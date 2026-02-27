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
  if (file) { log(`📄 選擇: ${file.name}`); loadPDF(file); }
});

uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadPDF(file);
});


// ── 讀取 PDF（只解析結構，不 OCR）─────────
async function loadPDF(file) {
  if (file.type !== 'application/pdf') {
    showError(`不支援的格式：${file.type || '未知'}`, [
      '請上傳 <strong>.pdf</strong> 檔案',
    ]);
    return;
  }

  stopReading();
  showLoading();
  setStep('step-read', 'active');
  setBarProgress(5, '讀取檔案...', `${Math.round(file.size/1024)} KB`);

  try {
    // Step 1: ArrayBuffer
    const buf = await file.arrayBuffer();
    setStep('step-read', 'done');
    setBarProgress(20, '檔案讀取完成', `${Math.round(buf.byteLength/1024)} KB`);

    // Step 2: PDF.js 解析
    setStep('step-parse', 'active');
    setBarProgress(30, '解析 PDF 結構...', '');
    pdfDoc     = await pdfjsLib.getDocument({ data: buf }).promise;
    totalPages = pdfDoc.numPages;
    log(`✅ PDF 解析完成，共 ${totalPages} 頁`, 'ok');
    setStep('step-parse', 'done');
    setBarProgress(50, `PDF 解析完成`, `共 ${totalPages} 頁`);

    // Step 3: 偵測是否有內嵌文字
    setStep('step-text', 'active');
    setBarProgress(55, '偵測 PDF 類型...', '');
    const trialPage    = await pdfDoc.getPage(1);
    const trialContent = await trialPage.getTextContent();
    hasEmbedded = trialContent.items.filter(i => i.str.trim()).length > 10;
    log(`  PDF 類型: ${hasEmbedded ? '✅ 內嵌文字' : '📷 掃描圖片，將使用 OCR'}`, hasEmbedded ? 'ok' : 'warn');

    // 初始化快取（全部設為 null = 未處理）
    pageTexts    = new Array(totalPages).fill(null);
    ocrInProgress = {};
    setStep('step-text', 'done');
    setBarProgress(70, hasEmbedded ? '內嵌文字，無需 OCR' : '掃描 PDF，將按需 OCR', '');

    // Step 4: 渲染並 OCR 第一頁
    setStep('step-render', 'active');
    setBarProgress(80, '載入第一頁...', '');
    currentPage = 1;
    await renderPage(currentPage);    // 會觸發 OCR
    setStep('step-render', 'done');
    setBarProgress(100, '完成！可以開始閱讀', '🎉');

    // 更新 UI
    document.getElementById('fileInfo').style.display      = 'flex';
    document.getElementById('fileNameLabel').textContent   = file.name;
    document.getElementById('fileDetailLabel').textContent = `${totalPages} 頁 · ${Math.round(file.size/1024)} KB`;
    document.getElementById('nowTitle').textContent        = file.name.replace('.pdf','');
    document.getElementById('nowSub').textContent          = hasEmbedded
      ? `共 ${totalPages} 頁 · 內嵌文字 · 直接朗讀`
      : `共 ${totalPages} 頁 · 掃描 PDF · 按需 OCR（邊讀邊辨識）`;
    document.getElementById('pageTotalLabel').textContent  = totalPages;
    document.getElementById('btnPrevPage').disabled        = false;
    document.getElementById('btnNextPage').disabled        = false;
    document.getElementById('btnPlay').disabled            = false;
    document.getElementById('progressBarRow').style.display = 'flex';

    await new Promise(r => setTimeout(r, 500));
    showPageView();
    log('✅ 載入完成，進入按需 OCR 模式', 'ok');

  } catch (err) {
    log(`❌ ${err.message}`, 'error');
    showError(err.message, [
      '確認是標準 PDF 格式（非加密）',
      `錯誤：${err.message}`,
    ]);
  }
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
    setStatus('reading'); showReadingBadge(true);
    // 開始朗讀時也觸發預載
    prefetchPages(currentPage);
  };

  utterance.onend = () => {
    isPlaying = false; isPaused = false;
    document.getElementById('btnPlay').textContent = '▶';
    showReadingBadge(false);
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

  // 全部辨識完畢 → 顯示存檔按鈕
  if (done === totalPages && totalPages > 0) {
    const btn = document.getElementById('btnSaveJson');
    if (btn) {
      btn.style.display = 'flex';
      btn.classList.add('pulse-once');
    }
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
    <div class="mybooks-hint-title">📁 兩個檔案放進 mybooks/</div>
    <div class="mybooks-hint-step">① <code>${newFilename}</code> ← 剛才下載的書</div>
    <div class="mybooks-hint-step">② <code>books.json</code> ← 剛才自動下載的更新版</div>
    <div class="mybooks-hint-step" style="margin-top:0.4rem">覆蓋舊的 books.json → git push → 完成 ✅</div>
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

  const text       = pageTexts[pageNum - 1] || '';
  const textScroll = document.getElementById('textScroll');
  const charBadge  = document.getElementById('charBadge');

  textScroll.textContent    = text;
  charBadge.textContent     = `✅ ${text.length} 字`;
  charBadge.style.cssText   = 'background:rgba(46,158,110,0.15);color:#2e9e6e;border:1px solid rgba(46,158,110,0.3)';

  document.getElementById('pageCurrentLabel').textContent = pageNum;
  document.getElementById('btnPrevPage').disabled = pageNum <= 1;
  document.getElementById('btnNextPage').disabled = pageNum >= totalPages;
  updateProgress();

  // canvas 顯示佔位
  const canvas = document.getElementById('pdfCanvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = 400;
  canvas.height = 300;
  ctx.fillStyle = '#f5ede2';
  ctx.fillRect(0, 0, 400, 300);
  ctx.fillStyle = '#c8a882';
  ctx.font      = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('📄 從 JSON 快取載入', 200, 140);
  ctx.font      = '12px sans-serif';
  ctx.fillStyle = '#9c7a5a';
  ctx.fillText('無需原始 PDF，直接朗讀', 200, 165);

  showPageView();
}


// ═══════════════════════════════════════════
// 我的藏書（localStorage 持久化）
// ═══════════════════════════════════════════

const LIBRARY_KEY = 'juju_library';      // 書目清單
const PROGRESS_KEY = 'juju_progress';    // 每本書的閱讀進度

// 書本 spine 顏色循環
const SPINE_COLORS = [
  '#ff6b2b','#e8854a','#d4a852','#5ba85a',
  '#4a8fc0','#7b68cc','#c06080','#3bbd85',
];

function getSpineColor(idx) {
  return SPINE_COLORS[idx % SPINE_COLORS.length];
}

// ── 讀取 / 寫入 Library ─────────────────────
function getLibrary() {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]'); }
  catch { return []; }
}

function saveLibrary(books) {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(books));
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
    pages:      jsonData.pages,   // 儲存完整頁面資料
  };

  if (existing >= 0) books[existing] = entry;
  else books.unshift(entry);  // 最新的排最前面

  saveLibrary(books);
  renderLibrary();
  currentBookId = entry.id;   // 設定目前書 id
  log(`📚 「${entry.title}」已加入藏書`, 'ok');
}

