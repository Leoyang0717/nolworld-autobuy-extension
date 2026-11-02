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
let deniedStreak = 0; // 連續偵測到 Access Denied 的次數（看到正常座位圖即歸零）
let cycleFn = null;    // 當前模式的主循環（runCycle 或 scoutTick）
let scoutBuildUrl = null; // 偵察網址產生函式 (zone) => url，初始化失敗為 null

// ─── 背景剩餘座位監控（並行於盲輪/偵察，只「看與指揮」不提交）──
let monitorTimer = null;      // 監控節拍器
let monitorInFlight = false;  // AllBlock 請求單飛防護（前一發未回不發下一發）
let monitorBuildUrl = null;   // AllBlock 網址產生函式 () => url，初始化失敗為 null
let remainMap = {};           // 區碼 -> { block, remain, grade, gradeName }（保序＝API 順序）
let monitorOverride = null;   // { zone, since } 目前鎖定要主模式改刷的區；null＝不干預
let monitorLastAvailSig = ''; // 上次「有票區集合」簽章，變化才 log，避免洗版
let monitorLockHits = 0;      // 本次鎖定已集中刷幾次（偵察心跳計數）
let monitorHeartbeatTs = 0;   // 上次心跳 log 時間戳
const MONITOR_DWELL_MS = 60000; // 鎖定一區至少停留 60 秒，防止區間反覆橫跳
const MONITOR_HEARTBEAT_MS = 5000; // 偵察鎖定期間，每隔多久印一次心跳 log

let watchTimer = null;
let watchObserver = null;

let seatMapObserver = null;
let seatMapTriggered = false;
// Every timeout/interval the seat map watch schedules lives here, so a stop
// (manual, timeout or success) cancels pending retries instead of letting them restart the watch
const seatMapTimers = new Set();
let seatMapRows = [];       // target rows for the current watch session
let seatMapTimeoutMin = 0;  // user-set limit, kept across internal re-watches
let seatMapDeadline = 0;    // absolute ms timestamp; 0 = no limit
let seatMapStartTs = 0;
const SEATMAP_SUBMIT_WAIT_TICKS = 60;      // x 100ms waiting for Submit to unlock
const SEATMAP_RESULT_TIMEOUT_MS = 8000;    // after select API fires, wait this long for a result
const rejectedSeats = new Set(); // 被伺服器 reject 的座位，暫時跳過
let selectApiCalled = false;
let origFetch = null;
let origXhrOpen = null;

// ─── seatStatus 被動監聽（只讀頁面自己打的 API，不額外發請求）──
// 頁面約每 3 秒打 /onestop/api/seatStatus?blockKeys=...（每次最多 16 區，區多就分多發），
// 回應 data[i] 對應 blockKeys[i]，是 hex 點陣：每個 bit 依 DOM 順序對應一個座位，1＝可選
let seatStatusMap = {};       // block key -> open count (latest)
let seatStatusUpdates = 0;    // responses parsed in the current watch session
let seatStatusLastTs = 0;
// Render-lag probe: block key -> { apiTs, expected } waiting for the DOM to show what the API said
const renderLagPending = new Map();
const RENDER_LAG_GIVEUP_MS = 5000;
const blockChangeTs = {};     // block key -> when the API last reported more open seats

const HEX_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
function countOpenBits(hex) {
  let n = 0;
  for (const ch of hex) n += HEX_POPCOUNT[parseInt(ch, 16)] || 0;
  return n;
}

// "001:212" -> "212", "001:003" -> "F3" (two-digit-or-less codes are floor blocks on these maps)
function blockLabel(key) {
  const tail = String(key).split(':').pop();
  const n = parseInt(tail, 10);
  return Number.isFinite(n) && n < 100 ? `F${n}` : tail;
}

function handleSeatStatus(url, json) {
  let keys;
  try { keys = new URL(url, location.href).searchParams.getAll('blockKeys'); } catch (_) { return; }
  const data = json?.data;
  if (!keys.length || !Array.isArray(data) || data.length !== keys.length) return;
  seatStatusUpdates++;
  seatStatusLastTs = Date.now();

  const changes = [];
  const apiTs = Date.now();
  keys.forEach((key, i) => {
    const open = typeof data[i] === 'string' ? countOpenBits(data[i]) : 0;
    const prev = seatStatusMap[key];
    seatStatusMap[key] = open;
    if (prev !== undefined && prev !== open) {
      if (open > prev) blockChangeTs[key] = apiTs;
      if (document.getElementById(`seat_block_${key}`)) renderLagPending.set(key, { apiTs, expected: open, prev });
    }
    // First sighting only reports blocks that already have seats; later ones report any change
    if (prev === undefined ? open > 0 : prev !== open) changes.push({ key, prev: prev ?? null, open });
  });
  trace('seat_status_resp', { blocks: keys.length, changed: changes.length });
  // The page renders after our load listener runs, so check on the next frames too
  checkRenderLag();
  if (!changes.length) return;

  const targeted = (key) => !seatMapRows.length || seatMapRows.includes(key);
  const text = changes.map(c =>
    `${blockLabel(c.key)} ${c.prev === null ? '' : `${c.prev}→`}${c.open}${targeted(c.key) ? '〔指定〕' : '〔未指定〕'}`
  ).join('、');
  log(`🎫 座位變化：${text}`, {
    event: 'seat_status',
    changes: changes.map(c => ({ ...c, label: blockLabel(c.key), targeted: targeted(c.key) })),
  });
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEATMAP_COUNTS', counts: { ...seatStatusMap } } }, '*');
}

function countDomOpen(key) {
  const g = document.getElementById(`seat_block_${key}`);
  if (!g) return null;
  let n = 0;
  g.querySelectorAll('circle.js-seat').forEach(c => {
    const cls = c.getAttribute('class') || '';
    if (!cls.includes('SeatMap_disabled__')) n++;
  });
  return n;
}

// Called after each API response and on every DOM mutation while watching
function checkRenderLag() {
  if (!renderLagPending.size) return;
  const now = Date.now();
  for (const [key, p] of renderLagPending) {
    const dom = countDomOpen(key);
    if (dom === p.expected) {
      renderLagPending.delete(key);
      trace('render_lag', { key, label: blockLabel(key), lagMs: now - p.apiTs, prev: p.prev, open: p.expected });
    } else if (now - p.apiTs > RENDER_LAG_GIVEUP_MS) {
      renderLagPending.delete(key);
      trace('render_lag', { key, label: blockLabel(key), lagMs: null, prev: p.prev, open: p.expected, dom, note: 'dom never matched' });
    }
  }
}

function openBlocksSummary() {
  const open = Object.entries(seatStatusMap).filter(([, n]) => n > 0);
  if (!open.length) return '全部無位';
  return open.map(([k, n]) => `${blockLabel(k)}×${n}${!seatMapRows.length || seatMapRows.includes(k) ? '' : '〔未指定〕'}`).join('、');
}

function hookFetch() {
  // Fetch API
  if (!origFetch) {
    origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || String(args[0] || ''));
      if (url.includes('/api/seats/select')) {
        selectApiCalled = true;
        log(`[API] seats/select (fetch) 已發出`);
      }
      const res = await origFetch.apply(this, args);
      if (url.includes('/onestop/api/seatStatus')) {
        res.clone().json().then(j => handleSeatStatus(url, j)).catch(() => {});
      }
      return res;
    };
  }
  // XMLHttpRequest（站台實際使用 XHR）
  if (!origXhrOpen) {
    origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      const u = String(url || '');
      if (u.includes('/api/seats/select')) {
        selectApiCalled = true;
        log(`[API] seats/select (XHR) 已發出`);
      }
      if (u.includes('/onestop/api/seatStatus')) {
        this.addEventListener('load', () => {
          try {
            const j = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            handleSeatStatus(u, j);
          } catch (_) {}
        }, { once: true });
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
// Groups every log line of one start/watch session, so a run can be pulled out of the day's file
let logRunId = null;

// data: optional structured fields, written to the log file only (not shown in the panel)
function log(msg, data) {
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const text = `[${time}] ${msg}`;
  console.log('[NOL搶票]', text);
  // ts is taken here, not in the service worker: the worker may be asleep and stamp a whole backlog at once
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'LOG', message: text, data: { ts: Date.now(), run: logRunId, ...data } } }, '*');
}

