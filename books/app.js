/* ============================================================
   shelf — terminal ebook reader
   ============================================================ */

/* ---------- IndexedDB wrapper ---------- */
const DB_NAME = 'shelf-db';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('books')) {
        _db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('files')) {
        _db.createObjectStore('files', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('bookmarks')) {
        const bm = _db.createObjectStore('bookmarks', { keyPath: 'id' });
        bm.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!_db.objectStoreNames.contains('highlights')) {
        const hl = _db.createObjectStore('highlights', { keyPath: 'id' });
        hl.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

function idbGetByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const idx = tx.objectStore(storeName).index(indexName);
    const req = idx.getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

/* ---------- App state ---------- */
const state = {
  books: [],          // metadata list
  sortMode: 'recent',
  currentBook: null,  // { id, ...meta }
  rendition: null,
  book: null,          // epub.js Book instance
  currentBookmarks: [],
  currentHighlights: [],
  settings: {
    fontSize: 18,
    lineHeight: 1.6,
    margin: 24,
    fontFamily: 'serif',
    flow: 'paginated',
    theme: 'paper',
    highlightingEnabled: false
  },
  chromeVisible: true,
  currentSelection: null,
};

const THEMES = {
  paper:  { bg: '#f4f1ea', text: '#1c1c1a' },
  sepia:  { bg: '#ecdfc4', text: '#3b2f1e' },
  dusk:   { bg: '#2a2b2e', text: '#d8d8dc' },
  black:  { bg: '#000000', text: '#c9c9c9' },
};

const FONT_STACKS = {
  serif: "'Source Serif 4', Georgia, 'Times New Roman', serif",
  sans: "'Literata', -apple-system, 'Segoe UI', sans-serif"
};

// Page-turn animation timing. `scroll-behavior: smooth` (set in CSS on
// epub.js's internal .epub-container) doesn't expose its animation duration
// to JS — it's browser-controlled, typically 250-450ms — so this constant is
// a conservative upper bound used to (a) gate rapid repeat taps to roughly
// one turn per animation cycle, and (b) debounce location/progress reporting
// until just after the animation visually settles.
const PAGE_TURN_ANIM_MS = 400;

/* ---------- Utility ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (id) => document.getElementById(id);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function showToast(msg, variant) {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast' + (variant ? ` toast-${variant}` : '');
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, 2400);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('shelf-settings');
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (e) {}
}
function saveSettings() {
  localStorage.setItem('shelf-settings', JSON.stringify(state.settings));
}

/* ============================================================
   LIBRARY
   ============================================================ */
async function loadLibrary() {
  state.books = await idbGetAll('books');
  renderLibrary();
}

function sortBooks(books) {
  const arr = [...books];
  switch (state.sortMode) {
    case 'title':
      arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    case 'progress':
      arr.sort((a, b) => (b.progress || 0) - (a.progress || 0));
      break;
    case 'added':
      arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      break;
    case 'recent':
    default:
      arr.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0));
  }
  return arr;
}

function renderLibrary() {
  const grid = el('libraryGrid');
  const empty = el('emptyState');
  const continueSection = el('continueSection');

  if (state.books.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    continueSection.hidden = true;
    return;
  }
  empty.hidden = true;

  // Continue reading card: most recently opened, unfinished
  const inProgress = state.books
    .filter(b => b.progress > 0 && b.progress < 0.995 && !b.finished)
    .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0];

  if (inProgress) {
    continueSection.hidden = false;
    renderContinueCard(inProgress);
  } else {
    continueSection.hidden = true;
  }

  const sorted = sortBooks(state.books);
  grid.innerHTML = sorted.map(bookCardHTML).join('');

  grid.querySelectorAll('.book-card').forEach(card => {
    const id = card.dataset.id;
    card.addEventListener('click', () => openBook(id));
    const menuBtn = card.querySelector('.book-card-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBookOptions(id);
      });
    }
  });
}

function renderContinueCard(b) {
  const pct = Math.round((b.progress || 0) * 100);
  el('continueCard').innerHTML = `
    <div class="continue-cover">${b.cover ? `<img src="${b.cover}" alt="">` : coverFallback(b.title)}</div>
    <div class="continue-info">
      <div class="continue-title">${escapeHtml(b.title || 'Untitled')}</div>
      <div class="continue-author">${escapeHtml(b.author || 'Unknown author')}</div>
      <div class="continue-progress-row">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-pct tnum">${pct}%</div>
      </div>
    </div>
  `;
  el('continueCard').onclick = () => openBook(b.id);
}

function coverFallback(title) {
  return `<div class="book-cover-fallback">${escapeHtml((title || 'Untitled').slice(0, 60))}</div>`;
}

