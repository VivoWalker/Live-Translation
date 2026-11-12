"""Translate a few (context, sentence) pairs with the configured engine.

    python tools/test_translate.py --engine deepseek
    python tools/test_translate.py --engine deepseek --repeat 3   # latency spread
"""
from __future__ import annotations

import argparse
import json
import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.translate import TranslationPipeline, create_translator  # noqa: E402

CASES = [
    ("昨日の試合はとても面白かったですね。", "最後の一点が決め手でした。"),
    ("会議は三時から始まりますので。", "資料を準備しておいてください。"),
    ("", "こんにちは。今日は東京の天気についてお話しします。"),
    ("", "すみません、この電車は新宿駅に止まりますか。"),
    ("", "午後から雨が降るそうなので、傘を持っていったほうがいいでしょう。"),
    ("", "ありがとうございました。また何かあればいつでもご連絡ください。"),
]


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="deepseek")
    ap.add_argument("--target", default="zh")
    ap.add_argument("--repeat", type=int, default=1)
    args = ap.parse_args()

    cfg_path = Path(__file__).resolve().parent.parent / "config.local.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    pipe = TranslationPipeline(create_translator(args.engine, cfg.get("deepseek_api_key")))
    print(f"engine: {pipe.engine}\n")
    lat = []
    for ctx, text in CASES:
        for _ in range(args.repeat):
            t0 = time.perf_counter()
            tr = await pipe.translate(text, args.target, context=ctx)
            el = (time.perf_counter() - t0) * 1000
            lat.append(el)
            print(f"原文 {text}")
            if ctx:
                print(f"  上文 {ctx}")
            print(f"  译文 {tr.text}   [{el:.0f}ms]")
    await pipe.tr.close()
    if lat:
        print(f"\nlatency: p50={statistics.median(lat):.0f}ms  max={max(lat):.0f}ms  n={len(lat)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
