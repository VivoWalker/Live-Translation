/* A remote audio destination requires explicit consent and secure WebSocket. */
(() => {
  'use strict';
  function checked(value, allowRemote = false) {
    let url;
    try { url = new URL(value); } catch { throw new Error('请输入有效的 WebSocket 服务地址'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('服务地址应为不含凭据或查询参数的 ws:// 或 wss:// 地址');
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!loopback && (url.protocol !== 'wss:' || allowRemote !== true)) {
      throw new Error('远程服务需使用 wss:// 并在高级设置中允许发送音频');
    }
    return url.href;
  }
  globalThis.JLSServerURL = Object.freeze({ checked });
})();
