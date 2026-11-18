import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from server.asr import Recognition
from server.asr_agent import Action, OptimizationAgent
from server.asr_domain import EpisodeTerm
from server.asr_review import ReviewStore, candidates, validate_candidates
from server.asr_router import DecodeScheduler
from server.episodes import DomainSelection
from server.streaming import SessionConfig, StreamSession
from server.translate import MockTranslator, TranslationPipeline


SOURCE = "https://example.test/cast"
DOMAIN = DomainSelection("auto", episode="例の番組", terms=(
    EpisodeTerm("夏空太郎", "なつぞらたろう", "character", "high", True, SOURCE),
))
BASELINE = "なつぞらたろうさんです。"
VERIFIED = "夏空太郎さんです。"
AUDIO = np.full(8000, .1, dtype=np.float32)


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_known_reading_requires_independent_secondary_agreement(self):
        asr = SimpleNamespace(recognize=MagicMock(return_value=Recognition(VERIFIED, VERIFIED)))
        agent = OptimizationAgent(DecodeScheduler(), asr)
        trial = []
        result = await agent.optimize(Recognition(BASELINE, BASELINE), DOMAIN, AUDIO, forced=False,
                                      backlog=False, provisional=trial.append)
        self.assertEqual((result.action, result.text, trial), (Action.ACCEPT_CORRECTION, VERIFIED, [BASELINE]))
        self.assertEqual(result.changes[0].source, SOURCE)
        self.assertEqual(asr.recognize.call_args.args[1].prompt, "")

    async def test_uncertain_disagreement_and_ordinary_audio(self):
        asr = SimpleNamespace(transcribe=MagicMock(return_value="別の名前を言いました。"))
        agent = OptimizationAgent(DecodeScheduler(), asr)
        regular = await agent.optimize(Recognition("こんにちは。", "こんにちは。"), DOMAIN, AUDIO, forced=False,
                                       backlog=False, provisional=lambda _: None)
        self.assertEqual(regular.action, Action.ACCEPT_ORIGINAL)
        asr.transcribe.assert_not_called()
        conflict = await agent.optimize(Recognition(BASELINE, BASELINE), DOMAIN, AUDIO, forced=False,
                                        backlog=False, provisional=lambda _: None)
        self.assertEqual((conflict.action, conflict.text), (Action.UNCERTAIN, BASELINE))

    async def test_timeout_keeps_original_final_and_translates_once(self):
        release = threading.Event()
        self.addCleanup(release.set)
        def slow(_):
            release.wait(timeout=2)
            return VERIFIED
        verifier = DecodeScheduler()
        agent = OptimizationAgent(verifier, SimpleNamespace(transcribe=slow), budget_ms=20)
        asr = SimpleNamespace(transcribe=lambda _: BASELINE)
        events = []
        with patch("server.streaming.SileroVad"):
            session = StreamSession(asr, TranslationPipeline(MockTranslator()), events.append,
                                    SessionConfig(domain=DOMAIN), agent=agent)
        self.addAsyncCleanup(session.close)
        await session._finalize(AUDIO, .5)
        await session._translations[0]
        release.set()
        self.assertEqual([(event["type"], event["id"]) for event in events],
                         [("partial", 0), ("final", 0), ("translation", 0)])
        self.assertEqual(events[1]["text"], BASELINE)
        self.assertEqual(agent.counts["timeouts"], 1)
        await asyncio.sleep(0)

    async def test_review_and_holdout_gate_require_positive_evidence_with_no_regression(self):
        agent = OptimizationAgent(DecodeScheduler(), SimpleNamespace(transcribe=lambda _: VERIFIED))
        primary = Recognition(BASELINE, BASELINE)
        decision = await agent.optimize(primary, DOMAIN, AUDIO, forced=False, backlog=False, provisional=lambda _: None)
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewStore(Path(directory) / "audit.sqlite", limit=2)
            for n in range(3):
                store.record(str(n), 0, primary, decision, DOMAIN.episode)
            self.assertEqual(len(store.list()), 2)
            self.assertEqual(validate_candidates(candidates(store.list()), []), [])
            for row in store.list():
                store.review(row["id"], "accepted", VERIFIED)
            proposals = candidates(store.list())
            holdout = [{"episode": DOMAIN.episode, "baseline": BASELINE, "reference": VERIFIED}]
            self.assertTrue(validate_candidates(proposals, holdout)[0]["promotable"])
            holdout.append({"episode": DOMAIN.episode, "baseline": BASELINE, "reference": BASELINE})
            self.assertFalse(validate_candidates(proposals, holdout)[0]["promotable"])
