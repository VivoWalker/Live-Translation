/* Capture ownership and routing are tied to an immutable session id. */
'use strict';
const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_SERVER = 'ws://127.0.0.1:8765/ws';
const state = { tabId: null, running: false, sessionId: null };
let generation = 0;
const restored = chrome.storage.session.get('jls').then(({ jls }) => {
  if (jls && jls.running && jls.sessionId) Object.assign(state, jls);
});
chrome.storage.local?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

async function setStatus(patch, sessionId) {
  const ticket = generation;
  const cur = (await chrome.storage.session.get('jlsStatus')).jlsStatus || {};
  if (ticket !== generation) return;
  if (sessionId && sessionId !== state.sessionId) return;
  await chrome.storage.session.set({ jlsStatus: { ...cur, ...patch, at: Date.now() } });
}
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH, reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'], justification: '抓取标签页音频并转写字幕',
  });
}
async function ensureContentScript(tabId) {
  try { if ((await chrome.tabs.sendMessage(tabId, { type: 'jls:ping' }))?.ok) return; } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['caption-overlay.js', 'content.js'] });
}
async function start(tabId, target, serverUrl, streamId, engine = 'browser', apiKey = '', serverToken = '') {
  await restored;
  const ticket = ++generation;
  const sessionId = crypto.randomUUID();
  Object.assign(state, { tabId, running: true, sessionId });
  const current = () => ticket === generation && state.sessionId === sessionId;
  await chrome.storage.session.set({ jls: { ...state } });
  await setStatus({ phase: 'starting', message: '准备中…' }, sessionId);
  try {
    await ensureContentScript(tabId);
    if (!current()) return { ok: false, error: '采集已取消' };
    await ensureOffscreen();
    if (!current()) return { ok: false, error: '采集已取消' };
    if (!streamId) streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (!current()) return { ok: false, error: '采集已取消' };
    const response = await chrome.runtime.sendMessage({
      type: 'jls:offscreen-start', sessionId, streamId, tabId, target,
      serverUrl: serverUrl || DEFAULT_SERVER, engine, apiKey, serverToken,
    });
    if (!current()) return { ok: false, error: '采集已取消' };
    if (!response?.ok) throw new Error(response?.error || '采集启动失败');
    chrome.tabs.sendMessage(tabId, { type: 'jls:toast', text: '字幕已开启，等待声音…' }).catch(() => {});
    return { ok: true };
  } catch (error) {
    if (!current()) return { ok: false, error: '采集已取消' };
    await stop(true);
    await setStatus({ phase: 'error', message: error.message || String(error) });
    return { ok: false, error: error.message || String(error) };
  }
}
async function stop(silent, expectedSession) {
  await restored;
  if (expectedSession && state.sessionId !== expectedSession) return;
  ++generation;
  const sessionId = state.sessionId;
  Object.assign(state, { running: false, tabId: null, sessionId: null });
  chrome.action.setBadgeText({ text: '' });
  await chrome.storage.session.set({ jls: { ...state } });
  await setStatus({ phase: 'idle', message: '已停止' });
  try { await chrome.runtime.sendMessage({ type: 'jls:offscreen-stop', sessionId }); } catch {}
  if (!silent) {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'jls:clear' }).catch(() => {});
    }
  }
}
function trustedPage(sender, path) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(path);
}
function captionSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const settings = {};
  for (const [key, min, max] of [['fontSize', 16, 40], ['width', 40, 94], ['background', 0, 70], ['cps', 4, 10]]) {
    if (Number.isFinite(source[key])) settings[key] = Math.min(max, Math.max(min, source[key]));
  }
  if (typeof source.showJa === 'boolean') settings.showJa = source.showJa;
  if (typeof source.color === 'string' && /^#[\da-f]{6}$/i.test(source.color)) settings.color = source.color;
  if (source.position && Number.isFinite(source.position.x) && Number.isFinite(source.position.y)) {
    settings.position = { x: Math.min(1, Math.max(0, source.position.x)), y: Math.min(1, Math.max(0, source.position.y)) };
  }
  return settings;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (['jls:caption-settings-get', 'jls:caption-settings-set'].includes(msg.type)) {
    if (sender.id !== chrome.runtime.id || !sender.tab) return false;
    (async () => {
      if (msg.type === 'jls:caption-settings-set') {
        await chrome.storage.local.set({ jlsCaptionPrefs: captionSettings(msg.settings) });
        return { ok: true };
      }
      const saved = await chrome.storage.local.get('jlsCaptionPrefs');
      return { settings: captionSettings(saved.jlsCaptionPrefs) };
    })().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (['jls:start', 'jls:stop', 'jls:query'].includes(msg.type)) {
    if (!trustedPage(sender, 'popup.html')) return false;
    (async () => {
      await restored;
      if (msg.type === 'jls:start') return start(msg.tabId, msg.target, msg.serverUrl, msg.streamId, msg.engine, msg.apiKey, msg.serverToken);
      if (msg.type === 'jls:stop') { await stop(); return { ok: true }; }
      return { running: state.running, tabId: state.tabId };
    })().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (!trustedPage(sender, OFFSCREEN_PATH)) return false;
  (async () => {
    await restored;
    if (!state.running || !msg.sessionId || msg.sessionId !== state.sessionId) return;
    const tabId = state.tabId;
    if (msg.type === 'jls:event') {
      if (msg.event?.type === 'model-cache') {
        // Persist final results, not a stale "downloading" state after restart.
        if (msg.event.saved || msg.event.warning) {
          await chrome.storage.local.set({ jlsModelCache: {
            saved: msg.event.saved === true, warning: msg.event.warning === true,
            message: String(msg.event.message || '').slice(0, 300), at: Date.now(),
          } });
        }
      } else {
        await chrome.tabs.sendMessage(tabId, { type: 'jls:event', event: msg.event }).catch(() => {});
      }
    } else if (msg.type === 'jls:state') {
      await setStatus({ phase: msg.phase, message: msg.message }, msg.sessionId);
      if (msg.sessionId !== state.sessionId) return;
      if (msg.phase === 'idle' || msg.phase === 'error') {
        await stop(msg.phase === 'error', msg.sessionId);
        if (msg.phase === 'error' && !state.running) {
          await setStatus({ phase: 'error', message: msg.message });
          chrome.tabs.sendMessage(tabId, { type: 'jls:toast', text: msg.message, bad: true }).catch(() => {});
        }
      } else {
        if (msg.phase === 'error') chrome.tabs.sendMessage(tabId, { type: 'jls:toast', text: msg.message, bad: true }).catch(() => {});
        chrome.action.setBadgeText({ text: msg.phase === 'capturing' || msg.phase === 'connected' ? '●' : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#35d07f' });
      }
    }
  })().catch(() => {});
  return false;
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (state.running && state.tabId === tabId) stop();
});
