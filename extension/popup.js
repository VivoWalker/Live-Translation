/* Edit capture settings and preview the caption style before or during playback. */
'use strict';

const DEFAULT_SERVER = 'ws://127.0.0.1:8765/ws';
const $ = id => document.getElementById(id);
const startButton = $('start');
const stopButton = $('stop');
const engine = $('engine');
const target = $('target');
const domainField = $('asr-domain-field');
const packIds = JLSASRDomain.packs;
const packInput = id => $('asr-pack-' + id);
const selectedPacks = () => packIds.filter(id => packInput(id).checked);
const apiKey = $('apikey');
const server = $('server');
const serverToken = $('server-token');
const domainMode = $('domain-mode');
const contextTurns = $('context-turns');
const vadSilence = $('vad-silence');
const vadSegment = $('vad-segment');
const agentMode = $('agent-mode');
const fallback = $('browser-fallback');
const sessionFields = [engine, target, apiKey, server, serverToken, domainMode, contextTurns, vadSilence, vadSegment, agentMode];
const settingKeys = ['jlsEngine', 'jlsTarget', 'jlsApiKey', 'jlsServer', 'jlsServerToken',
  'jlsDomainMode', 'jlsContextTurns', 'jlsVadSilence', 'jlsVadSegment', 'jlsAgentMode'];
const choice = (value, allowed, defaultValue) => allowed.includes(value) ? value : defaultValue;
let activeTab, phase = 'idle', operation = 0, ready = false, cacheInfo;
let prefs = JLS.captionPreferences();
const preview = JLS.createCaptionPreview($('caption-preview'), { compact: true });
const editor = JLS.createCaptionEditor($('caption-editor'), {
  onChange(settings, commit) {
    applySettings(settings);
    if (commit) {
      chrome.runtime.sendMessage({ type: 'jls:caption-settings-set', settings })
        .then(response => { if (!response?.ok) showMessage('字幕设置未能保存', true); })
        .catch(() => showMessage('字幕设置未能保存', true));
    }
  },
});

function applySettings(value) {
  prefs = JLS.captionPreferences(value);
  document.documentElement.dataset.theme = prefs.theme;
  editor.update(prefs);
  preview.update(prefs, target.value);
}

function showMessage(message, error = false) {
  const notice = $('message');
  notice.hidden = !message;
  notice.textContent = message || '';
  notice.dataset.kind = error ? 'error' : '';
}

function setPhase(next, message) {
  phase = next;
  const active = ['starting', 'connected', 'capturing', 'degraded', 'stopping'].includes(phase);
  const labels = { idle: '待开始', starting: '准备中', connected: '已连接', capturing: '字幕运行中',
    degraded: '处理延迟', stopping: '正在停止', error: '需要处理' };
  $('status').textContent = labels[phase] || labels.idle;
  $('capture-status').dataset.phase = phase === 'error' ? 'error'
    : ['connected', 'capturing'].includes(phase) ? 'live' : active ? 'busy' : 'idle';
  startButton.hidden = active;
  startButton.disabled = !ready || active;
  stopButton.hidden = !active;
  stopButton.disabled = phase === 'stopping';
  fallback.hidden = phase !== 'error' || engine.value === 'browser';
  for (const field of sessionFields) field.disabled = active;
  domainField.disabled = active;
  showMessage(message, phase === 'error');
}

function renderCaptureStatus(status) {
  if (phase === 'stopping' || !status?.phase) return;
  if (phase === 'starting' && status.phase === 'idle') return;
  setPhase(status.phase, ['error', 'starting', 'degraded', 'capturing'].includes(status.phase) ? status.message : '');
}

function renderFields() {
  const browser = engine.value === 'browser';
  for (const id of ['apikey-field', 'vad-silence-field', 'vad-segment-field']) $(id).hidden = !browser;
  $('asr-domain-field').hidden = !browser || domainMode.value !== 'manual';
  for (const id of ['server-field', 'token-field', 'agent-field', 'service-note']) $(id).hidden = browser;
  const cache = $('model-cache-status');
  cache.hidden = !browser || !(cacheInfo?.saved || cacheInfo?.warning);
  cache.textContent = cacheInfo?.warning ? cacheInfo.message : cacheInfo?.saved ? '识别模型已缓存' : '';
  cache.className = 'model-cache' + (cacheInfo?.warning ? ' warning' : '');
}

function showPanel(captions) {
  $('session-tab').setAttribute('aria-pressed', String(!captions));
  $('caption-tab').setAttribute('aria-pressed', String(captions));
  $('session-panel').hidden = captions;
  $('caption-panel').hidden = !captions;
  $('menu-content').scrollTop = 0;
  if (captions) preview.update(prefs, target.value);
}
$('session-tab').addEventListener('click', () => showPanel(false));
$('caption-tab').addEventListener('click', () => showPanel(true));
fallback.addEventListener('click', () => {
  engine.value = 'browser';
  engine.dispatchEvent(new Event('change'));
  setPhase('idle');
});

function focusRequiredField(field, message) {
  showPanel(false);
  setPhase('error', message);
  field.focus();
}

