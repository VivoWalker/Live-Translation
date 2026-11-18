import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const read = name => fs.readFileSync(new URL('../extension/' + name, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const extensionId = 'a'.repeat(32);
const extensionURL = path => `chrome-extension://${extensionId}/${path}`;
function loadBackground(sandbox) {
  sandbox.importScripts = file => vm.runInContext(read(file), sandbox);
  vm.runInContext(read('background.js'), sandbox);
}
function dispatch(listener, message, page = 'background.js') {
  return new Promise(resolve => {
    if (!listener(message, { id: extensionId, url: extensionURL(page) }, resolve)) resolve(undefined);
  });
}
function media() {
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function offscreen(engine = { init: async () => {}, stop() {}, stats: () => ({}) }) {
  const requests = [], messages = [], sockets = [];
  let listener;
  class Context {
    constructor() { this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {} async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Socket {
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); queueMicrotask(() => this.onopen()); }
    send(raw) {
      this.sent.push(JSON.parse(raw));
      if (this.sent.length === 2) queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'ready', asr: 'whisper-base-int8', translator: 'mock' }) }));
    }
    close() { this.readyState = 3; }
  }
  const sandbox = vm.createContext({
    console, DOMException, setTimeout, clearTimeout, setInterval, clearInterval,
    AudioContext: Context, AudioWorkletNode: class { constructor() { this.port = {}; } disconnect() {} },
    WebSocket: Socket, JLSEngine: engine,
    navigator: { mediaDevices: { getUserMedia() { const request = deferred(); requests.push(request); return request.promise; } } },
    chrome: { runtime: { id: extensionId, getURL: extensionURL, sendMessage: async m => { messages.push(m); }, onMessage: { addListener(fn) { listener = fn; } } } },
  });
  vm.runInContext(read('offscreen.js'), sandbox);
  return { requests, messages, sockets, send: message => dispatch(listener, message) };
}

test('late media is stopped after cancellation and cannot restart capture', async () => {
  const context = offscreen();
  const pending = context.send({ type: 'jls:offscreen-start', sessionId: 'A', engine: 'browser' });
  await tick();
  await context.send({ type: 'jls:offscreen-stop', sessionId: 'A' });
  assert.equal((await pending).ok, false);
  const stream = media();
  context.requests[0].resolve(stream);
  await tick();
  assert.equal(stream.track.stopped, true);
  assert.equal(context.messages.some(m => m.phase === 'capturing'), false);
});

test('an older start or stop cannot clean up a newer capture', async () => {
  const context = offscreen();
  const first = context.send({ type: 'jls:offscreen-start', sessionId: 'A' });
  await tick();
  const second = context.send({ type: 'jls:offscreen-start', sessionId: 'B' });
  await tick();
  const b = media(), a = media();
  context.requests[1].resolve(b);
  assert.equal((await second).ok, true);
  context.requests[0].resolve(a);
  assert.equal((await first).ok, false);
  await tick();
  await context.send({ type: 'jls:offscreen-stop', sessionId: 'A' });
  assert.equal(a.track.stopped, true);
  assert.equal(b.track.stopped, false);
  await context.send({ type: 'jls:offscreen-stop', sessionId: 'B' });
  assert.equal(b.track.stopped, true);
});

test('media resolved in the same microtask turn is still owned by stop', async () => {
  const context = offscreen();
  const pending = context.send({ type: 'jls:offscreen-start', sessionId: 'A' });
  await tick();
  const stream = media();
  context.requests[0].resolve(stream);
  await Promise.resolve();
  await context.send({ type: 'jls:offscreen-stop', sessionId: 'A' });
  await pending;
  assert.equal(stream.track.stopped, true);
});

test('server mode authenticates and never starts the browser engine', async () => {
  let browserStarts = 0;
  const context = offscreen({ init: async () => { browserStarts++; }, stop() {} });
  const started = context.send({ type: 'jls:offscreen-start', sessionId: 'S', engine: 'server', serverToken: 'test-token', target: 'en' });
  await tick();
  context.requests[0].resolve(media());
  assert.equal((await started).ok, true);
  assert.deepEqual(context.sockets[0].sent[0], { type: 'auth', token: 'test-token' });
  assert.equal(browserStarts, 0);
  assert.equal(context.messages.some(m => m.phase === 'connected' && m.message.includes('whisper-base-int8')), true);
  await context.send({ type: 'jls:offscreen-stop', sessionId: 'S' });
});

test('stop during engine initialization stops media and suppresses late progress', async () => {
  const initialization = deferred();
  let handler;
  const context = offscreen({ init: config => { handler = config.onEvent; return initialization.promise; }, stop() {} });
  const started = context.send({ type: 'jls:offscreen-start', sessionId: 'A' });
  await tick();
  const stream = media();
  context.requests[0].resolve(stream);
  await tick();
  await context.send({ type: 'jls:offscreen-stop', sessionId: 'A' });
  initialization.resolve();
  assert.equal((await started).ok, false);
  handler({ type: 'translation', text: 'late private text' });
  assert.equal(stream.track.stopped, true);
  assert.equal(context.messages.some(m => m.event?.text === 'late private text'), false);
});

