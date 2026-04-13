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

let watchTimer = null;
let watchObserver = null;

let seatMapObserver = null;
let seatMapTriggered = false;
let seatMapHeartbeat = null;
const rejectedSeats = new Set(); // 被伺服器 reject 的座位，暫時跳過
let selectApiCalled = false;
let origFetch = null;
let origXhrOpen = null;

function hookFetch() {
  // Fetch API
  if (!origFetch) {
    origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (url.includes('/api/seats/select')) {
        selectApiCalled = true;
        log(`[API] seats/select (fetch) 已發出`);
      }
      return origFetch.apply(this, args);
    };
  }
  // XMLHttpRequest（站台實際使用 XHR）
  if (!origXhrOpen) {
    origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      if (typeof url === 'string' && url.includes('/api/seats/select')) {
        selectApiCalled = true;
        log(`[API] seats/select (XHR) 已發出`);
      }
      return origXhrOpen.apply(this, [method, url, ...rest]);
    };
  }
}

function unhookFetch() {
  if (origFetch)    { window.fetch = origFetch; origFetch = null; }
  if (origXhrOpen)  { XMLHttpRequest.prototype.open = origXhrOpen; origXhrOpen = null; }
  selectApiCalled = false;
}

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

// ─── 監聽預約按鈕（gates 頁面）────────────────────────────
function findReserveBtn(enabledOnly = false) {
  const selector = enabledOnly ? 'button:not([disabled])' : 'button[disabled]';
  for (const btn of document.querySelectorAll(selector)) {
    if ([...btn.classList].some(c => c.includes('primary'))) return btn;
  }
  // 備案：頁面上唯一的 disabled/enabled button
  return enabledOnly ? null : document.querySelector('button[disabled]');
}

function stopWatchReserveBtn() {
  if (watchObserver) { watchObserver.disconnect(); watchObserver = null; }
  if (watchTimer)    { clearInterval(watchTimer);  watchTimer = null; }
}

function watchReserveBtn() {
  stopWatchReserveBtn(); // 防止重複啟動

  const disabledBtn = findReserveBtn(false);
  if (!disabledBtn) {
    log('⚠️ 找不到預約按鈕（請確認在預約頁面）');
    return;
  }
  log(`🕐 監聽中: "${disabledBtn.textContent.trim()}"，解鎖後立即點擊`);

  function triggerClick(btn) {
    stopWatchReserveBtn();
    log('🚀 預約按鈕解鎖！連點 3 次確保觸發！');
    btn.click();
    setTimeout(() => btn.click(), 80);
    setTimeout(() => btn.click(), 160);
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'RESERVE_BTN_CLICKED' } }, '*');
  }

  // MutationObserver：最快路徑，直接監聽 disabled 屬性
  watchObserver = new MutationObserver(() => {
    if (!disabledBtn.disabled) triggerClick(disabledBtn);
  });
  watchObserver.observe(disabledBtn, { attributes: true, attributeFilter: ['disabled'] });

  // 備案 polling 每 50ms（應對 React re-render 替換整個按鈕元素的情況）
  watchTimer = setInterval(() => {
    if (disabledBtn && !disabledBtn.disabled) { triggerClick(disabledBtn); return; }
    const fresh = findReserveBtn(true);
    if (fresh) triggerClick(fresh);
  }, 50);
}

// ─── 座位圖監聽（React SVG 架構）──────────────────────────
function stopWatchSeatMap() {
  if (seatMapObserver)  { seatMapObserver.disconnect(); seatMapObserver = null; }
  if (seatMapHeartbeat) { clearInterval(seatMapHeartbeat); seatMapHeartbeat = null; }
  unhookFetch();
  // 注意：不在這裡 reset seatMapTriggered
  // triggerSeat 呼叫時需保持 true 防止重複觸發
}

function findSubmitBtn() {
  for (const btn of document.querySelectorAll('button')) {
    if (btn.textContent.trim() === 'Submit') {
      return btn.disabled ? null : btn;
    }
  }
  return null;
}

function logSubmitState() {
  for (const btn of document.querySelectorAll('button')) {
    if (btn.textContent.trim() === 'Submit') {
      log(`[Submit] disabled=${btn.disabled}`);
      return;
    }
  }
  log('[Submit] 找不到 Submit 按鈕');
}

function isSeatAvailable(circle) {
  if (rejectedSeats.has(circle.id)) return false;
  const cls = circle.className?.baseVal || circle.getAttribute('class') || '';
  return cls.includes('js-seat') && !cls.includes('SeatMap_disabled__');
}

