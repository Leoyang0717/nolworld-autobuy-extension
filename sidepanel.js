// sidepanel.js - NOL World 搶票助手 UI 控制邏輯

// ─── 狀態 ──────────────────────────────────────────────────
let zones = [];
let isRunning = false;
let isWatching = false;
let statsTimer = null;
let startTimestamp = null;

// ─── DOM ───────────────────────────────────────────────────
const zoneWrapper = document.getElementById('zoneWrapper');
const zoneInput   = document.getElementById('zoneInput');
const startBtn    = document.getElementById('startBtn');
const stopBtn     = document.getElementById('stopBtn');
const statusBox   = document.getElementById('statusBox');
const statsRow    = document.getElementById('statsRow');
const attemptEl   = document.getElementById('attemptCount');
const elapsedEl   = document.getElementById('elapsedTime');
const logBox      = document.getElementById('logBox');

// ─── 預約按鈕監聽 ──────────────────────────────────────────
const watchReserveBtnEl     = document.getElementById('watchReserveBtn');
const stopWatchReserveBtnEl = document.getElementById('stopWatchReserveBtn');

async function sendToWatchTab(msg) {
  const tab = await getWatchTab();
  if (!tab) {
    appendLog('找不到 tickets.interpark.com 預約頁面，請先開啟', 'error');
    return null;
  }
  const ready = await ensureContentScript(tab.id);
  if (!ready) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    appendLog(`訊息傳送失敗: ${e.message}`, 'error');
    return null;
  }
}

watchReserveBtnEl.addEventListener('click', async () => {
  const res = await sendToWatchTab({ action: 'WATCH_RESERVE' });
  if (!res?.ok) return;
  isWatching = true;
  watchReserveBtnEl.style.display     = 'none';
  stopWatchReserveBtnEl.style.display = 'block';
  setStatus('👁️ 監聽預約按鈕中...解鎖後自動點擊', 'watching');
  appendLog('▶ 開始監聽預約按鈕', 'success');
});

stopWatchReserveBtnEl.addEventListener('click', async () => {
  await sendToWatchTab({ action: 'STOP_WATCH' });
  isWatching = false;
  watchReserveBtnEl.style.display     = 'block';
  stopWatchReserveBtnEl.style.display = 'none';
  setStatus('💤 尚未啟動', 'idle');
  appendLog('⏸ 已停止監聽');
});

// ─── 區域 Tag 管理 ─────────────────────────────────────────
function addZone(code) {
  code = code.trim().replace(/[,，]/g, '');
  if (!code || zones.includes(code)) return;
  zones.push(code);
  renderZones();
  saveSettings();
}

function removeZone(code) {
  zones = zones.filter(z => z !== code);
  renderZones();
  saveSettings();
}

function renderZones() {
  // 清除舊 tag（保留 input）
  [...zoneWrapper.querySelectorAll('.zone-tag')].forEach(el => el.remove());
  zones.forEach(code => {
    const tag = document.createElement('div');
    tag.className = 'zone-tag';
    tag.innerHTML = `${code}<span class="zone-tag-remove" data-code="${code}">×</span>`;
    zoneWrapper.insertBefore(tag, zoneInput);
  });
  // 綁定移除按鈕
  zoneWrapper.querySelectorAll('.zone-tag-remove').forEach(btn => {
    btn.addEventListener('click', () => removeZone(btn.dataset.code));
  });
}

zoneWrapper.addEventListener('click', () => zoneInput.focus());

zoneInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault();
    addZone(zoneInput.value);
    zoneInput.value = '';
  } else if (e.key === 'Backspace' && zoneInput.value === '' && zones.length > 0) {
    removeZone(zones[zones.length - 1]);
  }
});

zoneInput.addEventListener('blur', () => {
  if (zoneInput.value.trim()) {
    addZone(zoneInput.value);
    zoneInput.value = '';
  }
});

