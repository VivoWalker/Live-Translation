"""Quick offline check: SenseVoice or Whisper on a local audio file.

Usage:
    python tools/test_asr.py testdata/ja_nanami.mp3 --language ja
    python tools/test_asr.py a.wav b.wav --language auto --threads 4
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server.asr import create_recognizer, resample_to_16k  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--language", default="ja", help="Source language code, or auto")
    ap.add_argument("--asr", choices=("sensevoice", "whisper"), default="sensevoice")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--itn", action="store_true", default=True)
    ap.add_argument("--model-dir", default=None)
    ap.add_argument("--asr-domain", choices=("off", "anime", "gakumas"), default="gakumas")
    ap.add_argument("--asr-terms", default=None, help="Custom lexicon JSON")
    args = ap.parse_args()

    t0 = time.perf_counter()
    asr = create_recognizer(args.asr, model_dir=args.model_dir, language=args.language, num_threads=args.threads,
                            asr_domain=args.asr_domain, asr_terms=args.asr_terms)
    print(f"model: {asr.name} ({asr.model_dir})")
    print(f"ASR spelling lexicon: {args.asr_domain} (not acoustic-model fine-tuning)")
    print(f"init: {time.perf_counter() - t0:.2f}s")

    for path in args.files:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        audio = resample_to_16k(audio, sr)
        dur = len(audio) / 16000
        t1 = time.perf_counter()
        text = asr.transcribe(audio)
        el = time.perf_counter() - t1
        print(f"\n{os.path.basename(path)}  {dur:.2f}s  decode {el*1000:.0f}ms  RTF={el/dur:.3f}")
        print(f"  {text}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
