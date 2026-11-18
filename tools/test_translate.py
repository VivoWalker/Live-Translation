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

from server.translate import DeepSeekTranslator, TranslationPipeline, create_translator  # noqa: E402
from server.translation_cache import TranslationStats  # noqa: E402
from server.benchmark import latency_summary  # noqa: E402
from server.conversation import ConversationContext, Glossary  # noqa: E402
from server.episodes import EpisodeCatalog  # noqa: E402

CASES = [
    ("昨日の試合はとても面白かったですね。", "最後の一点が決め手でした。"),
    ("会議は三時から始まりますので。", "資料を準備しておいてください。"),
    ("", "こんにちは。今日は東京の天気についてお話しします。"),
    ("", "すみません、この電車は新宿駅に止まりますか。"),
    ("", "午後から雨が降るそうなので、傘を持っていったほうがいいでしょう。"),
    ("", "ありがとうございました。また何かあればいつでもご連絡ください。"),
]

CONTEXT_CASES = (
    (("このあと、藤田ことねの歌を流します。", "それ、前の回でも聴いたね。", "うん、あの子の曲だよ。"),
     "あ、違う。藤田ことねが選んだ曲のほう！"),
    (("学園アイドルマスターの話に戻ろう。", "初星学園HR、昨日だったっけ？", "ううん、来週だって。"),
     "えー、もうカレンダーに書いちゃったよ。"),
)


async def probe_context(translator, target):
    domain = EpisodeCatalog().resolve("auto", title="初星学園HR")
    glossary = Glossary.load()
    stats = TranslationStats()
    rows = []
    for case_id, (history, current) in enumerate(CONTEXT_CASES, 1):
        conversation = ConversationContext()
        for line in history:
            conversation.remember(line)
        variants = (("classic", 1), ("multiturn", 3))
        if case_id % 2 == 0:
            variants = tuple(reversed(variants))
        for variant, window in variants:
            context = conversation.snapshot(current, target, window, glossary, domain)
            request = translator.request(current, target, context)
            start = time.perf_counter()
            try:
                result = await translator.send(request, stats)
                rows.append({"case": case_id, "variant": variant, "elapsed_ms": round((time.perf_counter() - start) * 1000, 1),
                             "prompt_version": request.prompt_version, "usage": result.usage, "completed": True})
            except (RuntimeError, OSError):
                rows.append({"case": case_id, "variant": variant, "completed": False})
    latency = {variant: latency_summary(row["elapsed_ms"] for row in rows if row["variant"] == variant and row["completed"])
               for variant in ("classic", "multiturn")}
    return {"verified": all(row["completed"] for row in rows), "model": translator.model, "target": target,
            "requests": rows, "latency": latency, "totals": stats.snapshot()}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="deepseek")
    ap.add_argument("--target", choices=("zh", "en"), default="zh")
    ap.add_argument("--repeat", type=int, default=1)
    probes = ap.add_mutually_exclusive_group()
    probes.add_argument("--probe-cache", action="store_true", help="Three real API calls; bypass local reuse")
    probes.add_argument("--probe-context", action="store_true", help="Four real API calls on synthetic dialogue")
    ap.add_argument("--report", type=Path, help="Save usage/latency only; never dialogue or credentials")
    args = ap.parse_args()

    cfg_path = Path(__file__).resolve().parent.parent / "config.local.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    pipe = TranslationPipeline(create_translator(args.engine, cfg.get("deepseek_api_key")))
    if args.probe_context:
        if not isinstance(pipe.tr, DeepSeekTranslator):
            ap.error('--probe-context requires DeepSeek')
        try:
            report = await probe_context(pipe.tr, args.target)
        finally:
            await pipe.close()
            await pipe.tr.close()
        serialized = json.dumps(report, ensure_ascii=False, indent=2)
        if args.report:
            args.report.write_text(serialized, encoding="utf-8")
        print(serialized)
        return 0 if report["verified"] else 1
    if args.probe_cache:
        if not isinstance(pipe.tr, DeepSeekTranslator):
            ap.error('--probe-cache requires DeepSeek')
        stats = TranslationStats()
        rows = []
        cases = [('fixed_prefix_a', CASES[0]), ('fixed_prefix_b', (CASES[0][0], CASES[1][1])), ('exact_repeat_a', CASES[0])]
        verified = True
        try:
            for label, (context, text) in cases:
                before = stats.api_requests
                started = time.perf_counter()
                result = await pipe.tr.send(pipe.tr.request(text, args.target, context), stats)
                rows.append({'case': label, 'api_requests': stats.api_requests - before,
                             'elapsed_ms': round((time.perf_counter() - started) * 1000, 1), 'usage': result.usage})
        except Exception:
            verified = False
        finally:
            await pipe.close()
            await pipe.tr.close()
        report = {'verified': verified, 'local_cache_bypassed': True, 'model': pipe.tr.model,
                  'prompt_version': pipe.tr.prompt_version, 'target': args.target,
                  'requests': rows, 'totals': stats.snapshot()}
        if args.report:
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if verified else 1
    print(f"engine: {pipe.engine}\n")
    lat = []
    for case_id, (ctx, text) in enumerate(CASES, 1):
        for _ in range(args.repeat):
            t0 = time.perf_counter()
            tr = await pipe.translate(text, args.target, context=ctx)
            el = (time.perf_counter() - t0) * 1000
            lat.append(el)
            print(f"case={case_id} source={tr.source} elapsed_ms={el:.0f}")
    print(json.dumps(pipe.snapshot(), ensure_ascii=False))
    await pipe.close()
    await pipe.tr.close()
    if lat:
        print(f"\nlatency: p50={statistics.median(lat):.0f}ms  max={max(lat):.0f}ms  n={len(lat)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
