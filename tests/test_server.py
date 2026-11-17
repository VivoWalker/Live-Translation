"""Unit tests: text normalization, DeepSeek request/response contract, cache.

Run:  .venv\\Scripts\\python -m unittest discover -s tests -v
"""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server.text import clean_translation, normalize_ja, stable_prefix
from server.translate import DeepSeekTranslator, TranslationPipeline


class TextTests(unittest.TestCase):
    def test_normalize_ja_removes_subword_spaces(self):
        self.assertEqual(
            normalize_ja("すみ ません、この 電車 は 新宿 駅 に 停まり ま すか"),
            "すみません、この電車は新宿駅に停まりま すか".replace("ま すか", "ますか"),
        )

    def test_normalize_ja_keeps_latin_words(self):
        self.assertEqual(normalize_ja("これは iPhone の 話 です"), "これはiPhoneの話です")

    def test_stable_prefix_keeps_agreed_head(self):
        prev = "今日は東京へ"
        cur = "今日は東京へ行きます"
        self.assertEqual(stable_prefix(prev, cur), "今日は東京へ")

    def test_stable_prefix_handles_revision(self):
        self.assertEqual(stable_prefix("今日は東京へ行きます", "今日は大阪へ行きます"), "今日は")

    def test_clean_translation_strips_prefix(self):
        self.assertEqual(clean_translation('译文：“今天天气不错。”'), "今天天气不错。")


class FakeDeepSeek:
    """Minimal OpenAI-compatible endpoint that records what the client sends."""

    def __init__(self, status: int = 200, content: str = "今天来讲讲东京的天气。"):
        self.status = status
        self.content = content
        self.requests: list[dict] = []

    async def handle(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.requests.append({"headers": dict(request.headers), "body": body})
        if self.status != 200:
            return web.Response(status=self.status, text='{"error":"boom"}')
        return web.json_response(
            {
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": self.content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42},
            }
        )


class DeepSeekClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake = FakeDeepSeek()
        app = web.Application()
        app.router.add_post("/chat/completions", self.fake.handle)
        self.server = TestServer(app)
        await self.server.start_server()
        port = self.server.port
        self.base = f"http://127.0.0.1:{port}"

    async def asyncTearDown(self):
        await self.server.close()

    async def test_request_shape_and_parse(self):
        tr = DeepSeekTranslator("sk-test-123", base=self.base)
        out = await tr.translate("今日は東京の天気についてお話しします。", target="zh", context="こんにちは。")
        await tr.close()

        self.assertEqual(out.text, "今天来讲讲东京的天气。")
        self.assertEqual(out.engine, "deepseek")
        req = self.fake.requests[0]
        self.assertEqual(req["headers"]["Authorization"], "Bearer sk-test-123")
        self.assertEqual(req["body"]["model"], "deepseek-chat")
        self.assertEqual(req["body"]["stream"], False)
        self.assertEqual(req["body"]["messages"][0]["role"], "system")
        self.assertIn("字幕", req["body"]["messages"][0]["content"])
        # Dynamic dialogue is an explicitly labelled user JSON, outside the fixed prefix.
        self.assertNotIn("こんにちは。", req["body"]["messages"][0]["content"])
        self.assertEqual(json.loads(req["body"]["messages"][1]["content"]), {"previous": "こんにちは。", "current": "今日は東京の天気についてお話しします。"})

    async def test_error_is_retried_then_raised(self):
        self.fake.status = 500
        tr = DeepSeekTranslator("sk-test-123", base=self.base)
        with self.assertRaises(RuntimeError):
            await tr.translate("テスト", target="zh")
        await tr.close()
        self.assertEqual(len(self.fake.requests), 2)

    async def test_cache_avoids_second_call(self):
        tr = DeepSeekTranslator("sk-test-123", base=self.base)
        pipe = TranslationPipeline(tr)
        a = await pipe.translate("おはようございます", "zh")
        b = await pipe.translate("おはようございます", "zh")
        await tr.close()
        self.assertEqual(a.text, b.text)
        self.assertIn("cache", b.engine)
        self.assertEqual(len(self.fake.requests), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