// File-only record for high-frequency events (every request/response) that would flood the panel
function trace(event, data) {
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'TRACE', data: { ts: Date.now(), run: logRunId, event, ...data } } }, '*');
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
function smTimeout(fn, ms) {
  const id = setTimeout(() => { seatMapTimers.delete(id); fn(); }, ms);
  seatMapTimers.add(id);
  return id;
}

function smInterval(fn, ms) {
  const id = setInterval(fn, ms);
  seatMapTimers.add(id);
  return id;
}

// clearTimeout also cancels intervals (browsers share one timer list)
function smClear(id) {
  clearTimeout(id);
  seatMapTimers.delete(id);
}

function stopWatchSeatMap() {
  if (seatMapObserver) { seatMapObserver.disconnect(); seatMapObserver = null; }
  renderLagPending.clear(); // no observer = no valid render timing; drop instead of mis-measuring later
  seatMapTimers.forEach(id => clearTimeout(id));
  seatMapTimers.clear();
  unhookFetch();
  // 注意：不在這裡 reset seatMapTriggered
  // triggerSeat 呼叫時需保持 true 防止重複觸發
}

// ─── 彈窗記錄器（只記錄、不處理）─────────────────────────
// Runs for the whole watch session (independent of stopWatchSeatMap, which triggerSeat calls internally)
// so we can collect the real modal texts before writing handling rules.
// MutationObserver callbacks run as microtasks, i.e. before checkStolenModal's interval can close the modal.
let modalObserver = null;
let modalStopTimer = null;
const modalsOpen = new Map(); // signature -> { types, text, shownAt }
// The site mixes two UI kits: CSS-module "Modal*" components (e.g. ModalToast) and the
// "nds-e-dialog" design system (e.g. seat time expired); ARIA roles catch both and any future one
const MODAL_SELECTOR = '[class*="Modal"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
let seatMapLastTriggerTs = 0;
let seatMapLastSeatId = null;

function readModal(root) {
  const types = new Set();
  const role = root.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') types.add(`role:${role}`);
  const kit = (root.getAttribute('class') || '').match(/\b(nds-[a-z]-[a-z-]+?)__/);
  if (kit) types.add(kit[1]);
  [root, ...root.querySelectorAll('[class*="Modal"]')].forEach(el => {
    const cls = el.getAttribute('class') || '';
    for (const m of cls.matchAll(/\b(Modal[A-Za-z]+)_/g)) types.add(m[1]);
  });
  return {
    types: [...types],
    text: (root.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    dialogMessage: document.getElementById('dialogMessage')?.textContent?.trim() || null,
    buttons: [...root.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean),
    html: root.outerHTML.slice(0, 4000),
  };
}

// ─── 彈窗分類（依實際收集到的原文；見 log 的 modal_shown）──────
// Seen so far: "This seat has already been reserved." / "Your 10-minute seat selection time has expired."
// / "Would you like to re-select your seats? ..." (shown when the user clicks the map after booking)
function classifyDialog(text) {
  if (/already been reserved|already (been )?(selected|sold|taken)|not available/i.test(text)) return 'TAKEN';
  if (/has expired|restart your booking/i.test(text)) return 'EXPIRED';
  if (/re-?select your seats/i.test(text)) return 'RESELECT';
  return 'UNKNOWN';
}

// The blocking dialog on screen from either UI kit (toasts have no buttons and are ignored)
function findBlockingDialog() {
  const legacy = document.querySelector('[class*="ModalConfirm_button__"]');
  if (legacy && legacy.getClientRects().length) {
    return { text: document.getElementById('dialogMessage')?.textContent?.trim() || '', buttons: [legacy] };
  }
  for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    const buttons = [...d.querySelectorAll('button')];
    if (!buttons.length || !d.getClientRects().length) continue;
    return { text: (d.innerText || '').replace(/\s+/g, ' ').trim(), buttons };
  }
  return null;
}

// React buttons need their own onClick; a plain .click() may not reach the handler
function pressReactButton(btn) {
  const reactKey = Object.keys(btn).find(k => k.startsWith('__reactProps'));
  if (reactKey && btn[reactKey]?.onClick) {
    btn[reactKey].onClick({ type: 'click', target: btn, currentTarget: btn, bubbles: true, cancelable: true, preventDefault: () => {}, stopPropagation: () => {} });
  } else {
    btn.click();
  }
}

// Longer than one seatStatus poll (~3.9s): the map keeps showing a taken seat as open until the next poll
const SEAT_REJECT_MS = 10000;
function rejectSeat(id) {
  rejectedSeats.add(id);
  setTimeout(() => rejectedSeats.delete(id), SEAT_REJECT_MS);
}

function scanModals() {
  // Outermost visible Modal* elements only (nested Modal* parts belong to the same dialog)
  const roots = [...document.querySelectorAll(MODAL_SELECTOR)].filter(el =>
    !el.parentElement?.closest(MODAL_SELECTOR) && el.getClientRects().length && (el.innerText || '').trim()
  );
  const seen = new Set();
  const now = Date.now();
  const phase = seatMapTriggered ? 'after_click' : 'watching';
  for (const root of roots) {
    const m = readModal(root);
    // Digits normalized so a ticking countdown inside a dialog doesn't log it again every second
    const sig = `${m.types.join('+')}|${m.text.replace(/\d+/g, '#')}`;
    seen.add(sig);
    if (modalsOpen.has(sig)) continue;
    modalsOpen.set(sig, { types: m.types, text: m.text, shownAt: now });
    log(`🪟 彈窗出現〔${m.types.join(' / ') || '?'}〕：「${m.text}」${m.buttons.length ? ` 按鈕：[${m.buttons.join(', ')}]` : ''}`, {
      event: 'modal_shown', phase, ...m,
      seatId: phase === 'after_click' ? seatMapLastSeatId : null,
      sinceTriggerMs: phase === 'after_click' ? now - seatMapLastTriggerTs : null,
    });
    // Session over: watching on is pointless (timers exist only while a watch is live)
    if (seatMapTimers.size && m.buttons.length && classifyDialog(m.text) === 'EXPIRED') {
      endSeatMap('EXPIRED', '⏰ 選位時間已到，已停止監聽，請重新進入選座頁');
      return;
    }
  }
  for (const [sig, m] of modalsOpen) {
    if (seen.has(sig)) continue;
    modalsOpen.delete(sig);
    trace('modal_closed', { types: m.types, text: m.text, visibleMs: now - m.shownAt });
  }
}

