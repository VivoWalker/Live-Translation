/* Demo client: the same WebSocket protocol the extension uses.
   Audio sources:
     display – getDisplayMedia(tab audio): what a user does in the browser
     file     – built-in Japanese clip: tests the browser path end-to-end
*/
(function () {
  'use strict';

  const state = {
    ws: null,
    ctx: null,
    node: null,
    source: null,
    capturing: false,
    captions: null,
    engine: '—',
    currentId: null,
    finals: 0,
    statsTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const btnStart = $('btn-start');
  const btnStop = $('btn-stop');
  const dot = $('dot');
  const statusEl = $('status');
  const engineEl = $('engine');
  const statsEl = $('stats');
  const targetEl = $('target');

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    dot.className = 'dot' + (kind ? ' ' + kind : '');
  }

  function setRunning(on) {
    btnStart.disabled = on;
    btnStop.disabled = !on;
    state.capturing = on;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => reject(new Error('连接字幕服务超时')), 5000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'config', target: targetEl.value }));
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve(msg);
        }
        handle(msg);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('无法连接字幕服务，请先启动 python -m server.app'));
      };
      ws.onclose = () => {
        if (state.ws === ws) {
          state.ws = null;
          if (state.capturing) setStatus('连接中断', 'err');
        }
      };
      state.ws = ws;
    });
  }

  function handle(msg) {
    const cap = state.captions;
    switch (msg.type) {
      case 'ready':
        state.engine = msg.translator;
        engineEl.textContent = 'ASR ' + msg.asr + ' · MT ' + msg.translator;
        setStatus('已连接，等待说话', 'live');
        break;
      case 'speech_start':
        cap.start(msg.id);
        break;
      case 'partial':
        cap.text(msg.id, 'partial', msg.text);
        cap.setMeta('识别中 · ' + (msg.t || 0).toFixed(1) + 's');
        break;
      case 'final':
        state.finals += 1;
        cap.text(msg.id, 'final', msg.text);
        cap.setMeta('第 ' + state.finals + ' 句 · 识别 ' + (msg.decode_ms || 0).toFixed(0) + 'ms');
        break;
      case 'translation': {
        cap.translation(msg.id, msg.text, msg.final);
        const eng = String(msg.engine).replace(':cache', '');
        cap.setMeta((msg.final ? '译文' : '译文草稿') + ' · ' + eng + ' ' + (msg.ms ? msg.ms + 'ms' : '缓存'));
        break;
      }
      case 'stats':
        statsEl.textContent = 'RTF ' + msg.rtf + ' · 平均翻译 ' + (msg.avg_translate_ms >= 1 ? msg.avg_translate_ms + 'ms' : '缓存命中');
        break;
      case 'error':
        cap.setMeta('翻译失败：' + msg.message);
        break;
      default:
        break;
    }
  }

  async function ensureAudio() {
    if (!state.ctx) {
      state.ctx = new AudioContext({ sampleRate: 16000 });
      await state.ctx.audioWorklet.addModule('/static/pcm-worklet.js');
    }
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    if (!state.node) {
      state.node = new AudioWorkletNode(state.ctx, 'pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      state.node.port.onmessage = (e) => {
        if (state.ws && state.ws.readyState === 1) state.ws.send(e.data);
      };
    }
  }

  async function startDisplay() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('所选来源没有音频，请勾选“分享标签页音频”');
    }
    const src = state.ctx.createMediaStreamSource(stream);
    src.connect(state.node);
    state.source = { kind: 'display', stream, src };
  }

  async function startFile(url) {
    const res = await fetch(url || '/static/sample-ja.wav');
    const buf = await state.ctx.decodeAudioData(await res.arrayBuffer());
    const src = state.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(state.node);
    src.start();
    state.source = { kind: 'file', src };
  }

  async function start(kind, url) {
    if (state.capturing) return;
    setRunning(true);
    setStatus('连接字幕服务…', 'busy');
    state.captions.root.classList.remove('hidden');
    state.captions.clear();
    try {
      await ensureAudio();
      if (!state.ws || state.ws.readyState !== 1) await connect();
      if (kind === 'file') {
        await startFile(url);
        setStatus('播放内置日语样本', 'live');
      } else {
        await startDisplay();
        setStatus('正在转写标签页声音', 'live');
      }
      state.statsTimer = setInterval(() => {
        if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'stats' }));
      }, 2000);
    } catch (err) {
      stop();
      setStatus(err.message || String(err), 'err');
    }
  }

  function stop() {
    if (state.statsTimer) clearInterval(state.statsTimer);
    if (state.source) {
      try {
        if (state.source.stream) state.source.stream.getTracks().forEach((t) => t.stop());
        if (state.source.src) {
          if (state.source.src.stop) state.source.src.stop();
          state.source.src.disconnect();
        }
      } catch (e) {}
      state.source = null;
    }
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    setRunning(false);
    setStatus('已停止');
    if (state.captions) {
      state.captions.clear();
      state.captions.root.classList.add('hidden');
    }
    engineEl.textContent = '—';
  }

  function init() {
    state.captions = window.JLS.createCaptionOverlay({ mount: document.body, showMeta: true });
    state.captions.root.classList.add('hidden');

    btnStart.addEventListener('click', () => start('display'));
    btnStop.addEventListener('click', stop);
    targetEl.addEventListener('change', () => {
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'config', target: targetEl.value }));
        state.currentId = null;
        state.captions.clear();
      }
    });
    document.getElementById('link-file').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.capturing) start('file');
    });

    window.__jls = {
      start,
      stop,
      state,
      ready: false,
      get captionText() {
        const root = state.captions.root;
        const cur = root.querySelector('.jls-cur');
        const prev = root.querySelector('.jls-prev');
        return {
          ja: cur.querySelector('.jls-ja').textContent,
          zh: cur.querySelector('.jls-zh').textContent,
          prevJa: prev.querySelector('.jls-ja').textContent,
          prevZh: prev.querySelector('.jls-zh').textContent,
          meta: root.querySelector('.jls-meta').textContent,
        };
      },
    };

    const qs = new URLSearchParams(location.search);
    if (qs.get('autostart') === 'file') setTimeout(() => start('file'), 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
