"""Local-service boundaries shared by HTTP, WebSocket, and audio sessions."""
from __future__ import annotations

import re
import time
from urllib.parse import urlsplit

from aiohttp import web

MAX_FRAME_BYTES = 64 * 1024
MAX_BUFFERED_BYTES = 256 * 1024
MAX_CONNECTIONS = 8
AUTH_TIMEOUT = 5
LOCAL_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1'})


def valid_origin(origin: str | None, request: web.Request) -> bool:
    if origin is None:  # Native clients still need the access token.
        return True
    if re.fullmatch(r'chrome-extension://[a-p]{32}', origin):
        return True
    try:
        supplied = urlsplit(origin)
        expected = urlsplit(f'{request.scheme}://{request.host}')
        return (
            supplied.scheme in {'http', 'https'}
            and not supplied.username and not supplied.password
            and not supplied.path and not supplied.query and not supplied.fragment
            and (supplied.scheme, supplied.hostname, supplied.port or (443 if supplied.scheme == 'https' else 80))
            == (expected.scheme, expected.hostname, expected.port or (443 if expected.scheme == 'https' else 80))
        )
    except ValueError:
        return False


def valid_host(host: str, allowed: set[str] | frozenset[str]) -> bool:
    try:
        parsed = urlsplit('http://' + host)
        _ = parsed.port  # Reject malformed ports.
        return (
            parsed.hostname in allowed and not parsed.username and not parsed.password
            and not parsed.path and not parsed.query and not parsed.fragment
        )
    except ValueError:
        return False


class RateBudget:
    def __init__(self, rate: float, burst: float):
        self.rate, self.burst = rate, burst
        self.remaining = burst
        self.updated = time.monotonic()

    def consume(self, amount: int) -> bool:
        now = time.monotonic()
        self.remaining = min(self.burst, self.remaining + (now - self.updated) * self.rate)
        self.updated = now
        if amount > self.remaining:
            return False
        self.remaining -= amount
        return True