function startModalRecorder() {
  stopModalRecorder();
  scanModals(); // record anything already on screen
  modalObserver = new MutationObserver(scanModals);
  modalObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopModalRecorder(delayMs = 0) {
  if (modalStopTimer) { clearTimeout(modalStopTimer); modalStopTimer = null; }
  if (delayMs > 0) { modalStopTimer = setTimeout(() => stopModalRecorder(), delayMs); return; }
  if (modalObserver) { modalObserver.disconnect(); modalObserver = null; }
  modalsOpen.clear();
}

// End the watch for good and tell the side panel so its buttons/status reset
function endSeatMap(reason, msg) {
  log(msg, { event: 'seatmap_stop', reason });
  stopWatchSeatMap();
  stopModalRecorder();
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEATMAP_STOPPED', reason } }, '*');
}

function rewatchSeatMap(msg) {
  log(msg);
  smTimeout(watchSeatMap, 500);
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

function isSelectPriceShown() {
  return [...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'Select Price');
}

function isSeatAvailable(circle) {
  if (rejectedSeats.has(circle.id)) return false;
  const cls = circle.className?.baseVal || circle.getAttribute('class') || '';
  // Skip seats we already selected: clicking them again would deselect
  return cls.includes('js-seat') && !cls.includes('SeatMap_disabled__') && !cls.includes('SeatMap_selected__');
}

// Outline one block on the page for a few seconds: block codes don't say which drawn area they are
// (area names live in the background image, not the DOM)
let blockHighlightEl = null;
let blockHighlightTimer = null;
function highlightSeatBlock(key) {
  if (blockHighlightTimer) { clearTimeout(blockHighlightTimer); blockHighlightTimer = null; }
  blockHighlightEl?.remove();
  blockHighlightEl = null;
  const r = document.getElementById(`seat_block_${key}`)?.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return false;
  const pad = 6;
  blockHighlightEl = document.createElement('div');
  blockHighlightEl.style.cssText = `position:fixed;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`
    + 'border:3px solid #ff3d00;border-radius:6px;background:rgba(255,61,0,.12);pointer-events:none;z-index:2147483647;';
  const tag = document.createElement('div');
  tag.textContent = `${blockLabel(key)}（${key}）`;
  tag.style.cssText = 'position:absolute;top:-24px;left:-3px;background:#ff3d00;color:#fff;font:bold 13px sans-serif;padding:2px 6px;border-radius:4px;white-space:nowrap;';
  blockHighlightEl.appendChild(tag);
  document.body.appendChild(blockHighlightEl);
  blockHighlightTimer = setTimeout(() => { blockHighlightEl?.remove(); blockHighlightEl = null; }, 2500);
  return true;
}

// List every seat block currently drawn on the map (only present once zoomed in to seat level)
function scanSeatBlocks() {
  return [...document.querySelectorAll('svg g[id^="seat_block_"]')].map(g => {
    const seats = g.querySelectorAll('circle.js-seat');
    let open = 0;
    seats.forEach(c => { if (isSeatAvailable(c)) open++; });
    const key = g.id.slice('seat_block_'.length);
    return { key, label: blockLabel(key), total: seats.length, open };
  });
}

// Entry point from the side panel; internal re-watches call watchSeatMap() directly
// so the rows and the overall deadline survive retries
function startWatchSeatMap(rows, timeoutMin) {
  seatMapRows = rows || [];
  seatMapTimeoutMin = timeoutMin || 0;
  seatMapStartTs = Date.now();
  seatMapDeadline = seatMapTimeoutMin > 0 ? seatMapStartTs + seatMapTimeoutMin * 60000 : 0;
  rejectedSeats.clear();
  seatStatusMap = {};
  seatStatusUpdates = 0;
  seatStatusLastTs = 0;
  renderLagPending.clear();
  logRunId = `seatmap-${seatMapStartTs}`;
  startModalRecorder();
  if (seatMapTimeoutMin > 0) {
    log(`⏱️ 監聽時限：${seatMapTimeoutMin} 分鐘（${seatMapTimeoutMin * 60}s）`);
  }
  return watchSeatMap();
}

function watchSeatMap() {
  stopWatchSeatMap();
  seatMapTriggered = false; // 重新開始監聽時才 reset

  if (seatMapDeadline && Date.now() >= seatMapDeadline) {
    handleSeatMapTimeout();
    return false;
  }

  // 監聽穩定的高層容器，避免 React re-mount 導致參照失效
  const observeRoot = document.querySelector('.SeatMap_seatMap__3ktuQ')
    || document.querySelector('main')
    || document.body;

  if (!document.querySelector('svg')) {
    endSeatMap('NO_SVG', '⚠️ 找不到 SVG 座位圖（確認在選座頁面）');
    return false;
  }

  const targetRows = seatMapRows;
  let triggerTs = 0;
  const leftover = findBlockingDialog();
  if (leftover && classifyDialog(leftover.text) === 'TAKEN') {
    pressReactButton(leftover.buttons.find(b => /^(ok|confirm|확인)$/i.test(b.textContent.trim())) || leftover.buttons[0]);
    log(`關閉殘留彈窗：「${leftover.text}」`);
  }
  hookFetch();
  selectApiCalled = false;
  const desc = targetRows.length ? `[${targetRows.map(blockLabel).join(', ')}]` : '全場';
  log(`🕐 座位圖監聽中：${desc}`, { event: 'seatmap_watch', rows: targetRows });
  const missing = targetRows.filter(r => !document.getElementById(`seat_block_${r}`));
  if (missing.length) {
    log(`⚠️ 頁面上目前找不到 ${missing.map(blockLabel).join(', ')}（若停在純圖模式，請先放大到座位格子）`);
  }

  function handleSeatMapTimeout() {
    log(`⏱️ 監聽已達 ${seatMapTimeoutMin} 分鐘時限，自動停止`, { event: 'seatmap_stop', reason: 'TIMEOUT' });
    stopWatchSeatMap();
    stopModalRecorder();
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEATMAP_TIMEOUT', minutes: seatMapTimeoutMin } }, '*');
  }

  // Returns true when a dialog was handled (caller stops its current loop)
  function checkStolenModal(circleId) {
    const dlg = findBlockingDialog();
    if (!dlg) return false;
    const kind = classifyDialog(dlg.text);
    if (kind === 'RESELECT') return false; // user-triggered; pressing Re-select would release a booked seat
    if (kind === 'TAKEN') {
      const ok = dlg.buttons.find(b => /^(ok|confirm|확인)$/i.test(b.textContent.trim())) || dlg.buttons[0];
      pressReactButton(ok);
      rejectSeat(circleId);
      log(`⚠️ 座位已被搶走：「${dlg.text}」，${SEAT_REJECT_MS / 1000} 秒內跳過此座位`, {
        event: 'seat_rejected', seatId: circleId, modal: dlg.text, sinceTriggerMs: Date.now() - triggerTs,
      });
      rewatchSeatMap('換下一個座位，重新監聽...');
      return true;
    }
    // Expired or never-seen wording: stop instead of looping on something we don't understand
    if (kind === 'EXPIRED') endSeatMap('EXPIRED', '⏰ 選位時間已到，已停止監聽，請重新進入選座頁');
    else endSeatMap('UNKNOWN_DIALOG', `⚠️ 出現未知彈窗「${dlg.text}」，已停止監聽，請手動處理`);
    return true;
  }

  // Success is only declared once the price step is actually on screen
  function onSeatMapSuccess(circleId) {
    log('✅ Select Price 已出現，Submit 成功！', { event: 'seatmap_success', seatId: circleId, sinceTriggerMs: Date.now() - triggerTs });
    stopWatchSeatMap();
    stopModalRecorder(60000); // keep recording dialogs on the price step for a minute
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEATMAP_FOUND', id: circleId } }, '*');
  }

  // After the select API fires, keep watching for its outcome instead of going silent
  function waitSelectResult(circleId) {
    const t0 = Date.now();
    const t3 = smInterval(() => {
      if (checkStolenModal(circleId)) { smClear(t3); return; }
      if (isSelectPriceShown()) { smClear(t3); onSeatMapSuccess(circleId); return; }
      if (Date.now() - t0 > SEATMAP_RESULT_TIMEOUT_MS) {
        smClear(t3);
        endSeatMap('RESULT_TIMEOUT', `⚠️ select API 送出 ${SEATMAP_RESULT_TIMEOUT_MS / 1000}s 仍未看到結果，已停止監聽，請手動確認頁面`);
      }
    }, 150);
  }

  function triggerSeat(circle, candidates = 1) {
    if (seatMapTriggered) return;
    seatMapTriggered = true;
    triggerTs = Date.now();
    seatMapLastTriggerTs = triggerTs;
    seatMapLastSeatId = circle.id;
    stopWatchSeatMap(); // 斷開 observer，但也會 unhookFetch
    selectApiCalled = false;
    hookFetch();        // 重新掛，用於偵測 select API 發出後停止 Submit 循環
    const blockKey = circle.closest('g[id^="seat_block_"]')?.id.slice('seat_block_'.length) || null;
    const apiTs = blockKey ? blockChangeTs[blockKey] : null;
    log(`🚀 [1] 座位解鎖：${circle.id}`, {
      event: 'seat_trigger', seatId: circle.id, block: blockKey, candidates,
      // How long after the API reported this block opening did our DOM-based trigger fire
      apiToTriggerMs: apiTs ? triggerTs - apiTs : null,
    });

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
    const t = smInterval(() => {
      if (checkStolenModal(circle.id)) { smClear(t); return; }
      const btn = findSubmitBtn();
      if (btn) {
        smClear(t);
        const waitMs = Date.now() - triggerTs;
        log(`[3] Submit 解鎖（等了 ${waitMs}ms），開始反覆按直到成功...`, { event: 'submit_unlocked', waitMs });

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

        // 每 150ms 按一次，直到 Select Price 出現（成功）、select API 發出或逾時
        let submitCount = 0;
        const t2 = smInterval(() => {
          if (checkStolenModal(circle.id)) { smClear(t2); return; }
          if (isSelectPriceShown()) { smClear(t2); onSeatMapSuccess(circle.id); return; }
          // select API 已發出 → 停止按，改為等待結果
          if (selectApiCalled) {
            smClear(t2);
            log('[4] select API 已發出，等待結果...', { event: 'select_api_sent', submitClicks: submitCount, sinceTriggerMs: Date.now() - triggerTs });
            waitSelectResult(circle.id);
            return;
          }
          const freshBtn = findSubmitBtn();
          if (freshBtn) {
            log(`[4] Submit #${submitCount + 1}：disabled=${freshBtn.disabled} parent="${freshBtn.parentElement?.className}"`);
            clickSubmit(freshBtn);
          } else {
            // Usually the site rejected the seat right after the click; its dialog follows ~100ms later.
            // Wait for it and let checkStolenModal close it, or the next seat would get blamed for it
            smClear(t2);
            rejectSeat(circle.id);
            const goneAt = Date.now();
            const t4 = smInterval(() => {
              if (checkStolenModal(circle.id)) { smClear(t4); return; }
              if (Date.now() - goneAt > 600) {
                smClear(t4);
                rewatchSeatMap('⚠️ Submit 按鈕消失，跳過此座位，重新監聽...');
              }
            }, 50);
            return;
          }
          if (++submitCount > 20) {
            smClear(t2);
            rejectSeat(circle.id);
            rewatchSeatMap('⚠️ Submit 反覆按仍未發出 select API，跳過此座位，重新監聽...');
          }
        }, 150);
      } else if (++attempts > SEATMAP_SUBMIT_WAIT_TICKS) {
        smClear(t);
        logSubmitState();
        // The seat may be half-selected; re-watching could stack a second seat, so hand back to the user
        endSeatMap('SUBMIT_TIMEOUT', `[3] ⚠️ Submit 等待逾時（${SEATMAP_SUBMIT_WAIT_TICKS / 10}s），已停止監聽，請手動確認頁面`);
      }
    }, 100);
  }

  // 每次都重新查詢 DOM，不依賴舊參照
  function scanTargets() {
    if (seatMapTriggered) return;
    const elements = targetRows.length
      ? targetRows.map(r => document.getElementById(`seat_block_${r}`)).filter(Boolean)
      : [document.querySelector('svg')].filter(Boolean);

    // Random pick: other bots likely take the first open seat in DOM order, so avoid colliding with them
    const open = [];
    for (const el of elements) {
      for (const circle of el.querySelectorAll('circle.js-seat')) {
        if (isSeatAvailable(circle)) open.push(circle);
      }
    }
    if (open.length) triggerSeat(open[Math.floor(Math.random() * open.length)], open.length);
  }

  // 先掃描現有可用座位
  scanTargets();
  if (seatMapTriggered) return true;

  // 每 30 秒 heartbeat + 逾時檢查（時限從使用者按下開始算，重新監聽不會重置）
  smInterval(() => {
    if (seatMapDeadline && Date.now() >= seatMapDeadline) { handleSeatMapTimeout(); return; }
    const elapsed = Math.round((Date.now() - seatMapStartTs) / 1000);
    // No seatStatus for 15s+ means the page stopped polling (usually still in the zoomed-out overview)
    const stale = !seatStatusLastTs || Date.now() - seatStatusLastTs > 15000;
    log(stale
      ? `👁️ 監聽中（${elapsed}s）⚠️ 頁面沒有在更新座位（seatStatus 已停），請把座位圖放大到看得到座位格子`
      : `👁️ 監聽中（${elapsed}s）· 座位 API 已更新 ${seatStatusUpdates} 次 · 有位：${openBlocksSummary()}`,
      { event: 'seatmap_heartbeat', elapsed, updates: seatStatusUpdates, stale, counts: { ...seatStatusMap } });
  }, 30000);

  // 監聽高層容器，捕捉任何 DOM 變化（attribute 修改 or React 整體替換）
  // DOM 變化不再逐筆 log（hover/縮放也會觸發，是雜訊）；實際座位變化由 seatStatus 回報
  seatMapObserver = new MutationObserver(() => {
    checkRenderLag();
    if (seatMapTriggered) return;
    scanTargets();
  });

  seatMapObserver.observe(observeRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'fill'],
    childList: true,
  });
  return true;
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

// ─── Access Denied 偵測 ──────────────────────────────────
// 刷太快被 WAF 擋下時，座位 iframe 會變成 Access Denied 頁面
function findAccessDeniedInDoc(doc, depth) {
  if (!doc || depth > 5) return false;
  try {
    const text = doc.body?.innerText || '';
    if (text.includes('Access Denied')) return true;
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        if (findAccessDeniedInDoc(iframe.contentDocument, depth + 1)) return true;
      } catch (_) {}
    }
  } catch (_) {}
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
    return false;
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
  return true;
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

