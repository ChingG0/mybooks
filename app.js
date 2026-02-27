/* =============================================
   啾啾說書 — app.js  (按需 OCR 版)
   =============================================
   策略：
   1. 上傳後只做 PDF 解析，不預先 OCR 全書
   2. 翻到某頁時才 OCR 該頁（如果還沒做過）
   3. 朗讀時同步在背景預先 OCR 接下來 2 頁
   4. 已 OCR 的頁面快取，不重複處理
   ============================================= */

// ── PDF.js 初始化 ──────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';


// ── 全域狀態 ───────────────────────────────
let pdfDoc         = null;
let totalPages     = 0;
let currentPage    = 1;
let hasEmbedded    = false;   // 是否有內嵌文字（非掃描）

// OCR 快取：pageTexts[i] = string | null（null = 尚未處理）
let pageTexts      = [];

// 正在進行中的 OCR Promise（避免同頁重複觸發）
let ocrInProgress  = {};      // { pageNum: Promise<string> }
let currentBookId  = null;    // 目前開啟的書 id（藏書用）

let isPlaying      = false;
let isPaused       = false;
let utterance      = null;
let speechRate     = 1.0;
let selectedVoice  = null;   // 使用者選擇的人聲（null = 自動）

const RENDER_SCALE = 2.0;
const PREFETCH     = 2;       // 預載接下來幾頁

// Google Vision API Key 從 sidebar 輸入框讀取


// ── 啾啾鞋說書風格 ─────────────────────────
const JUJU = {
  pitch: 1.1,
  intros: [
    '',
  ],
  outros: [
    '',
  ],
  transform(text) {
    return text
      .replace(/這是/g,     '這！就是！')
      .replace(/非常重要/g, '非常！非常重要')
      .replace(/值得注意/g, '這點超值得注意')
      .replace(/研究顯示/g, '研究竟然顯示')
      .replace(/例如/g,     '舉個例子喔，')
      .replace(/因此/g,     '所以你看，')
      .replace(/總結/g,     '來做個總結，');
  },
  build(rawText) {
    const intro = this.intros[Math.floor(Math.random() * this.intros.length)];
    const outro = this.outros[Math.floor(Math.random() * this.outros.length)];
    return `${intro}\n\n${this.transform(rawText)}\n\n${outro}`;
  },
};


// ── Debug ──────────────────────────────────
function log(msg, type = 'info') {
  const colors = { info: '#4f4', warn: '#ff0', error: '#f55', ok: '#4df' };
  const time   = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  console.log(`[${time}] ${msg}`);
  const body = document.getElementById('debugBody');
  if (body) {
    const el = document.createElement('div');
    el.style.color = colors[type] || '#4f4';
    el.textContent = `[${time}] ${msg}`;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }
}

function toggleDebug() {
  const p = document.getElementById('debugPanel');
  p.style.display = p.style.display === 'none' ? 'flex' : 'none';
}


// ── 上傳事件 ───────────────────────────────
const uploadZone   = document.getElementById('uploadZone');
const pdfFileInput = document.getElementById('pdfFileInput');

pdfFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!checkApiKey()) return;
  log(`📄 選擇: ${file.name}`);
  loadPDF(file);
});

uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!checkApiKey()) return;
  loadPDF(file);
});

// ── API Key 檢查 ────────────────────────────
function checkApiKey() {
  const key = (document.getElementById('apiKeyInput')?.value || '').trim();
  if (key) return true;

  // 沒填 → 搖動 API Key 欄位並提示
  const panel = document.getElementById('apiKeyInput');
  const wrap  = panel?.closest('.panel') || panel?.parentElement;

  // 高亮欄位
  if (panel) {
    panel.style.borderColor = '#e55';
    panel.style.boxShadow   = '0 0 0 3px rgba(220,50,50,0.18)';
    panel.focus();
    setTimeout(() => {
      panel.style.borderColor = '';
      panel.style.boxShadow   = '';
    }, 2500);
  }

  // 搖動整個 panel
  if (wrap) {
    wrap.classList.remove('shake-panel');
    void wrap.offsetWidth;
    wrap.classList.add('shake-panel');
  }

  // 顯示提示訊息
  showApiKeyHint();

  // 重置 file input（讓同一個檔案也能重新觸發）
  pdfFileInput.value = '';
  return false;
}

function showApiKeyHint() {
  let hint = document.getElementById('apiKeyHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id        = 'apiKeyHint';
    hint.className = 'api-key-hint';
    const panel = document.getElementById('apiKeyInput')?.closest('.panel');
    if (panel) panel.appendChild(hint);
  }
  hint.textContent = '⚠️ 請先填入 API Key 再上傳 PDF';
  hint.style.display = 'block';
  clearTimeout(hint._timer);
  hint._timer = setTimeout(() => hint.style.display = 'none', 3000);
}


