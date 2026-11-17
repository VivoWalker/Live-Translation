/** Real Chromium checks for caption reading, hover, settings and dragging.
 * JLS_CHROME=/usr/bin/chromium node tools/content_check.mjs --shot-dir /tmp/caption-ui
 * Uses a local fixture and stubbed extension messaging; no models/API keys needed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.JLS_CDP_PORT || 9343);
const CHROME = process.env.JLS_CHROME || '/usr/bin/chromium';
const SRC = ['caption-overlay.js', 'content.js'].map(name => readFileSync(resolve('extension', name), 'utf8')).join('\n');
const SHOTS = process.argv.includes('--shot-dir') ? process.argv[process.argv.indexOf('--shot-dir') + 1] : null;
const profile = mkdtempSync(join(tmpdir(), 'jls-content-'));
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}body{margin:0;background:#102530;color:#fff;font:16px system-ui}header{padding:28px 6vw;display:flex;justify-content:space-between;border-bottom:1px solid #ffffff15;letter-spacing:.08em}main{height:calc(100vh - 80px);position:relative;overflow:hidden;background:radial-gradient(ellipse at 68% 28%,#b7d0c5 0,transparent 40%),linear-gradient(160deg,#335e69 10%,#86a6a3 48%,#346478 49%,#203e47 83%)}.land{position:absolute;background:#193f3d;clip-path:polygon(0 100%,12% 57%,28% 72%,52% 10%,80% 50%,100% 38%,100% 100%);width:120%;height:56%;bottom:0;left:-10%}.land.far{background:#446b66;bottom:17%;opacity:.7;transform:scaleX(-1)}.label{position:absolute;top:12%;left:7%;font-size:12px;letter-spacing:.2em;color:#e1efe9}.label h1{font-weight:400;font-size:42px;letter-spacing:.03em;margin:14px 0}.label p{font-size:14px;letter-spacing:.03em;opacity:.75}.time{position:absolute;right:6%;bottom:10%;font:12px monospace;opacity:.7}
  </style></head><body><header><span>FIELD NOTES</span><span>01 / A QUIET AFTERNOON</span></header><main id="scene"><div class="land far"></div><div class="land"></div><div class="label">MOMENTS IN MOTION<h1>山の向こうへ。</h1><p>Slow down. There is a little more to see.</p></div><div class="time">04:28 / 18:42</div></main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PAGE = `http://127.0.0.1:${server.address().port}/`;
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let counter = 0, ws, sessionId;
const pending = new Map(), errors = [];
function call(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  let result;
  try { result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); }
  catch (error) { throw new Error(error.message + ': ' + expression.slice(0, 150)); }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function inject() {
  await evaluate(`window.chrome={runtime:{onMessage:{addListener:fn=>window.__jlsListener=fn},sendMessage:async msg=>{
    if(msg.type==='jls:caption-settings-get')return{settings:JSON.parse(localStorage.getItem('test-prefs')||'{}')};
    if(msg.type==='jls:caption-settings-set'){localStorage.setItem('test-prefs',JSON.stringify(msg.settings));return{ok:true}}}}};`);
  await evaluate(SRC);
  await evaluate(`window.cap=q=>document.getElementById('ja-live-subs-host').shadowRoot.querySelector(q);
    window.send=e=>window.__jlsListener({type:'jls:event',event:e},{},()=>{});
    window.final=(id,ja,zh)=>{send({type:'speech_start',id});send({type:'final',id,text:ja});send({type:'translation',id,text:zh,final:true,engine:'deepseek',ms:180})};`);
}
async function move(x, y) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
async function click(selector) {
  const rect = await evaluate(`(()=>{const r=cap(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await move(rect.x, rect.y);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
}
async function bounds() { return evaluate(`(()=>{const r=cap('.wrap').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`); }
const checks = [];
try {
  let version;
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (response.ok) { version = await response.json(); break; } } catch {}
    await sleep(150);
  }
  assert(version, 'Chromium devtools did not start');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  const { targetId } = await call('Target.createTarget', { url: PAGE }, null);
  ({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300); await inject();
  await evaluate(`final(1,'今日は、山の向こうにある小さな町まで歩いてみようと思います。','今天想慢慢走到山那边的小镇，沿途看看河流和树林，也给自己留一点不赶时间的余地。');
    final(2,'いいですね。','听起来很好。');final(3,'行きましょう。','那就出发吧。');`);
  await sleep(500);
  assert.equal(await evaluate(`cap('.rows').querySelectorAll('.row:not([aria-hidden])').length`), 2);
  assert(await evaluate(`cap('.rows').textContent.includes('不赶时间')`));
  assert.equal(await evaluate(`cap('.catch-up').hidden`), false);
  checks.push('long translation survives later short sentences; bounded visible rows and explicit catch-up');
  await shot('rest');
  const resting = await evaluate(`getComputedStyle(cap('.wrap')).backgroundColor`);
  let rect = await bounds(); await move(rect.x + rect.width / 2, rect.y + 20); await sleep(550);
  const active = await evaluate(`getComputedStyle(cap('.wrap')).backgroundColor`);
  assert.notEqual(resting, active);
  assert(active.includes('0.93'), active);
  assert.equal(await evaluate(`getComputedStyle(cap('.toolbar')).opacity`), '1');
  await click('.settings-toggle'); await sleep(320);
  assert.equal(await evaluate(`cap('.settings').hidden`), false);
  const panelBounds = await evaluate(`(()=>{const r=cap('.settings').getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()`);
  assert(panelBounds.top >= 0 && panelBounds.bottom <= 800 && panelBounds.left >= 0 && panelBounds.right <= 1280, JSON.stringify(panelBounds));
  const gap = await evaluate(`(()=>{const r=cap('.settings-bridge').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+2}})()`);
  await move(gap.x, gap.y); await sleep(250);
  assert.equal(await evaluate(`cap('.settings').hidden`), false, 'moving through the hover gap must not dismiss settings');
  await shot('settings');
  checks.push('hover strengthens only the background and reveals working style controls');
  await evaluate(`for(const[key,value]of Object.entries({fontSize:30,width:72,background:12,color:'#fff1ce'})){const el=cap('[data-setting="'+key+'"]');el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))}`);
  await sleep(400);
  assert.equal(await evaluate(`getComputedStyle(cap('.zh')).fontSize`), '27.6px');
  assert.equal(await evaluate(`cap('.wrap').classList.contains('dragging')`), false);
  await click('.settings-toggle');
  const handle = await evaluate(`(()=>{const r=cap('.drag').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await move(handle.x, handle.y);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
  await move(1, 1);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(300);
  rect = await bounds(); assert(rect.x >= 11 && rect.y >= 43, JSON.stringify(rect));
  assert.equal(await evaluate(`cap('.wrap').classList.contains('dragging')`), false);
  checks.push('dedicated pointer-captured drag handle clamps position and never captures settings input');
  await move(1250, 780); await sleep(800);
  assert.equal(await evaluate(`cap('.wrap').classList.contains('engaged')`), false);
  assert((await evaluate(`getComputedStyle(cap('.wrap')).backgroundColor`)).includes('0.12'));
  assert.equal(await evaluate(`getComputedStyle(cap('.zh')).opacity`), '1');
  checks.push('pointer exit closes controls, restores transparency and keeps translation text fully opaque');
  await sleep(200);
  await call('Page.reload'); await sleep(400); await inject();
  await evaluate(`final(10,'保存した設定を確認しています。','样式和位置已保留，重新打开页面后可以接着使用。')`); await sleep(300);
  assert.equal(await evaluate(`cap('.wrap').style.getPropertyValue('--font-size')`), '30px');
  assert.equal(await evaluate(`cap('.wrap').style.getPropertyValue('--caption-color')`), '#fff1ce');
  rect = await bounds(); assert(rect.x >= 11 && rect.y >= 43 && rect.right <= 1269, JSON.stringify(rect));
  checks.push('public style and normalized position preferences survive a fresh page');
  await evaluate(`cap('.drag').focus()`);
  const beforeKeyboard = await bounds();
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  rect = await bounds(); assert(rect.x >= beforeKeyboard.x + 5, JSON.stringify(rect));
  await evaluate(`cap('.settings-toggle').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(50);
  assert.equal(await evaluate(`cap('.settings').hidden`), false);
  await click('.reset');
  await move(1250, 20); await sleep(700);
  await evaluate(`final(20,'明るい背景でも字幕が読みやすいか確認しています。','即使画面变亮，也会保留清晰的文字轮廓与阴影，让字幕尽量少遮挡画面，同时留出读完长句的时间。');document.getElementById('scene').style.background='#fafaf8';document.querySelectorAll('.land').forEach(el=>el.style.display='none')`);
  await sleep(500);
  assert.notEqual(await evaluate(`getComputedStyle(cap('.zh')).textShadow`), 'none');
  assert.equal(await evaluate(`getComputedStyle(cap('.zh')).opacity`), '1');
  await shot('bright');
  checks.push('keyboard controls and reset work; bright backgrounds retain full-opacity text with shadows');
  rect = await bounds(); await move(rect.x + 30, rect.y + 20); await sleep(250);
  const cancelHandle = await evaluate(`(()=>{const r=cap('.drag').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await move(cancelHandle.x, cancelHandle.y);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...cancelHandle, button: 'left', clickCount: 1 });
  assert.equal(await evaluate(`cap('.wrap').classList.contains('dragging')`), true);
  await evaluate(`cap('.drag').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))`);
  assert.equal(await evaluate(`cap('.wrap').classList.contains('dragging')`), false);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...cancelHandle, button: 'left', clickCount: 1 });
  checks.push('cancelled pointer capture releases dragging without sticking');
  await evaluate(`document.getElementById('scene').style.background='';document.querySelectorAll('.land').forEach(el=>el.style.display='')`);
  for (const [width, height] of [[768, 600], [390, 740]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(180);
    rect = await bounds(); assert(rect.x >= 0 && rect.right <= width && rect.y >= 0 && rect.bottom <= height, JSON.stringify(rect));
  }
  await move(200, 100); await sleep(200); await shot('mobile');
  rect = await bounds(); await move(rect.x + 25, rect.y + 25); await sleep(250); await click('.settings-toggle');
  const narrowPanel = await evaluate(`(()=>{const r=cap('.settings').getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()`);
  assert(narrowPanel.x >= 0 && narrowPanel.right <= 390 && narrowPanel.y >= 0 && narrowPanel.bottom <= 740, JSON.stringify(narrowPanel));
  checks.push('tablet and narrow viewport resizing keeps the panel inside the viewport');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(50);
  await evaluate(`final(11,'動きを減らす設定です。','尊重系统的减少动态效果设置。')`);
  assert.equal(await evaluate(`cap('.wrap').getAnimations({subtree:true}).length`), 0);
  checks.push('reduced-motion preference disables transitions and entry/exit animations');
  // Headless Chromium may leave requestFullscreen pending. Exercise the DOM
  // event contract directly without claiming a native fullscreen transition.
  await evaluate(`Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>document.getElementById('scene')});document.dispatchEvent(new Event('fullscreenchange'))`);
  assert.equal(await evaluate(`document.getElementById('ja-live-subs-host').parentNode===document.fullscreenElement`), true);
  await evaluate(`delete document.fullscreenElement;document.dispatchEvent(new Event('fullscreenchange'))`);
  assert.equal(await evaluate(`document.getElementById('ja-live-subs-host').parentNode===document.body`), true);
  checks.push('fullscreen DOM events reattach the same overlay without losing reading state');
  await evaluate(`window.__jlsListener({type:'jls:clear'},{},()=>{})`);
  assert.equal(await evaluate(`cap('.wrap').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`cap('.rows').children.length`), 0);
  await evaluate(SRC);
  assert.equal(await evaluate(`document.querySelectorAll('#ja-live-subs-host').length`), 1);
  checks.push('stop clears retained rows and repeated injection does not duplicate the overlay');
  assert.deepEqual(errors, []);
  for (const check of checks) console.log('PASS:', check);
  console.log('RESULT: PASS');
} catch (error) { for (const check of checks) console.log('PASS:', check); console.error('RESULT: FAIL', error.stack || error); process.exitCode = 1; }
finally {
  ws?.close(); child.kill(); await new Promise(resolve => server.close(resolve));
  for (const item of pending.values()) clearTimeout(item.timer);
  await sleep(250); try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
