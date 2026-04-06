// content-bridge.js - ISOLATED world
// 橋接 chrome.runtime（sidepanel）↔ window.postMessage（MAIN world）

if (typeof window.__nolBridgeLoaded !== 'undefined') {
  // 已載入，跳過
} else {
window.__nolBridgeLoaded = true;

const MSG_KEY = '__nol__';

// sidepanel → MAIN world
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!['START', 'STOP', 'STATUS', 'PING', 'WATCH_RESERVE', 'STOP_WATCH'].includes(msg.action)) return;

  window.postMessage({ [MSG_KEY]: true, dir: 'to-main', msg }, '*');

  const handler = (e) => {
    if (e.source !== window) return;
    if (!e.data?.[MSG_KEY] || e.data.dir !== 'response' || e.data.action !== msg.action) return;
    window.removeEventListener('message', handler);
    sendResponse(e.data.payload);
  };
  window.addEventListener('message', handler);
  setTimeout(() => window.removeEventListener('message', handler), 3000);
  return true;
});

// MAIN world → sidepanel（日誌、事件）
// 用可覆蓋式，防止 listener 累積
if (window.__nolExtHandler) window.removeEventListener('message', window.__nolExtHandler);
window.__nolExtHandler = (e) => {
  if (e.source !== window) return;
  if (!e.data?.[MSG_KEY] || e.data.dir !== 'to-ext') return;
  chrome.runtime.sendMessage(e.data.payload).catch(() => {});
};
window.addEventListener('message', window.__nolExtHandler);

} // end guard