function bookCardHTML(b) {
  const pct = Math.round((b.progress || 0) * 100);
  return `
    <div class="book-card" data-id="${b.id}">
      <div class="book-cover-wrap">
        ${b.cover ? `<img src="${b.cover}" alt="">` : coverFallback(b.title)}
        ${b.finished ? '<div class="book-finished-badge">DONE</div>' : ''}
        <button class="book-card-menu-btn" aria-label="Options">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </div>
      <div class="book-card-title">${escapeHtml(b.title || 'Untitled')}</div>
      <div class="book-card-meta">
        <span>${escapeHtml((b.author || '—').split(',')[0])}</span>
        ${b.progress > 0 ? `<span class="book-card-pct tnum">${pct}%</span>` : ''}
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

/* ---------- Book options sheet ---------- */
let optionsTargetId = null;
function openBookOptions(id) {
  optionsTargetId = id;
  const book = state.books.find(b => b.id === id);
  if (!book) return;
  el('optMarkFinishedBtn').textContent = book.finished ? 'MARK AS UNFINISHED' : 'MARK AS FINISHED';
  openSheet('bookOptionsOverlay');
}

el('optOpenBtn').addEventListener('click', () => {
  closeSheet('bookOptionsOverlay');
  if (optionsTargetId) openBook(optionsTargetId);
});

el('optMarkFinishedBtn').addEventListener('click', async () => {
  const book = state.books.find(b => b.id === optionsTargetId);
  if (!book) return;
  book.finished = !book.finished;
  if (book.finished) book.progress = 1;
  await idbPut('books', book);
  closeSheet('bookOptionsOverlay');
  await loadLibrary();
  showToast(book.finished ? 'Marked as finished' : 'Marked as unfinished', 'accent');
});

el('optDeleteBtn').addEventListener('click', async () => {
  if (!optionsTargetId) return;
  const book = state.books.find(b => b.id === optionsTargetId);
  await idbDelete('books', optionsTargetId);
  await idbDelete('files', optionsTargetId);
  const bms = await idbGetByIndex('bookmarks', 'bookId', optionsTargetId);
  for (const bm of bms) await idbDelete('bookmarks', bm.id);
  const hls = await idbGetByIndex('highlights', 'bookId', optionsTargetId);
  for (const hl of hls) await idbDelete('highlights', hl.id);
  closeSheet('bookOptionsOverlay');
  await loadLibrary();
  showToast(`Removed "${book ? book.title : 'book'}"`, 'danger');
});

/* ============================================================
   IMPORT
   ============================================================ */
el('importBtn').addEventListener('click', () => el('fileInput').click());
el('emptyImportBtn').addEventListener('click', () => el('fileInput').click());

el('fileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of files) {
    await importEpub(f);
  }
});

async function importEpub(file) {
  showLoading('PARSING EPUB…');
  try {
    if (typeof ePub === 'undefined') {
      throw new Error('EPUB_LIB_MISSING');
    }

    const arrayBuffer = await file.arrayBuffer();
    const id = uid();

    // Parse with epub.js to extract metadata + cover
    const tempBook = ePub(arrayBuffer.slice(0));
    await withTimeout(tempBook.opened, 15000, 'TIMEOUT_OPENING');
    await withTimeout(tempBook.ready, 15000, 'TIMEOUT_READY');
    let metadata = {};
    try {
      metadata = await tempBook.loaded.metadata;
    } catch (err) { /* malformed metadata block, fall back to filename below */ }
    let coverUrl = null;
    try {
      const coverPath = await tempBook.loaded.cover;
      if (coverPath) {
        const coverBlobUrl = await tempBook.archive.createUrl(coverPath, { base64: true });
        coverUrl = coverBlobUrl;
      }
    } catch (err) { /* no cover, non-fatal */ }

    let navigation = null;
    try {
      navigation = await tempBook.loaded.navigation;
    } catch (err) { /* missing/broken TOC, non-fatal — book can still open */ }

    const meta = {
      id,
      title: metadata.title || file.name.replace(/\.epub$/i, ''),
      author: metadata.creator || 'Unknown author',
      cover: coverUrl,
      addedAt: Date.now(),
      lastOpenedAt: null,
      progress: 0,
      cfi: null,
      finished: false,
      fileName: file.name,
      fileSize: file.size,
    };

    await idbPut('files', { id, data: arrayBuffer });
    await idbPut('books', meta);

    tempBook.destroy();

    state.books.push(meta);
    hideLoading();
    await loadLibrary();
    showToast(`Imported "${meta.title}"`, 'accent');
  } catch (err) {
    console.error('EPUB import failed:', err);
    hideLoading();
    showToast(describeImportError(err, file), 'danger');
  }
}

function withTimeout(promise, ms, reason) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms)),
  ]);
}

function describeImportError(err, file) {
  const msg = (err && (err.message || String(err))) || '';
  if (msg === 'EPUB_LIB_MISSING') {
    return 'Reader library failed to load — check your connection and reload';
  }
  if (msg === 'TIMEOUT_OPENING' || msg === 'TIMEOUT_READY') {
    return 'That EPUB took too long to parse — it may be malformed';
  }
  if (file && !/\.epub$/i.test(file.name)) {
    return `"${file.name}" isn't an .epub file`;
  }
  if (/central directory|end of central directory|not a valid zip|corrupt/i.test(msg)) {
    return 'That file isn\'t a valid EPUB (bad or corrupted zip)';
  }
  if (/container\.xml|mimetype|rootfile|opf/i.test(msg)) {
    return 'EPUB is missing required internal files (container.xml/OPF)';
  }
  return `Could not parse that EPUB file${msg ? ` (${msg.slice(0, 80)})` : ''}`;
}

