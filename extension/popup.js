/* Popup: pick the tab, start capture, report service health and capture state. */
'use strict';

const DEFAULT_SERVER = 'ws://127.0.0.1:8765/ws';
const $ = (id) => document.getElementById(id);
const dot = $('dot');
const statusEl = $('status');
const btnStart = $('start');
const btnStop = $('stop');
const targetEl = $('target');
const serverEl = $('server');
const engineEl = $('engine');
const apiKeyEl = $('apikey');
const serverField = $('server-field');
const tokenField = $('token-field');
const tokenEl = $('server-token');
const cacheStatusEl = $('model-cache-status');

let activeTab = null;
let running = false;
let pollTimer = null;

function setDot(cls) {
  dot.className = 'dot' + (cls ? ' ' + cls : '');
}

function setStatus(text, isErr) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isErr ? ' err' : '');
}

async function checkServer() {
  const url = serverEl.value.trim() || DEFAULT_SERVER;
  const health = url.replace(/^ws/, 'http').replace(/\/ws$/, '/health');
  try {
    const r = await fetch(health, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j;
  } catch (e) {
    return null;
  }
}

function syncEngineFields() {
  const browser = engineEl.value === 'browser';
  serverField.hidden = browser;
  tokenField.hidden = browser;
  cacheStatusEl.hidden = !browser;
}

function showModelCache(info) {
  cacheStatusEl.textContent = info?.message || '';
  cacheStatusEl.className = 'hint' + (info?.warning ? ' warning' : '');
}

function setRunning(on) {
  running = on;
  btnStart.disabled = on;
  btnStop.disabled = !on;
  if (on) setDot('ok');
  else setDot(null);
}

async function pollState() {
  const cache = (await chrome.storage.local.get('jlsModelCache')).jlsModelCache;
  showModelCache(cache);
  const st = (await chrome.storage.session.get('jlsStatus')).jlsStatus || {};
  if (!st.phase) return;
  if (st.phase === 'error') {
    setRunning(false);
    setStatus(st.message || '出错了', true);
    setDot('bad');
  } else if (st.phase === 'connected') {
    setStatus(st.message || '已连接', false);
    setDot('ok');
  } else if (st.phase === 'capturing') {
    setStatus(st.message || '正在采集声音', false);
    setDot('busy');
  } else if (st.phase === 'idle') {
    setRunning(false);
    setStatus(st.message || '已停止', false);
    setDot(null);
  } else if (st.phase === 'starting') {
    setStatus(st.message || '启动中…', false);
    setDot('busy');
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  $('tab-title').textContent = tab ? (tab.title || tab.url || '当前标签页') : '没有可用标签页';

  const store = await chrome.storage.local.get(['jlsTarget', 'jlsServer', 'jlsEngine', 'jlsApiKey', 'jlsServerToken', 'jlsModelCache']);
  targetEl.value = store.jlsTarget || 'zh';
  serverEl.value = store.jlsServer || DEFAULT_SERVER;
  engineEl.value = store.jlsEngine || 'browser';
  apiKeyEl.value = store.jlsApiKey || '';
  tokenEl.value = store.jlsServerToken || '';
  showModelCache(store.jlsModelCache);
  syncEngineFields();

  const st = await chrome.runtime.sendMessage({ type: 'jls:query' }).catch(() => null);
  if (st && st.running) setRunning(true);

  const health = engineEl.value === 'browser' ? true : await checkServer();
  if (health) setDot(running ? 'ok' : null);
  else {
    setDot('bad');
    setStatus('服务未启动：先运行 python -m server.app', true);
  }

  pollTimer = setInterval(pollState, 500);

  targetEl.addEventListener('change', () => chrome.storage.local.set({ jlsTarget: targetEl.value }));
  serverEl.addEventListener('change', () => chrome.storage.local.set({ jlsServer: serverEl.value.trim() }));
  engineEl.addEventListener('change', () => {
    chrome.storage.local.set({ jlsEngine: engineEl.value });
    syncEngineFields();
  });
  apiKeyEl.addEventListener('change', () => chrome.storage.local.set({ jlsApiKey: apiKeyEl.value.trim() }));
  tokenEl.addEventListener('change', () => chrome.storage.local.set({ jlsServerToken: tokenEl.value.trim() }));
}

btnStart.addEventListener('click', async () => {
  if (!activeTab || !activeTab.id) {
    setStatus('请先打开一个播放视频的网页', true);
    return;
  }
  const url = activeTab.url || '';
  if (/^(chrome|edge|about|chrome-extension):/.test(url)) {
    setStatus('浏览器内部页面无法采集，请换一个普通网页', true);
    return;
  }
  const health = engineEl.value === 'browser' ? true : await checkServer();
  if (!health) {
    setDot('bad');
    setStatus('字幕服务没有运行：先执行 .\\run.ps1', true);
    return;
  }

  if (engineEl.value === 'browser' && !apiKeyEl.value.trim()) {
    setDot('bad');
    setStatus('浏览器内模式需要 DeepSeek Key（翻译用）', true);
    return;
  }
  if (engineEl.value === 'server' && !tokenEl.value.trim()) {
    setStatus('请填写服务启动时显示的访问令牌', true);
    return;
  }
  chrome.storage.local.set({ jlsEngine: engineEl.value, jlsApiKey: apiKeyEl.value.trim(), jlsTarget: targetEl.value });

  btnStart.disabled = true;
  setStatus('正在开始…');
  setDot('busy');
  try {
    // The stream id must be minted in a user-gesture context: do it here in the
    // popup, not in the service worker.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    const r = await chrome.runtime.sendMessage({
      type: 'jls:start',
      streamId,
      tabId: activeTab.id,
      target: targetEl.value,
      serverUrl: serverEl.value.trim() || DEFAULT_SERVER,
      engine: engineEl.value,
      apiKey: apiKeyEl.value.trim(),
      serverToken: tokenEl.value.trim(),
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '启动失败');
    setRunning(true);
    setStatus('已开始，字幕会出现在网页底部');
    setDot('ok');
  } catch (e) {
    await chrome.runtime.sendMessage({ type: 'jls:stop' }).catch(() => {});
    setRunning(false);
    setDot('bad');
    setStatus(String(e.message || e), true);
  }
});

btnStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'jls:stop' }).catch(() => {});
  setRunning(false);
  setStatus('已停止');
  setDot(null);
});

window.addEventListener('unload', () => clearInterval(pollTimer));

init();
