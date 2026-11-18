"""Conservative local verification of selected finalized ASR segments."""
from __future__ import annotations

import asyncio
import re
from collections import Counter
from dataclasses import dataclass
from enum import StrEnum

import numpy as np

from .asr import Recognition, RecognitionContext, Recognizer, SAMPLE_RATE
from .asr_domain import Correction, DomainCorrector
from .asr_router import DecodeScheduler
from .episodes import DomainSelection
from .security import RateBudget
from .text import looks_complete, normalize_ja

_REPEATED = re.compile(r"(.{2,8})\1{2,}")
_NO_LEXICON = DomainCorrector([])


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
    def __init__(self, decoder: DecodeScheduler, secondary: Recognizer | None = None, *, budget_ms: int = 450,
                 rate: RateBudget | None = None):
        self.decoder = decoder
        self.secondary = secondary
        self.budget_ms = budget_ms
        self.rate = rate or RateBudget(.2, 1)
        self.counts: Counter = Counter()

    async def optimize(self, primary, context, audio, *, forced, backlog, provisional):
        plan = assess(primary, context, audio, forced)
        decision = plan
        if plan.action == Action.NEED_RETRANSCRIPTION:
            self.counts["flagged"] += 1
            decision = await self._verify(plan, context, audio, backlog, provisional)
        self.counts[decision.action.value] += 1
        return decision

    async def _verify(self, plan, context, audio, backlog, provisional):
        if not self.secondary or backlog or len(audio) > SAMPLE_RATE * 8 or self.decoder.slot.locked():
            self.counts["skipped"] += 1
            return Decision(Action.UNCERTAIN, plan.text, "verification_unavailable", plan.signals)
        if not self.rate.consume(1):
            self.counts["skipped"] += 1
            return Decision(Action.UNCERTAIN, plan.text, "verification_rate_limit", plan.signals)

        provisional(plan.text)
        self.counts["secondary_attempts"] += 1
        try:
            async with asyncio.timeout(self.budget_ms / 1000):
                recognize = getattr(self.secondary, "recognize", None)
                if recognize:
                    # Keep the second acoustic hypothesis independent of the terminology under review.
                    result = await self.decoder.run(recognize, audio, RecognitionContext(corrector=_NO_LEXICON), optional=True)
                    alternate = result.original if result else ""
                else:
                    alternate = await self.decoder.run(self.secondary.transcribe, audio, optional=True)
            return compare(plan, alternate or "", context)
        except TimeoutError:
            self.counts["timeouts"] += 1
            return Decision(Action.UNCERTAIN, plan.text, "verification_timeout", plan.signals)
        except Exception:
            self.counts["failures"] += 1
            return Decision(Action.UNCERTAIN, plan.text, "verification_failed", plan.signals)