function showLoading(text) {
  el('loadingText').textContent = text;
  el('loadingOverlay').hidden = false;
}
function hideLoading() { el('loadingOverlay').hidden = true; }

/* ============================================================
   READER
   ============================================================ */
async function openBook(id) {
  const meta = state.books.find(b => b.id === id);
  if (!meta) return;
  showLoading('OPENING BOOK…');

  try {
    const fileRec = await idbGet('files', id);
    if (!fileRec) throw new Error('File data missing');

    state.currentBook = meta;
    el('readerBookTitle').textContent = meta.title;
    el('readerView').hidden = false;
    el('bottomNav').style.display = 'none';
    document.body.style.overflow = 'hidden';

    // epub.js reads #epubViewer's on-screen size once, synchronously, at
    // renderTo() time and locks in that width for all its pagination math
    // (page width, column count, tap-zone math downstream). readerView was
    // just unhidden above; if the browser hasn't finished laying it out yet
    // (e.g. mid-transition, or this is the very first paint), epub.js can
    // compute against a stale/zero size and pagination stays broken until
    // something else forces a real resize — which is why rotating the device
    // "fixes" it: that's the first legitimate resize event epub.js sees.
    // Forcing a synchronous layout flush here (reading offsetHeight) and
    // waiting one animation frame guarantees #epubViewer has its final,
    // correct dimensions before epub.js ever measures it.
    void el('readerView').offsetHeight;
    await new Promise(requestAnimationFrame);

    const book = ePub(fileRec.data.slice(0));
    state.book = book;

    const viewerEl = el('epubViewer');
    viewerEl.innerHTML = '';

    const theme = THEMES[state.settings.theme];
    document.documentElement.style.setProperty('--rs-bg', theme.bg);

    const rendition = book.renderTo(viewerEl, {
      // Deliberately omitting width/height: epub.js's own isNumber() check
      // treats '100%' as numeric (parseFloat('100%') === 100) and appends
      // 'px' to it, producing the invalid CSS value '100%px' on its internal
      // container. That silently fails to size the container at all, so
      // epub.js falls back to an unreliable measurement. Passing nothing
      // here makes epub.js measure #epubViewer's actual pixel size via
      // getBoundingClientRect() instead, which is the robust path.
      flow: state.settings.flow === 'scrolled' ? 'scrolled-doc' : 'paginated',
      spread: 'none',
    });
    state.rendition = rendition;

    applyRenditionTheme();

    // IMPORTANT: all rendition.on()/hooks.*.register() calls must happen
    // BEFORE the first rendition.display() below, not after. hooks.content
    // fires once per section as it's rendered, and awaiting display()
    // doesn't resolve until that render (and its hook triggers) has already
    // completed. Registering attachSurfaceTapHandler after display() meant
    // it silently missed the very first page's content event — the tap
    // listener was never attached to the page the reader actually lands on,
    // only to whatever section got rendered *after* it. That's why nothing
    // was tappable until something else (like rotating the device) forced
    // epub.js to internally re-render the current section and fire the
    // hook again, for the first time, on that already-open page.
    rendition.on('relocated', (location) => {
      onRelocated(location);
    });

    rendition.on('selected', (cfiRange, contents) => {
      handleTextSelection(cfiRange, contents);
    });

    rendition.hooks.content.register((contents) => {
      attachSurfaceTapHandler(contents);
    });

    const startCfi = meta.cfi || undefined;
    await rendition.display(startCfi);

    book.ready.then(() => {
      book.locations.generate(1200).then(() => {
        updateProgressUI();
      });
    });

    // load nav
    const navigation = await book.loaded.navigation;
    renderChapters(navigation.toc);

    await loadBookmarksAndHighlights(id);
    renderBookmarks();
    renderHighlights();
    applyHighlightsToRendition();

    meta.lastOpenedAt = Date.now();
    await idbPut('books', meta);

    hideLoading();
    showReaderChrome(true);
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast('Could not open this book', 'danger');
    closeReader();
  }
}