function engine({ runtimeReady = true, runtimeFailure = false, decodeFailure = false, cache, fetcher, domainFetcher, cryptoImpl = webcrypto, clock, urlImpl = URL, requestTimeoutMs } = {}) {
  let speech = true, moduleReady;
  let hypothesis = 'PRIVATE_TAB_A';
  let vadSegment = { samples: new Float32Array(9600), start: 0 };
  const decodedAudio = [];
  const requests = [], events = [], scripts = [];
  let freedStreams = 0, removedScripts = 0;
  let recognizerConfig;
  const sandbox = vm.createContext({
    console, crypto: cryptoImpl, performance,
    Date: clock ? class extends Date { static now() { return clock.now; } } : Date,
    Float32Array, Uint8Array, Blob, URL: urlImpl, Response, TextEncoder,
    DOMException, AbortController,
    setTimeout: (fn, delay) => setTimeout(fn, delay === 12000 && requestTimeoutMs !== undefined ? requestTimeoutMs : delay), clearTimeout,
    navigator: { storage: { persist: async () => true } },
    caches: cache || { open: async () => ({ match: async () => null, put: async () => {} }) },
    fetch: (url, options) => String(url).endsWith('/asr-terms.json')
      ? domainFetcher ? domainFetcher() : Promise.resolve(new Response(read('asr-terms.json')))
      : fetcher ? fetcher(url, options) : (() => { const request = deferred(); requests.push({ ...request, url, options }); return request.promise; })(),
    createVad: () => ({ free() {}, acceptWaveform() {}, isDetected: () => speech, isEmpty: () => false, front: () => vadSegment, pop() {} }),
    OfflineRecognizer: class {
      constructor(config) { recognizerConfig = config; }
      free() {}
      createStream() { return { acceptWaveform(rate, audio) { decodedAudio.push(audio.slice()); }, free() { freedStreams++; } }; }
      decode() { if (decodeFailure) throw new Error('decode fixture failed'); }
      getResult() { return { text: hypothesis }; }
    },
  });
  sandbox.window = sandbox;
  sandbox.document = { currentScript: { src: 'http://local/ext-assets/asr-engine.js' }, createElement: () => ({ remove() { removedScripts++; } }), head: { appendChild(script) {
    scripts.push(script.src);
    if (script.src.endsWith('/asr-domain.js')) vm.runInContext(read('asr-domain.js'), sandbox);
    if (script.src.endsWith('sherpa-onnx-wasm-main-vad-asr.js')) {
      if (runtimeFailure) { script.onerror(); return; }
      moduleReady = () => sandbox.Module.onRuntimeInitialized();
      if (runtimeReady) queueMicrotask(moduleReady);
    }
    script.onload();
  } } };
  vm.runInContext(read('asr-engine.js'), sandbox);
  const config = { apiKey: 'sk-fake', packageUrl: 'http://local/mock.data', packageMeta: { files: [], remote_package_size: 0 }, onEvent: e => events.push(e) };
  return { api: sandbox.JLSEngine, config, events, requests, scripts, decodedAudio, ready: () => moduleReady(),
    get recognizerConfig() { return recognizerConfig; },
    get freedStreams() { return freedStreams; }, get removedScripts() { return removedScripts; },
    hypothesis(text) { hypothesis = text; },
    vadSegment(samples, start = 0) { vadSegment = { samples, start }; },
    speech(seconds) { speech = true; for (let i = 0; i < Math.round(seconds * 10); i++) sandbox.JLSEngine.feed(new Float32Array(1600)); },
    endSpeech() { speech = false; sandbox.JLSEngine.feed(new Float32Array(1600)); },
    utterance() { vadSegment = { samples: new Float32Array(9600), start: Math.round(sandbox.JLSEngine.stats().audio_seconds * 16000) }; speech = true; for (let i = 0; i < 6; i++) sandbox.JLSEngine.feed(new Float32Array(1600)); speech = false; sandbox.JLSEngine.feed(new Float32Array(1600)); },
  };
}

