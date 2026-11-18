"""Bounded WebSocket output. Preserve FIFO order for reliable events."""
from __future__ import annotations

import asyncio
import time
from collections import deque

CRITICAL_LIMIT = 64
FAILURE_DRAIN_SECONDS = 2
REPLACEABLE = {"partial", "stats"}


class ClientEvents:
    def __init__(self, capacity: int = CRITICAL_LIMIT):
        self.capacity = capacity
        self.critical: deque[dict] = deque()
        self.latest: dict[str, dict] = {}
        self.available = asyncio.Event()
        self.failure: tuple[int, bytes] | None = None
        self.drain_deadline: float | None = None
        self.preview_floor = 0
        self.peak = self.dropped_partial = self.overflows = 0

    def fail(self, code: int, reason: bytes) -> None:
        if self.failure is None:
            self.failure = (code, reason)
            self.drain_deadline = time.monotonic() + FAILURE_DRAIN_SECONDS
            self.dropped_partial += int("partial" in self.latest)
            self.latest.clear()
            self.available.set()

    def put(self, event: dict) -> None:
        if self.failure:
            return
        kind = event["type"]
        partial = self.latest.get("partial")
        if kind in REPLACEABLE:
            if kind == "partial" and (event["id"] < self.preview_floor
                                      or (partial is not None and event["id"] < partial["id"])):
                self.dropped_partial += 1
                return
            self.dropped_partial += int(kind == "partial" and partial is not None)
            self.latest[kind] = event
        elif len(self.critical) >= self.capacity:
            self.overflows += 1
            self.fail(1013, b"Subtitle output queue exceeded")
            return
        else:
            if kind in ("final", "speech_start"):
                self.preview_floor = max(self.preview_floor, event["id"] + int(kind == "final"))
                if partial and partial["id"] < self.preview_floor:
                    self.dropped_partial += 1
                    del self.latest["partial"]
            self.critical.append(event)
        self.peak = max(self.peak, len(self.critical) + len(self.latest))
        self.available.set()

    def send_budget(self, limit: float) -> float:
        if self.drain_deadline is None:
            return limit
        return max(0, min(limit, self.drain_deadline - time.monotonic()))

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
