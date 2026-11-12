/* Offscreen document: tab audio -> 16 kHz PCM -> WebSocket -> subtitle events. */
'use strict';

let ctx = null;
let playCtx = null;
let playbackSource = null;
let node = null;
let source = null;
let stream = null;
let ws = null;
let worker = null;
let engineReady = false;
let stopping = false;
let statsTimer = null;

function report(phase, message) {
  chrome.runtime.sendMessage({ type: 'jls:state', phase, message }).catch(() => {});
  console.log('[jls offscreen]', phase, message || '');
}

function send(event) {
  chrome.runtime.sendMessage({ type: 'jls:event', event }).catch(() => {});
}

let counted = false;
function markCapturing() {
  if (counted) return;
  counted = true;
  report('capturing', '正在接收页面声音');
}

function connect(url, target) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('字幕服务连接超时'));
      }
    }, 5000);
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'config', target }));
    };
    sock.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (msg.type === 'ready') {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          report('connected', '已连接字幕服务（' + msg.translator + '）');
          resolve(msg);
        }
      }
      send(msg);
    };
    sock.onerror = () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('连接 ws://127.0.0.1:8765 失败，请先启动服务'));
      }
    };
    sock.onclose = () => {
      if (ws === sock && !stopping) {
        report('error', '字幕服务已断开');
        send({ type: 'error', scope: 'socket', message: '字幕服务已断开' });
      }
    };
    ws = sock;
  });
}

async function start(msg) {
  await stopInternal();
  stopping = false;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
      video: false,
    });
  } catch (e) {
    throw new Error('标签页音频采集失败：' + (e.message || e));
  }

  // Playback keeps the tab's native sample rate: routing it through the 16 kHz
  // ASR context would low-pass everything above 8 kHz (muffled, "weird" audio).
  playCtx = new AudioContext();
  await playCtx.resume();
  playbackSource = playCtx.createMediaStreamSource(stream);
  playbackSource.connect(playCtx.destination);

  // Recognition gets its own 16 kHz context and tap.
  ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
  if (ctx.state === 'suspended') await ctx.resume();

  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 0, // sink: processed without being wired to the speakers
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  source.connect(node);

  if (msg.engine === 'server') {
    node.port.onmessage = (e) => {
      if (ws && ws.readyState === 1) {
        ws.send(e.data);
        markCapturing();
      }
    };
    await connect(msg.serverUrl || 'ws://127.0.0.1:8765/ws', msg.target || 'zh');
    send({ type: 'status', state: 'listening' });
  } else {
    // Browser-only mode: SenseVoice (WASM) runs inside this extension page.
    node.port.onmessage = (e) => {
      if (!engineReady) return;
      JLSEngine.feed(e.data);
      markCapturing();
    };
    await JLSEngine.init({
      target: msg.target || 'zh',
      apiKey: msg.apiKey || '',
      onEvent: (ev) => {
        if (ev.type === 'progress') report('starting', ev.message);
        else if (ev.type === 'ready') report('capturing', '识别引擎就绪（浏览器内，' + ev.initMs + 'ms）');
        else send(ev);
      },
    });
    engineReady = true;
    report('capturing', '正在接收页面声音');
  }

  statsTimer = setInterval(() => {
    if (engineReady) send(JLSEngine.stats());
    else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stats' }));
  }, 3000);

  stream.getAudioTracks()[0].addEventListener('ended', () => {
    report('idle', '标签页声音已停止');
    stopInternal();
  });
}

async function stopInternal() {
  stopping = true;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  try {
    if (node) node.port.onmessage = null;
    if (worker) { worker.terminate(); worker = null; }
    if (engineReady) { try { JLSEngine.stop(); } catch (e) {} engineReady = false; }
    if (source) source.disconnect();
    if (node) node.disconnect();
    if (playbackSource) playbackSource.disconnect();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ws) ws.close();
    if (playCtx) await playCtx.close();
    if (ctx) await ctx.close();
  } catch (e) {
    console.log('[jls offscreen] stop error', e);
  }
  node = source = playbackSource = stream = ws = ctx = playCtx = null;
  counted = false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'jls:offscreen-start') {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('采集启动超时：页面没有声音，或采集权限被拒绝')), 7000)
    );
    Promise.race([start(msg), timeout])
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        const text = String(e && e.message ? e.message : e);
        report('error', text);
        send({ type: 'error', scope: 'capture', message: text });
        stopInternal();
        sendResponse({ ok: false, error: text });
      });
    return true;
  }
  if (msg.type === 'jls:offscreen-stop') {
    stopInternal().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
