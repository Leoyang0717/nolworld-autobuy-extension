// content-main.js - MAIN world
// 直接存取頁面 JS / iframe，透過 window.postMessage 與 bridge 溝通

if (window.__nolMainLoaded) {
  console.log('[NOL搶票] content-main.js 已載入，跳過重複注入');
  // 把舊的 listener 清掉，重新掛上（避免訊息沒人回應）
} else {
window.__nolMainLoaded = true;

const MSG_KEY = '__nol__';

let isRunning = false;
let config = null;
let zoneIndex = 0;
let timer = null;
let startTime = null;

// ─── 工具 ────────────────────────────────────────────────
function log(msg) {
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const text = `[${time}] ${msg}`;
  console.log('[NOL搶票]', text);
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'LOG', message: text } }, '*');
}

function randomInterval() {
  return (config.intervalMin || 800) + Math.random() * ((config.intervalMax || 1500) - (config.intervalMin || 800));
}

// ─── 遞迴搜尋所有 iframe（含巢狀）找 fnBlockSeatUpdate ──
function findWinWithFn(doc, depth) {
  if (depth > 5) return null;
  try {
    const iframes = doc.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const win = iframe.contentWindow;
        const iDoc = iframe.contentDocument;
        if (typeof win.fnBlockSeatUpdate === 'function') {
          log(`找到 fnBlockSeatUpdate (iframe#${iframe.id || iframe.name || '?'}, depth=${depth})`);
          return win;
        }
        if (iDoc) {
          const found = findWinWithFn(iDoc, depth + 1);
          if (found) return found;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function getSeatIframe() {
  return document.getElementById('ifrmSeat');
}

// ─── 點擊區域 ────────────────────────────────────────────
function clickZone(zoneCode) {
  // 先試主 window
  if (typeof window.fnBlockSeatUpdate === 'function') {
    window.fnBlockSeatUpdate('', '', zoneCode);
    return true;
  }

  // 遞迴找所有 iframe
  const win = findWinWithFn(document, 0);
  if (win) {
    try {
      win.fnBlockSeatUpdate('', '', zoneCode);
      return true;
    } catch (e) {
      log(`呼叫失敗: ${e.message}`);
    }
  }

  // 最後備案：找連結直接點
  function findLink(doc, depth) {
    if (depth > 5) return null;
    try {
      const link = doc.querySelector(`a[href*="'${zoneCode}'"]`)
        || doc.querySelector(`a[href*='"${zoneCode}"']`)
        || [...doc.querySelectorAll('a')].find(a => a.textContent.trim().startsWith(zoneCode));
      if (link) return link;
      for (const iframe of doc.querySelectorAll('iframe')) {
        try {
          const found = findLink(iframe.contentDocument, depth + 1);
          if (found) return found;
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  const link = findLink(document, 0);
  if (link) { link.click(); return true; }

  log(`找不到 fnBlockSeatUpdate 也找不到連結（區域 ${zoneCode}）`);
  return false;
}

// ─── 驗證碼偵測 ──────────────────────────────────────────
function findCaptchaInDoc(doc, depth) {
  if (depth > 5) return false;
  try {
    const el = doc.querySelector('.captchSliderLayer');
    if (el) {
      const st = (doc.defaultView || doc.parentWindow)?.getComputedStyle(el);
      if (!st || st.display !== 'none') return true;
    }
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        if (findCaptchaInDoc(iframe.contentDocument, depth + 1)) return true;
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

// ─── 掃描綠葡萄（可用座位）────────────────────────────────
// SeatN = 可選座位（綠色）、SeatR = 已售、SeatB = 隔位
const SEAT_SELECTORS = [
  'span.SeatN',              // 確認有效：此系統的可用座位 class
  'span.SeatN[onclick]',     // 有 onclick 才是真正可點的
];

function searchSeatInDoc(doc, depth) {
  if (depth > 5) return null;
  try {
    for (const sel of SEAT_SELECTORS) {
      try {
        const els = doc.querySelectorAll(sel);
        if (els.length > 0) {
          log(`[GREEN] 找到 ${els.length} 個可用座位 (${sel}, depth=${depth})`);
          return els[0];
        }
      } catch (_) {}
    }
    // 遞迴搜尋巢狀 iframe
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        const found = searchSeatInDoc(iframe.contentDocument, depth + 1);
        if (found) return found;
      } catch (_) {}
    }
  } catch (e) {
    log(`掃描失敗: ${e.message}`);
  }
  return null;
}

function findAvailableSeat() {
  return searchSeatInDoc(document, 0);
}

// ─── 點擊確認按鈕（fnSelect）────────────────────────────
function confirmSeat() {
  // 遞迴找 #NextStepImage（btnWrap 內的橘色確認按鈕）
  function findNextStepBtn(doc, depth) {
    if (depth > 5) return null;
    try {
      const img = doc.getElementById('NextStepImage');
      if (img) return img.closest('a') || img.parentElement;
      for (const iframe of doc.querySelectorAll('iframe')) {
        try {
          const found = findNextStepBtn(iframe.contentDocument, depth + 1);
          if (found) return found;
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  const btn = findNextStepBtn(document, 0);
  if (btn) {
    btn.click();
    log('✅ 已點擊確認按鈕 (NextStepImage)，進入下一步');
    return;
  }

  // 備案：找 a[href*="fnSelect"] 或直接呼叫 iframe 內的函式
  function tryConfirmFallback(doc, depth) {
    if (depth > 5) return false;
    try {
      const link = doc.querySelector('a[href*="fnSelect"]');
      if (link) { link.click(); log('✅ 已點擊確認按鈕，進入下一步'); return true; }
      for (const iframe of doc.querySelectorAll('iframe')) {
        try {
          if (tryConfirmFallback(iframe.contentDocument, depth + 1)) return true;
        } catch (_) {}
      }
      if (depth > 0) {
        const win = doc.defaultView || doc.parentWindow;
        if (win && typeof win.fnSelect === 'function') {
          win.fnSelect();
          log('✅ 已呼叫 fnSelect()，進入下一步');
          return true;
        }
      }
    } catch (e) { log(`confirmSeat 失敗: ${e.message}`); }
    return false;
  }

  if (!tryConfirmFallback(document, 0)) {
    log('⚠️ 找不到確認按鈕，請手動點擊');
  }
}

// ─── 票數頁：輪詢等待 select 出現，填 1 張並按下一步 ──────
function findSelectInDoc(doc, depth) {
  if (depth > 5) return null;
  try {
    const selects = doc.querySelectorAll('select[name="SeatCount"]');
    if (selects.length > 0) return { selects, doc };
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        const found = findSelectInDoc(iframe.contentDocument, depth + 1);
        if (found) return found;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function fillTicketCount() {
  // 等待 ifrmBookStep 載入新的 Price/Discount 頁面（load 事件）
  // 不用輪詢，避免設到舊的 document
  const bookStepIframe = document.getElementById('ifrmBookStep');

  if (bookStepIframe) {
    log('等待 Price/Discount 頁面載入...');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      bookStepIframe.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    // 等頁面內部 JS（fnInit）初始化完成
    await new Promise(r => setTimeout(r, 300));
  } else {
    // 備案：找不到 ifrmBookStep，改用輪詢
    const timeout = 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (findSelectInDoc(document, 0)) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  const found = findSelectInDoc(document, 0);
  if (!found) {
    log('⚠️ 找不到票數選單，請手動選擇張數');
    return;
  }

  const { selects, doc } = found;
  const win = doc.defaultView || doc.parentWindow;
  selects.forEach(sel => {
    sel.value = '1';
    if (win && typeof win.fnSelectPrice === 'function') {
      win.fnSelectPrice(sel);
    } else {
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  log(`✅ 已設定 ${selects.length} 個票數選單為 1 張`);

  await new Promise(r => setTimeout(r, 300));
  const btn = document.getElementById('SmallNextBtnLink')
    || document.getElementById('LargeNextBtnLink')
    || document.querySelector('a[href*="fnNextStep"]');
  if (btn) {
    btn.click();
    log('✅ 已點擊下一步按鈕');
  } else if (typeof window.fnNextStep === 'function') {
    window.fnNextStep('P');
    log('✅ 已呼叫 window.fnNextStep');
  } else {
    log('⚠️ 找不到下一步按鈕，請手動點擊');
  }
}

// ─── 主循環 ──────────────────────────────────────────────
async function runCycle() {
  if (!isRunning) return;

  if (config.durationMs > 0 && Date.now() - startTime > config.durationMs) {
    log(`已達設定時間，停止搶票`);
    stop('TIMEOUT');
    return;
  }

  // 每輪開始前先偵測是否出現驗證碼
  if (findCaptchaInDoc(document, 0)) {
    log('🔒 偵測到驗證碼！停止搶票，請完成驗證後重新開始');
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'CAPTCHA' } }, '*');
    stop('CAPTCHA');
    return;
  }

  const zones = config.zones;
  if (!zones?.length) { log('未設定任何區域'); stop('NO_ZONES'); return; }

  const zoneCode = zones[zoneIndex % zones.length];
  zoneIndex++;

  log(`嘗試 ${zoneCode} 區域（第 ${zoneIndex} 次）`);
  const clicked = clickZone(zoneCode);

  if (clicked) {
    await new Promise(r => setTimeout(r, 800));
    const seat = findAvailableSeat();
    if (seat) {
      log(`✅ 找到綠葡萄！區域 ${zoneCode}，點擊座位中...`);
      seat.click();

      // 等待座位選取完成，再按確認按鈕（需等伺服器回應）
      await new Promise(r => setTimeout(r, 150));
      confirmSeat();

      // 票數頁由 fillTicketCount 自行輪詢等待（最多 5 秒）
      fillTicketCount();

      window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEAT_FOUND', zone: zoneCode } }, '*');
      stop('FOUND');
      return;
    }
    log(`${zoneCode} 無可用座位`);
  } else {
    log(`${zoneCode} 點擊失敗`);
  }

  const interval = randomInterval();
  log(`${Math.round(interval)}ms 後試下一個`);
  timer = setTimeout(runCycle, interval);
}

function start(cfg) {
  if (isRunning) { log('已在執行中'); return; }
  config = cfg;
  isRunning = true;
  zoneIndex = 0;
  startTime = Date.now();
  log(`開始搶票！區域: [${cfg.zones.join(', ')}]，間隔: ${cfg.intervalMin}~${cfg.intervalMax}ms，持續: ${cfg.durationMs / 60000} 分鐘`);
  runCycle();
}

function stop(reason) {
  isRunning = false;
  if (timer) { clearTimeout(timer); timer = null; }
  log(`已停止（${reason || 'MANUAL'}）`);
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'STOPPED', reason } }, '*');
}

// ─── 接收來自 bridge 的指令（可覆蓋，防止監聽器累積）────
if (window.__nolMsgHandler) {
  window.removeEventListener('message', window.__nolMsgHandler);
}
window.__nolMsgHandler = (e) => {
  if (e.source !== window) return;
  if (!e.data?.[MSG_KEY] || e.data.dir !== 'to-main') return;

  const { msg } = e.data;

  // 防止同一訊息在短時間內被處理多次（多個 bridge 轉發時）
  const dedupeKey = `${msg.action}_${msg._ts || ''}`;
  if (window.__nolLastMsg === dedupeKey && msg.action === 'START') return;
  window.__nolLastMsg = dedupeKey;

  let payload = null;
  if (msg.action === 'PING')    payload = { ok: true };
  else if (msg.action === 'START') { start(msg.config); payload = { ok: true }; }
  else if (msg.action === 'STOP')  { stop('MANUAL');    payload = { ok: true }; }
  else if (msg.action === 'STATUS') payload = { isRunning, zoneIndex, elapsed: startTime ? Date.now() - startTime : 0 };

  window.postMessage({ [MSG_KEY]: true, dir: 'response', action: msg.action, payload }, '*');
};
window.addEventListener('message', window.__nolMsgHandler);

console.log('[NOL搶票] content-main.js 已載入（MAIN world）');
} // end guard
