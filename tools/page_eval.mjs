/**
 * Minimal CDP helper: open a URL, wait, evaluate an expression, print the result.
 *
 *   node tools/page_eval.mjs --url http://127.0.0.1:8765/static/worklet-test.html --wait 4000 --expr "document.body.innerText"
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_ = arg('url', 'about:blank');
const WAIT = Number(arg('wait', '3000'));
const EXPR = arg('expr', 'document.body.innerText');
const HEADED = argv.includes('--headed');
const PORT = Number(arg('port', '9371'));
const CHROME = process.env.JLS_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'jls-page-'));
const args = [
  '--no-sandbox',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
];
if (!HEADED) args.unshift('--headless=new');
const child = spawn(CHROME, [...args, 'about:blank'], { stdio: 'ignore' });

let id = 0;
const pending = new Map();
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
  });
}
function call(ws, method, params = {}, sessionId) {
  const i = ++id;
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
    setTimeout(() => pending.has(i) && reject(new Error('timeout ' + method)), 20000);
  });
}

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      up = r.ok;
    } catch {}
    if (!up) await sleep(250);
  }
  const v = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  const ws = await connect(v.webSocketDebuggerUrl);
  const { targetId } = await call(ws, 'Target.createTarget', { url: URL_ });
  const { sessionId } = await call(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await call(ws, 'Runtime.enable', {}, sessionId);
  await call(ws, 'Log.enable', {}, sessionId);
  await sleep(WAIT);
  const r = await call(ws, 'Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) console.log('EVAL EXCEPTION:', (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 800));
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
  ws.close();
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  try {
    child.kill();
  } catch {}
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
