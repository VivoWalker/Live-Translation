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
const PAGE_URL = getArg('url', 'http://127.0.0.1:8765/?autostart=file');
const SECONDS = Number(getArg('seconds', '16'));
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
    pending.set(id, { resolve, reject });
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout: ' + method));
      }
    }, 20000);
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
    source: `document.addEventListener('DOMContentLoaded', () => { document.getElementById('access-token').value = ${JSON.stringify(accessToken)}; });`,
  }, sessionId);
  await call(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await call(ws, 'Page.navigate', { url: PAGE_URL }, sessionId);
  await sleep(1500);

  const seen = [];
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
  console.log(`\ncaption updates observed: ${seen.length}`);
  console.log(seen.length >= 2 ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (seen.length < 2) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error('RESULT: FAIL', e.message);
  process.exitCode = 1;
} finally {
  try {
    child.kill();
  } catch {}
  await sleep(600);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
