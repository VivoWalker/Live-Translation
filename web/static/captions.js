/* Shared caption renderer: two rolling rows so the previous translation stays
   readable while the next sentence is still being transcribed. */
(function (global) {
  'use strict';

  function createCaptionOverlay(options) {
    const opts = Object.assign({ mount: document.body, showMeta: true, maxLines: 4 }, options || {});
    const root = document.createElement('div');
    root.className = 'jls-captions';
    root.innerHTML =
      '<div class="jls-row jls-prev">' +
      '  <div class="jls-ja"></div><div class="jls-zh"></div>' +
      '</div>' +
      '<div class="jls-row jls-cur">' +
      '  <div class="jls-ja"></div><div class="jls-zh"></div>' +
      '</div>' +
      '<div class="jls-meta"></div>';
    opts.mount.appendChild(root);

    const prevRow = root.querySelector('.jls-prev');
    const curRow = root.querySelector('.jls-cur');
    const meta = root.querySelector('.jls-meta');
    meta.style.display = opts.showMeta ? '' : 'none';

    const lines = new Map();
    let curId = null;
    let prevId = null;
    let idleTimer = null;

    function line(id) {
      if (id === null || id === undefined) return null;
      if (!lines.has(id)) lines.set(id, { ja: '', zh: '', kind: 'partial' });
      return lines.get(id);
    }

    function trim() {
      while (lines.size > opts.maxLines) {
        const oldest = lines.keys().next().value;
        if (oldest === curId || oldest === prevId) break;
        lines.delete(oldest);
      }
    }

    function paint(row, data) {
      if (!data || (!data.ja && !data.zh)) {
        row.classList.add('jls-off');
        row.querySelector('.jls-ja').textContent = '';
        row.querySelector('.jls-zh').textContent = '';
        return;
      }
      row.classList.remove('jls-off');
      row.querySelector('.jls-ja').textContent = data.ja || '';
      row.querySelector('.jls-zh').textContent = data.zh || '';
      row.classList.toggle('jls-pending', !data.zh);
      row.classList.toggle('jls-partial', data.kind !== 'final');
    }

    function render() {
      const cur = lines.get(curId) || null;
      const prev = lines.get(prevId) || null;
      // Fixed order: previous pair on top (keeps its translation readable while the
      // next sentence is still being recognised), current sentence underneath.
      paint(prevRow, prev);
      paint(curRow, cur);
      root.classList.toggle('jls-empty', !(cur && (cur.ja || cur.zh)) && !(prev && (prev.ja || prev.zh)));
      touch();
    }

    function touch() {
      root.classList.remove('jls-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => root.classList.add('jls-idle'), 6000);
    }

    function promote(id) {
      if (id === curId) return;
      if (curId !== null) prevId = curId;
      curId = id;
      trim();
    }

    return {
      root,
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
        render();
      },
      translation(id, zh, final) {
        const l = line(id);
        if (!l) {
          // Translation for a line we already dropped: show it as its own row.
          promote(id);
        }
        const target = line(id);
        target.zh = zh || '';
        if (final) target.kind = 'final';
        render();
      },
      setMeta(text) {
        meta.textContent = text || '';
      },
      clear() {
        lines.clear();
        curId = null;
        prevId = null;
        root.classList.add('jls-empty');
        meta.textContent = '';
      },
      get currentId() {
        return curId;
      },
    };
  }

  global.JLS = global.JLS || {};
  global.JLS.createCaptionOverlay = createCaptionOverlay;
})(typeof window !== 'undefined' ? window : globalThis);