// ─── 驗證碼停止（共用）──────────────────────────────────
function handleCaptchaStop(where) {
  trace('captcha', { source: where, action: 'stop', sinceStartMs: Date.now() - startTime, attempts: zoneIndex });
  log(`🔒 偵測到驗證碼（${where}）！停止搶票，請完成驗證後重新開始`);
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'CAPTCHA' } }, '*');
  stop('CAPTCHA');
}

// ─── Access Denied 暫停/停止（盲輪與偵察共用）────────────
function handleDeniedPause() {
  deniedStreak++;
  trace('access_denied', {
    streak: deniedStreak, sinceStartMs: Date.now() - startTime,
    mode: cycleFn === scoutTick ? 'scout' : 'blind',
    attempts: cycleFn === scoutTick ? scoutReqCount : zoneIndex,
  });
  if (deniedStreak >= 4) {
    log(`⛔ Access Denied 連續 ${deniedStreak - 1} 次等待後仍被擋，11 秒策略已失效，停止搶票`);
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'ACCESS_DENIED_FATAL', count: deniedStreak } }, '*');
    stop('ACCESS_DENIED');
    return;
  }
  log(`⛔ 偵測到 Access Denied（連續第 ${deniedStreak} 次），暫停 11 秒後自動繼續（持續時間照常計算）`);
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'ACCESS_DENIED', count: deniedStreak } }, '*');
  timer = setTimeout(() => {
    log('⏳ 等待 11 秒結束，恢復刷票...');
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'ACCESS_DENIED_RESUMED' } }, '*');
    cycleFn();
  }, 11000);
}