// `relocated` can fire while the CSS smooth-scroll page-turn animation is
// still visually in flight (epub.js reports location right after issuing the
// scroll, not after it visually settles), so the reported CFI/percentage can
// momentarily reflect a mid-transition position. Debouncing to just past the
// animation window ensures we save and display the page the user actually
// lands on rather than a transient one.
let relocateDebounce = null;
function onRelocated(location) {
  clearTimeout(relocateDebounce);
  relocateDebounce = setTimeout(() => applyRelocated(location), PAGE_TURN_ANIM_MS + 40);
}

function applyRelocated(location) {
  if (!state.currentBook || !state.book) return;
  const cfi = location.start.cfi;
  state.currentBook.cfi = cfi;

  let pct = 0;
  if (state.book.locations && state.book.locations.length()) {
    pct = state.book.locations.percentageFromCfi(cfi);
  } else if (location.start.percentage != null) {
    pct = location.start.percentage;
  }
  state.currentBook.progress = pct;
  if (pct >= 0.995) state.currentBook.finished = true;

  idbPut('books', state.currentBook);
  updateProgressUI();
  updateChapterLabel(cfi);
}

function updateProgressUI() {
  if (!state.currentBook) return;
  const pct = Math.round((state.currentBook.progress || 0) * 100);
  el('readerProgressFill').style.width = pct + '%';
  el('readerPercentLabel').textContent = pct + '%';

  let locLabel = '—';
  if (state.book && state.book.locations && state.book.locations.length()) {
    const total = state.book.locations.length();
    const current = state.book.locations.locationFromCfi(state.currentBook.cfi);
    locLabel = `LOC ${current}/${total}`;
  }
  el('readerLocLabel').textContent = locLabel;
}

function updateChapterLabel(cfi) {
  if (!state.book) return;
  try {
    const spineItem = state.book.spine.get(cfi);
    if (!spineItem) return;
    const navItem = findNavItemByHref(spineItem.href);
    el('readerChapterTitle').textContent = navItem ? navItem.label.trim() : '';
    highlightCurrentTocItem(navItem ? navItem.href : null);
  } catch (e) {}
}

let flatToc = [];
function findNavItemByHref(href) {
  const clean = href.split('#')[0];
  return flatToc.find(t => t.href.split('#')[0] === clean);
}

function renderChapters(toc) {
  flatToc = [];
  const flatten = (items, depth) => {
    items.forEach(item => {
      flatToc.push({ ...item, depth });
      if (item.subitems && item.subitems.length) flatten(item.subitems, depth + 1);
    });
  };
  flatten(toc, 0);

  const panel = el('chaptersPanel');
  if (!flatToc.length) {
    panel.innerHTML = '<div class="toc-empty">NO TABLE OF CONTENTS FOUND</div>';
    return;
  }
  panel.innerHTML = flatToc.map(item => `
    <div class="toc-item ${item.depth ? 'toc-item-sub' : ''}" data-href="${escapeHtml(item.href)}">
      <span class="toc-item-dot"></span>
      <span class="toc-item-label">${escapeHtml(item.label.trim())}</span>
    </div>
  `).join('');

  panel.querySelectorAll('.toc-item').forEach(row => {
    row.addEventListener('click', () => {
      const href = row.dataset.href;
      state.rendition.display(href);
      closeSheet('tocOverlay');
    });
  });
}

function highlightCurrentTocItem(href) {
  const panel = el('chaptersPanel');
  panel.querySelectorAll('.toc-item').forEach(row => {
    row.classList.toggle('current', href && row.dataset.href.split('#')[0] === href.split('#')[0]);
  });
}

/* ---------- Reader chrome / theme / settings ---------- */
function applyRenditionTheme() {
  if (!state.rendition) return;
  const theme = THEMES[state.settings.theme];
  const fontStack = FONT_STACKS[state.settings.fontFamily];
  document.documentElement.style.setProperty('--rs-bg', theme.bg);

  state.rendition.themes.default({
    'html, body': {
      background: `${theme.bg} !important`,
      color: `${theme.text} !important`,
    },
    'body': {
      'font-family': `${fontStack} !important`,
      'font-size': `${state.settings.fontSize}px !important`,
      'line-height': `${state.settings.lineHeight} !important`,
      'padding': `0 ${state.settings.margin}px !important`,
    },
    'p, div, span, li': {
      'font-family': `${fontStack} !important`,
    },
    '::selection': {
      background: '#39ff9a55',
    },
    'a': { color: `${theme.text} !important`, 'text-decoration': 'underline' },
  });
  state.rendition.themes.fontSize(`${state.settings.fontSize}px`);
}