function watchSeatMap(targetRows, timeoutMin = 0) {
  stopWatchSeatMap();
  seatMapTriggered = false; // 重新開始監聽時才 reset

  // 監聽穩定的高層容器，避免 React re-mount 導致參照失效
  const observeRoot = document.querySelector('.SeatMap_seatMap__3ktuQ')
    || document.querySelector('main')
    || document.body;

  if (!document.querySelector('svg')) {
    log('⚠️ 找不到 SVG 座位圖（確認在選座頁面）');
    return;
  }

  hookFetch();
  selectApiCalled = false;
  const desc = targetRows?.length ? `row [${targetRows.join(', ')}]` : '全場';
  log(`🕐 座位圖監聽中：${desc}`);

  function checkStolenModal(circleId) {
    // 只要出現 Confirm 按鈕就處理，不管 modal 文字內容
    const confirmBtn = document.querySelector('.ModalConfirm_button__qDjC3');
    if (confirmBtn) {
      const msg = document.getElementById('dialogMessage');
      const text = msg?.textContent?.trim() || '(未知錯誤)';
      // React 按鈕需用 __reactProps.onClick，否則 .click() 無效
      const reactKey = Object.keys(confirmBtn).find(k => k.startsWith('__reactProps'));
      if (reactKey && confirmBtn[reactKey]?.onClick) {
        confirmBtn[reactKey].onClick({ type: 'click', target: confirmBtn, currentTarget: confirmBtn, bubbles: true, cancelable: true, preventDefault: () => {}, stopPropagation: () => {} });
      } else {
        confirmBtn.click();
      }
      rejectedSeats.add(circleId);
      log(`⚠️ Modal：「${text}」，加入黑名單，重新監聽...`);
      setTimeout(() => { rejectedSeats.delete(circleId); }, 3000);
      setTimeout(() => watchSeatMap(targetRows), 500);
      return true;
    }
    return false;
  }

  function triggerSeat(circle) {
    if (seatMapTriggered) return;
    seatMapTriggered = true;
    stopWatchSeatMap(); // 斷開 observer，但也會 unhookFetch
    selectApiCalled = false;
    hookFetch();        // 重新掛，用於偵測 select API 發出後停止 Submit 循環
    log(`🚀 [1] 座位解鎖：${circle.id}`);

    // 步驟1：點擊座位
    const circleReactKey = Object.keys(circle).find(k => k.startsWith('__reactProps'));
    if (circleReactKey && circle[circleReactKey]?.onClick) {
      circle[circleReactKey].onClick({ type: 'click', target: circle, currentTarget: circle, bubbles: true });
      log('[2] 座位：React handler 觸發');
    } else {
      const opts = { bubbles: true, cancelable: true, isPrimary: true };
      circle.dispatchEvent(new PointerEvent('pointerover', opts));
      circle.dispatchEvent(new PointerEvent('pointerenter', opts));
      circle.dispatchEvent(new PointerEvent('pointerdown', opts));
      circle.dispatchEvent(new PointerEvent('pointerup', opts));
      circle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      log('[2] 座位：dispatchEvent 觸發');
    }

    // 步驟2：等 Submit 解鎖
    let attempts = 0;
    const t = setInterval(() => {
      if (checkStolenModal(circle.id)) { clearInterval(t); return; }
      const btn = findSubmitBtn();
      if (btn) {
        clearInterval(t);
        log(`[3] Submit 解鎖（等了 ${attempts * 100}ms），開始反覆按直到成功...`);
        window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEATMAP_FOUND', id: circle.id } }, '*');

        function clickSubmit(b) {
          const reactKey = Object.keys(b).find(k => k.startsWith('__reactProps'));
          if (reactKey && b[reactKey]?.onClick) {
            const fakeEv = {
              type: 'click', target: b, currentTarget: b,
              bubbles: true, cancelable: true, defaultPrevented: false,
              preventDefault: () => {}, stopPropagation: () => {},
              stopImmediatePropagation: () => {}, nativeEvent: new MouseEvent('click', { bubbles: true }),
            };
            b[reactKey].onClick(fakeEv);
            log('[4] Submit 按下（React handler）');
          } else {
            b.click();
            log('[4] Submit 按下（fallback）');
          }
        }

        // 每 200ms 按一次，直到 PriceContent 出現（成功）或逾時
        let submitCount = 0;
        const t2 = setInterval(() => {
          if (checkStolenModal(circle.id)) { clearInterval(t2); return; }
          if ([...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'Select Price')) {
            clearInterval(t2);
            log('✅ Select Price 已出現，Submit 成功！');
            return;
          }
          const freshBtn = findSubmitBtn();
          // select API 已發出 → 停止按，等結果
          if (selectApiCalled) {
            clearInterval(t2);
            log('[4] select API 已發出，等待結果...');
            return;
          }
          if (freshBtn) {
            log(`[4] Submit #${submitCount + 1}：disabled=${freshBtn.disabled} parent="${freshBtn.parentElement?.className}"`);
            clickSubmit(freshBtn);
          } else {
            clearInterval(t2);
            log('⚠️ Submit 按鈕消失，重新監聽...');
            setTimeout(() => watchSeatMap(targetRows), 500);
            return;
          }
          if (++submitCount > 20) {
            clearInterval(t2);
            log('⚠️ Submit 反覆按仍未發出 select API，重新監聽...');
            setTimeout(() => watchSeatMap(targetRows), 500);
          }
        }, 150);
      } else if (++attempts > 60) {
        clearInterval(t);
        logSubmitState();
        log('[3] ⚠️ Submit 等待逾時（3s），請手動點擊');
      }
    }, 100);
  }

  // 每次都重新查詢 DOM，不依賴舊參照
  function scanTargets() {
    if (seatMapTriggered) return;
    const elements = targetRows?.length
      ? targetRows.map(r => document.getElementById(`seat_block_${r}`)).filter(Boolean)
      : [document.querySelector('svg')].filter(Boolean);

    for (const el of elements) {
      for (const circle of el.querySelectorAll('circle.js-seat')) {
        if (isSeatAvailable(circle)) { triggerSeat(circle); return; }
      }
    }
  }

  // 先掃描現有可用座位
  scanTargets();
  if (seatMapTriggered) return;

  // 每 30 秒 heartbeat + 逾時檢查
  let heartbeatCount = 0;
  const timeoutSec = timeoutMin * 60;
  if (timeoutMin > 0) {
    log(`⏱️ 監聽時限：${timeoutMin} 分鐘（${timeoutSec}s）`);
  }
  seatMapHeartbeat = setInterval(() => {
    heartbeatCount++;
    const elapsed = heartbeatCount * 30;
    if (timeoutSec > 0 && elapsed >= timeoutSec) {
      log(`⏱️ 監聽已達 ${timeoutMin} 分鐘時限，自動停止`);
      stopWatchSeatMap();
      window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEATMAP_TIMEOUT', minutes: timeoutMin } }, '*');
      return;
    }
    log(`👁️ 座位圖監聽中（${elapsed}s）...等待位置解鎖`);
  }, 30000);

  // 監聽高層容器，捕捉任何 DOM 變化（attribute 修改 or React 整體替換）
  let mutationCount = 0;
  seatMapObserver = new MutationObserver(() => {
    if (seatMapTriggered) return;
    mutationCount++;
    log(`[DOM] 變化 #${mutationCount}，掃描中...`);
    scanTargets();
  });

  seatMapObserver.observe(observeRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'fill'],
    childList: true,
  });
}

