"""One native decode at a time, with finals ahead of optional work."""
from __future__ import annotations

import asyncio

from .asr import BackendUnavailable, create_recognizer
from .security import MAX_CONNECTIONS


def select_recognizer(engine, *, fallback_dir=None, allow_fallback=True, **options):
    try:
        return create_recognizer(engine, **options), None
    except (OSError, BackendUnavailable) as error:
        if engine == "sensevoice" or not allow_fallback:
            raise
        fallback = {**options, "model_dir": fallback_dir, "device": "cpu", "precision": "int8"}
        try:
            return create_recognizer("sensevoice", **fallback), engine
        except (OSError, BackendUnavailable):
            raise BackendUnavailable(f"{engine} failed to load and the local SenseVoice fallback is unavailable") from error


class DecodeScheduler:
    def __init__(self):
        self.slot = asyncio.Semaphore(1)
        self.waiting = 0

    @property
    def idle(self):
        return not self.slot.locked() and self.waiting == 0

    async def run(self, decode, *args, optional=False):
        if optional and not self.idle:
            return None
        if self.waiting >= MAX_CONNECTIONS:
            raise RuntimeError("ASR inference backlog exceeded")
        self.waiting += 1
        try:
            await self.slot.acquire()
        finally:
            self.waiting -= 1
        task = asyncio.create_task(asyncio.to_thread(decode, *args))
        task.add_done_callback(self._complete)
        return await asyncio.shield(task)

    def _complete(self, task):
        self.slot.release()
        if not task.cancelled():
            task.exception()  # Observe failures even after a consumer disconnects.
