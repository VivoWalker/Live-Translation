"""Preview ASR must not send incomplete sentences to the translation API."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
from aiohttp import web
from aiohttp.test_utils import TestServer

from server.asr import SAMPLE_RATE, SileroVad
from server.streaming import StreamSession
from server.translate import DeepSeekTranslator, Translation, TranslationPipeline


class TranslationTimingTests(unittest.IsolatedAsyncioTestCase):
    async def test_previews_never_call_api_and_final_sends_complete_text_once(self):
        requests = []

        async def chat(request):
            requests.append(await request.json())
            return web.json_response({"choices": [{"finish_reason": "stop", "message": {"content": "今天介绍东京的天气，下午可能下雨。"}}]})

        app = web.Application()
        app.router.add_post('/chat/completions', chat)
        upstream = TestServer(app)
        await upstream.start_server()
        self.addAsyncCleanup(upstream.close)

        for engine, minimum in (("sensevoice-int8", 0.9), ("whisper-base-int8", 2.0)):
            with self.subTest(engine=engine):
                requests.clear()
                events = []
                translator = DeepSeekTranslator('sk-test', base=str(upstream.make_url('/')).rstrip('/'))
                self.addAsyncCleanup(translator.close)
                asr = SimpleNamespace(name=engine, min_partial_speech=minimum, transcribe=MagicMock())
                with patch('server.streaming.SileroVad'):
                    session = StreamSession(asr, TranslationPipeline(translator), events.append)
                self.addAsyncCleanup(session.close)
                audio = np.zeros(48000, dtype=np.float32)
                session._append(audio)
                for preview in (
                    'こんにちは、今日は東京の天気について',
                    'こんにちは、今日は東京の天気についてお話しします。',
                    'こんにちは、今日は東京の天気についてお話しします。午後から',
                ):
                    asr.transcribe.return_value = preview
                    await session._emit_partial()
                    if session._translate_task:
                        await asyncio.wait_for(session._translate_task, timeout=2)
                    self.assertEqual(requests, [], 'Preview text must stay local')
                self.assertEqual(len([e for e in events if e['type'] == 'partial']), 3)
                final_text = 'こんにちは、今日は東京の天気についてお話しします。午後から雨が降るそうです。'
                asr.transcribe.return_value = final_text
                await session._finalize(audio, 3.0)
                await asyncio.wait_for(session._translate_task, timeout=2)
                self.assertEqual(len(requests), 1)
                user_text = [json.loads(m['content'])['current'] for m in requests[0]['messages'] if m['role'] == 'user']
                self.assertEqual(user_text, [final_text])
                translations = [e for e in events if e['type'] == 'translation']
                self.assertEqual(len(translations), 1)
                self.assertTrue(translations[0]['final'])
                self.assertEqual(translations[0]['id'], [e['id'] for e in events if e['type'] == 'final'][0])
                await session.close()

    async def test_long_utterance_excludes_audio_already_submitted_at_forced_boundary(self):
        first = np.ones(12 * SAMPLE_RATE, dtype=np.float32)
        tail = np.full(SAMPLE_RATE, 2, dtype=np.float32)
        detector = MagicMock()
        detector.is_speech_detected.return_value = True
        detector.front = SimpleNamespace(start=0, samples=np.concatenate([first, tail]))
        detector.empty.side_effect = [False, True]
        vad = SileroVad.__new__(SileroVad)
        vad._vad = detector
        asr = SimpleNamespace(transcribe=MagicMock(return_value='本段字幕'))
        translator = MagicMock()
        translator.translate = AsyncMock(return_value=Translation(text='译文', engine='test', ms=0))
        with patch('server.streaming.SileroVad', return_value=vad):
            session = StreamSession(asr, translator, lambda _: None)
        self.addAsyncCleanup(session.close)
        session._speech = True
        session._append(first)
        await session._step()
        await session._translate_task
        self.assertEqual(len(asr.transcribe.call_args.args[0]), 12 * SAMPLE_RATE)
        session._append(tail)
        detector.is_speech_detected.return_value = False
        await session._step()
        await session._translate_task
        self.assertEqual(asr.transcribe.call_count, 2)
        np.testing.assert_array_equal(asr.transcribe.call_args.args[0], tail)
        self.assertEqual(translator.translate.await_count, 2)

    def test_vad_discards_a_segment_that_was_already_completely_finalized(self):
        detector = MagicMock()
        detector.front = SimpleNamespace(start=16000, samples=np.ones(16000, dtype=np.float32))
        detector.empty.side_effect = [False, True]
        vad = SileroVad.__new__(SileroVad)
        vad._vad = detector
        self.assertEqual(vad.pop_segments(since=32000), [])
        detector.pop.assert_called_once()

    async def test_replaced_translation_notifies_the_waiting_caption(self):
        entered = asyncio.Event()
        async def translate(text, target, context):
            if text == '前の句':
                entered.set()
                await asyncio.Event().wait()
            return Translation(text='新句译文', engine='test', ms=0)
        translator = SimpleNamespace(translate=translate)
        events = []
        with patch('server.streaming.SileroVad'):
            session = StreamSession(None, translator, events.append)
        self.addAsyncCleanup(session.close)
        session._schedule_translation(0, '前の句', final=True)
        await asyncio.wait_for(entered.wait(), 2)
        previous = session._translate_task
        session._schedule_translation(1, '新しい句', final=True)
        await asyncio.wait_for(session._translate_task, 2)
        await asyncio.gather(previous, return_exceptions=True)
        self.assertTrue(previous.cancelled())
        self.assertIn({'type': 'translation_cancelled', 'id': 0}, events)
        self.assertEqual([event['id'] for event in events if event['type'] == 'translation'], [1])
