/* Service worker: owns tab capture lifetime, relays events to the content script. */
'use strict';

const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_SERVER = 'ws://127.0.0.1:8765/ws';

const state = { tabId: null, running: false };

async function setStatus(patch) {
  const cur = (await chrome.storage.session.get('jlsStatus')).jlsStatus || {};
  const next = Object.assign({}, cur, patch, { at: Date.now() });
  await chrome.storage.session.set({ jlsStatus: next });
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: '抓取标签页音频并转写字幕',
  });
}

/**
 * A page that was already open when the extension got installed has no content
 * script, so the overlay would never appear. Inject it on demand.
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'jls:ping' });
    if (pong && pong.ok) return true;
  } catch (e) {
    /* no receiver yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 120));
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'jls:ping' });
    return !!(pong && pong.ok);
  } catch (e) {
    await setStatus({ phase: 'error', message: '无法在页面上注入字幕层：' + (e.message || e) });
    return false;
  }
}

async function start(tabId, target, serverUrl, streamId, engine, apiKey) {
  await setStatus({ phase: 'starting', message: '准备中…' });

  const injected = await ensureContentScript(tabId);
  if (!injected) return { ok: false, error: '无法在当前页面注入字幕层，请刷新页面后重试' };

  await ensureOffscreen();
  if (!streamId) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      return { ok: false, error: '无法采集该标签页：' + (e.message || e) };
    }
  }

  state.tabId = tabId;
  state.running = true;
  await chrome.storage.session.set({ jls: { tabId, running: true, target } });

  let resp = null;
  try {
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: '采集进程 9 秒内没有响应，请重试' }), 9000)
    );
    resp = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'jls:offscreen-start',
        streamId,
        tabId,
        target,
        serverUrl: serverUrl || DEFAULT_SERVER,
      }),
      timeout,
    ]);
  } catch (e) {
    resp = { ok: false, error: '采集进程启动失败：' + (e.message || e) };
  }
  if (resp && resp.ok === false) {
    await stop(true);
    chrome.tabs.sendMessage(tabId, { type: 'jls:toast', text: resp.error || '采集失败', bad: true }).catch(() => {});
    return { ok: false, error: resp.error || '采集失败' };
  }
  chrome.tabs.sendMessage(tabId, { type: 'jls:toast', text: '字幕已开启，等待声音…' }).catch(() => {});
  return { ok: true };
}

async function stop(silent) {
  state.running = false;
  state.tabId = null;
  await chrome.storage.session.set({ jls: { running: false } });
  await setStatus({ phase: 'idle', message: '已停止' });
  try {
    await chrome.runtime.sendMessage({ type: 'jls:offscreen-stop' });
  } catch (e) {
    /* offscreen already gone */
  }
  if (!silent) {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id) chrome.tabs.sendMessage(t.id, { type: 'jls:clear' }).catch(() => {});
    }
  }
}

async function relayTarget() {
  if (state.tabId) return state.tabId;
  const saved = (await chrome.storage.session.get('jls')).jls;
  if (saved && saved.tabId) {
    state.tabId = saved.tabId;
    state.running = !!saved.running;
  }
  return state.tabId;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'jls:start') {
    start(msg.tabId, msg.target, msg.serverUrl, msg.streamId, msg.engine, msg.apiKey)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === 'jls:stop') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'jls:event') {
    relayTarget().then((tabId) => {
      if (!tabId) return;
      chrome.tabs.sendMessage(tabId, { type: 'jls:event', event: msg.event }).catch(() => {});
    });
    return false;
  }
  if (msg.type === 'jls:state') {
    setStatus({ phase: msg.phase, message: msg.message });
    if (msg.phase === 'connected' || msg.phase === 'error') {
      relayTarget().then((tabId) => {
        if (!tabId) return;
        chrome.tabs
          .sendMessage(tabId, { type: 'jls:toast', text: msg.message, bad: msg.phase === 'error' })
          .catch(() => {});
      });
    }
    chrome.action.setBadgeText({ text: msg.phase === 'connected' ? '●' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#35d07f' });
    return false;
  }
  if (msg.type === 'jls:query') {
    sendResponse({ running: state.running, tabId: state.tabId });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.running && state.tabId === tabId) stop();
});