// ── 讀取 PDF → 全自動辨識 → 下載 JSON ────
async function loadPDF(file) {
  if (file.type !== 'application/pdf') {
    showError(`不支援的格式：${file.type || '未知'}`, ['請上傳 <strong>.pdf</strong> 檔案']);
    return;
  }

  stopReading();
  showLoading();

  const title = file.name.replace(/\.pdf$/i, '');

  try {
    // ── Step 1: 讀取檔案 ──
    setStep('step-read', 'active');
    setBarProgress(5, '讀取檔案...', `${Math.round(file.size/1024)} KB`);
    const buf = await file.arrayBuffer();
    setStep('step-read', 'done');
    setBarProgress(15, '檔案讀取完成', `${Math.round(buf.byteLength/1024)} KB`);

    // ── Step 2: PDF.js 解析 ──
    setStep('step-parse', 'active');
    setBarProgress(20, '解析 PDF 結構...', '');
    pdfDoc     = await pdfjsLib.getDocument({ data: buf }).promise;
    totalPages = pdfDoc.numPages;
    log(`✅ PDF 解析完成，共 ${totalPages} 頁`, 'ok');
    setStep('step-parse', 'done');
    setBarProgress(25, `共 ${totalPages} 頁`, '開始辨識...');

    // ── Step 3: 偵測 PDF 類型 ──
    setStep('step-text', 'active');
    const trialContent = await (await pdfDoc.getPage(1)).getTextContent();
    hasEmbedded = trialContent.items.filter(i => i.str.trim()).length > 10;
    log(`PDF 類型: ${hasEmbedded ? '內嵌文字' : '掃描圖片 → OCR'}`, hasEmbedded ? 'ok' : 'warn');
    setStep('step-text', 'done');

    // 初始化
    pageTexts     = new Array(totalPages).fill(null);
    ocrInProgress = {};
    currentPage   = 1;

    // ── Step 4: 全部頁面辨識 ──
    setStep('step-render', 'active');

    for (let p = 1; p <= totalPages; p++) {
      const pct = Math.round(25 + (p / totalPages) * 70);
      setBarProgress(pct, `辨識第 ${p} / ${totalPages} 頁...`, `${Math.round((p/totalPages)*100)}%`);
      updateOcrCounter(p, totalPages);

      if (hasEmbedded) {
        pageTexts[p-1] = await extractVerticalTextFallback(p);
      } else {
        pageTexts[p-1] = await ocrOnePage(p);
      }

      log(`  ✅ 第 ${p}/${totalPages} 頁完成，${pageTexts[p-1].length} 字`, 'ok');
    }

    setStep('step-render', 'done');
    setBarProgress(100, `✅ 全部 ${totalPages} 頁辨識完成！`, '點下方按鈕下載');
    log(`✅ 全部 ${totalPages} 頁辨識完成`, 'ok');

    // 加入藏書
    addToLibrary({
      bookId:     'mybooks_' + title.replace(/[^a-zA-Z0-9一-鿿]/g, '_'),
      title,
      totalPages,
      totalChars: pageTexts.reduce((s, t) => s + (t||'').length, 0),
      pages:      pageTexts.map((text, i) => ({ page: i+1, text: text||'' })),
    });

    // 顯示下載按鈕
    showDownloadReady(title);

    // ── 更新 UI，進入閱讀模式 ──
    document.getElementById('fileInfo').style.display      = 'flex';
    document.getElementById('fileNameLabel').textContent   = file.name;
    document.getElementById('fileDetailLabel').textContent = `${totalPages} 頁 · ${Math.round(file.size/1024)} KB`;
    document.getElementById('nowTitle').textContent        = title;
    document.getElementById('nowSub').textContent          = `✅ 辨識完成 · ${totalPages} 頁 · 已自動下載 JSON`;
    document.getElementById('pageTotalLabel').textContent  = totalPages;
    document.getElementById('btnPrevPage').disabled        = false;
    document.getElementById('btnNextPage').disabled        = false;
    document.getElementById('btnPlay').disabled            = false;
    document.getElementById('progressBarRow').style.display = 'flex';

    await new Promise(r => setTimeout(r, 800));
    await renderPage(1);
    showPageView();

  } catch (err) {
    log(`❌ ${err.message}`, 'error');
    showError(err.message, ['確認是標準 PDF 格式（非加密）', `錯誤：${err.message}`]);
  }
}

// ── 建立書本 JSON 物件 ──────────────────────
function buildBookJson(title) {
  return {
    title,
    totalPages,
    savedAt: new Date().toISOString(),
    pages: pageTexts.map((text, i) => ({ page: i + 1, text: text || '' })),
  };
}

// ── 下載 JSON 檔案 ──────────────────────────
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 顯示下載準備完成 UI ────────────────────
function showDownloadReady(title) {
  const overlay = document.getElementById('downloadReadyOverlay');
  if (!overlay) return;

  document.getElementById('downloadReadyTitle').textContent = `《${title}》`;
  document.getElementById('downloadReadyPages').textContent = `共 ${totalPages} 頁・${pageTexts.reduce((s,t)=>s+(t||'').length,0).toLocaleString()} 字`;
  overlay.style.display = 'flex';

  // 儲存 title 供按鈕使用
  overlay.dataset.title = title;
}

function doDownload() {
  const overlay = document.getElementById('downloadReadyOverlay');
  const title   = overlay?.dataset.title || '書籍';
  const jsonData = buildBookJson(title);

  // 只下載書籍 JSON，不需要 books.json
  downloadJson(jsonData, `${title}.juju.json`);

  overlay.style.display = 'none';
  log(`💾 已下載 ${title}.juju.json`, 'ok');
  log(`👉 把檔案放入 mybooks/ → git push → 所有裝置自動讀取`, 'ok');
}

function cancelDownload() {
  document.getElementById('downloadReadyOverlay').style.display = 'none';
}

// ── 顯示辨識計數器 ──────────────────────────
function updateOcrCounter(current, total) {
  const el = document.getElementById('cacheStatus');
  if (el) el.textContent = `辨識中 ${current}/${total} 頁`;
}


// ── 取得某頁文字（快取 + 按需 OCR）──────────
async function getPageText(pageNum) {
  const idx = pageNum - 1;

  // 已有快取，直接回傳
  if (pageTexts[idx] !== null) return pageTexts[idx];

  // 已在進行中，等它完成（避免重複 OCR 同一頁）
  if (ocrInProgress[pageNum]) {
    return await ocrInProgress[pageNum];
  }

  // 新起一個 OCR 工作
  ocrInProgress[pageNum] = (async () => {
    let text = '';
    try {
      if (hasEmbedded) {
        text = await extractVerticalTextFallback(pageNum);
      } else {
        text = await ocrOnePage(pageNum);
      }
    } catch (e) {
      log(`  ❌ 頁 ${pageNum} 處理失敗: ${e.message}`, 'error');
      text = '';
    }
    pageTexts[idx] = text;
    delete ocrInProgress[pageNum];
    updateCacheStatus();
    return text;
  })();

  return await ocrInProgress[pageNum];
}


// ── Google Vision API OCR ─────────────────
/**
 * 用 Google Cloud Vision DOCUMENT_TEXT_DETECTION 辨識
 * 取得每個文字的 bounding box 座標後，套用直式排序演算法
 * 右→左（欄位）、上→下（欄內）
 */
async function ocrOnePage(pageNum) {
  const apiKey = (document.getElementById('apiKeyInput')?.value || '').trim();
  if (!apiKey) throw new Error('請先在左側輸入 Google Vision API Key');

  log(`🔍 Google Vision OCR 第 ${pageNum} 頁...`);
  setOcrStatus(`⏳ OCR 第 ${pageNum} 頁...`);

  // ── 渲染頁面為 JPEG ──
  const page   = await pdfDoc.getPage(pageNum);
  const vp     = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width  = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];

  // ── 呼叫 Google Vision API ──
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        imageContext: {
          languageHints: ['zh-TW', 'zh'],
        },
      }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const errMsg  = errBody?.error?.message || res.statusText;
    const errCode = errBody?.error?.code || res.status;

    // 針對常見 400 原因給出明確提示
    let hint = '';
    if (errCode === 400) {
      if (errMsg.includes('API key not valid') || errMsg.includes('API_KEY_INVALID')) {
        hint = '\n→ API Key 無效，請確認貼上的是正確的 Google Cloud API Key（格式：AIzaSy...）';
      } else if (errMsg.includes('requests')) {
        hint = '\n→ 請求格式錯誤';
      } else {
        hint = '\n→ 可能原因：①API Key 錯誤 ②Vision API 未啟用 ③圖片太大';
      }
    } else if (errCode === 403) {
      hint = '\n→ 權限不足：請確認已在 Google Cloud Console 啟用 Cloud Vision API';
    } else if (errCode === 429) {
      hint = '\n→ 超過免費額度（每月 1000 次），請明天再試或升級方案';
    }

    log(`  ❌ Vision API ${errCode}: ${errMsg}${hint}`, 'error');
    throw new Error(`Vision API ${errCode}: ${errMsg}${hint}`);
  }

  const data       = await res.json();
  const annotation = data.responses?.[0];

  if (annotation?.error) {
    throw new Error(`Vision API: ${annotation.error.message}`);
  }

  // ── 用 bounding box 做直式排序 ──
  const text = parseVerticalText(annotation, canvas.width, canvas.height);
  log(`  ✅ 頁 ${pageNum} OCR 完成，${text.length} 字`, 'ok');
  setOcrStatus('');
  return text;
}