// ─── 設定存取 ──────────────────────────────────────────────
function saveSettings() {
  chrome.storage.local.set({
    nolZones: zones,
    nolIntervalMin: parseInt(document.getElementById('intervalMin').value),
    nolIntervalMax: parseInt(document.getElementById('intervalMax').value),
    nolDuration:    parseInt(document.getElementById('duration').value),
  });
}

async function loadSettings() {
  const s = await chrome.storage.local.get(['nolZones', 'nolIntervalMin', 'nolIntervalMax', 'nolDuration']);
  if (s.nolZones) { zones = s.nolZones; renderZones(); }
  if (s.nolIntervalMin) document.getElementById('intervalMin').value = s.nolIntervalMin;
  if (s.nolIntervalMax) document.getElementById('intervalMax').value = s.nolIntervalMax;
  if (s.nolDuration)    document.getElementById('duration').value    = s.nolDuration;
}

['intervalMin', 'intervalMax', 'duration'].forEach(id =>
  document.getElementById(id).addEventListener('change', saveSettings)
);

// ─── 日誌 ──────────────────────────────────────────────────
function appendLog(msg, type = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ` log-${type}` : '');
  line.textContent = msg;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
  // 最多保留 200 行
  while (logBox.children.length > 200) logBox.removeChild(logBox.firstChild);
}

document.getElementById('clearLog').addEventListener('click', () => {
  logBox.innerHTML = '';
});

// ─── 狀態 UI ───────────────────────────────────────────────
function setStatus(text, type) {
  statusBox.textContent = text;
  statusBox.className = `status-box status-${type}`;
}

function startStatsTimer() {
  startTimestamp = Date.now();
  statsRow.style.display = 'block';
  statsTimer = setInterval(updateStats, 500);
}

function stopStatsTimer() {
  clearInterval(statsTimer);
}

function updateStats() {
  const elapsed = Math.floor((Date.now() - startTimestamp) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  elapsedEl.textContent = `${m}:${s}`;
}

// ─── 與 Content Script 通訊 ────────────────────────────────
async function getNolTab() {
  const tabs = await chrome.tabs.query({ url: 'https://gpoticket.globalinterpark.com/*' });
  return tabs[0] || null;
}

async function getWatchTab() {
  const tabs = await chrome.tabs.query({ url: 'https://tickets.interpark.com/*' });
  return tabs[0] || null;
}

async function ensureContentScript(tabId) {
  // 確認兩支腳本都已載入
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => !!window.__nolMainLoaded,
    });
    if (results?.[0]?.result === true) return true;
  } catch (_) {}

  // 尚未載入 → 注入 bridge（ISOLATED）+ main（MAIN world）
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-bridge.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-main.js'],
      world: 'MAIN',
    });
    appendLog('已動態注入 content script', 'success');
    await new Promise(r => setTimeout(r, 400));
    return true;
  } catch (e) {
    appendLog(`注入失敗: ${e.message}`, 'error');
    return false;
  }
}

async function sendToContent(msg) {
  const tab = await getNolTab();
  if (!tab) {
    appendLog('找不到 NOL World 訂票頁面，請先開啟 gpoticket.globalinterpark.com', 'error');
    return null;
  }
  const ready = await ensureContentScript(tab.id);
  if (!ready) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    appendLog(`訊息傳送失敗: ${e.message}`, 'error');
    return null;
  }
}

// ─── 開始 / 停止 ────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  if (zones.length === 0) {
    setStatus('⚠️ 請先設定目標區域', 'error');
    return;
  }

  const config = {
    zones,
    intervalMin:  parseInt(document.getElementById('intervalMin').value) || 800,
    intervalMax:  parseInt(document.getElementById('intervalMax').value) || 1500,
    durationMs:   (parseInt(document.getElementById('duration').value) || 9) * 60 * 1000,
  };

  const res = await sendToContent({ action: 'START', config, _ts: Date.now() });
  if (!res) return;

  isRunning = true;
  startBtn.style.display = 'none';
  stopBtn.style.display  = 'block';
  setStatus(`🔄 刷票中... 區域: [${zones.join(', ')}]`, 'running');
  startStatsTimer();
  appendLog(`▶ 開始搶票，區域: [${zones.join(', ')}]`, 'success');
});