test('long changing previews stay local and only the final sentence is translated', async () => {
  const clock = { now: 10000 };
  const context = engine({ clock });
  await context.api.init(context.config);
  try {
    for (const preview of [
      'こんにちは、今日は東京の天気について',
      'こんにちは、今日は東京の天気についてお話しします。',
      'こんにちは、今日は東京の天気についてお話しします。午後から',
    ]) {
      clock.now += 3000;
      context.hypothesis(preview);
      context.speech(1.5);
      await tick();
      assert.equal(context.requests.length, 0, 'a changing preview must not call DeepSeek');
    }
    assert(context.events.filter(e => e.type === 'partial').length >= 3, 'Japanese previews remain visible');
    const finalText = 'こんにちは、今日は東京の天気についてお話しします。午後から雨が降るそうです。';
    context.hypothesis(finalText);
    context.endSpeech();
    await tick();
    assert.equal(context.requests.length, 1);
    const payload = JSON.parse(context.requests[0].options.body);
    assert.equal(JSON.parse(payload.messages.find(m => m.role === 'user').content).current, finalText);
    context.requests[0].resolve({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '今天介绍东京的天气，下午可能下雨。' } }] }) });
    await tick();
    const translations = context.events.filter(e => e.type === 'translation');
    assert.equal(translations.length, 1);
    assert.equal(translations[0].final, true);
    assert.equal(translations[0].id, context.events.find(e => e.type === 'final').id);
  } finally { context.api.stop(); }
});

test('native ASR streams are freed even when decoding throws', async () => {
  const context = engine({ decodeFailure: true });
  await context.api.init(context.config);
  try {
    assert.throws(() => context.utterance(), /decode fixture failed/);
    assert.equal(context.freedStreams, 1);
  } finally { context.api.stop(); }
});

test('100 capture restarts abort pending translations and reuse the loaded runtime', async () => {
  const active = new Set();
  let calls = 0;
  const context = engine({ fetcher: (url, { signal }) => new Promise((resolve, reject) => {
    calls++; active.add(signal);
    signal.addEventListener('abort', () => { active.delete(signal); reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
  }) });
  for (let cycle = 0; cycle < 100; cycle++) {
    await context.api.init(context.config);
    context.utterance(); await tick();
    assert.equal(active.size, 1);
    context.api.stop(); await tick();
    assert.equal(active.size, 0);
    assert.equal(context.api.stats().audio_seconds, 0);
  }
  assert.equal(calls, 100);
  assert.equal(context.freedStreams, 100);
  assert.equal(context.scripts.length, 4);
});

test('temporary model blob URLs and loader scripts are released on success and failed retries', async () => {
  for (const runtimeFailure of [false, true]) {
    const active = new Set();
    let created = 0;
    class OwnedURLs extends URL {
      static createObjectURL() { const url = 'blob:fixture-' + (++created); active.add(url); return url; }
      static revokeObjectURL(url) { active.delete(url); }
    }
    const fixtures = modelFixtures();
    const context = engine({ runtimeFailure, cryptoImpl: fixtures.cryptoImpl, fetcher: fixtures.fetcher, urlImpl: OwnedURLs });
    try {
      for (let attempt = 0; attempt < (runtimeFailure ? 4 : 1); attempt++) {
        const initializing = context.api.init({ apiKey: 'sk-fake' });
        if (runtimeFailure) await assert.rejects(initializing, /无法加载/);
        else await initializing;
        assert.equal(active.size, 0, 'the engine must revoke every package URL it owns');
      }
      assert.equal(context.removedScripts, context.scripts.length);
      assert.equal(created, runtimeFailure ? 4 : 1);
    } finally { context.api.stop(); }
  }
});

test('a long utterance only decodes its remaining audio after a forced final', async () => {
  const context = engine({ clock: { now: 10000 } });
  await context.api.init(context.config);
  try {
    context.speech(12);
    await tick();
    assert.equal(context.requests.length, 1);
    assert.equal(context.decodedAudio.at(-1).length, 12 * 16000);
    context.requests[0].resolve({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '前半译文' } }] }) });
    await tick();
    context.speech(1);
    const wholeUtterance = new Float32Array(13 * 16000).fill(1);
    wholeUtterance.fill(2, 12 * 16000);
    context.vadSegment(wholeUtterance);
    context.endSpeech();
    await tick();
    assert.equal(context.requests.length, 2, 'one request for each non-overlapping final');
    assert.equal(context.decodedAudio.at(-1).length, 16000);
    assert(context.decodedAudio.at(-1).every(value => value === 2), 'previously finalized audio must not be decoded again');
    context.requests[1].resolve({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '剩余译文' } }] }) });
    await tick();
  } finally { context.api.stop(); }
});

