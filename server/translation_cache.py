"""Bounded, in-memory translation reuse and non-sensitive usage counters."""
from __future__ import annotations

import json
from collections import OrderedDict

USAGE_FIELDS = ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "completion_tokens")
MAX_COUNTER = 2**53 - 1


def usage_values(value) -> dict[str, int | None]:
    value = value if isinstance(value, dict) else {}
    return {field: n if type(n := value.get(field)) is int and 0 <= n <= MAX_COUNTER else None
            for field in USAGE_FIELDS}


class LruCache:
    def __init__(self, size: int = 500, max_bytes: int = 1024 * 1024, max_entry_bytes: int = 32768):
        self.size = max(0, min(size, 500))
        self.max_bytes = max(0, max_bytes)
        self.max_entry_bytes = max(0, min(max_entry_bytes, max_bytes))
        self.bytes = 0
        self._d: OrderedDict[tuple, tuple[str, int]] = OrderedDict()

    def get(self, key: tuple) -> str | None:
        if key not in self._d:
            return None
        self._d.move_to_end(key)
        return self._d[key][0]

    def put(self, key: tuple, text: str) -> None:
        cost = len(json.dumps(key, ensure_ascii=False, separators=(",", ":")).encode()) + len(text.encode())
        if not text or not self.size or cost > self.max_entry_bytes:
            return
        if key in self._d:
            self.bytes -= self._d.pop(key)[1]
        self._d[key] = (text, cost)
        self.bytes += cost
        while len(self._d) > self.size or self.bytes > self.max_bytes:
            self.bytes -= self._d.popitem(last=False)[1][1]

    def clear(self) -> None:
        self._d.clear()
        self.bytes = 0

    def __len__(self) -> int:
        return len(self._d)


class TranslationStats:
    def __init__(self):
        self.api_requests = self.completed = self.cache_hits = self.merged = 0
        self.request_ms = 0.0
        self.tokens = dict.fromkeys(USAGE_FIELDS, 0)
        self.reported = dict.fromkeys(USAGE_FIELDS, 0)
        self.missing = dict.fromkeys(USAGE_FIELDS, 0)

    def increment(self, name: str) -> None:
        setattr(self, name, min(MAX_COUNTER, getattr(self, name) + 1))

    def finish(self, ms: float, usage=None) -> None:
        self.increment("completed")
        self.request_ms = min(MAX_COUNTER, self.request_ms + max(0, ms))
        for field, value in usage_values(usage).items():
            if value is None:
                self.missing[field] = min(MAX_COUNTER, self.missing[field] + 1)
            else:
                self.reported[field] = min(MAX_COUNTER, self.reported[field] + 1)
                self.tokens[field] = min(MAX_COUNTER, self.tokens[field] + value)

    def snapshot(self) -> dict:
        known = {field: self.tokens[field] if self.reported[field] else None for field in USAGE_FIELDS}
        return {
            "api_requests": self.api_requests, "api_requests_completed": self.completed,
            "local_cache_hits": self.cache_hits, "merged_requests": self.merged,
            "request_ms": round(self.request_ms, 1),
            "avg_request_ms": round(self.request_ms / self.completed, 1) if self.completed else None,
            **{field: known[field] if not self.missing[field] else None for field in USAGE_FIELDS},
            "usage_reported_tokens": known,
            "usage_unavailable_requests": dict(self.missing),
            "usage_pending_requests": max(0, self.api_requests - self.completed),
        }
