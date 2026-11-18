/* Shared public preferences, caption styling and editor for all three surfaces. */
(() => {
  'use strict';

  const JLS = globalThis.JLS ||= {};
  const ranges = {
    fontSize: [16, 40, 1, 24, ' px'],
    sourceSize: [12, 36, 1, 17, ' px'],
    lineHeight: [1.2, 1.9, 0.1, 1.5, ''],
    outline: [0, 2, 0.25, 0.5, ' px'],
    width: [40, 94, 1, 80, '%'],
    background: [0, 70, 1, 16, '%'],
    focusBackground: [75, 100, 1, 93, '%'],
    radius: [0, 28, 1, 16, ' px'],
    cps: [4, 10, 1, 6, ' 字/秒'],
    minSeconds: [1, 10, 1, 3, ' 秒'],
  };
  const choices = {
    font: { system: '无衬线', serif: '衬线', mono: '等宽' },
    align: { center: '居中', left: '左对齐', right: '右对齐' },
    order: { source: '日语在上', translation: '译文在上' },
    anchor: { bottom: '底部', middle: '中部', top: '顶部' },
    theme: { system: '跟随系统', light: '浅色', dark: '深色' },
  };
  const colors = { color: '#f3f6ff', sourceColor: '#dcebe3', backgroundColor: '#101f1b' };
  const switches = { showJa: true, shadow: true, pauseOnHover: true, animations: true };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const defaults = {
    ...Object.fromEntries(Object.entries(ranges).map(([key, range]) => [key, range[3]])),
    ...Object.fromEntries(Object.entries(choices).map(([key, options]) => [key, Object.keys(options)[0]])),
    ...colors,
    ...switches,
    position: null,
  };

  function sanitizeCaptionSettings(input) {
    const result = {};
    if (!input || typeof input !== 'object') return result;
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (Number.isFinite(input[key])) result[key] = clamp(input[key], min, max);
    }
    for (const [key, options] of Object.entries(choices)) {
      if (typeof input[key] === 'string' && Object.hasOwn(options, input[key])) result[key] = input[key];
    }
    for (const key of Object.keys(colors)) {
      if (typeof input[key] === 'string' && /^#[\da-f]{6}$/i.test(input[key])) result[key] = input[key].toLowerCase();
    }
    for (const key of Object.keys(switches)) {
      if (typeof input[key] === 'boolean') result[key] = input[key];
    }
    if (input.position === null) result.position = null;
    else if (Number.isFinite(input.position?.x) && Number.isFinite(input.position?.y)) {
      result.position = { x: clamp(input.position.x, 0, 1), y: clamp(input.position.y, 0, 1) };
    }
    return result;
  }

  function captionPreferences(input) {
    const saved = sanitizeCaptionSettings(input);
    // Older settings sized Japanese relative to the translation.
    if (saved.sourceSize === undefined && saved.fontSize !== undefined) {
      saved.sourceSize = clamp(Math.round(saved.fontSize * 0.69), 12, 36);
    }
    return { ...defaults, ...saved };
  }

  const appearanceKeys = ['fontSize', 'sourceSize', 'lineHeight', 'outline', 'width', 'background',
    'focusBackground', 'radius', 'font', 'align', 'order', 'color', 'sourceColor', 'backgroundColor', 'shadow'];
  const standard = Object.fromEntries(appearanceKeys.map(key => [key, defaults[key]]));
  const presets = {
    standard: { label: '均衡', values: standard },
    clear: { label: '轻透', values: { ...standard, background: 0, outline: 0.75, radius: 12 } },
    contrast: {
      label: '高对比',
      values: { ...standard, fontSize: 28, sourceSize: 20, color: '#ffffff', sourceColor: '#ffffff',
        backgroundColor: '#000000', background: 70, focusBackground: 100, outline: 1, radius: 10 },
    },
  };
  const fonts = {
    system: '"Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", "Yu Gothic UI", system-ui, sans-serif',
    serif: '"Noto Serif CJK SC", "Songti SC", "Yu Mincho", Georgia, serif',
    mono: 'ui-monospace, "Noto Sans Mono CJK SC", "Yu Gothic UI", monospace',
  };

  // Only normalized preferences may reach CSS custom properties.
  function applyCaptionStyle(node, prefs) {
    const variables = {
      '--font-size': prefs.fontSize + 'px',
      '--source-size': prefs.sourceSize + 'px',
      '--caption-width': prefs.width + '%',
      '--rest-bg': prefs.background / 100,
      '--focus-bg': prefs.focusBackground / 100,
      '--caption-bg': prefs.backgroundColor.match(/[\da-f]{2}/g).map(pair => parseInt(pair, 16)).join(','),
      '--caption-color': prefs.color,
      '--source-color': prefs.sourceColor,
      '--caption-radius': prefs.radius + 'px',
      '--caption-font': fonts[prefs.font],
      '--caption-align': prefs.align,
      '--caption-leading': prefs.lineHeight,
      '--caption-stroke': prefs.outline + 'px',
      '--caption-shadow': prefs.shadow ? '0 1px 3px #000, 0 2px 8px #000d' : 'none',
    };
    for (const [key, value] of Object.entries(variables)) node.style.setProperty(key, String(value));
    node.classList.toggle('no-ja', !prefs.showJa);
    node.classList.toggle('translation-first', prefs.order === 'translation');
    node.classList.toggle('no-motion', !prefs.animations);
    node.dataset.anchor = prefs.anchor;
  }

  const captionTextCSS = `
    .caption-appearance { text-align: var(--caption-align); }
    .caption-appearance .ja, .caption-appearance .zh {
      font-family: var(--caption-font);
      line-height: var(--caption-leading);
      overflow-wrap: anywhere;
      text-shadow: var(--caption-shadow);
      -webkit-text-stroke: var(--caption-stroke) #000b;
      paint-order: stroke fill;
    }
    .caption-appearance .ja { color: var(--source-color); font-size: var(--source-size); }
    .caption-appearance .zh { color: var(--caption-color); font-size: var(--font-size); font-weight: 620; }
    .caption-appearance .caption-pair, .caption-appearance.caption-pair { display: flex; flex-direction: column; gap: 3px; }
    .caption-appearance.translation-first .caption-pair, .caption-appearance.translation-first.caption-pair { flex-direction: column-reverse; }
    .caption-appearance.no-ja .ja { display: none; }
  `;

  const groups = [
    { id: 'text', label: '文字', fields: [
      ['fontSize', '译文字号'], ['sourceSize', '日语字号'],
      ['color', '译文颜色'], ['sourceColor', '日语颜色'],
      ['font', '字体'], ['align', '对齐'],
      ['outline', '描边'], ['lineHeight', '行距'],
      ['showJa', '显示日语'], ['shadow', '文字阴影'], ['order', '上下顺序', true],
    ] },
    { id: 'surface', label: '底板', fields: [
      ['backgroundColor', '底板颜色'], ['anchor', '字幕位置'],
      ['background', '平时不透明度'], ['focusBackground', '悬停不透明度'],
      ['width', '字幕宽度'], ['radius', '圆角'],
      ['theme', '界面主题', true],
    ] },
    { id: 'reading', label: '阅读', fields: [
      ['cps', '阅读速度'], ['minSeconds', '最短停留'],
      ['pauseOnHover', '悬停暂停'], ['animations', '字幕动画'],
    ] },
  ];
  let editorId = 0;

  function field([key, label, wide]) {
    const data = `data-setting="${key}"`;
    if (ranges[key]) {
      const [min, max, step] = ranges[key];
      return `<label class="setting control-range"><span>${label}</span><output data-output="${key}"></output>
        <input aria-label="${label}" ${data} type="range" min="${min}" max="${max}" step="${step}"></label>`;
    }
    const options = choices[key];
    if (options) {
      return `<label class="setting control-select${wide ? ' wide' : ''}"><span>${label}</span>
        <select ${data}>${Object.entries(options).map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}
        ${key === 'anchor' ? '<option value="custom" disabled>已拖动定位</option>' : ''}</select></label>`;
    }
    const color = Object.hasOwn(colors, key);
    return `<label class="setting control-inline"><span>${label}</span><input ${data} type="${color ? 'color' : 'checkbox'}" ${color ? '' : 'role="switch"'}></label>`;
  }

  const editorCSS = `
    .caption-editor { color: var(--ui-text); font: 500 14px/1.4 var(--ui-font, system-ui, sans-serif); }
    .caption-editor *, .caption-editor *::before, .caption-editor *::after { box-sizing: border-box; }
    .caption-editor [hidden] { display: none !important; }
    .caption-editor button, .caption-editor input, .caption-editor select { font: inherit; color: inherit; }
    .caption-editor button, .caption-editor select { cursor: pointer; }
    .caption-editor :is(button, input, select):focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
    .caption-editor .editor-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
    .caption-editor h2 { font-size: 18px; font-weight: 700; margin: 0; letter-spacing: -.025em; }
    .caption-editor .editor-actions { display: flex; gap: 5px; align-items: center; }
    .caption-editor .editor-actions button {
      min-height: 32px; padding: 5px 8px; border: 1px solid transparent; border-radius: 8px;
      background: transparent; color: var(--ui-muted);
    }
    .caption-editor .editor-actions button:hover { background: var(--ui-tint); color: var(--ui-text); }
    .caption-editor .editor-actions .editor-close { width: 32px; font-size: 21px; line-height: 1; }
    .caption-editor .preset-list, .caption-editor .group-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
    .caption-editor .preset-list { margin-bottom: 12px; }
    .caption-editor .preset-list button {
      min-height: 36px; padding: 6px 4px; border: 1px solid var(--ui-line); border-radius: 9px;
      background: var(--ui-surface); white-space: nowrap;
    }
    .caption-editor .preset-list button:hover { background: var(--ui-tint); }
    .caption-editor .preset-list button[aria-pressed="true"] {
      color: var(--ui-accent-text); background: var(--ui-tint); border-color: var(--ui-accent);
    }
    .caption-editor .group-tabs { padding: 4px; border-radius: 11px; background: var(--ui-well); margin-bottom: 12px; }
    .caption-editor .group-tabs button {
      min-height: 31px; padding: 4px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--ui-muted);
    }
    .caption-editor .group-tabs button:hover { color: var(--ui-text); }
    .caption-editor .group-tabs button[aria-pressed="true"] {
      color: var(--ui-text); background: var(--ui-surface); border-color: var(--ui-line); box-shadow: 0 1px 2px #10221a0c;
    }
    .caption-editor .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 16px; }
    .caption-editor .setting { display: grid; align-items: center; gap: 5px; min-width: 0; }
    .caption-editor .wide { grid-column: 1 / -1; }
    .caption-editor .control-range, .caption-editor .control-inline { grid-template-columns: minmax(0, 1fr) auto; }
    .caption-editor .control-inline { min-height: 34px; }
    .caption-editor output { color: var(--ui-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .caption-editor input[type=range] { grid-column: 1 / -1; width: 100%; height: 20px; margin: 0; accent-color: var(--ui-accent); cursor: pointer; }
    .caption-editor input[type=color] {
      width: 36px; height: 30px; padding: 3px; border: 1px solid var(--ui-line); border-radius: 8px;
      background: var(--ui-surface); cursor: pointer;
    }
    .caption-editor input[type=checkbox] {
      appearance: none; display: inline-grid; align-items: center; width: 36px; height: 22px; margin: 0;
      padding: 2px; border: 1px solid var(--ui-line); border-radius: 99px; background: var(--ui-well); cursor: pointer;
    }
    .caption-editor input[type=checkbox]::before {
      content: ""; width: 15px; height: 15px; border-radius: 100%; background: var(--ui-muted); transition: transform .18s ease;
    }
    .caption-editor input[type=checkbox]:checked { background: var(--ui-accent); border-color: var(--ui-accent); }
    .caption-editor input[type=checkbox]:checked::before { transform: translateX(14px); background: var(--ui-on-accent); }
    .caption-editor select {
      width: 100%; min-height: 34px; border: 1px solid var(--ui-line); border-radius: 8px; background: var(--ui-surface); padding: 5px 7px;
    }
    .caption-preview {
      position: relative; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-height: 140px;
      padding: 12px; background: radial-gradient(ellipse at 50% 0%, #365c4f, #172e26 70%);
      border-radius: 12px; overflow: hidden;
    }
    .caption-preview[data-anchor="top"] { justify-content: flex-start; }
    .caption-preview[data-anchor="middle"] { justify-content: center; }
    .caption-preview .caption-appearance {
      width: var(--caption-width); padding: 7px 12px; border-radius: var(--caption-radius);
      background: rgba(var(--caption-bg), var(--rest-bg));
    }
    .caption-preview .caption-appearance:hover { background: rgba(var(--caption-bg), var(--focus-bg)); }
    .caption-preview .caption-appearance.positioned {
      position: absolute; left: var(--preview-x); top: var(--preview-y);
      transform: translate(calc(-1 * var(--preview-x)), calc(-1 * var(--preview-y)));
    }
    @media (prefers-reduced-motion: reduce) { .caption-editor *, .caption-editor *::before { transition: none !important; } }
  `;

  function createCaptionEditor(mount, { onChange, onClose } = {}) {
    const id = ++editorId;
    const root = document.createElement('section');
    root.className = 'caption-editor';
    root.innerHTML = `
      <style>${editorCSS}${captionTextCSS}</style>
      <div class="editor-head">
        <h2>字幕设置</h2>
        <div class="editor-actions">
          <button class="reset" type="button">恢复默认</button>
          ${onClose ? '<button class="editor-close" type="button" aria-label="关闭字幕设置">×</button>' : ''}
        </div>
      </div>
      <div class="preset-list" role="group" aria-label="字幕预设">
        ${Object.entries(presets).map(([key, preset]) => `<button type="button" data-preset="${key}" aria-pressed="false">${preset.label}</button>`).join('')}
      </div>
      <div class="group-tabs" role="group" aria-label="字幕设置分类">
        ${groups.map(group => `<button type="button" data-group="${group.id}" aria-controls="jls-group-${id}-${group.id}" aria-pressed="false">${group.label}</button>`).join('')}
      </div>
      ${groups.map(group => `<div class="field-grid" id="jls-group-${id}-${group.id}" data-fields="${group.id}">${group.fields.map(field).join('')}</div>`).join('')}`;
    mount.append(root);

    const controls = [...root.querySelectorAll('[data-setting]')];
    const outputs = new Map([...root.querySelectorAll('[data-output]')].map(el => [el.dataset.output, el]));
    const presetButtons = [...root.querySelectorAll('[data-preset]')];
    const groupButtons = [...root.querySelectorAll('[data-group]')];
    const sections = [...root.querySelectorAll('[data-fields]')];
    let prefs = captionPreferences();

    function selectGroup(id) {
      for (const button of groupButtons) button.setAttribute('aria-pressed', String(button.dataset.group === id));
      for (const section of sections) section.hidden = section.dataset.fields !== id;
    }

    function update(value) {
      prefs = captionPreferences(value);
      for (const control of controls) {
        const key = control.dataset.setting;
        if (control.type === 'checkbox') control.checked = prefs[key];
        else {
          const value = key === 'anchor' && prefs.position ? 'custom' : String(prefs[key]);
          if (control.value !== value) control.value = value;
        }
        const output = outputs.get(key);
        if (output) output.textContent = prefs[key] + ranges[key][4];
      }
      for (const button of presetButtons) {
        const values = presets[button.dataset.preset].values;
        button.setAttribute('aria-pressed', String(Object.keys(values).every(key => values[key] === prefs[key])));
      }
    }

    function change(next, commit = true) {
      update(next);
      onChange?.(prefs, commit);
    }
    function edit(event) {
      const control = event.target;
      const key = control.dataset.setting;
      if (!key) return;
      const value = control.type === 'checkbox' ? control.checked : control.type === 'range' ? Number(control.value) : control.value;
      const next = { ...prefs, [key]: value };
      if (key === 'anchor') next.position = null;
      change(next, event.type === 'change');
    }
    root.addEventListener('input', edit);
    root.addEventListener('change', edit);
    for (const button of groupButtons) button.addEventListener('click', () => selectGroup(button.dataset.group));
    for (const button of presetButtons) button.addEventListener('click', () => change({ ...prefs, ...presets[button.dataset.preset].values }));
    root.querySelector('.reset').addEventListener('click', () => change(defaults));
    if (onClose) root.querySelector('.editor-close').addEventListener('click', onClose);
    selectGroup('text');
    update(prefs);
    return { update };
  }

  function createCaptionPreview(mount, { compact = false } = {}) {
    const root = document.createElement('div');
    root.className = 'caption-preview';
    root.innerHTML = '<div class="caption-appearance caption-pair"><div class="ja" lang="ja"></div><div class="zh"></div></div>';
    mount.append(root);
    const box = root.firstElementChild;
    box.querySelector('.ja').textContent = compact ? 'ライブを楽しもう！' : '次の曲も、一緒に楽しみましょう。';
    const sample = compact
      ? { en: 'Enjoy the show!', zh: '一起享受直播吧！' }
      : { en: 'Let’s enjoy the next song together.', zh: '下一首歌，也一起享受吧。' };
    const translated = box.querySelector('.zh');
    return { update(prefs, target) {
      root.dataset.anchor = prefs.anchor;
      translated.textContent = target === 'en' ? sample.en : sample.zh;
      translated.lang = target === 'en' ? 'en' : 'zh-CN';
      applyCaptionStyle(box, prefs);
      box.classList.toggle('positioned', !!prefs.position);
      if (prefs.position) {
        box.style.setProperty('--preview-x', prefs.position.x * 100 + '%');
        box.style.setProperty('--preview-y', prefs.position.y * 100 + '%');
      }
    } };
  }

  Object.assign(JLS, { sanitizeCaptionSettings, captionPreferences, applyCaptionStyle, captionTextCSS, createCaptionEditor, createCaptionPreview });
})();