/**
 * 解析 Google Vision 回傳的 fullTextAnnotation
 * 用每個段落的 bounding box 中心座標做直式排序
 * 右→左（欄位分組）、上→下（欄內排序）
 */
function parseVerticalText(annotation, imgWidth, imgHeight) {
  if (!annotation?.fullTextAnnotation) {
    // 備用：直接用 textAnnotations[0] 的完整文字
    return annotation?.textAnnotations?.[0]?.description?.trim() || '';
  }

  const paragraphs = [];

  for (const page of (annotation.fullTextAnnotation.pages || [])) {
    for (const block of (page.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        // 取得段落中心座標
        const verts = para.boundingBox?.vertices || [];
        if (verts.length < 4) continue;

        const cx = verts.reduce((s, v) => s + (v.x || 0), 0) / verts.length;
        const cy = verts.reduce((s, v) => s + (v.y || 0), 0) / verts.length;

        // 組合段落內所有文字
        let text = '';
        for (const word of (para.words || [])) {
          for (const sym of (word.symbols || [])) {
            text += sym.text || '';
            const brk = sym.property?.detectedBreak?.type;
            if (brk === 'LINE_BREAK' || brk === 'EOL_SURE_SPACE') text += '';
          }
        }

        if (text.trim()) {
          paragraphs.push({ text: text.trim(), cx, cy });
        }
      }
    }
  }

  if (paragraphs.length === 0) {
    return annotation.fullTextAnnotation.text?.trim() || '';
  }

  // ── 直式欄位聚類：X 差 < 閾值視為同欄 ──
  // 對直式書籍：欄寬約 imgWidth / 估計欄數
  const COLUMN_THRESHOLD = Math.max(30, imgWidth * 0.04);
  const columns = [];

  // 先按 X 由大到小（右→左）
  paragraphs.sort((a, b) => b.cx - a.cx);

  for (const para of paragraphs) {
    const col = columns.find(c => {
      const avgX = c.reduce((s, p) => s + p.cx, 0) / c.length;
      return Math.abs(avgX - para.cx) < COLUMN_THRESHOLD;
    });
    if (col) col.push(para);
    else columns.push([para]);
  }

  // 欄位按平均 X 由大到小（右→左）
  columns.sort((a, b) => {
    const ax = a.reduce((s, p) => s + p.cx, 0) / a.length;
    const bx = b.reduce((s, p) => s + p.cx, 0) / b.length;
    return bx - ax;
  });

  // 欄內按 Y 由小到大（上→下）
  columns.forEach(col => col.sort((a, b) => a.cy - b.cy));

  return columns
    .map(col => col.map(p => p.text).join(''))
    .join('')
    .trim();
}

// ── 直式文字備用擷取（有內嵌文字時）────────
async function extractVerticalTextFallback(pageNum) {
  const page    = await pdfDoc.getPage(pageNum);
  const content = await page.getTextContent();
  const vp      = page.getViewport({ scale: 1 });
  const pageH   = vp.height;

  const items = content.items
    .filter(i => i.str.trim().length > 0)
    .map(i => ({ str: i.str, x: i.transform[4], y: pageH - i.transform[5] }));

  if (!items.length) return '';

  items.sort((a, b) => b.x - a.x);
  const columns = [];
  for (const item of items) {
    const col = columns.find(c => {
      const colX = c.reduce((s, i) => s + i.x, 0) / c.length;
      return Math.abs(colX - item.x) <= 20;
    });
    if (col) col.push(item);
    else columns.push([item]);
  }
  columns.sort((a, b) => {
    const ax = a.reduce((s,i)=>s+i.x,0)/a.length;
    const bx = b.reduce((s,i)=>s+i.x,0)/b.length;
    return bx - ax;
  });
  columns.forEach(col => col.sort((a,b) => a.y - b.y));
  return columns.map(col => col.map(i=>i.str).join('')).join('\n').trim();
}


// ── 背景預載下 N 頁 ────────────────────────
function prefetchPages(fromPage) {
  for (let i = 1; i <= PREFETCH; i++) {
    const p = fromPage + i;
    if (p <= totalPages && pageTexts[p-1] === null && !ocrInProgress[p]) {
      log(`  🔄 背景預載第 ${p} 頁`, 'info');
      getPageText(p); // 不 await，讓它在背景跑
    }
  }
}


// ── 渲染頁面 ───────────────────────────────
async function renderPage(pageNum) {
  log(`🖼️ 渲染第 ${pageNum} 頁`);

  // 更新頁碼
  document.getElementById('pageCurrentLabel').textContent = pageNum;
  document.getElementById('btnPrevPage').disabled = pageNum <= 1;
  document.getElementById('btnNextPage').disabled = pageNum >= totalPages;
  updateProgress();
  showPageView();

  // ── 右側文字欄：顯示狀態 ──
  const textScroll = document.getElementById('textScroll');
  const charBadge  = document.getElementById('charBadge');

  // 先顯示 loading 佔位
  const cached = pageTexts[pageNum - 1];
  if (cached === null) {
    textScroll.innerHTML = `<div class="ocr-pending">
      <div class="ocr-spinner"></div>
      <div>OCR 辨識中，請稍候...</div>
    </div>`;
    charBadge.textContent = '辨識中...';
    charBadge.style.cssText = 'background:rgba(255,160,50,0.15);color:#b06010;border:1px solid rgba(255,160,50,0.3)';
  }

  // ── Canvas 渲染（不等文字）──
  try {
    const page   = await pdfDoc.getPage(pageNum);
    const vp     = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.getElementById('pdfCanvas');
    const ctx    = canvas.getContext('2d');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    log(`  ✅ canvas 渲染完成`, 'ok');
  } catch (e) {
    log(`  ❌ canvas 失敗: ${e.message}`, 'error');
  }

  // ── 取得文字（等 OCR，期間 canvas 已顯示）──
  const text = await getPageText(pageNum);

  if (text.length > 0) {
    textScroll.textContent    = text;
    charBadge.textContent     = `✅ ${text.length} 字`;
    charBadge.style.cssText   = 'background:rgba(46,158,110,0.15);color:#2e9e6e;border:1px solid rgba(46,158,110,0.3)';
  } else {
    textScroll.innerHTML = `<div style="color:#c0392b;font-size:0.8rem;padding:0.75rem;background:#fff5f5;border-radius:8px;border:1px solid #fdd;line-height:1.6;">
      ⚠️ 此頁無法辨識文字<br>
      <span style="font-size:0.7rem;color:#aaa;">圖片品質可能過低</span>
    </div>`;
    charBadge.textContent   = '⚠️ 0 字';
    charBadge.style.cssText = 'background:rgba(220,50,50,0.1);color:#c0392b;border:1px solid rgba(220,50,50,0.2)';
  }

  // ── 背景預載下 2 頁 ──
  prefetchPages(pageNum);
}


