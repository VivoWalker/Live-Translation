"""Opt-in local runtimes. Import each dependency only when selected."""
from __future__ import annotations

import threading
from contextlib import nullcontext
from pathlib import Path

from .asr import BackendUnavailable, Capabilities, Recognition, SAMPLE_RATE, _OfflineRecognizer
from .asr_domain import DomainCorrector


class _LocalBackend(_OfflineRecognizer):
    mode = "enhanced"
    partial_interval = 3.0
    min_partial_speech = 2.5
    default_cuda = "float16"
    precisions = {"cpu": ("float32",), "cuda": ("float16", "float32")}
    checkpoint: str | None = None
    files: tuple[str, ...] = ()
    timestamps = context_prompt = False
    partial_transcription = False

    def __init__(self, *, model_dir, language, num_threads, asr_domain, asr_terms, device, precision):
        if language != "ja":
            raise ValueError(f"{self.name} is configured for Japanese")
        precision = precision or (self.precisions["cpu"][0] if device == "cpu" else self.default_cuda)
        if precision not in self.precisions[device]:
            raise ValueError(f"{self.name} does not support {device}/{precision}")
        path = Path(model_dir).expanduser() if model_dir else None
        if path and path.is_dir() and self.checkpoint:
            path = path / self.checkpoint
        if path is None or (self.checkpoint and not path.is_file()) or (
            not self.checkpoint and (not path.is_dir() or any(not (path / name).is_file() for name in self.files))
        ):
            raise FileNotFoundError(f"{self.name} requires a complete local --model-dir (see docs/local-service.md)")
        self.language = language
        self.model_dir = str(path)
        self.domain = DomainCorrector(asr_domain, asr_terms)
        self.capabilities = Capabilities(timestamps=self.timestamps, context_prompt=self.context_prompt,
                                         partial_transcription=self.partial_transcription, device=device, precision=precision)
        self._lock = threading.Lock()
        try:
            self._load(path, device, precision, num_threads)
        except ImportError:
            raise BackendUnavailable(f"{self.name} optional runtime is missing or incompatible") from None
        except (OSError, RuntimeError, ValueError, TypeError):
            raise BackendUnavailable(f"{self.name} could not initialize the local model on {device}/{precision}") from None


class ParakeetRecognizer(_LocalBackend):
    name = "parakeet-tdt-ctc-0.6b-ja"
    mode = "fast"
    checkpoint = "parakeet-tdt_ctc-0.6b-ja.nemo"
    partial_transcription = True

    def _load(self, path, device, precision, threads):
        import torch
        from nemo.collections.asr.models import ASRModel

        self._torch = torch
        self._amp = device == "cuda" and precision == "float16"
        if device == "cpu":
            torch.set_num_threads(threads)
        self._model = ASRModel.restore_from(str(path), map_location=torch.device(device))
        self._model.to(device=device, dtype=getattr(torch, precision))
        self._model.eval()

    def _infer(self, audio, context):
        amp = self._torch.autocast(device_type="cuda", dtype=self._torch.float16) if self._amp else nullcontext()
        with self._torch.inference_mode(), amp:
            item = self._model.transcribe([audio], batch_size=1, verbose=False)[0]
        text = (item if isinstance(item, str) else item.text).strip()
        return Recognition(text, text)


class WhisperTurboRecognizer(_LocalBackend):
    name = "whisper-large-v3-turbo-ct2"
    files = ("config.json", "model.bin", "tokenizer.json", "vocabulary.json")
    precisions = {"cpu": ("int8", "float32"), "cuda": ("float16", "int8_float16", "float32")}
    timestamps = context_prompt = True

    def _load(self, path, device, precision, threads):
        from faster_whisper import WhisperModel

        self._model = WhisperModel(str(path), device=device, compute_type=precision,
                                   cpu_threads=threads, num_workers=1, local_files_only=True)

    def _infer(self, audio, context):
        segments, _ = self._model.transcribe(audio, language="ja", task="transcribe", beam_size=1,
                                             vad_filter=False, condition_on_previous_text=False,
                                             initial_prompt=context.prompt if context else None)
        spans = tuple((segment.start, segment.end, segment.text) for segment in segments)
        text = "".join(span[2] for span in spans).strip()
        return Recognition(text, text, spans)


class QwenRecognizer(_LocalBackend):
    name = "qwen3-asr-1.7b"
    files = ("config.json", "preprocessor_config.json", "tokenizer_config.json")
    context_prompt = True
    default_cuda = "bfloat16"
    precisions = {"cpu": ("float32",), "cuda": ("bfloat16", "float16", "float32")}

    def _load(self, path, device, precision, threads):
        import torch
        from qwen_asr import Qwen3ASRModel

        if device == "cpu":
            torch.set_num_threads(threads)
        self._model = Qwen3ASRModel.from_pretrained(str(path), dtype=getattr(torch, precision),
                                                   device_map=device, max_inference_batch_size=1,
                                                   max_new_tokens=256, local_files_only=True)

    def _infer(self, audio, context):
        item = self._model.transcribe(audio=(audio, SAMPLE_RATE), language="Japanese",
                                      context=context.prompt if context else "")[0]
        text = item.text.strip()
        return Recognition(text, text)


OPTIONAL_BACKENDS = {"parakeet": ParakeetRecognizer, "whisper-turbo": WhisperTurboRecognizer,
                     "qwen3-asr": QwenRecognizer}
