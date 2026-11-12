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
  const PARTIAL_TRANSLATE_EVERY = 2500;
  const PARTIAL_TRANSLATE_MIN = 10;

  const MODEL_FILES = [
    {
      fs: '/sense-voice.onnx',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      label: 'SenseVoice 模型',
    },
    {
      fs: '/silero_vad.onnx',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      label: 'VAD 模型',
    },
    {
      fs: '/tokens.txt',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
      label: '分词表',
    },
  ];
  const CACHE_NAME = 'jls-asr-v1';
  const CACHE_KEY = '/sensevoice-package.data';
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

  const chunks = [];
  let totalSamples = 0;
  let vadPending = new Float32Array(0);
  let segStart = 0;
  let segId = 0;
  let speaking = false;
  let lastPartialAt = 0;
  let partialInterval = PARTIAL_INTERVAL;
  let lastHyp = '';
  let lastText = '';
  let lastPartialTranslateAt = 0;
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
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('无法加载 ' + src));
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------ model package
  async function buildPackage() {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(CACHE_KEY);
      if (hit) {
        emit({ type: 'progress', message: '识别模型已缓存，正在加载…' });
        return { url: URL.createObjectURL(await hit.blob()), meta: null };
      }
    } catch (e) {
      /* cache unavailable */
    }

    const parts = [];
    const meta = { files: [], remote_package_size: 0 };
    let offset = 0;
    for (let i = 0; i < MODEL_FILES.length; i++) {
      const f = MODEL_FILES[i];
      emit({ type: 'progress', message: `首次使用，下载${f.label}（${i + 1}/${MODEL_FILES.length}）…` });
      const resp = await fetch(f.url);
      if (!resp.ok) throw new Error(`${f.label}下载失败 HTTP ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      parts.push(buf);
      meta.files.push({ filename: f.fs, start: offset, end: offset + buf.length });
      offset += buf.length;
    }
    meta.remote_package_size = offset;
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(CACHE_KEY, new Response(blob));
    } catch (e) {
      /* caching is best effort */
    }
    return { url: URL.createObjectURL(blob), meta };
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
  async function translate(id, text, isFinal) {
    if (!text) return;
    if (!apiKey) {
      emit({ type: 'error', scope: 'translate', message: '未填写 DeepSeek API Key' });
      return;
    }
    const t0 = performance.now();
    const base = PROMPTS[targetLang] || PROMPTS.zh;
    const system = finalContext
      ? base + '\n上一句字幕是「' + finalContext + '」，只用来理解指代和语气；不要翻译或复述它。'
      : base;
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
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
      const out = (data.choices?.[0]?.message?.content || '').trim().replace(/^["“](.*)["”]$/, '$1');
      const ms = Math.round(performance.now() - t0);
      translateCount++;
      translateMsTotal += ms;
      if (isFinal) finalContext = text;
      emit({ type: 'translation', id, final: isFinal, text: out, engine: 'deepseek', ms });
    } catch (e) {
      emit({ type: 'error', scope: 'translate', message: '翻译失败：' + (e.message || e) });
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
    stream.acceptWaveform(SAMPLE_RATE, samples);
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text || '';
    stream.free();
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

  function finishSegment(audio) {
    busy = true;
    try {
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
      setTimeout(() => translate(id, text, true), 0);
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
        finishSegment(audio);
      } else {
        resetSegment();
      }
      return;
    }

    if (!speaking) return;
    const dur = (totalSamples - segStart) / SAMPLE_RATE;
    if (dur >= MAX_SEGMENT_SEC) {
      finishSegment(slice(segStart, totalSamples));
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
          if (stable.length >= PARTIAL_TRANSLATE_MIN && now - lastPartialTranslateAt >= PARTIAL_TRANSLATE_EVERY) {
            lastPartialTranslateAt = now;
            setTimeout(() => translate(segId, stable, false), 0);
          }
        }
      } finally {
        busy = false;
      }
    }
  }

  // ------------------------------------------------------------ init
  async function init(config) {
    targetLang = config.target || 'zh';
    apiKey = config.apiKey || '';
    onEvent = config.onEvent || (() => {});

    const pkg = config.packageUrl
      ? { url: config.packageUrl, meta: config.packageMeta || (await (await fetch(config.packageMetaUrl)).json()) }
      : await buildPackage();
    const wasmBase = baseUrl() + 'wasm/';

    window.Module = {
      locateFile: (path) => (path.endsWith('.data') ? pkg.url : wasmBase + path),
      print: (t) => { if (t) emit({ type: 'progress', message: String(t) }); },
      printErr: (t) => { if (t) emit({ type: 'progress', message: String(t) }); },
      setStatus: (t) => { if (t) emit({ type: 'progress', message: String(t) }); },
      onRuntimeInitialized: () => setupRuntime(),
    };
    if (pkg.meta) window.Module._dataPackageMetadata = pkg.meta;

    emit({ type: 'progress', message: '加载识别运行时…' });
    await loadScript(wasmBase + 'sherpa-onnx-wasm-main-vad-asr.js');
    await loadScript(wasmBase + 'sherpa-onnx-asr.js');
    await loadScript(wasmBase + 'sherpa-onnx-vad.js');
    started = true;
  }

  function setupRuntime() {
    try {
      const t0 = performance.now();
      vad = createVad(Module, {
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
        Module
      );
      ready = true;
      emit({ type: 'ready', initMs: Math.round(performance.now() - t0) });
    } catch (e) {
      emit({ type: 'error', scope: 'asr', message: '识别引擎初始化失败：' + (e.message || e) });
    }
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
    started = false;
    ready = false;
  }

  window.JLSEngine = { init, feed, stop, stats, setConfig: (c) => { if (c.target) targetLang = c.target; if (c.apiKey) apiKey = c.apiKey; } };
})();