// ── 翻頁 ───────────────────────────────────
async function prevPage() {
  if (currentPage > 1) {
    stopReading();
    currentPage--;
    if (pdfDoc) await renderPage(currentPage);
    else showJsonPage(currentPage);
    saveCurrentProgress();
  }
}

async function nextPage() {
  if (currentPage < totalPages) {
    stopReading();
    currentPage++;
    if (pdfDoc) await renderPage(currentPage);
    else showJsonPage(currentPage);
    saveCurrentProgress();
  }
}


// ── 播放控制 ───────────────────────────────
function togglePlay() {
  if (!pdfDoc && totalPages === 0) return;  // 完全沒有載入任何書才擋

  if (isPaused) {
    window.speechSynthesis.resume();
    isPaused = false; isPlaying = true;
    document.getElementById('btnPlay').textContent = '⏸';
    setStatus('reading'); showReadingBadge(true);
    return;
  }
  if (isPlaying) {
    window.speechSynthesis.pause();
    isPaused = true; isPlaying = false;
    document.getElementById('btnPlay').textContent = '▶';
    setStatus('paused'); showReadingBadge(false);
    return;
  }
  startReading();
}

async function startReading() {
  log('🎙️ 開始朗讀');

  if (!('speechSynthesis' in window)) {
    alert('您的瀏覽器不支援語音合成，請使用 Chrome 或 Edge！');
    return;
  }

  window.speechSynthesis.cancel();

  // 等這頁文字準備好
  const rawText = await getPageText(currentPage);

  if (!rawText.trim()) {
    log('⚠️ 這頁無文字，跳下一頁', 'warn');
    if (currentPage < totalPages) {
      currentPage++;
      await renderPage(currentPage);
      setTimeout(startReading, 400);
    }
    return;
  }

  const textToRead = JUJU.build(rawText);
  utterance        = new SpeechSynthesisUtterance(textToRead);
  utterance.lang   = 'zh-TW';
  utterance.rate   = speechRate;
  utterance.pitch  = JUJU.pitch;

  // 使用者選擇的人聲，或自動選最佳中文語音
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  } else {
    const voices = window.speechSynthesis.getVoices();
    const voice  =
      voices.find(v => v.lang === 'zh-TW' && v.localService) ||
      voices.find(v => v.lang === 'zh-TW') ||
      voices.find(v => v.lang.startsWith('zh'));
    if (voice) utterance.voice = voice;
  }

  utterance.onstart = () => {
    isPlaying = true; isPaused = false;
    document.getElementById('btnPlay').textContent = '⏸';
    setStatus('reading');
    showReadingBadge(true);
    prefetchPages(currentPage);
    // 顯示朗讀中標籤（閱讀模式）
    const b2 = document.getElementById('readingBadge2');
    if (b2) b2.style.display = 'inline-flex';
  };

  utterance.onend = () => {
    isPlaying = false; isPaused = false;
    document.getElementById('btnPlay').textContent = '▶';
    showReadingBadge(false);
    const _b2 = document.getElementById('readingBadge2'); if (_b2) _b2.style.display = 'none';
    if (currentPage < totalPages) {
      currentPage++;
      const flipPromise = pdfDoc ? renderPage(currentPage) : Promise.resolve(showJsonPage(currentPage));
      flipPromise.then(() => { saveCurrentProgress(); setTimeout(startReading, 500); });
    } else {
      setStatus('done');
    }
  };

  utterance.onerror = e => {
    log(`❌ TTS 錯誤: ${e.error}`, 'error');
    isPlaying = false; isPaused = false;
    document.getElementById('btnPlay').textContent = '▶';
    setStatus('idle'); showReadingBadge(false);
  };

  window.speechSynthesis.speak(utterance);
}

function stopReading() {
  window.speechSynthesis.cancel();
  isPlaying = false; isPaused = false;
  document.getElementById('btnPlay').textContent = '▶';
  setStatus('idle'); showReadingBadge(false);
}


// ── 語速 ───────────────────────────────────
function onSpeedChange(val) {
  speechRate = parseFloat(val);
  document.getElementById('speedBadge').textContent = parseFloat(val).toFixed(1) + 'x';
  log(`⚡ 語速 → ${speechRate}x`);

  // 朗讀中 → 立即重啟當頁（才會套用新語速）
  if (isPlaying) {
    window.speechSynthesis.cancel();
    isPlaying = false;
    setTimeout(() => startReading(), 150);
  }
}

// ── 人聲切換 ───────────────────────────────
function onVoiceChange(voiceName) {
  const voices = window.speechSynthesis.getVoices();
  selectedVoice = voices.find(v => v.name === voiceName) || null;
  log(`🔊 人聲 → ${voiceName || '自動'}`);

  // 朗讀中 → 立即重啟套用
  if (isPlaying) {
    window.speechSynthesis.cancel();
    isPlaying = false;
    setTimeout(() => startReading(), 150);
  }
}

