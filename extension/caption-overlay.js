/* Shared subtitle display for the extension and the local demo. */
(() => {
  'use strict';
  const global = typeof window === 'undefined' ? globalThis : window;
  global.JLS = global.JLS || {};
  if (global.JLS.createCaptionOverlay) return;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const DEFAULTS = { fontSize: 24, width: 80, background: 16, color: '#f3f6ff', showJa: true, cps: 6, position: null };
  function preferences(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    const out = { ...DEFAULTS };
    for (const [key, min, max] of [['fontSize', 16, 40], ['width', 40, 94], ['background', 0, 70], ['cps', 4, 10]]) {
      if (Number.isFinite(input[key])) out[key] = clamp(input[key], min, max);
    }
    if (typeof input.color === 'string' && /^#[\da-f]{6}$/i.test(input.color)) out.color = input.color;
    if (typeof input.showJa === 'boolean') out.showJa = input.showJa;
    if (input.position && Number.isFinite(input.position.x) && Number.isFinite(input.position.y)) {
      out.position = { x: clamp(input.position.x, 0, 1), y: clamp(input.position.y, 0, 1) };
    }
    return out;
  }

  function readingTime(text, cps = 6) {
    return clamp(1100 + Array.from(text.replace(/\s/g, '')).length / cps * 1000, 3000, 24000);
  }

  class CaptionTimeline {
    constructor(options = {}) {
      this.now = options.now || (() => performance.now());
      this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
      this.clearTimer = options.clearTimer || (timer => clearTimeout(timer));
      this.onChange = options.onChange || (() => {});
      this.cps = options.cps || 6;
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
      entry.deadline = entry.zh || entry.failed
        ? entry.shownAt + readingTime(entry.zh || entry.ja, this.cps)
        : entry.shownAt + 60000; // Beyond the translator's retries; never block a slot forever.
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
      this.visible = this.visible.filter(entry => {
        if (entry.deadline > now) return true;
        if (!entry.zh && !entry.failed) { entry.failed = true; this.beginReading(entry); return true; }
        entry.retired = true;
        return false;
      });
      this.fill();
      this.changed();
    }
    pause(on) {
      if (on && this.pauseAt === null) this.pauseAt = this.now();
      else if (!on && this.pauseAt !== null) {
        for (const entry of this.visible) {
          if (!Number.isFinite(entry.deadline)) continue;
          const elapsed = this.now() - Math.max(this.pauseAt, entry.shownAt);
          entry.deadline += elapsed; entry.shownAt += elapsed;
        }
        this.pauseAt = null;
      }
      this.changed();
    }
    speed(cps) {
      this.cps = cps;
      for (const entry of this.visible) {
        if (entry.zh || entry.failed) entry.deadline = entry.shownAt + readingTime(entry.zh || entry.ja, cps);
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
    .wrap {
      --font-size: 24px; --caption-width: 80vw; --rest-bg: .16; --caption-color: #f3f6ff;
      position: fixed; left: 50%; bottom: 6vh; transform: translateX(-50%);
      width: min(var(--caption-width), 1040px); min-width: min(320px, calc(100vw - 24px)); max-width: calc(100vw - 24px);
      padding: 15px 22px; border: 1px solid rgba(255,255,255,.035); border-radius: 18px;
      color: var(--caption-color); background: rgba(9,13,22,var(--rest-bg));
      backdrop-filter: blur(2px); box-shadow: 0 8px 32px #0000000a;
      text-align: center; font: 400 14px/1.5 "Segoe UI", "Yu Gothic UI", "Hiragino Sans", system-ui, sans-serif;
      z-index: 2147483647; pointer-events: auto; color-scheme: dark;
      transition: background .42s cubic-bezier(.22,1,.36,1), border-color .42s ease,
        box-shadow .42s ease, backdrop-filter .42s ease, opacity .42s ease;
    }
    .wrap.engaged { background: rgba(12,17,28,.93); border-color: #ffffff24;
      backdrop-filter: blur(18px); box-shadow: 0 16px 64px #0006; }
    .wrap.hidden { display: none; }
    .wrap.empty:not(.engaged) { opacity: 0; pointer-events: none; }
    .toolbar { position: absolute; bottom: calc(100% - 2px); left: 14px; right: 14px;
      display: flex; align-items: center; gap: 8px; padding-bottom: 9px;
      opacity: 0; transform: translateY(8px); pointer-events: none;
      transition: opacity .25s ease, transform .35s cubic-bezier(.22,1,.36,1); }
    .engaged .toolbar { opacity: 1; transform: none; pointer-events: auto; }
    button, input, select { font: inherit; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      border: 1px solid #ffffff1c; border-radius: 10px; padding: 7px 11px;
      background: #182131f5; color: #e5edf9; cursor: pointer; line-height: 1.25;
      font-size: 12px; transition: background .18s ease, border-color .18s ease; }
    button:hover { background: #28364c; border-color: #ffffff4a; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #91baff; outline-offset: 3px; }
    .drag { cursor: grab; touch-action: none; user-select: none; }
    .dragging .drag { cursor: grabbing; }
    .grip { letter-spacing: -2px; font-size: 17px; opacity: .65; }
    .toolbar .spacer { flex: 1; }
    .catch-up[hidden], [hidden] { display: none !important; }
    .rows { max-height: min(46vh, 420px); overflow-y: auto; overflow-x: hidden;
      overscroll-behavior: contain; overflow-anchor: none; scrollbar-width: none; }
    .rows::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .rows:focus-visible { outline: 1px solid #9bbdff80; outline-offset: 3px; border-radius: 8px; }
    .row { padding: 3px 0 8px; overflow-wrap: anywhere; }
    .row + .row { border-top: 1px solid #ffffff12; padding-top: 10px; }
    .ja { color: #edf2fc; font-size: calc(var(--font-size) * .69); line-height: 1.5; opacity: .76;
      text-shadow: 0 1px 3px #000, 0 2px 8px #000; }
    .zh { color: var(--caption-color); font-size: var(--font-size); font-weight: 600; line-height: 1.48;
      letter-spacing: .012em; margin-top: 3px; -webkit-text-stroke: .35px #0008;
      paint-order: stroke fill; text-shadow: 0 1px 3px #000, 0 2px 10px #000c;
      transition: font-size .32s cubic-bezier(.22,1,.36,1), color .25s ease; }
    .live { padding: 4px 0 0; }
    .live .ja { font-size: calc(var(--font-size) * .69); opacity: .76; }
    .no-ja .ja { display: none; }
    .meta { max-height: 0; overflow: hidden; opacity: 0; color: #a9b9d0;
      font-size: 11px; transition: opacity .25s ease, max-height .3s ease; }
    .engaged .meta:not(:empty) { max-height: 36px; opacity: 1; margin-top: 7px; }
    .meta.err { color: #ffb3b3; max-height: 48px; opacity: 1; }
    .settings { position: absolute; right: 0; bottom: calc(100% + 42px); width: min(310px, calc(100vw - 28px));
      max-height: min(70vh, 490px); overflow-y: auto; padding: 18px; text-align: left;
      background: #111927f5; border: 1px solid #ffffff24; border-radius: 16px;
      box-shadow: 0 20px 70px #0007; backdrop-filter: blur(20px); color: #eff4ff;
      font-size: 13px; }
    .settings.below { bottom: auto; top: calc(100% + 12px); }
    .settings-bridge { position: absolute; right: 0; bottom: 100%; width: min(310px, calc(100vw - 28px)); height: 44px; }
    .settings-bridge.below { bottom: auto; top: 100%; height: 16px; }
    .settings h2 { margin: 0 0 15px; font-size: 14px; font-weight: 600; }
    .setting { display: grid; grid-template-columns: 1fr auto; gap: 7px; margin: 13px 0; align-items: center; }
    .setting input[type=range] { grid-column: 1 / -1; width: 100%; margin: 2px 0; accent-color: #9bbdff; cursor: pointer; }
    output { color: #acbdd6; font-variant-numeric: tabular-nums; font-size: 12px; }
    input[type=color] { width: 38px; height: 27px; padding: 2px; border: 1px solid #ffffff30; border-radius: 6px; background: transparent; }
    input[type=checkbox] { accent-color: #9bbdff; width: 16px; height: 16px; }
    select { border: 1px solid #ffffff26; border-radius: 7px; background: #202d41; padding: 5px 7px; color: #edf3ff; font-size: 12px; }
    .note { margin: 13px 0; color: #99abc5; font-size: 11px; line-height: 1.65; }
    .reset { width: 100%; }
    .pill { position: fixed; top: 16px; right: 16px; padding: 8px 13px; max-width: calc(100vw - 32px);
      background: #111927ee; border: 1px solid #ffffff24; border-radius: 99px; color: #dce8ff;
      font: 12px/1.5 "Segoe UI", sans-serif; opacity: 0; transform: translateY(-7px);
      transition: opacity .25s ease, transform .35s cubic-bezier(.22,1,.36,1); }
    .pill.on { opacity: 1; transform: none; } .pill.bad { color: #ffb3b3; }
    @media (max-width: 520px) { .wrap { padding: 11px 13px; border-radius: 13px; } .settings { right: -3px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
  `;

  function createCaptionOverlay(options = {}) {
    const opts = { mount: document.body, showMeta: true, ...options };
    const host = document.createElement('div');
    host.id = opts.hostId || 'jls-demo-caption-host';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const root = document.createElement('section');
    root.className = 'wrap jls-captions empty';
    root.setAttribute('aria-label', '双语字幕');
    root.innerHTML = `
      <div class="settings-bridge" hidden aria-hidden="true"></div>
      <div class="toolbar">
        <button class="drag" type="button" aria-label="拖动字幕框，方向键微调" title="拖动移动，方向键微调"><span class="grip" aria-hidden="true">⠿</span> 移动</button>
        <span class="spacer"></span>
        <button class="catch-up" type="button" hidden title="跳过待读译文，显示最新一句">回到实时</button>
        <button class="settings-toggle" type="button" aria-expanded="false" aria-controls="jls-settings">⚙ 字幕样式</button>
      </div>
      <div class="rows" role="log" tabindex="0" aria-label="字幕，可滚动阅读" aria-live="polite" aria-relevant="additions text"></div>
      <div class="live" aria-live="off"><div class="ja jls-ja"></div></div>
      <div class="meta jls-meta"></div>
      <div class="settings" id="jls-settings" hidden>
        <h2>字幕样式</h2>
        <label class="setting">译文字号 <output data-output="fontSize"></output><input aria-label="译文字号" data-setting="fontSize" type="range" min="16" max="40" step="1"></label>
        <label class="setting">字幕宽度 <output data-output="width"></output><input aria-label="字幕宽度" data-setting="width" type="range" min="40" max="94" step="1"></label>
        <label class="setting">离开时的背景浓度 <output data-output="background"></output><input aria-label="离开时的背景浓度" data-setting="background" type="range" min="0" max="70" step="1"></label>
        <label class="setting">译文颜色 <input aria-label="译文颜色" data-setting="color" type="color"></label>
        <label class="setting">显示日语原文 <input data-setting="showJa" type="checkbox"></label>
        <label class="setting">阅读速度 <select data-setting="cps" aria-label="阅读速度"><option value="4">从容 · 4 字/秒</option><option value="6">标准 · 6 字/秒</option><option value="8">较快 · 8 字/秒</option><option value="10">快速 · 10 字/秒</option></select></label>
        <p class="note">译文按长度停留 3–24 秒。悬停时暂停计时；离开后背景淡出，文字保持清晰。</p>
        <button class="reset" type="button">恢复默认样式与位置</button>
      </div>`;
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
    let hovered = false, keyboard = false, pointerFocus = false, drag = null, destroyed = false, revision = 0;
    let pillTimer = null, saveTimer = null, leaveTimer = null;

    function motion(node, frames, duration) {
      if (reduced.matches || !node.animate) return null;
      const animation = node.animate(frames, { duration, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' });
      animations.add(animation);
      animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
      return animation;
    }
    function cancelAnimations() {
      for (const animation of animations) animation.cancel();
      animations.clear();
    }
    function position() {
      if (!prefs.position || drag) return;
      const rect = root.getBoundingClientRect();
      root.style.left = (12 + prefs.position.x * Math.max(0, innerWidth - rect.width - 24)) + 'px';
      root.style.top = (44 + prefs.position.y * Math.max(0, innerHeight - rect.height - 56)) + 'px';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
    }
    function placePanel() {
      const rect = root.getBoundingClientRect();
      const above = rect.top - 48, below = innerHeight - rect.bottom - 20;
      panel.classList.toggle('below', below > above);
      bridge.classList.toggle('below', below > above);
      panel.style.maxHeight = Math.max(64, Math.min(490, Math.max(above, below))) + 'px';
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
          row.innerHTML = '<div class="ja jls-ja"></div><div class="zh jls-zh"></div>';
          row.dataset.id = String(entry.id);
          rendered.set(entry.id, row);
          entering = true;
        }
        row.className = 'row jls-row ' + (index === timeline.visible.length - 1 ? 'cur jls-cur' : 'prev jls-prev');
        row.setAttribute('aria-busy', String(!entry.zh && !entry.failed));
        const ja = row.querySelector('.ja');
        if (ja.textContent !== entry.ja) ja.textContent = entry.ja;
        const zh = row.querySelector('.zh');
        const firstTranslation = !zh.textContent && !!entry.zh;
        const oldHeight = row.isConnected ? row.getBoundingClientRect().height : 0;
        if (zh.textContent !== entry.zh) zh.textContent = entry.zh;
        zh.hidden = !entry.zh;
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
      root.classList.toggle('empty', !timeline.visible.length && !showLive && !meta.classList.contains('err'));
      catchUp.hidden = !timeline.pending.length;
      catchUp.textContent = '回到实时 · ' + timeline.pending.length;
      position();
    }
    const timeline = new CaptionTimeline({ onChange: render });

    function engagement() {
      const on = hovered || keyboard || !!drag;
      root.classList.toggle('engaged', on);
      timeline.pause(on || document.hidden);
    }
    root.addEventListener('pointerenter', () => { clearTimeout(leaveTimer); hovered = true; engagement(); });
    root.addEventListener('pointerleave', () => {
      hovered = false;
      leaveTimer = setTimeout(() => {
        if (hovered) return;
        if (!keyboard && !drag) { panel.hidden = bridge.hidden = true; toggle.setAttribute('aria-expanded', 'false'); shadow.activeElement?.blur(); }
        engagement();
      }, 180);
    });
    root.addEventListener('pointerdown', () => { pointerFocus = true; keyboard = false; engagement(); });
    root.addEventListener('keydown', event => {
      keyboard = true;
      pointerFocus = false;
      if (event.key === 'Escape') { panel.hidden = bridge.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
      if (event.key === 'Escape') endDrag();
      engagement();
    });
    root.addEventListener('focusin', event => { if (!pointerFocus && event.target.matches(':focus-visible')) keyboard = true; engagement(); });
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
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          const result = opts.saveSettings ? opts.saveSettings(prefs) : localStorage.setItem('jls.captionPrefs.v1', JSON.stringify(prefs));
          Promise.resolve(result).catch(() => {});
        } catch {}
      }, 180);
    }
    function apply() {
      root.style.setProperty('--font-size', prefs.fontSize + 'px');
      root.style.setProperty('--caption-width', prefs.width + 'vw');
      root.style.setProperty('--rest-bg', String(prefs.background / 100));
      root.style.setProperty('--caption-color', prefs.color);
      root.classList.toggle('no-ja', !prefs.showJa);
      for (const input of panel.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = prefs[key];
        else input.value = String(prefs[key]);
        const output = panel.querySelector('[data-output="' + key + '"]');
        if (output) output.textContent = prefs[key] + (key === 'fontSize' ? ' px' : '%');
      }
      timeline.speed(prefs.cps);
      position();
      placePanel();
    }
    panel.addEventListener('input', event => {
      const key = event.target.dataset.setting;
      if (!key) return;
      const value = key === 'showJa' ? event.target.checked : key === 'color' ? event.target.value : Number(event.target.value);
      prefs = preferences({ ...prefs, [key]: value });
      apply();
      save();
    });
    root.querySelector('.reset').addEventListener('click', () => {
      prefs = preferences();
      for (const key of ['left', 'top', 'bottom', 'transform']) root.style.removeProperty(key);
      apply(); save();
    });
    function rememberPosition(left, top) {
      const rect = root.getBoundingClientRect();
      prefs.position = {
        x: clamp((left - 12) / Math.max(1, innerWidth - rect.width - 24), 0, 1),
        y: clamp((top - 44) / Math.max(1, innerHeight - rect.height - 56), 0, 1),
      };
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
      const rect = root.getBoundingClientRect();
      const left = clamp(event.clientX - drag.dx, 12, Math.max(12, innerWidth - rect.width - 12));
      const top = clamp(event.clientY - drag.dy, 44, Math.max(44, innerHeight - rect.height - 12));
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
    const resize = new ResizeObserver(() => { position(); placePanel(); });
    resize.observe(root);
    const onResize = () => { position(); placePanel(); };
    const onVisibility = () => engagement();
    const onMotionPreference = () => {
      if (reduced.matches) cancelAnimations();
    };
    const onFullscreen = () => { if (host.parentNode !== mountPoint()) mountPoint().appendChild(host); onResize(); };
    global.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onMotionPreference);
    if (opts.fullscreen) document.addEventListener('fullscreenchange', onFullscreen);
    meta.hidden = !opts.showMeta;
    apply();
    engagement();
    const initialRevision = revision;
    Promise.resolve().then(() => opts.loadSettings ? opts.loadSettings() : JSON.parse(localStorage.getItem('jls.captionPrefs.v1') || '{}'))
      .then(saved => { if (!destroyed && revision === initialRevision) { prefs = preferences(saved || {}); apply(); } }).catch(() => {});

    return {
      host, root,
      start(id) { root.classList.remove('hidden'); timeline.start(id); },
      text(id, kind, text) { root.classList.remove('hidden'); timeline.text(id, kind, text); },
      translation(id, text, final) { root.classList.remove('hidden'); timeline.translation(id, text, final); },
      translationFailed(id) { timeline.fail(id); },
      show() { root.classList.remove('hidden'); },
      hide() { root.classList.add('hidden'); },
      setMeta(text, error) { meta.textContent = text || ''; meta.classList.toggle('err', !!error); render(); },
      toast(text, bad) {
        pill.textContent = text; pill.classList.toggle('bad', !!bad); pill.classList.add('on');
        clearTimeout(pillTimer); pillTimer = setTimeout(() => pill.classList.remove('on'), 4000);
      },
      clear() {
        cancelAnimations();
        endDrag(); hovered = keyboard = false; clearTimeout(leaveTimer);
        panel.hidden = bridge.hidden = true; toggle.setAttribute('aria-expanded', 'false'); root.classList.remove('engaged');
        meta.textContent = ''; meta.classList.remove('err'); timeline.clear(); timeline.pause(document.hidden);
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
        destroyed = true; timeline.clear(); clearTimeout(pillTimer); clearTimeout(saveTimer); clearTimeout(leaveTimer); resize.disconnect();
        global.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisibility);
        global.removeEventListener('pointerup', endDrag, true); global.removeEventListener('blur', endDrag);
        document.removeEventListener('fullscreenchange', onFullscreen); host.remove();
        reduced.removeEventListener('change', onMotionPreference);
      },
    };
  }
  Object.assign(global.JLS, { createCaptionOverlay, CaptionTimeline, captionReadingTime: readingTime, captionPreferences: preferences });
})();