test('late API response is aborted and cannot leak into a new session', async () => {
  const context = engine();
  await context.api.init(context.config);
  context.utterance();
  await tick();
  assert.equal(context.requests.length, 1);
  context.api.stop();
  assert.equal(context.requests[0].options.signal.aborted, true);
  const next = [];
  await context.api.init({ ...context.config, onEvent: e => next.push(e) });
  context.requests[0].resolve({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE_TRANSLATION' } }] }) });
  await tick();
  assert.equal(next.some(e => e.text === 'PRIVATE_TRANSLATION'), false);
  assert.equal(context.api.stats().audio_seconds, 0);
  assert.equal(context.scripts.length, 4, 'runtime and lexicon scripts must load once across restarts');
  context.api.stop();
});

test('stop cancels scheduled translation before network dispatch', async () => {
  const context = engine();
  await context.api.init(context.config);
  context.utterance();
  context.api.stop();
  await tick();
  assert.equal(context.requests.length, 0);
});

test('cancelled initialization never publishes ready to a later session', async () => {
  const context = engine({ runtimeReady: false });
  const first = context.api.init(context.config);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick();
  context.api.stop();
  const secondEvents = [];
  const second = context.api.init({ ...context.config, onEvent: e => secondEvents.push(e) });
  context.ready();
  await rejected;
  await second;
  assert.equal(context.events.some(e => e.type === 'ready'), false);
  assert.equal(secondEvents.filter(e => e.type === 'ready').length, 1);
  context.api.stop();
});

test('tampered cached model is removed and corrupt download is rejected before WASM', async () => {
  let deleted = false;
  const context = engine({
    cache: { open: async () => ({ match: async () => new Response('tampered'), delete: async () => { deleted = true; } }) },
    fetcher: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  });
  await assert.rejects(context.api.init({ onEvent() {} }), /校验失败/);
  assert.equal(deleted, true);
  assert.equal(context.scripts.filter(src => src.includes('/wasm/')).length, 0);
});

// Cache behavior uses tiny fixtures; cryptographic validation itself is covered
// by the corruption test and the real-browser check with full model bytes.
function modelFixtures() {
  const bodies = ['model-fixture', 'vad-fixture', 'tokens-fixture'];
  const hashes = [
    'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
  ];
  const known = new Map(bodies.map((body, index) => [body, hashes[index]]));
  known.set(bodies.join(''), '4c063aa4af215b02b6c127f3b7be8ae8405ff1285a18117e746f4abe53e5b3be');
  let downloads = 0;
  return {
    get downloads() { return downloads; },
    cryptoImpl: { subtle: { digest: async (algorithm, data) => {
      const hash = known.get(Buffer.from(data).toString());
      return hash ? Uint8Array.from(Buffer.from(hash, 'hex')).buffer : webcrypto.subtle.digest(algorithm, data);
    } } },
    fetcher: async () => {
      const body = bodies[downloads++ % bodies.length];
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    },
  };
}

function extensionCache(entries = new Map()) {
  const normalize = key => new URL(key, extensionURL('offscreen.html')).href;
  return { open: async () => ({
    match: async key => entries.get(normalize(key))?.clone(),
    delete: async key => entries.delete(normalize(key)),
    put: async (key, response) => {
      const url = normalize(key);
      if (!/^https?:/.test(url)) throw new TypeError('Request scheme chrome-extension is unsupported');
      entries.set(url, response.clone());
    },
  }) };
}

test('model cache uses an HTTP(S) key and survives a fresh engine context', async () => {
  const fixtures = modelFixtures(), entries = new Map();
  const cache = extensionCache(entries);
  const first = engine({ cache, cryptoImpl: fixtures.cryptoImpl, fetcher: fixtures.fetcher });
  const events = [];
  await first.api.init({ onEvent: e => events.push(e) });
  assert.equal(fixtures.downloads, 3);
  assert.equal(entries.size, 1);
  assert.match([...entries.keys()][0], /^https:\/\//);
  assert(events.some(e => e.type === 'model-cache' && e.saved));
  first.api.stop();
  const secondEvents = [];
  const second = engine({ cache, cryptoImpl: fixtures.cryptoImpl, fetcher: async () => { throw new Error('Unexpected redownload'); } });
  await second.api.init({ onEvent: e => secondEvents.push(e) });
  assert(secondEvents.some(e => e.type === 'ready'));
  assert(secondEvents.some(e => e.type === 'model-cache' && e.saved));
  assert.equal(fixtures.downloads, 3);
  second.api.stop();
});

test('quota failure is reported without falsely claiming the model was saved', async () => {
  const fixtures = modelFixtures();
  const context = engine({ ...fixtures, cache: { open: async () => ({
    match: async () => undefined,
    put: async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
  }) } });
  const events = [];
  await context.api.init({ onEvent: e => events.push(e) });
  assert(events.some(e => e.type === 'ready'), 'downloaded model remains usable this session');
  assert(events.some(e => e.type === 'model-cache' && !e.saved && e.warning && e.message.includes('空间不足')));
  assert.equal(events.some(e => e.type === 'model-cache' && e.saved), false);
  context.api.stop();
});

test('unavailable Cache Storage produces a visible cache warning', async () => {
  const fixtures = modelFixtures();
  const context = engine({ ...fixtures, cache: { open: async () => { throw new Error('Storage disabled'); } } });
  const events = [];
  await context.api.init({ onEvent: e => events.push(e) });
  assert(events.some(e => e.type === 'model-cache' && !e.saved && e.warning));
  context.api.stop();
});

test('large model storage has the extension permission needed to avoid eviction', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert(manifest.permissions.includes('unlimitedStorage'));
});

test('background forwards mode/keys and refuses stale or spoofed events', async () => {
  let listener;
  const sent = [], painted = [], values = {};
  const sandbox = vm.createContext({
    console, crypto: webcrypto, setTimeout,
    chrome: {
      runtime: { id: extensionId, getURL: extensionURL, getContexts: async () => [{}], onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async m => { sent.push(m); return { ok: true }; } },
      storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: values[key] }), set: async entries => Object.assign(values, entries) }, session: { get: async key => ({ [key]: values[key] }), set: async entries => Object.assign(values, entries) } },
      tabs: { sendMessage: async (id, m) => { painted.push({ id, ...m }); return { ok: true }; }, query: async () => [], onRemoved: { addListener() {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    },
  });
  loadBackground(sandbox);
  const message = { type: 'jls:start', tabId: 1, engine: 'server', apiKey: 'sk-fake', serverToken: 'token', streamId: 'mock', asrDomain: 'anime' };
  assert.equal((await dispatch(listener, message, 'popup.html')).ok, true);
  const first = sent.find(m => m.type === 'jls:offscreen-start');
  assert.equal(first.engine, 'server'); assert.equal(first.apiKey, 'sk-fake'); assert.equal(first.serverToken, 'token');
  assert.equal(first.asrDomain, 'anime');
  await dispatch(listener, { ...message, tabId: 2 }, 'popup.html');
  painted.length = 0;
  await dispatch(listener, { type: 'jls:event', sessionId: first.sessionId, event: { text: 'private' } }, 'offscreen.html');
  await tick();
  assert.equal(painted.length, 0);
  const last = sent.filter(m => m.type === 'jls:offscreen-start').at(-1);
  await dispatch(listener, { type: 'jls:event', sessionId: last.sessionId, event: { type: 'model-cache', saved: false, warning: true, message: '模型未保存' } }, 'offscreen.html');
  await tick();
  assert.equal(values.jlsModelCache.saved, false);
  assert.equal(values.jlsModelCache.warning, true);
  assert.equal(painted.length, 0, 'cache status belongs in the popup, not video captions');
  await dispatch(listener, { type: 'jls:event', sessionId: last.sessionId, event: { text: 'spoof' } }, 'popup.html');
  await tick();
  assert.equal(painted.length, 0);
  await dispatch(listener, { type: 'jls:event', sessionId: last.sessionId, event: { text: 'current' } }, 'offscreen.html');
  await tick();
  assert.equal(painted[0].id, 2);
  await dispatch(listener, { type: 'jls:caption-settings-set', settings: { theme: 'dark', sourceSize: 19, apiKey: 'private' } }, 'popup.html');
  assert.equal(painted.at(-1).type, 'jls:caption-settings-update');
  assert.equal(painted.at(-1).id, 2);
  assert.equal(painted.at(-1).settings.sourceSize, 19);
  assert.equal(painted.at(-1).settings.theme, 'dark');
  assert.equal(painted.at(-1).settings.apiKey, undefined);
  await dispatch(listener, { type: 'jls:stop' }, 'popup.html');
  assert.equal((await dispatch(listener, { type: 'jls:query' }, 'popup.html')).running, false);
  painted.length = 0;
  await dispatch(listener, { type: 'jls:event', sessionId: last.sessionId, event: { text: 'after-stop' } }, 'offscreen.html');
  await tick();
  assert.equal(painted.length, 0);
});

test('browser-mode popup starts without fetching a local service', async () => {
  let calls = 0;
  const sent = [], elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', className: '', dataset: {}, addEventListener(name, fn) { this[name] = fn; } });
    return elements.get(id);
  };
  const sandbox = vm.createContext({
    document: { getElementById: element, documentElement: { dataset: {} } },
    fetch: async () => { calls++; throw new Error('No local service'); },
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://video.test', title: 'test' }] },
      storage: { local: { get: async () => ({ jlsEngine: 'browser', jlsApiKey: 'sk-fake', jlsModelCache: { saved: false, warning: true, message: '模型未保存' } }), set: async () => {} }, session: { get: async () => ({}) }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async m => { sent.push(m); return m.type === 'jls:query' ? { running: false } : { ok: true }; } },
      tabCapture: { getMediaStreamId: async () => 'mock' },
    },
  });
  vm.runInContext(read('caption-settings.js'), sandbox);
  sandbox.JLS.createCaptionEditor = () => ({ update() {} });
  sandbox.JLS.createCaptionPreview = () => ({ update() {} });
  vm.runInContext(read('popup.js'), sandbox);
  await tick();
  assert.equal(element('model-cache-status').textContent, '模型未保存');
  assert.equal(element('model-cache-status').className, 'model-cache warning');
  await element('start').click();
  assert.equal(calls, 0);
  assert.equal(sent.find(m => m.type === 'jls:start').engine, 'browser');
  assert.equal(sent.find(m => m.type === 'jls:start').asrDomain, 'gakumas');
});