// ── 填充人聲下拉選單 ───────────────────────
function populateVoiceSelect() {
  const voices = window.speechSynthesis.getVoices();
  const sel    = document.getElementById('voiceSelect');
  if (!sel || voices.length === 0) return;

  sel.innerHTML = '';

  // 分組：中文語音 / 其他語音
  const zhVoices    = voices.filter(v => v.lang.startsWith('zh'));
  const otherVoices = voices.filter(v => !v.lang.startsWith('zh'));

  if (zhVoices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '⚠️ 無中文語音（請用 Chrome）';
    sel.appendChild(opt);
    return;
  }

  // 預設：自動
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = '🤖 自動選擇';
  sel.appendChild(autoOpt);

  // 中文語音
  if (zhVoices.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '── 中文語音 ──';
    zhVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      // 標記本地語音
      const tag  = v.localService ? '💻' : '☁️';
      const lang = v.lang === 'zh-TW' ? '繁中' : v.lang === 'zh-CN' ? '簡中' : v.lang;
      opt.textContent = `${tag} ${v.name} (${lang})`;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  // 其他語音（折疊）
  if (otherVoices.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '── 其他語音 ──';
    otherVoices.slice(0, 10).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  // 自動選第一個繁中語音為預設
  const defaultVoice = zhVoices.find(v => v.lang === 'zh-TW') || zhVoices[0];
  if (defaultVoice) {
    sel.value     = defaultVoice.name;
    selectedVoice = defaultVoice;
    log(`🔊 預設語音: ${defaultVoice.name}`, 'ok');
  }

  // 更新 voiceStatus badge
  const statusEl = document.getElementById('voiceStatus');
  if (statusEl) {
    statusEl.textContent = `🔊 ${zhVoices.length} 個中文語音`;
  }
}


// ── OCR 狀態小提示 ─────────────────────────
function setOcrStatus(msg) {
  const el = document.getElementById('ocrStatus');
  if (!el) return;
  el.textContent  = msg;
  el.style.display = msg ? 'block' : 'none';
}

// 更新快取狀態顯示（幾頁已完成）
function updateCacheStatus() {
  const done = pageTexts.filter(t => t !== null).length;
  const el   = document.getElementById('cacheStatus');
  if (el) el.textContent = `已辨識 ${done}/${totalPages} 頁`;

  // 全部辨識完畢（按需 OCR 模式才需要）
  if (done === totalPages && totalPages > 0) {
    const el = document.getElementById('cacheStatus');
    if (el) el.textContent = `✅ 全部 ${totalPages} 頁已辨識`;
  }
}

// ── 儲存辨識結果為 JSON ────────────────────
function saveAsJson() {
  const title = document.getElementById('fileNameLabel')?.textContent
    ?.replace('.pdf', '') || '未命名';

  const data = {
    title,
    totalPages,
    savedAt: new Date().toISOString(),
    pages: pageTexts.map((text, i) => ({
      page: i + 1,
      text: text || '',
    })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${title}.juju.json`;
  a.click();
  URL.revokeObjectURL(url);

  log(`💾 已儲存 ${title}.juju.json（${totalPages} 頁）`, 'ok');

  // 同步加入藏書
  addToLibrary({
    bookId:     `book_${Date.now()}`,
    title,
    totalPages,
    totalChars: pageTexts.reduce((s, t) => s + (t||'').length, 0),
    pages:      pageTexts.map((text, i) => ({ page: i+1, text: text||'' })),
  });

  // 按鈕顯示已儲存
  const btn = document.getElementById('btnSaveJson');
  if (btn) {
    btn.innerHTML = '💾 已儲存！';
    btn.style.background = 'linear-gradient(135deg, #2e9e6e, #3bbd85)';
    setTimeout(() => {
      btn.innerHTML = '💾 儲存辨識結果';
      btn.style.background = '';
    }, 2500);
  }

  // 自動更新並下載 books.json
  autoUpdateBooksJson(title);
}

// 自動把書名加入 books.json 並下載更新版
async function autoUpdateBooksJson(newTitle) {
  const newFilename = `${newTitle}.juju.json`;

  // 讀取現有 books.json
  let currentBooks = [];
  try {
    const res = await fetch('./mybooks/books.json?t=' + Date.now());
    if (res.ok) {
      const data = await res.json();
      currentBooks = data.books || [];
    }
  } catch {}

  // 檢查是否已存在
  const alreadyIn = currentBooks.some(b => b.filename === newFilename);
  if (!alreadyIn) {
    currentBooks.push({ filename: newFilename });
  }

  // 產生新的 books.json 內容
  const newBooksJson = JSON.stringify({
    "_readme": "加入新書：把 .juju.json 放進 mybooks/ 資料夾，執行 python update_books.py，再 git push",
    "books": currentBooks
  }, null, 2);

  // 下載新的 books.json
  const blob = new Blob([newBooksJson], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'books.json';
  a.click();
  URL.revokeObjectURL(url);

  // 顯示提示
  const hint = document.getElementById('mybooksHint');
  if (!hint) return;

  hint.innerHTML = `
    <div class="mybooks-hint-title">📁 一個步驟搞定</div>
    <div class="mybooks-hint-step">① 把 <code>${newFilename}</code> 放入 <code>mybooks/</code></div>
    <div class="mybooks-hint-step" style="margin-top:0.4rem">② git push → 重整頁面，書自動出現 ✅</div>
  `;
  hint.style.display = 'block';

  log(`📋 books.json 已更新並下載（共 ${currentBooks.length} 本書）`, 'ok');
}

// ── 載入已存的 JSON（跳過 OCR）────────────
function loadJson(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);

      if (!data.pages || !Array.isArray(data.pages)) {
        throw new Error('不是有效的 .juju.json 檔案');
      }

      log(`📂 載入 JSON：${data.title}，共 ${data.totalPages} 頁`, 'ok');

      // 重置狀態
      stopReading();
      pdfDoc      = null;  // 沒有 PDF，只有文字
      totalPages  = data.totalPages;
      currentPage = 1;
      hasEmbedded = true;  // 直接用文字，不跑 OCR
      pageTexts   = data.pages.map(p => p.text || '');
      ocrInProgress = {};

      // 更新 UI
      document.getElementById('fileInfo').style.display      = 'flex';
      document.getElementById('fileNameLabel').textContent   = data.title + '.juju.json';
      document.getElementById('fileDetailLabel').textContent =
        `${totalPages} 頁 · 已儲存辨識 · ${new Date(data.savedAt).toLocaleDateString('zh-TW')}`;
      document.getElementById('nowTitle').textContent        = data.title;
      document.getElementById('nowSub').textContent          = `✅ 從快取載入 · 共 ${totalPages} 頁 · 無需 OCR`;
      document.getElementById('pageTotalLabel').textContent  = totalPages;
      document.getElementById('btnPrevPage').disabled        = false;
      document.getElementById('btnNextPage').disabled        = false;
      document.getElementById('btnPlay').disabled            = false;
      document.getElementById('progressBarRow').style.display = 'flex';

      // 顯示第一頁文字（沒有 PDF 就不渲染 canvas）
      showJsonPage(1);
      updateCacheStatus();

      log('✅ JSON 載入完成，直接朗讀', 'ok');

      // 加入藏書
      addToLibrary({
        bookId:     `book_${Date.now()}`,
        title:      data.title,
        totalPages: data.totalPages,
        totalChars: data.pages.reduce((s, p) => s + (p.text||'').length, 0),
        pages:      data.pages,
      });

    } catch (err) {
      log(`❌ JSON 載入失敗: ${err.message}`, 'error');
      showError(`JSON 載入失敗：${err.message}`, [
        '請確認是 .juju.json 格式的檔案',
        '這是由啾啾說書辨識後儲存的專用格式',
      ]);
    }
  };
  reader.readAsText(file);
}

// 純文字模式顯示（無 PDF canvas）
function showJsonPage(pageNum) {
  currentPage = pageNum;

  const text = pageTexts[pageNum - 1] || '';

  // ── 切換到全版閱讀模式 ──
  const pdfLayout    = document.getElementById('pdfLayout');
  const readerLayout = document.getElementById('readerLayout');
  if (pdfLayout)    pdfLayout.style.display    = 'none';
  if (readerLayout) readerLayout.style.display = 'flex';

  // ── 填充閱讀內容 ──
  const readerBody = document.getElementById('readerBody');
  if (readerBody) {
    // 把文字拆成段落，每段用 <p> 包起來方便高亮
    readerBody.innerHTML = text
      ? text.split(/ + /).filter(s => s.trim()).map((para, i) =>
          `<p class="reader-para" data-idx="${i}">${escHtml(para)}</p>`
        ).join('')
      : '<p class="reader-empty">（此頁無文字）</p>';
  }

  // ── 更新標題 ──
  const title = document.getElementById('nowTitle')?.textContent || '';
  const titleEl = document.getElementById('readerTitleLabel');
  if (titleEl) titleEl.textContent = `${title} · 第 ${pageNum} / ${totalPages} 頁`;

  // ── char badge ──
  document.querySelectorAll('#charBadge').forEach(el => {
    el.textContent   = `${text.length} 字`;
    el.style.cssText = 'background:rgba(46,158,110,0.15);color:#2e9e6e;border:1px solid rgba(46,158,110,0.3)';
  });

  document.getElementById('pageCurrentLabel').textContent = pageNum;
  document.getElementById('btnPrevPage').disabled = pageNum <= 1;
  document.getElementById('btnNextPage').disabled = pageNum >= totalPages;
  updateProgress();
  showPageView();
}

// HTML 跳脫（防止 XSS）
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


// ═══════════════════════════════════════════
// 我的藏書（localStorage 持久化）
// ═══════════════════════════════════════════

// 書籍資料來自 mybooks/（GitHub 同步）
// 進度資料存 localStorage（各裝置獨立）
const PROGRESS_KEY = 'juju_progress';    // 每本書的閱讀進度

// 記憶體快取（從 mybooks/ 載入後暫存）
let _booksCache = null;

// 書本 spine 顏色循環
const SPINE_COLORS = [
  '#ff6b2b','#e8854a','#d4a852','#5ba85a',
  '#4a8fc0','#7b68cc','#c06080','#3bbd85',
];

function getSpineColor(idx) {
  return SPINE_COLORS[idx % SPINE_COLORS.length];
}

// ── 讀取書庫（從記憶體快取）──────────────────
// 實際載入由 loadMyBooksFolder() 負責，結果存 _booksCache
function getLibrary() {
  return _booksCache || [];
}

// saveLibrary 在新架構不再寫 localStorage
// 書籍透過 git push mybooks/ 管理
function saveLibrary(books) {
  _booksCache = books;  // 只更新記憶體快取
}

function getProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); }
  catch { return {}; }
}

function saveProgress(bookId, page) {
  const prog = getProgress();
  prog[bookId] = { page, updatedAt: new Date().toISOString() };
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));
}

// ── 加入藏書（辨識完後自動呼叫）──────────────
function addToLibrary(jsonData) {
  const books = getLibrary();
  const existing = books.findIndex(b => b.id === jsonData.bookId);

  const entry = {
    id:         jsonData.bookId || `book_${Date.now()}`,
    title:      jsonData.title || '未命名',
    totalPages: jsonData.totalPages,
    totalChars: jsonData.totalChars || 0,
    addedAt:    new Date().toISOString(),
    pages:      jsonData.pages,
  };

  if (existing >= 0) books[existing] = entry;
  else books.unshift(entry);

  _booksCache = books;        // 只更新記憶體快取
  currentBookId = entry.id;
  renderLibrary();
  log(`📚 「${entry.title}」加入藏書（本次 session）`, 'ok');
}

// ── 從藏書開啟書本 ───────────────────────────
async function openBook(bookId) {
  const books = getLibrary();
  const book  = books.find(b => b.id === bookId);
  if (!book) return;

  stopReading();
  closeLibraryModal();

  // 如果 pages 還沒載入，現在 fetch
  if (!book.pages) {
    log(`📥 載入「${book.title}」...`);

    // 顯示讀取中
    document.getElementById('nowTitle').textContent = book.title;
    document.getElementById('nowSub').textContent   = '載入中...';
    document.getElementById('fileInfo').style.display = 'flex';

    try {
      const r = await fetchMyBook(book.filename);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      book.pages      = data.pages || [];
      book.totalPages = data.totalPages || book.pages.length;
      book.totalChars = book.pages.reduce((s, p) => s + (p.text || '').length, 0);
      book.title      = data.title || book.title;
      book.loaded     = true;
    } catch (e) {
      log(`❌ 無法載入「${book.title}」: ${e.message}`, 'error');
      return;
    }
  }

  // 載入狀態
  pdfDoc        = null;
  totalPages    = book.totalPages;
  hasEmbedded   = true;
  pageTexts     = book.pages.map(p => p.text || '');
  ocrInProgress = {};

  // 恢復上次閱讀進度
  const prog     = getProgress();
  const lastPage = prog[bookId]?.page || 1;
  currentPage    = Math.min(lastPage, totalPages);

  // 更新 UI
  document.getElementById('fileInfo').style.display      = 'flex';
  document.getElementById('fileNameLabel').textContent   = book.title;
  document.getElementById('fileDetailLabel').textContent =
    `${totalPages} 頁 · ${(book.totalChars/1000).toFixed(1)}k 字`;
  document.getElementById('nowTitle').textContent = book.title;
  document.getElementById('nowSub').textContent   =
    lastPage > 1
      ? `📖 從第 ${currentPage} 頁繼續 · 共 ${totalPages} 頁`
      : `📖 共 ${totalPages} 頁 · 點播放開始朗讀`;
  document.getElementById('pageTotalLabel').textContent  = totalPages;
  document.getElementById('btnPrevPage').disabled        = false;
  document.getElementById('btnNextPage').disabled        = false;
  document.getElementById('btnPlay').disabled            = false;
  document.getElementById('progressBarRow').style.display = 'flex';

  currentBookId = bookId;
  showJsonPage(currentPage);
  updateCacheStatus();
  renderLibrary();

  log(`📖 開啟「${book.title}」，從第 ${currentPage} 頁`, 'ok');
}

// ── 刪除藏書 ────────────────────────────────
function deleteBook(bookId, e) {
  e.stopPropagation();
  const books = getLibrary();
  const book  = books.find(b => b.id === bookId);
  if (!book) return;

  if (!confirm(`「${book.title}」

注意：這只會從本次畫面移除。
若要永久刪除，請同時從 mybooks/ 資料夾刪除對應 .juju.json 並更新 books.json，再 git push。`)) return;

  // 只從記憶體快取移除
  _booksCache = books.filter(b => b.id !== bookId);

  // 清除進度
  const prog = getProgress();
  delete prog[bookId];
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));

  if (currentBookId === bookId) currentBookId = null;
  renderLibrary();
  log(`🗑️ 已從畫面移除「${book.title}」（刷新頁面會重新從 mybooks/ 載入）`, 'warn');
}

// ── Modal 開關 ─────────────────────────────
function openLibraryModal() {
  const modal = document.getElementById('libraryModal');
  if (modal) {
    modal.style.display = 'flex';
    renderLibraryModal();
  }
}

function closeLibraryModal() {
  const modal = document.getElementById('libraryModal');
  if (modal) modal.style.display = 'none';
}

// ── 渲染 Modal 書架 ─────────────────────────
function renderLibraryModal() {
  const books   = getLibrary();
  const query   = (document.getElementById('modalSearch')?.value || '').toLowerCase();
  const prog    = getProgress();
  const grid    = document.getElementById('modalGrid');
  if (!grid) return;

  const filtered = query ? books.filter(b => b.title.toLowerCase().includes(query)) : books;
  grid.innerHTML = '';

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="modal-empty">
      <div style="font-size:3rem;margin-bottom:0.75rem">${books.length === 0 ? '📚' : '🔍'}</div>
      <div>${books.length === 0 ? '還沒有書，辨識 PDF 後會自動加入' : '找不到符合的書'}</div>
    </div>`;
    return;
  }

  filtered.forEach((book, idx) => {
    const bookProg = prog[book.id];
    const lastPage = bookProg?.page || 0;
    const pct      = book.totalPages > 0 ? Math.round((lastPage / book.totalPages) * 100) : 0;
    const color    = getSpineColor(idx);
    const isActive = book.id === currentBookId;

    const card = document.createElement('div');
    card.className = 'modal-book-card' + (isActive ? ' modal-book-active' : '');
    card.onclick = () => openBook(book.id);

    const addedDate = new Date(book.addedAt).toLocaleDateString('zh-TW', { month:'numeric', day:'numeric' });

    card.innerHTML = `
      <div class="modal-book-cover" style="background:linear-gradient(145deg,${color}cc,${color}88)">
        <div class="modal-book-title-cover">${escHtml(book.title)}</div>
        ${pct > 0 ? `<div class="modal-book-pct">${pct}%</div>` : ''}
      </div>
      <div class="modal-book-body">
        <div class="modal-book-name">${escHtml(book.title)}</div>
        <div class="modal-book-info">${book.totalPages} 頁 · ${(book.totalChars/1000).toFixed(1)}k 字</div>
        ${lastPage > 0
          ? `<div class="modal-book-last">📖 讀到第 ${lastPage} 頁</div>`
          : `<div class="modal-book-last" style="color:#bbb">尚未閱讀</div>`}
        <div class="modal-book-progress">
          <div class="modal-book-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>
      <button class="modal-book-del" onclick="deleteBookModal('${book.id}',event)" title="刪除">✕</button>
    `;
    grid.appendChild(card);
  });
}

function deleteBookModal(bookId, e) {
  e.stopPropagation();
  const books = getLibrary();
  const book  = books.find(b => b.id === bookId);
  if (!book || !confirm(`「${book.title}」

注意：這只從畫面移除。永久刪除請從 mybooks/ 刪除檔案並更新 books.json 後 git push。`)) return;

  _booksCache = books.filter(b => b.id !== bookId);
  const prog  = getProgress();
  delete prog[bookId];
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));
  if (currentBookId === bookId) currentBookId = null;
  renderLibraryModal();
  renderLibrary();
}

// ── 渲染藏書列表 ─────────────────────────────
function renderLibrary() {
  const books    = getLibrary();
  const query    = (document.getElementById('librarySearch')?.value || '').toLowerCase();
  const prog     = getProgress();
  const list     = document.getElementById('libraryList');
  const empty    = document.getElementById('libraryEmpty');
  const countEl  = document.getElementById('libraryCount');

  if (!list) return;

  // 更新計數
  if (countEl) countEl.textContent = `${books.length} 本`;

  // 過濾搜尋
  const filtered = query
    ? books.filter(b => b.title.toLowerCase().includes(query))
    : books;

  // 清空（保留 empty 佔位）
  list.innerHTML = '';

  if (filtered.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'library-empty';
    emptyEl.innerHTML = books.length === 0
      ? '<div style="font-size:1.8rem;margin-bottom:0.4rem">📖</div><div>辨識完成後自動加入</div>'
      : '<div style="font-size:1.4rem;margin-bottom:0.3rem">🔍</div><div>找不到符合的書</div>';
    list.appendChild(emptyEl);
    return;
  }

  // 找出目前開啟的書 id
  const activeTitle = document.getElementById('nowTitle')?.textContent;

  filtered.forEach((book, idx) => {
    const bookProg  = prog[book.id];
    const lastPage  = bookProg?.page || 0;
    const pct       = book.totalPages > 0 ? Math.round((lastPage / book.totalPages) * 100) : 0;
    const isActive  = book.title === activeTitle;
    const color     = getSpineColor(idx);

    const card = document.createElement('div');
    card.className = 'book-card' + (isActive ? ' active-book' : '');
    card.onclick   = () => openBook(book.id);

    // 日期格式
    const dateStr = bookProg?.updatedAt
      ? new Date(bookProg.updatedAt).toLocaleDateString('zh-TW', { month:'numeric', day:'numeric' })
      : new Date(book.addedAt).toLocaleDateString('zh-TW', { month:'numeric', day:'numeric' });

    card.innerHTML = `
      <div class="book-spine" style="background:${color}"></div>
      <div class="book-info">
        <div class="book-title">${escHtml(book.title)}</div>
        <div class="book-meta">
          <span>${book.totalPages} 頁</span>
          <span>·</span>
          <span>${(book.totalChars/1000).toFixed(1)}k 字</span>
          ${lastPage > 0
            ? `<span class="book-last-read">讀到第 ${lastPage} 頁</span>`
            : `<span style="color:#ccc">未讀</span>`}
        </div>
        <div class="book-progress-bar">
          <div class="book-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
      <button class="book-delete" onclick="deleteBook('${book.id}', event)"
              title="刪除">✕</button>`;

    list.appendChild(card);
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 儲存閱讀進度（每次翻頁時呼叫）──────────
function saveCurrentProgress() {
  if (!currentBookId) return;
  saveProgress(currentBookId, currentPage);
  renderLibrary();
}


// ── UI 切換 ────────────────────────────────
function showLoading() {
  document.getElementById('emptyState').style.display   = 'none';
  document.getElementById('loadingState').style.display = 'flex';
  document.getElementById('pageView').style.display     = 'none';
  document.getElementById('errorState').style.display   = 'none';
  ['step-read','step-parse','step-text','step-render'].forEach(id => setStep(id, 'pending'));
  setBarProgress(0, '準備中...', '');
}

function showEmpty() {
  document.getElementById('emptyState').style.display   = 'flex';
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageView').style.display     = 'none';
  document.getElementById('errorState').style.display   = 'none';
}

function showPageView() {
  document.getElementById('emptyState').style.display   = 'none';
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('errorState').style.display   = 'none';
  document.getElementById('pageView').style.display     = 'flex';

  // PDF 模式顯示左圖右文，JSON 模式顯示全版閱讀
  const pdfLayout    = document.getElementById('pdfLayout');
  const readerLayout = document.getElementById('readerLayout');
  if (pdfLayout)    pdfLayout.style.display    = pdfDoc ? 'flex' : 'none';
  if (readerLayout) readerLayout.style.display = pdfDoc ? 'none' : 'flex';
}

function showError(message, tips = []) {
  document.getElementById('emptyState').style.display   = 'none';
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageView').style.display     = 'none';
  document.getElementById('errorState').style.display   = 'flex';
  document.getElementById('errorMsg').textContent = message || '發生未知錯誤';
  const tipsEl = document.getElementById('errorTips');
  if (tips.length > 0) {
    tipsEl.innerHTML = '💡 可能原因：<br>' + tips.map(t => `• ${t}`).join('<br>');
    tipsEl.style.display = 'block';
  } else {
    tipsEl.style.display = 'none';
  }
}

function retryUpload() {
  showEmpty();
  const input = document.getElementById('pdfFileInput');
  input.value = '';
  input.click();
}

function setBarProgress(pct, title, sub) {
  const fill = document.getElementById('loadBarFill');
  if (!fill) return;
  fill.classList.remove('indeterminate');
  if (pct !== null) fill.style.width = pct + '%';
  if (title) document.getElementById('loadingText').textContent = title;
  if (sub !== undefined) document.getElementById('loadingSub').textContent = sub;
  if (pct !== null) {
    document.getElementById('loadBarLeft').textContent  = pct + '%';
    document.getElementById('loadBarRight').textContent = sub || '';
  }
}

function setStep(stepId, state) {
  const el = document.getElementById(stepId);
  if (!el) return;
  el.className = 'load-step';
  if (state === 'active') el.classList.add('active');
  if (state === 'done')   el.classList.add('done');
  const icon = el.querySelector('.step-icon');
  if (icon) {
    icon.textContent = state === 'done' ? '✅' : state === 'active' ? '⏺' : '⏳';
  }
}

function showReadingBadge(show) {
  document.getElementById('readingBadge').style.display = show ? 'block' : 'none';
}

function setStatus(state) {
  const pill = document.getElementById('statusPill');
  pill.className = 'status-pill';
  const map = {
    idle:    { cls: 'idle',    text: '就緒'   },
    reading: { cls: 'reading', text: '朗讀中' },
    paused:  { cls: 'paused',  text: '已暫停' },
    done:    { cls: 'done',    text: '完成 ✓' },
  };
  const s = map[state] || map.idle;
  pill.classList.add(s.cls);
  pill.innerHTML = `<span class="status-dot"></span><span>${s.text}</span>`;
}

function updateProgress() {
  if (!totalPages) return;
  const pct = Math.round((currentPage / totalPages) * 100);
  document.getElementById('progFill').style.width  = pct + '%';
  document.getElementById('progLeft').textContent  = `第 ${currentPage} 頁`;
  document.getElementById('progRight').textContent = `${pct}%`;
}


// ═══════════════════════════════════════════
// mybooks/ 資料夾自動載入
// 讀取 mybooks/books.json 索引，逐一載入書籍
// 新增書籍只需：
//   1. 把 .juju.json 放進 mybooks/
//   2. 在 books.json 的 books 陣列新增 { "filename": "書名.juju.json" }
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// 從 mybooks/books.json 讀取書目索引
// 只存書名和檔名，不預載頁面內容
// 點書時才去 fetch 對應的 .juju.json
// ═══════════════════════════════════════════
// ── fetch mybooks/ 檔案（繞過中文編碼問題）──
async function fetchMyBook(filename) {
  // 用 XMLHttpRequest 避免 fetch 自動編碼中文路徑
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', './mybooks/' + filename + '?t=' + Date.now(), true);
    xhr.responseType = 'text';
    xhr.onload = () => {
      // 模擬 fetch Response 介面
      resolve({
        ok:   xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: () => Promise.resolve(JSON.parse(xhr.responseText)),
      });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, json: () => Promise.resolve(null) });
    xhr.send();
  });
}

async function loadMyBooksFolder() {
  _booksCache = [];

  try {
    const res = await fetch('./mybooks/books.json?t=' + Date.now());
    if (!res.ok) {
      log('📁 mybooks/books.json 不存在', 'warn');
      renderLibrary();
      return;
    }

    const index = await res.json();
    const list  = (index.books || []).map(b => b.filename).filter(Boolean);

    if (list.length === 0) {
      log('📁 books.json 是空的');
      renderLibrary();
      return;
    }

    // 只建立輕量 index（不載入 pages 內容）
    _booksCache = list.map(filename => {
      const name = filename.replace(/\.juju\.json$/i, '');
      return {
        id:       'mybooks_' + name,
        title:    name,
        filename,
        // pages 先不載入，點書時才 fetch
        totalPages: null,
        totalChars: null,
        addedAt:    null,
        loaded:     false,
      };
    });

    renderLibrary();
    log(`✅ 書目載入完成，共 ${_booksCache.length} 本`, 'ok');

    // 背景非同步補全每本書的 metadata（頁數、字數）
    loadBooksMetadata();

  } catch (err) {
    log(`⚠️ books.json 載入失敗: ${err.message}`, 'warn');
    renderLibrary();
  }
}

// 背景載入每本書的 metadata（不含 pages 內容）
async function loadBooksMetadata() {
  for (const book of _booksCache) {
    if (book.loaded) continue;
    try {
      const r    = await fetchMyBook(book.filename);
      if (!r.ok) continue;
      const data = await r.json();
      book.title      = data.title || book.title;
      book.totalPages = data.totalPages || (data.pages || []).length;
      book.totalChars = (data.pages || []).reduce((s, p) => s + (p.text || '').length, 0);
      book.addedAt    = data.savedAt || new Date().toISOString();
      book.loaded     = true;
      renderLibrary();  // 逐本更新 UI
    } catch {}
  }
}

// ── 初始化 ─────────────────────────────────
log('🚀 app.js 載入完成 (按需 OCR 版)');
renderLibrary();  // 啟動時渲染藏書
loadMyBooksFolder();  // 從 mybooks/ 資料夾載入

// ESC 關閉 Modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLibraryModal();
});
log(`📦 PDF.js ${pdfjsLib.version}`);

if ('speechSynthesis' in window) {
  const loadVoices = () => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      populateVoiceSelect();
    }
  };
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
} else {
  document.getElementById('voiceStatus').textContent = '❌ 不支援語音';
}