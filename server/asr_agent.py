"""Conservative local verification of selected finalized ASR segments."""
from __future__ import annotations

import asyncio
import re
import time
from collections import Counter, deque
from dataclasses import dataclass, replace
from enum import StrEnum

import numpy as np

from .asr import Recognition, RecognitionContext, Recognizer, SAMPLE_RATE
from .asr_domain import Correction, DomainCorrector
from .asr_router import DecodeScheduler
from .asr_verification import VerificationController, VerificationPolicy, percentile
from .episodes import DomainSelection
from .security import RateBudget
from .text import looks_complete, normalize_ja

_REPEATED = re.compile(r"(.{2,8})\1{2,}")
_NO_LEXICON = DomainCorrector([])
_COUNTERS = ("segments_total", "segments_flagged", "secondary_attempts", "secondary_skipped",
             "secondary_timeouts", "secondary_failures", "secondary_cancelled", "secondary_completions",
             "corrections_accepted", "secondary_corrections_accepted", "uncertain_decisions", "fallback_count",
             "decisions_total")


class Action(StrEnum):
    ACCEPT_ORIGINAL = "ACCEPT_ORIGINAL"
    ACCEPT_CORRECTION = "ACCEPT_CORRECTION"
    NEED_RETRANSCRIPTION = "NEED_RETRANSCRIPTION"
    UNCERTAIN = "UNCERTAIN"


@dataclass(frozen=True)
class Decision:
    action: Action
    text: str
    reason: str
    signals: tuple[str, ...] = ()
    alternative: str = ""
    changes: tuple[Correction, ...] = ()
    verification_wait_ms: float = 0


def assess(primary: Recognition, context: DomainSelection | None, audio: np.ndarray, forced: bool) -> Decision:
    text = primary.text
    signals = []
    if forced and not looks_complete(text):
        signals.append("forced_boundary")
    if _REPEATED.search(text[:512]):
        signals.append("repetition")
    if audio.size and (np.sqrt(np.mean(np.square(audio))) < .008 or np.mean(np.abs(audio) >= .99) > .03):
        signals.append("low_signal_or_clipping")
    for term in context.terms if context else ():
        spellings = (term.reading, *term.aliases) if term.verified else (term.canonical, term.reading, *term.aliases)
        if any(len(spelling) >= 4 and spelling in text for spelling in spellings):
            signals.append("verified_reading" if term.verified else "unverified_term")
    if signals:
        return Decision(Action.NEED_RETRANSCRIPTION, text, "risk_signals", tuple(dict.fromkeys(signals)))
    if primary.changes:
        return Decision(Action.ACCEPT_CORRECTION, text, "curated_lexicon", changes=primary.changes)
    return Decision(Action.ACCEPT_ORIGINAL, text, "no_risk_signal")


def compare(plan: Decision, alternate: str, context: DomainSelection | None) -> Decision:
    text = plan.text
    alternate = normalize_ja(alternate)
    if not alternate:
        return Decision(Action.UNCERTAIN, text, "empty_secondary", plan.signals)
    suffix = "。！？!?"
    if text.rstrip(suffix) == alternate.rstrip(suffix):
        return Decision(Action.ACCEPT_ORIGINAL, text, "agreement", plan.signals, alternate)
    for term in context.terms if context else ():
        if not term.verified:
            continue
        for alias in (term.reading, *term.aliases):
            if len(alias) < 4 or alias == term.canonical or text.count(alias) != 1:
                continue
            start = text.index(alias)
            proposed = text[:start] + term.canonical + text[start + len(alias):]
            if alternate.rstrip(suffix) == proposed.rstrip(suffix):
                change = Correction(alias, term.canonical, start, start + len(alias), term.source)
                return Decision(Action.ACCEPT_CORRECTION, proposed, "independent_asr_and_verified_term",
                                plan.signals, alternate, (change,))
    return Decision(Action.UNCERTAIN, text, "hypothesis_conflict", plan.signals, alternate)


