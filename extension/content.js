/* Routes caption events to the shared, shadow-isolated overlay. */
'use strict';

(() => {
  // The background may inject this file a second time (page opened before install).
  if (window.__jlsContentLoaded) return;
  window.__jlsContentLoaded = true;

  let ui = null;

  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    ui?.destroy();
    ui = window.JLS.createCaptionOverlay({
      hostId: 'ja-live-subs-host', mount: document.body || document.documentElement, fullscreen: true,
      loadSettings: async () => (await chrome.runtime.sendMessage({ type: 'jls:caption-settings-get' }))?.settings,
      saveSettings: settings => chrome.runtime.sendMessage({ type: 'jls:caption-settings-set', settings }),
    });
    ui.hide();
    return ui;
  }

  function handle(ev) {
    if (!ev) return;
    const u = ensureUi();
    switch (ev.type) {
      case 'speech_start':
        u.show();
        u.start(ev.id);
        break;
      case 'partial':
        u.text(ev.id, 'partial', ev.text);
        break;
      case 'final':
        u.text(ev.id, 'final', ev.text);
        break;
      case 'translation':
        u.translation(ev.id, ev.text, ev.final);
        u.setMeta('');
        break;
      case 'error':
        if (ev.scope === 'translate') u.translationFailed(ev.id);
        u.show();
        u.setMeta(ev.message || '出错了', true);
        break;
      case 'translation_cancelled':
        u.translationFailed(ev.id);
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
    } else if (msg.type === 'jls:caption-settings-update' && sender.id === chrome.runtime.id) {
      ensureUi().setSettings(msg.settings);
    } else if (msg.type === 'jls:clear') {
      if (ui) {
        ui.clear();
        ui.hide();
      }
    }
    return false;
  });
})();
