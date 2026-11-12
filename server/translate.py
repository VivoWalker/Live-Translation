"""Translation backends.

Priority: DeepSeek chat API (OpenAI-compatible) when a key is configured.
A public Google endpoint and a mock backend exist so the pipeline can be
exercised / demoed without a key; neither is used when DeepSeek is available.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass

import aiohttp

from .text import clean_translation

DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

SYSTEM_PROMPTS = {
    "zh": (
        "你是专业的日语影视字幕翻译。把用户给出的日语台词翻译成自然、口语化的简体中文，"
        "符合字幕阅读习惯。只输出译文本身：不要解释，不要加引号，不要附日语原文，"
        "不要加“译文：”之类的前缀。人名、语气词、省略号和停顿要保留。"
    ),
    "en": (
        "You translate Japanese dialogue into natural conversational English subtitles. "
        "Output only the translation: no notes, no quotes, no Japanese source text."
    ),
}


@dataclass
class Translation:
    text: str
    engine: str
    ms: int


class LruCache:
    def __init__(self, size: int = 512):
        self.size = size
        self._d: OrderedDict[tuple, str] = OrderedDict()

    def get(self, key: tuple) -> str | None:
        if key in self._d:
            self._d.move_to_end(key)
            return self._d[key]
        return None

    def put(self, key: tuple, value: str) -> None:
        self._d[key] = value
        self._d.move_to_end(key)
        while len(self._d) > self.size:
            self._d.popitem(last=False)


class Translator:
    name = "base"

    async def translate(self, text: str, target: str = "zh", context: str = "") -> Translation:
        raise NotImplementedError

    async def close(self) -> None:
        return None


class DeepSeekTranslator(Translator):
    name = "deepseek"

    def __init__(self, api_key: str, base: str = DEEPSEEK_BASE, model: str = DEEPSEEK_MODEL):
        self.api_key = api_key
        self.base = base.rstrip("/")
        self.model = model
        self._session: aiohttp.ClientSession | None = None
        self._sem = asyncio.Semaphore(2)

    async def _sess(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=12, connect=4),
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
        return self._session

    async def translate(self, text: str, target: str = "zh", context: str = "") -> Translation:
        t0 = time.perf_counter()
        system = SYSTEM_PROMPTS.get(target, SYSTEM_PROMPTS["zh"])
        if context:
            # Context lives in the system message: putting it in the user message
            # makes the model merge both sentences into one translation.
            system += (
                f"\n上一句字幕是「{context}」，只用来理解指代和语气；"
                "不要翻译或复述它，译文里只出现本句的内容。"
            )
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
            "temperature": 0.2,
            "max_tokens": 512,
            "stream": False,
        }
        err: Exception | None = None
        for attempt in range(2):
            try:
                async with self._sem:
                    sess = await self._sess()
                    async with sess.post(f"{self.base}/chat/completions", json=payload) as r:
                        body = await r.text()
                        if r.status != 200:
                            raise RuntimeError(f"deepseek http {r.status}: {body[:200]}")
                        data = json.loads(body)
                out = data["choices"][0]["message"]["content"]
                return Translation(clean_translation(out), self.name, int((time.perf_counter() - t0) * 1000))
            except Exception as e:  # noqa: BLE001 - retry once, then surface
                err = e
                await asyncio.sleep(0.3 * (attempt + 1))
        raise RuntimeError(f"deepseek translation failed: {err}")

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


class GooglePublicTranslator(Translator):
    """Public translate endpoint, no key. Only a fallback for local trials.

    aiohttp's request gets rate-limited (429) by this endpoint while a plain
    urllib request with a browser UA goes through, so the call runs in a thread.
    """

    name = "google-public"

    def __init__(self) -> None:
        self._ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        )

    def _fetch(self, params: dict) -> str:
        url = "https://translate.googleapis.com/translate_a/single?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": self._ua})
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.read().decode("utf-8", "replace")

    async def translate(self, text: str, target: str = "zh", context: str = "") -> Translation:
        t0 = time.perf_counter()
        params = {
            "client": "gtx",
            "sl": "ja",
            "tl": "zh-CN" if target == "zh" else target,
            "dt": "t",
            "q": text,
        }
        try:
            body = await asyncio.to_thread(self._fetch, params)
            data = json.loads(body)
        except Exception as e:  # noqa: BLE001 - surface a readable fallback error
            raise RuntimeError(f"public translator unavailable: {e}") from e
        out = "".join(seg[0] for seg in data[0] if seg and seg[0])
        return Translation(clean_translation(out), self.name, int((time.perf_counter() - t0) * 1000))

    async def close(self) -> None:
        return None


class MockTranslator(Translator):
    """Offline stand-in: proves the timing/plumbing without any network call."""

    name = "mock"

    async def translate(self, text: str, target: str = "zh", context: str = "") -> Translation:
        return Translation(f"[{target}] {text}", self.name, 0)


def create_translator(mode: str = "auto", api_key: str | None = None) -> Translator:
    key = api_key or os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if mode == "auto":
        mode = "deepseek" if key else "google-public"
    if mode == "deepseek":
        if not key:
            raise RuntimeError(
                "未配置 DeepSeek API Key：设置环境变量 DEEPSEEK_API_KEY，"
                "或在 config.local.json 里写 deepseek_api_key（见 config.example.json）"
            )
        return DeepSeekTranslator(key)
    if mode == "google-public":
        return GooglePublicTranslator()
    if mode == "mock":
        return MockTranslator()
    raise ValueError(f"unknown translator mode: {mode}")


class TranslationPipeline:
    """Cache + context + engine, with the per-target-language niceties."""

    def __init__(self, translator: Translator, cache_size: int = 512):
        self.tr = translator
        self.cache = LruCache(cache_size)

    @property
    def engine(self) -> str:
        return self.tr.name

    async def translate(self, text: str, target: str, context: str = "") -> Translation:
        text = text.strip()
        if not text:
            return Translation("", self.tr.name, 0)
        key = (text, target)
        hit = self.cache.get(key)
        if hit is not None:
            return Translation(hit, self.tr.name + ":cache", 0)
        tr = await self.tr.translate(text, target, context)
        if tr.text:
            self.cache.put(key, tr.text)
        return tr
