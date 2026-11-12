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
      if (this.sent.length === 2) queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'ready', translator: 'mock' }) }));
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

function engine({ runtimeReady = true, cache, fetcher, cryptoImpl = webcrypto } = {}) {
  let speech = true, moduleReady;
  const requests = [], events = [], scripts = [];
  const sandbox = vm.createContext({
    console, crypto: cryptoImpl, performance, Date, Float32Array, Uint8Array, Blob, URL, Response,
    DOMException, AbortController, setTimeout, clearTimeout,
    navigator: { storage: { persist: async () => true } },
    caches: cache || { open: async () => ({ match: async () => null, put: async () => {} }) },
    fetch: fetcher || ((url, options) => { const request = deferred(); requests.push({ ...request, url, options }); return request.promise; }),
    createVad: () => ({ free() {}, acceptWaveform() {}, isDetected: () => speech, isEmpty: () => false, front: () => ({ samples: new Float32Array(9600) }), pop() {} }),
    OfflineRecognizer: class {
      free() {}
      createStream() { return { acceptWaveform() {}, free() {} }; }
      decode() {}
      getResult() { return { text: 'PRIVATE_TAB_A' }; }
    },
  });
  sandbox.window = sandbox;
  sandbox.document = { currentScript: { src: 'http://local/ext-assets/asr-engine.js' }, createElement: () => ({}), head: { appendChild(script) {
    scripts.push(script.src);
    if (script.src.endsWith('sherpa-onnx-wasm-main-vad-asr.js')) {
      moduleReady = () => sandbox.Module.onRuntimeInitialized();
      if (runtimeReady) queueMicrotask(moduleReady);
    }
    script.onload();
  } } };
  vm.runInContext(read('asr-engine.js'), sandbox);
  const config = { apiKey: 'sk-fake', packageUrl: 'http://local/mock.data', packageMeta: { files: [], remote_package_size: 0 }, onEvent: e => events.push(e) };
  return { api: sandbox.JLSEngine, config, events, requests, scripts, ready: () => moduleReady(),
    utterance() { speech = true; for (let i = 0; i < 6; i++) sandbox.JLSEngine.feed(new Float32Array(1600)); speech = false; sandbox.JLSEngine.feed(new Float32Array(1600)); },
  };
}

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
  context.requests[0].resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'PRIVATE_TRANSLATION' } }] }) });
  await tick();
  assert.equal(next.some(e => e.text === 'PRIVATE_TRANSLATION'), false);
  assert.equal(context.api.stats().audio_seconds, 0);
  assert.equal(context.scripts.length, 3, 'runtime scripts must load once across restarts');
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
  assert.equal(context.scripts.length, 0);
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
      storage: { local: { setAccessLevel: async () => {}, set: async entries => Object.assign(values, entries) }, session: { get: async key => ({ [key]: values[key] }), set: async entries => Object.assign(values, entries) } },
      tabs: { sendMessage: async (id, m) => { painted.push({ id, ...m }); return { ok: true }; }, query: async () => [], onRemoved: { addListener() {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    },
  });
  vm.runInContext(read('background.js'), sandbox);
  const message = { type: 'jls:start', tabId: 1, engine: 'server', apiKey: 'sk-fake', serverToken: 'token', streamId: 'mock' };
  assert.equal((await dispatch(listener, message, 'popup.html')).ok, true);
  const first = sent.find(m => m.type === 'jls:offscreen-start');
  assert.equal(first.engine, 'server'); assert.equal(first.apiKey, 'sk-fake'); assert.equal(first.serverToken, 'token');
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
    if (!elements.has(id)) elements.set(id, { value: '', className: '', addEventListener(name, fn) { this[name] = fn; } });
    return elements.get(id);
  };
  const sandbox = vm.createContext({
    document: { getElementById: element }, window: { addEventListener() {} }, setInterval: () => 1, clearInterval() {},
    fetch: async () => { calls++; throw new Error('No local service'); },
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://video.test', title: 'test' }] },
      storage: { local: { get: async () => ({ jlsEngine: 'browser', jlsApiKey: 'sk-fake', jlsModelCache: { saved: false, warning: true, message: '模型未保存' } }), set: async () => {} }, session: { get: async () => ({}) } },
      runtime: { sendMessage: async m => { sent.push(m); return m.type === 'jls:query' ? { running: false } : { ok: true }; } },
      tabCapture: { getMediaStreamId: async () => 'mock' },
    },
  });
  vm.runInContext(read('popup.js'), sandbox);
  await tick();
  assert.equal(element('model-cache-status').textContent, '模型未保存');
  assert.equal(element('model-cache-status').className, 'hint warning');
  await element('start').click();
  assert.equal(calls, 0);
  assert.equal(sent.find(m => m.type === 'jls:start').engine, 'browser');
});
