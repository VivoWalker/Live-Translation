"""Streaming session: PCM in, stabilized subtitles + translations out.

Design constraints
------------------
* Preview pacing follows the backend and measured decoding cost. Whisper
  needs longer windows and less frequent previews than SenseVoice.
* Partials are cheap previews; finals come from Silero-VAD segments.
* Only finalized segments are translated; partials remain ASR previews.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import numpy as np

from .asr import SAMPLE_RATE, SileroVad, Recognizer
from .text import normalize_ja, stable_prefix, trim_overlap
from .translate import TranslationPipeline
from .security import MAX_BUFFERED_BYTES, MAX_FRAME_BYTES

VAD_FRAME = 512
MAX_WINDOW = 8.0
KEEP_SECONDS = 20.0
PREVIEW_BACKLOG = 19_200  # 300 ms of queued float32 PCM
MAX_TRANSLATIONS = 32
TRANSLATION_CONCURRENCY = 3
TRANSLATION_DEADLINE = 28.0

class AudioBacklogError(ValueError):
    pass


@dataclass(frozen=True)
class VadSettings:
    min_silence: float = 0.4
    max_segment: float = 12.0
    overlap: float = 0.0

    def __post_init__(self) -> None:
        for name, low, high in (("min_silence", .2, 1.2), ("max_segment", 8, 16), ("overlap", 0, .30)):
            value = getattr(self, name)
            if type(value) not in (int, float) or not low <= value <= high:
                raise ValueError(f"VAD {name} must be between {low} and {high} seconds")


@dataclass
class SessionConfig:
    target_lang: str = "zh"
    source_lang: str = "ja"
    vad: VadSettings = VadSettings()


@dataclass
class Stats:
    chunks: int = 0
    audio_seconds: float = 0.0
    decodes: int = 0
    decode_ms: float = 0.0
    finals: int = 0
    translations: int = 0
    translate_ms: float = 0.0
    translation_failures: int = 0
    translation_timeouts: int = 0
    translation_overflows: int = 0
    translation_cancelled: int = 0
    audio_overflows: int = 0
    preview_backlog_skips: int = 0
    decode_failures: int = 0

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
            "translation_failures": self.translation_failures,
            "translation_timeouts": self.translation_timeouts,
            "translation_overflows": self.translation_overflows,
            "translation_cancelled": self.translation_cancelled,
            "audio_overflows": self.audio_overflows,
            "preview_backlog_skips": self.preview_backlog_skips,
            "decode_failures": self.decode_failures,
        }


class StreamSession:
    def __init__(
        self,
        asr: Recognizer,
        translator: TranslationPipeline,
        on_event,
        config: SessionConfig | None = None,
    ):
        self.asr = asr
        self.translator = translator.new_session() if isinstance(translator, TranslationPipeline) else translator
        self.on_event = on_event
        self.cfg = config or SessionConfig()
        self.vad = SileroVad(min_silence=self.cfg.vad.min_silence)
        self._max_segment = round(self.cfg.vad.max_segment * SAMPLE_RATE)
        self._overlap = round(self.cfg.vad.overlap * SAMPLE_RATE)
        self.stats = Stats()

        self._q: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=64)
        self._queued_bytes = 0
        self._chunks: list[np.ndarray] = []
        self._chunk_starts: list[int] = []
        self._total = 0
        self._vad_pending = np.zeros(0, dtype=np.float32)

        self._speech = False
        self._seg_start = 0
        self._seg_id = 0
        self._finalized_until = 0
        self._last_forced_text = ""
        self._last_partial_at = 0.0
        self._last_partial_total = 0
        self._last_hyp = ""
        self._last_text = ""
        self.previous_final_japanese = ""
        self.last_translated_segment: int | None = None
        self._last_decode_ms = 0.0
        self._translations: dict[int, asyncio.Task] = {}
        self._translation_slots = asyncio.Semaphore(TRANSLATION_CONCURRENCY)
        self._last_submitted_id = -1
        self.translation_epoch = 0
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
        if pcm.ndim != 1 or pcm.nbytes > MAX_FRAME_BYTES or not np.isfinite(pcm).all():
            raise ValueError('Invalid or oversized PCM frame')
        if not pcm.size:
            return
        if self._queued_bytes + pcm.nbytes > MAX_BUFFERED_BYTES or self._q.full():
            self.stats.audio_overflows += 1
            raise AudioBacklogError('Audio buffer limit exceeded; slow down')
        self.stats.chunks += 1
        self.stats.audio_seconds += len(pcm) / SAMPLE_RATE
        self._q.put_nowait(pcm)
        self._queued_bytes += pcm.nbytes

    @property
    def queued_audio_bytes(self) -> int:
        return self._queued_bytes

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        tasks = list(self._translations.values())
        if self._task is not None:
            tasks.append(self._task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if isinstance(self.translator, TranslationPipeline):
            await self.translator.close()
        self._translations.clear()
        self.previous_final_japanese = ""
        self.last_translated_segment = None
        while not self._q.empty():
            self._q.get_nowait()
        self._queued_bytes = 0
        self._chunks.clear()
        self._chunk_starts.clear()
        self._vad_pending = np.zeros(0, dtype=np.float32)
        # The translator belongs to the application, not this connection.

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
        if self._closed:
            return
        try:
            self.on_event(event)
        except Exception:  # noqa: BLE001 - never break audio processing on UI errors
            pass

    async def _feed_vad(self, pcm: np.ndarray) -> None:
        pending = np.concatenate([self._vad_pending, pcm]) if self._vad_pending.size else pcm
        start = self._total - len(pending)
        consumed = len(pending) - len(pending) % VAD_FRAME
        for offset in range(0, consumed, VAD_FRAME):
            end = offset + VAD_FRAME
            self.vad.accept(pending[offset:end])
            await self._step(start + end, preview=False)
        self._vad_pending = pending[consumed:].copy()
        await self._maybe_preview(start + consumed)

    # ---------------------------------------------------------------- ASR/MT
    async def _decode(self, audio: np.ndarray) -> str:
        t0 = time.perf_counter()
        try:
            text = await asyncio.to_thread(self.asr.transcribe, audio)
        except Exception:
            self.stats.decode_failures += 1
            self._emit({"type": "error", "scope": "asr", "code": "asr_decode_failed",
                        "message": "语音识别失败"})
            return ""
        elapsed = (time.perf_counter() - t0) * 1000
        self._last_decode_ms = elapsed
        self.stats.decodes += 1
        self.stats.decode_ms += elapsed
        return normalize_ja(text)

    async def set_target(self, target: str) -> None:
        if target == self.cfg.target_lang:
            return
        self.cfg.target_lang = target
        self.translation_epoch += 1
        self.previous_final_japanese = ""
        self.last_translated_segment = None
        if isinstance(self.translator, TranslationPipeline):
            self.translator.reset()
        for seg_id, task in self._translations.items():
            if not task.done() and not task.cancelling():
                task.cancel()
                self.stats.translation_cancelled += 1
                self._emit({"type": "translation_cancelled", "id": seg_id})

    def translation_stats(self) -> dict:
        stats = self.translator.snapshot() if isinstance(self.translator, TranslationPipeline) else {}
        return {**stats, "deliveries_in_flight": len(self._translations),
                "last_translated_segment": self.last_translated_segment}

    async def _translate(self, seg_id: int, text: str, target: str, context: str, epoch: int,
                         deadline: float) -> None:
        try:
            async with asyncio.timeout_at(deadline), self._translation_slots:
                tr = await self.translator.translate(text, target, context=context)
            if not tr.text:
                raise ValueError("Empty translation")
        except Exception as error:
            if not self._closed and epoch == self.translation_epoch:
                self.stats.translation_failures += 1
                timed_out = isinstance(error, TimeoutError)
                self.stats.translation_timeouts += int(timed_out)
                self._emit({"type": "error", "scope": "translate", "id": seg_id,
                            "code": "translation_timeout" if timed_out else "translation_failed",
                            "message": "翻译请求超时" if timed_out else "翻译失败"})
            return
        if self._closed or epoch != self.translation_epoch:
            return
        if self.last_translated_segment is None or seg_id > self.last_translated_segment:
            self.last_translated_segment = seg_id
        self.stats.translations += 1
        elapsed = asyncio.get_running_loop().time() - (deadline - TRANSLATION_DEADLINE)
        self.stats.translate_ms += elapsed * 1000
        self._emit(
            {
                "type": "translation",
                "id": seg_id,
                "final": True,
                "text": tr.text,
                "engine": tr.engine,
                "ms": tr.ms,
                "source": tr.source,
            }
        )

    def _schedule_translation(self, seg_id: int, text: str) -> asyncio.Task | None:
        if self._closed or seg_id <= self._last_submitted_id:
            return
        self._last_submitted_id = seg_id
        context = self.previous_final_japanese
        self.previous_final_japanese = text
        if len(self._translations) >= MAX_TRANSLATIONS:
            self.stats.translation_overflows += 1
            self.stats.translation_failures += 1
            self._emit({"type": "error", "scope": "translate", "id": seg_id,
                        "code": "translation_overflow", "message": "翻译队列已满"})
            return
        deadline = asyncio.get_running_loop().time() + TRANSLATION_DEADLINE
        task = asyncio.create_task(self._translate(seg_id, text, self.cfg.target_lang, context,
                                                   self.translation_epoch, deadline))
        self._translations[seg_id] = task
        task.add_done_callback(lambda _: self._translations.pop(seg_id, None))
        return task

    async def _emit_partial(self, end: int | None = None) -> None:
        end = self._total if end is None else end
        start = max(self._seg_start, int(end - MAX_WINDOW * SAMPLE_RATE))
        audio = self._slice(start, end)
        if len(audio) < SAMPLE_RATE * self.asr.min_partial_speech:
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
        # Preview text is provisional, even when it already has punctuation.
        # Only _finalize submits text to the translator.

    async def _finalize(self, audio: np.ndarray, audio_end_ratio: float, *, forced: bool = False) -> None:
        overlap_text = self._last_forced_text if self._overlap else ""
        self._last_forced_text = ""
        if len(audio) < SAMPLE_RATE * 0.3:
            return
        text = await self._decode(audio)
        if not text:
            return
        text = trim_overlap(overlap_text, text)
        if forced:
            self._last_forced_text = text
        self.stats.finals += 1
        self._emit(
            {
                "type": "final",
                "id": self._seg_id,
                "text": text,
                "t": round(audio_end_ratio, 2),
                "t_start": round(max(0, audio_end_ratio - len(audio) / SAMPLE_RATE), 2),
                "forced": forced,
                "decode_ms": round(self._last_decode_ms, 1),
            }
        )
        self._schedule_translation(self._seg_id, text)
        self._seg_id += 1

    def _reset_segment(self, end: int) -> None:
        self._seg_start = end
        self._last_hyp = ""
        self._last_text = ""
        self._last_partial_at = 0.0
        self._last_partial_total = end

    # ---------------------------------------------------------------- loop
    async def _step(self, end: int | None = None, *, preview: bool = True) -> None:
        end = self._total if end is None else end
        in_speech = self.vad.in_speech
        overlap = self._overlap if self._last_forced_text else 0
        segments = self.vad.pop_spans(since=max(0, self._finalized_until - overlap))
        for segment in segments:
            if segment.end <= self._finalized_until:
                continue
            await self._finalize(segment.samples, segment.end / SAMPLE_RATE)
            self._finalized_until = segment.end
            self._reset_segment(segment.end)

        if in_speech and not self._speech:
            self._seg_start = max(self._finalized_until, end - int(0.3 * SAMPLE_RATE))
            self._last_partial_at = time.monotonic()
            self._emit({"type": "speech_start", "id": self._seg_id})
        elif self._speech and not in_speech:
            self._last_forced_text = ""
            self._reset_segment(end)
        self._speech = in_speech

        if in_speech and end - self._seg_start >= self._max_segment:
            boundary = self._seg_start + self._max_segment
            start = max(0, self._seg_start - (self._overlap if self._last_forced_text else 0))
            await self._finalize(self._slice(start, boundary), boundary / SAMPLE_RATE, forced=True)
            self._finalized_until = boundary
            self._reset_segment(boundary)
        if preview:
            await self._maybe_preview(end)

    async def _maybe_preview(self, end: int) -> None:
        if not self._speech or end <= self._last_partial_total:
            return
        now = time.monotonic()
        if ((end - self._seg_start) / SAMPLE_RATE < self.asr.min_partial_speech
                or now - self._last_partial_at < max(self.asr.partial_interval, self._last_decode_ms / 1000 * 1.5)):
            return
        self._last_partial_at = now
        self._last_partial_total = end
        if self._queued_bytes >= PREVIEW_BACKLOG:
            self.stats.preview_backlog_skips += 1
            return
        await self._emit_partial(end)

    async def _run(self) -> None:
        while not self._closed:
            item = await self._q.get()
            self._queued_bytes -= item.nbytes
            self._append(item)
            await self._feed_vad(item)