// ── 從藏書開啟書本 ───────────────────────────
function openBook(bookId) {
  const books = getLibrary();
  const book  = books.find(b => b.id === bookId);
  if (!book) return;

  stopReading();

  // 載入狀態（類似 loadJson）
  pdfDoc        = null;
  totalPages    = book.totalPages;
  hasEmbedded   = true;
  pageTexts     = book.pages.map(p => p.text || '');
  ocrInProgress = {};

  // 恢復上次閱讀進度
  const prog = getProgress();
  const lastPage = prog[bookId]?.page || 1;
  currentPage = Math.min(lastPage, totalPages);

  // 更新 UI
  document.getElementById('fileInfo').style.display      = 'flex';
  document.getElementById('fileNameLabel').textContent   = book.title;
  document.getElementById('fileDetailLabel').textContent =
    `${totalPages} 頁 · ${(book.totalChars/1000).toFixed(1)}k 字`;
  document.getElementById('nowTitle').textContent        = book.title;
  document.getElementById('nowSub').textContent          =
    lastPage > 1
      ? `📖 從第 ${currentPage} 頁繼續 · 共 ${totalPages} 頁`
      : `📖 共 ${totalPages} 頁 · 點播放開始朗讀`;
  document.getElementById('pageTotalLabel').textContent  = totalPages;
  document.getElementById('btnPrevPage').disabled        = false;
  document.getElementById('btnNextPage').disabled        = false;
  document.getElementById('btnPlay').disabled            = false;
  document.getElementById('progressBarRow').style.display = 'flex';

  currentBookId = bookId;   // 記住目前書 id
  showJsonPage(currentPage);
  updateCacheStatus();
  closeLibraryModal();
  renderLibrary();  // 更新藏書高亮

  log(`📖 開啟「${book.title}」，從第 ${currentPage} 頁`, 'ok');
}

