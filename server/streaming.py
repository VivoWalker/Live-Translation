"""Streaming session: PCM in, stabilized subtitles + translations out.

Design constraints
------------------
* One ASR call costs ~1-2 % of realtime on a desktop CPU (measured), but we
  still decode a *growing window* every ~600 ms instead of every audio chunk.
* Partials are cheap previews; finals come from Silero-VAD segments.
* Translation only happens for finals plus throttled long partials.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import numpy as np

from .asr import SAMPLE_RATE, SileroVad, SenseVoiceRecognizer
from .text import looks_complete, normalize_ja, stable_prefix
from .translate import TranslationPipeline

VAD_FRAME = 512
PARTIAL_INTERVAL = 0.6
MIN_PARTIAL_SPEECH = 0.9
MAX_SEGMENT = 12.0
MAX_WINDOW = 8.0
KEEP_SECONDS = 20.0
PARTIAL_TRANSLATE_EVERY = 2.0
PARTIAL_TRANSLATE_MIN_CHARS = 10

_TIMEOUT = object()


@dataclass
class SessionConfig:
    target_lang: str = "zh"
    source_lang: str = "ja"
    partial_translation: bool = True


@dataclass
class Stats:
    chunks: int = 0
    audio_seconds: float = 0.0
    decodes: int = 0
    decode_ms: float = 0.0
    finals: int = 0
    translations: int = 0
    translate_ms: float = 0.0

    def as_dict(self) -> dict:
        dec = self.decodes or 1
        return {
            "audio_seconds": round(self.audio_seconds, 2),
            "decodes": self.decodes,
            "avg_decode_ms": round(self.decode_ms / dec, 1),
            "rtf": round(self.decode_ms / 1000 / max(self.audio_seconds, 0.01), 4),
            "finals": self.finals,
            "translations": self.translations,
            "avg_translate_ms": round(self.translate_ms / max(self.translations, 1), 1),
        }


class StreamSession:
    def __init__(
        self,
        asr: SenseVoiceRecognizer,
        translator: TranslationPipeline,
        on_event,
        config: SessionConfig | None = None,
    ):
        self.asr = asr
        self.translator = translator
        self.on_event = on_event
        self.cfg = config or SessionConfig()
        self.vad = SileroVad()
        self.stats = Stats()

        self._q: asyncio.Queue[np.ndarray | None] = asyncio.Queue(maxsize=600)
        self._chunks: list[np.ndarray] = []
        self._chunk_starts: list[int] = []
        self._total = 0
        self._vad_pending = np.zeros(0, dtype=np.float32)

        self._speech = False
        self._seg_start = 0
        self._seg_id = 0
        self._last_partial_at = 0.0
        self._last_partial_tr_at = 0.0
        self._last_hyp = ""
        self._last_text = ""
        self._final_context = ""
        self._last_decode_ms = 0.0
        self._translate_task: asyncio.Task | None = None
        self._task: asyncio.Task | None = None
        self._closed = False

    # ---------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def push(self, pcm: np.ndarray) -> None:
        if self._closed:
            return
        if not np.issubdtype(pcm.dtype, np.floating):
            pcm = pcm.astype(np.float32) / 32768.0
        pcm = np.ascontiguousarray(pcm, dtype=np.float32)
        self.stats.chunks += 1
        self.stats.audio_seconds += len(pcm) / SAMPLE_RATE
        try:
            self._q.put_nowait(pcm)
        except asyncio.QueueFull:
            try:
                self._q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self._q.put_nowait(pcm)
            except asyncio.QueueFull:
                pass

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._q.put_nowait(None)
        except asyncio.QueueFull:
            pass
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=8)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        if self._translate_task and not self._translate_task.done():
            self._translate_task.cancel()
        await self.translator.tr.close()

    # ---------------------------------------------------------------- audio ring
    def _append(self, pcm: np.ndarray) -> None:
        self._chunks.append(pcm)
        self._chunk_starts.append(self._total)
        self._total += len(pcm)
        cutoff = int((self._total / SAMPLE_RATE - KEEP_SECONDS) * SAMPLE_RATE)
        while len(self._chunks) > 1 and self._chunk_starts[1] <= cutoff:
            self._chunks.pop(0)
            self._chunk_starts.pop(0)

    def _slice(self, start: int, end: int) -> np.ndarray:
        if not self._chunks or end <= start:
            return np.zeros(0, dtype=np.float32)
        parts = []
        for chunk, cstart in zip(self._chunks, self._chunk_starts):
            cend = cstart + len(chunk)
            if cend <= start or cstart >= end:
                continue
            parts.append(chunk[max(0, start - cstart): min(len(chunk), end - cstart)])
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts)

    def _emit(self, event: dict) -> None:
        try:
            self.on_event(event)
        except Exception:  # noqa: BLE001 - never break audio processing on UI errors
            pass

    def _feed_vad(self, pcm: np.ndarray) -> None:
        self._vad_pending = (
            np.concatenate([self._vad_pending, pcm]) if self._vad_pending.size else pcm
        )
        while len(self._vad_pending) >= VAD_FRAME:
            frame = self._vad_pending[:VAD_FRAME]
            self._vad_pending = self._vad_pending[VAD_FRAME:]
            self.vad.accept(frame)

    # ---------------------------------------------------------------- ASR/MT
    async def _decode(self, audio: np.ndarray) -> str:
        t0 = time.perf_counter()
        text = await asyncio.to_thread(self.asr.transcribe, audio)
        elapsed = (time.perf_counter() - t0) * 1000
        self._last_decode_ms = elapsed
        self.stats.decodes += 1
        self.stats.decode_ms += elapsed
        return normalize_ja(text)

    async def _translate(self, seg_id: int, text: str, final: bool) -> None:
        t0 = time.perf_counter()
        try:
            tr = await self.translator.translate(text, self.cfg.target_lang, context=self._final_context)
        except Exception as e:  # noqa: BLE001 - a failed translation must not kill the stream
            self._emit({"type": "error", "scope": "translate", "message": str(e)[:300], "id": seg_id})
            return
        self.stats.translations += 1
        self.stats.translate_ms += (time.perf_counter() - t0) * 1000
        if final and tr.text:
            self._final_context = text
        self._emit(
            {
                "type": "translation",
                "id": seg_id,
                "final": final,
                "text": tr.text,
                "engine": tr.engine,
                "ms": tr.ms,
            }
        )

    def _schedule_translation(self, seg_id: int, text: str, final: bool) -> None:
        running = self._translate_task and not self._translate_task.done()
        if running and not final:
            return
        if running:
            self._translate_task.cancel()
        self._translate_task = asyncio.create_task(self._translate(seg_id, text, final))

    async def _emit_partial(self) -> None:
        end = self._total
        start = max(self._seg_start, int(end - MAX_WINDOW * SAMPLE_RATE))
        audio = self._slice(start, end)
        if len(audio) < SAMPLE_RATE * MIN_PARTIAL_SPEECH:
            return
        text = await self._decode(audio)
        if not text:
            return
        stable = stable_prefix(self._last_hyp, text) if self._last_hyp else text
        self._last_hyp = text
        if text == self._last_text:
            return
        self._last_text = text
        self._emit(
            {"type": "partial", "id": self._seg_id, "text": text, "stable": stable, "t": round(end / SAMPLE_RATE, 2)}
        )
        if (
            self.cfg.partial_translation
            and len(stable) >= PARTIAL_TRANSLATE_MIN_CHARS
            and time.monotonic() - self._last_partial_tr_at >= PARTIAL_TRANSLATE_EVERY
            and (looks_complete(stable) or len(stable) >= PARTIAL_TRANSLATE_MIN_CHARS + 6)
        ):
            self._last_partial_tr_at = time.monotonic()
            self._schedule_translation(self._seg_id, stable, final=False)

    async def _finalize(self, audio: np.ndarray, audio_end_ratio: float) -> None:
        if len(audio) < SAMPLE_RATE * 0.3:
            self._reset_segment()
            return
        text = await self._decode(audio)
        if not text:
            self._reset_segment()
            return
        self.stats.finals += 1
        self._emit(
            {
                "type": "final",
                "id": self._seg_id,
                "text": text,
                "t": round(audio_end_ratio, 2),
                "decode_ms": round(self._last_decode_ms, 1),
            }
        )
        self._last_text = text
        self._schedule_translation(self._seg_id, text, final=True)
        self._seg_id += 1
        self._reset_segment()

    def _reset_segment(self) -> None:
        self._seg_start = self._total
        self._last_hyp = ""
        self._last_text = ""
        self._last_partial_at = 0.0

    # ---------------------------------------------------------------- loop
    async def _step(self) -> None:
        in_speech = self.vad.in_speech
        if in_speech and not self._speech:
            self._speech = True
            self._seg_start = max(0, self._total - int(0.3 * SAMPLE_RATE))
            self._last_partial_at = time.monotonic()
            self._emit({"type": "speech_start", "id": self._seg_id})
        elif self._speech and not in_speech:
            segments = self.vad.pop_segments()
            self._speech = False
            if segments:
                await self._finalize(segments[-1], self._total / SAMPLE_RATE)
            else:
                self._reset_segment()
            return

        if not self._speech:
            return
        dur = (self._total - self._seg_start) / SAMPLE_RATE
        if dur >= MAX_SEGMENT:
            await self._finalize(self._slice(self._seg_start, self._total), self._total / SAMPLE_RATE)
        elif dur >= MIN_PARTIAL_SPEECH and time.monotonic() - self._last_partial_at >= PARTIAL_INTERVAL:
            self._last_partial_at = time.monotonic()
            await self._emit_partial()

    async def _run(self) -> None:
        while True:
            try:
                item = await asyncio.wait_for(self._q.get(), timeout=0.05)
            except asyncio.TimeoutError:
                item = _TIMEOUT
            if item is None:
                break
            if item is not _TIMEOUT:
                self._append(item)  # type: ignore[arg-type]
                self._feed_vad(item)  # type: ignore[arg-type]
            await self._step()

        try:
            self.vad.flush()
            while self.vad.pop_segments():
                pass
        except Exception:  # noqa: BLE001
            pass
        if self._translate_task and not self._translate_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._translate_task), 8)
            except Exception:  # noqa: BLE001
                pass
