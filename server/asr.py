"""Local CPU ASR backends using sherpa-onnx's int8 ONNX exports."""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
import sherpa_onnx

from .asr_domain import Correction, DomainCorrector
from .text import normalize_ja

SAMPLE_RATE = 16000
PROVIDERS = ("sensevoice", "whisper", "parakeet", "whisper-turbo", "qwen3-asr")


@dataclass(frozen=True)
class Capabilities:
    languages: tuple[str, ...] = ("ja",)
    timestamps: bool = False
    context_prompt: bool = False
    partial_transcription: bool = True
    streaming: bool = False
    device: str = "cpu"
    precision: str = "int8"


@dataclass(frozen=True)
class RecognitionContext:
    previous: str = ""
    terms: tuple[str, ...] = ()
    corrector: DomainCorrector | None = None

    @property
    def prompt(self) -> str:
        return "、".join(self.terms[:12])[:200]


@dataclass(frozen=True)
class Recognition:
    text: str
    original: str
    timestamps: tuple[tuple[float, float, str], ...] = ()
    changes: tuple[Correction, ...] = ()
    candidates: tuple[Correction, ...] = ()


class Recognizer(Protocol):
    name: str
    model_dir: str
    partial_interval: float
    min_partial_speech: float

    def transcribe(self, audio: np.ndarray, context: RecognitionContext | None = None) -> str: ...


class BackendUnavailable(RuntimeError):
    pass


def _candidate_dirs() -> list[Path]:
    here = Path(__file__).resolve().parent.parent
    dirs: list[Path] = []
    env = os.environ.get("JLSUBS_MODEL_DIR")
    if env:
        dirs.append(Path(env))
    dirs.append(here / "models" / "sensevoice-onnx")
    # Reuse the model that the DSH voice-input plugin already downloaded.
    dsh_home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
    dirs.append(dsh_home / "speech-to-text" / "sensevoice" / "models" / "sensevoice-onnx")
    return dirs


def resolve_model_dir(explicit: str | None = None) -> str:
    if explicit:
        p = Path(explicit)
        if (p / "model.int8.onnx").is_file() and (p / "tokens.txt").is_file():
            return str(p)
        raise FileNotFoundError(f"SenseVoice requires model.int8.onnx + tokens.txt under {p}")
    for d in _candidate_dirs():
        if (d / "model.int8.onnx").exists() and (d / "tokens.txt").exists():
            return str(d)
    raise FileNotFoundError(
        "SenseVoice model not found. Put model.int8.onnx + tokens.txt in "
        f"{Path(__file__).resolve().parent.parent / 'models' / 'sensevoice-onnx'} "
        "or set JLSUBS_MODEL_DIR."
    )


def resolve_whisper_model(explicit: str | None = None) -> tuple[Path, str]:
    """Resolve one matching multilingual encoder/decoder/tokens int8 set."""
    root = Path(__file__).resolve().parent.parent
    configured = explicit or os.environ.get("JLSUBS_WHISPER_MODEL_DIR")
    directories = [Path(configured)] if configured else [root / "models" / "whisper-base"]
    for directory in directories:
        prefixes = [p.name.removesuffix("-encoder.int8.onnx")
                    for p in directory.glob("*-encoder.int8.onnx") if p.is_file()]
        complete = [prefix for prefix in prefixes
                    if (directory / f"{prefix}-decoder.int8.onnx").is_file()
                    and (directory / f"{prefix}-tokens.txt").is_file()]
        if len(complete) > 1:
            raise ValueError(f"Multiple Whisper models under {directory}; use a separate directory for each model")
        if complete:
            prefix = complete[0]
            if prefix.endswith(".en"):
                raise ValueError("English-only Whisper models cannot recognize Japanese; download a multilingual model")
            return directory, prefix
    raise FileNotFoundError(
        f"Whisper model not found under {directories[0]}. Requires matching "
        "<size>-encoder.int8.onnx, <size>-decoder.int8.onnx and <size>-tokens.txt "
        "from sherpa-onnx. Use --model-dir or JLSUBS_WHISPER_MODEL_DIR."
    )


def resolve_vad_model() -> str | None:
    here = Path(__file__).resolve().parent.parent
    for d in [
        here / "models" / "silero" / "silero_vad.onnx",
        Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
        / "speech-to-text"
        / "sensevoice"
        / "models"
        / "silero"
        / "silero_vad.onnx",
    ]:
        if d.exists():
            return str(d)
    return None


def resample_to_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    """Cheap resampler. The browser already hands us 16 kHz, this is for files."""
    if sr == SAMPLE_RATE:
        return np.ascontiguousarray(audio, dtype=np.float32)
    if audio.size == 0:
        return np.zeros(0, dtype=np.float32)
    if sr > SAMPLE_RATE:  # anti-alias before decimation
        k = max(2, int(round(sr / SAMPLE_RATE)))
        kernel = np.ones(k, dtype=np.float32) / k
        audio = np.convolve(audio, kernel, mode="same")
    n_out = int(round(len(audio) * SAMPLE_RATE / sr))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


