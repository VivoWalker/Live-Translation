/* Each asynchronous start owns its resources; stale starts cannot resume capture. */
'use strict';
let active = null;
let generation = 0;
const current = capture => active === capture && !capture.cancelled;
function report(capture, phase, message) {
  if (current(capture)) chrome.runtime.sendMessage({ type: 'jls:state', sessionId: capture.sessionId, phase, message }).catch(() => {});
}
function send(capture, event) {
  if (current(capture)) chrome.runtime.sendMessage({ type: 'jls:event', sessionId: capture.sessionId, event }).catch(() => {});
}
function check(capture) {
  if (!current(capture)) throw new DOMException('采集已取消', 'AbortError');
}
async function dispose(capture) {
  if (!capture || capture.cancelled) return;
  capture.cancelled = true;
  clearTimeout(capture.mediaTimer);
  clearInterval(capture.statsTimer);
  capture.cancelStart?.();
  capture.cancelConnect?.();
  if (capture.node) capture.node.port.onmessage = null;
  if (capture.engineStarted) JLSEngine.stop();
  capture.stream?.getTracks().forEach(track => track.stop());
  capture.ws?.close();
  capture.source?.disconnect();
  capture.node?.disconnect();
  capture.playbackSource?.disconnect();
  await Promise.allSettled([capture.ctx?.close(), capture.playCtx?.close()]);
}
async function stopInternal(sessionId) {
  if (sessionId && active?.sessionId !== sessionId) return;
  ++generation;
  const old = active;
  active = null;
  await dispose(old);
}
function connect(capture, url, target, token) {
  return new Promise((resolve, reject) => {
    const sock = capture.ws = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    let settled = false;
    const fail = error => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    };
    const timer = setTimeout(() => { fail(new Error('字幕服务连接或认证超时')); sock.close(); }, 5000);
    capture.cancelConnect = () => fail(new DOMException('采集已取消', 'AbortError'));
    sock.onopen = () => {
      if (!current(capture)) return sock.close();
      sock.send(JSON.stringify({ type: 'auth', token }));
      sock.send(JSON.stringify({ type: 'config', target }));
    };
    sock.onmessage = e => {
      if (!current(capture)) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ready' && !settled) {
        settled = true; clearTimeout(timer);
        report(capture, 'connected', '已连接字幕服务（' + msg.asr + ' / ' + msg.translator + '）');
        resolve();
      }
      send(capture, msg);
    };
    sock.onerror = () => fail(new Error('无法连接字幕服务'));
    sock.onclose = () => {
      fail(new Error('字幕服务连接已关闭，请检查访问令牌'));
      if (current(capture)) {
        report(capture, 'error', '字幕服务已断开，请检查访问令牌');
        stopInternal(capture.sessionId);
      }
    };
  });
}
async function start(msg) {
  const old = active;
  const capture = { id: ++generation, sessionId: msg.sessionId, cancelled: false, engineStarted: false };
  capture.cancelledPromise = new Promise((_, reject) => {
    capture.cancelStart = () => reject(new DOMException('采集已取消', 'AbortError'));
  });
  // Attach a handler before any asynchronous cleanup can cancel this start.
  capture.cancelledPromise.catch(() => {});
  active = capture;
  await dispose(old);
  check(capture);
  try {
    const media = navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } }, video: false,
    });
    // A late media result must always stop its own tracks, even after timeout.
    const guardedMedia = media.then(stream => {
      if (!current(capture)) { stream.getTracks().forEach(track => track.stop()); check(capture); }
      capture.stream = stream; // Publish ownership before another microtask can stop us.
      return stream;
    });
    const timeout = new Promise((_, reject) => {
      capture.mediaTimer = setTimeout(() => reject(new Error('标签页音频采集超时')), 15000);
    });
    await Promise.race([guardedMedia, timeout, capture.cancelledPromise]);
    clearTimeout(capture.mediaTimer);
    check(capture);
    capture.playCtx = new AudioContext();
    await capture.playCtx.resume(); check(capture);
    capture.playbackSource = capture.playCtx.createMediaStreamSource(capture.stream);
    capture.playbackSource.connect(capture.playCtx.destination);
    capture.ctx = new AudioContext({ sampleRate: 16000 });
    await capture.ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js')); check(capture);
    if (capture.ctx.state === 'suspended') { await capture.ctx.resume(); check(capture); }
    capture.source = capture.ctx.createMediaStreamSource(capture.stream);
    capture.node = new AudioWorkletNode(capture.ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    capture.source.connect(capture.node);
    if (msg.engine === 'server') {
      await connect(capture, msg.serverUrl || 'ws://127.0.0.1:8765/ws', msg.target || 'zh', msg.serverToken || '');
      check(capture);
      capture.node.port.onmessage = e => {
        if (current(capture) && capture.ws?.readyState === 1) capture.ws.send(e.data);
      };
    } else {
      capture.engineStarted = true;
      await Promise.race([JLSEngine.init({ target: msg.target || 'zh', apiKey: msg.apiKey || '', onEvent: event => {
        if (!current(capture)) return;
        if (event.type === 'progress') report(capture, 'starting', event.message);
        else send(capture, event);
      } }), capture.cancelledPromise]);
      check(capture);
      capture.node.port.onmessage = e => { if (current(capture)) JLSEngine.feed(e.data); };
    }
    report(capture, 'capturing', '正在接收页面声音');
    capture.statsTimer = setInterval(() => {
      if (!current(capture)) return;
      if (msg.engine === 'server' && capture.ws?.readyState === 1) capture.ws.send(JSON.stringify({ type: 'stats' }));
      else if (capture.engineStarted) send(capture, JLSEngine.stats());
    }, 3000);
    capture.stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (current(capture)) { report(capture, 'idle', '标签页声音已停止'); stopInternal(capture.sessionId); }
    });
  } catch (error) {
    if (current(capture)) {
      report(capture, 'error', error.message || String(error));
      send(capture, { type: 'error', scope: 'capture', message: error.message || String(error) });
      active = null;
    }
    await dispose(capture);
    throw error;
  }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js')) return false;
  if (msg.type === 'jls:offscreen-start') {
    start(msg).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'jls:offscreen-stop') {
    stopInternal(msg.sessionId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