// ─── 進入區域並嘗試選位（盲輪與偵察共用）─────────────────
let lastSeatLoadMs = null; // iframe load time of the latest zone entry (for tracing)
// 回傳 'FOUND' | 'DENIED' | 'CAPTCHA' | 'NONE' | 'FAIL'
async function enterZoneAndPick(zoneCode) {
  const clicked = clickZone(zoneCode);
  if (!clicked) { log(`${zoneCode} 點擊失敗`); return 'FAIL'; }

  const loadStart = Date.now();
  await waitForSeatLoad();
  lastSeatLoadMs = Date.now() - loadStart;

  // Denied/驗證碼須在載入完成後檢查：舊畫面會殘留在 iframe 內，
  // 點擊前檢查會把殘留畫面誤計成新的一次
  if (findAccessDeniedInDoc(document, 0)) return 'DENIED';
  if (findCaptchaInDoc(document, 0)) return 'CAPTCHA';

  const seat = findAvailableSeat();
  if (!seat) { log(`${zoneCode} 無可用座位`); return 'NONE'; }

  log(`✅ 找到綠葡萄！區域 ${zoneCode}，點擊座位中...`);
  seat.click();

  // 等待座位選取完成，再按確認按鈕（需等伺服器回應）
  await new Promise(r => setTimeout(r, 150));
  confirmSeat();

  // 票數頁由 fillTicketCount 自行輪詢等待（最多 5 秒）
  fillTicketCount();

  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEAT_FOUND', zone: zoneCode } }, '*');
  stop('FOUND');
  return 'FOUND';
}

// ─── 盲輪主循環（逐區輪流點擊）───────────────────────────
async function runCycle() {
  if (!isRunning) return;

  if (config.durationMs > 0 && Date.now() - startTime > config.durationMs) {
    log(`已達設定時間，停止搶票`);
    stop('TIMEOUT');
    return;
  }

  if (findCaptchaInDoc(document, 0)) { handleCaptchaStop('頁面'); return; }

  const zones = config.zones;
  if (!zones?.length) { log('未設定任何區域'); stop('NO_ZONES'); return; }

  // 背景監控鎖定某有票區時優先改刷該區；否則在「指定區扣掉排除區」中輪詢
  let zoneCode = monitorOverride?.zone;
  if (!zoneCode) {
    const active = zones.filter(z => !isExcluded(z));
    if (!active.length) {
      // 指定區全被排除：監控開著就等它指路，否則停止
      if (config.monitorEnabled) { timer = setTimeout(runCycle, randomInterval()); return; }
      log('⚠️ 所有指定區域都在排除清單中，無可刷區域'); stop('NO_ZONES'); return;
    }
    zoneCode = active[zoneIndex % active.length];
  }
  zoneIndex++;

  log(`嘗試 ${zoneCode} 區域（第 ${zoneIndex} 次）${monitorOverride ? '🎯監控鎖定' : ''}`);
  const res = await enterZoneAndPick(zoneCode);
  trace('blind_try', { zone: zoneCode, attempt: zoneIndex, result: res, loadMs: lastSeatLoadMs, monitorLocked: !!monitorOverride });
  if (res === 'FOUND') return;
  if (res === 'DENIED')  { handleDeniedPause(); return; }
  if (res === 'CAPTCHA') { handleCaptchaStop('選位頁'); return; }
  if (res === 'NONE') deniedStreak = 0; // 正常看到座位圖 → 連續計數歸零

  const interval = randomInterval();
  log(`${Math.round(interval)}ms 後試下一個`);
  timer = setTimeout(runCycle, interval);
}

// ─── 偵察模式：滴灌 fetch 各區座位頁比對文字 ──────────────
const SCOUT_MAX_INFLIGHT = 2; // 在飛請求上限（實測 3 併發會觸發驗證）

// 每次發請求前的隨機等待（時序不固定，較不像機器人）
function scoutRandomInterval() {
  const min = config.scoutIntervalMin || 1000;
  const max = config.scoutIntervalMax || 1200;
  return min >= max ? min : min + Math.random() * (max - min);
}

let scoutReqCount = 0;      // 已發出的請求數（輪流換區用）
let scoutInFlight = 0;      // 目前在飛的請求數
let scoutBusy = false;      // 開衝/暫停中，此時落地的回應一律丟棄
let scoutWinNormal = 0;     // 摘要視窗：正常回應數
let scoutWinTotal = 0;      // 摘要視窗：總回應數
let scoutConsecAnomaly = 0; // 連續異常回應數（任何正常回應即歸零）

// 遞迴找擁有指定函式的 window（叫出驗證視窗用）
function findWinWithNamedFn(doc, name, depth) {
  if (!doc || depth > 5) return null;
  try {
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        const win = iframe.contentWindow;
        if (typeof win[name] === 'function') return win;
        const found = findWinWithNamedFn(iframe.contentDocument, name, depth + 1);
        if (found) return found;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// ─── 驗證暫停：自動叫出驗證視窗，解鎖後自動恢復偵察 ───────
// 伺服器風控標記 session 後，座位頁回應會變成
// <script>parent.CaptchaOpen('S','seat')</script>；正常流程由頁面執行它彈窗，
// 我們用 fetch 繞過了頁面，所以要替頁面把驗證視窗叫出來給使用者解
function pauseForCaptcha(source, responseText) {
  if (timer) { clearTimeout(timer); timer = null; }
  scoutBusy = true;
  const pausedAt = Date.now();
  log(`🔒 偵測到驗證要求（${source}），暫停偵察（持續時間照常計算）`, {
    event: 'captcha', source, action: 'pause', sinceStartMs: pausedAt - startTime, attempts: scoutReqCount,
  });
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'CAPTCHA_PAUSE' } }, '*');

  let opened = false;
  try {
    const m = responseText ? responseText.match(/CaptchaOpen\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/) : null;
    let win = null;
    if (typeof window.CaptchaOpen === 'function') win = window;
    else win = findWinWithNamedFn(document, 'CaptchaOpen', 0);
    if (win) {
      win.CaptchaOpen(m ? m[1] : 'S', m ? m[2] : 'seat');
      opened = true;
      log('🔓 已自動開啟驗證視窗，完成驗證後會自動恢復偵察');
    }
  } catch (e) {
    log(`開啟驗證視窗失敗: ${e.message}`);
  }
  if (!opened) log('⚠️ 無法自動開啟驗證視窗，請手動點擊任一區域讓驗證跳出並完成');

  // 每秒檢查遮罩：出現過且消失 = 驗證完成 → 自動恢復
  let seen = false;
  const poll = setInterval(() => {
    if (!isRunning) { clearInterval(poll); return; }
    if (findCaptchaInDoc(document, 0)) { seen = true; return; }
    if (seen) {
      clearInterval(poll);
      log('✅ 驗證完成，恢復偵察', { event: 'captcha_resumed', pausedMs: Date.now() - pausedAt });
      window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'CAPTCHA_RESUMED' } }, '*');
      scoutConsecAnomaly = 0;
      cycleFn(); // scoutTick 開頭會解除 scoutBusy
    }
  }, 1000);
}

// 執行期從頁面 fnBlockSeatUpdate 原始碼抽出 BookSeatDetail 網址模板
// （SessionId/GoodsCode 等參數寫死在該函式內，PlaySeq 從表單欄位取）
function buildScoutUrlTemplate() {
  let win = null;
  if (typeof window.fnBlockSeatUpdate === 'function') win = window;
  else win = findWinWithFn(document, 0);
  if (!win) { log('⚠️ 偵察初始化：找不到 fnBlockSeatUpdate（請確認在訂票頁面）'); return null; }

  try {
    const src = win.fnBlockSeatUpdate.toString();
    const raw = [...src.matchAll(/url\s*\+?=\s*"([^"]*)"/g)].map(m => m[1]).join('');
    const qIdx = raw.indexOf('?');
    if (!raw.includes('BookSeatDetail.asp') || qIdx < 0) {
      log('⚠️ 偵察初始化：抽不出 BookSeatDetail 網址骨架（網站可能已改版）');
      return null;
    }

    let playSeq = '';
    try { playSeq = win.document.getElementById('PlaySeq')?.value || ''; } catch (_) {}
    if (!playSeq) { log('⚠️ 偵察初始化：抓不到 PlaySeq（場次序號）'); return null; }

    const path = raw.slice(0, qIdx);
    const baseParams = new URLSearchParams(raw.slice(qIdx + 1));
    baseParams.set('PlaySeq', playSeq);
    baseParams.set('SeatGrade', '');
    baseParams.set('SeatCheckCnt', '0');

    return (zone) => {
      const p = new URLSearchParams(baseParams);
      p.set('Block', zone);
      return path + '?' + p.toString();
    };
  } catch (e) {
    log(`⚠️ 偵察初始化失敗: ${e.message}`);
    return null;
  }
}

