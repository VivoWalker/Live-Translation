/* Each asynchronous start owns its resources; stale starts cannot resume capture. */
'use strict';
let active = null;
let generation = 0;
const SOCKET_WARN_BYTES = 64 * 1024, SOCKET_LIMIT_BYTES = 128 * 1024;
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
function failCapture(capture, message) {
  if (!current(capture)) return;
  report(capture, 'error', message);
  stopInternal(capture.sessionId);
}
function domainNotice(domain) {
  const messages = {
    unmatched: '未识别节目，已保留原文',
    ambiguous: '标题包含多个企划，已保留原文',
    manual_fallback: '未确定节目，使用自选词库',
    general_fallback: '未确定节目，使用保守直播词库',
  };
  return Object.hasOwn(messages, domain?.match) ? messages[domain.match] : '';
}
function captureNotice(capture) {
  return [capture.notice, capture.domainNotice].filter(Boolean).join('。');
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
function connect(capture, url, target, token, settings) {
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
      sock.send(JSON.stringify({ type: 'config', target, ...settings }));
    };
    sock.onmessage = e => {
      if (!current(capture)) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ready' && !settled) {
        settled = true; clearTimeout(timer);
        const name = String(msg.asr || '').slice(0, 80);
        const modeMismatch = settings.mode && msg.asr_mode && settings.mode !== msg.asr_mode;
        const defaultMessage = name ? '本地识别模型 ' + name : '';
        capture.notice = msg.asr_fallback_from ? '服务已回退到 ' + name
          : modeMismatch ? (msg.asr_mode === 'fast' ? '服务当前提供本地快速模式' : '服务当前提供本地增强模式') + '（' + name + '）'
            : defaultMessage;
        if (settings.agent && !msg.agent?.enabled) capture.notice += '。服务未启用 Agent 复查';
        report(capture, 'connected', '已连接字幕服务（' + msg.asr + ' / ' + msg.translator + '）');
        resolve();
      }
      if (msg.type === 'stats') msg.client_buffered_bytes = sock.bufferedAmount || 0;
      if (msg.type === 'config' && msg.domain) {
        capture.domainNotice = domainNotice(msg.domain);
        if (capture.capturing && !capture.congested) report(capture, 'capturing', captureNotice(capture));
      }
      send(capture, msg);
    };
    sock.onerror = () => fail(new Error('无法连接字幕服务'));
    sock.onclose = event => {
      const message = event?.code === 1013 ? '字幕服务积压，请重新开始字幕'
        : event?.code === 1011 ? '字幕服务处理失败，请检查本地模型'
          : event?.code === 1008 ? '字幕服务拒绝连接，请检查访问令牌或请求限制' : '字幕服务已断开';
      fail(new Error(message));
      failCapture(capture, message);
    };
  });
}
async function start(msg) {
  const old = active;
  const capture = { id: ++generation, sessionId: msg.sessionId, cancelled: false, engineStarted: false };
  const local = msg.engine === 'server' || msg.engine === 'server-enhanced';
  capture.cancelledPromise = new Promise((_, reject) => {
    capture.cancelStart = () => reject(new DOMException('采集已取消', 'AbortError'));
  });
  // Attach a handler before any asynchronous cleanup can cancel this start.
  capture.cancelledPromise.catch(() => {});
  active = capture;
  await dispose(old);
  check(capture);
  try {
    const endpoint = local ? JLSServerURL.checked(msg.serverUrl || 'ws://127.0.0.1:8765/ws', msg.allowRemote) : null;
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
    capture.node = new AudioWorkletNode(capture.ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 1, channelCountMode: 'explicit', processorOptions: { maxPendingBlocks: 20 } });
    if (local) {
      const settings = msg.domainMode === 'auto' ? { domain: 'auto', page_title: msg.pageTitle }
        : msg.domainMode === 'off' ? { domain: 'off' } : {};
      if (msg.domainMode === 'auto' && ['selected', 'general', 'off'].includes(msg.domainFallback)) {
        settings.packs = msg.domainFallback === 'selected' ? msg.asrPacks : [];
        settings.domain_general = msg.domainFallback === 'general';
      }
      if (msg.contextTurns !== undefined) settings.context_turns = msg.contextTurns;
      if (msg.localMode !== undefined) settings.mode = msg.localMode;
      if (typeof msg.agent === 'boolean') settings.agent = msg.agent;
      await connect(capture, endpoint, msg.target || 'zh', msg.serverToken || '', settings);
      check(capture);
    } else {
      capture.engineStarted = true;
      await Promise.race([JLSEngine.init({ target: msg.target || 'zh', apiKey: msg.apiKey || '', asrPacks: msg.asrPacks ?? msg.asrDomain, onEvent: event => {
        if (!current(capture)) return;
        if (event.type === 'progress') report(capture, 'starting', event.message);
        else {
          if (event.type === 'ready') capture.domainNotice = domainNotice(event.domain);
          send(capture, event);
        }
      }, domainMode: msg.domainMode, domainFallback: msg.domainFallback, pageTitle: msg.pageTitle,
      contextTurns: msg.contextTurns, vad: msg.vad }), capture.cancelledPromise]);
      check(capture);
    }
    const audioStart = capture.ctx.currentTime;
    let audioSeconds = 0;
    capture.node.port.onmessage = ({ data }) => {
      if (!current(capture)) return;
      if (data.overrun) { failCapture(capture, '音频处理积压，请重新开始字幕'); return; }
      try {
        if (capture.ws?.readyState === 1) {
          const buffered = (capture.ws.bufferedAmount || 0) + data.byteLength;
          if (buffered > SOCKET_LIMIT_BYTES) {
            failCapture(capture, '音频发送缓冲区已满，请检查本地服务并重新开始字幕');
            return;
          }
          const warning = buffered > SOCKET_WARN_BYTES;
          if (warning !== Boolean(capture.congested)) {
            capture.congested = warning;
            report(capture, warning ? 'degraded' : 'capturing', warning ? '音频发送积压' : captureNotice(capture));
          }
          capture.ws.send(data);
        } else if (capture.engineStarted) {
          audioSeconds += data.length / 16000;
          JLSEngine.feed(data, capture.ctx.currentTime - audioStart - audioSeconds > .3);
        }
        capture.node.port.postMessage('consumed');
      } catch {
        failCapture(capture, '音频处理失败，请重新开始字幕');
      }
    };
    capture.source.connect(capture.node);
    capture.capturing = true;
    report(capture, 'capturing', captureNotice(capture));
    capture.statsTimer = setInterval(() => {
      if (!current(capture)) return;
      if (local && capture.ws?.readyState === 1) capture.ws.send(JSON.stringify({ type: 'stats' }));
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