function closeReader() {
  if (state.rendition) {
    try { state.rendition.destroy(); } catch (e) {}
  }
  state.rendition = null;
  if (state.book) {
    try { state.book.destroy(); } catch (e) {}
  }
  state.book = null;
  state.currentBook = null;
  el('readerView').hidden = true;
  el('bottomNav').style.display = '';
  document.body.style.overflow = '';
  loadLibrary();
}

el('closeReaderBtn').addEventListener('click', closeReader);

/* tap zones for page turn + center tap toggles chrome.
   Guard against swallowing a text-selection drag that starts near the edge:
   only treat as a page-turn if there's no active selection in the iframe. */
function hasActiveIframeSelection() {
  try {
    const contents = state.rendition && state.rendition.getContents();
    if (!contents) return false;
    return contents.some(c => {
      const sel = c.window.getSelection();
      return sel && sel.toString().trim().length > 0;
    });
  } catch (e) { return false; }
}

// Turning pages while the previous smooth-scroll animation is still running
// would queue a second scrollLeft change mid-transition, producing a jarring
// stutter instead of a clean slide. This gates rapid repeat taps to roughly
// one turn per animation cycle (see PAGE_TURN_ANIM_MS above).
let pageTurnLocked = false;
function turnPage(direction) {
  if (!state.rendition || pageTurnLocked) return;
  pageTurnLocked = true;
  const result = direction === 'next' ? state.rendition.next() : state.rendition.prev();
  Promise.resolve(result).finally(() => {
    setTimeout(() => { pageTurnLocked = false; }, PAGE_TURN_ANIM_MS);
  });
}

el('readerSurface').addEventListener('click', (e) => {
  if (hasActiveIframeSelection()) return;
  const rect = el('readerSurface').getBoundingClientRect();
  const x = e.clientX - rect.left;
  const edgeStart = rect.width * 0.22;
  const edgeEnd = rect.width * 0.78;
  if (x <= edgeStart) {
    turnPage('prev');
  } else if (x >= edgeEnd) {
    turnPage('next');
  } else {
    showReaderChrome(!state.chromeVisible);
  }
});

// epub.js renders content in a same-origin iframe; clicks inside it don't
// bubble to the outer document, so listen for its own click/tap too.
//
// IMPORTANT (paginated flow): epub.js lays the chapter out as CSS columns and
// sizes the iframe/section to the FULL scrollable width of all columns
// combined — only one "page" worth is visible at a time, revealed by
// scrolling an ancestor container horizontally. That means e.clientX inside
// the iframe is relative to the iframe's full (multi-page) width, not the
// single visible page, so naively comparing it against the iframe or document
// width breaks down as soon as a chapter spans more than one page.
//
// Fix: subtract the ancestor scroll container's current scrollLeft from
// clientX to get the click's position within the *currently visible* page,
// then compare that against the visible page width (readerSurface's width).
function attachSurfaceTapHandler(contents) {
  try {
    const doc = contents.document;
    doc.addEventListener('click', (e) => {
      if (hasActiveIframeSelection()) return;

      const width = el('readerSurface').clientWidth;
      const scrollLeft = getEpubScrollLeft();
      const x = e.clientX - scrollLeft;

      const edgeStart = width * 0.22;
      const edgeEnd = width * 0.78;
      if (x <= edgeStart) {
        turnPage('prev');
      } else if (x >= edgeEnd) {
        turnPage('next');
      } else {
        showReaderChrome(!state.chromeVisible);
      }
    });
  } catch (e) {}
}

// epub.js's internal scrolling container tracks how far the current page has
// scrolled horizontally within the full multi-column chapter. This offset is
// what needs to be subtracted from an in-iframe click's clientX to land back
// in the visible page's own coordinate space.
function getEpubScrollLeft() {
  try {
    const manager = state.rendition && state.rendition.manager;
    if (!manager) return 0;
    if (manager.settings && manager.settings.fullsize) {
      return window.scrollX || 0;
    }
    if (manager.container && typeof manager.container.scrollLeft === 'number') {
      return manager.container.scrollLeft;
    }
  } catch (e) {}
  return 0;
}

// keyboard nav
document.addEventListener('keydown', (e) => {
  if (el('readerView').hidden) return;
  if (e.key === 'ArrowRight') turnPage('next');
  if (e.key === 'ArrowLeft') turnPage('prev');
  if (e.key === 'Escape') closeReader();
});

function showReaderChrome(visible) {
  state.chromeVisible = visible;
  el('readerHeader').classList.toggle('hidden-chrome', !visible);
  el('readerFooter').classList.toggle('hidden-chrome', !visible);
}

/* ---------- Bookmarks ---------- */
async function loadBookmarksAndHighlights(bookId) {
  state.currentBookmarks = await idbGetByIndex('bookmarks', 'bookId', bookId);
  state.currentHighlights = await idbGetByIndex('highlights', 'bookId', bookId);
}