test('content scripts can persist only public caption preferences through the background', async () => {
  let listener;
  const values = { jlsApiKey: 'private-test-key', jlsCaptionPrefs: { fontSize: 26, color: '#eeeeff', apiKey: 'must-not-return' } };
  const sandbox = vm.createContext({
    chrome: {
      runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        local: { setAccessLevel: async () => {}, get: async key => ({ [key]: values[key] }), set: async items => Object.assign(values, items) },
        session: { get: async () => ({}) },
      },
      tabs: { onRemoved: { addListener() {} } },
    },
  });
  loadBackground(sandbox);
  const sender = { id: extensionId, tab: { id: 1 }, url: 'https://video.example/watch' };
  const ask = (message, from = sender) => new Promise(resolve => {
    if (!listener(message, from, resolve)) resolve(null);
  });
  const saved = await ask({ type: 'jls:caption-settings-get' });
  assert.equal(saved.settings.fontSize, 26);
  assert.equal(saved.settings.apiKey, undefined);
  assert.equal(saved.jlsApiKey, undefined);
  await ask({ type: 'jls:caption-settings-set', settings: { fontSize: 999, width: -100, color: 'url(https://bad.invalid)', position: { x: -1, y: 2 }, jlsApiKey: 'overwrite' } });
  assert.equal(values.jlsCaptionPrefs.fontSize, 40);
  assert.equal(values.jlsCaptionPrefs.width, 40);
  assert.equal(values.jlsCaptionPrefs.position.x, 0);
  assert.equal(values.jlsCaptionPrefs.position.y, 1);
  assert.equal(values.jlsCaptionPrefs.color, undefined);
  assert.equal(values.jlsApiKey, 'private-test-key');
  assert.equal(await ask({ type: 'jls:caption-settings-set', settings: { fontSize: 16 } }, { ...sender, id: 'foreign' }), null);
  assert.equal(await ask({ type: 'jls:caption-settings-get' }, { id: extensionId }), null);
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('content.js')).js;
  assert.deepEqual(scripts, ['caption-settings.js', 'caption-overlay.js', 'content.js']);
});

