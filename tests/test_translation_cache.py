"""Session reuse, request snapshots, cancellation and usage (local HTTP only)."""
import asyncio
import json
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestServer

from server.conversation import Glossary
from server.episodes import EpisodeCatalog
from server.streaming import SessionConfig, StreamSession
from server.translate import DeepSeekTranslator, InvalidTranslation, Translation, TranslationPipeline
from server.translation_cache import LruCache


class TranslationCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.status = 200
        self.finish = 'stop'
        self.content = '完整译文'
        self.usage = {'prompt_cache_hit_tokens': 64, 'prompt_cache_miss_tokens': 32, 'completion_tokens': 6}
        self.entered = asyncio.Event()
        self.release = asyncio.Event(); self.release.set()

        async def handle(request):
            self.requests.append({'path': request.path, 'payload': await request.json()})
            self.entered.set()
            await self.release.wait()
            if self.status != 200:
                return web.Response(status=self.status, text='provider error with private content')
            return web.json_response({'choices': [{'finish_reason': self.finish, 'message': {'content': self.content}}], 'usage': self.usage})

        app = web.Application()
        app.router.add_post('/chat/completions', handle)
        app.router.add_post('/v1/chat/completions', handle)
        server = TestServer(app); await server.start_server()
        self.addAsyncCleanup(server.close)
        self.tr = DeepSeekTranslator('sk-local-fixture', base=str(server.make_url('/')).rstrip('/'))
        self.addAsyncCleanup(self.tr.close)
        self.pipe = TranslationPipeline(self.tr)
        self.addAsyncCleanup(self.pipe.close)
        self.addCleanup(self.release.set)

    async def test_fixed_prompts_and_user_envelope_match_cross_runtime_contract(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures' / 'translation_contract.json').read_text())
        for language in ('zh', 'en'):
            snapshot = self.tr.request('今の句', language, '前の句')
            payload = snapshot.payload
            self.assertEqual(snapshot.prompt_version, fixture['version'])
            self.assertEqual(payload['messages'][0], {'role': 'system', 'content': fixture['system'][language]})
            self.assertEqual(json.loads(payload['messages'][1]['content']), {'previous': '前の句', 'current': '今の句'})
            self.assertEqual(self.tr.request('別の句', language, '別の前文').payload['messages'][0], payload['messages'][0])

    async def test_same_input_reuses_but_context_language_and_configuration_do_not(self):
        await self.pipe.translate('同じ句', 'zh', '文脈A')
        self.assertEqual((await self.pipe.translate('同じ句', 'zh', '文脈A')).source, 'cache')
        await self.pipe.translate('同じ句', 'zh', '文脈B')
        await self.pipe.translate('同じ句', 'en', '文脈A')
        self.assertEqual(len(self.requests), 3)
        for field, value in [('model', 'other-model'), ('prompt_version', 'subtitle-v3'), ('temperature', .3), ('max_tokens', 513), ('base', self.tr.base + '/v1')]:
            setattr(self.tr, field, value)
            await self.pipe.translate('同じ句', 'zh', '文脈A')
            self.assertEqual(self.pipe.snapshot()['local_cache_hits'], 0)
            self.assertEqual(self.pipe.snapshot()['api_requests'], 1)
        self.assertEqual(len(self.requests), 8)
        self.assertEqual(self.requests[-1]['path'], '/v1/chat/completions')

    async def test_multiturn_context_uses_final_order_and_target_glossary(self):
        domain = EpisodeCatalog().resolve("auto", title="初星学園HR")
        cfg = SessionConfig(domain=domain, context_turns=3, glossary=Glossary.load())
        with patch("server.streaming.SileroVad"):
            session = StreamSession(None, self.pipe, lambda _: None, cfg)
        self.addAsyncCleanup(session.close)
        session.conversation.remember("古い句")
        for text in ("第一句", "藤田ことね", "第三句"):
            session.conversation.remember(text)
        snapshot = session.conversation.snapshot("そうなの？", "zh", 3, cfg.glossary, domain)
        self.release.clear()
        first = session._schedule_translation(0, "そうなの？")
        second = session._schedule_translation(1, "待って")
        await self.entered.wait()
        self.release.set()
        await asyncio.gather(first, second)
        user = [json.loads(item["payload"]["messages"][1]["content"]) for item in self.requests]
        self.assertEqual(user[0]["history"], ["第一句", "藤田ことね", "第三句"])
        self.assertEqual(user[0]["glossary"]["藤田ことね"], "藤田琴音")
        self.assertEqual(user[0]["episode"], "初星学園HR")
        self.assertEqual(user[1]["previous"], "そうなの？")
        self.assertEqual((await session.translator.translate("そうなの？", "zh", snapshot)).source, "cache")
        version_changed = replace(snapshot, glossary_version="other")
        self.assertEqual((await session.translator.translate("そうなの？", "zh", version_changed)).source, "api")
        self.assertEqual(len(self.requests), 3)
        await session.set_target("en")
        await session._schedule_translation(2, "藤田ことね")
        english = json.loads(self.requests[-1]["payload"]["messages"][1]["content"])
        self.assertEqual(english["history"], [])
        self.assertEqual(english["glossary"]["藤田ことね"], "Kotone Fujita")

    async def test_concurrent_identical_requests_use_one_api_and_one_set_of_usage(self):
        self.release.clear()
        tasks = [asyncio.create_task(self.pipe.translate('同じ句', 'zh', '同じ文脈')) for _ in range(8)]
        await self.entered.wait()
        self.release.set()
        results = await asyncio.gather(*tasks)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(sum(result.source == 'shared' for result in results), 7)
        await self.pipe.translate('同じ句', 'zh', '同じ文脈')
        stats = self.pipe.snapshot()
        self.assertEqual(stats['api_requests'], 1)
        self.assertEqual(stats['merged_requests'], 7)
        self.assertEqual(stats['local_cache_hits'], 1)
        self.assertEqual(stats['prompt_cache_hit_tokens'], 64)
        self.assertEqual(stats['prompt_cache_miss_tokens'], 32)
        self.assertEqual(stats['completion_tokens'], 6)
        self.assertEqual(stats['in_flight'], 0)

    async def test_cancelling_one_consumer_does_not_cancel_other_consumer(self):
        self.release.clear()
        first = asyncio.create_task(self.pipe.translate('句', 'zh'))
        second = asyncio.create_task(self.pipe.translate('句', 'zh'))
        await self.entered.wait()
        first.cancel(); await asyncio.gather(first, return_exceptions=True)
        self.assertFalse(second.done())
        self.release.set()
        self.assertEqual((await second).text, self.content)
        self.assertEqual(len(self.requests), 1)

    async def test_last_cancelled_consumer_removes_record_and_cannot_cache_a_late_result(self):
        entered, release, returned = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def stubborn(text, target, context):
            entered.set()
            try: await release.wait()
            except asyncio.CancelledError: await release.wait()
            returned.set()
            return Translation('late result', 'mock', 0)
        pipe = TranslationPipeline(SimpleNamespace(name='mock', translate=stubborn))
        self.addAsyncCleanup(pipe.close)
        task = asyncio.create_task(pipe.translate('PRIVATE_SENTENCE', 'zh', 'PRIVATE_CONTEXT'))
        await entered.wait(); task.cancel(); await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(pipe.snapshot()['in_flight'], 0)
        release.set(); await returned.wait(); await asyncio.sleep(0)
        self.assertEqual(pipe.snapshot()['cache_entries'], 0)
        self.assertNotIn('PRIVATE_SENTENCE', json.dumps(pipe.snapshot()))

    async def test_failures_empty_and_incomplete_responses_are_not_cached(self):
        for finish, content in [('length', '被截断'), (None, '未确认结束'), ('stop', '  '), ('stop', '“”')]:
            self.finish, self.content = finish, content
            with self.assertRaises(InvalidTranslation):
                await self.pipe.translate('失败后重试', 'zh')
            self.assertEqual(self.pipe.snapshot()['cache_entries'], 0)
            self.assertEqual(self.pipe.snapshot()['in_flight'], 0)
        self.finish, self.content = 'stop', '重试成功'
        self.assertEqual((await self.pipe.translate('失败后重试', 'zh')).text, '重试成功')
        self.assertEqual(len(self.requests), 5)
        self.assertEqual(self.pipe.snapshot()['api_requests'], 5)

    async def test_oversized_provider_body_is_rejected_without_cache_or_retry(self):
        self.content = "x" * 70_000
        with self.assertRaisesRegex(InvalidTranslation, "size limit"):
            await self.pipe.translate("日文", "zh")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.pipe.snapshot()["cache_entries"], 0)
        self.content = "译文"
        self.assertEqual((await self.pipe.translate("日文", "zh")).text, "译文")

    async def test_http_retries_are_actual_calls_and_errors_do_not_echo_provider_body(self):
        self.status = 500
        with self.assertRaisesRegex(RuntimeError, '^deepseek translation failed$'):
            await self.pipe.translate('句', 'zh')
        self.assertEqual(len(self.requests), 2)
        stats = self.pipe.snapshot()
        self.assertEqual(stats['api_requests'], 2)
        self.assertIsNone(stats['prompt_cache_hit_tokens'])
        self.assertEqual(stats['usage_unavailable_requests']['prompt_cache_hit_tokens'], 2)
        self.status = 200
        await self.pipe.translate('句', 'zh')
        self.assertEqual(len(self.requests), 3)

    async def test_missing_usage_and_explicit_zero_are_distinguished(self):
        self.usage = {'prompt_cache_hit_tokens': 0, 'completion_tokens': 0}
        await self.pipe.translate('句1', 'zh')
        stats = self.pipe.snapshot()
        self.assertEqual(stats['prompt_cache_hit_tokens'], 0)
        self.assertIsNone(stats['prompt_cache_miss_tokens'])
        self.assertEqual(stats['completion_tokens'], 0)
        self.usage = None
        await self.pipe.translate('句2', 'zh')
        stats = self.pipe.snapshot()
        self.assertIsNone(stats['prompt_cache_hit_tokens'])
        self.assertEqual(stats['usage_reported_tokens']['prompt_cache_hit_tokens'], 0)
        self.assertEqual(stats['usage_unavailable_requests']['prompt_cache_hit_tokens'], 1)

    async def test_close_and_config_change_cancel_old_generation_and_clear_reuse(self):
        self.release.clear()
        previous = asyncio.create_task(self.pipe.translate('句', 'zh', '旧文脈'))
        await self.entered.wait()
        old_stats = self.pipe.stats
        self.tr.model = 'changed-model'
        current = asyncio.create_task(self.pipe.translate('句', 'zh', '新文脈'))
        await asyncio.sleep(.02)
        self.release.set()
        with self.assertRaises(asyncio.CancelledError): await previous
        await current
        self.assertEqual(self.requests[-1]['payload']['model'], 'changed-model')
        self.assertEqual(json.loads(self.requests[-1]['payload']['messages'][1]['content'])['previous'], '新文脈')
        self.assertEqual(self.pipe.snapshot()['api_requests'], 1)
        self.assertIsNot(self.pipe.stats, old_stats)
        await self.pipe.close()
        self.assertEqual(self.pipe.snapshot()['cache_entries'], 0)
        with self.assertRaises(asyncio.CancelledError): await self.pipe.translate('句', 'zh')
        fresh = self.pipe.new_session(); self.addAsyncCleanup(fresh.close)
        await fresh.translate('句', 'zh', '新文脈')
        self.assertEqual(fresh.snapshot()['api_requests'], 1)

    async def test_lru_and_inflight_have_entry_and_byte_limits(self):
        cache = LruCache(2, max_bytes=100, max_entry_bytes=100)
        cache.put(('a',), '甲'); cache.put(('b',), '乙'); cache.get(('a',)); cache.put(('c',), '丙')
        self.assertIsNone(cache.get(('b',)))
        cache.put(('large',), '字' * 200)
        self.assertIsNone(cache.get(('large',)))
        self.assertLessEqual(cache.bytes, 100)
        self.release.clear()
        tasks = [asyncio.create_task(self.pipe.translate(str(i), 'zh')) for i in range(32)]
        await self.entered.wait()
        with self.assertRaisesRegex(RuntimeError, 'limit'): await self.pipe.translate('overflow', 'zh')
        self.release.set(); await asyncio.gather(*tasks)
        for i in range(550): await self.pipe.translate('unique-' + str(i), 'zh')
        self.assertLessEqual(self.pipe.snapshot()['cache_entries'], 500)
        self.assertLessEqual(self.pipe.snapshot()['cache_bytes'], 1024 * 1024)
        self.assertEqual(self.pipe.snapshot()['in_flight'], 0)

    async def test_stream_sessions_are_isolated_and_cache_hits_advance_context(self):
        with patch('server.streaming.SileroVad'):
            events = []
            first = StreamSession(None, self.pipe, events.append)
            second = StreamSession(None, self.pipe, lambda event: None)
        self.addAsyncCleanup(first.close); self.addAsyncCleanup(second.close)
        await first.translator.translate('句X', 'zh', '文脈')
        first.conversation.remember('文脈')
        await first._schedule_translation(0, '句X')
        self.assertEqual(first.previous_final_japanese, '句X')
        self.assertEqual(len(self.requests), 1)
        await first._schedule_translation(1, '句Y')
        self.assertEqual(json.loads(self.requests[-1]['payload']['messages'][1]['content'])['previous'], '句X')
        await second.translator.translate('句X', 'zh', '文脈')
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(len([event for event in events if event['type'] == 'translation']), 2)
        await first.set_target('en')
        self.assertEqual(first.previous_final_japanese, '')
        self.assertEqual(first.translation_stats()['cache_entries'], 0)
        self.assertEqual(second.translation_stats()['api_requests'], 1)

    async def test_identical_text_and_context_share_transport_and_deliver_each_segment(self):
        self.release.clear()
        events = []
        with patch('server.streaming.SileroVad'):
            session = StreamSession(None, self.pipe, events.append)
        self.addAsyncCleanup(session.close)
        session.conversation.remember('同じ句')
        first = session._schedule_translation(0, '同じ句')
        await self.entered.wait()
        second = session._schedule_translation(1, '同じ句')
        self.assertIsNone(session._schedule_translation(1, '同じ句'))
        await asyncio.sleep(.01)
        self.release.set()
        await asyncio.gather(first, second)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual([event['id'] for event in events if event['type'] == 'translation'], [0, 1])
        self.assertEqual(session.translation_stats()['merged_requests'], 1)

    async def test_target_change_clears_context_before_cancellation_can_yield_to_audio_worker(self):
        entered, cancelling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        requests, events = [], []

        async def translate(text, target, context):
            requests.append((text, target, context))
            if text == 'old':
                entered.set()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    cancelling.set()
                    await release.wait()
            return Translation('translated', 'mock', 0)

        with patch('server.streaming.SileroVad'):
            session = StreamSession(None, SimpleNamespace(name='mock', translate=translate), events.append)
        self.addAsyncCleanup(session.close)
        self.addCleanup(release.set)
        session.conversation.remember('old context')
        old = session._schedule_translation(0, 'old')
        await entered.wait()
        changing = asyncio.create_task(session.set_target('en'))
        await cancelling.wait()
        new = session._schedule_translation(1, 'new')
        release.set()
        await changing
        await asyncio.gather(old, new)
        self.assertEqual(requests[-1], ('new', 'en', ''))
        self.assertEqual([event['id'] for event in events if event['type'] == 'translation'], [1])
        self.assertIn({'type': 'translation_cancelled', 'id': 0}, events)
