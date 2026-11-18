"""Refine ordered Japanese clips locally using independent ASR votes."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.asr import RecognitionContext, create_recognizer
from server.asr_agent import Action, OptimizationAgent, refine_offline
from server.asr_review import ReviewStore
from server.asr_router import DecodeScheduler
from server.asr_verification import VerificationController, VerificationPolicy
from server.benchmark import load_dataset
from server.episodes import EpisodeCatalog
from tools.benchmark import model_spec
from tools.benchmark_stream import load_audio


async def run(args):
    dataset = load_dataset(args.manifest)
    review = ReviewStore(args.review) if args.review else None
    catalog = EpisodeCatalog(args.episode_catalog)
    primary = create_recognizer(*args.model, num_threads=args.threads, device=args.device, asr_domain="off")
    scheduler = DecodeScheduler()
    verifiers = []
    for spec in args.secondary:
        model = create_recognizer(*spec, num_threads=args.threads, device=args.secondary_device, asr_domain="off")
        policy = VerificationPolicy.for_model(model, budget_ms=args.budget_ms, mode="offline")
        verifiers.append(OptimizationAgent(scheduler, model, controller=VerificationController(scheduler, policy)))

    rows, previous, previous_context = [], "", None
    review_session = uuid.uuid4().hex
    for index, clip in enumerate(dataset.clips):
        # Carry context through adjacent clips with the same documented source and program.
        domain = catalog.resolve("auto", title=clip.title)
        context_key = (clip.source, domain.episode, domain.franchise)
        if context_key != previous_context:
            previous = ""
        previous_context = context_key
        audio = load_audio(clip.audio)
        context = RecognitionContext(previous, domain.prompt_terms, domain.corrector)
        baseline = await asyncio.to_thread(primary.recognize, audio, context)
        decision = await refine_offline(baseline, domain, audio, verifiers)
        previous = decision.text[:512]
        if review and (decision.action != Action.ACCEPT_ORIGINAL or baseline.changes or decision.candidates):
            review.record(review_session, index, baseline, decision, domain.episode or domain.franchise, pcm=audio)
        rows.append({"id": clip.id, "original": baseline.original, **asdict(decision)})
    return {"dataset_sha256": dataset.digest, "model": primary.name, "segments": rows,
            "verification": {agent.secondary.name: agent.snapshot() for agent in verifiers}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--model", type=model_spec, required=True)
    parser.add_argument("--secondary", type=model_spec, action="append", required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--secondary-device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--threads", type=int, choices=range(1, 17), default=2)
    parser.add_argument("--budget-ms", type=int)
    parser.add_argument("--episode-catalog", type=Path)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    backends = {spec[0] for spec in (args.model, *args.secondary)}
    if len(backends) != len(args.secondary) + 1 or len(args.secondary) > 2:
        parser.error("Choose one or two distinct secondary backends, each different from the primary")
    try:
        VerificationPolicy.for_model(None, budget_ms=args.budget_ms, mode="offline")
        report = asyncio.run(run(args))
        with args.output.open("x", encoding="utf-8") as file:
            json.dump(report, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.write("\n")
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
