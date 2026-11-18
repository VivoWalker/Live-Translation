"""WebSocket front door: browser audio in, subtitle JSON out, plus the demo page.

    python -m server.app --port 8765 --translator auto

Protocol
--------
client -> server
    text  {"type":"auth","token":"<local access token>"} (first message)
    text  {"type":"config","target":"zh","source":"ja"}
    bin   little-endian float32, 16 kHz mono PCM (max 64 KiB per frame)
    text  {"type":"ping"}
server -> client
    {"type":"ready","asr":"sensevoice-int8","translator":"deepseek","source":"ja","target":"zh"}
    {"type":"partial","id":3,"text":"...","stable":"...","t":12.4}
    {"type":"final","id":3,"text":"...","t":13.1}
    {"type":"translation","id":3,"final":true,"text":"...","engine":"deepseek","ms":820}
    {"type":"stats", ...}
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import time
from pathlib import Path

import numpy as np
from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.asr import Recognizer, create_recognizer  # noqa: E402
from server.asr_domain import PACKS, PROFILES, normalize_packs  # noqa: E402
from server.streaming import SessionConfig, StreamSession  # noqa: E402
from server.translate import TranslationPipeline, create_translator  # noqa: E402
from server.security import (  # noqa: E402
    AUTH_TIMEOUT, LOCAL_HOSTS, MAX_CONNECTIONS, MAX_FRAME_BYTES,
    RateBudget, valid_host, valid_origin,
)

WEB_DIR = ROOT / "web"


class AppState:
    def __init__(
        self, asr: Recognizer, translator: TranslationPipeline, *,
        access_token: str | None = None, allowed_hosts: set[str] | None = None,
    ):
        self.asr = asr
        self.translator = translator
        self.access_token = access_token or secrets.token_urlsafe(32)
        if len(self.access_token) < 32 or not self.access_token.isascii():
            raise ValueError("Access token must contain at least 32 ASCII characters")
        self.allowed_hosts = set(allowed_hosts or LOCAL_HOSTS)
        self.sockets: set[web.WebSocketResponse] = set()
        self.sessions = 0
        self.started = time.time()
        self.total_audio_s = 0.0
        self.total_decode_ms = 0.0
        self.total_finals = 0
        self.total_translate_ms = 0.0

    def add(self, stats) -> None:
        self.total_audio_s += stats.audio_seconds
        self.total_decode_ms += stats.decode_ms
        self.total_finals += stats.finals
        self.total_translate_ms += stats.translate_ms

    @property
    def engine(self) -> str:
        return self.translator.engine


STATE_KEY = web.AppKey("state", AppState)


@web.middleware
async def boundaries(request, handler):
    state = request.app[STATE_KEY]
    if not valid_host(request.host, state.allowed_hosts) or not valid_origin(request.headers.get("Origin"), request):
        raise web.HTTPForbidden(text="Untrusted request host or origin")
    response = await handler(request)
    if not response.prepared:
        response.headers.update({
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": "no-store",
        })
    return response


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    state: AppState = request.app[STATE_KEY]
    if len(state.sockets) >= MAX_CONNECTIONS:
        raise web.HTTPServiceUnavailable(text="Connection limit reached")
    # aiohttp treats max_msg_size as exclusive; the protocol allows 64 KiB.
    ws = web.WebSocketResponse(max_msg_size=MAX_FRAME_BYTES + 1, heartbeat=30, compress=False)
    state.sockets.add(ws)  # Reserve before the first await, including pending auth.
    session = None
    writer_task = None
    try:
        await ws.prepare(request)
        try:
            msg = await ws.receive(timeout=AUTH_TIMEOUT)
            data = json.loads(msg.data) if msg.type == WSMsgType.TEXT and len(msg.data) <= 1024 else None
            authenticated = (
                isinstance(data, dict) and data.get("type") == "auth"
                and isinstance(data.get("token"), str) and data["token"].isascii()
                and secrets.compare_digest(data["token"], state.access_token)
            )
        except (ValueError, asyncio.TimeoutError):
            authenticated = False
        if not authenticated:
            await ws.close(code=1008, message=b"Access token required")
            return ws

        out: asyncio.Queue[tuple[int, dict]] = asyncio.Queue(maxsize=64)
        def on_event(event):
            if not out.full():
                out.put_nowait((session.translation_epoch if session else 0, event))

        cfg = SessionConfig()
        session = StreamSession(state.asr, state.translator, on_event, cfg)
        await session.start()
        state.sessions += 1
        async def writer():
            while True:
                epoch, event = await out.get()
                is_translation = event["type"] == "translation" or event.get("scope") == "translate"
                if not is_translation or epoch == session.translation_epoch:
                    await ws.send_json(event)
        writer_task = asyncio.create_task(writer())
        await ws.send_json({"type": "ready", "asr": state.asr.name, "translator": state.engine, "source": "ja", "target": "zh"})
        audio_budget = RateBudget(128000, 256000)  # Up to 2x realtime, four-second burst.
        control_budget = RateBudget(20, 40)
        message_budget = RateBudget(50, 100)
        async for msg in ws:
            try:
                if msg.type in (WSMsgType.BINARY, WSMsgType.TEXT) and not message_budget.consume(1):
                    raise ValueError("Message rate limit exceeded")
                if msg.type == WSMsgType.BINARY:
                    if not msg.data or len(msg.data) % 4 or not audio_budget.consume(len(msg.data)):
                        raise ValueError("Invalid PCM frame or audio rate limit exceeded")
                    await session.push(np.frombuffer(msg.data, dtype="<f4"))
                elif msg.type == WSMsgType.TEXT:
                    if len(msg.data) > 1024 or not control_budget.consume(1):
                        raise ValueError("Control message limit exceeded")
                    data = json.loads(msg.data)
                    if not isinstance(data, dict):
                        raise ValueError("Expected a JSON object")
                    kind = data.get("type")
                    if kind == "config":
                        target = data.get("target", cfg.target_lang)
                        if target not in ("zh", "en"):
                            raise ValueError("Unsupported target language")
                        await session.set_target(target)
                        await ws.send_json({"type": "config", "ok": True, "target": target})
                    elif kind == "ping":
                        await ws.send_json({"type": "pong", "t": time.time()})
                    elif kind == "stats":
                        await ws.send_json({"type": "stats", **session.stats.as_dict(), "translation": session.translation_stats()})
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
            except (ValueError, TypeError):
                await ws.close(code=1008, message=b"Invalid input or resource limit exceeded")
                break
    finally:
        if writer_task is not None:
            writer_task.cancel()
        try:
            if session is not None:
                state.sessions = max(0, state.sessions - 1)
                await session.close()
                state.add(session.stats)
            if writer_task is not None:
                await asyncio.gather(writer_task, return_exceptions=True)
        finally:
            state.sockets.discard(ws)
    return ws


async def index(_: web.Request) -> web.StreamResponse:
    return web.FileResponse(WEB_DIR / "index.html")


async def health(request: web.Request) -> web.Response:
    state: AppState = request.app[STATE_KEY]
    return web.json_response(
        {
            "ok": True,
            "asr": state.asr.name,
            "translator": state.engine,
            "sessions": state.sessions,
            "uptime_s": round(time.time() - state.started, 1),
            "audio_seconds": round(state.total_audio_s, 2),
            "decode_ms": round(state.total_decode_ms, 1),
            "finals": state.total_finals,
            "cpu_s": round(time.process_time(), 2),
        }
    )


def build_app(state: AppState, *, dev_assets: bool = False) -> web.Application:
    app = web.Application(client_max_size=MAX_FRAME_BYTES, middlewares=[boundaries])
    app[STATE_KEY] = state
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/health", health)
    app.router.add_get("/", index)
    extension_assets = {
        "captions.js": "caption-overlay.js",
        "caption-settings.js": "caption-settings.js",
        "interface.css": "interface.css",
    }
    public_assets = {"app.js", "style.css", "pcm-worklet.js", "sample-ja.wav", *extension_assets}
    if dev_assets:
        public_assets.update({"test-player.html", "engine-test.html", "wasm-test.html", "worklet-test.html", "worklet-probe.js"})
    async def static_asset(request):
        name = request.match_info["name"]
        if name not in public_assets:
            raise web.HTTPNotFound()
        if name in extension_assets:
            return web.FileResponse(ROOT / "extension" / extension_assets[name])
        return web.FileResponse(WEB_DIR / "static" / name)
    app.router.add_get("/static/{name}", static_asset)
    if dev_assets:
        assets = ROOT / "wasm-test"
        if assets.exists():
            app.router.add_static("/asr-assets/", assets)
        app.router.add_static("/ext-assets/", ROOT / "extension")
    async def shutdown(app):
        await asyncio.gather(*(ws.close(code=1001, message=b"Server shutdown") for ws in list(state.sockets)), return_exceptions=True)
    async def cleanup(app):
        await state.translator.tr.close()
    app.on_shutdown.append(shutdown)
    app.on_cleanup.append(cleanup)
    return app


def load_local_config() -> dict:
    path = ROOT / "config.local.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"[jls] config.local.json 读取失败：{e}")
        return {}


def main() -> int:
    cfg = load_local_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=cfg.get("host", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(cfg.get("port", 8765)))
    ap.add_argument(
        "--translator",
        default=os.environ.get("JLSUBS_TRANSLATOR", cfg.get("translator", "auto")),
    )
    ap.add_argument(
        "--threads",
        type=int,
        default=int(os.environ.get("JLSUBS_ASR_THREADS", cfg.get("asr_threads", 4))),
    )
    ap.add_argument("--model-dir", default=cfg.get("model_dir"))
    ap.add_argument("--asr", choices=("sensevoice", "whisper"),
                    default=os.environ.get("JLSUBS_ASR", cfg.get("asr", "sensevoice")),
                    help="Local recognition backend (default: sensevoice)")
    lexicon = ap.add_mutually_exclusive_group()
    lexicon.add_argument("--asr-packs", choices=PACKS, nargs="*", help="Enable named ASR word packs; no names disables all packs")
    lexicon.add_argument("--asr-domain", choices=PROFILES, help="Legacy ASR lexicon profile")
    ap.add_argument("--asr-terms", default=cfg.get("asr_terms"), help="Custom ASR lexicon JSON, replaces built-in terms")
    ap.add_argument("--dev-assets", action="store_true", help="Expose non-secret development test pages")
    ap.add_argument("--allow-host", action="append", default=[], help="Additional trusted HTTP hostname (no scheme or port)")
    args = ap.parse_args()
    selection = args.asr_packs if args.asr_packs is not None else args.asr_domain
    if selection is None:
        selection = cfg.get("asr_domain", "gakumas")
        if args.asr_terms is None:
            selection = cfg.get("asr_packs", selection)

    api_key = os.environ.get("DEEPSEEK_API_KEY") or cfg.get("deepseek_api_key")
    try:
        asr = create_recognizer(args.asr, model_dir=args.model_dir, language="ja", num_threads=args.threads,
                                asr_domain=selection, asr_terms=args.asr_terms)
    except (OSError, ValueError) as exc:
        ap.error(str(exc))
    translator = TranslationPipeline(create_translator(args.translator, api_key))
    state = AppState(asr, translator, access_token=os.environ.get("JLSUBS_ACCESS_TOKEN") or cfg.get("access_token"), allowed_hosts=LOCAL_HOSTS | set(args.allow_host))
    active_packs = ("custom" if selection != "off" else "off") if args.asr_terms else ",".join(normalize_packs(selection)) or "off"
    print(f"[jls] asr={asr.name} threads={args.threads} asr_packs={active_packs} translator={translator.engine}")
    if translator.engine == "deepseek":
        print(f"[jls] deepseek model={os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')}")
    elif translator.engine == "google-public":
        print("[jls] 未配置 DEEPSEEK_API_KEY，翻译使用公共端点（仅用于本地试用）")
    print(f"[jls] http://{args.host}:{args.port}/  ws://{args.host}:{args.port}/ws")
    print(f"[jls] 本地服务访问令牌（填入扩展服务模式）：{state.access_token}")
    web.run_app(build_app(state, dev_assets=args.dev_assets), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
