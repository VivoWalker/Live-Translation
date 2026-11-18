"""Exercise the streaming pipeline with generated PCM and local ASR/translation doubles."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import numpy as np
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.app import AppState, build_app
from server.asr import Capabilities, SAMPLE_RATE, SpeechSpan
from server.benchmark import CONDITIONS, load_dataset, rate
from server.streaming import StreamSession, VAD_FRAME
from server.translate import MockTranslator, TranslationPipeline
from tools.benchmark import MemorySampler
from tools.benchmark_stream import stream_dataset

ROOT = Path(__file__).resolve().parent.parent
SPEECH_BLOCKS = 20  # 640 ms
SILENCE_BLOCKS = 8


class FixtureVad:
    """Detect generated blocks. Production Silero accuracy is outside this measurement."""
    def __init__(self, **_):
        self.in_speech = False
        self.position = self.start = self.end = 0
        self.finished = None

    def accept(self, block):
        first = self.position
        self.position += len(block)
        if np.max(np.abs(block)) > .008:
            if not self.in_speech:
                self.start = first
            self.end = self.position
            self.in_speech = True
        elif self.in_speech and self.position - self.end >= 6 * VAD_FRAME:
            self.finished = (self.start, self.end)
            self.in_speech = False

    def pop_spans(self, since=0):
        if self.finished is None:
            return []
        start, end = self.finished
        self.finished = None
        start = max(since, start)
        return [SpeechSpan(start, np.full(end - start, .1, dtype=np.float32))] if start < end else []


class FixtureAsr:
    name = "mock-ja"
    capabilities = Capabilities(partial_transcription=False)

    def __init__(self, flagged=False):
        self.count = 0
        self.flagged = flagged

    def transcribe(self, _):
        self.count += 1
        prefix = "字幕字幕字幕" if self.flagged else "字幕テスト"
        return f"{prefix} {self.count}。"


async def direct_soak(minutes):
    model = FixtureAsr()
    pending = set()
    counts = dict(finals=0, translated=0, duplicate_or_out_of_order_finals=0, unexpected_translations=0, forced_finals=0)
    peak_pending = peak_audio = 0

    def emit(event):
        nonlocal peak_pending
        if event["type"] == "final":
            idx = event["id"]
            counts["duplicate_or_out_of_order_finals"] += int(idx != counts["finals"])
            counts["finals"] += 1
            counts["forced_finals"] += int(event["forced"])
            pending.add(idx)
            peak_pending = max(peak_pending, len(pending))
        elif event["type"] == "translation":
            idx = event["id"]
            counts["unexpected_translations"] += int(idx not in pending)
            pending.discard(idx)
            counts["translated"] += 1

    session = StreamSession(model, TranslationPipeline(MockTranslator()), emit)
    await session.start()
    speech = np.full(VAD_FRAME, .1, dtype=np.float32)
    silence = np.zeros(VAD_FRAME, dtype=np.float32)
    total_blocks = minutes * 60 * SAMPLE_RATE // VAD_FRAME
    preamble = 24 * SAMPLE_RATE // VAD_FRAME
    cycles = (total_blocks - preamble) // (SPEECH_BLOCKS + SILENCE_BLOCKS)
    expected = 2 + cycles
    try:
        for block in range(total_blocks):
            offset = block - preamble
            speaking = offset < 0 or (offset < cycles * (SPEECH_BLOCKS + SILENCE_BLOCKS)
                                      and offset % (SPEECH_BLOCKS + SILENCE_BLOCKS) < SPEECH_BLOCKS)
            while session.queued_audio_bytes >= 16 * VAD_FRAME * 4:
                await asyncio.sleep(.001)
                if session._task.done():
                    raise RuntimeError("Mock audio worker stopped unexpectedly")
            await session.push(speech if speaking else silence)
            peak_audio = max(peak_audio, session.queued_audio_bytes)
        async with asyncio.timeout(10):
            while session.stats.audio_processed_samples != total_blocks * VAD_FRAME or session._translations:
                await asyncio.sleep(.002)
        mt = session.translation_stats()
        report = {**counts, "audio_seconds": total_blocks * VAD_FRAME / SAMPLE_RATE, "expected_finals": expected,
                  "missing_translation_rate": rate(len(pending), counts["finals"]),
                  "audio_queue_peak_bytes": peak_audio, "pending_translations_peak": peak_pending,
                  "audio_queue_overflows": session.stats.audio_overflows,
                  "translation_queue_overflows": session.stats.translation_overflows,
                  "mock_decode_rtf": session.stats.decode_ms / 1000 / session.stats.audio_seconds,
                  "translation_stats": mt}
        report["pass"] = (counts["finals"] == counts["translated"] == expected and not pending
                          and not counts["duplicate_or_out_of_order_finals"] and not counts["unexpected_translations"]
                          and not session.stats.audio_overflows and not session.stats.translation_overflows)
        return report
    finally:
        await session.close()


def fixture_manifest(directory):
    import soundfile as sf

    audio, manifest = directory / "mock.wav", directory / "mock.json"
    samples = np.concatenate([np.full(VAD_FRAME * SPEECH_BLOCKS, .1), np.zeros(VAD_FRAME * SILENCE_BLOCKS)] * 3)
    sf.write(audio, samples, SAMPLE_RATE)
    data = {"version": 2, "dataset_version": "1", "name": "generated pipeline fixture", "clips": [{
        "id": "mock", "audio": audio.name, "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
        "source": "generated PCM squares", "license": "repository fixture", "usage_scope": "local pipeline testing",
        "data_kind": "mock", "language": "ja", "recording": "benchmark-mock",
        "conditions": dict.fromkeys(CONDITIONS, False),
    }]}
    manifest.write_text(json.dumps(data), encoding="utf-8")
    return load_dataset(manifest)


async def wire_check(browser=False):
    token = secrets.token_urlsafe(32)
    class SlowVerifier:
        name = "mock-verifier"

        def transcribe(self, _):
            time.sleep(.25)
            return "テスト"

    state = AppState(FixtureAsr(flagged=not browser), TranslationPipeline(MockTranslator()), access_token=token,
                     agent_enabled=not browser, secondary=None if browser else SlowVerifier(), agent_budget_ms=80)
    async with TestServer(build_app(state)) as server:
        if browser:
            url = str(server.make_url("/?autostart=file"))
            child = await asyncio.create_subprocess_exec(
                "node", "tools/browser_check.mjs", "--url", url, "--seconds", "10", "--switch-language", "--restart",
                cwd=ROOT, env={**os.environ, "JLSUBS_ACCESS_TOKEN": token})
            try:
                async with asyncio.timeout(65):
                    return {"pass": await child.wait() == 0, "path": "Chromium AudioWorklet to mock service"}
            finally:
                if child.returncode is None:
                    child.kill()
                    await child.wait()
        with tempfile.TemporaryDirectory(prefix="jls-mock-benchmark-") as directory:
            dataset = fixture_manifest(Path(directory))
            url = str(server.make_url("/ws").with_scheme("ws"))
            report = await stream_dataset(dataset, url, token, "zh", 2, False, lambda: None)
            result = report["clips"][0]
            report["pass"] = (result["complete"] and result["finals"] == result["translations"] == 3
                              and not report["duplicate_finals"] and report["dropped_final_rate"] == 0
                              and report["agent"]["secondary_timeouts"] == 1)
            return report


async def run(args):
    with patch("server.streaming.SileroVad", FixtureVad):
        if args.browser:
            return await wire_check(browser=True)
        if args.wire:
            return await wire_check()
        return await direct_soak(args.minutes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--wire", action="store_true", help="Use an authenticated loopback WebSocket")
    mode.add_argument("--browser", action="store_true", help="Use Chromium and the demo AudioWorklet")
    mode.add_argument("--minutes", type=int, choices=(1, 10, 30, 60), default=1, help="Accelerated audio duration")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    start_wall, start_cpu = time.perf_counter(), time.process_time()
    with MemorySampler() as memory:
        report = asyncio.run(run(args))
    report.update(audio_kind="mock" if not args.browser else "repository synth demo", engine_kind="mock",
                  wall_seconds=round(time.perf_counter() - start_wall, 3),
                  process_cpu_seconds=round(time.process_time() - start_cpu, 3), memory=memory.report())
    output = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.output:
        with args.output.open("x", encoding="utf-8") as file:
            file.write(output)
    else:
        print(output, end="")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
