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
from dataclasses import asdict
from pathlib import Path

import numpy as np
from aiohttp import ClientConnectionError, WSMsgType, web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.asr import BackendUnavailable, Capabilities, PROVIDERS, Recognizer  # noqa: E402
from server.asr_router import DecodeScheduler, select_recognizer  # noqa: E402
from server.asr_domain import PACKS, PROFILES, normalize_packs  # noqa: E402
from server.episodes import EpisodeCatalog  # noqa: E402
from server.streaming import AudioBacklogError, SessionConfig, StreamSession, VadSettings  # noqa: E402
from server.translate import TranslationPipeline, create_translator  # noqa: E402
from server.security import (  # noqa: E402
    AUTH_TIMEOUT, LOCAL_HOSTS, MAX_CONNECTIONS, MAX_FRAME_BYTES,
    RateBudget, valid_host, valid_origin,
)
from server.ws_events import ClientEvents  # noqa: E402

WEB_DIR = ROOT / "web"


class AppState:
    def __init__(
        self, asr: Recognizer, translator: TranslationPipeline, *,
        access_token: str | None = None, allowed_hosts: set[str] | None = None, vad: VadSettings = VadSettings(),
        fallback_from: str | None = None, episodes: EpisodeCatalog | None = None,
    ):
        self.asr = asr
        self.translator = translator
        self.vad = vad
        self.decoder = DecodeScheduler()
        self.fallback_from = fallback_from
        self.episodes = episodes or EpisodeCatalog()
        self.capabilities = asdict(getattr(asr, "capabilities", Capabilities()))
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
        self.total_ws_overflows = 0
        self.total_audio_overflows = 0

    def add(self, stats) -> None:
        self.total_audio_s += stats.audio_seconds
        self.total_decode_ms += stats.decode_ms
        self.total_finals += stats.finals
        self.total_translate_ms += stats.translate_ms
        self.total_audio_overflows += stats.audio_overflows

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
    ws = web.WebSocketResponse(max_msg_size=MAX_FRAME_BYTES + 1, heartbeat=30, compress=False, timeout=2)
    state.sockets.add(ws)  # Reserve before the first await, including pending auth.
    session = None
    writer_task = None
    out = ClientEvents()
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

        cfg = SessionConfig(vad=state.vad)
        try:
            session = StreamSession(state.asr, state.translator, out.put, cfg, decoder=state.decoder)
        except (OSError, RuntimeError):
            await ws.close(code=1011, message=b"VAD unavailable; verify local model")
            return ws
        await session.start()
        state.sessions += 1

        async def writer():
            try:
                while (event := await out.get()) is not None:
                    async with asyncio.timeout(2):
                        await ws.send_json(event)
            except (TimeoutError, ClientConnectionError, OSError, RuntimeError):
                out.fail(1013, b"Subtitle client could not keep up")
            if out.failure:
                code, reason = out.failure
                await ws.close(code=code, message=reason, drain=False)

        await ws.send_json({"type": "ready", "asr": state.asr.name, "translator": state.engine, "source": "ja", "target": "zh",
                            "asr_capabilities": state.capabilities, "asr_fallback_from": state.fallback_from})
        writer_task = asyncio.create_task(writer())
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
                        domain = (state.episodes.resolve(data["domain"], title=data.get("page_title", ""),
                                                         packs=data.get("packs")) if "domain" in data else None)
                        await session.set_target(target)
                        if domain is not None:
                            session.set_domain(domain)
                        out.put({"type": "config", "ok": True, "target": target,
                                 **({"domain": domain.public()} if domain else {})})
                    elif kind == "ping":
                        out.put({"type": "pong", "t": time.time()})
                    elif kind == "stats":
                        out.put({"type": "stats", **session.stats.as_dict(), "translation": session.translation_stats(),
                                 "queue": out.stats(), "audio_queue_bytes": session.queued_audio_bytes})
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
            except AudioBacklogError:
                out.fail(1013, b"ASR audio backlog exceeded")
                break
            except (ValueError, TypeError):
                await ws.close(code=1008, message=b"Invalid input or resource limit exceeded")
                break
    finally:
        if writer_task is not None and not out.failure:
            writer_task.cancel()
        try:
            if session is not None:
                state.sessions = max(0, state.sessions - 1)
                await session.close()
                state.add(session.stats)
            if writer_task is not None:
                try:
                    await asyncio.wait_for(asyncio.gather(writer_task, return_exceptions=True), timeout=4)
                except TimeoutError:
                    await ws.close(code=1013, message=b"Subtitle backpressure", drain=False)
        finally:
            state.total_ws_overflows += out.overflows
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
            "asr_capabilities": state.capabilities,
            "asr_fallback_from": state.fallback_from,
            "translator": state.engine,
            "sessions": state.sessions,
            "uptime_s": round(time.time() - state.started, 1),
            "audio_seconds": round(state.total_audio_s, 2),
            "decode_ms": round(state.total_decode_ms, 1),
            "finals": state.total_finals,
            "ws_queue_overflows": state.total_ws_overflows,
            "audio_queue_overflows": state.total_audio_overflows,
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
        "pcm-worklet.js": "pcm-worklet.js",
    }
    public_assets = {"app.js", "style.css", "sample-ja.wav", *extension_assets}
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
    ap.add_argument("--vad-min-silence", type=float, default=cfg.get("vad_min_silence", .4))
    ap.add_argument("--vad-max-segment", type=float, default=cfg.get("vad_max_segment", 12))
    ap.add_argument("--vad-overlap", type=float, default=cfg.get("vad_overlap", 0))
    ap.add_argument("--asr", choices=PROVIDERS,
                    default=os.environ.get("JLSUBS_ASR", cfg.get("asr", "sensevoice")),
                    help="Local recognition backend (default: sensevoice)")
    ap.add_argument("--asr-device", choices=("cpu", "cuda"), default=cfg.get("asr_device", "cpu"))
    ap.add_argument("--asr-precision", default=cfg.get("asr_precision"))
    ap.add_argument("--asr-fallback", choices=("sensevoice", "off"), default=cfg.get("asr_fallback", "sensevoice"))
    ap.add_argument("--fallback-model-dir", default=cfg.get("fallback_model_dir"))
    lexicon = ap.add_mutually_exclusive_group()
    lexicon.add_argument("--asr-packs", choices=PACKS, nargs="*", help="Enable named ASR word packs; no names disables all packs")
    lexicon.add_argument("--asr-domain", choices=PROFILES, help="Legacy ASR lexicon profile")
    ap.add_argument("--asr-terms", default=cfg.get("asr_terms"), help="Custom ASR lexicon JSON, replaces built-in terms")
    ap.add_argument("--episode-catalog", default=cfg.get("episode_catalog"), help="Local episode metadata JSON")
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
        vad = VadSettings(args.vad_min_silence, args.vad_max_segment, args.vad_overlap)
        episodes = EpisodeCatalog(args.episode_catalog)
        asr, fallback_from = select_recognizer(args.asr, model_dir=args.model_dir, language="ja",
                                               num_threads=args.threads, asr_domain=selection, asr_terms=args.asr_terms,
                                               device=args.asr_device, precision=args.asr_precision,
                                               fallback_dir=args.fallback_model_dir, allow_fallback=args.asr_fallback != "off")
    except (OSError, ValueError, BackendUnavailable) as exc:
        ap.error(str(exc))
    translator = TranslationPipeline(create_translator(args.translator, api_key))
    state = AppState(asr, translator, access_token=os.environ.get("JLSUBS_ACCESS_TOKEN") or cfg.get("access_token"),
                     allowed_hosts=LOCAL_HOSTS | set(args.allow_host), vad=vad, fallback_from=fallback_from,
                     episodes=episodes)
    active_packs = ("custom" if selection != "off" else "off") if args.asr_terms else ",".join(normalize_packs(selection)) or "off"
    print(f"[jls] asr={asr.name} threads={args.threads} asr_packs={active_packs} translator={translator.engine}")
    if fallback_from:
        print(f"[jls] 无法加载 {fallback_from}，已切换到 {asr.name}")
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
