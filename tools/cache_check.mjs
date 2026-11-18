/** Cache regression: real Chromium exits/reopens the same temporary profile.
 * Uses local verified model files; WASM wrappers are stubs because this tests
 * storage, not recognition. No real DeepSeek key or external download is used.
 * JLS_CHROME=/usr/bin/chromium DSH_HOME=/path/to/.dsh node tools/cache_check.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1]; };
const dataRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'speech-to-text/sensevoice/models');
const modelDir = option('model-dir', process.env.JLSUBS_MODEL_DIR || join(dataRoot, 'sensevoice-onnx'));
const files = [join(modelDir, 'model.int8.onnx'), option('vad-model', join(dataRoot, 'silero/silero_vad.onnx')), join(modelDir, 'tokens.txt')];
for (const file of files) assert(existsSync(file), 'Missing local model: ' + file);
const engine = readFileSync(join(root, 'extension/asr-engine.js'), 'utf8');
const urls = [...engine.matchAll(/url: '([^']+)'/g)].map(match => match[1]);
assert.equal(urls.length, 3);
const profile = mkdtempSync(join(tmpdir(), 'jls-cache-restart-'));
const packPaths = new Set(readdirSync(join(root, 'extension/asr-terms')).filter(name => name.endsWith('.json'))
  .map(name => '/asr-terms/' + name));
const chrome = process.env.JLS_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'chromium');
let downloads = 0;
const server = createServer((request, response) => {
  const fixture = /^\/fixture\/(\d)$/.exec(request.url);
  if (fixture) {
    const index = Number(fixture[1]);
    if (!files[index]) { response.writeHead(404).end(); return; }
    downloads++;
    response.setHeader('Content-Type', 'application/octet-stream');
    const source = createReadStream(files[index]);
    source.on('error', () => response.destroy());
    source.pipe(response);
  } else if (request.url === '/engine.js') {
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8'); response.end(engine);
  } else if (request.url === '/asr-domain.js' || packPaths.has(request.url)) {
    const type = request.url.endsWith('.json') ? 'application/json' : 'application/javascript';
    response.setHeader('Content-Type', type + '; charset=utf-8');
    response.end(readFileSync(join(root, 'extension', request.url.slice(1))));
  } else if (request.url === '/wasm/sherpa-onnx-asr.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end('class OfflineRecognizer { free() {} }');
  } else if (request.url === '/wasm/sherpa-onnx-vad.js') {
    response.setHeader('Content-Type', 'application/javascript'); response.end('function createVad() { return { free() {} }; }');
  } else if (request.url === '/wasm/sherpa-onnx-wasm-main-vad-asr.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end('Module.FS_createDataFile = () => {}; Module.FS_unlink = () => {}; Module.onRuntimeInitialized();');
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><script>
      const modelURLs = ${JSON.stringify(urls)};
      const fetchOriginal = window.fetch.bind(window);
      window.fetch = (url, options) => {
        const index = modelURLs.indexOf(String(url));
        return fetchOriginal(index < 0 ? url : '/fixture/' + index, options);
      };
      </script><script src="/engine.js"></script><script>
      window.cacheCheck = (async () => {
        const events = [];
        const probe = await caches.open('jls-scheme-probe');
        let schemeError;
        try {
          await probe.put('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sensevoice-package.data', new Response('probe'));
        } catch (error) { schemeError = {name: error.name, message: error.message}; }
        await caches.delete('jls-scheme-probe');
        await JLSEngine.init({onEvent: event => events.push(event)});
        const result = {schemeError, ready: events.some(e => e.type === 'ready'),
          cache: events.filter(e => e.type === 'model-cache').at(-1),
          progress: events.filter(e => e.type === 'progress').map(e => e.message)};
        JLSEngine.stop();
        return result;
      })();
      </script>`);
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

function cdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url), waiting = new Map();
    let sequence = 0;
    socket.onerror = () => reject(new Error('DevTools connection failed'));
    socket.onclose = () => {
      for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error('DevTools closed')); }
      waiting.clear();
    };
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      const item = waiting.get(data.id);
      if (!item) return;
      waiting.delete(data.id); clearTimeout(item.timer);
      if (data.error) item.reject(new Error(JSON.stringify(data.error))); else item.resolve(data.result);
    };
    socket.onopen = () => resolve({
      close: () => socket.close(),
      call(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => { waiting.delete(id); reject(new Error('DevTools timeout: ' + method)); }, 90000);
          waiting.set(id, {resolve, reject, timer});
          socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
        });
      },
    });
  });
}
async function phase() {
  const portFile = join(profile, 'DevToolsActivePort');
  rmSync(portFile, {force: true});
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], {stdio: 'ignore'});
  let startError;
  child.on('error', error => { startError = error; });
  const exited = new Promise(resolve => child.once('close', resolve));
  let connection;
  try {
    let version;
    for (let i = 0; i < 150; i++) {
      if (startError) throw startError;
      try {
        const port = readFileSync(portFile, 'utf8').split('\n')[0];
        version = await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json());
        break;
      } catch { await pause(100); }
    }
    assert(version, 'Browser did not start');
    connection = await cdp(version.webSocketDebuggerUrl);
    const {targetId} = await connection.call('Target.createTarget', {url: origin});
    const {sessionId} = await connection.call('Target.attachToTarget', {targetId, flatten: true});
    for (let i = 0; i < 100; i++) {
      const probe = await connection.call('Runtime.evaluate', {expression: 'typeof window.cacheCheck !== "undefined"', returnByValue: true}, sessionId);
      if (probe.result?.value) break;
      await pause(50);
    }
    const result = await connection.call('Runtime.evaluate', {expression: 'window.cacheCheck', returnByValue: true, awaitPromise: true}, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    assert(result.result?.value?.ready, 'Model loader did not become ready');
    await connection.call('Browser.close').catch(() => {});
    let timeout;
    try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Browser did not exit')), 10000); })]); }
    finally { clearTimeout(timeout); }
    return result.result.value;
  } finally {
    connection?.close();
    if (child.exitCode === null) { child.kill(); await exited; }
  }
}
try {
  const first = await phase();
  const firstDownloads = downloads;
  assert.equal(first.schemeError?.name, 'TypeError', 'Must reproduce the old unsupported scheme');
  assert.match(first.schemeError.message, /scheme.*unsupported/);
  assert.equal(firstDownloads, 3);
  assert.equal(first.cache?.saved, true);
  const second = await phase();
  assert.equal(second.cache?.saved, true);
  assert.equal(downloads, firstDownloads, 'Reopening Chrome must not download the models again');
  console.log(JSON.stringify({firstStartDownloads: firstDownloads, afterRestartDownloads: downloads - firstDownloads,
    firstCacheSaved: first.cache.saved, reopenedCacheSaved: second.cache.saved, originalError: first.schemeError.message}, null, 2));
  console.log('RESULT: PASS (real Cache API, full model hashes, two separate browser processes; WASM stubs)');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, {recursive: true, force: true});
}
