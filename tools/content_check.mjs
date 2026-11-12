/**
 * Renders the extension's content script in a real Chrome page (chrome.runtime stubbed)
 * and asserts the bilingual overlay updates. Complements the tab-capture path that
 * headless Chrome cannot exercise.
 *
 *   node tools/content_check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.JLS_CDP_PORT || 9343);
const CHROME = process.env.JLS_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = readFileSync(resolve('extension/content.js'), 'utf8');
const PAGE = 'http://127.0.0.1:8765/';

const profile = mkdtempSync(join(tmpdir(), 'jls-content-'));
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let msgId = 0;
const pending = new Map();

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws error'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 300))) : p.resolve(m.result);
      }
    };
  });
}

function call(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => pending.has(id) && reject(new Error('timeout ' + method)), 15000);
  });
}

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools not up');
}

try {
  const version = await waitDevtools();
  const ws = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await call(ws, 'Target.createTarget', { url: PAGE });
  const { sessionId } = await call(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await call(ws, 'Runtime.enable', {}, sessionId);
  await sleep(1200);

  await call(
    ws,
    'Runtime.evaluate',
    {
      expression:
        'window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__jlsListener = fn; } } } }; "ok"',
      returnByValue: true,
    },
    sessionId
  );

  await call(ws, 'Runtime.evaluate', { expression: SRC, returnByValue: true }, sessionId);

  const dispatch = `
    (() => {
      if (!window.__jlsListener) return 'no-listener';
      const send = (m) => window.__jlsListener(m, {}, (resp) => { window.__resp = resp; });
      const out = {};
      send({ type: 'jls:ping' });
      out.pong = window.__resp && window.__resp.ok === true;
      send({ type: 'jls:toast', text: '字幕已开启，等待声音…' });
      const h0 = document.getElementById('ja-live-subs-host');
      out.pill = h0 && h0.shadowRoot.querySelector('.pill').textContent;

      // sentence 1 fully translated
      send({ type: 'jls:event', event: { type: 'speech_start', id: 1 } });
      send({ type: 'jls:event', event: { type: 'final', id: 1, text: '今日は東京の天気についてお話しします。', decode_ms: 80 } });
      send({ type: 'jls:event', event: { type: 'translation', id: 1, final: true, text: '今天来讲讲东京的天气。', engine: 'deepseek', ms: 640 } });

      // sentence 2 starts before its translation arrives
      send({ type: 'jls:event', event: { type: 'speech_start', id: 2 } });
      send({ type: 'jls:event', event: { type: 'partial', id: 2, text: '午後から雨が降るそうです', t: 3.1 } });
      send({ type: 'jls:event', event: { type: 'final', id: 2, text: '午後から雨が降るそうです。', decode_ms: 60 } });

      const hosts = document.querySelectorAll('#ja-live-subs-host').length;
      const h = document.getElementById('ja-live-subs-host');
      if (!h || !h.shadowRoot) return 'no-shadow';
      const r = h.shadowRoot;
      const cur = r.querySelector('.cur');
      const prev = r.querySelector('.prev');
      out.ja = cur.querySelector('.ja').textContent;
      out.zh = cur.querySelector('.zh').textContent;
      out.prevJa = prev.querySelector('.ja').textContent;
      out.prevZh = prev.querySelector('.zh').textContent;
      out.meta = r.querySelector('.meta').textContent;
      out.visible = !r.querySelector('.wrap').classList.contains('hidden');
      out.empty = r.querySelector('.wrap').classList.contains('empty');
      out.hosts = hosts;
      return JSON.stringify(out);
    })()
  `;  const r = await call(ws, 'Runtime.evaluate', { expression: dispatch, returnByValue: true }, sessionId);
  const raw = r.result.value;
  console.log('overlay:', raw);
  const out = JSON.parse(raw);
  const pass = out.ja.includes('雨') && out.prevZh.includes('天气') && out.visible && !out.empty && out.pong && out.hosts === 1 && String(out.pill).includes('字幕');
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (!pass) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error('RESULT: FAIL', e.message);
  process.exitCode = 1;
} finally {
  try {
    child.kill();
  } catch {}
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
