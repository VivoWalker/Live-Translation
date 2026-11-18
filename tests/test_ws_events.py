import unittest
from types import SimpleNamespace
from unittest.mock import patch

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

from server.app import AppState, build_app
from server.streaming import AudioBacklogError, Stats
from server.translate import MockTranslator, TranslationPipeline
from server.ws_events import ClientEvents


class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_priority_coalesces_previews_and_keeps_critical_order(self):
        out = ClientEvents(capacity=4)
        for text in ("一", "二"):
            out.put({"type": "partial", "id": 1, "text": text})
        out.put({"type": "stats", "count": 0})
        out.put({"type": "final", "id": 1})
        out.put({"type": "stats", "count": 1})
        out.put({"type": "translation", "id": 1})
        out.put({"type": "partial", "id": 2})
        self.assertEqual(out.stats()["dropped_partial_count"], 2)
        self.assertEqual([await out.get() for _ in range(4)], [
            {"type": "final", "id": 1}, {"type": "translation", "id": 1},
            {"type": "stats", "count": 1}, {"type": "partial", "id": 2},
        ])

    async def test_real_socket_signals_overflow_and_a_new_session_recovers(self):
        class BurstSession:
            def __init__(self, asr, translator, on_event, config):
                self.emit = on_event
                self.stats = Stats()

            async def start(self):
                pass

            async def close(self):
                pass

            async def push(self, pcm):
                if pcm[0] == 1:
                    self.stats.audio_overflows += 1
                    raise AudioBacklogError()
                for i in range(3):
                    self.emit({"type": "final", "id": i})

        token = "queue-test-token-" + "x" * 30
        state = AppState(SimpleNamespace(name="fake"), TranslationPipeline(MockTranslator()), access_token=token)
        async with TestClient(TestServer(build_app(state))) as client:
            with patch("server.app.StreamSession", BurstSession), patch("server.app.ClientEvents", lambda: ClientEvents(2)):
                async with client.ws_connect("/ws") as ws:
                    await ws.send_json({"type": "auth", "token": token})
                    self.assertEqual((await ws.receive_json())["type"], "ready")
                    await ws.send_bytes(b"\0" * 4)
                    self.assertEqual([(await ws.receive_json())["id"] for _ in range(2)], [0, 1])
                    closed = await ws.receive(timeout=5)
                    self.assertEqual((closed.type, closed.data), (aiohttp.WSMsgType.CLOSE, 1013))
                    self.assertIn("output queue", closed.extra)
                async with client.ws_connect("/ws") as ws:
                    await ws.send_json({"type": "auth", "token": token})
                    self.assertEqual((await ws.receive_json())["type"], "ready")
                    await ws.send_bytes(b"\x00\x00\x80\x3f")
                    closed = await ws.receive(timeout=5)
                    self.assertEqual((closed.type, closed.data), (aiohttp.WSMsgType.CLOSE, 1013))
                    self.assertIn("audio backlog", closed.extra)
