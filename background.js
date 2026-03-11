// background.js - NOL World 搶票助手 Service Worker

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// content script 的 LOG/STOPPED/SEAT_FOUND 訊息已由 bridge 直接送達 sidepanel，
// background 不需要再 re-broadcast（否則 sidepanel 會收到兩次）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  sendResponse({ ok: true });
});
