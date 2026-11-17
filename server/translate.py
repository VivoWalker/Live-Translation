"""Translation backends.

Priority: DeepSeek chat API (OpenAI-compatible) when a key is configured.
A public Google endpoint and a mock backend exist so the pipeline can be
exercised / demoed without a key; neither is used when DeepSeek is available.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time
import urllib.parse
from dataclasses import dataclass, field, replace

import aiohttp

from .text import clean_translation
from .translation_cache import LruCache, TranslationStats, usage_values

DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

PROMPT_VERSION = "subtitle-v2"
SYSTEM_PROMPTS = {
    "zh": (
        "你是专业的日语影视字幕翻译。把用户消息 JSON 中 current 字段的日语台词翻译成自然、口语化的简体中文，符合字幕阅读习惯。"
        "previous 字段只用于理解指代和语气，不要翻译、复述或合并上一句；只翻译 current。"
        "只输出译文本身：不要解释，不要加引号，不要附日语原文，不要加“译文：”之类的前缀。"
        "人名、语气词、省略号和停顿要保留。"
    ),
    "en": (
        "You translate Japanese dialogue in the current field of the user JSON into natural conversational English subtitles. "
        "Use the previous field only to understand references and tone. Do not translate, repeat or merge the previous sentence; translate current only. "
        "Output only the translation: no notes, no quotes, no Japanese source text. Preserve names, tone, ellipses and pauses."
    ),
}


@dataclass
class Translation:
    text: str
    engine: str
    ms: int
    usage: dict | None = None
    source: str = "api"


@dataclass(frozen=True)
class DeepSeekRequest:
    endpoint: str
    model: str
    prompt_version: str
    target: str
    context: str
    text: str
    system: str
    temperature: float
    max_tokens: int
    api_key: str = field(repr=False)

    @property
    def payload(self) -> dict:
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self.system},
                {"role": "user", "content": json.dumps({"previous": self.context, "current": self.text}, ensure_ascii=False, separators=(",", ":"))},
            ],
            "temperature": self.temperature, "max_tokens": self.max_tokens, "stream": False,
        }

    @property
    def key(self) -> tuple:
        return (self.endpoint, self.prompt_version, self.target,
                json.dumps(self.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


class InvalidTranslation(RuntimeError):
    pass


class Translator:
    name = "base"

    async def translate(self, text: str, target: str = "zh", context: str = "") -> Translation:
        raise NotImplementedError

    async def close(self) -> None:
        return None


class DeepSeekTranslator(Translator):
    name = "deepseek"

    def __init__(self, api_key: str, base: str = DEEPSEEK_BASE, model: str = DEEPSEEK_MODEL,
                 *, prompt_version: str = PROMPT_VERSION, temperature: float = 0.2, max_tokens: int = 512):
        self.api_key = api_key
        self.base = base.rstrip("/")
        self.model = model
        self.prompt_version = prompt_version
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._session: aiohttp.ClientSession | None = None
        self._sem = asyncio.Semaphore(2)

    def configuration(self) -> tuple:
        return (self.base, self.model, self.prompt_version, self.temperature, self.max_tokens, self.api_key)

    def request(self, text: str, target: str, context: str) -> DeepSeekRequest:
        if not all(isinstance(value, str) for value in (self.base, self.model, self.prompt_version, self.api_key, target, context, text)):
            raise ValueError("Invalid translation configuration")
        if type(self.temperature) not in (int, float) or not math.isfinite(self.temperature) or type(self.max_tokens) is not int or self.max_tokens < 1:
            raise ValueError("Invalid translation parameters")
        return DeepSeekRequest(self.base.rstrip("/") + "/chat/completions", self.model, self.prompt_version,
                               target, context, text, SYSTEM_PROMPTS.get(target, SYSTEM_PROMPTS["zh"]),
                               self.temperature, self.max_tokens, self.api_key)

    async def _sess(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12, connect=4))
        return self._session

    async def translate(self, text: str, target: str = "zh", context: str = "") -> Translation:
        # This lower-level method deliberately bypasses local reuse (e.g. API probes).
        return await self.send(self.request(text, target, context), TranslationStats())

    async def send(self, request: DeepSeekRequest, stats: TranslationStats) -> Translation:
        t0 = time.perf_counter()
        for attempt in range(2):
            try:
                async with self._sem:
                    sess = await self._sess()
                    stats.increment("api_requests")
                    started = time.perf_counter()
                    usage = None
                    try:
                        async with sess.post(request.endpoint, json=request.payload,
                                             headers={"Authorization": f"Bearer {request.api_key}"}) as response:
                            if response.status != 200:
                                raise RuntimeError(f"deepseek http {response.status}")
                            data = await response.json()
                            usage = data.get("usage") if isinstance(data, dict) else None
                            choices = data.get("choices") if isinstance(data, dict) else None
                            choice = choices[0] if isinstance(choices, list) and choices else None
                            content = choice.get("message", {}).get("content") if isinstance(choice, dict) and isinstance(choice.get("message"), dict) else None
                            if not isinstance(content, str) or not content.strip() or choice.get("finish_reason") != "stop":
                                raise InvalidTranslation("deepseek returned an empty or incomplete translation")
                            out = clean_translation(content)
                            if not out:
                                raise InvalidTranslation("deepseek returned an empty translation")
                            return Translation(out, self.name, int((time.perf_counter() - t0) * 1000), usage_values(usage))
                    finally:
                        stats.finish((time.perf_counter() - started) * 1000, usage)
            except InvalidTranslation:
                raise
            except Exception:  # Retry transport/server errors once; never echo bodies or dialogue.
                if attempt == 1:
                    raise RuntimeError("deepseek translation failed") from None
                await asyncio.sleep(0.3)
        raise RuntimeError("deepseek translation failed")

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
    """One session's bounded result cache, shared requests and usage counters.

    The transport may be shared by sessions. Cache, tasks and metrics never are.
    """
    def __init__(self, translator: Translator, cache_size: int = 500, *, max_bytes: int = 1024 * 1024,
                 max_entry_bytes: int = 32768, max_inflight: int = 32):
        self.tr = translator
        self.cache = LruCache(cache_size, max_bytes, max_entry_bytes)
        self.stats = TranslationStats()
        self.max_inflight = max(1, min(max_inflight, 32))
        self._inflight: dict[tuple, dict] = {}
        self._tasks: set[asyncio.Task] = set()
        self._epoch = 0
        self._closed = False
        self._configuration = self._config()

    def _config(self) -> tuple:
        return self.tr.configuration() if isinstance(self.tr, DeepSeekTranslator) else (type(self.tr), self.tr.name)

    def new_session(self) -> TranslationPipeline:
        return TranslationPipeline(self.tr, self.cache.size, max_bytes=self.cache.max_bytes,
                                   max_entry_bytes=self.cache.max_entry_bytes, max_inflight=self.max_inflight)

    @property
    def engine(self) -> str:
        return self.tr.name

    def reset(self) -> None:
        self._epoch += 1
        for task in self._tasks:
            task.cancel()
        self._inflight.clear()
        self.cache.clear()
        self.stats = TranslationStats()
        self._configuration = self._config()

    async def close(self) -> None:
        self._closed = True
        self.reset()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def snapshot(self) -> dict:
        return {**self.stats.snapshot(), "cache_entries": len(self.cache), "cache_bytes": self.cache.bytes,
                "in_flight": len(self._inflight)}

    def _done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled():
            task.exception()  # Consume failures when all consumers were cancelled.

    async def _run(self, key: tuple, request: DeepSeekRequest | None, text: str, target: str,
                   context: str, epoch: int, stats: TranslationStats) -> Translation:
        try:
            result = await self.tr.send(request, stats) if request else await self.tr.translate(text, target, context)
            if self._closed or epoch != self._epoch or asyncio.current_task().cancelling():
                raise asyncio.CancelledError
            if not result.text.strip():
                raise InvalidTranslation("empty translation")
            self.cache.put(key, result.text)
            return result
        finally:
            current = self._inflight.get(key)
            if current and current["task"] is asyncio.current_task():
                self._inflight.pop(key, None)

    async def translate(self, text: str, target: str, context: str = "") -> Translation:
        if self._closed:
            raise asyncio.CancelledError
        if self._config() != self._configuration:
            self.reset()
        text = text.strip()
        if not text:
            return Translation("", self.tr.name, 0)
        request = self.tr.request(text, target, context) if isinstance(self.tr, DeepSeekTranslator) else None
        key = request.key if request else (self.tr.name, target, context, text)
        if len(json.dumps(key, ensure_ascii=False).encode()) > 65536:
            raise ValueError("Translation input too large")
        hit = self.cache.get(key)
        if hit is not None:
            self.stats.increment("cache_hits")
            return Translation(hit, self.tr.name + ":cache", 0, source="cache")
        epoch = self._epoch
        current = self._inflight.get(key)
        merged = current is not None and not current["task"].cancelling()
        if merged:
            self.stats.increment("merged")
        else:
            if len(self._tasks) >= self.max_inflight:
                raise RuntimeError("Translation request limit exceeded")
            task = asyncio.create_task(self._run(key, request, text, target, context, epoch, self.stats))
            current = {"task": task, "waiters": 0}
            self._inflight[key] = current
            self._tasks.add(task)
            task.add_done_callback(self._done)
        current["waiters"] += 1
        try:
            result = await asyncio.shield(current["task"])
            if self._closed or epoch != self._epoch:
                raise asyncio.CancelledError
            return replace(result, usage=None, source="shared") if merged else result
        finally:
            current["waiters"] -= 1
            if not current["waiters"] and not current["task"].done():
                if self._inflight.get(key) is current:
                    self._inflight.pop(key, None)
                current["task"].cancel()
