"""Security regressions use real HTTP/WS handlers and a local fake API."""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import aiohttp
import numpy as np
from aiohttp import web
from aiohttp.test_utils import TestServer

from server.app import AppState, build_app
from server.security import MAX_BUFFERED_BYTES, MAX_CONNECTIONS, MAX_FRAME_BYTES, RateBudget, local_access_token
from server.streaming import StreamSession
from server.translate import DeepSeekTranslator, MockTranslator, TranslationPipeline, create_translator

TOKEN = 'local-test-access-token-0123456789abcdef'


class FakeVad:
    in_speech = False
    def __init__(self, **kwargs):
        pass

    def accept(self, audio):
        pass

    def pop_spans(self, since=0):
        return []


class SecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.vad_patch = patch('server.streaming.SileroVad', FakeVad)
        self.vad_patch.start()
        self.addCleanup(self.vad_patch.stop)
        self.state = AppState(SimpleNamespace(name="sensevoice-int8"), TranslationPipeline(MockTranslator()), access_token=TOKEN)
        self.server = TestServer(build_app(self.state))
        await self.server.start_server()
        self.client = aiohttp.ClientSession()
        self.addAsyncCleanup(self.server.close)
        self.addAsyncCleanup(self.client.close)

    async def connect(self, **kwargs):
        ws = await self.client.ws_connect(self.server.make_url('/ws'), **kwargs)
        await ws.send_json({'type': 'auth', 'token': TOKEN})
        self.assertEqual((await ws.receive_json())['type'], 'ready')
        return ws

    async def test_foreign_origin_and_rebinding_host_rejected(self):
        for headers in ({'Origin': 'https://attacker.invalid'}, {'Host': 'rebind.attacker.invalid'}, {'Origin': 'null'}):
            with self.subTest(headers=headers):
                with self.assertRaises(aiohttp.WSServerHandshakeError) as result:
                    await self.client.ws_connect(self.server.make_url('/ws'), headers=headers)
                self.assertEqual(result.exception.status, 403)
        self.assertFalse(self.state.sockets)

    async def test_same_origin_and_extension_require_valid_token(self):
        for origin in (str(self.server.make_url('/')).rstrip('/'), 'chrome-extension://' + 'a' * 32):
            async with await self.connect(origin=origin) as ws:
                await ws.send_json({'type': 'ping'})
                self.assertEqual((await ws.receive_json())['type'], 'pong')

    async def test_no_token_discovery_in_public_http(self):
        for route in ('/', '/health', '/static/app.js', '/static/caption-settings.js', '/static/interface.css'):
            async with self.client.get(self.server.make_url(route)) as response:
                self.assertEqual(response.status, 200)
                self.assertNotIn(TOKEN, await response.text())
                self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')

    async def test_health_and_ready_report_the_selected_asr(self):
        self.state.asr.name = 'whisper-base-int8'
        async with self.client.get(self.server.make_url('/health')) as response:
            self.assertEqual((await response.json())['asr'], 'whisper-base-int8')
        async with self.client.ws_connect(self.server.make_url('/ws')) as ws:
            await ws.send_json({'type': 'auth', 'token': TOKEN})
            self.assertEqual((await ws.receive_json())['asr'], 'whisper-base-int8')

    async def test_session_configuration_reports_actual_mode_and_disables_agent(self):
        self.state.agent_enabled = True
        async with await self.connect() as ws:
            await ws.send_json({"type": "config", "target": "en", "mode": "enhanced",
                                "agent": False, "context_turns": 3, "domain": "auto",
                                "page_title": "初星学園HR", "request_id": 7})
            config = await ws.receive_json()
            self.assertEqual(config["request_id"], 7)
            self.assertEqual(config["asr_mode"], "fast")
            self.assertEqual(config["requested_mode"], "enhanced")
            self.assertFalse(config["agent"]["enabled"])
            self.assertEqual(config["domain"]["episode"], "初星学園HR")
            self.assertEqual(config["context_turns"], 3)

    async def test_ready_and_configuration_distinguish_missing_secondary_and_audio_only(self):
        self.state.agent_enabled = True
        self.state.secondary_requested = "whisper"
        self.state.secondary_state = "unavailable"
        self.state.requested_asr = self.state.fallback_from = "parakeet"
        self.state.translator = TranslationPipeline(create_translator("disabled"))
        async with self.client.ws_connect(self.server.make_url('/ws')) as ws:
            await ws.send_json({"type": "auth", "token": TOKEN})
            ready = await ws.receive_json()
            self.assertTrue(ready["config_ack"])
            self.assertEqual((ready["asr_requested"], ready["asr"], ready["translator"]),
                             ("parakeet", "sensevoice-int8", "disabled"))
            self.assertEqual(ready["agent"]["secondary_state"], "unavailable")
            self.assertFalse(ready["agent"]["verification_available"])
            await ws.send_json({"type": "config", "mode": "enhanced", "agent": True, "request_id": 1})
            ack = await ws.receive_json()
            self.assertTrue(ack["agent"]["requested"])
            self.assertFalse(ack["agent"]["verification_available"])

    async def test_wrong_token_or_audio_before_auth_closes(self):
        for first in ({'type': 'auth', 'token': 'wrong'}, {'type': 'config'}, None):
            async with self.client.ws_connect(self.server.make_url('/ws')) as ws:
                if first is None:
                    await ws.send_bytes(b'\0' * 6400)
                else:
                    await ws.send_json(first)
                self.assertEqual((await ws.receive()).type, aiohttp.WSMsgType.CLOSE)
                self.assertEqual(ws.close_code, 1008)
        self.assertEqual(self.state.sessions, 0)

    async def test_auth_deadline(self):
        with patch('server.app.AUTH_TIMEOUT', .02):
            async with self.client.ws_connect(self.server.make_url('/ws')) as ws:
                self.assertEqual((await ws.receive(timeout=1)).type, aiohttp.WSMsgType.CLOSE)
                self.assertEqual(ws.close_code, 1008)

    async def test_connection_limit_includes_unauthenticated_sockets(self):
        sockets = []
        try:
            for _ in range(MAX_CONNECTIONS):
                sockets.append(await self.client.ws_connect(self.server.make_url('/ws')))
            with self.assertRaises(aiohttp.WSServerHandshakeError) as result:
                await self.client.ws_connect(self.server.make_url('/ws'))
            self.assertEqual(result.exception.status, 503)
        finally:
            await asyncio.gather(*(ws.close() for ws in sockets))

    async def test_malformed_inputs_close_only_offending_client(self):
        for payload in (b'\0', np.array([float('nan')], dtype='<f4').tobytes(), np.array([float('inf')], dtype='<f4').tobytes(), [], {'type': 'config', 'target': []}):
            async with await self.connect() as ws:
                if isinstance(payload, bytes):
                    await ws.send_bytes(payload)
                else:
                    await ws.send_json(payload)
                self.assertEqual((await ws.receive()).type, aiohttp.WSMsgType.CLOSE)
                self.assertEqual(ws.close_code, 1008)
        async with await self.connect() as ws:
            await ws.send_bytes(np.zeros(1600, dtype='<f4').tobytes())
            await ws.send_json({'type': 'config', 'target': 'en'})
            self.assertEqual((await ws.receive_json())['target'], 'en')

    async def test_oversized_frame_rejected(self):
        async with await self.connect() as ws:
            await ws.send_bytes(b'\0' * (MAX_FRAME_BYTES + 4))
            self.assertEqual((await ws.receive()).type, aiohttp.WSMsgType.CLOSE)
            self.assertEqual(ws.close_code, 1009)

    async def test_burst_audio_is_rate_limited(self):
        async with await self.connect() as ws:
            for _ in range(5):
                await ws.send_bytes(b'\0' * MAX_FRAME_BYTES)
            self.assertEqual((await ws.receive()).type, aiohttp.WSMsgType.CLOSE)
            self.assertEqual(ws.close_code, 1008)

    async def test_private_and_dev_assets_not_public(self):
        for path in ('/static/key.local.js', '/static/engine-test.html', '/ext-assets/asr-engine.js', '/asr-assets/model.onnx'):
            async with self.client.get(self.server.make_url(path)) as response:
                self.assertEqual(response.status, 404)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'static').mkdir()
            (root / 'static/key.local.js').write_text('window.SECRET="dummy";')
            with patch('server.app.WEB_DIR', root):
                dev = TestServer(build_app(AppState(SimpleNamespace(name="sensevoice-int8"), TranslationPipeline(MockTranslator())), dev_assets=True))
                await dev.start_server()
                try:
                    async with self.client.get(dev.make_url('/static/key.local.js')) as response:
                        self.assertEqual(response.status, 404)
                finally:
                    await dev.close()

    async def test_disconnect_does_not_abort_shared_translation(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def translate(request):
            calls.append(await request.json())
            entered.set()
            await release.wait()
            return web.json_response({'choices': [{'finish_reason': 'stop', 'message': {'content': '成功'}}]})
        fake_app = web.Application()
        fake_app.router.add_post('/chat/completions', translate)
        fake = TestServer(fake_app)
        await fake.start_server()
        self.addAsyncCleanup(fake.close)
        translator = DeepSeekTranslator('sk-fake', base=str(fake.make_url('/')).rstrip('/'))
        self.state.translator = TranslationPipeline(translator)
        victim = asyncio.create_task(self.state.translator.translate('正在进行的翻译', 'zh'))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            for _ in range(2):
                ws = await self.connect()
                await ws.close()
            self.assertFalse(translator._session.closed)
            release.set()
            self.assertEqual((await asyncio.wait_for(victim, 2)).text, '成功')
            self.assertEqual(len(calls), 1)
            await self.server.close()
            self.assertTrue(translator._session.closed)
        finally:
            release.set()
            if not victim.done():
                victim.cancel()
                await asyncio.gather(victim, return_exceptions=True)

    async def test_audio_buffer_has_byte_budget_and_is_released(self):
        session = StreamSession(None, self.state.translator, lambda _: None)
        for _ in range(MAX_BUFFERED_BYTES // MAX_FRAME_BYTES):
            await session.push(np.zeros(MAX_FRAME_BYTES // 4, dtype=np.float32))
        self.assertEqual(session._queued_bytes, MAX_BUFFERED_BYTES)
        with self.assertRaises(ValueError):
            await session.push(np.zeros(1, dtype=np.float32))
        await session.close()
        self.assertEqual(session._queued_bytes, 0)
        self.assertTrue(session._q.empty())

    async def test_default_service_without_key_preserves_asr_without_external_translation(self):
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": ""}):
            translator = TranslationPipeline(create_translator())
        self.assertEqual(translator.engine, "disabled")
        events = []
        session = StreamSession(None, translator, events.append)
        self.addAsyncCleanup(session.close)
        self.assertIsNone(session._schedule_translation(0, "日語"))
        self.assertEqual(events, [{"type": "translation_cancelled", "id": 0}])
        self.assertEqual(session.translation_stats()["api_requests"], 0)

    def test_default_token_file_reuses_token_and_explicit_token_bypasses_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ignored" / "token"
            token = local_access_token(None, path)
            self.assertEqual(len(token), 43)
            self.assertEqual(local_access_token(None, path), token)
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(local_access_token(TOKEN, path), TOKEN)

    def test_rate_budget_has_bounded_burst_and_refill(self):
        with patch('server.security.time.monotonic', return_value=0):
            budget = RateBudget(100, 200)
            self.assertTrue(budget.consume(200))
            self.assertFalse(budget.consume(1))
        with patch('server.security.time.monotonic', return_value=1):
            self.assertTrue(budget.consume(100))
            self.assertFalse(budget.consume(1))


if __name__ == '__main__':
    unittest.main()