class OptimizationAgent:
    def __init__(self, decoder: DecodeScheduler, secondary: Recognizer | None = None, *, budget_ms: int | None = None,
                 rate: RateBudget | None = None, controller: VerificationController | None = None):
        self.secondary = secondary
        self.controller = controller or VerificationController(
            decoder, VerificationPolicy.for_model(secondary, budget_ms=budget_ms), rate=rate)
        self.counts: Counter = Counter(dict.fromkeys(_COUNTERS, 0))
        self.skip_reasons: Counter = Counter()
        self.inference_times: deque[float] = deque(maxlen=256)
        self.wait_times: deque[float] = deque(maxlen=256)
        self.inference_ms = self.wait_ms = 0.0

    def snapshot(self):
        counts = dict(self.counts)
        attempts, total = counts["secondary_attempts"], counts["segments_total"]

        def ratio(value, count):
            return round(value / count, 4) if count else None

        return {**counts, "secondary_skip_reasons": dict(self.skip_reasons),
                "secondary_trigger_rate": ratio(attempts, total),
                "secondary_timeout_rate": ratio(counts["secondary_timeouts"], attempts),
                "secondary_correction_acceptance_rate": ratio(counts["secondary_corrections_accepted"], attempts),
                "secondary_inference_ms": round(self.inference_ms, 3),
                "secondary_inference_mean_ms": ratio(self.inference_ms, counts["secondary_completions"]),
                "secondary_inference_p95_ms": percentile(self.inference_times, .95),
                "verification_wait_mean_ms": ratio(self.wait_ms, counts["decisions_total"]),
                "verification_wait_p95_ms": percentile(self.wait_times, .95),
                "timing_window": 256}

    async def optimize(self, primary, context, audio, *, forced, backlog, provisional):
        self.counts["segments_total"] += 1
        plan = assess(primary, context, audio, forced)
        decision = plan
        if plan.action == Action.NEED_RETRANSCRIPTION:
            self.counts["segments_flagged"] += 1
            decision = await self._verify(plan, context, audio, backlog, provisional)
        self.counts["corrections_accepted"] += int(decision.action == Action.ACCEPT_CORRECTION or bool(primary.changes))
        self.counts["secondary_corrections_accepted"] += int(
            decision.reason == "independent_asr_and_verified_term")
        self.counts["uncertain_decisions"] += int(decision.action == Action.UNCERTAIN)
        self.counts["fallback_count"] += int(decision.action == Action.UNCERTAIN)
        self.counts["decisions_total"] += 1
        self.wait_ms += decision.verification_wait_ms
        self.wait_times.append(decision.verification_wait_ms)
        return decision

    async def _verify(self, plan, context, audio, backlog, provisional):
        controller = self.controller
        duration = len(audio) / SAMPLE_RATE
        high_value = ("verified_reading" in plan.signals or "repetition" in plan.signals
                      or {"forced_boundary", "low_signal_or_clipping"}.issubset(plan.signals))
        reason = "model_unavailable" if self.secondary is None else (
            "low_priority" if controller.policy.mode == "live" and not high_value
            else controller.admit(duration, backlog=backlog))
        if reason:
            return self._skip(plan, reason)
        started = time.perf_counter()
        provisional(plan.text)
        self.counts["secondary_attempts"] += 1
        loop = asyncio.get_running_loop()

        def decode():
            start = time.perf_counter()
            failed = True
            try:
                recognize = getattr(self.secondary, "recognize", None)
                if recognize:
                    # Exclude lexicon replacements and prompts from the independent hypothesis.
                    result = recognize(audio, RecognitionContext(corrector=_NO_LEXICON))
                    alternate = result.original if result else ""
                else:
                    alternate = self.secondary.transcribe(audio) or ""
                failed = False
                return alternate
            finally:
                loop.call_soon_threadsafe(self._observe, duration, (time.perf_counter() - start) * 1000, failed)

        timeout = asyncio.timeout(controller.policy.budget_ms / 1000)
        try:
            async with timeout:
                alternate = await controller.decoder.run(decode, optional=True)
        except TimeoutError:
            if timeout.expired():
                controller.timeout()
                self.counts["secondary_timeouts"] += 1
                decision = Decision(Action.UNCERTAIN, plan.text, "verification_timeout", plan.signals)
            else:
                decision = Decision(Action.UNCERTAIN, plan.text, "verification_failed", plan.signals)
        except asyncio.CancelledError:
            self.counts["secondary_cancelled"] += 1
            raise
        except Exception:
            decision = Decision(Action.UNCERTAIN, plan.text, "verification_failed", plan.signals)
        else:
            if alternate is None:
                self.counts["secondary_attempts"] -= 1
                return self._skip(plan, "secondary_busy")
            controller.completed_in_budget()
            decision = compare(plan, alternate, context)
        return replace(decision, verification_wait_ms=round((time.perf_counter() - started) * 1000, 3))

    def _skip(self, plan, reason):
        self.counts["secondary_skipped"] += 1
        self.skip_reasons[reason] += 1
        return Decision(Action.UNCERTAIN, plan.text, f"verification_{reason}", plan.signals)

    def _observe(self, duration, inference_ms, failed):
        self.inference_ms += inference_ms
        self.inference_times.append(inference_ms)
        self.counts["secondary_completions"] += 1
        self.counts["secondary_failures"] += int(failed)
        if not failed:
            self.controller.observe(duration, inference_ms)


async def refine_offline(primary, context, audio, verifiers):
    """Use the live evidence rules with an offline budget and optional consensus."""
    proposals = [await verifier.optimize(primary, context, audio, forced=False, backlog=False,
                                         provisional=lambda _: None) for verifier in verifiers]
    first = proposals[0]
    if all((item.text, item.action) == (first.text, first.action) for item in proposals):
        return replace(first, verification_wait_ms=sum(item.verification_wait_ms for item in proposals))
    alternative = next((item.alternative for item in proposals if item.alternative), "")
    return Decision(Action.UNCERTAIN, primary.text, "offline_model_disagreement", first.signals,
                    alternative, verification_wait_ms=sum(item.verification_wait_ms for item in proposals))