const successfulReply = (text = '完整译文', usage = { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20, completion_tokens: 5 }) => ({
  ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: text } }], usage }),
});
async function translatedUtterance(context, text) {
  const previous = context.requests.length;
  context.hypothesis(text); context.utterance(); await tick();
  if (context.requests.length > previous) context.requests.at(-1).resolve(successfulReply());
  await tick();
}

test('browser prompt contract is fixed and uses the same JSON envelope as Python', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/translation_contract.json', import.meta.url), 'utf8'));
  const context = engine(); await context.api.init(context.config);
  try {
    await translatedUtterance(context, '前の句');
    await translatedUtterance(context, '今の句');
    const payload = JSON.parse(context.requests[1].options.body);
    assert.deepEqual(payload.messages[0], { role: 'system', content: fixture.system.zh });
    assert.deepEqual(JSON.parse(payload.messages[1].content), { previous: '前の句', current: '今の句' });
    assert.equal(JSON.parse(context.requests[0].options.body).messages[0].content, payload.messages[0].content);
    context.api.setConfig({ target: 'en' });
    await translatedUtterance(context, 'English target');
    assert.equal(JSON.parse(context.requests[2].options.body).messages[0].content, fixture.system.en);
  } finally { context.api.stop(); }
});

test('browser reuse respects context and a cache hit advances context for the next sentence', async () => {
  const context = engine(); await context.api.init(context.config);
  try {
    for (const text of ['句A', '句B', '句A', '句B', '句A']) await translatedUtterance(context, text);
    assert.equal(context.requests.length, 3);
    assert.deepEqual(context.events.filter(e => e.type === 'translation').map(e => e.source), ['api', 'api', 'api', 'cache', 'cache']);
    const stats = context.api.stats().translation;
    assert.equal(stats.api_requests, 3); assert.equal(stats.local_cache_hits, 2);
    assert.equal(stats.prompt_cache_hit_tokens, 0);
    assert.equal(stats.prompt_cache_miss_tokens, 60); assert.equal(stats.completion_tokens, 15);
  } finally { context.api.stop(); }
});

test('browser concurrent identical requests share one API result and emit once per distinct segment', async () => {
  const context = engine(); await context.api.init(context.config);
  try {
    context.hypothesis('同じ句'); context.utterance(); context.utterance();
    await tick(); assert.equal(context.requests.length, 1);
    context.requests[0].resolve(successfulReply()); await tick();
    const events = context.events.filter(e => e.type === 'translation');
    assert.equal(events.length, 2); assert.equal(new Set(events.map(e => e.id)).size, 2);
    const stats = context.api.stats().translation;
    assert.equal(stats.api_requests, 1); assert.equal(stats.merged_requests, 1);
    assert.equal(stats.completion_tokens, 5); assert.equal(stats.in_flight, 0);
    assert.equal(stats.deliveries_in_flight, 0);
  } finally { context.api.stop(); }
});

