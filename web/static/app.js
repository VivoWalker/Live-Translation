/* Local workspace using the same authenticated WebSocket and caption renderer as the extension. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const stage = $('caption-stage');
  const accessToken = $('access-token');
  const target = $('target');
  const startButton = $('btn-start');
  const sampleButton = $('link-file');
  const stopButton = $('btn-stop');
  const appPrefsKey = 'jls.captionPrefs.v1';
  const targetKey = 'jls.target.v1';
  let active = null;
  let prefs = JLS.captionPreferences();

  try {
    prefs = JLS.captionPreferences(JSON.parse(localStorage.getItem(appPrefsKey) || '{}'));
    target.value = localStorage.getItem(targetKey) === 'en' ? 'en' : 'zh';
  } catch {}

  const preview = JLS.createCaptionPreview($('stage-preview'));
  const editor = JLS.createCaptionEditor($('caption-editor'), { onChange: applySettings });
  const captions = JLS.createCaptionOverlay({
    mount: stage, embedded: true, showMeta: false, showSettings: false,
    loadSettings: () => prefs,
    saveSettings: settings => applySettings(settings, true),
  });
  captions.hide();

  function showMessage(text, error = false) {
    const notice = $('message');
    notice.hidden = !text;
    notice.dataset.kind = error ? 'error' : '';
    notice.textContent = text || '';
  }

  function applySettings(value, commit) {
    prefs = JLS.captionPreferences(value);
    document.documentElement.dataset.theme = prefs.theme;
    editor.update(prefs);
    captions.setSettings(prefs);
    preview.update(prefs, target.value);
    if (commit) {
      try { localStorage.setItem(appPrefsKey, JSON.stringify(prefs)); }
      catch { showMessage('字幕设置未能保存', true); }
    }
  }

  function setStatus(text, phase = 'idle') {
    $('connection').dataset.phase = phase;
    $('status').textContent = text;
  }

  function updateView() {
    const live = !!active;
    startButton.hidden = sampleButton.hidden = live;
    stopButton.hidden = !live;
    accessToken.disabled = live;
    stage.dataset.live = String(live);
    stage.dataset.caption = String(live && active.hasCaption);
    $('stage-title').textContent = live ? '实时字幕' : '字幕预览';
    $('stage-preview').hidden = live;
    $('stage-empty').hidden = !live || active.hasCaption;
    if (live && !active.hasCaption) $('stage-empty').textContent = active.stageMessage || '等待语音';
    if (!live) stage.style.removeProperty('--level');
  }

  function updateTarget() {
    $('stage-languages').textContent = target.value === 'en' ? '日语 → 英语' : '日语 → 简体中文';
    preview.update(prefs, target.value);
  }

  function isCurrent(session) { return active === session; }

  function requireCurrent(session) {
    if (!isCurrent(session)) throw new DOMException('采集已取消', 'AbortError');
  }

  function connect(session, token) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = session.ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.binaryType = 'arraybuffer';
      function fail(message) {
        clearTimeout(timer);
        reject(new Error(message));
      }
      const timer = setTimeout(() => fail('连接字幕服务超时'), 5000);
      session.cancelConnect = () => fail('连接已取消');
      ws.onopen = () => {
        if (!isCurrent(session)) return ws.close();
        ws.send(JSON.stringify({ type: 'auth', token }));
        ws.send(JSON.stringify({ type: 'config', target: target.value }));
      };
      ws.onmessage = event => {
        if (!isCurrent(session)) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') {
          clearTimeout(timer);
          session.cancelConnect = null;
          resolve();
        }
        handle(session, message);
      };
      ws.onerror = () => fail('无法连接字幕服务');
      ws.onclose = event => {
        const error = event.code === 1013 ? '字幕服务积压，请重新开始'
          : event.code === 1011 ? '字幕服务处理失败，请检查本地模型'
            : event.code === 1008 ? '服务拒绝连接，请检查访问令牌或请求限制' : '字幕服务已断开';
        fail(error);
        if (isCurrent(session)) stop(session, error, true);
      };
    });
  }

  function handle(session, message) {
    switch (message.type) {
      case 'ready':
        $('engine').textContent = message.asr + ' / ' + message.translator;
        $('stats').textContent = '0 句';
        $('latency').textContent = '—';
        $('diagnostics').hidden = false;
        break;
      case 'speech_start':
        captions.start(message.id);
        break;
      case 'partial':
      case 'final':
        captions.text(message.id, message.type, message.text);
        if (message.text && prefs.showJa && !session.hasCaption) {
          session.hasCaption = true;
          updateView();
        }
        break;
      case 'translation':
        captions.translation(message.id, message.text, message.final);
        if (message.text && !session.hasCaption) {
          session.hasCaption = true;
          updateView();
        }
        if ($('message').dataset.kind === 'error') showMessage('');
        break;
      case 'stats':
        $('stats').textContent = (message.translations ?? 0) + ' 句';
        const ms = message.translation?.avg_request_ms;
        $('latency').textContent = Number.isFinite(ms) ? Math.round(ms) + ' ms' : '—';
        break;
      case 'error':
        if (message.scope === 'translate') captions.translationFailed(message.id);
        showMessage(message.message || '字幕处理失败', true);
        break;
      case 'translation_cancelled':
        captions.translationFailed(message.id);
        break;
    }
  }

  async function setupAudio(session) {
    const ctx = session.ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('/static/pcm-worklet.js');
    requireCurrent(session);
    if (ctx.state === 'suspended') await ctx.resume();
    requireCurrent(session);
    const node = session.node = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { maxPendingBlocks: 20 },
    });
    node.port.onmessage = event => {
      if (!isCurrent(session) || session.ws.readyState !== WebSocket.OPEN) return;
      const samples = event.data;
      const buffered = session.ws.bufferedAmount + (samples.byteLength || 0);
      if (samples.overrun || buffered > 128 * 1024) {
        stop(session, '音频处理积压，请重新开始', true);
        return;
      }
      const congested = buffered > 64 * 1024;
      if (congested !== session.congested) {
        session.congested = congested;
        setStatus(congested ? '音频发送积压' : session.kind === 'file' ? '正在转写样本' : '正在转写', congested ? 'busy' : 'live');
      }
      session.ws.send(samples);
      node.port.postMessage('consumed');
      let energy = 0;
      for (let index = 0; index < samples.length; index += 16) energy += samples[index] ** 2;
      const level = Math.min(1, Math.sqrt(energy / Math.max(1, samples.length / 16)) * 7);
      stage.style.setProperty('--level', level.toFixed(2));
    };
  }

  async function start(kind, url) {
    if (active) return;
    const token = accessToken.value.trim();
    if (!token) {
      setStatus('需要令牌', 'error');
      showMessage('请填写服务终端显示的访问令牌', true);
      accessToken.focus();
      return;
    }
    const session = { kind, abort: new AbortController(), hasCaption: false, congested: false,
      stageMessage: kind === 'display' ? '选择带音频的标签页' : '加载日语样本' };
    active = session;
    setStatus('准备中', 'busy');
    showMessage('');
    updateView();
    try {
      if (kind === 'display') {
        // Open the browser picker directly from the click before awaiting anything else.
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (!isCurrent(session)) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        session.stream = stream;
        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') throw new Error('请重新选择标签页并勾选“分享标签页音频”');
        track.addEventListener('ended', () => stop(session, '音频共享已结束'), { once: true });
      }
      setStatus('连接中', 'busy');
      await connect(session, token);
      requireCurrent(session);
      await setupAudio(session);
      if (kind === 'file') {
        const response = await fetch(url || '/static/sample-ja.wav', { signal: session.abort.signal });
        if (!response.ok) throw new Error('日语样本加载失败');
        const buffer = await response.arrayBuffer();
        requireCurrent(session);
        const audio = await session.ctx.decodeAudioData(buffer);
        requireCurrent(session);
        const source = session.ctx.createBufferSource();
        source.buffer = audio;
        source.loop = true;
        source.connect(session.node);
        source.connect(session.ctx.destination);
        source.start();
        session.source = source;
      } else {
        session.source = session.ctx.createMediaStreamSource(session.stream);
        session.source.connect(session.node);
      }
      session.stageMessage = '等待语音';
      updateView();
      setStatus(kind === 'file' ? '正在转写样本' : '正在转写', 'live');
      session.statsTimer = setInterval(() => {
        if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'stats' }));
      }, 2000);
    } catch (error) {
      if (isCurrent(session)) {
        const cancelled = error.name === 'NotAllowedError' || error.name === 'AbortError';
        stop(session, cancelled ? '未共享音频' : error.message || '无法开始字幕', !cancelled);
      }
    }
  }

  function stop(session = active, message = '', error = false) {
    if (!session || !isCurrent(session)) return;
    active = null;
    session.abort.abort();
    session.cancelConnect?.();
    clearInterval(session.statsTimer);
    if (session.node) {
      session.node.port.onmessage = null;
      session.node.disconnect();
    }
    if (session.kind === 'file' && session.source) session.source.stop();
    session.source?.disconnect();
    session.stream?.getTracks().forEach(track => track.stop());
    session.ws?.close();
    session.ctx?.close().catch(() => {});
    captions.clear();
    captions.hide();
    $('diagnostics').hidden = true;
    setStatus(error ? '需要处理' : '已停止', error ? 'error' : 'idle');
    showMessage(message, error);
    updateView();
  }

  startButton.addEventListener('click', () => start('display'));
  stopButton.addEventListener('click', () => stop());
  sampleButton.addEventListener('click', () => start('file'));
  target.addEventListener('change', () => {
    try { localStorage.setItem(targetKey, target.value); } catch {}
    updateTarget();
    if (active?.ws?.readyState === WebSocket.OPEN) {
      active.ws.send(JSON.stringify({ type: 'config', target: target.value }));
      active.hasCaption = false;
      captions.clear();
      updateView();
    }
  });
  window.addEventListener('pagehide', () => stop());
  applySettings(prefs);
  updateTarget();

  window.__jls = {
    start, stop: () => stop(),
    get state() { return { capturing: !!active, source: active?.kind || null }; },
    get captionText() { return captions.captionText; },
  };
  if (new URLSearchParams(location.search).get('autostart') === 'file') setTimeout(() => start('file'), 400);
})();