// 座位頁原始 HTML 是無引號的 class=SeatN，正則需同時相容有無引號
function countSeatN(text) {
  return (text.match(/class=["']?SeatN\b/g) || []).length;
}

// 分類 fetch 回應：SEAT 座位頁 / DENIED 被擋 / CAPTCHA 驗證 / ANOMALY 異常
function classifyResponse(status, text) {
  if (status === 403 || text.includes('Access Denied')) return 'DENIED';
  if (/class=["']?Seat[NRB]\b/.test(text)) return 'SEAT';
  if (/captch|divCaptchaWrap/i.test(text)) return 'CAPTCHA';
  return 'ANOMALY';
}

// ─── 發現即提交：從偵察回應直接解析座位參數並提交，繞過進場 ──
// 座位頁每個可選座位帶 onclick="SelectSeat(this,'SeatGrade','Floor','RowNo','SeatNo','Block')"
function parseFirstSeatParams(html) {
  const m = html.match(/class=["']?SeatN\b[^>]*onclick="SelectSeat\(this,'([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'\)/);
  return m ? m.slice(1, 6) : null;
}

// 遞迴找同時擁有 fnAddSeat 與 fnSetPointDiscount 的 window（跨 iframe）
function findSeatFnWin(win, depth) {
  if (!win || depth > 5) return null;
  try {
    if (typeof win.fnAddSeat === 'function' && typeof win.fnSetPointDiscount === 'function') return win;
  } catch (_) {}
  try {
    for (let i = 0; i < win.frames.length; i++) {
      const r = findSeatFnWin(win.frames[i], depth + 1);
      if (r) return r;
    }
  } catch (_) {}
  return null;
}

// 用頁面函式直接選位並提交（fnAddSeat + fnSetPointDiscount）；成功回傳 true
function submitSeatByParams(params) {
  const win = findSeatFnWin(window, 0);
  if (!win) { log('[發現即提交] 找不到選位函式 window'); return false; }
  try {
    const ok = win.fnAddSeat(params[0], params[1], params[2], params[3], params[4]);
    if (!ok) { log('[發現即提交] fnAddSeat 回傳 false（座位已滿/無效）'); return false; }
    win.fnSetPointDiscount();
    log(`[發現即提交] 已送出 ${params[4]}區 ${params[2]} ${params[3]}`);
    return true;
  } catch (e) {
    log(`[發現即提交] 失敗: ${e.message}`);
    return false;
  }
}

// 命中後開衝（清掉節拍器、設 busy 讓其他落地回應作廢）
async function scoutStrike(zone, n, html) {
  if (timer) { clearTimeout(timer); timer = null; }
  scoutBusy = true;
  deniedStreak = 0;
  scoutConsecAnomaly = 0;
  const strikeAt = Date.now();
  log(`🎯 偵察命中：${zone} 區有 ${n} 個可選座位，開衝！`, { event: 'scout_hit', zone, seats: n });

  // 優先走「發現即提交」：直接從回應解析座位參數、用頁面函式提交，繞過進場
  const params = html ? parseFirstSeatParams(html) : null;
  const direct = params ? submitSeatByParams(params) : false;
  trace('submit_attempt', { zone, path: 'direct', parsed: !!params, ok: direct, seat: params ? params.slice(1, 5) : null });
  if (direct) {
    await new Promise(r => setTimeout(r, 200));
    // 提交後被驗證擋下 → 暫停等解鎖
    if (findCaptchaInDoc(document, 0)) { pauseForCaptcha('選位提交', null); return; }
    // 等票數頁載入、自動填 1 張並按下一步
    const ok = await fillTicketCount();
    trace('submit_result', { zone, path: 'direct', reachedPricePage: ok, sinceHitMs: Date.now() - strikeAt });
    if (ok) {
      window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SEAT_FOUND', zone } }, '*');
      stop('FOUND');
      return;
    }
    // 沒進到票數頁 → 座位可能被搶走（撲空），恢復滴灌繼續掃
    log('發現即提交後未進入票數頁（可能撲空），繼續偵察...');
    timer = setTimeout(scoutTick, 300);
    return;
  }

  // fallback：解析失敗或函式不可用 → 走舊的進場點擊
  log('[發現即提交] 無法使用，改用進場點擊');
  const res = await enterZoneAndPick(zone);
  trace('submit_result', { zone, path: 'fallback', result: res, loadMs: lastSeatLoadMs, sinceHitMs: Date.now() - strikeAt });
  if (res === 'FOUND') return; // enterZoneAndPick 內已 stop('FOUND')
  if (res === 'DENIED')  { handleDeniedPause(); return; }
  if (res === 'CAPTCHA') { pauseForCaptcha('選位頁', null); return; }
  // 撲空（票剛被別人搶走）→ 立刻恢復滴灌
  log('撲空，繼續偵察...');
  timer = setTimeout(scoutTick, 300);
}

// 發出單一區域的偵察請求；回應落地當下立即分類處理
async function scoutFetch(zone) {
  scoutInFlight++;
  const inflightAtSend = scoutInFlight;
  const sentAt = Date.now();
  let status = 0, text = null;
  try {
    const resp = await fetch(scoutBuildUrl(zone), { cache: 'no-store' });
    status = resp.status;
    text = await resp.text();
  } catch (_) { /* 網路錯誤 → 視為異常回應 */ }
  scoutInFlight--;

  if (!isRunning || scoutBusy) return; // 已停止 / 開衝中 / 暫停中 → 丟棄

  scoutWinTotal++;
  const kind = text === null ? 'ANOMALY' : classifyResponse(status, text);
  trace('scout_resp', {
    zone, kind, status, latencyMs: Date.now() - sentAt, inflight: inflightAtSend,
    seats: kind === 'SEAT' ? countSeatN(text) : null, bytes: text ? text.length : 0,
  });

  if (kind === 'SEAT') {
    scoutWinNormal++;
    scoutConsecAnomaly = 0;
    deniedStreak = 0; // 正常看到座位頁 → Denied 連續計數歸零
    const n = countSeatN(text);
    if (n > 0) scoutStrike(zone, n, text);
    return;
  }

  if (kind === 'DENIED') {
    if (timer) { clearTimeout(timer); timer = null; }
    scoutBusy = true; // 暫停期間落地的回應作廢；恢復時 scoutTick 會解除
    handleDeniedPause();
    return;
  }

  if (kind === 'CAPTCHA') {
    pauseForCaptcha(`偵察回應（${zone} 區）`, text);
    return;
  }

  // ANOMALY：連續異常達門檻（2 輪份量）→ 停止
  scoutConsecAnomaly++;
  const limit = Math.max(4, (config.zones?.length || 2) * 2);
  if (scoutConsecAnomaly >= limit) {
    if (timer) { clearTimeout(timer); timer = null; }
    log(`⚠️ 連續 ${scoutConsecAnomaly} 個回應異常，停止搶票。請檢查頁面（可能 session 已失效）`, { event: 'scout_anomaly_stop', count: scoutConsecAnomaly });
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SCOUT_ANOMALY' } }, '*');
    stop('ANOMALY');
  }
}

// 滴灌節拍器：固定間隔發下一個請求（輪流換區），
// 回應何時落地不影響節奏；在飛達上限時憋著不發
function scoutTick() {
  if (!isRunning) return;
  scoutBusy = false; // 每次（重新）開始滴灌都解除 busy

  if (config.durationMs > 0 && Date.now() - startTime > config.durationMs) {
    log(`已達設定時間，停止搶票`);
    stop('TIMEOUT');
    return;
  }

  const zones = config.zones;
  if (!zones?.length) { log('未設定任何區域'); stop('NO_ZONES'); return; }

  // 頁面自己彈出驗證遮罩 → 暫停等解鎖
  if (findCaptchaInDoc(document, 0)) { pauseForCaptcha('頁面', null); return; }

  // 在飛達上限（伺服器變慢）→ 憋著，稍後再試，保證併發不疊到 3
  if (scoutInFlight >= SCOUT_MAX_INFLIGHT) {
    timer = setTimeout(scoutTick, 200);
    return;
  }

  // 背景監控鎖定某有票區時集中火力偵察該區；否則在「指定區扣掉排除區」中輪詢
  let zone = monitorOverride?.zone;
  if (!zone) {
    const active = zones.filter(z => !isExcluded(z));
    if (!active.length) {
      if (config.monitorEnabled) { timer = setTimeout(scoutTick, scoutRandomInterval()); return; }
      log('⚠️ 所有指定區域都在排除清單中，無可刷區域'); stop('NO_ZONES'); return;
    }
    zone = active[scoutReqCount % active.length];
  }
  scoutReqCount++;
  scoutFetch(zone); // 不 await：解析在回應落地時自行進行

  // 偵察鎖定期間，逐次請求本來不印 → 補心跳，讓使用者確定仍在集中刷、剩餘多少
  if (monitorOverride) {
    monitorLockHits++;
    const now2 = Date.now();
    if (now2 - monitorHeartbeatTs >= MONITOR_HEARTBEAT_MS) {
      monitorHeartbeatTs = now2;
      const info = remainMap[zone];
      log(`🎯 ${zone} 集中刷第 ${monitorLockHits} 次·剩餘 ${info ? info.remain : '?'}·仍未搶到`);
    }
  }

  // 每完成一輪（所有區域都發過一次）回報一次：狀態列＋log 都更新，
  // 讓使用者在畫面靜止的偵察模式隨時看得到「還在掃、掃到哪、沒票」
  if (!monitorOverride && scoutReqCount % zones.length === 0) {
    const round = scoutReqCount / zones.length;
    zoneIndex = round; // 供 STATUS 查詢
    const normal = scoutWinNormal, total = scoutWinTotal;
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SCOUT_ROUND', round, zones: zones.length, normal, total } }, '*');
    log(`🛰️ 第 ${round} 輪掃完 ${zones.length} 區 · ${normal}/${total} 正常回應 · 無可選座位`, { event: 'scout_round', round, zones: zones.length, normal, total });
    scoutWinNormal = 0;
    scoutWinTotal = 0;
  }

  timer = setTimeout(scoutTick, scoutRandomInterval());
}

// ─── 背景剩餘座位監控 ────────────────────────────────────
// 執行期從頁面 fnBlockUpdate 原始碼抽出 AllBlock 網址（含 SessionId，寫死在函式內）
function buildRemainUrl() {
  let win = null;
  if (typeof window.fnBlockUpdate === 'function') win = window;
  else win = findWinWithNamedFn(document, 'fnBlockUpdate', 0);
  if (!win) { log('⚠️ 監控初始化：找不到 fnBlockUpdate（請確認在訂票頁面）'); return null; }

  try {
    const src = win.fnBlockUpdate.toString();
    // fnBlockUpdate 是單行 var url = "前段" + $F("PlaySeq") + "後段(含SessionId)";
    // 舊寫法只抓第一個字串字面量會漏掉 $F 之後整段（含 SessionId）→ 改成還原整條運算式。
    // 取所有 url = / url += 的右側（到分號），相容單行串接與多行 += 兩種寫法。
    const segs = [...src.matchAll(/url\s*\+?=\s*([^;]+);/g)].map(m => m[1]);
    if (!segs.length) { log('⚠️ 監控初始化：抽不出 fnBlockUpdate 內的 url 指派'); return null; }

    // 把 $F("欄位") 換成該欄位當前值（轉為字串字面量）；其餘非字面量 token 會在下一步被略過
    const combined = segs.join(' + ').replace(/\$F\(\s*['"]([^'"]+)['"]\s*\)/g, (_, field) => {
      let v = '';
      try { v = win.document.getElementById(field)?.value || ''; } catch (_) {}
      return JSON.stringify(v);
    });

    // 串接所有字串字面量，還原完整 URL
    const url = [...combined.matchAll(/"([^"]*)"|'([^']*)'/g)]
      .map(x => x[1] !== undefined ? x[1] : x[2]).join('');

    if (!url.includes('BookInfoXml.asp') || !url.includes('AllBlock')) {
      log('⚠️ 監控初始化：抽出的網址不含 AllBlock（網站可能已改版）'); return null;
    }
    if (!/SessionId=[^&]+/i.test(url)) {
      log('⚠️ 監控初始化：抽出的網址缺少 SessionId，放棄啟用監控（避免打空請求）'); return null;
    }

    // 核對用：印出網址但遮罩 SessionId，避免完整 token 落在 log
    log(`🛰️ 監控 API 就緒：${url.replace(/(SessionId=)([^&]{0,8})[^&]*/i, '$1$2…')}`);
    return () => url;
  } catch (e) {
    log(`⚠️ 監控初始化失敗: ${e.message}`);
    return null;
  }
}

// 解析 AllBlock 回應 XML → [{ block, remain, grade, gradeName }]（保序）
function parseRemainXml(text) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    for (const t of doc.querySelectorAll('Table')) {
      const block = t.querySelector('SelfDefineBlock')?.textContent?.trim();
      if (!block) continue;
      const remain = parseInt((t.querySelector('RemainCnt')?.textContent || '0').replace(/,/g, ''), 10) || 0;
      out.push({
        block,
        remain,
        grade: t.querySelector('SeatGrade')?.textContent?.trim() || '',
        gradeName: t.querySelector('SeatGradeName')?.textContent?.trim() || '',
      });
    }
  } catch (_) {}
  return out;
}

// 是否為使用者的排除區域（放票重搶時避免重抓同一區）
function isExcluded(zone) {
  return !!(config.excludeZones && config.excludeZones.includes(zone));
}

// 依決策挑目標區：先指定清單內有票者（依清單序），再非指定有票者（依 API 序）；排除區一律略過
function pickTarget() {
  const threshold = config.monitorMinRemain || 1;
  const designated = config.zones || [];
  for (const z of designated) {
    if (!isExcluded(z) && remainMap[z] && remainMap[z].remain >= threshold) return z;
  }
  for (const r of Object.values(remainMap)) {
    if (r.remain >= threshold && !designated.includes(r.block) && !isExcluded(r.block)) return r.block;
  }
  return null;
}

function setMonitorOverride(zone, now) {
  const changed = !monitorOverride || monitorOverride.zone !== zone;
  monitorOverride = { zone, since: now };
  if (changed) {
    monitorLockHits = 0;
    monitorHeartbeatTs = now; // 首次心跳排在切區後約 MONITOR_HEARTBEAT_MS，避免與切區 log 疊在一起
    const info = remainMap[zone];
    log(`🎯 切換到有票區 ${zone}（剩餘 ${info ? info.remain : '?'}）→ 主模式改刷此區`, { event: 'remain_switch', zone, remain: info ? info.remain : null });
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'REMAIN_SWITCH', zone, remain: info ? info.remain : 0 } }, '*');
  }
}

function clearMonitorOverride() {
  if (!monitorOverride) return;
  const { zone, since } = monitorOverride;
  monitorOverride = null;
  log(`↩️ ${zone} 售完且無其他有票區，回到指定區域輪刷`, { event: 'remain_revert', zone, lockedMs: Date.now() - since });
  window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'REMAIN_REVERT', zone } }, '*');
}