test('browser model, version, endpoint and output parameter changes clear session reuse and counters', async () => {
  const context = engine(); await context.api.init(context.config);
  try {
    await translatedUtterance(context, '句');
    for (const config of [{ model: 'other-model' }, { promptVersion: 'subtitle-v3' }, { baseUrl: 'https://api.deepseek.com/v1' }, { temperature: .3 }, { maxTokens: 513 }, { apiKey: 'sk-new-fixture' }]) {
      context.api.setConfig(config);
      assert.equal(context.api.stats().translation.cache_entries, 0);
      assert.equal(context.api.stats().translation.api_requests, 0);
      await translatedUtterance(context, '句');
    }
    const latest = context.requests.at(-1);
    assert.equal(latest.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(JSON.parse(latest.options.body).model, 'other-model');
    assert.equal(JSON.parse(latest.options.body).max_tokens, 513);
    assert.deepEqual(JSON.parse(JSON.parse(latest.options.body).messages[1].content), { previous: '', current: '句' });
  } finally { context.api.stop(); }
});

test('browser incomplete and failed responses are not cached and can be retried', async () => {
  const context = engine(); await context.api.init(context.config);
  try {
    for (const response of [
      { ok: false, status: 500 },
      { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '截断的输出' } }] }) },
      { ok: true, json: async () => ({ choices: [{ message: { content: '缺失结束标记' } }] }) },
      successfulReply('  '), successfulReply('“”'),
    ]) {
      context.hypothesis('同じ句'); context.utterance(); await tick();
      context.requests.at(-1).resolve(response); await tick();
      assert.equal(context.api.stats().translation.cache_entries, 0);
      assert.equal(context.api.stats().translation.in_flight, 0);
    }
    await translatedUtterance(context, '同じ句');
    assert.equal(context.requests.length, 6);
    assert.equal(context.events.filter(e => e.type === 'translation').length, 1);
  } finally { context.api.stop(); }
});

test('browser usage missing fields remain unavailable and timeout cleanup permits retry', async () => {
  let attempts = 0;
  const context = engine({ requestTimeoutMs: 15, fetcher: (url, { signal }) => {
    attempts++;
    if (attempts === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true }));
    return Promise.resolve(successfulReply('成功', { prompt_cache_hit_tokens: 0, completion_tokens: 0 }));
  } });
  await context.api.init(context.config);
  try {
    context.utterance(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(context.api.stats().translation.in_flight, 0);
    assert.equal(context.api.stats().translation.cache_entries, 0);
    context.utterance(); await tick();
    const stats = context.api.stats().translation;
    assert.equal(stats.api_requests, 2); assert.equal(stats.api_requests_completed, 2);
    assert.equal(stats.prompt_cache_hit_tokens, null);
    assert.equal(stats.prompt_cache_miss_tokens, null);
    assert.equal(stats.usage_reported_tokens.prompt_cache_hit_tokens, 0);
    assert.equal(stats.usage_unavailable_requests.prompt_cache_hit_tokens, 1);
    assert.equal(stats.usage_unavailable_requests.prompt_cache_miss_tokens, 2);
  } finally { context.api.stop(); }
});

test('browser configuration changes and restarts cannot deliver or cache an old request', async () => {
  const context = engine(); await context.api.init(context.config);
  context.utterance(); await tick();
  const previous = context.requests[0];
  context.api.setConfig({ target: 'en' });
  assert.equal(previous.options.signal.aborted, true);
  previous.resolve(successfulReply('旧译文')); await tick();
  assert.equal(context.events.filter(e => e.type === 'translation').length, 0);
  assert.equal(context.api.stats().translation.cache_entries, 0);
  assert.equal(context.api.stats().translation.api_requests, 0);
  context.api.stop(); await context.api.init(context.config);
  await translatedUtterance(context, 'PRIVATE_TAB_A');
  assert.equal(context.requests.length, 2);
  assert.equal(context.api.stats().translation.api_requests, 1);
  context.api.stop();
});

test('browser cache, delivery bookkeeping and statistics remain bounded in a long session', async () => {
  let calls = 0;
  const context = engine({ fetcher: async (url, options) => {
    calls++;
    const text = JSON.parse(JSON.parse(options.body).messages[1].content).current;
    return successfulReply(text === 'too-large' ? '字'.repeat(40000) : '完整译文'.repeat(180));
  } });
  await context.api.init(context.config);
  try {
    for (let i = 0; i < 650; i++) { context.hypothesis('台词' + i); context.utterance(); await tick(); }
    let stats = context.api.stats().translation;
    assert.equal(calls, 650); assert(stats.cache_entries <= 500); assert(stats.cache_bytes <= 1024 * 1024);
    assert(stats.delivered_segments <= 500); assert.equal(stats.in_flight, 0); assert.equal(stats.deliveries_in_flight, 0);
    const bytes = stats.cache_bytes;
    context.hypothesis('too-large'); context.utterance(); await tick();
    stats = context.api.stats().translation;
    assert.equal(stats.cache_bytes, bytes, 'oversized translations must not enter the cache');
    context.api.stop(); stats = context.api.stats().translation;
    assert.equal(stats.cache_entries, 0); assert.equal(stats.in_flight, 0); assert.equal(stats.api_requests, 0);
    assert.equal(stats.prompt_cache_hit_tokens, null);
  } finally { context.api.stop(); }
});