el('bookmarkBtn').addEventListener('click', async () => {
  if (!state.rendition || !state.currentBook) return;
  const loc = state.rendition.currentLocation();
  if (!loc || !loc.start) return;
  const cfi = loc.start.cfi;

  const existing = state.currentBookmarks.find(b => b.cfi === cfi);
  if (existing) {
    await idbDelete('bookmarks', existing.id);
    state.currentBookmarks = state.currentBookmarks.filter(b => b.id !== existing.id);
    showToast('Bookmark removed');
    updateBookmarkIcon(false);
    renderBookmarks();
    return;
  }

  let excerpt = '';
  try {
    const range = await state.rendition.getContents()[0]?.document;
  } catch (e) {}

  const bm = {
    id: uid(),
    bookId: state.currentBook.id,
    cfi,
    chapter: el('readerChapterTitle').textContent,
    createdAt: Date.now(),
    excerpt: getVisibleTextExcerpt(),
  };
  await idbPut('bookmarks', bm);
  state.currentBookmarks.push(bm);
  showToast('Bookmark added', 'accent');
  updateBookmarkIcon(true);
  renderBookmarks();
});

function getVisibleTextExcerpt() {
  try {
    const contents = state.rendition.getContents();
    if (contents && contents[0] && contents[0].document) {
      const text = contents[0].document.body.innerText || '';
      return text.trim().slice(0, 160);
    }
  } catch (e) {}
  return '';
}

function updateBookmarkIcon(active) {
  const btn = el('bookmarkBtn');
  btn.style.color = active ? 'var(--accent)' : '';
}

function renderBookmarks() {
  const panel = el('bookmarksPanel');
  if (!state.currentBookmarks.length) {
    panel.innerHTML = '<div class="toc-empty">NO BOOKMARKS YET</div>';
    return;
  }
  const sorted = [...state.currentBookmarks].sort((a, b) => b.createdAt - a.createdAt);
  panel.innerHTML = sorted.map(bm => `
    <div class="bookmark-item" data-cfi="${escapeHtml(bm.cfi)}">
      <div class="bm-meta-row">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" stroke="none"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        <span>${escapeHtml(bm.chapter || '')}</span>
        <span>· ${new Date(bm.createdAt).toLocaleDateString()}</span>
      </div>
      ${bm.excerpt ? `<div class="bm-excerpt">${escapeHtml(bm.excerpt)}</div>` : ''}
    </div>
  `).join('');
  panel.querySelectorAll('.bookmark-item').forEach(row => {
    row.addEventListener('click', () => {
      state.rendition.display(row.dataset.cfi);
      closeSheet('tocOverlay');
    });
  });
}

/* ---------- Highlights ---------- */
function handleTextSelection(cfiRange, contents) {
  if (!state.settings.highlightingEnabled) return;

  const selection = contents.window.getSelection();
  const text = selection ? selection.toString() : '';
  if (!text || !text.trim()) return;

  state.currentSelection = { cfiRange, text: text.trim(), contents };

  // position toolbar near selection
  try {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const iframe = el('epubViewer').querySelector('iframe');
    const iframeRect = iframe.getBoundingClientRect();
    const toolbar = el('selectionToolbar');
    const top = iframeRect.top + rect.top - 54;
    const left = iframeRect.left + rect.left + rect.width / 2;
    toolbar.style.top = Math.max(8, top) + 'px';
    toolbar.style.left = left + 'px';
    toolbar.style.transform = 'translateX(-50%)';

    // Check if this selection overlaps an existing highlight
    const existing = state.currentHighlights.find(h => h.cfi === cfiRange);
    el('selRemoveBtn').hidden = !existing;
    state.currentSelection.existingId = existing ? existing.id : null;

    toolbar.hidden = false;
  } catch (e) {
    console.error(e);
  }
}

$$('.sel-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!state.currentSelection || !state.currentBook) return;
    const color = btn.dataset.color;
    const { cfiRange, text } = state.currentSelection;

    const hl = {
      id: uid(),
      bookId: state.currentBook.id,
      cfi: cfiRange,
      text,
      color,
      chapter: el('readerChapterTitle').textContent,
      createdAt: Date.now(),
    };
    await idbPut('highlights', hl);
    state.currentHighlights.push(hl);

    applyHighlight(hl);
    renderHighlights();
    clearSelectionUI();
    showToast('Highlighted', 'accent');
  });
});

el('selCopyBtn').addEventListener('click', () => {
  if (!state.currentSelection) return;
  navigator.clipboard?.writeText(state.currentSelection.text).catch(() => {});
  showToast('Copied to clipboard');
  clearSelectionUI();
});