async function init() {
  const [[tab], store, capture] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get([...settingKeys, 'jlsModelCache', 'jlsAsrDomain', 'jlsAsrPacks', 'jlsCaptionPrefs']),
    chrome.runtime.sendMessage({ type: 'jls:query' }).catch(() => null),
  ]);
  activeTab = tab;
  $('tab-title').textContent = tab?.title || tab?.url || '没有可用标签页';
  $('tab-title').title = $('tab-title').textContent;
  target.value = store.jlsTarget === 'en' ? 'en' : 'zh';
  engine.value = choice(store.jlsEngine, ['server', 'server-enhanced'], 'browser');
  domainMode.value = choice(store.jlsDomainMode, ['auto', 'off'], 'manual');
  contextTurns.value = choice(store.jlsContextTurns, ['3', '4', '5'], '1');
  vadSilence.value = choice(store.jlsVadSilence, ['0.4', '0.6', '0.8'], '0.4');
  vadSegment.value = choice(store.jlsVadSegment, ['8', '12', '16'], '12');
  agentMode.value = choice(store.jlsAgentMode, ['on', 'off'], 'default');
  server.value = store.jlsServer || DEFAULT_SERVER;
  apiKey.value = store.jlsApiKey || '';
  serverToken.value = store.jlsServerToken || '';
  let enabled = packIds;
  try { enabled = JLSASRDomain.normalizePacks(store.jlsAsrPacks ?? store.jlsAsrDomain); } catch {}
  for (const id of packIds) packInput(id).checked = enabled.includes(id);
  cacheInfo = store.jlsModelCache;
  applySettings(store.jlsCaptionPrefs);
  renderFields();
  const { jlsStatus: currentStatus } = await chrome.storage.session.get('jlsStatus');
  ready = true;
  if (capture?.running) renderCaptureStatus(currentStatus?.phase === 'idle' || !currentStatus ? { phase: 'starting' } : currentStatus);
  else setPhase(currentStatus?.phase === 'error' ? 'error' : 'idle', currentStatus?.phase === 'error' ? currentStatus.message : '');

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.jlsStatus) renderCaptureStatus(changes.jlsStatus.newValue);
    if (area !== 'local') return;
    if (changes.jlsCaptionPrefs) applySettings(changes.jlsCaptionPrefs.newValue);
    if (changes.jlsModelCache) {
      cacheInfo = changes.jlsModelCache.newValue;
      renderFields();
    }
  });

  domainField.addEventListener('change', () => {
    chrome.storage.local.set({ jlsAsrPacks: selectedPacks() }).catch(() => {});
  });
  sessionFields.forEach((field, index) => field.addEventListener('change', () => {
    chrome.storage.local.set({ [settingKeys[index]]: field.value.trim() }).catch(() => {});
    if (field === engine || field === domainMode) renderFields();
    if (field === target) preview.update(prefs, target.value);
    if (phase === 'error') setPhase('idle');
  }));
}

startButton.addEventListener('click', async () => {
  if (!ready || !['idle', 'error'].includes(phase)) return;
  if (!activeTab?.id || /^(chrome|edge|about|chrome-extension):/.test(activeTab.url || '')) {
    setPhase('error', '请打开带有音频的普通网页');
    return;
  }
  const browser = engine.value === 'browser';
  const config = {
    tabId: activeTab.id, target: target.value, engine: engine.value, asrPacks: selectedPacks(),
    serverUrl: server.value.trim() || DEFAULT_SERVER, apiKey: apiKey.value.trim(), serverToken: serverToken.value.trim(),
    domainMode: domainMode.value, pageTitle: domainMode.value === 'auto' ? activeTab.title : undefined,
    contextTurns: Number(contextTurns.value),
    vad: browser ? { minSilence: Number(vadSilence.value), maxSegment: Number(vadSegment.value) } : undefined,
    localMode: browser ? undefined : engine.value === 'server-enhanced' ? 'enhanced' : 'fast',
    agent: browser ? undefined : agentMode.value === 'on' || agentMode.value === 'default' && engine.value === 'server-enhanced',
  };
  if (browser && !config.apiKey) {
    focusRequiredField(apiKey, '请填写 DeepSeek API Key');
    return;
  }
  if (!browser && !config.serverToken) {
    focusRequiredField(serverToken, '请填写本地服务访问令牌');
    return;
  }
  if (!browser) {
    try {
      if (!['ws:', 'wss:'].includes(new URL(config.serverUrl).protocol)) throw new Error();
    } catch {
      focusRequiredField(server, '请输入以 ws:// 或 wss:// 开头的服务地址');
      return;
    }
  }
  const ticket = ++operation;
  setPhase('starting');
  try {
    // Chrome grants tab capture from the popup's click.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: config.tabId });
    if (ticket !== operation) return;
    // Autofilled credentials and values entered immediately before the click also persist.
    chrome.storage.local.set({ jlsEngine: config.engine, jlsTarget: config.target, jlsAsrPacks: config.asrPacks,
      jlsApiKey: config.apiKey, jlsServer: config.serverUrl, jlsServerToken: config.serverToken }).catch(() => {});
    const response = await chrome.runtime.sendMessage({ type: 'jls:start', streamId, ...config });
    if (ticket !== operation) return;
    if (!response?.ok) throw new Error(response?.error || '启动失败');
    const { jlsStatus } = await chrome.storage.session.get('jlsStatus');
    if (ticket === operation) setPhase('capturing', jlsStatus?.phase === 'capturing' ? jlsStatus.message : '');
  } catch (error) {
    if (ticket === operation) setPhase('error', error.message || '无法开始字幕');
  }
});
stopButton.addEventListener('click', async () => {
  const previous = phase;
  ++operation;
  setPhase('stopping');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'jls:stop' });
    if (!response?.ok) throw new Error();
    setPhase('idle');
  } catch {
    setPhase(previous, '停止失败，请重试');
  }
});

init().catch(() => setPhase('error', '无法读取扩展设置，请重新打开菜单'));
