"""Sweep Silero settings through the same local finalization path."""
from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import sys
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.asr import SAMPLE_RATE, create_recognizer
from server.benchmark import load_dataset, score_asr, latency_summary
from server.streaming import SessionConfig, StreamSession, VadSettings
from server.translate import MockTranslator, TranslationPipeline
from tools.benchmark_stream import FRAME, load_audio


async def sweep(dataset, recognizer, overlap):
    # Measure VAD and final decisions with previews disabled, independent of wall-clock pacing.
    recognizer.capabilities = replace(recognizer.capabilities, partial_transcription=False)
    report = []
    for silence, limit in itertools.product((.4, .6, .8), (8, 12, 16)):
        settings = VadSettings(silence, limit, overlap)
        predictions, delays, finals, cuts = {}, [], 0, 0
        for clip in dataset.clips:
            events = []
            session = StreamSession(recognizer, TranslationPipeline(MockTranslator()), events.append, SessionConfig(vad=settings))
            try:
                audio = np.concatenate((load_audio(clip.audio), np.zeros(SAMPLE_RATE * 2, dtype=np.float32)))
                position = 0
                collected = []
                for start in range(0, len(audio), FRAME):
                    frame = audio[start:start + FRAME]
                    position += len(frame)
                    session._append(frame)
                    await session._feed_vad(frame)
                    for event in events:
                        if event["type"] == "final":
                            collected.append(event["text"])
                            delays.append(max(0., position / SAMPLE_RATE - event["t"]) * 1000)
                            finals += 1
                            cuts += int(event["forced"])
                    events.clear()
                predictions[clip.id] = "".join(collected)
            finally:
                await session.close()
        metrics = score_asr(dataset, predictions)
        report.append({"vad": asdict(settings), "finals": finals, "forced_cuts": cuts,
                       "detection_lag": latency_summary(delays), "cer_raw": metrics["cer_raw"],
                       "cer_nfkc_no_spaces": metrics["cer_nfkc_no_spaces"]})
    return {"dataset": dataset.name, "dataset_sha256": dataset.digest, "model": recognizer.name,
            "mode": "offline-final-only", "settings": report}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--model-dir")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--overlap", type=float, default=0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    dataset = load_dataset(args.manifest)
    recognizer = create_recognizer(model_dir=args.model_dir, num_threads=args.threads, asr_domain="off")
    report = asyncio.run(sweep(dataset, recognizer, args.overlap))
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        with args.output.open("x", encoding="utf-8") as file:
            file.write(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