el('selRemoveBtn').addEventListener('click', async () => {
  if (!state.currentSelection || !state.currentSelection.existingId) return;
  const id = state.currentSelection.existingId;
  await idbDelete('highlights', id);
  state.currentHighlights = state.currentHighlights.filter(h => h.id !== id);
  try { state.rendition.annotations.remove(state.currentSelection.cfiRange, 'highlight'); } catch (e) {}
  renderHighlights();
  clearSelectionUI();
  showToast('Highlight removed');
});

function clearSelectionUI() {
  el('selectionToolbar').hidden = true;
  state.currentSelection = null;
  try {
    const contents = state.rendition.getContents();
    contents.forEach(c => c.window.getSelection().removeAllRanges());
  } catch (e) {}
}

function applyHighlight(hl) {
  try {
    state.rendition.annotations.add(
      'highlight',
      hl.cfi,
      {},
      null,
      'shelf-highlight',
      { fill: hl.color, 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' }
    );
  } catch (e) { console.error(e); }
}

function applyHighlightsToRendition() {
  state.currentHighlights.forEach(applyHighlight);
}

function renderHighlights() {
  const panel = el('highlightsPanel');
  if (!state.currentHighlights.length) {
    panel.innerHTML = '<div class="toc-empty">NO HIGHLIGHTS YET</div>';
    return;
  }
  const sorted = [...state.currentHighlights].sort((a, b) => b.createdAt - a.createdAt);
  panel.innerHTML = sorted.map(hl => `
    <div class="highlight-item" data-cfi="${escapeHtml(hl.cfi)}">
      <div class="bm-meta-row">
        <span class="hl-color-dot" style="background:${hl.color}"></span>
        <span>${escapeHtml(hl.chapter || '')}</span>
        <span>· ${new Date(hl.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="hl-excerpt" style="--hl-color:${hl.color}">${escapeHtml(hl.text)}</div>
    </div>
  `).join('');
  panel.querySelectorAll('.highlight-item').forEach(row => {
    row.addEventListener('click', () => {
      state.rendition.display(row.dataset.cfi);
      closeSheet('tocOverlay');
    });
  });
}

/* ============================================================
   SHEETS (generic open/close + swipe to dismiss)
   ============================================================ */
function openSheet(overlayId) {
  el(overlayId).hidden = false;
}
function closeSheet(overlayId) {
  el(overlayId).hidden = true;
}

$$('.sheet-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSheet(overlay.id);
  });
});
$$('.sheet-close').forEach(btn => {
  btn.addEventListener('click', () => closeSheet(btn.dataset.close));
});

// swipe down to dismiss
$$('.sheet-handle-row').forEach(handleRow => {
  let startY = null;
  const sheet = handleRow.closest('.sheet');
  const overlay = sheet.closest('.sheet-overlay');

  handleRow.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    sheet.style.transition = 'none';
  }, { passive: true });

  handleRow.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  handleRow.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = (e.changedTouches[0].clientY - startY);
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 80) closeSheet(overlay.id);
    startY = null;
  });
});

/* ---------- TOC sheet trigger + tabs ---------- */
el('tocBtn').addEventListener('click', () => openSheet('tocOverlay'));

$$('.sheet-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.sheet-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tocTab;
    el('chaptersPanel').hidden = target !== 'chapters';
    el('bookmarksPanel').hidden = target !== 'bookmarks';
    el('highlightsPanel').hidden = target !== 'highlights';
  });
});

/* ---------- Settings sheet ---------- */
el('openSettingsBtn').addEventListener('click', () => {
  syncSettingsUI();
  openSheet('settingsOverlay');
});

function syncSettingsUI() {
  el('fontSizeValue').textContent = state.settings.fontSize;
  el('lineHeightValue').textContent = state.settings.lineHeight.toFixed(1);
  el('marginValue').textContent = state.settings.margin;
  $$('.chip-option[data-font]').forEach(c => c.classList.toggle('active', c.dataset.font === state.settings.fontFamily));
  $$('.chip-option[data-flow]').forEach(c => c.classList.toggle('active', c.dataset.flow === state.settings.flow));
  el('highlightToggle').setAttribute('aria-checked', String(!!state.settings.highlightingEnabled));
}

el('highlightToggle').addEventListener('click', () => {
  state.settings.highlightingEnabled = !state.settings.highlightingEnabled;
  saveSettings();
  syncSettingsUI();
  // Turning it off should also dismiss any toolbar that's currently showing
  // and clear the pending selection, so it can't be used a moment later.
  if (!state.settings.highlightingEnabled) {
    clearSelectionUI();
  }
});

