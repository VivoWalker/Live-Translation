import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import aiohttp
import numpy as np
from aiohttp.test_utils import TestClient, TestServer

from server.app import AppState, build_app
from server.asr import Capabilities
from server.streaming import AudioBacklogError, Stats
from server.translate import MockTranslator, TranslationPipeline
from server.ws_events import ClientEvents
from tools.benchmark_mock import FixtureVad


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

    async def test_late_preview_cannot_replace_a_final_or_newer_preview(self):
        out = ClientEvents()
        out.put({"type": "final", "id": 2})
        self.assertEqual(await out.get(), {"type": "final", "id": 2})
        out.put({"type": "partial", "id": 2})
        out.put({"type": "partial", "id": 4})
        out.put({"type": "partial", "id": 3})
        self.assertEqual(await out.get(), {"type": "partial", "id": 4})
        self.assertEqual(out.stats()["dropped_partial_count"], 2)
        self.assertEqual(out.stats()["depth"], 0)

    async def test_failure_has_one_drain_deadline_for_all_events(self):
        with patch("server.ws_events.time.monotonic", return_value=10):
            out = ClientEvents(capacity=1)
            out.put({"type": "final", "id": 0})
            out.put({"type": "final", "id": 1})
            self.assertEqual(out.send_budget(2), 2)
        with patch("server.ws_events.time.monotonic", return_value=11.5):
            out.fail(1011, b"other failure")
            self.assertEqual(out.send_budget(2), .5)
            self.assertEqual(out.failure[0], 1013)
        with patch("server.ws_events.time.monotonic", return_value=12):
            self.assertEqual(out.send_budget(2), 0)

    async def test_real_socket_signals_overflow_and_a_new_session_recovers(self):
        class BurstSession:
            def __init__(self, asr, translator, on_event, config, **kwargs):
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

    async def test_stalled_writer_closes_and_releases_the_session(self):
        token = "queue-test-token-" + "x" * 30
        state = AppState(SimpleNamespace(name="fake"), TranslationPipeline(MockTranslator()), access_token=token)
        original = aiohttp.web.WebSocketResponse.send_json
        entered = asyncio.Event()
        cancelled = asyncio.Event()

        async def stall_pong(ws, data):
            if data["type"] != "pong":
                return await original(ws, data)
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        with patch("server.streaming.SileroVad"), patch("server.app.SUBTITLE_SEND_TIMEOUT", .04):
            async with TestClient(TestServer(build_app(state))) as client:
                with patch.object(aiohttp.web.WebSocketResponse, "send_json", stall_pong):
                    async with client.ws_connect("/ws") as ws:
                        await ws.send_json({"type": "auth", "token": token})
                        self.assertEqual((await ws.receive_json())["type"], "ready")
                        await ws.send_json({"type": "ping"})
                        await asyncio.wait_for(entered.wait(), 1)
                        closed = await ws.receive(timeout=2)
                        self.assertEqual((closed.type, closed.data), (aiohttp.WSMsgType.CLOSE, 1013))
                        self.assertTrue(cancelled.is_set())
                async with client.ws_connect("/ws") as ws:
                    await ws.send_json({"type": "auth", "token": token})
                    self.assertEqual((await ws.receive_json())["type"], "ready")
                    await ws.send_json({"type": "ping"})
                    self.assertEqual((await ws.receive_json())["type"], "pong")
        self.assertEqual((state.sessions, len(state.sockets)), (0, 0))

    async def test_slow_primary_audio_overflow_closes_then_another_session_recovers(self):
        entered, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()
        self.addCleanup(release.set)

        def transcribe(_):
            loop.call_soon_threadsafe(entered.set)
            release.wait(3)
            return "日語字幕。"

        asr = SimpleNamespace(name="slow", transcribe=transcribe, capabilities=Capabilities(partial_transcription=False))
        token = "queue-test-token-" + "x" * 30
        # A bounded test buffer makes the failure deterministic without hitting the audio rate limit.
        state = AppState(asr, TranslationPipeline(MockTranslator()), access_token=token)
        speech = np.full(1600, .1, dtype="<f4").tobytes()
        silence = bytes(len(speech))

        async def start(client):
            ws = await client.ws_connect("/ws")
            await ws.send_json({"type": "auth", "token": token})
            self.assertEqual((await ws.receive_json())["type"], "ready")
            return ws

        async def utter(ws):
            for frame in (speech,) * 5 + (silence,) * 3:
                await ws.send_bytes(frame)
                await asyncio.sleep(.01)

        with patch("server.streaming.SileroVad", FixtureVad), patch("server.streaming.MAX_BUFFERED_BYTES", 3 * len(speech)):
            async with TestClient(TestServer(build_app(state))) as client:
                async with await start(client) as ws:
                    await utter(ws)
                    await asyncio.wait_for(entered.wait(), 1)
                    for _ in range(4):
                        await ws.send_bytes(silence)
                    while (event := await ws.receive(timeout=2)).type == aiohttp.WSMsgType.TEXT:
                        self.assertNotEqual(event.json()["type"], "final")
                    self.assertEqual((event.type, event.data), (aiohttp.WSMsgType.CLOSE, 1013))
                    self.assertIn("audio backlog", event.extra)
                    self.assertFalse(state.decoder.idle)
                release.set()
                async with await start(client) as ws:
                    await utter(ws)
                    events = []
                    while not any(event["type"] == "translation" for event in events):
                        events.append(await ws.receive_json(timeout=2))
                    self.assertEqual([(event["type"], event["id"]) for event in events],
                                     [("speech_start", 0), ("final", 0), ("translation", 0)])
