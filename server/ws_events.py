"""Bounded WebSocket output. Preserve FIFO order for reliable events."""
from __future__ import annotations

import asyncio
from collections import deque

CRITICAL_LIMIT = 64
REPLACEABLE = {"partial", "stats"}


class ClientEvents:
    def __init__(self, capacity: int = CRITICAL_LIMIT):
        self.capacity = capacity
        self.critical: deque[dict] = deque()
        self.latest: dict[str, dict] = {}
        self.available = asyncio.Event()
        self.failure: tuple[int, bytes] | None = None
        self.peak = self.dropped_partial = self.overflows = 0

    def fail(self, code: int, reason: bytes) -> None:
        if self.failure is None:
            self.failure = (code, reason)
            self.dropped_partial += int("partial" in self.latest)
            self.latest.clear()
            self.available.set()

    def put(self, event: dict) -> None:
        if self.failure:
            return
        kind = event["type"]
        partial = self.latest.get("partial")
        if kind in REPLACEABLE:
            self.dropped_partial += int(kind == "partial" and partial is not None)
            self.latest[kind] = event
        elif len(self.critical) >= self.capacity:
            self.overflows += 1
            self.fail(1013, b"Subtitle output queue exceeded")
            return
        else:
            if partial and kind in ("final", "speech_start") and partial["id"] <= event["id"]:
                self.dropped_partial += 1
                del self.latest["partial"]
            self.critical.append(event)
        self.peak = max(self.peak, len(self.critical) + len(self.latest))
        self.available.set()

    async def get(self) -> dict | None:
        while True:
            if self.critical:
                return self.critical.popleft()
            if self.failure:
                return None
            if self.latest:
                return self.latest.pop(next(iter(self.latest)))
            self.available.clear()
            await self.available.wait()

    def stats(self) -> dict:
        return {"depth": len(self.critical) + len(self.latest), "critical_depth": len(self.critical),
                "peak_depth": self.peak, "dropped_partial_count": self.dropped_partial,
                "overflows": self.overflows}