el('fontIncBtn').addEventListener('click', () => adjustSetting('fontSize', 1, 12, 32));
el('fontDecBtn').addEventListener('click', () => adjustSetting('fontSize', -1, 12, 32));
el('lineIncBtn').addEventListener('click', () => adjustSetting('lineHeight', 0.1, 1.2, 2.4));
el('lineDecBtn').addEventListener('click', () => adjustSetting('lineHeight', -0.1, 1.2, 2.4));
el('marginIncBtn').addEventListener('click', () => adjustSetting('margin', 4, 0, 64));
el('marginDecBtn').addEventListener('click', () => adjustSetting('margin', -4, 0, 64));

function adjustSetting(key, delta, min, max) {
  let val = state.settings[key] + delta;
  val = Math.round(val * 10) / 10;
  val = Math.max(min, Math.min(max, val));
  state.settings[key] = val;
  saveSettings();
  syncSettingsUI();
  applyRenditionTheme();
}

$$('.chip-option[data-font]').forEach(chip => {
  chip.addEventListener('click', () => {
    state.settings.fontFamily = chip.dataset.font;
    saveSettings();
    syncSettingsUI();
    applyRenditionTheme();
  });
});

$$('.chip-option[data-flow]').forEach(chip => {
  chip.addEventListener('click', async () => {
    state.settings.flow = chip.dataset.flow;
    saveSettings();
    syncSettingsUI();
    // re-render with new flow
    if (state.rendition && state.currentBook) {
      const cfi = state.currentBook.cfi;
      const viewerEl = el('epubViewer');
      state.rendition.destroy();
      viewerEl.innerHTML = '';
      const rendition = state.book.renderTo(viewerEl, {
        // See openBook() for why width/height are intentionally omitted.
        flow: state.settings.flow === 'scrolled' ? 'scrolled-doc' : 'paginated',
        spread: 'none',
      });
      state.rendition = rendition;
      applyRenditionTheme();

      // See openBook() for why these must be registered before display().
      rendition.on('relocated', onRelocated);
      rendition.on('selected', handleTextSelection);
      rendition.hooks.content.register((contents) => {
        attachSurfaceTapHandler(contents);
      });

      await rendition.display(cfi || undefined);
      applyHighlightsToRendition();
    }
  });
});

/* ---------- Theme sheet ---------- */
el('openThemeBtn').addEventListener('click', () => {
  syncThemeUI();
  openSheet('themeOverlay');
});

function syncThemeUI() {
  $$('.theme-swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.theme === state.settings.theme));
}

$$('.theme-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    state.settings.theme = sw.dataset.theme;
    saveSettings();
    syncThemeUI();
    applyRenditionTheme();
  });
});

/* ============================================================
   BOTTOM NAV
   ============================================================ */
el('continueFabBtn').addEventListener('click', () => {
  const inProgress = state.books
    .filter(b => b.progress > 0 && !b.finished)
    .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0];
  if (inProgress) {
    openBook(inProgress.id);
  } else if (state.books.length) {
    openBook(state.books[0].id);
  } else {
    el('fileInput').click();
  }
});

$$('.nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', () => {
    $$('.nav-item[data-tab]').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    if (item.dataset.tab === 'stats') {
      showStatsToast();
    }
  });
});

function showStatsToast() {
  const total = state.books.length;
  const finished = state.books.filter(b => b.finished).length;
  const avgProgress = total ? Math.round(state.books.reduce((s, b) => s + (b.progress || 0), 0) / total * 100) : 0;
  showToast(`${total} books · ${finished} finished · ${avgProgress}% avg progress`);
}

/* ---------- Sort control ---------- */
el('sortSelect').addEventListener('change', (e) => {
  state.sortMode = e.target.value;
  renderLibrary();
});

/* ---------- Search (simple filter over title/author) ---------- */
el('searchLibraryBtn').addEventListener('click', () => {
  const q = prompt('Search library by title or author:');
  if (q == null) return;
  const query = q.trim().toLowerCase();
  if (!query) { renderLibrary(); return; }
  const filtered = state.books.filter(b =>
    (b.title || '').toLowerCase().includes(query) ||
    (b.author || '').toLowerCase().includes(query)
  );
  const grid = el('libraryGrid');
  el('emptyState').hidden = filtered.length > 0;
  grid.innerHTML = filtered.map(bookCardHTML).join('');
  grid.querySelectorAll('.book-card').forEach(card => {
    card.addEventListener('click', () => openBook(card.dataset.id));
    card.querySelector('.book-card-menu-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openBookOptions(card.dataset.id);
    });
  });
});

/* ============================================================
   PWA: SERVICE WORKER + INSTALL PROMPT
   ============================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!localStorage.getItem('shelf-install-dismissed')) {
    el('installBanner').hidden = false;
  }
});

el('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  el('installBanner').hidden = true;
});

el('installDismissBtn').addEventListener('click', () => {
  el('installBanner').hidden = true;
  localStorage.setItem('shelf-install-dismissed', '1');
});

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  loadSettings();
  await openDB();
  await loadLibrary();
}

init();