test('browser timeout removes the record even if fetch ignores abort; late data stays discarded', async () => {
  const context = engine({ requestTimeoutMs: 15 }); await context.api.init(context.config);
  try {
    context.utterance(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(context.api.stats().translation.in_flight, 0);
    assert.equal(context.api.stats().translation.deliveries_in_flight, 0);
    context.requests[0].resolve(successfulReply('迟到的数据')); await tick();
    assert.equal(context.events.filter(e => e.type === 'translation').length, 0);
    assert.equal(context.api.stats().translation.cache_entries, 0);
    await translatedUtterance(context, 'PRIVATE_TAB_A');
    assert.equal(context.requests.length, 2);
    assert.equal(context.events.filter(e => e.type === 'translation').length, 1);
  } finally { context.api.stop(); }
});

test('browser failures and usage statistics never echo dialogue, provider bodies or credentials', async () => {
  const context = engine(); await context.api.init(context.config);
  try {
    context.hypothesis('PRIVATE_SENTENCE'); context.utterance(); await tick();
    context.requests[0].resolve({ ok: true, json: async () => { throw new Error('PRIVATE_SENTENCE sk-private-context'); } });
    await tick();
    const diagnostic = JSON.stringify({ errors: context.events.filter(e => e.type === 'error'), stats: context.api.stats().translation });
    assert(!diagnostic.includes('PRIVATE_SENTENCE'));
    assert(!diagnostic.includes('sk-private-context'));
    assert(!diagnostic.includes('Bearer'));
    assert.equal(context.api.stats().translation.in_flight, 0);
  } finally { context.api.stop(); }
});

test('browser Japanese decoding and domain correction reach both preview and final translation', async () => {
  const clock = { now: 10000 }, context = engine({ clock });
  await context.api.init(context.config);
  try {
    assert.equal(context.recognizerConfig.modelConfig.senseVoice.language, 'ja');
    context.hypothesis('日高 真白さんと秦谷みすずの話です。');
    context.speech(1.5); await tick();
    assert.equal(context.events.find(event => event.type === 'partial').text, '陽高真白さんと秦谷美鈴の話です。');
    assert.equal(context.requests.length, 0);
    context.endSpeech(); await tick();
    assert.equal(context.events.find(event => event.type === 'final').text, '陽高真白さんと秦谷美鈴の話です。');
    assert.equal(JSON.parse(JSON.parse(context.requests[0].options.body).messages[1].content).current, '陽高真白さんと秦谷美鈴の話です。');
    context.requests[0].resolve(successfulReply()); await tick();
    assert.equal(context.events.filter(event => event.type === 'translation').length, 1);
  } finally { context.api.stop(); }
});

test('changing ASR domain cancels old translation and starts with clean context and correct text', async () => {
  const context = engine(); await context.api.init(context.config);
  try {
    context.hypothesis('日高真白さん'); context.utterance(); await tick();
    context.api.setConfig({ asrDomain: 'off' });
    assert.equal(context.requests[0].options.signal.aborted, true);
    context.requests[0].resolve(successfulReply('old')); await tick();
    assert.equal(context.events.filter(event => event.type === 'translation').length, 0);
    await translatedUtterance(context, '日高真白さん');
    assert.equal(context.events.filter(event => event.type === 'final').at(-1).text, '日高真白さん');
    const user = JSON.parse(JSON.parse(context.requests.at(-1).options.body).messages[1].content);
    assert.deepEqual(user, { previous: '', current: '日高真白さん' });
    assert.equal(context.api.stats().asr_domain, 'off');
    assert.throws(() => context.api.setConfig({ asrDomain: 'unknown' }), /未知/);
    await context.api.init(context.config);
    await translatedUtterance(context, '日高真白さん');
    assert.equal(context.events.filter(event => event.type === 'final').at(-1).text, '陽高真白さん');
  } finally { context.api.stop(); }
});

test('a failed lexicon load can retry and stopping during the load cannot publish a ready engine', async () => {
  let calls = 0;
  const loaded = deferred();
  const context = engine({ domainFetcher: () => {
    calls++;
    return calls === 1 ? Promise.resolve(new Response('not json')) : loaded.promise;
  } });
  await assert.rejects(context.api.init(context.config), /识别词表加载失败/);
  const pending = context.api.init(context.config);
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  await tick(); context.api.stop();
  loaded.resolve(new Response(read('asr-terms.json')));
  await cancelled;
  assert.equal(context.events.some(event => event.type === 'ready'), false);
  await context.api.init(context.config);
  assert.equal(calls, 2, 'static lexicon is fetched only once after a successful load');
  assert.equal(context.events.filter(event => event.type === 'ready').length, 1);
  context.api.stop();
});
