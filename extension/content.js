/* Content script: subtitle overlay on the page, isolated in a shadow root.

   Two rolling rows: the previous sentence keeps its Japanese + translation on
   screen while the next sentence is still being recognised, so a translation
   never disappears the moment the next line starts. */
'use strict';

(() => {
  // The background may inject this file a second time (page opened before install).
  if (window.__jlsContentLoaded) return;
  window.__jlsContentLoaded = true;

  const HOST_ID = 'ja-live-subs-host';
  const MAX_LINES = 4;
  let ui = null;

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; left: 50%; bottom: 6vh; transform: translateX(-50%);
      width: min(88vw, 1000px); padding: 14px 22px 12px;
      background: rgba(6, 8, 12, .84); backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.10); border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0,0,0,.5); color: #fff; text-align: center;
      font-family: "Segoe UI", "Yu Gothic UI", "Hiragino Sans", sans-serif;
      z-index: 2147483647; transition: opacity .25s ease; cursor: move;
      user-select: none;
    }
    .wrap.hidden { display: none; }
    .wrap.empty { opacity: 0; }
    .wrap.idle { opacity: .55; }
    .row + .row { margin-top: 6px; }
    .prev { opacity: .62; font-size: .82em; }
    .prev .zh { margin-top: 2px; }
    .off { display: none; }
    .ja { font-size: clamp(15px, 1.7vw, 22px); line-height: 1.5; }
    .zh { font-size: clamp(17px, 1.9vw, 25px); line-height: 1.55; margin-top: 4px; font-weight: 600; color: #cfe0ff; }
    .partial .ja { opacity: .72; }
    .meta { margin-top: 6px; font-size: 11px; color: rgba(255,255,255,.45); letter-spacing: .02em; }
    .zh.pending { color: #a9bde0; }
    .err { color: #ff8b8b; }
    .pill {
      position: fixed; top: 16px; right: 16px; padding: 7px 12px;
      background: rgba(6,8,12,.85); border: 1px solid rgba(255,255,255,.12);
      border-radius: 999px; font-size: 12px; color: #cfe0ff;
      font-family: "Segoe UI", "Yu Gothic UI", sans-serif;
      opacity: 0; transform: translateY(-6px); transition: opacity .2s ease, transform .2s ease;
    }
    .pill.on { opacity: 1; transform: none; }
    .pill.bad { color: #ffb3b3; border-color: rgba(255,120,120,.35); }
  `;

  function mountPoint() {
    // In fullscreen the browser only paints the fullscreen element's subtree.
    return document.fullscreenElement || document.body || document.documentElement;
  }

  function build() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = document.createElement('div');
    wrap.className = 'wrap hidden empty';
    wrap.innerHTML =
      '<div class="row prev off"><div class="ja"></div><div class="zh"></div></div>' +
      '<div class="row cur"><div class="ja"></div><div class="zh"></div></div>' +
      '<div class="meta"></div>';

    const pill = document.createElement('div');
    pill.className = 'pill';

    shadow.append(style, wrap, pill);
    mountPoint().appendChild(host);

    const prevRow = wrap.querySelector('.prev');
    const curRow = wrap.querySelector('.cur');
    const meta = wrap.querySelector('.meta');
    const lines = new Map();
    let curId = null;
    let prevId = null;
    let idleTimer = null;
    let pillTimer = null;
    let drag = null;

    const saved = localStorage.getItem('jls.pos');
    if (saved) {
      try {
        const p = JSON.parse(saved);
        wrap.style.left = p.left;
        wrap.style.top = p.top;
        wrap.style.bottom = 'auto';
        wrap.style.transform = 'none';
      } catch (e) {}
    }

    wrap.addEventListener('pointerdown', (e) => {
      const r = wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      wrap.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
      wrap.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
      wrap.style.bottom = 'auto';
      wrap.style.transform = 'none';
    });
    wrap.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      localStorage.setItem('jls.pos', JSON.stringify({ left: wrap.style.left, top: wrap.style.top }));
    });

    document.addEventListener('fullscreenchange', () => {
      const target = mountPoint();
      if (host.parentNode !== target) target.appendChild(host);
    });

    function line(id) {
      if (id === null || id === undefined) return null;
      if (!lines.has(id)) lines.set(id, { ja: '', zh: '', kind: 'partial' });
      return lines.get(id);
    }

    function trim() {
      while (lines.size > MAX_LINES) {
        const oldest = lines.keys().next().value;
        if (oldest === curId || oldest === prevId) break;
        lines.delete(oldest);
      }
    }

    function paint(row, data) {
      if (!data || (!data.ja && !data.zh)) {
        row.classList.add('off');
        row.querySelector('.ja').textContent = '';
        row.querySelector('.zh').textContent = '';
        return;
      }
      row.classList.remove('off');
      row.querySelector('.ja').textContent = data.ja || '';
      row.querySelector('.zh').textContent = data.zh || '';
      row.classList.toggle('partial', data.kind !== 'final');
      const zh = row.querySelector('.zh');
      zh.classList.toggle('pending', !data.zh);
    }

    function render() {
      paint(prevRow, lines.get(prevId) || null);
      paint(curRow, lines.get(curId) || null);
      const cur = lines.get(curId);
      const prev = lines.get(prevId);
      wrap.classList.toggle('empty', !(cur && (cur.ja || cur.zh)) && !(prev && (prev.ja || prev.zh)));
      wrap.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => wrap.classList.add('idle'), 6000);
    }

    function promote(id) {
      if (id === curId) return;
      if (curId !== null) prevId = curId;
      curId = id;
      trim();
    }

    return {
      host,
      show() {
        wrap.classList.remove('hidden');
      },
      start(id) {
        promote(id);
        render();
      },
      text(id, kind, ja) {
        promote(id);
        const l = line(id);
        if (l) {
          l.ja = ja || '';
          l.kind = kind;
        }
        this.show();
        render();
      },
      translation(id, zh, final) {
        if (!lines.has(id)) promote(id);
        const l = line(id);
        l.zh = zh || '';
        if (final) l.kind = 'final';
        render();
      },
      setMeta(text, isError) {
        meta.textContent = text || '';
        meta.classList.toggle('err', !!isError);
      },
      toast(text, bad) {
        pill.textContent = text;
        pill.classList.toggle('bad', !!bad);
        pill.classList.add('on');
        clearTimeout(pillTimer);
        pillTimer = setTimeout(() => pill.classList.remove('on'), 4000);
      },
      clear() {
        lines.clear();
        curId = null;
        prevId = null;
        meta.textContent = '';
        wrap.classList.add('empty');
      },
      hide() {
        wrap.classList.add('hidden');
      },
    };
  }

  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    ui = build();
    return ui;
  }

  function handle(ev) {
    if (!ev) return;
    const u = ensureUi();
    switch (ev.type) {
      case 'speech_start':
        u.show();
        u.start(ev.id);
        u.setMeta('识别中…');
        break;
      case 'partial':
        u.text(ev.id, 'partial', ev.text);
        u.setMeta('识别中 ' + (ev.t || 0).toFixed(1) + 's');
        break;
      case 'final':
        u.text(ev.id, 'final', ev.text);
        u.setMeta('识别 ' + Math.round(ev.decode_ms || 0) + 'ms · 翻译中…');
        break;
      case 'translation': {
        u.translation(ev.id, ev.text, ev.final);
        const eng = String(ev.engine || '').replace(':cache', '');
        u.setMeta((ev.final ? '译 ' : '译稿 ') + eng + ' ' + (ev.ms ? Math.round(ev.ms) + 'ms' : '缓存'));
        break;
      }
      case 'error':
        u.show();
        u.setMeta(ev.message || '出错了', true);
        break;
      default:
        break;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'jls:ping') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'jls:toast') {
      ensureUi().toast(msg.text || '字幕已开启', msg.bad);
      return false;
    }
    if (msg.type === 'jls:event') {
      handle(msg.event);
    } else if (msg.type === 'jls:clear') {
      if (ui) {
        ui.clear();
        ui.hide();
      }
    }
    return false;
  });
})();
