// background.js - NOL World 搶票助手 Service Worker

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// content script 的 LOG/STOPPED/SEAT_FOUND 訊息已由 bridge 直接送達 sidepanel，
// background 不需要再 re-broadcast（否則 sidepanel 會收到兩次）
// 這裡只把 LOG 另外寫進 log 檔（tools/log-server.py → logs/YYYY-MM-DD.jsonl）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // LOG = panel line + optional fields; TRACE = file-only structured record (no text)
  if ((msg?.action === 'LOG' || msg?.action === 'TRACE') && sender.tab) {
    // msg.data.ts (stamped in the page) overrides the receive time below when present
    queueLogLine({
      ts: Date.now(),
      tabId: sender.tab.id,
      host: safeHost(sender.tab.url),
      text: msg.action === 'LOG' ? maskSecrets(msg.message) : null,
      ...(msg.data ? JSON.parse(maskSecrets(JSON.stringify(msg.data))) : {}),
    });
  }
  sendResponse({ ok: true });
});

// ─── Log 檔 ───────────────────────────────────────────────
// Same scheme as ticketplus-autobuy-extension, on its own port so both servers can run together.
// Batched once per second so logging never sits on the ticketing path; dropped if the server is down.
const LOG_SERVER_URL = 'http://127.0.0.1:8793/log';
const LOG_FLUSH_INTERVAL = 1000;
const LOG_QUEUE_LIMIT = 5000;
let logQueue = [];
let logFlushTimer = null;
let logServerDownWarned = false;

function safeHost(url) {
  try { return new URL(url).host; } catch (_) { return null; }
}

// Session tokens appear in monitor URLs; never let them reach disk in full
function maskSecrets(text) {
  return String(text ?? '').replace(/(SessionId=)([^&"\s]{0,8})[^&"\s]*/gi, '$1$2…');
}

function queueLogLine(entry) {
  const d = new Date(entry.ts);
  entry.ms = entry.ts % 1000;
  entry.time = d.toLocaleTimeString('zh-TW', { hour12: false }) + '.' + String(entry.ms).padStart(3, '0');
  logQueue.push(entry);
  if (logQueue.length > LOG_QUEUE_LIMIT) logQueue.splice(0, logQueue.length - LOG_QUEUE_LIMIT);
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, LOG_FLUSH_INTERVAL);
}

async function flushLogs() {
  logFlushTimer = null;
  if (!logQueue.length) return;
  const batch = logQueue;
  logQueue = [];

  try {
    const res = await fetch(LOG_SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logServerDownWarned = false;
  } catch (err) {
    if (!logServerDownWarned) {
      console.warn('[背景] log server 沒有回應，這段 log 不會寫入檔案（請執行 python3 tools/log-server.py）:', err.message);
      logServerDownWarned = true;
    }
  }
}
