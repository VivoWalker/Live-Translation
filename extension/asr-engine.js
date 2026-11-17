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
    zh:
      '你是专业的日语影视字幕翻译。把用户给出的日语台词翻译成自然、口语化的简体中文，符合字幕阅读习惯。' +
      '只输出译文本身：不要解释，不要加引号，不要附日语原文，不要加“译文：”之类的前缀。',
    en:
      'You translate Japanese dialogue into natural conversational English subtitles. ' +
      'Output only the translation: no notes, no quotes, no Japanese source text.',
  };

  let recognizer = null;
  let vad = null;
  let ready = false;
  let targetLang = 'zh';
  let apiKey = '';
  let onEvent = () => {};
  let started = false;
  let generation = 0;
  let runtimePromise = null;
  const scripts = new Map();
  const pendingRequests = new Set();
  const timers = new Set();

  function scheduleTranslation(id, text, final) {
    const epoch = generation;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (epoch === generation) translate(id, text, final, epoch);
    }, 0);
    timers.add(timer);
  }

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
  let finalContext = '';
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

  async function fetchModel(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('模型下载失败 HTTP ' + response.status);
      return await response.arrayBuffer();
    } finally { clearTimeout(timer); }
  }

  async function buildPackage(progress) {
    let cache;
    let cacheError;
    try { cache = await caches.open(CACHE_NAME); } catch (error) { cacheError = error; }
    if (cache) {
      for (const key of [CACHE_KEY, LEGACY_CACHE_KEY]) {
        try {
          const hit = await cache.match(key);
          if (!hit) continue;
          const buffer = await verified(await hit.arrayBuffer(), PACKAGE_SHA256);
          emit({ type: 'model-cache', saved: true, warning: false, message: '识别模型已保存在本地，无需重新下载。' });
          progress('识别模型已缓存，正在加载…');
          return { url: URL.createObjectURL(new Blob([buffer])), meta: PACKAGE_META, owned: true };
        } catch (error) {
          cacheError = error;
          if (error.name === 'ModelIntegrityError') {
            try { await cache.delete(key); } catch (error) { cacheError = error; }
            progress('本地模型缓存校验失败，正在重新下载…');
          }
        }
      }
    }
    emit({ type: 'model-cache', saved: false, warning: false, message: '本地未找到可用模型，正在下载…' });
    // unlimitedStorage protects the extension from quota/eviction. Also request
    // persistence where the StorageManager API is supported (e.g. web tests).
    try { await globalThis.navigator?.storage?.persist?.(); } catch {}
    const parts = [];
    const meta = { files: [], remote_package_size: 0 };
    for (const file of MODEL_FILES) {
      progress('本地未找到模型，下载' + file.label + '…');
      const buffer = await verified(await fetchModel(file.url), file.sha256);
      const start = meta.remote_package_size;
      parts.push(buffer);
      meta.files.push({ filename: file.fs, start, end: start + buffer.byteLength });
      meta.remote_package_size += buffer.byteLength;
    }
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    try {
      if (!cache) throw cacheError || new Error('Cache Storage unavailable');
      await cache.put(CACHE_KEY, new Response(blob, { headers: { 'X-JLS-Metadata': JSON.stringify(meta) } }));
      if (!await cache.match(CACHE_KEY)) throw new Error('Cache readback failed');
      emit({ type: 'model-cache', saved: true, warning: false, message: '识别模型已保存，重开浏览器后可直接加载。' });
    } catch (error) {
      const reason = error.name === 'QuotaExceededError' ? '本地存储空间不足' : '浏览器未能写入本地缓存';
      emit({ type: 'model-cache', saved: false, warning: true, message: `模型可以用于本次识别，但${reason}；重开浏览器可能需要重新下载。` });
    }
    return { url: URL.createObjectURL(blob), meta, owned: true };
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
  async function translate(id, text, isFinal, epoch) {
    if (epoch !== generation) return;
    if (!text) return;
    if (!apiKey) {
      emit({ type: 'error', scope: 'translate', id, message: '未填写 DeepSeek API Key' });
      return;
    }
    const controller = new AbortController();
    pendingRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    const t0 = performance.now();
    const base = PROMPTS[targetLang] || PROMPTS.zh;
    const system = finalContext
      ? base + '\n上一句字幕是「' + finalContext + '」，只用来理解指代和语气；不要翻译或复述它。'
      : base;
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          temperature: 0.2,
          max_tokens: 512,
          stream: false,
        }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (epoch !== generation) return;
      const out = (data.choices?.[0]?.message?.content || '').trim().replace(/^["“](.*)["”]$/, '$1');
      const ms = Math.round(performance.now() - t0);
      translateCount++;
      translateMsTotal += ms;
      if (isFinal) finalContext = text;
      emit({ type: 'translation', id, final: isFinal, text: out, engine: 'deepseek', ms });
    } catch (e) {
      if (epoch === generation) emit({ type: 'error', scope: 'translate', id, message: '翻译失败：' + (e.message || e) });
    } finally {
      clearTimeout(timeout);
      pendingRequests.delete(controller);
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
    return normalizeJa(text);
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
      scheduleTranslation(id, text, true);
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
  async function loadRuntime(config, progress) {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        // Explicit package URLs are for the developer test harness only.
        const pkg = config.packageUrl
          ? { url: config.packageUrl, meta: config.packageMeta || (await (await fetch(config.packageMetaUrl)).json()) }
          : await buildPackage(progress);
        try {
          const wasmBase = baseUrl() + 'wasm/';
          let resolveRuntime, rejectRuntime;
          const initialized = new Promise((resolve, reject) => { resolveRuntime = resolve; rejectRuntime = reject; });
          initialized.catch(() => {});
          const module = window.Module = {
            locateFile: path => path.endsWith('.data') ? pkg.url : wasmBase + path,
            print: text => { if (text) progress(String(text)); },
            printErr: text => { if (text) progress(String(text)); },
            setStatus: text => { if (text) progress(String(text)); },
            onRuntimeInitialized: () => resolveRuntime(module),
            onAbort: reason => rejectRuntime(new Error(String(reason))),
          };
          if (pkg.meta) module._dataPackageMetadata = pkg.meta;
          progress('加载识别运行时…');
          // Define wrappers before a cached model can initialize the runtime.
          await loadScript(wasmBase + 'sherpa-onnx-asr.js');
          await loadScript(wasmBase + 'sherpa-onnx-vad.js');
          await loadScript(wasmBase + 'sherpa-onnx-wasm-main-vad-asr.js');
          let timeout;
          try {
            return await Promise.race([initialized, new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('识别运行时加载超时')), 300000);
            })]);
          } finally { clearTimeout(timeout); }
        } finally {
          if (pkg.owned) URL.revokeObjectURL(pkg.url);
        }
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
    targetLang = config.target || 'zh';
    apiKey = config.apiKey || '';
    onEvent = config.onEvent || (() => {});
    const module = await loadRuntime(config, message => {
      if (epoch === generation) emit({ type: 'progress', message });
    });
    if (epoch !== generation) throw new DOMException('采集已取消', 'AbortError');
    const t0 = performance.now();
    try {
      setupRuntime(module);
      ready = started = true;
      emit({ type: 'ready', initMs: Math.round(performance.now() - t0) });
    } catch (error) {
      stop();
      throw error;
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
          senseVoice: { model: '/sense-voice.onnx', language: '', useInverseTextNormalization: 1 },
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
      translations: translateCount,
      avg_translate_ms: translateCount ? Math.round(translateMsTotal / translateCount) : 0,
    };
  }

  function stop() {
    ++generation;
    started = ready = false;
    for (const controller of pendingRequests) controller.abort();
    pendingRequests.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    onEvent = () => {};
    apiKey = finalContext = lastHyp = lastText = '';
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

  window.JLSEngine = { init, feed, stop, stats, setConfig: (c) => { if (c.target) targetLang = c.target; if (c.apiKey) apiKey = c.apiKey; } };
})();
