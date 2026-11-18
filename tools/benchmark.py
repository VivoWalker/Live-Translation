"""Repeatable local ASR, translation, diarization and streaming benchmarks."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.asr import PROVIDERS, SAMPLE_RATE, create_recognizer
from server.asr_domain import PACKS
from server.benchmark import latency_summary, load_dataset, load_json, score_asr, score_diarization, score_translation
from server.text import edit_distance
from tools.benchmark_stream import load_audio, stream_dataset


class MemorySampler:
    def __init__(self, pid=None, gpu=False):
        self.stop = threading.Event()
        self.thread = None
        self.first_rss = self.peak_rss = self.last_rss = None
        self.peak_gpu = None
        self.gpu = shutil.which("nvidia-smi") if gpu else None
        self.pid = pid or os.getpid()
        try:
            import psutil
            self.process_errors = (OSError, psutil.Error)
        except ImportError:
            self.process_errors = (OSError,)
            self.process = None
        else:
            try:
                self.process = psutil.Process(self.pid)
            except psutil.Error:
                self.process = None

    def capture_rss(self):
        try:
            return self.process.memory_info().rss if self.process else None
        except self.process_errors:
            return None

    def sample(self):
        value = self.capture_rss()
        if value is not None:
            if self.first_rss is None:
                self.first_rss = value
            self.peak_rss = max(self.peak_rss or 0, value)
            self.last_rss = value

    def __enter__(self):
        self.sample()
        self.thread = threading.Thread(target=self._poll, daemon=True)
        self.thread.start()
        return self

    def _poll(self):
        while not self.stop.wait(.5):
            self.sample()
            if self.gpu:
                try:
                    output = subprocess.check_output(
                        [self.gpu, "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                        text=True, timeout=.5, stderr=subprocess.DEVNULL)
                    values = [int(memory.strip()) for pid, memory in (line.split(",", 1) for line in output.splitlines())
                              if pid.strip() == str(self.pid) and memory.strip().isdigit()]
                    if values:
                        self.peak_gpu = max(self.peak_gpu or 0, sum(values))
                except (OSError, ValueError, subprocess.SubprocessError):
                    pass

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=1)
        self.sample()

    def report(self):
        return {"sampled_rss_bytes": self.peak_rss, "initial_rss_bytes": self.first_rss,
                "final_rss_bytes": self.last_rss, "sampled_peak_vram_mib": self.peak_gpu}


def hardware():
    cpu = platform.processor() or platform.machine()
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        with cpuinfo.open(encoding="utf-8") as file:
            cpu = next((line.split(":", 1)[1].strip() for line in file if line.startswith("model name")), cpu)
    gpu = None
    if shutil.which("nvidia-smi"):
        try:
            gpu = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
                                           "--format=csv,noheader"], text=True, timeout=2).splitlines()
        except (OSError, subprocess.SubprocessError):
            pass
    return {"platform": platform.platform(), "cpu": cpu, "logical_cpus": os.cpu_count(), "gpus": gpu,
            "python": platform.python_version()}


def model_spec(value):
    backend, _, directory = value.partition("=")
    if backend not in PROVIDERS:
        raise argparse.ArgumentTypeError("Use PROVIDER or PROVIDER=/local/model/directory")
    return backend, directory or None


def asr_worker(args):
    dataset = load_dataset(args.manifest)
    backend, directory = args.model
    tokenizer = None
    if any(clip.reference is not None for clip in dataset.clips):
        from janome.tokenizer import Tokenizer
        tokenizer = Tokenizer(wakati=True)

    with MemorySampler(gpu=args.device == "cuda") as memory:
        started = time.perf_counter()
        model = create_recognizer(backend, directory, num_threads=args.threads, asr_domain=args.packs,
                                  device=args.device, precision=args.precision)
        load_ms = (time.perf_counter() - started) * 1000
        for _ in range(args.warmup):
            model.transcribe(load_audio(dataset.clips[0].audio))

        elapsed, inputs, raw, decoded = [], {}, {}, 0
        for _ in range(args.repeat):
            for clip in dataset.clips:
                audio = load_audio(clip.audio)
                started = time.perf_counter()
                recognition = model.recognize(audio)
                elapsed.append((time.perf_counter() - started) * 1000)
                inputs[clip.id] = recognition.text
                raw[clip.id] = recognition.original
                decoded += len(audio)
    scores = score_asr(dataset, inputs, tokenize=(lambda text: list(tokenizer.tokenize(text))) if tokenizer else None)
    chars = scores["reference_characters"]
    backend_cer = (sum(edit_distance(raw[clip.id], clip.reference) for clip in dataset.clips
                       if clip.reference is not None) / chars) if chars else None
    report = {
        "backend": backend, "model": model.name, "dataset_sha256": dataset.digest,
        "capabilities": asdict(model.capabilities), "threads": args.threads, "repeat": args.repeat, "warmup": args.warmup,
        "packs": args.packs, "load_ms": round(load_ms, 1), "rtf": sum(elapsed) / 1000 / (decoded / SAMPLE_RATE),
        "avg_decode_ms": statistics.fmean(elapsed), "decode_latency": latency_summary(elapsed), "memory": memory.report(),
        "cer_backend_raw": backend_cer, **scores,
    }
    if args.include_text:
        report["predictions"] = inputs
    return report


def run_models(args, dataset):
    reports = []
    for backend, directory in args.model:
        with tempfile.TemporaryDirectory(prefix="jls-model-benchmark-") as tmp:
            path = Path(tmp) / "result.json"
            spec = f"{backend}={directory}" if directory else backend
            command = [sys.executable, __file__, "_asr", str(args.manifest), "--model", spec, "--output", str(path),
                       "--threads", str(args.threads), "--device", args.device, "--warmup", str(args.warmup),
                       "--repeat", str(args.repeat), "--packs", *args.packs]
            if args.precision:
                command.extend(["--precision", args.precision])
            if args.include_text:
                command.append("--include-text")
            try:
                result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                        text=True, timeout=args.timeout, check=False)
                if result.returncode:
                    reports.append({"backend": backend, "failed": True, "exit_status": result.returncode,
                                    "error": result.stderr.splitlines()[-1][:240] if result.stderr else "Worker exited"})
                    continue
                report = load_json(path)
                if report["dataset_sha256"] != dataset.digest:
                    raise ValueError("Benchmark input changed between runs")
                reports.append(report)
            except subprocess.TimeoutExpired:
                reports.append({"backend": backend, "failed": True, "error": "Model worker exceeded deadline"})
    return {"models": reports}


def options(parser, *, multiple):
    model = parser.add_argument("--model", type=model_spec, required=True, action="append" if multiple else "store")
    model.metavar = "PROVIDER[=DIR]"
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--precision")
    parser.add_argument("--warmup", type=int, choices=range(0, 6), default=1)
    parser.add_argument("--repeat", type=int, choices=range(1, 6), default=1)
    parser.add_argument("--packs", nargs="*", choices=PACKS, default=[])
    parser.add_argument("--include-text", action="store_true")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="mode", required=True)
    for mode in ("asr", "stream", "translation", "diarization", "_asr"):
        cli = subs.add_parser(mode)
        cli.add_argument("manifest", type=Path)
        cli.add_argument("--output", type=Path)
        if mode in ("asr", "_asr"):
            options(cli, multiple=mode == "asr")
            if mode == "asr":
                cli.add_argument("--timeout", type=int, default=1800)
        elif mode == "stream":
            cli.add_argument("--url", default="ws://127.0.0.1:8765/ws")
            cli.add_argument("--target", choices=("zh", "en"), default="zh")
            cli.add_argument("--speed", type=float, default=1)
            cli.add_argument("--server-pid", type=int)
            cli.add_argument("--include-text", action="store_true")
        else:
            cli.add_argument("--predictions", type=Path, required=True)
            if mode == "translation":
                cli.add_argument("--target", choices=("zh", "en"), default="zh")
    args = parser.parse_args()
    try:
        if args.mode == "_asr":
            report = asr_worker(args)
        else:
            dataset = load_dataset(args.manifest)
            report = {"dataset": dataset.name, "dataset_sha256": dataset.digest, "clips": len(dataset.clips),
                      "hardware": hardware(), "mode": args.mode}
            if args.mode == "asr":
                report.update(run_models(args, dataset))
            elif args.mode == "stream":
                endpoint = urlsplit(args.url)
                token = os.environ.get("JLSUBS_ACCESS_TOKEN")
                if (not token or not 0 < args.speed <= 2 or endpoint.scheme not in ("ws", "wss")
                        or endpoint.hostname not in ("127.0.0.1", "localhost", "::1") or endpoint.username or endpoint.password):
                    raise ValueError("Use a loopback service, 0 < speed <= 2 and JLSUBS_ACCESS_TOKEN")
                if args.server_pid:
                    with MemorySampler(args.server_pid, gpu=True) as memory:
                        report.update(asyncio.run(stream_dataset(dataset, args.url, token, args.target,
                                                                  args.speed, args.include_text, memory.sample)))
                    report["server_memory"] = memory.report()
                else:
                    report.update(asyncio.run(stream_dataset(dataset, args.url, token, args.target,
                                                              args.speed, args.include_text, lambda: None)))
            else:
                predictions = load_json(args.predictions)
                if not isinstance(predictions, dict):
                    raise ValueError("Predictions must be a JSON object keyed by clip ID")
                if args.mode == "translation":
                    if any(not isinstance(text, str) or len(text) > 8192 for text in predictions.values()):
                        raise ValueError("Expected a string prediction for each translation")
                    report.update(score_translation(dataset, predictions, args.target))
                else:
                    report.update(score_diarization(dataset, predictions))
        output = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            with args.output.open("x", encoding="utf-8") as file:
                file.write(output)
        else:
            print(output, end="")
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))
    return int(any(model.get("failed") for model in report.get("models", ()))
               or args.mode == "stream" and report["complete_sessions"] != report["clips"])


if __name__ == "__main__":
    raise SystemExit(main())