// 每次掃描後套用切區決策（承諾機制：鎖定區至少停留 MONITOR_DWELL_MS）
function applyMonitorDecision() {
  const threshold = config.monitorMinRemain || 1;
  const candidate = pickTarget();
  const now = Date.now();

  if (monitorOverride) {
    const cur = remainMap[monitorOverride.zone];
    const curRemain = cur ? cur.remain : 0;
    if (curRemain < threshold) {
      // 鎖定區售完 → 有他區則轉移（重置停留），否則放手回指定區
      if (candidate) setMonitorOverride(candidate, now);
      else clearMonitorOverride();
    } else if (now - monitorOverride.since >= MONITOR_DWELL_MS && candidate && candidate !== monitorOverride.zone) {
      // 滿 60 秒仍未搶到、且他區有票 → 跳去他區
      setMonitorOverride(candidate, now);
    }
    // 否則：承諾期內或無更好選擇 → 續刷目前鎖定區
  } else if (candidate) {
    setMonitorOverride(candidate, now); // 從無到有 → 鎖定
  }
}

// 發一次 AllBlock 掃全區，更新 remainMap，套用決策
async function monitorScan() {
  if (!isRunning || monitorInFlight) return;
  monitorInFlight = true;
  const sentAt = Date.now();
  let status = 0, text = null;
  try {
    const resp = await fetch(monitorBuildUrl(), { cache: 'no-store' });
    status = resp.status;
    text = await resp.text();
  } catch (_) { /* 網路錯誤 → 本次略過 */ }
  monitorInFlight = false;
  if (!isRunning) return;

  const rows = text ? parseRemainXml(text) : [];
  const denied = status === 403 || !!(text && text.includes('Access Denied'));
  trace('remain_scan', {
    status, latencyMs: Date.now() - sentAt, denied, blocks: rows.length,
    avail: rows.filter(r => r.remain > 0).map(r => ({ block: r.block, remain: r.remain })),
  });

  // 被擋：不動 remainMap、不干預；讓主模式的 Denied 處理去暫停
  if (denied) return;

  if (!rows.length) return; // 解析失敗（非全部售完）→ 保留舊表，不清空

  remainMap = {};
  rows.forEach(r => { remainMap[r.block] = r; });

  // 有票區集合變化才 log 摘要，避免每次掃描洗版
  const threshold = config.monitorMinRemain || 1;
  const avail = rows.filter(r => r.remain >= threshold);
  const sig = avail.map(r => `${r.block}:${r.remain}`).join(',');
  if (sig !== monitorLastAvailSig) {
    monitorLastAvailSig = sig;
    if (avail.length) log(`🛰️ 全區掃描：${avail.length} 區有票（${avail.map(r => `${r.block}×${r.remain}`).join('、')}）`);
    else log('🛰️ 全區掃描：目前全數無票');
    window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'REMAIN_SCAN', count: avail.length } }, '*');
  }

  applyMonitorDecision();
}

