/* Shared subtitle display for the extension and the local demo. */
(() => {
  'use strict';
  const global = typeof window === 'undefined' ? globalThis : window;
  global.JLS = global.JLS || {};
  if (global.JLS.createCaptionOverlay) return;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const { captionPreferences: preferences, applyCaptionStyle, captionTextCSS, createCaptionEditor } = global.JLS;

  function readingTime(text, cps = 6, minSeconds = 3) {
    return clamp(1100 + Array.from(text.replace(/\s/g, '')).length / cps * 1000, minSeconds * 1000, 24000);
  }

  class CaptionTimeline {
    constructor(options = {}) {
      this.now = options.now || (() => performance.now());
      this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
      this.clearTimer = options.clearTimer || (timer => clearTimeout(timer));
      this.onChange = options.onChange || (() => {});
      this.cps = options.cps || 6;
      this.minSeconds = options.minSeconds || 3;
      this.entries = new Map();
      this.visible = [];
      this.pending = [];
      this.currentId = null;
      this.sequence = 0;
      this.pauseAt = null;
      this.timer = null;
    }
    entry(id) {
      if (id === null || id === undefined) return null;
      if (!this.entries.has(id)) {
        // An evicted late result must not become the newest sentence again.
        if (typeof id === 'number' && typeof this.currentId === 'number' && id < this.currentId) return null;
        this.entries.set(id, { id, order: this.sequence++, ja: '', zh: '', kind: 'partial', retired: false });
      }
      return this.entries.get(id);
    }
    start(id) {
      const entry = this.entry(id);
      if (entry && (this.currentId === null || entry.order >= (this.entries.get(this.currentId)?.order ?? -1))) this.currentId = id;
      this.changed();
    }
    text(id, kind, ja) {
      const entry = this.entry(id);
      if (!entry || entry.retired) return;
      if (entry.kind === 'final' && kind !== 'final') return;
      entry.ja = String(ja || '');
      entry.kind = kind;
      if (kind === 'final' && entry.ja) this.enqueue(entry);
      this.start(id);
    }
    enqueue(entry) {
      if (!this.visible.includes(entry) && !this.pending.includes(entry)) {
        this.pending.push(entry);
        this.pending.sort((a, b) => a.order - b.order);
      }
      this.fill();
    }
    beginReading(entry) {
      entry.shownAt = this.now();
      entry.readUntil = entry.zh || entry.failed
        ? entry.shownAt + readingTime(entry.zh || entry.ja, this.cps, this.minSeconds)
        : entry.shownAt + 60000; // Beyond the translator's retries; never block a slot forever.
      entry.deadline = entry.readUntil;
    }
    translation(id, text, final = true) {
      if (!text || final === false) return;
      const entry = this.entry(id);
      if (!entry || entry.retired) return;
      const changed = entry.zh !== text;
      entry.zh = String(text);
      entry.kind = 'final';
      entry.failed = false;
      if (this.visible.includes(entry)) {
        if (changed) this.beginReading(entry);
      } else this.enqueue(entry);
      this.changed();
    }
    fail(id) {
      const entry = this.entries.get(id);
      if (!entry || entry.retired || entry.zh || entry.failed) return;
      entry.failed = true;
      if (this.visible.includes(entry)) this.beginReading(entry);
      this.changed();
    }
    fill() {
      while (this.visible.length < 2 && this.pending.length) {
        const entry = this.pending.shift();
        this.beginReading(entry);
        this.visible.push(entry);
      }
      this.visible.sort((a, b) => a.order - b.order);
    }
    changed() {
      this.clearTimer(this.timer);
      this.timer = null;
      const protectedEntries = new Set([...this.visible, ...this.pending]);
      // Bound long-running sessions without removing the two protected rows.
      for (const [id, entry] of this.entries) {
        if (this.entries.size <= 64) break;
        if (!protectedEntries.has(entry) && id !== this.currentId) this.entries.delete(id);
      }
      while (this.pending.length > 32) {
        const [old] = this.pending.splice(1, 1); // Keep the Japanese currently shown in the preview.
        old.retired = true;
        this.entries.delete(old.id);
      }
      let previousDeadline = -Infinity;
      for (const entry of this.visible) {
        // Each sentence gets its own minimum reading time, but departures stay
        // in spoken order with enough separation for the preceding exit motion.
        entry.deadline = Math.max(entry.readUntil, entry.notBefore ?? -Infinity, previousDeadline + 600);
        previousDeadline = entry.deadline;
      }
      this.onChange();
      const deadlines = this.visible.map(entry => entry.deadline).filter(Number.isFinite);
      if (this.pauseAt === null && deadlines.length) {
        const deadline = Math.min(...deadlines);
        this.timer = this.setTimer(() => this.tick(), Math.max(1, deadline - this.now()));
      }
    }
    tick() {
      if (this.pauseAt !== null) return;
      const now = this.now();
      const first = this.visible[0];
      if (first && first.deadline <= now) {
        if (!first.zh && !first.failed) { first.failed = true; this.beginReading(first); }
        else {
          first.retired = true; this.visible.shift();
          this.fill();
          if (this.visible[0]) this.visible[0].notBefore = now + 600;
        }
      }
      this.fill();
      this.changed();
    }
    pause(on) {
      if (on && this.pauseAt === null) this.pauseAt = this.now();
      else if (!on && this.pauseAt !== null) {
        for (const entry of this.visible) {
          if (!Number.isFinite(entry.deadline)) continue;
          const elapsed = this.now() - Math.max(this.pauseAt, entry.shownAt);
          entry.readUntil += elapsed; entry.shownAt += elapsed;
          if (entry.notBefore !== undefined) entry.notBefore += elapsed;
        }
        this.pauseAt = null;
      }
      this.changed();
    }
    speed(cps, minSeconds = this.minSeconds) {
      this.cps = cps;
      this.minSeconds = minSeconds;
      for (const entry of this.visible) {
        if (entry.zh || entry.failed) entry.readUntil = entry.shownAt + readingTime(entry.zh || entry.ja, cps, minSeconds);
      }
      this.changed();
    }
    catchUp() {
      const latest = this.pending.at(-1);
      if (!latest) return;
      for (const entry of [...this.visible, ...this.pending]) entry.retired = entry !== latest;
      this.visible = [];
      this.pending = [latest];
      this.fill();
      this.changed();
    }
    preview() {
      const waiting = this.pending.find(entry => entry.ja && !entry.retired);
      if (waiting) return waiting;
      const current = this.entries.get(this.currentId);
      return current && !current.retired && !this.visible.includes(current) && current.ja ? current : null;
    }
    clear() {
      this.clearTimer(this.timer);
      this.timer = null;
      this.entries.clear();
      this.visible = [];
      this.pending = [];
      this.currentId = null;
      this.sequence = 0;
      this.onChange();
    }
  }

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .wrap {
      position: fixed; left: 50%; bottom: 6%; transform: translateX(-50%);
      width: min(var(--caption-width), 1040px);
      min-width: min(280px, calc(100% - 24px)); max-width: calc(100% - 24px);
      padding: 12px 20px; border: 1px solid #ffffff0f; border-radius: var(--caption-radius);
      color: var(--caption-color); background: rgba(var(--caption-bg), var(--rest-bg));
      box-shadow: 0 6px 26px #0000000d; pointer-events: auto; color-scheme: dark;
      font: 400 14px/1.45 "Segoe UI", "Noto Sans CJK SC", "Yu Gothic UI", system-ui, sans-serif;
      transition: background .36s cubic-bezier(.22,1,.36,1), border-color .36s ease, box-shadow .36s ease, opacity .36s ease;
    }
    .wrap.embedded { position: absolute; }
    .wrap[data-anchor="top"] { top: 48px; bottom: auto; }
    .wrap[data-anchor="middle"] { top: 50%; bottom: auto; transform: translate(-50%, -50%); }
    .wrap.engaged { background: rgba(var(--caption-bg), var(--focus-bg)); border-color: #ffffff29;
      box-shadow: 0 12px 38px #0005; }
    .wrap.hidden { display: none; }
    .wrap.empty:not(.engaged) { opacity: 0; pointer-events: none; }
    .toolbar { position: absolute; bottom: calc(100% - 1px); left: 0; right: 0;
      display: flex; align-items: center; gap: 7px; padding-bottom: 7px;
      opacity: 0; transform: translateY(6px); pointer-events: none;
      transition: opacity .2s ease, transform .3s cubic-bezier(.22,1,.36,1); }
    .engaged .toolbar { opacity: 1; transform: none; pointer-events: auto; }
    .toolbar button {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 33px; padding: 6px 11px; border: 1px solid #ffffff2b; border-radius: 8px;
      background: #19352a; color: #eff6ee; font: inherit; font-weight: 600;
      white-space: nowrap; box-shadow: 0 2px 8px #0003; cursor: pointer;
    }
    .toolbar button:hover { background: #315142; }
    .toolbar button:focus-visible, .rows:focus-visible { outline: 2px solid #bdebad; outline-offset: 2px; }
    .drag { cursor: grab !important; touch-action: none; user-select: none; }
    .dragging .drag { cursor: grabbing !important; }
    .grip { font-size: 17px; line-height: 1; color: #c3e8be; }
    .toolbar .spacer { flex: 1; }
    .rows { max-height: min(46vh, 420px); overflow-y: auto; overflow-x: hidden;
      overscroll-behavior: contain; overflow-anchor: none; scrollbar-width: none; }
    .embedded .rows { max-height: min(42vh, calc(var(--caption-frame-height) * .6)); }
    .rows::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .row { padding: 3px 0 6px; }
    .row + .row { border-top: 1px solid #ffffff25; padding-top: 9px; margin-top: 3px; }
    .live { padding: 4px 0 0; max-height: 84px; overflow: auto; scrollbar-width: none; }
    .meta { color: #ffdbd7; }
    .meta.err { padding: 6px 9px; border-radius: 8px; background: #412824f0; }
    .settings {
      --ui-text: #182b22; --ui-muted: #51645a; --ui-line: #d7e2d8; --ui-well: #edf2e9;
      --ui-surface: #fffefa; --ui-tint: #e1f2df; --ui-accent: #236346; --ui-on-accent: #fff; --ui-accent-text: #215138;
      position: absolute; z-index: 2; width: min(364px, calc(100vw - 24px)); overflow: auto; overscroll-behavior: contain;
      scrollbar-width: thin; scrollbar-color: var(--ui-line) transparent;
      padding: 16px; text-align: left; background: var(--ui-surface); border: 1px solid var(--ui-line);
      border-radius: 15px; box-shadow: 0 16px 48px #071b1380; color: var(--ui-text); color-scheme: light;
    }
    .settings[data-theme="dark"] {
      --ui-text: #eff6ee; --ui-muted: #afc2b7; --ui-line: #374d41; --ui-well: #121f19;
      --ui-surface: #192922; --ui-tint: #2a4435; --ui-accent: #bdebad; --ui-on-accent: #142b1e; --ui-accent-text: #cdf0c0;
      color-scheme: dark;
    }
    @media (prefers-color-scheme: dark) {
      .settings[data-theme="system"] {
        --ui-text: #eff6ee; --ui-muted: #afc2b7; --ui-line: #374d41; --ui-well: #121f19;
        --ui-surface: #192922; --ui-tint: #2a4435; --ui-accent: #bdebad; --ui-on-accent: #142b1e; --ui-accent-text: #cdf0c0;
        color-scheme: dark;
      }
    }
    .settings-bridge { position: absolute; pointer-events: auto; }
    .pill { position: fixed; top: 16px; right: 16px; padding: 8px 13px; max-width: calc(100vw - 32px);
      background: #19352a; border: 1px solid #ffffff26; border-radius: 12px; color: #eff6ee;
      font: 14px/1.5 system-ui, sans-serif; opacity: 0; transform: translateY(-6px);
      transition: opacity .25s ease, transform .3s ease; }
    .pill.on { opacity: 1; transform: none; }
    .pill.bad { background: #512b26; color: #ffddd6; }
    .no-motion, .no-motion *, .no-motion *::before, .no-motion *::after { transition: none !important; animation: none !important; }
    @media (max-width: 520px) { .wrap { padding: 9px 12px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
  `;

  function createCaptionOverlay(options = {}) {
    const opts = { mount: document.body, showMeta: true, showSettings: true, ...options };
    const host = document.createElement('div');
    host.id = opts.hostId || 'jls-demo-caption-host';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    if (opts.embedded) host.style.position = 'absolute';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS + captionTextCSS;
    const root = document.createElement('section');
    root.className = 'wrap jls-captions caption-appearance empty';
    root.classList.toggle('embedded', !!opts.embedded);
    root.setAttribute('aria-label', '双语字幕');
    root.innerHTML = `
      <div class="settings-bridge" hidden aria-hidden="true"></div>
      <div class="toolbar">
        <button class="drag" type="button" aria-label="拖动字幕框，方向键微调" title="拖动移动，方向键微调"><span class="grip" aria-hidden="true">⠿</span> 移动</button>
        <span class="spacer"></span>
        <button class="catch-up" type="button" hidden title="跳过待读译文，显示最新一句">回到实时</button>
        <button class="settings-toggle" type="button" aria-expanded="false" aria-controls="jls-settings">字幕设置</button>
      </div>
      <div class="rows" role="log" tabindex="0" aria-label="字幕，可滚动阅读" aria-live="polite" aria-relevant="additions text"></div>
      <div class="live" aria-live="off"><div class="ja jls-ja" lang="ja"></div></div>
      <div class="meta jls-meta" role="status" hidden></div>
      <div class="settings" id="jls-settings" hidden></div>`;
    const pill = document.createElement('div');
    pill.className = 'pill';
    shadow.append(style, root, pill);
    function mountPoint() { return (opts.fullscreen && document.fullscreenElement) || opts.mount; }
    mountPoint().appendChild(host);
    const rows = root.querySelector('.rows');
    const live = root.querySelector('.live');
    const meta = root.querySelector('.meta');
    const panel = root.querySelector('.settings');
    const bridge = root.querySelector('.settings-bridge');
    const toggle = root.querySelector('.settings-toggle');
    const handle = root.querySelector('.drag');
    const catchUp = root.querySelector('.catch-up');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const rendered = new Map();
    const animations = new Set();
    let prefs = preferences();
    let hovered = false, keyboard = false, drag = null, destroyed = false, revision = 0;
    let pillTimer = null, leaveTimer = null;
    toggle.hidden = !opts.showSettings;
    const editor = opts.showSettings ? createCaptionEditor(panel, {
      onChange(settings, commit) {
        setSettings(settings);
        if (commit) save();
      },
      onClose: () => closePanel(true),
    }) : null;

    function motion(node, frames, duration) {
      if (!prefs.animations || reduced.matches || !node.animate) return null;
      const animation = node.animate(frames, { duration, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' });
      animations.add(animation);
      animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
      return animation;
    }
    function cancelAnimations() {
      for (const animation of animations) animation.cancel();
      animations.clear();
    }
    function frame() {
      return opts.embedded ? host.getBoundingClientRect() : { width: innerWidth, height: innerHeight, left: 0, top: 0 };
    }
    function position() {
      if (drag) return;
      if (!prefs.position) {
        for (const key of ['left', 'top', 'bottom', 'transform']) root.style.removeProperty(key);
        return;
      }
      const size = frame();
      const rect = root.getBoundingClientRect();
      root.style.left = (12 + prefs.position.x * Math.max(0, size.width - rect.width - 24)) + 'px';
      root.style.top = (44 + prefs.position.y * Math.max(0, size.height - rect.height - 56)) + 'px';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
    }
    function placePanel() {
      if (panel.hidden) return;
      const rect = root.getBoundingClientRect();
      const above = rect.top - 56;
      const below = innerHeight - rect.bottom - 22;
      panel.style.maxHeight = Math.min(510, innerHeight - 24, Math.max(220, above, below)) + 'px';
      const width = panel.offsetWidth, height = panel.offsetHeight;
      const left = clamp(rect.right - width, 12, innerWidth - width - 12);
      const top = clamp(below > above ? rect.bottom + 10 : rect.top - 44 - height, 12, innerHeight - height - 12);
      panel.style.left = left - rect.left - root.clientLeft + 'px';
      panel.style.top = top - rect.top - root.clientTop + 'px';
      const gapStart = top > rect.bottom ? rect.bottom : top + height;
      const gapEnd = top > rect.bottom ? top : rect.top;
      bridge.style.left = panel.style.left;
      bridge.style.top = gapStart - rect.top - root.clientTop + 'px';
      bridge.style.width = width + 'px';
      bridge.style.height = Math.max(0, gapEnd - gapStart) + 'px';
    }
    function render() {
      if (destroyed) return;
      const visible = new Set(timeline.visible.map(entry => entry.id));
      for (const [id, row] of rendered) {
        if (visible.has(id)) continue;
        rendered.delete(id);
        row.setAttribute('aria-hidden', 'true');
        const height = row.getBoundingClientRect().height;
        row.style.overflow = 'hidden';
        const animation = motion(row, [{ opacity: 1, height: height + 'px', transform: 'translateY(0)' }, { opacity: 0, height: '0px', paddingTop: 0, paddingBottom: 0, transform: 'translateY(-8px)' }], 360);
        if (animation) animation.finished.catch(() => {}).then(() => row.remove());
        else row.remove();
      }
      timeline.visible.forEach((entry, index) => {
        let row = rendered.get(entry.id);
        let entering = false;
        if (!row) {
          row = document.createElement('article');
          row.innerHTML = '<div class="ja jls-ja" lang="ja"></div><div class="zh jls-zh"></div>';
          row.dataset.id = String(entry.id);
          rendered.set(entry.id, row);
          entering = true;
        }
        row.className = 'row jls-row caption-pair ' + (index === timeline.visible.length - 1 ? 'cur jls-cur' : 'prev jls-prev');
        row.setAttribute('aria-busy', String(!entry.zh && !entry.failed));
        const ja = row.querySelector('.ja');
        if (ja.textContent !== entry.ja) ja.textContent = entry.ja;
        const zh = row.querySelector('.zh');
        const firstTranslation = !zh.textContent && !!entry.zh;
        const oldHeight = row.isConnected ? row.getBoundingClientRect().height : 0;
        if (zh.textContent !== entry.zh) zh.textContent = entry.zh;
        zh.hidden = !entry.zh;
        row.hidden = !entry.zh && (!prefs.showJa || !entry.ja);
        if (entering) {
          const nextRow = timeline.visible.slice(index + 1).map(item => rendered.get(item.id)).find(item => item?.parentNode === rows);
          rows.insertBefore(row, nextRow || null);
          // Final Japanese must not fade out and re-enter while waiting for MT.
          // Only a new translation receives a fade; its source row stays opaque.
        }
        if (firstTranslation) {
          const height = row.getBoundingClientRect().height;
          if (oldHeight && height > oldHeight) {
            row.style.overflow = 'hidden';
            const animation = motion(row, [{ height: oldHeight + 'px' }, { height: height + 'px' }], 360);
            if (animation) animation.finished.catch(() => {}).then(() => row.style.removeProperty('overflow'));
            else row.style.removeProperty('overflow');
          }
          motion(zh, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], 360);
        }
      });
      const current = timeline.preview();
      const showLive = prefs.showJa && current;
      live.hidden = !showLive;
      live.querySelector('.ja').textContent = showLive ? current.ja : '';
      const containsText = timeline.visible.some(entry => entry.zh || (prefs.showJa && entry.ja));
      root.classList.toggle('empty', !containsText && !showLive && meta.hidden);
      catchUp.hidden = !timeline.pending.length;
      catchUp.textContent = '回到实时 · ' + timeline.pending.length;
      position();
    }
    const timeline = new CaptionTimeline({ onChange: render });

    function engagement() {
      if (destroyed) return;
      const on = hovered || keyboard || !!drag;
      root.classList.toggle('engaged', on);
      timeline.pause(document.hidden || keyboard || !!drag || !panel.hidden || (hovered && prefs.pauseOnHover));
    }
    function closePanel(restoreFocus = false) {
      panel.hidden = bridge.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
      engagement();
    }
    root.addEventListener('pointerenter', () => { clearTimeout(leaveTimer); hovered = true; engagement(); });
    root.addEventListener('pointerleave', () => {
      hovered = false;
      leaveTimer = setTimeout(() => {
        if (hovered) return;
        if (!keyboard && !drag) { closePanel(); shadow.activeElement?.blur(); }
        engagement();
      }, 180);
    });
    root.addEventListener('pointerdown', () => { keyboard = false; engagement(); });
    root.addEventListener('keydown', event => {
      keyboard = true;
      if (event.key === 'Escape') {
        if (!panel.hidden) closePanel(true);
        endDrag();
      }
      engagement();
    });
    root.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) keyboard = true; engagement(); });
    root.addEventListener('focusout', () => queueMicrotask(() => { if (!root.contains(shadow.activeElement)) keyboard = false; engagement(); }));
    toggle.addEventListener('click', event => {
      if (!event.detail) keyboard = true;
      panel.hidden = !panel.hidden;
      bridge.hidden = panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      placePanel();
      engagement();
      if (!panel.hidden) motion(panel, [{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }], 260);
    });
    catchUp.addEventListener('click', () => timeline.catchUp());

    function save() {
      revision++;
      try {
        const result = opts.saveSettings ? opts.saveSettings(prefs) : localStorage.setItem('jls.captionPrefs.v1', JSON.stringify(prefs));
        Promise.resolve(result).catch(() => {});
      } catch {}
    }
    function apply() {
      applyCaptionStyle(root, prefs);
      panel.dataset.theme = prefs.theme;
      editor?.update(prefs);
      if (!prefs.animations) cancelAnimations();
      timeline.speed(prefs.cps, prefs.minSeconds);
      engagement();
      placePanel();
    }
    function setSettings(value) {
      prefs = preferences(value);
      revision++;
      apply();
    }
    function rememberPosition(left, top) {
      const size = frame();
      const rect = root.getBoundingClientRect();
      prefs.position = {
        x: clamp((left - size.left - 12) / Math.max(1, size.width - rect.width - 24), 0, 1),
        y: clamp((top - size.top - 44) / Math.max(1, size.height - rect.height - 56), 0, 1),
      };
      editor?.update(prefs);
      position();
    }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, id: event.pointerId };
      handle.setPointerCapture(event.pointerId);
      root.classList.add('dragging');
      engagement();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const size = frame();
      const rect = root.getBoundingClientRect();
      const left = clamp(event.clientX - drag.dx - size.left, 12, Math.max(12, size.width - rect.width - 12));
      const top = clamp(event.clientY - drag.dy - size.top, 44, Math.max(44, size.height - rect.height - 12));
      root.style.left = left + 'px'; root.style.top = top + 'px';
      root.style.bottom = 'auto'; root.style.transform = 'none';
    });
    function endDrag() {
      if (!drag) return;
      const pointer = drag.id;
      drag = null;
      const rect = root.getBoundingClientRect();
      rememberPosition(rect.left, rect.top);
      root.classList.remove('dragging');
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      save(); engagement();
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, endDrag);
    global.addEventListener('pointerup', endDrag, true);
    global.addEventListener('blur', endDrag);
    handle.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta) return;
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const step = event.shiftKey ? 24 : 6;
      rememberPosition(rect.left + delta[0] * step, rect.top + delta[1] * step);
      save();
    });
    const onResize = () => {
      if (opts.embedded) root.style.setProperty('--caption-frame-height', host.clientHeight + 'px');
      position();
      placePanel();
    };
    const resize = new ResizeObserver(onResize);
    resize.observe(root);
    if (opts.embedded) resize.observe(host);
    if (editor) resize.observe(panel);
    const onVisibility = () => engagement();
    const onMotionPreference = () => {
      if (reduced.matches) cancelAnimations();
    };
    const onFullscreen = () => { if (host.parentNode !== mountPoint()) mountPoint().appendChild(host); onResize(); };
    global.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onMotionPreference);
    if (opts.fullscreen) document.addEventListener('fullscreenchange', onFullscreen);
    onResize();
    apply();
    engagement();
    const initialRevision = revision;
    Promise.resolve().then(() => opts.loadSettings ? opts.loadSettings() : JSON.parse(localStorage.getItem('jls.captionPrefs.v1') || '{}'))
      .then(saved => { if (!destroyed && revision === initialRevision) setSettings(saved); }).catch(() => {});

    return {
      host, root, setSettings,
      start(id) { root.classList.remove('hidden'); timeline.start(id); },
      text(id, kind, text) { root.classList.remove('hidden'); timeline.text(id, kind, text); },
      translation(id, text, final) { root.classList.remove('hidden'); timeline.translation(id, text, final); },
      translationFailed(id) { timeline.fail(id); },
      show() { root.classList.remove('hidden'); },
      hide() { root.classList.add('hidden'); },
      setMeta(text, error) {
        const detail = text || '';
        const hidden = !text || !error || !opts.showMeta;
        if (meta.textContent === detail && meta.hidden === hidden) return;
        meta.textContent = detail;
        meta.hidden = hidden;
        meta.classList.toggle('err', !!error);
        render();
      },
      toast(text, bad) {
        pill.textContent = text; pill.classList.toggle('bad', !!bad); pill.classList.add('on');
        clearTimeout(pillTimer); pillTimer = setTimeout(() => pill.classList.remove('on'), 4000);
      },
      clear() {
        cancelAnimations();
        endDrag(); hovered = keyboard = false; clearTimeout(leaveTimer);
        panel.hidden = bridge.hidden = true; toggle.setAttribute('aria-expanded', 'false'); root.classList.remove('engaged');
        meta.textContent = ''; meta.hidden = true; meta.classList.remove('err'); timeline.clear(); timeline.pause(document.hidden);
        rows.replaceChildren(); rendered.clear(); live.hidden = true; root.classList.add('empty');
        cancelAnimations();
      },
      get currentId() { return timeline.currentId; },
      get captionText() {
        const current = timeline.visible.at(-1), previous = timeline.visible.at(-2), source = timeline.preview();
        const liveSource = source?.ja || '';
        return { ja: prefs.showJa ? liveSource || current?.ja || '' : '', zh: current?.zh || '', prevJa: prefs.showJa ? previous?.ja || '' : '', prevZh: previous?.zh || '', meta: meta.textContent };
      },
      destroy() {
        cancelAnimations();
        destroyed = true; timeline.clear(); clearTimeout(pillTimer); clearTimeout(leaveTimer); resize.disconnect();
        global.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisibility);
        global.removeEventListener('pointerup', endDrag, true); global.removeEventListener('blur', endDrag);
        document.removeEventListener('fullscreenchange', onFullscreen); host.remove();
        reduced.removeEventListener('change', onMotionPreference);
      },
    };
  }
  Object.assign(global.JLS, { createCaptionOverlay, CaptionTimeline, captionReadingTime: readingTime, captionPreferences: preferences });
})();
