"""WebSocket front door: browser audio in, subtitle JSON out, plus the demo page.

    python -m server.app --port 8765 --translator auto

Protocol
--------
client -> server
    text  {"type":"config","target":"zh","source":"ja","partial_translation":true}
    bin   little-endian float32, 16 kHz mono PCM (any chunk size)
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
import sys
import time
from pathlib import Path

import numpy as np
from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.asr import SenseVoiceRecognizer  # noqa: E402
from server.streaming import SessionConfig, StreamSession  # noqa: E402
from server.translate import TranslationPipeline, create_translator  # noqa: E402

WEB_DIR = ROOT / "web"


class AppState:
    def __init__(self, asr: SenseVoiceRecognizer, translator: TranslationPipeline):
        self.asr = asr
        self.translator = translator
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


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    state: AppState = request.app["state"]
    ws = web.WebSocketResponse(max_msg_size=16 * 1024 * 1024, heartbeat=30)
    await ws.prepare(request)

    out: asyncio.Queue[dict] = asyncio.Queue(maxsize=1000)

    def on_event(ev: dict) -> None:
        try:
            out.put_nowait(ev)
        except asyncio.QueueFull:
            pass

    cfg = SessionConfig()
    session = StreamSession(state.asr, state.translator, on_event, cfg)
    await session.start()
    state.sessions += 1

    async def writer() -> None:
        while True:
            ev = await out.get()
            if ev is None:
                break
            try:
                await ws.send_json(ev)
            except Exception:  # noqa: BLE001 - client went away
                break

    wtask = asyncio.create_task(writer())
    await ws.send_json(
        {
            "type": "ready",
            "asr": "sensevoice-int8",
            "translator": state.engine,
            "source": cfg.source_lang,
            "target": cfg.target_lang,
        }
    )
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                pcm = np.frombuffer(msg.data, dtype="<f4")
                await session.push(pcm)
            elif msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                kind = data.get("type")
                if kind == "config":
                    session.cfg.target_lang = str(data.get("target", cfg.target_lang))[:8]
                    session.cfg.partial_translation = bool(data.get("partial_translation", True))
                    await ws.send_json({"type": "config", "ok": True, "target": session.cfg.target_lang})
                elif kind == "ping":
                    await ws.send_json({"type": "pong", "t": time.time()})
                elif kind == "stats":
                    await ws.send_json({"type": "stats", **session.stats.as_dict()})
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
    finally:
        state.sessions = max(0, state.sessions - 1)
        await session.close()
        state.add(session.stats)
        out.put_nowait(None)
        wtask.cancel()
    return ws


async def index(_: web.Request) -> web.StreamResponse:
    return web.FileResponse(WEB_DIR / "index.html")


async def health(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    return web.json_response(
        {
            "ok": True,
            "asr": "sensevoice-int8",
            "translator": state.engine,
            "sessions": state.sessions,
            "uptime_s": round(time.time() - state.started, 1),
            "audio_seconds": round(state.total_audio_s, 2),
            "decode_ms": round(state.total_decode_ms, 1),
            "finals": state.total_finals,
            "cpu_s": round(time.process_time(), 2),
        }
    )


def build_app(state: AppState) -> web.Application:
    app = web.Application(client_max_size=32 * 1024 * 1024)
    app["state"] = state
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/health", health)
    app.router.add_get("/", index)
    app.router.add_static("/static/", WEB_DIR / "static")
    assets = ROOT / "wasm-test"
    if assets.exists():
        app.router.add_static("/asr-assets/", assets)
    ext_dir = ROOT / "extension"
    if ext_dir.exists():  # dev-only: lets tests run the packaged worker outside the extension
        app.router.add_static("/ext-assets/", ext_dir)
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
    args = ap.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY") or cfg.get("deepseek_api_key")
    asr = SenseVoiceRecognizer(model_dir=args.model_dir, language="ja", num_threads=args.threads)
    translator = TranslationPipeline(create_translator(args.translator, api_key))
    state = AppState(asr, translator)
    print(f"[jls] asr=sensevoice-int8 threads={args.threads} translator={translator.engine}")
    if translator.engine == "deepseek":
        print(f"[jls] deepseek model={os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')}")
    elif translator.engine == "google-public":
        print("[jls] 未配置 DEEPSEEK_API_KEY，翻译使用公共端点（仅用于本地试用）")
    print(f"[jls] http://{args.host}:{args.port}/  ws://{args.host}:{args.port}/ws")
    web.run_app(build_app(state), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