// ─── 遞迴搜尋所有 iframe（含巢狀）找 fnBlockSeatUpdate ──
function findWinWithFn(doc, depth) {
  if (!doc || depth > 5) return null;
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
    // 偵測 NOL World 統一驗證遮罩（hCaptcha / reCAPTCHA 共用）
    const wrap = doc.getElementById('divCaptchaWrap');
    if (wrap && wrap.style.display !== 'none') {
      const rect = wrap.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }

    // 偵測滑塊驗證
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
  if (!doc || depth > 5) return null;
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

// ─── 等待座位 iframe 載入完成 ────────────────────────────
function waitForSeatLoad(timeout = 1500) {
  return new Promise(resolve => {
    const t0 = Date.now();
    try {
      const seatDoc = document.getElementById('ifrmSeat')?.contentDocument;
      const detail = seatDoc?.getElementById('ifrmSeatDetail');
      if (!detail) { setTimeout(resolve, 800); return; }

      const timer = setTimeout(() => {
        log(`iframe 載入逾時（>${timeout}ms）`);
        resolve();
      }, timeout);
      detail.addEventListener('load', () => {
        clearTimeout(timer);
        setTimeout(() => {
          log(`iframe 載入完成（${Date.now() - t0}ms）`);
          resolve();
        }, 150);
      }, { once: true });
    } catch (_) {
      setTimeout(resolve, 800);
    }
  });
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
    await waitForSeatLoad();
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
  else if (msg.action === 'WATCH_RESERVE')   { watchReserveBtn();           payload = { ok: true }; }
  else if (msg.action === 'STOP_WATCH')      { stopWatchReserveBtn();       payload = { ok: true }; }
  else if (msg.action === 'WATCH_SEATMAP')   { watchSeatMap(msg.rows || [], msg.timeoutMin || 0); payload = { ok: true }; }
  else if (msg.action === 'STOP_WATCH_SEATMAP') { stopWatchSeatMap();       payload = { ok: true }; }

  window.postMessage({ [MSG_KEY]: true, dir: 'response', action: msg.action, payload }, '*');
};
window.addEventListener('message', window.__nolMsgHandler);

console.log('[NOL搶票] content-main.js 已載入（MAIN world）');
} // end guard
