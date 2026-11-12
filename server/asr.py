"""SenseVoice ASR wrapper (sherpa-onnx, CPU, int8).

The model is the official SenseVoiceSmall int8 ONNX export. Japanese is one of
the languages it was trained on; we pin ``language="ja"`` to avoid the
auto-detect step drifting on short clips.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16000


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
        if (p / "model.int8.onnx").exists():
            return str(p)
        raise FileNotFoundError(f"model.int8.onnx not found under {p}")
    for d in _candidate_dirs():
        if (d / "model.int8.onnx").exists() and (d / "tokens.txt").exists():
            return str(d)
    raise FileNotFoundError(
        "SenseVoice model not found. Put model.int8.onnx + tokens.txt in "
        f"{Path(__file__).resolve().parent.parent / 'models' / 'sensevoice-onnx'} "
        "or set JLSUBS_MODEL_DIR."
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


class SenseVoiceRecognizer:
    """Thin, thread-safe wrapper around sherpa-onnx SenseVoiceSmall."""

    def __init__(self, model_dir: str | None = None, language: str = "ja", num_threads: int = 4):
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

    def transcribe(self, audio: np.ndarray) -> str:
        audio = np.ascontiguousarray(audio, dtype=np.float32)
        if audio.size < SAMPLE_RATE * 0.2:
            return ""
        with self._lock:
            stream = self._rec.create_stream()
            stream.accept_waveform(SAMPLE_RATE, audio)
            self._rec.decode_stream(stream)
            return (stream.result.text or "").strip()


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

    def pop_segments(self) -> list[np.ndarray]:
        out = []
        while not self._vad.empty():
            seg = self._vad.front
            out.append(np.asarray(seg.samples, dtype=np.float32))
            self._vad.pop()
        return out

    @property
    def in_speech(self) -> bool:
        return bool(self._vad.is_speech_detected())