class _OfflineRecognizer:
    """Serialize native inference across sessions sharing one model."""

    capabilities = Capabilities()
    mode = "fast"

    def transcribe(self, audio: np.ndarray, context: RecognitionContext | None = None) -> str:
        return self.recognize(audio, context).text

    def recognize(self, audio: np.ndarray, context: RecognitionContext | None = None) -> Recognition:
        audio = np.ascontiguousarray(audio, dtype=np.float32)
        if audio.size < SAMPLE_RATE * 0.2:
            return Recognition("", "")
        with self._lock:
            result = self._infer(audio, context)
        text = result.text
        if self.language == "ja":
            corrector = context.corrector if context and context.corrector is not None else self.domain
            text, changes, candidates = corrector.inspect(normalize_ja(result.text))
            return Recognition(text, result.original, result.timestamps, changes, candidates)
        return result

    def _infer(self, audio: np.ndarray, context: RecognitionContext | None) -> Recognition:
        stream = self._rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self._rec.decode_stream(stream)
        text = (stream.result.text or "").strip()
        return Recognition(text, text)


class SenseVoiceRecognizer(_OfflineRecognizer):
    """Thin, thread-safe wrapper around sherpa-onnx SenseVoiceSmall."""

    name = "sensevoice-int8"
    capabilities = Capabilities(languages=("ja", "zh", "en", "ko", "yue", "auto"))
    partial_interval = 0.6
    min_partial_speech = 0.9

    def __init__(self, model_dir: str | None = None, language: str = "ja", num_threads: int = 4,
                 asr_domain: str | list[str] = "gakumas", asr_terms: str | None = None):
        self.domain = DomainCorrector(asr_domain, asr_terms)
        model_dir = resolve_model_dir(model_dir)
        self.model_dir = model_dir
        self.language = language
        self._lock = threading.Lock()
        self._rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(model_dir, "model.int8.onnx"),
            tokens=os.path.join(model_dir, "tokens.txt"),
            num_threads=num_threads,
            use_itn=True,
            language=language,
            debug=False,
        )


class WhisperRecognizer(_OfflineRecognizer):
    """Whisper transcribes Japanese; the existing translator produces Chinese."""

    partial_interval = 2.0
    min_partial_speech = 2.0
    capabilities = Capabilities(languages=("ja", "auto"))

    def __init__(self, model_dir: str | None = None, language: str = "ja", num_threads: int = 4,
                 asr_domain: str | list[str] = "gakumas", asr_terms: str | None = None):
        self.domain = DomainCorrector(asr_domain, asr_terms)
        directory, prefix = resolve_whisper_model(model_dir)
        self.model_dir = str(directory)
        self.name = f"whisper-{prefix}-int8"
        self.language = language
        self._lock = threading.Lock()
        self._rec = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=str(directory / f"{prefix}-encoder.int8.onnx"),
            decoder=str(directory / f"{prefix}-decoder.int8.onnx"),
            tokens=str(directory / f"{prefix}-tokens.txt"),
            language="" if language == "auto" else language,
            task="transcribe",
            num_threads=num_threads,
            provider="cpu",
            debug=False,
        )


def create_recognizer(engine: str = "sensevoice", model_dir: str | None = None,
                      language: str = "ja", num_threads: int = 4,
                      asr_domain: str | list[str] = "gakumas", asr_terms: str | None = None,
                      *, device: str = "cpu", precision: str | None = None) -> Recognizer:
    if not 1 <= num_threads <= 64:
        raise ValueError("ASR threads must be at least 1 and at most 64")
    if device not in ("cpu", "cuda"):
        raise ValueError("ASR device must be cpu or cuda")
    backends = {"sensevoice": SenseVoiceRecognizer, "whisper": WhisperRecognizer}
    if engine not in PROVIDERS:
        raise ValueError(f"Unknown ASR backend: {engine}")
    options = dict(model_dir=model_dir, language=language, num_threads=num_threads,
                   asr_domain=asr_domain, asr_terms=asr_terms)
    if engine in backends:
        if device != "cpu" or precision not in (None, "int8"):
            raise ValueError("The sherpa-onnx backends use CPU int8")
        return backends[engine](**options)
    from .asr_backends import OPTIONAL_BACKENDS
    return OPTIONAL_BACKENDS[engine](**options, device=device, precision=precision)


@dataclass(frozen=True)
class SpeechSpan:
    start: int
    samples: np.ndarray

    @property
    def end(self) -> int:
        return self.start + len(self.samples)


class SileroVad:
    """Silero VAD from sherpa-onnx, used to cut utterances out of a stream."""

    def __init__(self, threshold: float = 0.5, min_silence: float = 0.4, min_speech: float = 0.25):
        model = resolve_vad_model()
        if not model:
            raise FileNotFoundError("silero_vad.onnx not found")
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = model
        cfg.silero_vad.threshold = threshold
        cfg.silero_vad.min_silence_duration = min_silence
        cfg.silero_vad.min_speech_duration = min_speech
        cfg.sample_rate = SAMPLE_RATE
        self._vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)

    def accept(self, audio: np.ndarray) -> None:
        self._vad.accept_waveform(audio)

    def pop_segments(self, since: int = 0) -> list[np.ndarray]:
        return [span.samples for span in self.pop_spans(since)]

    def pop_spans(self, since: int = 0) -> list[SpeechSpan]:
        out = []
        while not self._vad.empty():
            seg = self._vad.front
            samples = np.asarray(seg.samples, dtype=np.float32)
            # A long utterance may already have emitted a forced final. The
            # detector still returns the whole utterance when silence arrives.
            offset = max(0, since - seg.start)
            if offset < len(samples):
                out.append(SpeechSpan(seg.start + offset, samples[offset:]))
            self._vad.pop()
        return out

    @property
    def in_speech(self) -> bool:
        return bool(self._vad.is_speech_detected())
