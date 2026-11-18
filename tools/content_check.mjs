/** Real Chromium checks for caption reading, hover, settings and dragging.
 * JLS_CHROME=/usr/bin/chromium node tools/content_check.mjs --shot-dir /tmp/caption-ui
 * Uses a local fixture and stubbed extension messaging; no models/API keys needed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.JLS_CDP_PORT || 9343);
const CHROME = process.env.JLS_CHROME || '/usr/bin/chromium';
const SRC = ['caption-settings.js', 'caption-overlay.js', 'content.js'].map(name => readFileSync(resolve('extension', name), 'utf8')).join('\n');
const SHOTS = process.argv.includes('--shot-dir') ? process.argv[process.argv.indexOf('--shot-dir') + 1] : null;
const STRESS = process.argv.includes('--stress');
const RESTART = process.argv.includes('--wasm');
const restartCycles = process.argv.includes('--wasm-cycles') ? Number(process.argv[process.argv.indexOf('--wasm-cycles') + 1]) : 24;
assert(Number.isInteger(restartCycles) && restartCycles >= 2 && restartCycles <= 1000, '--wasm-cycles must be between 2 and 1000');
const CONTINUOUS = process.argv.includes('--continuous');
const WASM = RESTART || CONTINUOUS;
const REPORT = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
const metrics = { ui: [], wasm: [], continuous: [] };
const modelRoot = existsSync(resolve('models/sensevoice-onnx/model.int8.onnx')) ? resolve('models')
  : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'speech-to-text/sensevoice/models');
const files = new Map([
  ['/ext-assets/asr-engine.js', resolve('extension/asr-engine.js')],
  ['/ext-assets/asr-domain.js', resolve('extension/asr-domain.js')],
  ['/ext-assets/asr-terms.json', resolve('extension/asr-terms.json')],
  ['/models/model.int8.onnx', join(modelRoot, 'sensevoice-onnx/model.int8.onnx')],
  ['/models/tokens.txt', join(modelRoot, 'sensevoice-onnx/tokens.txt')],
  ['/models/silero_vad.onnx', join(modelRoot, 'silero/silero_vad.onnx')],
  ['/sample-ja.wav', resolve('web/static/sample-ja.wav')],
  ...['sherpa-onnx-asr.js', 'sherpa-onnx-vad.js', 'sherpa-onnx-wasm-main-vad-asr.js', 'sherpa-onnx-wasm-main-vad-asr.wasm']
    .map(name => ['/ext-assets/wasm/' + name, resolve('extension/wasm', name)]),
]);
if (WASM) for (const file of files.values()) assert(existsSync(file), 'Missing real-model fixture: ' + file);
const popupFiles = new Set(['popup.html', 'popup.css', 'interface.css', 'caption-settings.js', 'popup.js']);
const profile = mkdtempSync(join(tmpdir(), 'jls-content-'));
const server = createServer((req, res) => {
  const popupFile = req.url.startsWith('/popup/') && req.url.slice('/popup/'.length);
  if (popupFiles.has(popupFile)) {
    const type = popupFile.endsWith('.css') ? 'text/css' : popupFile.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(readFileSync(resolve('extension', popupFile)));
    return;
  }
  if (WASM && files.has(req.url)) {
    const file = files.get(req.url);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', 'Content-Length': statSync(file).size });
    createReadStream(file).on('error', error => res.destroy(error)).pipe(res);
    return;
  }
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
function call(method, params = {}, session = sessionId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression, timeout = 15000) {
  let result;
  try { result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId, timeout); }
  catch (error) { throw new Error(error.message + ': ' + expression.slice(0, 150)); }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function inject() {
  await evaluate(`window.chrome={runtime:{getURL:path=>location.origin+'/ext-assets/'+path,onMessage:{addListener:fn=>window.__jlsListener=fn},sendMessage:async msg=>{
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
async function memorySnapshot(label) {
  await sleep(500);
  await call('HeapProfiler.collectGarbage');
  const heap = await call('Runtime.getHeapUsage');
  return { label, heapBytes: heap.usedSize, backingBytes: heap.backingStorageSize, ...await call('Memory.getDOMCounters') };
}
async function checkPopupSizing() {
  const stub = await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.chrome = {
    tabs: { query: async () => [{ id: 1, title: '字幕弹窗尺寸测试', url: 'https://example.invalid' }] },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ running: false }) },
  };` });
  try {
    for (const scale of [1, 1.5]) {
      // A toolbar popup initially gets a small viewport from Chrome. Its
      // contents must request their full width before the bubble can expand.
      await call('Emulation.setDeviceMetricsOverride', { width: 152, height: 224, deviceScaleFactor: scale, mobile: false });
      await call('Page.navigate', { url: PAGE + 'popup/popup.html' });
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await evaluate(`document.querySelector('#tab-title')?.textContent === '字幕弹窗尺寸测试'`)) break;
        await sleep(50);
      }
      const width = await evaluate('document.documentElement.scrollWidth');
      assert(width >= 380 && width <= 420, 'popup must request its width from the initial viewport, got ' + width);
      await call('Emulation.setDeviceMetricsOverride', { width, height: 580, deviceScaleFactor: scale, mobile: false });
      const layout = await evaluate(`(() => {
        const heading = document.querySelector('.popup-header h1');
        document.querySelector('#caption-tab').click();
        return { headingHeight: heading.offsetHeight, footerBottom: document.querySelector('#start').getBoundingClientRect().bottom,
          scrollbar: document.documentElement.scrollWidth - innerWidth, hasEditor: !!document.querySelector('[data-setting="fontSize"]') };
      })()`);
      assert(layout.headingHeight <= 36 && layout.footerBottom <= 580 && layout.scrollbar === 0 && layout.hasEditor,
        JSON.stringify(layout));
    }
    await shot('popup');
  } finally {
    await call('Page.removeScriptToEvaluateOnNewDocument', stub);
  }
  checks.push('popup requests its full width from a small initial viewport at 1× and 1.5× and keeps its footer visible');
}
async function stressCaptions() {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await evaluate(`window.__captionStress=async count=>{
    let overlay, maxRows=0;
    for(let i=0;i<count;i++){
      if(i%100===0){overlay?.destroy();overlay=JLS.createCaptionOverlay({hostId:'jls-stress',loadSettings:async()=>({}),saveSettings:()=>{}})}
      const id=i;overlay.start(id);overlay.text(id,'partial','正在识别的日语 '+i);overlay.text(id,'final','これは長時間動作の確認です。'+i);
      overlay.translation(id,'内存压测译文，重复验证显示、排队和动画资源的释放。'.repeat(i%4+1),true);
      if(i%25===24)overlay.root.querySelector('.catch-up').click();
      maxRows=Math.max(maxRows,overlay.root.querySelectorAll('.row').length);
      if(i%20===19)await new Promise(r=>setTimeout(r,16));
    }
    overlay.clear();overlay.destroy();return maxRows;
  }`);
  await evaluate('__captionStress(400)', 120000);
  metrics.ui.push(await memorySnapshot('warm'));
  for (let round = 1; round <= 5; round++) {
    const maxAnimatedRows = await evaluate('__captionStress(2000)', 120000);
    const point = { ...await memorySnapshot('captions-' + round * 2000), maxAnimatedRows };
    metrics.ui.push(point);
    console.log('caption memory:', JSON.stringify(point));
  }
  const baseline = metrics.ui[0], last = metrics.ui.at(-1);
  assert(last.heapBytes - baseline.heapBytes < 2 * 1024 * 1024, 'caption heap keeps growing after collection');
  assert(last.nodes <= baseline.nodes + 8, 'caption DOM nodes were retained after destroy');
  assert(last.jsEventListeners <= baseline.jsEventListeners + 2, 'caption event listeners were retained');
  await evaluate('delete window.__captionStress');
  checks.push('10,000 caption updates and 100 destroy/recreate cycles retain bounded heap, DOM and listeners');
}
async function stressRealWasm() {
  console.log('WASM memory: loading verified local models');
  await evaluate(`(async()=>{window.__realFetch=window.fetch.bind(window);window.__liveBlobURLs=new Set();
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);__liveBlobURLs.add(url);return url};
    URL.revokeObjectURL=url=>{__liveBlobURLs.delete(url);revoke(url)};
    window.fetch=(input,init)=>{const url=String(input);
      if(url==='https://api.deepseek.com/chat/completions')return Promise.resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'本地翻译样本'}}]}),{headers:{'Content-Type':'application/json'}}));
      if(url.startsWith('https://huggingface.co/')&&url.endsWith('/model.int8.onnx'))return __realFetch('/models/model.int8.onnx');
      if(url.startsWith('https://huggingface.co/')&&url.endsWith('/tokens.txt'))return __realFetch('/models/tokens.txt');
      if(url.startsWith('https://github.com/')&&url.endsWith('/silero_vad.onnx'))return __realFetch('/models/silero_vad.onnx');
      return __realFetch(input,init)};
    window.__engineCounts={finals:0,translations:0};
    await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/ext-assets/asr-engine.js';s.onload=resolve;s.onerror=reject;document.head.append(s)});
    const wav=new DataView(await(await __realFetch('/sample-ja.wav')).arrayBuffer());let offset=12,dataOffset=0,dataSize=0;
    while(offset+8<=wav.byteLength){const name=String.fromCharCode(...[0,1,2,3].map(i=>wav.getUint8(offset+i)));const size=wav.getUint32(offset+4,true);if(name==='data'){dataOffset=offset+8;dataSize=size;break}offset+=8+size+(size%2)}
    window.__audio=new Float32Array(dataSize/2);for(let i=0;i<__audio.length;i++)__audio[i]=wav.getInt16(dataOffset+i*2,true)/32768;
    window.__startRealEngine=async()=>{__engineCounts={finals:0,translations:0};await JLSEngine.init({apiKey:'sk-local-fixture',onEvent:event=>{if(event.type==='final')__engineCounts.finals++;if(event.type==='translation')__engineCounts.translations++}})};
    window.__realEngineCycle=async(restart=true)=>{
      if(restart)await __startRealEngine();
      for(let i=0;i<__audio.length;i+=1600)JLSEngine.feed(__audio.slice(i,i+1600));
      for(let i=0;i<16;i++)JLSEngine.feed(new Float32Array(1600));
      await new Promise(r=>setTimeout(r,50));const stats=JLSEngine.stats();if(restart)JLSEngine.stop();
      return{...__engineCounts,audioSeconds:stats.audio_seconds,decodes:stats.decodes,wasmBytes:Module.HEAPU8.byteLength,blobURLs:__liveBlobURLs.size,loaderScripts:document.scripts.length};
    }})()`, 120000);
  for (let cycle = 0; cycle < (RESTART ? restartCycles : 0); cycle++) {
    const result = await evaluate('__realEngineCycle()', 120000);
    assert(result.finals > 0 && result.translations === result.finals, 'real WASM did not complete audio/translation');
    assert.equal(result.blobURLs, 0, 'model object URL remains registered');
    const point = { cycle, ...result, ...await memorySnapshot('wasm-' + cycle) };
    metrics.wasm.push(point);
    console.log('WASM memory:', JSON.stringify(point));
  }
  // The linear memory never shrinks and ORT may expand its arena after a larger
  // decode window. Check a sustained tail after repeated identical audio cycles.
  if (RESTART) {
    const settled = metrics.wasm.slice(-8), first = settled[0], last = settled.at(-1);
    assert(last.wasmBytes - first.wasmBytes <= 32 * 1024 * 1024, 'native WASM allocations continue growing after warmup');
    assert(last.heapBytes - first.heapBytes <= 2 * 1024 * 1024, 'WASM wrapper heap continues growing');
    assert(last.nodes <= first.nodes + 8 && last.jsEventListeners <= first.jsEventListeners + 2, 'WASM loader DOM/listeners remain retained');
    checks.push(`real SenseVoice WASM completes ${restartCycles} start/decode/stop cycles with released model URLs and stable post-warmup memory`);
  }
  if (CONTINUOUS) {
    await evaluate('__startRealEngine()', 120000);
    for (let block = 0; block < 8; block++) {
      let result;
      for (let sample = 0; sample < 8; sample++) result = await evaluate('__realEngineCycle(false)', 120000);
      assert(result.translations === result.finals && result.finals > 0);
      assert.equal(result.blobURLs, 0);
      const point = { ...result, ...await memorySnapshot('continuous-' + (block + 1) * 8) };
      metrics.continuous.push(point);
      console.log('continuous memory:', JSON.stringify(point));
    }
    const first = metrics.continuous[2], last = metrics.continuous.at(-1);
    assert(last.heapBytes - first.heapBytes < 2 * 1024 * 1024, 'continuous capture heap keeps growing');
    assert(last.backingBytes - first.backingBytes < 2 * 1024 * 1024, 'PCM buffers keep growing');
    assert(last.wasmBytes - first.wasmBytes <= 32 * 1024 * 1024, 'continuous native allocations keep growing');
    assert.equal(last.nodes, first.nodes); assert.equal(last.jsEventListeners, first.jsEventListeners);
    await evaluate('JLSEngine.stop()');
    metrics.continuous.push(await memorySnapshot('continuous-stopped'));
    checks.push('one uninterrupted capture processes 64 audio samples with bounded PCM buffers and stable memory');
  }
}
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
  await checkPopupSizing();
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: PAGE });
  await sleep(300); await inject();
  await evaluate(`send({type:'partial',id:100,text:'今日は東京の天気について'});window.__sourceFont=getComputedStyle(cap('.live .ja')).fontSize;send({type:'final',id:100,text:'今日は東京の天気についてお話しします。'});
    window.__sourceRow=cap('.rows .row[data-id="100"]');window.__sourceJa=__sourceRow?.querySelector('.ja');
    send({type:'speech_start',id:101});send({type:'partial',id:101,text:'午後から雨が'});`);
  assert.equal(await evaluate(`__sourceJa?.textContent`), '今日は東京の天気についてお話しします。');
  assert.equal(await evaluate(`getComputedStyle(__sourceJa).fontSize===__sourceFont`), true);
  await sleep(350);
  assert.equal(await evaluate(`getComputedStyle(__sourceRow).opacity`), '1');
  const continuity = await evaluate(`(async()=>{const samples=[];send({type:'translation',id:100,final:true,text:'今天介绍东京的天气。'});
    for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);const r=cap('.wrap').getBoundingClientRect();samples.push({x:r.x,width:r.width,ja:__sourceJa.isConnected&&__sourceJa.textContent==='今日は東京の天気についてお話しします。',opacity:Number(getComputedStyle(__sourceRow).opacity)})}return samples})()`);
  assert(continuity.every(frame => frame.ja && frame.opacity === 1));
  assert(Math.max(...continuity.map(frame => frame.x)) - Math.min(...continuity.map(frame => frame.x)) < .1);
  assert(Math.max(...continuity.map(frame => frame.width)) - Math.min(...continuity.map(frame => frame.width)) < .1);
  assert.equal(await evaluate(`cap('.rows .row[data-id="100"]')===__sourceRow`), true);
  await evaluate(`window.__jlsListener({type:'jls:clear'},{},()=>{});delete window.__sourceRow;delete window.__sourceJa;delete window.__sourceFont`);
  checks.push('final Japanese stays in the same opaque row during delayed MT and the next speech start');
  await evaluate(`final(200,'長い字幕のスクロールを確認します。','长字幕滚动测试，文字宽度保持不变。'.repeat(70));`);
  await sleep(400);
  const reflow = await evaluate(`(async()=>{const out=[];send({type:'final',id:201,text:'次の短い句です。'});send({type:'translation',id:201,final:true,text:'下一句很短。'});
    for(let i=0;i<25;i++){await new Promise(requestAnimationFrame);const r=cap('.wrap').getBoundingClientRect();const rows=cap('.rows');out.push({x:r.x,width:r.width,content:rows.clientWidth,font:parseFloat(getComputedStyle(cap('.rows .zh')).fontSize),gutter:rows.offsetWidth-rows.clientWidth})}return out})()`);
  assert(reflow.every(frame => frame.font === 24 && frame.gutter === 0));
  for (const key of ['x', 'width', 'content']) assert(Math.max(...reflow.map(frame => frame[key])) - Math.min(...reflow.map(frame => frame[key])) < .1, key + ' moved during caption growth');
  assert(await evaluate(`cap('.rows').scrollHeight>cap('.rows').clientHeight`));
  const wheel = await evaluate(`(()=>{const r=cap('.rows').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+30}})()`);
  await move(wheel.x, wheel.y); await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheel, deltaY: 120, deltaX: 0 }); await sleep(120);
  assert(await evaluate(`cap('.rows').scrollTop>0`));
  await evaluate(`window.__jlsListener({type:'jls:clear'},{},()=>{})`); await move(1, 1);
  checks.push('row promotion and height animation preserve fixed text width without a scrollbar; wheel scrolling still works');
  const orderedText = '前一句译文比较长，需要足够的阅读时间。';
  await sleep(200);
  await evaluate(`final(300,'前の長い句です。',${JSON.stringify(orderedText)});final(301,'はい。','好。')`);
  const orderedDuration = await evaluate(`JLS.captionReadingTime(${JSON.stringify(orderedText)})`);
  await sleep(orderedDuration + 100);
  assert.equal(await evaluate(`!!cap('.rows .row[data-id="300"]:not([aria-hidden])')`), false);
  assert.equal(await evaluate(`!!cap('.rows .row[data-id="301"]:not([aria-hidden])')`), true);
  await sleep(650);
  assert.equal(await evaluate(`!!cap('.rows .row[data-id="301"]:not([aria-hidden])')`), false);
  await evaluate(`window.__jlsListener({type:'jls:clear'},{},()=>{})`);
  checks.push('the earlier long translation exits before the later short translation');
  await evaluate(`final(1,'今日は、山の向こうにある小さな町まで歩いてみようと思います。','今天想慢慢走到山那边的小镇，沿途看看河流和树林，也给自己留一点不赶时间的余地。');
    final(2,'いいですね。','听起来很好。');final(3,'行きましょう。','那就出发吧。');`);
  await sleep(500);
  assert.equal(await evaluate(`cap('.rows').querySelectorAll('.row:not([aria-hidden])').length`), 2);
  assert(await evaluate(`cap('.rows').textContent.includes('不赶时间')`));
  assert.equal(await evaluate(`cap('.catch-up').hidden`), false);
  checks.push('long translation survives later short sentences; bounded visible rows and explicit catch-up');
  await shot('rest');
  const resting = await evaluate(`getComputedStyle(cap('.wrap')).backgroundColor`);
  assert.equal(await evaluate(`getComputedStyle(cap('.wrap')).backdropFilter`), 'blur(2px)');
  let rect = await bounds(); await move(rect.x + rect.width / 2, rect.y + 20); await sleep(550);
  const active = await evaluate(`getComputedStyle(cap('.wrap')).backgroundColor`);
  assert.notEqual(resting, active);
  assert(active.includes('0.93'), active);
  assert.equal(await evaluate(`getComputedStyle(cap('.wrap')).backdropFilter`), 'blur(18px)');
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
  await evaluate(`(() => {
    const input = cap('[data-setting="blur"]');
    input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  assert.equal(await evaluate(`getComputedStyle(cap('.wrap')).backdropFilter`), 'none');
  assert.equal(await evaluate(`getComputedStyle(cap('.zh')).opacity`), '1');
  checks.push('background blur can be disabled without changing caption text opacity');
  await evaluate(`for(const[key,value]of Object.entries({fontSize:30,sourceSize:19,width:72,background:12,color:'#fff1ce'})){const el=cap('[data-setting="'+key+'"]');el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}`);
  await sleep(400);
  assert.equal(await evaluate(`getComputedStyle(cap('.zh')).fontSize`), '30px');
  assert.equal(await evaluate(`getComputedStyle(cap('.row .ja')).fontSize`), '19px');
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
  assert.equal(await evaluate(`cap('.wrap').style.getPropertyValue('--caption-blur')`), 'none');
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
  await evaluate(`final(21,'動きを減らす設定です。','尊重系统的减少动态效果设置。')`);
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
  if (STRESS) await stressCaptions();
  if (WASM) await stressRealWasm();
  assert.deepEqual(errors, []);
  if (REPORT) writeFileSync(REPORT, JSON.stringify(metrics, null, 2));
  for (const check of checks) console.log('PASS:', check);
  console.log('RESULT: PASS');
} catch (error) { if (REPORT) writeFileSync(REPORT, JSON.stringify(metrics, null, 2)); for (const check of checks) console.log('PASS:', check); console.error('RESULT: FAIL', error.stack || error); process.exitCode = 1; }
finally {
  ws?.close(); child.kill(); await new Promise(resolve => server.close(resolve));
  for (const item of pending.values()) clearTimeout(item.timer);
  await sleep(250); try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
