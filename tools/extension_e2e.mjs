/**
 * Extension smoke test in a browser that supports --load-extension.
 * Verifies what can be verified without a human clicking
 * the toolbar button:
 *
 *   - the extension loads and its MV3 service worker starts
 *   - content script is present on a normal page and answers "ping"
 *   - background -> content relay paints the overlay
 *   - start() without an activeTab grant fails with a readable message
 *
 *   node tools/extension_e2e.mjs --browser edge
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const pick = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const HEADED = argv.includes('--headed');
const EDGE = pick('browser', 'edge') === 'edge';
const PORT = Number(process.env.JLS_CDP_PORT || pick('port', '9361'));
const CHROME = process.env.JLS_CHROME ||
  (EDGE ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const EXT = resolve('extension');
const PAGE = 'http://127.0.0.1:8765/static/test-player.html';

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('extension/manifest.json missing');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'jls-e2e-'));
const args = [
  '--no-sandbox',
  '--disable-breakpad',
  '--disable-crash-reporter',
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
];
if (!HEADED) args.unshift('--headless=new');
const child = spawn(CHROME, [...args, 'about:blank'], { stdio: 'ignore' });

let msgId = 0;
const pending = new Map();
const logs = [];

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws error'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        clearTimeout(p.timer);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 400))) : p.resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        logs.push('exception: ' + (d.exception?.description || d.text));
      }
    };
  });
}

function call(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout ' + method));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function evaluate(ws, sessionId, expression, awaitPromise = true) {
  const r = await call(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function waitDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools not up');
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

try {
  const version = await waitDevtools();
  const ws = await connect(version.webSocketDebuggerUrl);

  // 1. extension id from the throwaway profile
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    for (const file of ['Preferences', 'Secure Preferences']) {
      try {
        const prefs = JSON.parse(readFileSync(join(profile, 'Default', file), 'utf8'));
        for (const [id, v] of Object.entries(prefs.extensions?.settings || {})) {
          if (v.path && v.path.toLowerCase() === EXT.toLowerCase()) extId = id;
        }
      } catch {}
      if (extId) break;
    }
    if (!extId) await sleep(400);
  }
  if (!extId) throw new Error('extension not registered in profile (load error?)');
  check('extension loads', true, extId);

  // 2. opening the popup starts the MV3 service worker
  await call(ws, 'Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  await sleep(1200);
  const { targetInfos } = await call(ws, 'Target.getTargets');
  const swInfo = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (!swInfo) throw new Error('service worker did not start');
  const { sessionId: swSession } = await call(ws, 'Target.attachToTarget', { targetId: swInfo.targetId, flatten: true });
  await call(ws, 'Runtime.enable', {}, swSession);
  check('service worker starts', true);

  // 2b. offscreen document must expose the in-browser engine
  const { targetId: offTarget } = await call(ws, 'Target.createTarget', { url: `chrome-extension://${extId}/offscreen.html` });
  const { sessionId: offSession } = await call(ws, 'Target.attachToTarget', { targetId: offTarget, flatten: true });
  await call(ws, 'Runtime.enable', {}, offSession);
  await sleep(1200);
  const engineProbe = await evaluate(ws, offSession, 'JSON.stringify({engine: typeof JLSEngine, init: typeof (window.JLSEngine && JLSEngine.init)})', false);
  check('offscreen exposes in-browser engine', String(engineProbe).includes('"engine":"object"'), engineProbe);

  // 2c. optional: let the offscreen page download + init the real model
  if (argv.includes('--engine')) {
    const initRes = await evaluate(
      ws,
      offSession,
      `(async () => {
        window.__eng = { events: [] };
        await JLSEngine.init({ target: 'zh', apiKey: 'test-key', onEvent: (e) => window.__eng.events.push(e) });
        const t0 = Date.now();
        while (!window.__eng.events.some((e) => e.type === 'ready') && Date.now() - t0 < 240000) {
          await new Promise((r) => setTimeout(r, 500));
        }
        const ready = window.__eng.events.find((e) => e.type === 'ready');
        const err = window.__eng.events.find((e) => e.type === 'error');
        return JSON.stringify({ ready: !!ready, initMs: ready && ready.initMs, error: err && err.message, tail: window.__eng.events.slice(-3) });
      })()`
    ).catch((e) => 'ERR ' + e.message);
    check('in-extension engine loads model from HF', String(initRes).includes('"ready":true'), String(initRes).slice(0, 200));
  }

  // 3. content script on a normal page
  const { targetId: pageTarget } = await call(ws, 'Target.createTarget', { url: PAGE });
  const { sessionId: pageSession } = await call(ws, 'Target.attachToTarget', { targetId: pageTarget, flatten: true });
  await call(ws, 'Runtime.enable', {}, pageSession);
  await sleep(2000);

  const tabsJson = await evaluate(ws, swSession, `chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({id: t.id, url: t.url}))))`);
  const tabs = JSON.parse(tabsJson);
  const tab = tabs.find((t) => (t.url || '').includes('test-player.html'));
  if (!tab) throw new Error('test tab not found: ' + tabsJson);

  const pong = await evaluate(
    ws,
    swSession,
    `chrome.tabs.sendMessage(${tab.id}, {type: 'jls:ping'}).then(r => JSON.stringify(r)).catch(e => 'ERR ' + e.message)`
  );
  check('content script reachable (ping)', String(pong).includes('"ok":true'), String(pong));

  // 4. background -> content relay paints the overlay
  await evaluate(
    ws,
    swSession,
    `(async () => {
      const events = [
        {type:'speech_start', id: 7},
        {type:'partial', id: 7, text: '今日は東京の天気について', t: 1.2},
        {type:'final', id: 7, text: '今日は東京の天気についてお話しします。', decode_ms: 80},
        {type:'translation', id: 7, final: true, text: '今天来讲讲东京的天气。', engine: 'deepseek', ms: 640}
      ];
      for (const e of events) await chrome.tabs.sendMessage(${tab.id}, {type:'jls:event', event: e});
      return 'sent';
    })()`
  );
  await sleep(500);
  const overlayRaw = await evaluate(
    ws,
    pageSession,
    `(() => { const r = document.getElementById('ja-live-subs-host')?.shadowRoot; if (!r) return 'none'; const cur = r.querySelector('.rows .row[data-id="7"]'); return JSON.stringify({ja: cur?.querySelector('.ja')?.textContent || '', zh: cur?.querySelector('.zh')?.textContent || '', visible: !r.querySelector('.wrap').classList.contains('hidden')}); })()`,
    false
  );
  const overlay = overlayRaw === 'none' ? { ja: '', zh: '', visible: false } : JSON.parse(overlayRaw);
  check('overlay shows bilingual captions', overlay.ja.includes('東京') && overlay.zh.includes('天气') && overlay.visible, JSON.stringify(overlay));

  // 5. start() without a real toolbar click must fail with a readable message
  const startErr = await evaluate(
    ws,
    swSession,
    `start({tabId:${tab.id},target:'zh'}).then(r => JSON.stringify(r)).catch(e => 'THROW ' + e.message)`
  );
  check('start() reports capture permission error clearly', /ok":false|THROW/.test(String(startErr)), String(startErr).slice(0, 160));

  // 6. optional: try a real capture through chrome.action.openPopup()
  if (argv.includes('--capture')) {
    const opened = await evaluate(ws, swSession, `chrome.action.openPopup().then(() => 'opened').catch(e => 'ERR ' + e.message)`);
    console.log('openPopup:', opened);
    await sleep(1200);
    const { targetInfos: after } = await call(ws, 'Target.getTargets');
    const popupTarget = after.find((t) => t.type !== 'service_worker' && t.url.includes('popup.html'));
    let streamId = null;
    if (popupTarget) {
      const { sessionId: popSession } = await call(ws, 'Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
      await call(ws, 'Runtime.enable', {}, popSession);
      streamId = await evaluate(
        ws,
        popSession,
        `chrome.tabCapture.getMediaStreamId({ targetTabId: ${tab.id} }).then(id => id).catch(e => 'ERR ' + e.message)`
      ).catch((e) => 'ERR ' + e.message);
      console.log('capture grant received:', Boolean(streamId && !String(streamId).startsWith('ERR')));
    } else {
      console.log('popup target not found; targets:', after.map((t) => t.type + ':' + t.url.slice(0, 60)).join(' | '));
    }
    if (streamId && !String(streamId).startsWith('ERR')) {
      const started = await evaluate(
        ws,
        swSession,
        `start({tabId:${tab.id},target:'zh',streamId:${JSON.stringify(streamId)}}).then(r => JSON.stringify(r)).catch(e => 'THROW ' + e.message)`
      );
      console.log('start():', started);
      const t0 = Date.now();
      let got = 0;
      while (Date.now() - t0 < 15000) {
        await sleep(700);
        const raw = await evaluate(ws, pageSession, `(() => { const r = document.getElementById('ja-live-subs-host')?.shadowRoot; const row = r?.querySelector('.rows .row'); return JSON.stringify({ja: row?.querySelector('.ja')?.textContent, zh: row?.querySelector('.zh')?.textContent}); })()`, false);
        if (raw && raw !== 'none') {
          const o = JSON.parse(raw);
          if (o.ja) {
            got++;
            console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${o.ja} -> ${o.zh}`);
          }
        }
      }
      check('live tab capture produces captions', got >= 2, got + ' updates');
    } else {
      check('live tab capture produces captions', false, 'toolbar tabCapture permission unavailable');
    }
  }
  const pass = results.every((r) => r.ok);
  console.log(`\n${pass ? 'RESULT: PASS' : 'RESULT: FAIL'}  (${results.filter((r) => r.ok).length}/${results.length})`);
  if (!pass) process.exitCode = 1;
  if (logs.length) {
    console.log('console:');
    for (const l of logs.slice(-10)) console.log('  ' + l);
  }
  ws.close();
} catch (e) {
  console.error('RESULT: FAIL', e.message);
  process.exitCode = 1;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  try {
    child.kill();
  } catch {}
  await sleep(700);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
