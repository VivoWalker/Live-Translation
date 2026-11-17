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
