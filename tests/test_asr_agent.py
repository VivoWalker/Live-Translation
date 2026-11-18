import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from server.asr import Recognition
from server.asr_agent import Action, OptimizationAgent, refine_offline
from server.asr_domain import DomainCorrector, EpisodeTerm
from server.asr_review import ReviewStore, candidates, validate_candidates
from server.asr_router import DecodeScheduler
from server.asr_verification import VerificationController, VerificationPolicy
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
PRIMARY = Recognition(BASELINE, BASELINE)


async def optimize(agent, *, backlog=False):
    return await agent.optimize(PRIMARY, DOMAIN, AUDIO, forced=False, backlog=backlog, provisional=lambda _: None)


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_known_reading_requires_independent_secondary_agreement(self):
        asr = SimpleNamespace(recognize=MagicMock(return_value=Recognition(VERIFIED, VERIFIED)))
        agent = OptimizationAgent(DecodeScheduler(), asr)
        trial = []
        result = await agent.optimize(Recognition(BASELINE, BASELINE), DOMAIN, AUDIO, forced=False,
                                      backlog=False, provisional=trial.append)
        self.assertEqual((result.action, result.text, trial), (Action.ACCEPT_CORRECTION, VERIFIED, [BASELINE]))
        self.assertEqual(result.changes[0].source, SOURCE)
        self.assertEqual((result.changes[0].level, result.changes[0].verified, result.changes[0].independent_asr), (3, True, True))
        self.assertEqual(asr.recognize.call_args.args[1].prompt, "")

    async def test_verified_reading_cannot_bypass_conflicts_or_promote_unverified_terms(self):
        context = DomainSelection("auto", episode=DOMAIN.episode, terms=(
            DOMAIN.terms[0], EpisodeTerm("夏空多朗", "なつぞらたろう", "character", "normal", True, SOURCE)))
        asr = SimpleNamespace(transcribe=MagicMock(return_value=VERIFIED))
        agent = OptimizationAgent(DecodeScheduler(), asr)
        result = await agent.optimize(PRIMARY, context, AUDIO, forced=False, backlog=False, provisional=lambda _: None)
        self.assertEqual((result.text, result.reason), (BASELINE, "verification_low_priority"))
        self.assertTrue(all(item.rule == "conflicting_alias" for item in result.candidates))
        asr.transcribe.assert_not_called()
        unverified = DomainSelection("auto", terms=(
            EpisodeTerm("夏空太郎", "なつぞらたろう", "character", "normal", False, SOURCE),))
        result = await agent.optimize(PRIMARY, unverified, AUDIO, forced=False, backlog=False, provisional=lambda _: None)
        self.assertEqual(result.text, BASELINE)
        self.assertFalse(result.candidates[0].verified)
        asr.transcribe.assert_not_called()

    async def test_verification_compares_raw_hypotheses_and_preserves_nonoverlapping_safe_edits(self):
        raw = "日高真白となつぞらたろうです。"
        corrector = DomainCorrector(["mashiro"], episode_terms=DOMAIN.terms)
        text, changes, suggestions = corrector.inspect(raw)
        primary = Recognition(text, raw, changes=changes, candidates=suggestions)
        secondary = SimpleNamespace(transcribe=lambda _: "日高真白と夏空太郎です。")
        agent = OptimizationAgent(DecodeScheduler(), secondary)
        result = await agent.optimize(primary, None, AUDIO, forced=False, backlog=False, provisional=lambda _: None)
        self.assertEqual(result.text, "陽高真白と夏空太郎です。")

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
        self.assertEqual(agent.counts["secondary_timeouts"], 1)
        await asyncio.sleep(0)

    async def test_mock_inference_100_and_450_ms_completes_within_policy(self):
        for latency in (.1, .45):
            with self.subTest(latency=latency):
                def transcribe(_):
                    time.sleep(latency)
                    return VERIFIED
                agent = OptimizationAgent(DecodeScheduler(), SimpleNamespace(transcribe=transcribe), budget_ms=1100)
                self.assertEqual((await optimize(agent)).text, VERIFIED)
                stats = agent.snapshot()
                self.assertEqual((stats["secondary_attempts"], stats["secondary_completions"]), (1, 1))
                self.assertEqual(stats["secondary_correction_acceptance_rate"], 1)
                self.assertGreaterEqual(stats["secondary_inference_p95_ms"], latency * 1000)

    async def test_slow_2_and_20_second_models_cannot_queue_or_delay_other_primary_decode(self):
        for latency in (2, 20):
            with self.subTest(latency=latency):
                primary, verifier = DecodeScheduler(), DecodeScheduler()
                policy = VerificationController(verifier, VerificationPolicy(80), primary=primary)
                entered, release, completed = asyncio.Event(), threading.Event(), asyncio.Event()
                loop = asyncio.get_running_loop()

                def transcribe(_):
                    loop.call_soon_threadsafe(entered.set)
                    release.wait(latency)
                    loop.call_soon_threadsafe(completed.set)
                    return VERIFIED

                model = SimpleNamespace(transcribe=transcribe)
                owner = OptimizationAgent(verifier, model, controller=policy)
                peer = OptimizationAgent(verifier, model, controller=policy)
                task = asyncio.create_task(optimize(owner))
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    outcomes = await asyncio.gather(*(optimize(peer) for _ in range(12)))
                    self.assertEqual({decision.reason for decision in outcomes}, {"verification_secondary_busy"})
                    self.assertEqual((peer.counts["secondary_attempts"], verifier.waiting), (0, 0))
                    self.assertEqual(await primary.run(lambda: "latest primary"), "latest primary")
                    self.assertEqual((await task).reason, "verification_timeout")
                    self.assertFalse(verifier.idle)
                    self.assertEqual(owner.snapshot()["secondary_timeout_rate"], 1)
                finally:
                    release.set()
                    await asyncio.wait_for(completed.wait(), 1)
                await asyncio.wait_for(verifier.run(lambda: None), 1)
                self.assertTrue(verifier.idle)
                self.assertEqual(owner.counts["secondary_completions"], 1)

    async def test_backend_timeout_error_is_inference_failure(self):
        secondary = SimpleNamespace(transcribe=MagicMock(side_effect=TimeoutError("backend")))
        agent = OptimizationAgent(DecodeScheduler(), secondary)
        self.assertEqual((await optimize(agent)).reason, "verification_failed")
        self.assertEqual((agent.counts["secondary_failures"], agent.counts["secondary_timeouts"]), (1, 0))

    async def test_policy_uses_model_defaults_recent_inference_and_primary_priority(self):
        qwen = SimpleNamespace(name="qwen3-asr-1.7b")
        live, offline = VerificationPolicy.for_model(qwen), VerificationPolicy.for_model(qwen, mode="offline")
        now = [100]
        budget = SimpleNamespace(consume=lambda _: True)
        decoder = DecodeScheduler()
        controller = VerificationController(decoder, live)
        self.assertEqual(controller.admit(.5, backlog=False), "model_offline_preferred")
        self.assertEqual(offline.budget_ms, 60_000)
        live = VerificationPolicy.for_model(qwen, budget_ms=500)
        controller = VerificationController(decoder, live, rate=budget, clock=lambda: now[0])
        self.assertEqual(controller.admit(.5, backlog=True), "primary_backlog")
        self.assertIsNone(controller.admit(.5, backlog=False))
        controller.observe(.5, 800)
        controller.timeout()
        self.assertEqual(controller.admit(.5, backlog=False), "predicted_over_budget")
        now[0] += 61
        self.assertIsNone(controller.admit(.5, backlog=False))
        controller.timeout()
        self.assertEqual(controller.admit(.5, backlog=False), "timeout_cooldown")
        now[0] += 61
        self.assertIsNone(controller.admit(.5, backlog=False))
        controller.completed_in_budget()
        self.assertEqual(controller.consecutive_timeouts, 0)

    async def test_stopping_during_verification_cannot_publish_into_new_session(self):
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        self.addCleanup(release.set)

        def slow(_):
            loop.call_soon_threadsafe(entered.set)
            release.wait(2)
            return VERIFIED

        verifier = DecodeScheduler()
        controller = VerificationController(verifier, VerificationPolicy(1000))
        asr, secondary = SimpleNamespace(transcribe=lambda _: BASELINE), SimpleNamespace(transcribe=slow)
        old_events, new_events = [], []
        with patch("server.streaming.SileroVad"):
            old = StreamSession(asr, TranslationPipeline(MockTranslator()), old_events.append,
                                SessionConfig(domain=DOMAIN), agent=OptimizationAgent(verifier, secondary, controller=controller))
            new = StreamSession(asr, TranslationPipeline(MockTranslator()), new_events.append,
                                SessionConfig(domain=DOMAIN), agent=OptimizationAgent(verifier, secondary, controller=controller))
        self.addAsyncCleanup(old.close)
        self.addAsyncCleanup(new.close)
        late = asyncio.create_task(old._finalize(AUDIO, .5))
        await asyncio.wait_for(entered.wait(), 1)
        await old.close()
        await late
        await new._finalize(AUDIO, .5)
        await new._translations[0]
        release.set()
        await verifier.run(lambda: None)
        self.assertEqual([event["type"] for event in old_events], ["partial"])
        self.assertEqual([(event["type"], event["id"]) for event in new_events], [("final", 0), ("translation", 0)])
        self.assertEqual(new_events[0]["text"], BASELINE)

    async def test_offline_consensus_falls_back_on_disagreement(self):
        decoder = DecodeScheduler()

        def agent(text):
            controller = VerificationController(decoder, VerificationPolicy(1000, "offline"))
            return OptimizationAgent(decoder, SimpleNamespace(transcribe=lambda _: text), controller=controller)

        result = await refine_offline(PRIMARY, DOMAIN, AUDIO, [agent(VERIFIED), agent(BASELINE)])
        self.assertEqual((result.text, result.reason), (BASELINE, "offline_model_disagreement"))
        result = await refine_offline(PRIMARY, DOMAIN, AUDIO, [agent(VERIFIED), agent(VERIFIED)])
        self.assertEqual((result.text, result.action), (VERIFIED, Action.ACCEPT_CORRECTION))

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
