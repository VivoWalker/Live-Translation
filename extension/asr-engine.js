/* In-extension SenseVoice engine (sherpa-onnx WASM), driven from the offscreen page.

   Runs in a window context because the Emscripten glue is a classic script that
   must be loaded with <script> tags; a worker import hangs on this build.

   Usage:
     await JLSEngine.init({ target, apiKey, onEvent });
     JLSEngine.feed(float32Samples16k);
     JLSEngine.stop();
*/
(() => {
  'use strict';

  const SAMPLE_RATE = 16000;
  const VAD_WINDOW = 512;
  const PARTIAL_INTERVAL = 1100;
  const MIN_PARTIAL_SEC = 1.0;
  const MAX_WINDOW_SEC = 7;
  const MAX_SEGMENT_SEC = 12;
  const KEEP_SEC = 20;

  const MODEL_FILES = [
    {
      fs: '/sense-voice.onnx',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      label: 'SenseVoice 模型',
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    },
    {
      fs: '/silero_vad.onnx',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      label: 'VAD 模型',
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    },
    {
      fs: '/tokens.txt',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
      label: '分词表',
      sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    },
  ];
  // Keep existing downloads usable offline, but verify their bytes before use.
  const CACHE_NAME = 'jls-asr-v1';
  const PACKAGE_SHA256 = '4c063aa4af215b02b6c127f3b7be8ae8405ff1285a18117e746f4abe53e5b3be';
  const PACKAGE_META = { files: [
    { filename: '/sense-voice.onnx', start: 0, end: 239233841 },
    { filename: '/silero_vad.onnx', start: 239233841, end: 239877695 },
    { filename: '/tokens.txt', start: 239877695, end: 240193589 },
  ], remote_package_size: 240193589 };
  // Cache.put only supports HTTP(S) request URLs. A relative key resolves to
  // chrome-extension:// in production and is rejected. This URL is never fetched.
  const CACHE_KEY = 'https://jls-model-cache.invalid/sensevoice-2024-07-17.data';
  const LEGACY_CACHE_KEY = '/sensevoice-package.data';
  const PROMPTS = {
    "zh": "你是专业的日语影视字幕翻译。把用户消息 JSON 中 current 字段的日语台词翻译成自然、口语化的简体中文，符合字幕阅读习惯。previous 字段只用于理解指代和语气，不要翻译、复述或合并上一句；只翻译 current。只输出译文本身：不要解释，不要加引号，不要附日语原文，不要加“译文：”之类的前缀。人名、语气词、省略号和停顿要保留。",
    "en": "You translate Japanese dialogue in the current field of the user JSON into natural conversational English subtitles. Use the previous field only to understand references and tone. Do not translate, repeat or merge the previous sentence; translate current only. Output only the translation: no notes, no quotes, no Japanese source text. Preserve names, tone, ellipses and pauses."
  };

  const PROMPT_VERSION = 'subtitle-v2';
  const CACHE_LIMIT = 500, CACHE_BYTES = 1024 * 1024, ENTRY_BYTES = 32768, MAX_INFLIGHT = 32;
  const MAX_DELIVERIES = 32, TRANSLATION_CONCURRENCY = 3, MAX_QUEUE_MS = 16000;
  const USAGE_FIELDS = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'completion_tokens'];
  const encoder = new TextEncoder();
  let translationModel = 'deepseek-chat', translationBase = 'https://api.deepseek.com';
  let promptVersion = PROMPT_VERSION, temperature = 0.2, maxTokens = 512;
  let translationEpoch = 0;
  function freshTranslationState() {
    return { cache: new Map(), bytes: 0, inflight: new Map(), deliveries: new Map(), queue: [], active: 0,
      timer: null, lastSubmittedId: -1, lastTranslatedSegment: -1, succeeded: 0, failures: 0, overflows: 0, timeouts: 0,
      api: 0, completed: 0, hits: 0, merged: 0, ms: 0,
      tokens: Object.fromEntries(USAGE_FIELDS.map(k => [k, 0])),
      reported: Object.fromEntries(USAGE_FIELDS.map(k => [k, 0])),
      missing: Object.fromEntries(USAGE_FIELDS.map(k => [k, 0])) };
  }
  let translationState = freshTranslationState();
  let asrPacks = null, selectDomain = null, domainCorrector = null, domainPromise = null;
  async function loadDomain() {
    if (!domainPromise) domainPromise = (async () => {
      await loadScript(baseUrl() + 'asr-domain.js');
      const sources = await Promise.all(window.JLSASRDomain.packs.map(async id => {
        const response = await fetch(baseUrl() + `asr-terms/${id}.json`);
        if (!response.ok) throw new Error('识别词表加载失败');
        const raw = await response.text();
        if (encoder.encode(raw).length > 256 * 1024) throw new Error('识别词表过大');
        return [id, JSON.parse(raw)];
      }));
      selectDomain = window.JLSASRDomain.loadPacks(Object.fromEntries(sources));
    })().catch(() => { domainPromise = null; throw new Error('识别词表加载失败，请重新加载扩展'); });
    await domainPromise;
  }
  const add = (object, key, amount = 1) => object[key] = Math.min(Number.MAX_SAFE_INTEGER, object[key] + amount);
  function translationStats() {
    const s = translationState;
    const known = Object.fromEntries(USAGE_FIELDS.map(k => [k, s.reported[k] ? s.tokens[k] : null]));
    return { api_requests: s.api, api_requests_completed: s.completed, local_cache_hits: s.hits,
      merged_requests: s.merged, request_ms: Math.round(s.ms * 10) / 10,
      avg_request_ms: s.completed ? Math.round(s.ms / s.completed * 10) / 10 : null,
      ...Object.fromEntries(USAGE_FIELDS.map(k => [k, s.missing[k] ? null : known[k]])),
      usage_reported_tokens: known, usage_unavailable_requests: { ...s.missing },
      usage_pending_requests: Math.max(0, s.api - s.completed),
      cache_entries: s.cache.size, cache_bytes: s.bytes, in_flight: s.inflight.size,
      deliveries_in_flight: s.deliveries.size, delivered_segments: Math.min(s.succeeded, CACHE_LIMIT),
      last_translated_segment: s.lastTranslatedSegment < 0 ? null : s.lastTranslatedSegment,
      translation_failures: s.failures, translation_overflows: s.overflows, translation_timeouts: s.timeouts };
  }
  function finishRequest(s, ms, usage) {
    add(s, 'completed'); add(s, 'ms', Math.max(0, ms));
    for (const field of USAGE_FIELDS) {
      const value = usage?.[field];
      if (Number.isSafeInteger(value) && value >= 0) { add(s.reported, field); add(s.tokens, field, value); }
      else add(s.missing, field);
    }
  }
  function cachePut(s, key, text) {
    const bytes = encoder.encode(JSON.stringify([key])).length + encoder.encode(text).length;
    if (!text || bytes > ENTRY_BYTES) return;
    if (s.cache.has(key)) { s.bytes -= s.cache.get(key).bytes; s.cache.delete(key); }
    s.cache.set(key, { text, bytes }); s.bytes += bytes;
    while (s.cache.size > CACHE_LIMIT || s.bytes > CACHE_BYTES) {
      const oldest = s.cache.keys().next().value;
      s.bytes -= s.cache.get(oldest).bytes; s.cache.delete(oldest);
    }
  }
  function resetTranslationState(notify = false) {
    ++translationEpoch;
    for (const controller of pendingRequests) controller.abort();
    pendingRequests.clear();
    clearTimeout(translationState.timer);
    const pendingIds = [...translationState.deliveries.keys()];
    translationState.cache.clear(); translationState.inflight.clear();
    translationState.deliveries.clear(); translationState.queue.length = 0;
    translationState = freshTranslationState();
    previousFinalJapanese = '';
    if (notify) for (const id of pendingIds) emit({ type: 'translation_cancelled', id });
  }
  function requestSnapshot(text, context) {
    const target = targetLang;
    const payload = { model: translationModel,
      messages: [ { role: 'system', content: PROMPTS[target] || PROMPTS.zh },
        { role: 'user', content: JSON.stringify({ previous: context, current: text }) } ],
      temperature, max_tokens: maxTokens, stream: false };
    const endpoint = translationBase.replace(/\/+$/, '') + '/chat/completions';
    return { endpoint, payload, text, target, context, apiKey,
      key: JSON.stringify([endpoint, promptVersion, target, payload]) };
  }
  function validTranslation(epoch, state) { return epoch === translationEpoch && state === translationState; }
  function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(new DOMException('cancelled', 'AbortError'));
      if (signal.aborted) cancelled();
      else signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve(promise).then(value => { signal.removeEventListener('abort', cancelled); resolve(value); },
        error => { signal.removeEventListener('abort', cancelled); reject(error); });
    });
  }
  async function performRequest(snapshot, state, epoch, record) {
    const controller = record.controller;
    try {
      if (!validTranslation(epoch, state) || controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const started = performance.now();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        let text, retryTimer;
        try {
          text = await requestOnce(snapshot, state, controller.signal);
        } catch (error) {
          if (!error.retryable) throw error;
          try {
            await abortable(new Promise(resolve => { retryTimer = setTimeout(resolve, 250); }), controller.signal);
          } finally { clearTimeout(retryTimer); }
          text = await requestOnce(snapshot, state, controller.signal);
        }
        if (!validTranslation(epoch, state) || controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        cachePut(state, snapshot.key, text);
        return { text, ms: Math.round(performance.now() - started), source: 'api' };
      } finally { clearTimeout(timeout); }
    } finally {
      pendingRequests.delete(controller);
      if (state.inflight.get(snapshot.key) === record) state.inflight.delete(snapshot.key);
    }
  }
  async function requestOnce(snapshot, state, signal) {
    signal.throwIfAborted();
    const started = performance.now();
    let usage;
    add(state, 'api');
    try {
      let response;
      try {
        response = await abortable(fetch(snapshot.endpoint, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + snapshot.apiKey },
          body: JSON.stringify(snapshot.payload) }), signal);
      } catch (error) {
        if (error.name === 'TypeError') throw Object.assign(new Error('请求失败'), { retryable: true });
        throw error;
      }
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status),
        { retryable: response.status === 429 || response.status >= 500 });
      const data = await abortable(response.json(), signal);
      usage = data?.usage;
      const choice = Array.isArray(data?.choices) ? data.choices[0] : null, content = choice?.message?.content;
      if (choice?.finish_reason !== 'stop' || typeof content !== 'string' || !content.trim()) throw new Error('翻译结果为空或不完整');
      const text = content.trim().replace(/^(译文|翻译|中文)[:：]\s*/, '').trim().replace(/^["“”]+|["“”]+$/g, '').trim().replace(/\s*\n+\s*/g, ' ');
      if (!text) throw new Error('翻译结果为空');
      return text;
    } finally { finishRequest(state, performance.now() - started, usage); }
  }
  async function requestTranslation(snapshot, state, epoch) {
    if (encoder.encode(snapshot.key).length > 65536) throw new Error('翻译文本过长');
    const hit = state.cache.get(snapshot.key);
    if (hit) {
      state.cache.delete(snapshot.key); state.cache.set(snapshot.key, hit); add(state, 'hits');
      return { text: hit.text, ms: 0, source: 'cache' };
    }
    const existing = state.inflight.get(snapshot.key);
    if (existing) { add(state, 'merged'); return { ...await existing.promise, source: 'shared' }; }
    if (state.inflight.size >= MAX_INFLIGHT) throw new Error('翻译请求过多，请稍后重试');
    const record = { controller: new AbortController(), promise: null };
    pendingRequests.add(record.controller);
    record.promise = Promise.resolve().then(() => performRequest(snapshot, state, epoch, record));
    state.inflight.set(snapshot.key, record);
    return record.promise;
  }
  function setConfig(config) {
    const string = (key, fallback) => typeof config[key] === 'string' ? config[key] : fallback;
    const selection = config.asrPacks ?? config.asrDomain;
    const packs = selection === undefined ? asrPacks : window.JLSASRDomain.normalizePacks(selection);
    const packsChanged = packs?.join() !== asrPacks?.join();
    const next = { target: string('target', targetLang), apiKey: string('apiKey', apiKey),
      model: string('model', translationModel), baseUrl: string('baseUrl', translationBase),
      promptVersion: string('promptVersion', promptVersion),
      temperature: Number.isFinite(config.temperature) ? config.temperature : temperature,
      maxTokens: Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : maxTokens };
    const changed = packsChanged || next.target !== targetLang || next.apiKey !== apiKey || next.model !== translationModel ||
      next.baseUrl !== translationBase || next.promptVersion !== promptVersion || next.temperature !== temperature || next.maxTokens !== maxTokens;
    if (!changed) return;
    if (packsChanged) {
      domainCorrector = selectDomain(packs);
      asrPacks = packs;
    }
    resetTranslationState(true);
    targetLang = next.target; apiKey = next.apiKey; translationModel = next.model; translationBase = next.baseUrl;
    promptVersion = next.promptVersion; temperature = next.temperature; maxTokens = next.maxTokens;
  }

  let recognizer = null;
  let vad = null;
  let ready = false;
  let targetLang = 'zh';
  let apiKey = '';
  let onEvent = () => {};
  let started = false;
  let generation = 0;
  let runtimePromise = null;
  let modelLoad = null;
  const scripts = new Map();
  const pendingRequests = new Set();

  const chunks = [];
  let totalSamples = 0;
  let vadPending = new Float32Array(0);
  let segStart = 0;
  let segId = 0;
  let finalizedUntil = 0;
  let speaking = false;
  let lastPartialAt = 0;
  let partialInterval = PARTIAL_INTERVAL;
  let lastHyp = '';
  let lastText = '';
  let previousFinalJapanese = '';
  let busy = false;
  let decodeMsTotal = 0;
  let decodeCount = 0;
  let finals = 0;
  let translateCount = 0;
  let translateMsTotal = 0;
  let lastDecodeMs = 0;

  function emit(ev) {
    try {
      onEvent(ev);
    } catch (e) {
      /* never break audio processing on UI errors */
    }
  }

  const SCRIPT_BASE = (() => {
    const s = document.currentScript && document.currentScript.src;
    if (s) return s.replace(/[^/]+$/, '');
    try {
      return chrome.runtime.getURL('');
    } catch (e) {
      return '';
    }
  })();

  function baseUrl() {
    return SCRIPT_BASE;
  }

  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        const cleanup = () => { script.onload = script.onerror = null; script.remove(); };
        script.onload = () => { cleanup(); resolve(); };
        script.onerror = () => { cleanup(); scripts.delete(src); reject(new Error('无法加载 ' + src)); };
        document.head.appendChild(script);
      }));
    }
    return scripts.get(src);
  }

  async function verified(buffer, expected) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) {
      const error = new Error('识别模型校验失败，请重新下载');
      error.name = 'ModelIntegrityError';
      throw error;
    }
    return buffer;
  }

  async function fetchModel(url, signal) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('模型下载失败 HTTP ' + response.status);
      return await response.arrayBuffer();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }

  function unpack(buffer, meta) {
    const bytes = new Uint8Array(buffer);
    return meta.files.map(({ filename, start, end }) => [filename, bytes.subarray(start, end)]);
  }

  async function loadModels(config, progress, signal) {
    // Explicit packages belong to the local developer fixture.
    if (config.packageUrl) {
      let meta = config.packageMeta;
      if (!meta) {
        const response = await fetch(config.packageMetaUrl, { signal });
        if (!response.ok) throw new Error('无法读取识别模型索引');
        meta = await response.json();
      }
      if (!meta.files.length) return [];
      return unpack(await fetchModel(config.packageUrl, signal), meta);
    }
    let cache;
    let cacheError;
    try { cache = await caches.open(CACHE_NAME); } catch (error) { cacheError = error; }
    if (cache) {
      for (const key of [CACHE_KEY, LEGACY_CACHE_KEY]) {
        try {
          signal.throwIfAborted();
          const hit = await cache.match(key);
          if (!hit) continue;
          signal.throwIfAborted();
          const buffer = await verified(await hit.arrayBuffer(), PACKAGE_SHA256);
          signal.throwIfAborted();
          emit({ type: 'model-cache', saved: true, warning: false, message: '识别模型已保存在本地，无需重新下载。' });
          progress('识别模型已缓存，正在加载…');
          return unpack(buffer, PACKAGE_META);
        } catch (error) {
          signal.throwIfAborted();
          cacheError = error;
          if (error.name === 'ModelIntegrityError') {
            try { await cache.delete(key); } catch (error) { cacheError = error; }
            progress('本地模型缓存校验失败，正在重新下载…');
          }
        }
      }
    }
    signal.throwIfAborted();
    emit({ type: 'model-cache', saved: false, warning: false, message: '本地未找到可用模型，正在下载…' });
    // unlimitedStorage protects the extension from quota/eviction. Also request
    // persistence where the StorageManager API is supported (e.g. web tests).
    try { await globalThis.navigator?.storage?.persist?.(); } catch {}
    const parts = [];
    const meta = { files: [], remote_package_size: 0 };
    for (const file of MODEL_FILES) {
      progress('本地未找到模型，下载' + file.label + '…');
      const buffer = await verified(await fetchModel(file.url, signal), file.sha256);
      signal.throwIfAborted();
      const start = meta.remote_package_size;
      parts.push(buffer);
      meta.files.push({ filename: file.fs, start, end: start + buffer.byteLength });
      meta.remote_package_size += buffer.byteLength;
    }
    try {
      if (!cache) throw cacheError || new Error('Cache Storage unavailable');
      const blob = new Blob(parts, { type: 'application/octet-stream' });
      await cache.put(CACHE_KEY, new Response(blob, { headers: { 'X-JLS-Metadata': JSON.stringify(meta) } }));
      if (!await cache.match(CACHE_KEY)) throw new Error('Cache readback failed');
      signal.throwIfAborted();
      emit({ type: 'model-cache', saved: true, warning: false, message: '识别模型已保存，重开浏览器后可直接加载。' });
    } catch (error) {
      signal.throwIfAborted();
      const reason = error.name === 'QuotaExceededError' ? '本地存储空间不足' : '浏览器未能写入本地缓存';
      emit({ type: 'model-cache', saved: false, warning: true, message: `模型可以用于本次识别，但${reason}，下次开始字幕可能需要重新下载。` });
    }
    return parts.map((buffer, index) => [MODEL_FILES[index].fs, new Uint8Array(buffer)]);
  }

  // ------------------------------------------------------------ text helpers
  function normalizeJa(text) {
    return (text || '')
      .replace(/([\u3000-\u30ff\u3400-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef])/g, '$1')
      .replace(/\s+([、。！？])/g, '$1')
      .trim();
  }

  function commonPrefix(a, b) {
    let i = 0;
    const n = Math.min(a.length, b.length);
    while (i < n && a[i] === b[i]) i++;
    return a.slice(0, i);
  }

  // ------------------------------------------------------------ translation
  function scheduleTranslation(id, text) {
    const state = translationState, ticket = translationEpoch;
    if (id <= state.lastSubmittedId) return;
    state.lastSubmittedId = id;
    const context = previousFinalJapanese;
    previousFinalJapanese = text;
    if (state.deliveries.size >= MAX_DELIVERIES) {
      add(state, 'overflows'); add(state, 'failures');
      emit({ type: 'error', scope: 'translate', id, code: 'translation_overflow', message: '翻译队列已满' });
      return;
    }
    state.deliveries.set(id, { snapshot: requestSnapshot(text, context), queuedAt: performance.now() });
    state.queue.push(id);
    if (state.timer === null && state.active < TRANSLATION_CONCURRENCY) {
      state.timer = setTimeout(() => {
        state.timer = null;
        pumpTranslations(state, ticket);
      }, 0);
    }
  }

  function pumpTranslations(state, ticket) {
    if (!validTranslation(ticket, state)) return;
    while (state.active < TRANSLATION_CONCURRENCY && state.queue.length) {
      const id = state.queue.shift();
      state.active++;
      deliverTranslation(id, state, ticket).finally(() => {
        state.deliveries.delete(id);
        state.active--;
        pumpTranslations(state, ticket);
      });
    }
  }

  async function deliverTranslation(id, state, ticket) {
    const { snapshot, queuedAt } = state.deliveries.get(id);
    try {
      if (performance.now() - queuedAt >= MAX_QUEUE_MS) throw new DOMException('queue timeout', 'AbortError');
      if (!snapshot.apiKey) throw new Error('未填写 DeepSeek API Key');
      const result = await requestTranslation(snapshot, state, ticket);
      if (!validTranslation(ticket, state)) return;
      add(state, 'succeeded');
      state.lastTranslatedSegment = Math.max(state.lastTranslatedSegment, id);
      translateCount++; translateMsTotal += performance.now() - queuedAt;
      emit({ type: 'translation', id, final: true, text: result.text, source: result.source,
        engine: result.source === 'cache' ? 'deepseek:cache' : 'deepseek', ms: result.ms });
    } catch (error) {
      if (!validTranslation(ticket, state)) return;
      add(state, 'failures');
      const timedOut = error.name === 'AbortError';
      if (timedOut) add(state, 'timeouts');
      const safe = ['未填写 DeepSeek API Key', '翻译结果为空或不完整', '翻译结果为空', '翻译文本过长'].includes(error.message)
        || /^HTTP \d+$/.test(error.message) ? error.message : '请求失败';
      emit({ type: 'error', scope: 'translate', id, code: timedOut ? 'translation_timeout' : 'translation_failed',
        message: timedOut ? '翻译请求超时' : '翻译失败：' + safe });
    }
  }

  // ------------------------------------------------------------ audio pipeline
  function append(data) {
    chunks.push({ data, start: totalSamples });
    totalSamples += data.length;
    const cutoff = Math.max(0, totalSamples - KEEP_SEC * SAMPLE_RATE);
    while (chunks.length > 1 && chunks[1].start <= cutoff) chunks.shift();
  }

  function slice(start, end) {
    if (end <= start) return new Float32Array(0);
    const out = new Float32Array(Math.max(0, end - start));
    let filled = 0;
    for (const c of chunks) {
      const cEnd = c.start + c.data.length;
      if (cEnd <= start || c.start >= end) continue;
      const from = Math.max(0, start - c.start);
      const to = Math.min(c.data.length, end - c.start);
      out.set(c.data.subarray(from, to), filled);
      filled += to - from;
    }
    return filled === out.length ? out : out.subarray(0, filled);
  }

  function feedVad(data) {
    let pending = vadPending.length ? new Float32Array(vadPending.length + data.length) : data;
    if (vadPending.length) {
      pending.set(vadPending, 0);
      pending.set(data, vadPending.length);
    }
    let off = 0;
    while (pending.length - off >= VAD_WINDOW) {
      vad.acceptWaveform(pending.subarray(off, off + VAD_WINDOW));
      off += VAD_WINDOW;
    }
    vadPending = pending.slice(off);
  }

  function decode(samples) {
    const t0 = performance.now();
    const stream = recognizer.createStream();
    let text;
    try {
      stream.acceptWaveform(SAMPLE_RATE, samples);
      recognizer.decode(stream);
      text = recognizer.getResult(stream).text || '';
    } finally { stream.free(); }
    lastDecodeMs = performance.now() - t0;
    decodeMsTotal += lastDecodeMs;
    // Under load, back off instead of falling behind: previews get sparser but
    // finals still land on time.
    partialInterval = lastDecodeMs > 500
      ? Math.min(2400, partialInterval + 300)
      : Math.max(PARTIAL_INTERVAL, partialInterval - 100);
    decodeCount++;
    return domainCorrector.correct(normalizeJa(text));
  }

  function resetSegment() {
    segStart = totalSamples;
    lastHyp = '';
    lastText = '';
    lastPartialAt = 0;
  }

  function finishSegment(audio, start) {
    busy = true;
    try {
      const end = start + audio.length;
      audio = audio.subarray(Math.max(0, finalizedUntil - start));
      finalizedUntil = Math.max(finalizedUntil, end);
      if (audio.length < SAMPLE_RATE * 0.3) return;
      const text = decode(audio);
      if (!text) return;
      finals++;
      const id = segId++;
      emit({
        type: 'final',
        id,
        text,
        t: +(totalSamples / SAMPLE_RATE).toFixed(2),
        decode_ms: Math.round(lastDecodeMs),
      });
      lastText = text;
      scheduleTranslation(id, text);
    } finally {
      busy = false;
      resetSegment();
    }
  }

  function feed(samples) {
    if (!ready || !started) return;
    append(samples);
    feedVad(samples);
    if (busy) return;

    const inSpeech = vad.isDetected();
    if (inSpeech && !speaking) {
      speaking = true;
      segStart = Math.max(0, totalSamples - Math.round(0.35 * SAMPLE_RATE));
      lastPartialAt = 0;
      emit({ type: 'speech_start', id: segId });
    } else if (!inSpeech && speaking) {
      speaking = false;
      if (!vad.isEmpty()) {
        const seg = vad.front();
        const audio = seg.samples;
        vad.pop();
        finishSegment(audio, seg.start);
      } else {
        resetSegment();
      }
      return;
    }

    if (!speaking) return;
    const dur = (totalSamples - segStart) / SAMPLE_RATE;
    if (dur >= MAX_SEGMENT_SEC) {
      finishSegment(slice(segStart, totalSamples), segStart);
      return;
    }
    const now = Date.now();
    if (dur >= MIN_PARTIAL_SEC && now - lastPartialAt >= partialInterval) {
      lastPartialAt = now;
      const from = Math.max(segStart, totalSamples - MAX_WINDOW_SEC * SAMPLE_RATE);
      const audio = slice(from, totalSamples);
      busy = true;
      try {
        const text = decode(audio);
        if (text && text !== lastText) {
          const stable = lastHyp ? commonPrefix(lastHyp, text) : text;
          lastHyp = text;
          lastText = text;
          emit({ type: 'partial', id: segId, text, stable, t: +(totalSamples / SAMPLE_RATE).toFixed(2) });
          // ASR previews can still change. Submit only the finalized segment
          // to avoid translating the beginning of one sentence twice.
        }
      } finally {
        busy = false;
      }
    }
  }

  // ------------------------------------------------------------ init
  async function loadRuntime(progress) {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const wasmBase = baseUrl() + 'wasm/';
        let resolveRuntime, rejectRuntime;
        const initialized = new Promise((resolve, reject) => { resolveRuntime = resolve; rejectRuntime = reject; });
        initialized.catch(() => {});
        const module = window.Module = {
          locateFile: path => wasmBase + path,
          // Initialize the generated runtime without its default model package.
          // Verified files are mounted only while creating native sessions.
          _dataPackageMetadata: { files: [], remote_package_size: 0 },
          getPreloadedPackage: () => new ArrayBuffer(0),
          print: text => { if (text) progress(String(text)); },
          printErr: text => { if (text) progress(String(text)); },
          setStatus: text => { if (text) progress(String(text)); },
          onRuntimeInitialized: () => resolveRuntime(module),
          onAbort: reason => rejectRuntime(new Error(String(reason))),
        };
        progress('加载识别运行时…');
        await loadScript(wasmBase + 'sherpa-onnx-asr.js');
        await loadScript(wasmBase + 'sherpa-onnx-vad.js');
        await loadScript(wasmBase + 'sherpa-onnx-wasm-main-vad-asr.js');
        let timeout;
        try {
          return await Promise.race([initialized, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('识别运行时加载超时')), 300000);
          })]);
        } finally { clearTimeout(timeout); }
      })().catch(error => {
        scripts.delete(baseUrl() + 'wasm/sherpa-onnx-wasm-main-vad-asr.js');
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  }

  async function init(config) {
    stop();
    const epoch = generation;
    onEvent = config.onEvent || (() => {});
    const controller = modelLoad = new AbortController();
    const { signal } = controller;
    const progress = message => {
      if (epoch === generation) emit({ type: 'progress', message });
    };
    try {
      await abortable(loadDomain(), signal);
      signal.throwIfAborted();
      setConfig({ target: config.target || 'zh', apiKey: config.apiKey || '', model: config.model || 'deepseek-chat',
        asrPacks: config.asrPacks ?? config.asrDomain ?? 'gakumas',
        baseUrl: config.baseUrl || 'https://api.deepseek.com', promptVersion: config.promptVersion || PROMPT_VERSION,
        temperature: config.temperature ?? 0.2, maxTokens: config.maxTokens ?? 512 });
      const files = await loadModels(config, progress, signal);
      signal.throwIfAborted();
      const module = await abortable(loadRuntime(progress), signal);
      signal.throwIfAborted();
      const t0 = performance.now();
      setupWithModels(module, files);
      ready = started = true;
      emit({ type: 'ready', initMs: Math.round(performance.now() - t0) });
    } catch (error) {
      if (epoch === generation) stop();
      throw error;
    } finally {
      if (modelLoad === controller) modelLoad = null;
    }
  }

  function setupWithModels(module, files) {
    const mounted = [];
    try {
      for (const [filename, bytes] of files) {
        module.FS_createDataFile(filename, null, bytes, true, false, true);
        mounted.push(filename);
      }
      setupRuntime(module);
    } finally {
      for (const filename of mounted) module.FS_unlink(filename);
    }
  }

  function setupRuntime(module) {
    vad = createVad(module, {
      sileroVad: {
        model: '/silero_vad.onnx',
        threshold: 0.5,
        minSilenceDuration: 0.4,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      bufferSizeInSeconds: 30,
    });
    recognizer = new OfflineRecognizer(
      {
        modelConfig: {
          debug: 0,
          tokens: '/tokens.txt',
          senseVoice: { model: '/sense-voice.onnx', language: 'ja', useInverseTextNormalization: 1 },
        },
      },
      module
    );
  }

  function stats() {
    return {
      type: 'stats',
      audio_seconds: +(totalSamples / SAMPLE_RATE).toFixed(1),
      decodes: decodeCount,
      avg_decode_ms: decodeCount ? Math.round(decodeMsTotal / decodeCount) : 0,
      rtf: decodeCount ? +(decodeMsTotal / 1000 / Math.max(totalSamples / SAMPLE_RATE, 0.01)).toFixed(3) : 0,
      finals,
      asr_packs: asrPacks?.slice() ?? [],
      translations: translateCount,
      translation: translationStats(),
      avg_translate_ms: translateCount ? Math.round(translateMsTotal / translateCount) : 0,
    };
  }

  function stop() {
    ++generation;
    modelLoad?.abort();
    modelLoad = null;
    started = ready = false;
    resetTranslationState();
    onEvent = () => {};
    apiKey = lastHyp = lastText = '';
    chunks.length = 0;
    vadPending = new Float32Array(0);
    totalSamples = segStart = segId = lastPartialAt = finalizedUntil = 0;
    speaking = busy = false;
    partialInterval = PARTIAL_INTERVAL;
    decodeMsTotal = decodeCount = finals = translateCount = translateMsTotal = lastDecodeMs = 0;
    recognizer?.free();
    vad?.free();
    recognizer = vad = null;
  }

  window.JLSEngine = { init, feed, stop, stats, setConfig };
})();
