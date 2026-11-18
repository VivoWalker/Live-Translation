"""Shared admission state for a secondary model. Session metrics live in the agent."""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass

from .asr_router import DecodeScheduler
from .security import RateBudget

_LIVE_BUDGETS = {"sensevoice": 450, "whisper-base": 550, "parakeet": 650,
                 "whisper-large": 750, "qwen3": 900}
_OFFLINE_ONLY_CPU = ("whisper-large", "whisper-turbo", "qwen3")


def percentile(samples, fraction):
    ordered = sorted(samples)
    return ordered[math.ceil(len(ordered) * fraction) - 1] if ordered else None


@dataclass(frozen=True)
class VerificationPolicy:
    budget_ms: int
    mode: str = "live"
    max_audio_s: float = 8
    cold_start_allowed: bool = True

    def __post_init__(self):
        if self.mode not in ("live", "offline"):
            raise ValueError("Invalid Agent verification mode")
        maximum = 1500 if self.mode == "live" else 120_000
        if type(self.budget_ms) is not int or not 1 <= self.budget_ms <= maximum:
            raise ValueError(f"Agent {self.mode} budget must be at most {maximum} ms and positive")

    @classmethod
    def for_model(cls, secondary, *, budget_ms=None, mode="live"):
        name = getattr(secondary, "name", "")
        device = getattr(getattr(secondary, "capabilities", None), "device", "cpu")
        if mode == "offline":
            default = 60_000 if name.startswith("qwen3") else 30_000
            return cls(default if budget_ms is None else budget_ms, mode, 60)
        default = next((budget for prefix, budget in _LIVE_BUDGETS.items() if name.startswith(prefix)), 450)
        allowed = cls.live_eligible(name, device, budget_ms)
        return cls(default if budget_ms is None else budget_ms, mode, cold_start_allowed=allowed)

    @staticmethod
    def live_eligible(name, device, budget_ms):
        return budget_ms is not None or device != "cpu" or not name.startswith(_OFFLINE_ONLY_CPU)


class VerificationController:
    def __init__(self, decoder: DecodeScheduler, policy: VerificationPolicy, *, primary=None, rate=None,
                 clock=time.monotonic):
        self.decoder, self.policy, self.primary = decoder, policy, primary
        self.rate = rate if rate is not None else RateBudget(.2, 1)
        self.clock = clock
        self.samples: deque[tuple[float, float]] = deque(maxlen=16)
        self.last_start = float("-inf")
        self.cooldown_until = 0.0
        self.consecutive_timeouts = 0

    def admit(self, duration: float, *, backlog: bool) -> str | None:
        if duration <= 0 or duration > self.policy.max_audio_s:
            return "audio_length"
        if self.policy.mode == "live":
            if not self.policy.cold_start_allowed:
                return "model_offline_preferred"
            if backlog or (self.primary is not None and not self.primary.idle):
                return "primary_backlog"
        if not self.decoder.idle:
            return "secondary_busy"
        now = self.clock()
        if self.policy.mode == "live":
            if now < self.cooldown_until:
                return "timeout_cooldown"
            # Only project from comparable clip lengths. One periodic trial can adapt to faster inference.
            projected = percentile((elapsed * duration / length for length, elapsed in self.samples
                                    if .5 * duration <= length <= 2 * duration), .75)
            if projected is not None and projected >= self.policy.budget_ms * .9 and now - self.last_start < 60:
                return "predicted_over_budget"
            if not self.rate.consume(1):
                return "rate_limit"
        self.last_start = now
        return None

    def timeout(self):
        self.consecutive_timeouts += 1
        if self.policy.mode == "live" and self.consecutive_timeouts >= 2:
            delay = 15 * 2 ** min(3, self.consecutive_timeouts - 2)
            self.cooldown_until = self.clock() + delay

    def completed_in_budget(self):
        self.consecutive_timeouts = 0
        self.cooldown_until = 0.0

    def observe(self, duration, inference_ms):
        self.samples.append((duration, inference_ms))
