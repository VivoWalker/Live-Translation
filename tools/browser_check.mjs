/**
 * Browser-level smoke test for the demo page, driven over CDP (no extra deps).
 *
 *   node tools/browser_check.mjs --url "http://127.0.0.1:8765/?autostart=file" --seconds 16
 *
 * Launches a throwaway Chrome profile, plays the built-in Japanese clip through the
 * real AudioWorklet + WebSocket path, and prints what the caption overlay shows.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PAGE_URL = new URL(getArg('url', 'http://127.0.0.1:8765/?autostart=file'));
if (!['http:', 'https:'].includes(PAGE_URL.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(PAGE_URL.hostname)
    || PAGE_URL.username || PAGE_URL.password) throw new Error('Use a loopback demo URL without credentials');
const SECONDS = Number(getArg('seconds', '16'));
const SWITCH_LANGUAGE = argv.includes('--switch-language');
const RESTART = argv.includes('--restart');
const PORT = Number(getArg('port', '9337'));
const CHROME = process.env.JLS_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'jls-chrome-'));
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
child.on('error', (e) => console.error('spawn error', e));

async function waitForDevtools(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools endpoint did not come up');
}

let msgId = 0;
const pending = new Map();
const logs = [];

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = () => reject(new Error('ws closed before open'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 300)));
        else p.resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        logs.push('exception: ' + (d.exception?.description || d.text));
      }
    };
  });
}

function call(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout: ' + method));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(payload));
  });
}

async function evaluate(ws, sessionId, expression) {
  const r = await call(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r?.result?.value;
}

try {
  const version = await waitForDevtools();
  const ws = await connect(version.webSocketDebuggerUrl);

  const { targetId } = await call(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await call(ws, 'Runtime.enable', {}, sessionId);
  await call(ws, 'Page.enable', {}, sessionId);
  const accessToken = process.env.JLSUBS_ACCESS_TOKEN;
  if (!accessToken) throw new Error('Set JLSUBS_ACCESS_TOKEN for the authenticated service');
  await call(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('DOMContentLoaded', () => {
      if (location.origin === ${JSON.stringify(PAGE_URL.origin)}) document.getElementById('access-token').value = ${JSON.stringify(accessToken)};
    });`,
  }, sessionId);
  await call(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await call(ws, 'Page.navigate', { url: PAGE_URL.href }, sessionId);
  await sleep(1500);

  const seen = [];
  let translated = false;
  const t0 = Date.now();
  let lastLine = '';
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(400);
    const raw = await evaluate(
      ws,
      sessionId,
      'JSON.stringify({cap: window.__jls ? window.__jls.captionText : null, st: window.__jls ? window.__jls.state : null})'
    );
    if (!raw) continue;
    const { cap, st } = JSON.parse(raw);
    if (cap && cap.ja) {
      translated ||= Boolean(cap.zh);
      const line = `${cap.ja} || ${cap.zh} || ${cap.meta}`;
      if (line !== lastLine) {
        lastLine = line;
        seen.push(line);
        const at = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[${at}s] ${cap.ja}  ->  ${cap.zh}   (${cap.meta})`);
      }
    }
  }

  const finalState = await evaluate(ws, sessionId, 'JSON.stringify(window.__jls ? window.__jls.state : {})');
  console.log('\nstate:', finalState);
  let switched = !SWITCH_LANGUAGE;
  if (SWITCH_LANGUAGE) {
    await evaluate(ws, sessionId, `(() => {
      const target = document.querySelector('#target');
      target.value = 'en';
      target.dispatchEvent(new Event('change'));
    })()`);
    for (let attempt = 0; attempt < 35 && !switched; attempt++) {
      await sleep(400);
      switched = await evaluate(ws, sessionId, "window.__jls.captionText.zh?.startsWith('[en] ') || false");
    }
    console.log('mock language switch:', switched);
  }

  const shot = getArg('shot', '');
  if (shot) {
    // wait for a final line that already has a translation
    for (let i = 0; i < 40; i++) {
      const raw = await evaluate(ws, sessionId, 'JSON.stringify(window.__jls ? window.__jls.captionText : {})');
      const c = JSON.parse(raw || '{}');
      if (c.zh && c.zh.length > 2 && c.prevZh && c.prevZh.length > 2) break;
      await sleep(250);
    }
    const { data } = await call(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(shot, Buffer.from(data, 'base64'));
    console.log('screenshot:', shot);
  }
  if (logs.length) {
    console.log('console:');
    for (const l of logs.slice(-20)) console.log('  ' + l);
  }
  const stopped = await evaluate(ws, sessionId, 'window.__jls.stop(); !window.__jls.state.capturing');
  let restarted = !RESTART;
  if (RESTART && stopped) {
    const clear = await evaluate(ws, sessionId, '!(window.__jls.captionText.ja || window.__jls.captionText.zh)');
    if (clear) {
      await evaluate(ws, sessionId, "void window.__jls.start('file')");
      const expected = SWITCH_LANGUAGE ? '[en] ' : '[zh] ';
      for (let attempt = 0; attempt < 30 && !restarted; attempt++) {
        await sleep(300);
        restarted = await evaluate(ws, sessionId,
          `window.__jls.state.capturing && !!window.__jls.captionText.zh?.startsWith(${JSON.stringify(expected)})`);
      }
    }
    await evaluate(ws, sessionId, 'window.__jls.stop()');
    console.log('fresh session received subtitles:', restarted);
  }
  console.log(`\ncaption updates observed: ${seen.length}, translated: ${translated}, stopped: ${stopped}`);
  const pass = seen.length >= 2 && translated && switched && stopped && restarted;
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (!pass) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error('RESULT: FAIL', e.message);
  process.exitCode = 1;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  try {
    child.kill();
  } catch {}
  await sleep(600);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