// 監控節拍器：固定秒數掃一次；被擋/開衝期間跳過本次（避免火上加油）
function monitorTick() {
  if (!isRunning) return;
  if (config.durationMs > 0 && Date.now() - startTime > config.durationMs) return; // 主迴圈會 stop
  const sec = config.monitorInterval || 5;

  if (deniedStreak > 0 || scoutBusy) {
    monitorTimer = setTimeout(monitorTick, sec * 1000);
    return;
  }

  monitorScan().finally(() => {
    if (isRunning) monitorTimer = setTimeout(monitorTick, sec * 1000);
  });
}

function start(cfg) {
  if (isRunning) { log('已在執行中'); return; }
  config = cfg;
  isRunning = true;
  zoneIndex = 0;
  deniedStreak = 0;
  startTime = Date.now();
  logRunId = `run-${startTime}`;
  scoutBuildUrl = null;
  cycleFn = runCycle;

  scoutReqCount = 0;
  scoutInFlight = 0;
  scoutBusy = false;
  scoutWinNormal = 0;
  scoutWinTotal = 0;
  scoutConsecAnomaly = 0;

  monitorOverride = null;
  remainMap = {};
  monitorInFlight = false;
  monitorBuildUrl = null;
  monitorLastAvailSig = '';
  monitorLockHits = 0;
  monitorHeartbeatTs = 0;

  if (cfg.scoutMode) {
    scoutBuildUrl = buildScoutUrlTemplate();
    if (scoutBuildUrl) {
      cycleFn = scoutTick;
      const lo = cfg.scoutIntervalMin || 1000;
      const hi = cfg.scoutIntervalMax || 1200;
      const avg = (lo + hi) / 2;
      log(`🛰️ 偵察模式：每 ${lo}~${hi}ms 隨機發 1 個請求輪流掃描 ${cfg.zones.length} 區（每區約每 ${(avg * cfg.zones.length / 1000).toFixed(1)} 秒檢查一次，併發上限 ${SCOUT_MAX_INFLIGHT}）`);
    } else {
      log('⚠️ 偵察初始化失敗，已自動改用盲輪模式');
      window.postMessage({ [MSG_KEY]: true, dir: 'to-ext', payload: { action: 'SCOUT_FALLBACK' } }, '*');
    }
  }
  if (cycleFn === runCycle) {
    log(`🔄 盲輪模式：換區間隔 ${cfg.intervalMin}~${cfg.intervalMax}ms`);
  }

  // 背景剩餘座位監控：與盲輪/偵察並行，只掃全區 RemainCnt 指揮主模式改刷有票區
  if (cfg.monitorEnabled) {
    monitorBuildUrl = buildRemainUrl();
    if (monitorBuildUrl) {
      const sec = cfg.monitorInterval || 5;
      log(`🛰️ 背景剩餘監控啟動：每 ${sec} 秒掃全區一次（門檻 RemainCnt≥${cfg.monitorMinRemain || 1}，鎖定區至少停留 ${MONITOR_DWELL_MS / 1000} 秒）`);
      monitorTimer = setTimeout(monitorTick, sec * 1000);
    } else {
      log('⚠️ 背景剩餘監控初始化失敗（抓不出 AllBlock 網址），本次不啟用監控');
    }
  }

  log(`開始搶票！區域: [${cfg.zones.join(', ')}]，持續: ${cfg.durationMs / 60000} 分鐘`, {
    event: 'start',
    mode: cycleFn === scoutTick ? 'scout' : 'blind',
    zones: cfg.zones, excludeZones: cfg.excludeZones || [],
    intervalMin: cfg.intervalMin, intervalMax: cfg.intervalMax,
    scoutIntervalMin: cfg.scoutIntervalMin, scoutIntervalMax: cfg.scoutIntervalMax,
    durationMs: cfg.durationMs,
    monitor: monitorBuildUrl ? { interval: cfg.monitorInterval || 5, minRemain: cfg.monitorMinRemain || 1 } : null,
  });
  cycleFn();
}

function stop(reason) {
  isRunning = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  monitorOverride = null;
  log(`已停止（${reason || 'MANUAL'}）`, {
    event: 'stop', reason: reason || 'MANUAL',
    elapsedMs: startTime ? Date.now() - startTime : null,
    attempts: cycleFn === scoutTick ? scoutReqCount : zoneIndex,
  });
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
  else if (msg.action === 'WATCH_SEATMAP')   { payload = { ok: startWatchSeatMap(msg.rows || [], msg.timeoutMin || 0) }; }
  else if (msg.action === 'STOP_WATCH_SEATMAP') { stopWatchSeatMap(); stopModalRecorder(); payload = { ok: true }; }
  else if (msg.action === 'SCAN_SEAT_BLOCKS')   { payload = { ok: true, blocks: scanSeatBlocks() }; }
  else if (msg.action === 'HIGHLIGHT_SEAT_BLOCK') { payload = { ok: highlightSeatBlock(msg.key) }; }

  window.postMessage({ [MSG_KEY]: true, dir: 'response', action: msg.action, payload }, '*');
};
window.addEventListener('message', window.__nolMsgHandler);

console.log('[NOL搶票] content-main.js 已載入（MAIN world）');
} // end guard
