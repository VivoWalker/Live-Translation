"""Stream a local audio file into the running server exactly like the browser does.

    python tools/simulate.py testdata/ja_nanami.mp3 --realtime
    python tools/simulate.py a.wav --speed 2     # up to 2x realtime

Prints every event with the audio position, so字幕延迟 can be read directly:
    [12.40s] partial  今日は東京の天気について…
    [13.10s] FINAL    今日は東京の天気についてお話しします    (+0.62s)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import os

import numpy as np
import soundfile as sf
import websockets

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.asr import resample_to_16k  # noqa: E402


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--url", default="ws://127.0.0.1:8765/ws")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--target", default="zh")
    ap.add_argument("--chunk-ms", type=int, default=100)
    args = ap.parse_args()
    token = os.environ.get('JLSUBS_ACCESS_TOKEN', '')
    if not token:
        ap.error('Set JLSUBS_ACCESS_TOKEN to the access token printed by the server')
    if not 0 < args.speed <= 2 or not 40 <= args.chunk_ms <= 1000:
        ap.error('speed must be in (0, 2] and chunk-ms must be between 40 and 1000')

    audio, sr = sf.read(args.file, dtype="float32", always_2d=True)
    audio = resample_to_16k(audio.mean(axis=1), sr)
    chunk = int(16000 * args.chunk_ms / 1000)

    t_start = time.perf_counter()
    audio_pos = 0.0
    final_lat: list[float] = []
    async with websockets.connect(args.url, max_size=8 * 1024 * 1024) as ws:
        await ws.send(json.dumps({'type': 'auth', 'token': token}))
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
        if ready.get('type') != 'ready':
            raise RuntimeError('Subtitle service did not authenticate the connection')
        await ws.send(json.dumps({"type": "config", "target": args.target}))
        takeaway: asyncio.Queue = asyncio.Queue()

        async def reader() -> None:
            async for raw in ws:
                await takeaway.put((time.perf_counter(), json.loads(raw)))

        rt = asyncio.create_task(reader())
        print("server:", ready)

        sent = 0.0
        for i in range(0, len(audio), chunk):
            piece = audio[i: i + chunk]
            await ws.send(piece.astype("<f4").tobytes())
            audio_pos = (i + len(piece)) / 16000
            target_time = t_start + audio_pos / args.speed
            delay = target_time - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
            # drain events without blocking the send pace
            while not takeaway.empty():
                _, ev = takeaway.get_nowait()
                print(f"[{audio_pos:6.2f}s] {ev}")
                if ev.get("type") == "final":
                    final_lat.append(max(0.0, (time.perf_counter() - t_start) - ev.get("t", audio_pos)))
        await ws.send(json.dumps({"type": "stats"}))
        # let finals + translations finish
        deadline = time.perf_counter() + 15
        while time.perf_counter() < deadline:
            try:
                _, ev = await asyncio.wait_for(takeaway.get(), timeout=1.0)
            except asyncio.TimeoutError:
                break
            print(f"[{audio_pos:6.2f}s] {ev}")
            if ev.get("type") == "final":
                final_lat.append(max(0.0, (time.perf_counter() - t_start) - ev.get("t", audio_pos)))
            if ev.get("type") == "stats":
                break
        rt.cancel()
        await asyncio.gather(rt, return_exceptions=True)
    if final_lat:
        s = sorted(final_lat)
        print(f"\nfinalize latency over {len(s)} finals: p50={s[len(s)//2]*1000:.0f}ms p95={s[min(len(s)-1,int(len(s)*0.95))]*1000:.0f}ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