stopBtn.addEventListener('click', async () => {
  await sendToContent({ action: 'STOP' });
  handleStopped('MANUAL');
});

function handleStopped(reason) {
  isRunning = false;
  startBtn.style.display = 'block';
  stopBtn.style.display  = 'none';
  stopStatsTimer();

  if (reason === 'FOUND') {
    setStatus('✅ 找到綠葡萄！已自動點擊，請確認座位！', 'found');
    appendLog('🍇 找到綠葡萄！已點擊座位', 'found');
  } else if (reason === 'CAPTCHA') {
    setStatus('🔒 出現驗證碼，請手動完成驗證', 'error');
    appendLog('🔒 偵測到驗證碼，已停止搶票', 'error');
  } else if (reason === 'TIMEOUT') {
    setStatus('⏱️ 時間到，已停止', 'idle');
    appendLog('⏱ 達到設定時間，已停止');
  } else {
    setStatus('💤 已停止', 'idle');
    appendLog('⏸ 已手動停止');
  }
}

// ─── 監聽來自 content script 的事件 ──────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'LOG') {
    const isFound   = msg.message.includes('[GREEN]') || msg.message.includes('✅');
    const isError   = msg.message.includes('失敗') || msg.message.includes('找不到');
    const type = isFound ? 'found' : isError ? 'error' : '';
    appendLog(msg.message, type);

    // 更新嘗試次數
    const match = msg.message.match(/第 (\d+) 次/);
    if (match) attemptEl.textContent = match[1];
  }

  if (msg.action === 'RESERVE_BTN_CLICKED') {
    isWatching = false;
    watchReserveBtnEl.style.display     = 'block';
    stopWatchReserveBtnEl.style.display = 'none';
    setStatus('✅ 預約按鈕已點擊！進入下一步...', 'found');
    appendLog('🚀 預約按鈕解鎖並已點擊！', 'found');
    playFoundBeep();
  }

  if (msg.action === 'SEAT_FOUND') {
    handleStopped('FOUND');
    playFoundBeep();
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'NOL World 搶票成功！',
      message: `在 ${msg.zone} 區域找到綠葡萄，已自動點擊！請確認座位`,
      priority: 2,
    });
  }

  if (msg.action === 'CAPTCHA') {
    handleStopped('CAPTCHA');
    playWarningBeep();
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '⚠️ 出現驗證碼！',
      message: '搶票已停止，請完成驗證後重新開始搶票',
      priority: 2,
    });
  }

  if (msg.action === 'STOPPED' && isRunning) {
    handleStopped(msg.reason);
  }
});

// ─── F6 緊急停止 ────────────────────────────────────────────
document.addEventListener('keydown', async e => {
  if (e.key === 'F6') {
    await sendToContent({ action: 'STOP' });
    handleStopped('MANUAL');
  }
});

// ─── 嗶嗶聲提示 ────────────────────────────────────────────
// 搶到票：連嗶三聲高音（880Hz，興奮感）
function playFoundBeep() {
  try {
    const ctx = new AudioContext();
    [0, 0.3, 0.6].forEach(startAt => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.5, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startAt + 0.2);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + 0.2);
    });
  } catch (e) {
    console.warn('無法播放提示音:', e);
  }
}

// 驗證碼：兩聲低沉下降音（440→330Hz，警示感）
function playWarningBeep() {
  try {
    const ctx = new AudioContext();
    [{ start: 0, freq: 440 }, { start: 0.4, freq: 330 }].forEach(({ start, freq }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.4, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.35);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.35);
    });
  } catch (e) {
    console.warn('無法播放提示音:', e);
  }
}

// ─── 初始化 ─────────────────────────────────────────────────
loadSettings();
appendLog('NOL World 搶票助手已就緒');

const { version } = chrome.runtime.getManifest();
document.getElementById('versionLabel').textContent = `v${version}`;