// ── 刪除藏書 ────────────────────────────────
function deleteBook(bookId, e) {
  e.stopPropagation();  // 不觸發 openBook
  const books   = getLibrary();
  const book    = books.find(b => b.id === bookId);
  if (!book) return;
  if (!confirm(`確定刪除「${book.title}」？`)) return;

  saveLibrary(books.filter(b => b.id !== bookId));

  // 清除進度
  const prog = getProgress();
  delete prog[bookId];
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));

  renderLibrary();
  log(`🗑️ 已刪除「${book.title}」`, 'warn');
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
  if (!book || !confirm(`確定刪除「${book.title}」？`)) return;
  saveLibrary(books.filter(b => b.id !== bookId));
  const prog = getProgress();
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
  document.getElementById('pageView').style.display     = 'grid';
  document.getElementById('errorState').style.display   = 'none';
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

async function loadMyBooksFolder() {
  try {
    // ── 策略：直接嘗試載入 books.json 索引
    // 若不存在，改用 GitHub Pages 目錄掃描備用方案
    const filenames = await getMyBooksFilenames();

    if (filenames.length === 0) {
      log('📁 mybooks/ 無新書籍', 'info');
      return;
    }

    log(`📁 mybooks/ 找到 ${filenames.length} 個檔案，載入中...`);
    let added = 0;

    for (const filename of filenames) {
      try {
        const res = await fetch(`./mybooks/${encodeURIComponent(filename)}?t=` + Date.now());
        if (!res.ok) { log(`  ⚠️ 無法讀取: ${filename}`, 'warn'); continue; }

        const data = await res.json();
        if (!data.pages || !Array.isArray(data.pages)) {
          log(`  ⚠️ ${filename} 格式不正確`, 'warn');
          continue;
        }

        // 用檔名當唯一 id，避免重複加入
        const bookId = 'mybooks_' + filename.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
        if (getLibrary().find(b => b.id === bookId)) {
          log(`  ○ 已存在: ${data.title || filename}`);
          continue;
        }

        const entry = {
          id:         bookId,
          title:      data.title || filename.replace(/\.juju\.json$/i, ''),
          totalPages: data.totalPages || data.pages.length,
          totalChars: data.pages.reduce((s, p) => s + (p.text || '').length, 0),
          addedAt:    new Date().toISOString(),
          pages:      data.pages,
          source:     'mybooks',
        };

        const books = getLibrary();
        books.push(entry);
        saveLibrary(books);
        added++;
        log(`  📚 加入: ${entry.title}（${entry.totalPages} 頁）`, 'ok');

      } catch (e) {
        log(`  ❌ ${filename}: ${e.message}`, 'error');
      }
    }

    if (added > 0) {
      renderLibrary();
      log(`✅ mybooks/ 共載入 ${added} 本新書`, 'ok');
    }

  } catch (err) {
    log(`⚠️ mybooks/ 載入錯誤: ${err.message}`, 'warn');
  }
}

/**
 * 取得 mybooks/ 內所有 .juju.json 檔名
 * 三種方式依序嘗試：
 * 1. books.json 索引（最穩定，GitHub Pages 推薦）
 * 2. 目錄 HTML 解析（本機 Live Server 有效）
 * 3. 兩者都失敗 → 回傳空陣列
 */
async function getMyBooksFilenames() {
  // ── 方式 1：嘗試 books.json ──
  try {
    const res = await fetch('./mybooks/books.json?t=' + Date.now());
    if (res.ok) {
      const data = await res.json();
      const list = (data.books || []).map(b => b.filename).filter(Boolean);
      if (list.length > 0) {
        log(`📋 books.json 索引：${list.length} 本`);
        return list;
      }
    }
  } catch {}

  // ── 方式 2：嘗試解析目錄 HTML（Live Server / Apache 等有目錄列表時有效）──
  try {
    const res = await fetch('./mybooks/?t=' + Date.now());
    if (res.ok) {
      const html = await res.text();
      // 從 <a href="..."> 抓出 .juju.json 檔名
      const matches = [...html.matchAll(/href="([^"]*\.juju\.json)"/gi)];
      const list = matches
        .map(m => decodeURIComponent(m[1].split('/').pop()))
        .filter(f => f && !f.startsWith('.'));
      if (list.length > 0) {
        log(`📂 目錄掃描：${list.length} 本`);
        return list;
      }
    }
  } catch {}

  log('⚠️ 無法自動掃描 mybooks/，請確認 books.json 索引存在', 'warn');
  return [];
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