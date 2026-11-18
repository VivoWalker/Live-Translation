"""Local-service boundaries shared by HTTP, WebSocket, and audio sessions."""
from __future__ import annotations

import re
import os
import secrets
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

MAX_FRAME_BYTES = 64 * 1024
MAX_BUFFERED_BYTES = 256 * 1024
MAX_CONNECTIONS = 8
AUTH_TIMEOUT = 5
LOCAL_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1'})


def validate_access_token(token: str) -> str:
    if not isinstance(token, str) or re.fullmatch(r"[!-~]{32,128}", token) is None:
        raise ValueError("Access token must contain 32–128 printable ASCII characters")
    return token


def local_access_token(explicit: str | None, path: Path) -> str:
    """Create a private, reusable local token without putting it in logs."""
    if explicit:
        return validate_access_token(explicit)
    if not path.exists():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".access-token-", dir=path.parent)
        temp = Path(name)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as file:
                file.write(secrets.token_urlsafe(32) + "\n")
            try:
                os.link(temp, path)
            except FileExistsError:
                pass
        finally:
            temp.unlink(missing_ok=True)
    with path.open(encoding="ascii") as file:
        return validate_access_token(file.read(130).rstrip("\r\n"))


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
