/* ============================================================
   shelf — terminal ebook reader
   ============================================================ */

/* ---------- IndexedDB wrapper ---------- */
const DB_NAME = 'shelf-db';
// v2 adds the 'handles' store, which persists the File System Access
// directory handle for folder sync. The existing stores are all created
// behind contains() guards, so upgrading an existing v1 database just adds
// the new store and leaves books/files/bookmarks/highlights untouched.
const DB_VERSION = 2;
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
      // FileSystemDirectoryHandle objects are structured-cloneable, so the
      // folder grant survives app restarts without re-prompting.
      if (!_db.objectStoreNames.contains('handles')) {
        _db.createObjectStore('handles', { keyPath: 'id' });
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

// The reading font choices above are Google Fonts loaded in the OUTER
// document's <head> — but epub.js renders each chapter in its own, separate
// same-origin iframe with its own <head>, which does NOT inherit stylesheets
// from the parent document. Without explicitly loading fonts inside that
// iframe too, every book silently fell back to Georgia/system-sans
// regardless of what was picked in settings. contents.addStylesheet() (the
// documented epub.js API for injecting CSS into rendered content, called
// from the content hook) loads the same Google Fonts URL directly inside
// each section's iframe document, once per section as it renders.
const READING_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;1,7..72,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400&display=swap';
// Measure the reading area ourselves and hand epub.js exact pixel numbers,
// rather than letting it measure a percentage-height div for itself.
//
// Two things matter here:
//
// 1. WHO MEASURES. epub.js reads its container's size once and locks its
//    column geometry to it. Leaving that to a CSS percentage chain
//    (.reader-surface flex:1 > .epub-viewer height:100%) means the number it
//    gets depends on exactly when in the layout/paint cycle it looked, which
//    is not something we control. Measuring .reader-surface directly and
//    passing real numbers removes that whole class of timing risk. (Numbers,
//    not strings: epub.js's isNumber() check treats '100%' as numeric —
//    parseFloat('100%') === 100 — and appends 'px', producing the invalid
//    value '100%px'. A real number like 716 correctly becomes '716px'.)
//
// 2. LINE-HEIGHT ALIGNMENT — this is the one that actually causes text to
//    go missing. CSS columns fill to the column height, then break. If the
//    column height is not an exact multiple of the line box height, the
//    final line of each page only partly fits. A partly-fitting line is not
//    pushed to the next column — it renders in place and is simply cut off
//    by the container's bounds, and because CSS multi-column layout on the
//    web only overflows *horizontally*, that remainder has no next page to
//    flow into. It stays in the DOM (still selectable, which is exactly why
//    it could be highlighted and copied) but is never displayed anywhere.
//    Worse, the leftover remainder accumulates down the page, so several
//    lines can end up stranded rather than just one. Snapping the height
//    down to a whole number of line boxes means every page ends exactly on
//    a line boundary and nothing is ever left half-placed.
function getRenderSize() {
  const surface = el('readerSurface');
  const rect = surface.getBoundingClientRect();
  const width = Math.floor(rect.width);
  // Round the line box UP to a whole pixel before dividing. Most font-size /
  // line-height combinations give a fractional line box (18 x 1.6 = 28.8px),
  // and flooring the final height afterwards would knock it back off the
  // line boundary we just aligned it to — 24 x 1.6 would land on 18.98 line
  // boxes rather than 19. Ceiling the box keeps every height an exact whole
  // multiple of a whole number of pixels, and errs a hair tall per line so
  // real lines always fit inside their slot rather than a hair short.
  const lineBox = Math.ceil(state.settings.fontSize * state.settings.lineHeight);
  // Trim a couple of pixels first so sub-pixel rounding in the surface's own
  // measurement can't push the last line box past the edge.
  const usable = Math.floor(rect.height) - 2;
  const height = lineBox > 0
    ? Math.max(lineBox, Math.floor(usable / lineBox) * lineBox)
    : usable;
  return { width, height };
}

function loadReadingFonts(contents) {
  try {
    const stylesheetPromise = contents.addStylesheet(READING_FONTS_URL);
    // Loading a font AFTER epub.js has already measured/columnized a page
    // (which happens as soon as the section's markup and existing styles are
    // parsed — it doesn't know to wait for a stylesheet added afterward) can
    // itself reintroduce the very mismatch this whole fix is about: the font
    // swapping in mid-read shifts line heights/character widths, so the
    // column boundaries epub.js locked in against the fallback font may no
    // longer match the real font's layout. document.fonts.ready resolves
    // once all requested fonts have actually finished loading and the page
    // has reflowed against them; forcing one re-render at that point (not on
    // every load — see the guard below) ensures pagination is always
    // computed against final metrics rather than a transient fallback.
    const doc = contents.document;
    if (doc && doc.fonts && doc.fonts.ready) {
      Promise.resolve(stylesheetPromise).then(() => doc.fonts.ready).then(() => {
        scheduleFontReflowRerender();
      }).catch(() => {});
    }
  } catch (e) {}
}

// Fires at most once per book-open/settings-change cycle: multiple sections
// can each trigger this as they render, but we only need a single
// re-layout once fonts are actually available, not one per section.
let fontReflowRerenderDone = false;
function scheduleFontReflowRerender() {
  if (fontReflowRerenderDone) return;
  fontReflowRerenderDone = true;
  setTimeout(() => { reRenderRendition(); }, 50);
}

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

  // Continue reading card: most recently opened, unfinished.
  //
  // Keyed off lastOpenedAt, NOT progress. Requiring progress > 0 meant a book
  // you'd opened but hadn't yet paged past the first screen of still counted
  // as 0% — epub.js legitimately reports 0 at the very start of a book — so
  // it failed the filter and the card silently disappeared on the next load.
  // It looked like opening a book deleted it from Currently Reading. Having
  // opened a book at all is what makes it the thing you're currently reading.
  const inProgress = state.books
    .filter(b => b.lastOpenedAt && !b.finished && (b.progress || 0) < 0.995)
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

// opts.quiet suppresses the loading overlay, per-file toast and library
// re-render so folder sync can import many files and report once at the end.
// Returns true on success, false on failure, so the caller can tally results.
async function importEpub(file, opts = {}) {
  const quiet = !!opts.quiet;
  if (!quiet) showLoading('PARSING EPUB…');
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
      // 'folder' for books picked up by folder sync, undefined for manual
      // imports. Together with fileName+fileSize this is what lets a rescan
      // tell "already imported" from "new file".
      source: opts.source || undefined,
    };

    await idbPut('files', { id, data: arrayBuffer });
    await idbPut('books', meta);

    tempBook.destroy();

    state.books.push(meta);
    if (!quiet) {
      hideLoading();
      await loadLibrary();
      showToast(`Imported "${meta.title}"`, 'accent');
    }
    return true;
  } catch (err) {
    console.error('EPUB import failed:', err);
    if (!quiet) {
      hideLoading();
      showToast(describeImportError(err, file), 'danger');
    }
    return false;
  }
}

/* ============================================================
   FOLDER SYNC (File System Access API)

   Pick a folder once; re-scan it for new EPUBs each time the app opens.
   This is deliberately not "monitoring" — a PWA can't watch a directory
   while it's closed, and Periodic Background Sync is too throttled to
   rely on. What it can do is remember the folder and diff it on launch.

   The handle is stored in IndexedDB because FileSystemDirectoryHandle is
   structured-cloneable, so the grant survives restarts without re-picking.
   Permission still isn't guaranteed to persist: queryPermission() can come
   back 'prompt' after a restart, and re-requesting needs a user gesture.
   So a silent rescan is best-effort, and anything requiring a prompt is
   deferred to the person tapping the sync button.

   Availability is narrow: showDirectoryPicker() is Chromium-only, and
   support on Android is inconsistent. Everything here is feature-detected
   and the UI stays hidden entirely where it isn't supported, so the normal
   file picker remains the path that always works.
   ============================================================ */

const FOLDER_HANDLE_KEY = 'sync-folder';

function folderSyncSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

async function getSavedFolderHandle() {
  try {
    const rec = await idbGet('handles', FOLDER_HANDLE_KEY);
    return rec ? rec.handle : null;
  } catch (e) { return null; }
}

async function saveFolderHandle(handle) {
  await idbPut('handles', { id: FOLDER_HANDLE_KEY, handle, name: handle.name });
}

async function clearFolderHandle() {
  try { await idbDelete('handles', FOLDER_HANDLE_KEY); } catch (e) {}
}

// mode 'query' checks silently; 'request' may show a prompt and therefore
// must be called from a user gesture.
async function ensureFolderPermission(handle, mode) {
  if (!handle) return false;
  try {
    const opts = { mode: 'read' };
    const current = await handle.queryPermission(opts);
    if (current === 'granted') return true;
    if (mode === 'request') {
      return (await handle.requestPermission(opts)) === 'granted';
    }
    return false;
  } catch (e) { return false; }
}

async function pickSyncFolder() {
  if (!folderSyncSupported()) {
    showToast('Folder sync needs a Chromium browser', 'danger');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'shelf-books', mode: 'read' });
  } catch (e) {
    return; // person cancelled the picker
  }
  if (!(await ensureFolderPermission(handle, 'request'))) {
    showToast('Folder access was not granted', 'danger');
    return;
  }
  await saveFolderHandle(handle);
  await refreshFolderSheet();
  await scanSyncFolder({ silent: false });
}

// Walks the folder (recursively) and imports any .epub not already in the
// library. Dedupe is by filename + byte size, which is enough to avoid
// re-importing the same file while still noticing a genuinely different one.
async function scanSyncFolder({ silent }) {
  if (!folderSyncSupported()) return;
  const handle = await getSavedFolderHandle();
  if (!handle) return;

  const granted = await ensureFolderPermission(handle, silent ? 'query' : 'request');
  if (!granted) {
    // On a silent launch scan we can't prompt (no user gesture), so leave it
    // for the person to trigger from settings rather than failing loudly.
    if (!silent) showToast('Folder access was not granted', 'danger');
    return;
  }

  const known = new Set(
    state.books.map(b => `${b.fileName || ''}:${b.fileSize || 0}`)
  );

  let candidates = [];
  try {
    candidates = await collectEpubFiles(handle);
  } catch (e) {
    console.error('Folder scan failed:', e);
    if (!silent) showToast('Could not read that folder', 'danger');
    return;
  }

  const fresh = candidates.filter(f => !known.has(`${f.name}:${f.size}`));
  if (fresh.length === 0) {
    if (!silent) showToast('No new books found');
    return;
  }

  let imported = 0;
  showLoading(`IMPORTING 0/${fresh.length}…`);
  for (let i = 0; i < fresh.length; i++) {
    el('loadingText').textContent = `IMPORTING ${i + 1}/${fresh.length}…`;
    const ok = await importEpub(fresh[i], { quiet: true, source: 'folder' });
    if (ok) imported++;
  }
  hideLoading();
  await loadLibrary();

  const failed = fresh.length - imported;
  showToast(
    failed
      ? `Added ${imported}, skipped ${failed} unreadable`
      : `Added ${imported} book${imported === 1 ? '' : 's'}`,
    imported ? 'accent' : 'danger'
  );
}

// Recursive walk, depth-capped so a deeply nested or symlink-looping tree
// can't spin forever. Individual unreadable entries are skipped rather than
// aborting the whole scan.
async function collectEpubFiles(dirHandle, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  for await (const entry of dirHandle.values()) {
    try {
      if (entry.kind === 'file') {
        if (!/\.epub$/i.test(entry.name)) continue;
        out.push(await entry.getFile());
      } else if (entry.kind === 'directory') {
        out.push(...await collectEpubFiles(entry, depth + 1));
      }
    } catch (e) { /* skip entries we can't read */ }
  }
  return out;
}

async function forgetSyncFolder() {
  await clearFolderHandle();
  await refreshFolderSheet();
  showToast('Folder disconnected');
}

/* ---------- Folder sync UI ---------- */

// The whole feature is hidden where showDirectoryPicker() doesn't exist
// (Firefox, Safari, and some Android builds), so the normal file picker
// stays the obvious path rather than sitting next to a button that errors.
if (folderSyncSupported()) {
  el('folderBtn').hidden = false;
}

async function refreshFolderSheet() {
  const handle = await getSavedFolderHandle();
  const status = el('folderStatus');
  const hasFolder = !!handle;

  if (hasFolder) {
    const granted = await ensureFolderPermission(handle, 'query');
    status.innerHTML = granted
      ? `Watching <strong>${escapeHtml(handle.name)}</strong>. New EPUBs are picked up when you open the app.`
      : `<strong>${escapeHtml(handle.name)}</strong> needs permission again — tap Rescan to re-grant it.`;
  } else {
    status.textContent = 'Pick a folder and new EPUBs in it get added automatically each time you open the app. Nothing is scanned while the app is closed.';
  }

  el('folderPickBtn').textContent = hasFolder ? 'CHANGE FOLDER' : 'CHOOSE FOLDER';
  el('folderRescanBtn').hidden = !hasFolder;
  el('folderForgetBtn').hidden = !hasFolder;
}

el('folderBtn').addEventListener('click', async () => {
  await refreshFolderSheet();
  openSheet('folderOverlay');
});

el('folderPickBtn').addEventListener('click', async () => {
  closeSheet('folderOverlay');
  await pickSyncFolder();
});

el('folderRescanBtn').addEventListener('click', async () => {
  closeSheet('folderOverlay');
  // Not silent: this came from a tap, so we're allowed to prompt for
  // permission if the grant lapsed since last launch.
  await scanSyncFolder({ silent: false });
});

el('folderForgetBtn').addEventListener('click', async () => {
  closeSheet('folderOverlay');
  await forgetSyncFolder();
});


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
  // Reset the once-per-session font-reflow guard for this new reading
  // session; see loadReadingFonts()/scheduleFontReflowRerender().
  fontReflowRerenderDone = false;

  try {
    const fileRec = await idbGet('files', id);
    if (!fileRec) throw new Error('File data missing');

    state.currentBook = meta;
    el('readerBookTitle').textContent = meta.title;
    el('readerView').hidden = false;
    el('bottomNav').style.display = 'none';
    document.body.style.overflow = 'hidden';
    syncReaderViewHeightOnce();
    updateFullscreenStatusBar(Math.round((meta.progress || 0) * 100), null, null);

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
    // Record the surface size now that the reader is visible and laid out,
    // so the resize watcher treats this as the starting point rather than a
    // change worth re-rendering for.
    baselineSurfaceSize();

    const book = ePub(fileRec.data.slice(0));
    state.book = book;

    const viewerEl = el('epubViewer');
    viewerEl.innerHTML = '';

    const theme = THEMES[state.settings.theme];
    document.documentElement.style.setProperty('--rs-bg', theme.bg);

    const size = getRenderSize();
    const rendition = book.renderTo(viewerEl, {
      // Explicit measured pixel numbers — see getRenderSize() for why we
      // measure ourselves and why the height is snapped to a whole number
      // of line boxes.
      width: size.width,
      height: size.height,
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
      loadReadingFonts(contents);
    });

    // A saved CFI can be rejected by epub.js if it's malformed or no longer
    // resolves against this book. Falling back to the start is the only
    // option, but do it explicitly and log it — an unhandled rejection here
    // would silently land the reader at page one and look exactly like the
    // position was never saved.
    const startCfi = meta.cfi || undefined;
    try {
      await rendition.display(startCfi);
    } catch (err) {
      if (startCfi) {
        console.error('Saved position could not be restored, starting from the beginning:', err);
        await rendition.display();
      } else {
        throw err;
      }
    }

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
// Two separate concerns here, which were previously (wrongly) lumped
// together behind one debounce:
//
//  - SAVING the position. This must happen immediately. It was deferred by
//    ~440ms along with everything else, which meant any position not
//    followed by 440ms of idle time was simply never written — including
//    the page you were on when you left the book, since closing or
//    backgrounding the app dropped the pending timer on the floor. Saving
//    a position captured mid-page-turn is harmless (worst case you resume
//    a page early); losing it entirely is not.
//
//  - RECOMPUTING the progress bar / chapter label. This stays debounced,
//    which is what the delay was actually for: epub.js reports location as
//    soon as it issues the page-turn scroll, not once that scroll visually
//    settles, so reading it too early can show a transient in-between page.
let relocateDebounce = null;
function onRelocated(location) {
  // persistLocation must never be allowed to throw into epub.js's event
  // emit — an exception here propagates back into the rendition's own
  // relocation handling and can leave it in a broken state.
  try {
    persistLocation(location);
  } catch (err) {
    console.error('Failed to persist reading position:', err);
  }
  clearTimeout(relocateDebounce);
  relocateDebounce = setTimeout(() => applyRelocated(location), PAGE_TURN_ANIM_MS + 40);
}

function persistLocation(location) {
  if (!state.currentBook || !state.book || !location || !location.start) return;
  const cfi = location.start.cfi;
  if (!cfi) return;
  state.currentBook.cfi = cfi;

  // The percentage is a nice-to-have; the CFI is the thing that actually
  // restores your place. percentageFromCfi() can throw on a CFI it can't
  // resolve, and when that happened here it aborted the whole function
  // before the write — so the position was silently never saved. Work out
  // the percentage defensively and save regardless of whether it succeeded.
  let pct = null;
  try {
    if (state.book.locations && state.book.locations.length()) {
      const p = state.book.locations.percentageFromCfi(cfi);
      if (typeof p === 'number' && !isNaN(p)) pct = p;
    }
  } catch (e) { /* fall through to the location's own percentage */ }

  if (pct === null && typeof location.start.percentage === 'number') {
    pct = location.start.percentage;
  }

  if (pct !== null) {
    state.currentBook.progress = pct;
    if (pct >= 0.995) state.currentBook.finished = true;
  }

  idbPut('books', state.currentBook).catch(err => {
    console.error('Failed to save reading position:', err);
  });
}

function applyRelocated(location) {
  if (!state.currentBook || !state.book) return;
  updateProgressUI();
  updateChapterLabel(location.start.cfi);
}

// Force any position held only in memory out to storage right now. Called
// before tearing the reader down and when the app is being backgrounded.
function flushReadingPosition() {
  if (!state.currentBook || !state.rendition) return;
  try {
    const loc = state.rendition.currentLocation();
    if (loc && loc.start && loc.start.cfi) persistLocation(loc);
  } catch (e) { /* rendition already torn down */ }
}

// On a phone people leave a book by going to the home screen or switching
// apps far more often than by tapping back, and neither fires anything the
// reader was listening for. visibilitychange is the one signal that
// reliably arrives before the page is frozen or discarded; pagehide covers
// actual teardown. Without these, a session could end with nothing written
// at all — which is what made books reopen at the beginning.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushReadingPosition();
});
window.addEventListener('pagehide', flushReadingPosition);

function updateProgressUI() {
  if (!state.currentBook) return;
  const fraction = state.currentBook.progress || 0;
  const pct = Math.round(fraction * 100);
  el('readerProgressFill').style.width = pct + '%';
  el('readerPercentLabel').textContent = pct + '%';

  // Page numbers are derived from the book-wide percentage, not from
  // locations.locationFromCfi(). That lookup resolves a CFI against the
  // spine item it belongs to, so its result depends on chapter structure:
  // it can jump, repeat or run backwards across a chapter boundary, which
  // is why the count looked wrong whenever chapters were involved. The
  // percentage is a single monotonic measure over the whole book, so
  // scaling it by the total gives a flat 1..N page count that always moves
  // forward and always agrees with the progress bar next to it.
  let locLabel = '—';
  let currentPage = null, totalPages = null;
  if (state.book && state.book.locations && state.book.locations.length()) {
    totalPages = state.book.locations.length();
    // Clamped to 1 at the low end so the first page reads "1", not "0".
    currentPage = Math.min(totalPages, Math.max(1, Math.ceil(fraction * totalPages)));
    locLabel = `PAGE ${currentPage}/${totalPages}`;
  }
  el('readerLocLabel').textContent = locLabel;

  updateFullscreenStatusBar(pct, currentPage, totalPages);
}

/* ============================================================
   FULLSCREEN/STANDALONE STATUS BAR
   Only relevant when the app is running with no browser chrome at all
   (installed as a PWA, "Add to Home Screen", etc.) — a normal browser tab
   already has its own status bar (clock, battery, signal), so we stay out
   of the way there. display-mode: standalone/fullscreen/minimal-ui is the
   standard, cross-browser signal for "no browser UI is showing".
   ============================================================ */
function isRunningStandalone() {
  try {
    if (window.matchMedia) {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    }
    // Older iOS Safari "Add to Home Screen" signal.
    if (window.navigator && window.navigator.standalone) return true;
  } catch (e) {}
  return false;
}

function updateFullscreenStatusBar(pct, currentPage, totalPages) {
  const bar = el('fullscreenStatusBar');
  if (!isRunningStandalone() || !state.currentBook) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  el('fsStatusTitle').textContent = state.currentBook.title || '';
  el('fsStatusPage').textContent = (currentPage != null && totalPages != null)
    ? `PAGE ${currentPage}/${totalPages}`
    : '—';
  el('fsStatusPct').textContent = `${pct}%`;
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
      goToCfi(href);
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
    // font-size and line-height are forced here, not just on body, because
    // EPUBs very often ship their own stylesheet rules targeting p/div/span
    // directly, which would otherwise win over the body-level rule (a
    // long-standing epub.js complaint — issue #1039). That matters beyond
    // appearance: getRenderSize() snaps the page height to a whole number
    // of line boxes, and that arithmetic is only correct if every line in
    // the text really is the height we think it is. If the book's own CSS
    // silently changed it, pages would stop ending on a line boundary and
    // the last line of each page could be stranded again.
    'p, div, span, li': {
      'font-family': `${fontStack} !important`,
      'font-size': `${state.settings.fontSize}px !important`,
      'line-height': `${state.settings.lineHeight} !important`,
    },
    '::selection': {
      background: '#39ff9a55',
    },
    'a': { color: `${theme.text} !important`, 'text-decoration': 'underline' },
  });
  state.rendition.themes.fontSize(`${state.settings.fontSize}px`);
}

function closeReader() {
  // Capture the position BEFORE anything is destroyed or cleared. This used
  // to run after state.currentBook was already null, so the guard in the
  // save path silently discarded the final position of every session.
  flushReadingPosition();
  clearTimeout(relocateDebounce);

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
  stopReaderViewportSync();
  el('fullscreenStatusBar').hidden = true;
  loadLibrary();
}

// Mobile browsers report a "layout viewport" (window.innerHeight / vh units)
// that assumes the URL bar is fully collapsed, even while it's actually
// visible on screen. A fixed-position element sized off that layout viewport
// extends its bottom edge underneath the real, currently-visible browser
// chrome instead of stopping above it — content there is covered, not
// clipped by any CSS rule. window.visualViewport reports the actual visible
// area, so pinning .reader-view's real height to it at open time fixes that.
//
// IMPORTANT: this must only run ONCE per book-open, not live on every
// visualViewport 'resize'/'scroll' event. Those fire frequently and
// transiently on real devices — as the URL bar auto-hides/reappears during
// normal scrolling, for instance — and each firing used to both resize
// .reader-view AND dispatch a synthetic window 'resize', which epub.js
// listens for internally to re-measure and re-paginate. If that re-pagination
// ever happened while the URL bar was temporarily hidden (larger visible
// area), epub.js would lock in taller pages than what's visible once the bar
// reappears — and because CSS multi-column layout only overflows
// horizontally on the web, that excess has no "next page" to flow to; it
// just sits below the fold, selectable but never shown. That is almost
// certainly what produced the large, multi-line missing-text reports: not a
// small rounding error, but epub.js repaginating against a transient,
// larger-than-final viewport height. Syncing once at open (after layout has
// settled) avoids the live re-pagination risk entirely while still fixing
// the original URL-bar-covers-content problem.
function syncReaderViewHeightOnce() {
  if (!window.visualViewport) return;
  el('readerView').style.height = window.visualViewport.height + 'px';
}
function stopReaderViewportSync() {
  el('readerView').style.height = '';
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

// Single place for "jump to this CFI", used by the contents list, bookmarks
// and highlights. These all used to call rendition.display() bare: not
// awaited and not guarded, so a CFI epub.js couldn't resolve produced an
// unhandled rejection and left the reader wherever it happened to land,
// with nothing written down. Here the jump is awaited, failures surface as
// a toast instead of vanishing, and the new position is persisted straight
// away rather than waiting for the relocation event to come back around.
async function goToCfi(cfi) {
  if (!state.rendition || !cfi) return false;
  try {
    await state.rendition.display(cfi);
    flushReadingPosition();
    return true;
  } catch (err) {
    console.error('Could not navigate to position:', cfi, err);
    showToast('Could not open that position', 'danger');
    return false;
  }
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
      goToCfi(row.dataset.cfi);
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
      goToCfi(row.dataset.cfi);
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

// epub.js computes its CSS multi-column page boundaries once, against
// whatever font-size/line-height/margin was in effect at render time. It
// does not automatically recompute those boundaries when that CSS changes
// afterward (confirmed: futurepress/epub.js issue #453 — "the chapter frame
// does not resize dynamically when the chapter content size changed, for
// example after changing the text size"). Left alone, this means increasing
// font size can make a paragraph's actual rendered height exceed the OLD
// column height, and the overflow is silently clipped by the container's
// overflow:hidden rather than reflowing into the next page — exactly the
// "text missing until font is set to 12" symptom. The reliable fix is to
// fully re-render at the current position after any layout-affecting
// setting changes, forcing epub.js to lay out its columns fresh against the
// new CSS rather than trying to patch the existing (stale) layout in place.
// Re-entrancy guard. Several independent things can ask for a re-render
// (fonts finishing, the surface resizing, a settings change), and they can
// easily land within milliseconds of each other. Without this, two calls
// interleave: the second destroys the rendition the first just created and
// is still awaiting display() on, and the half-built result falls back to
// the start of the book. That is the flicker-then-jump-to-page-one
// behaviour. Overlapping requests instead set a flag, and one more
// re-render runs after the current one finishes.
let rerenderInFlight = false;
let rerenderQueued = false;

async function reRenderRendition() {
  if (!state.rendition || !state.currentBook || !state.book) return;
  if (rerenderInFlight) { rerenderQueued = true; return; }
  rerenderInFlight = true;

  try {
    // Prefer where the reader actually is right now over the last value
    // written to the book record — the record can lag by a page turn, and
    // after a bookmark jump it hasn't caught up at all yet.
    let cfi = state.currentBook.cfi;
    try {
      const loc = state.rendition.currentLocation();
      if (loc && loc.start && loc.start.cfi) cfi = loc.start.cfi;
    } catch (e) { /* fall back to the stored value */ }

    const viewerEl = el('epubViewer');
    state.rendition.destroy();
    viewerEl.innerHTML = '';
    const size = getRenderSize();
    const rendition = state.book.renderTo(viewerEl, {
      // See getRenderSize() — explicit numbers, height snapped to line boxes.
      width: size.width,
      height: size.height,
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
      loadReadingFonts(contents);
    });

    try {
      await rendition.display(cfi || undefined);
    } catch (err) {
      console.error('Re-render could not restore position:', err);
      await rendition.display();
    }
    applyHighlightsToRendition();

    // Re-baseline so the size we just rendered at doesn't itself look like
    // a change and kick off another round.
    const r = el('readerSurface').getBoundingClientRect();
    lastSurfaceSize = { width: Math.round(r.width), height: Math.round(r.height) };
  } finally {
    rerenderInFlight = false;
    if (rerenderQueued) {
      rerenderQueued = false;
      setTimeout(() => reRenderRendition(), 0);
    }
  }
}

// epub.js's column layout does not adapt to a resized container on its own
// (confirmed: futurepress/epub.js issue #453), so any real change to the
// reading area needs a full re-render at the current position.
//
// Watching .reader-surface directly with a ResizeObserver is better than
// listening for orientationchange or window resize: it reacts to whatever
// actually changed the reading area — rotation, the URL bar showing or
// hiding, the on-screen keyboard, switching between browser tab and
// installed app — and, critically, it only fires when the box genuinely
// changed size. That last part is what makes this safe: the earlier
// approach of re-paginating on every visualViewport event meant epub.js
// could relayout against a mid-animation, transiently-wrong height and
// then keep that stale geometry, stranding text below the fold.
//
// Guarded three ways: ignore when the reader is closed, ignore sub-pixel
// noise, and debounce so a burst during a rotation animation produces one
// re-render after things settle rather than one per frame.
let surfaceResizeDebounce = null;
let lastSurfaceSize = { width: 0, height: 0 };

// Called once the reader is visible and laid out, so the hidden(0x0) ->
// visible transition isn't mistaken for a genuine resize. Without this the
// baseline was captured at page load with the reader still hidden, so every
// single book open looked like a size change and fired an unnecessary
// re-render a quarter-second in — visible as a flicker right after the book
// appeared, and able to collide with the fonts-ready re-render.
function baselineSurfaceSize() {
  const r = el('readerSurface').getBoundingClientRect();
  lastSurfaceSize = { width: Math.round(r.width), height: Math.round(r.height) };
  clearTimeout(surfaceResizeDebounce);
}

function startSurfaceResizeWatch() {
  if (typeof ResizeObserver === 'undefined') return;
  const surface = el('readerSurface');

  const observer = new ResizeObserver(() => {
    if (el('readerView').hidden || !state.rendition) return;
    const r = el('readerSurface').getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 || h === 0) return;
    if (Math.abs(w - lastSurfaceSize.width) < 2 && Math.abs(h - lastSurfaceSize.height) < 2) return;
    lastSurfaceSize = { width: w, height: h };
    clearTimeout(surfaceResizeDebounce);
    surfaceResizeDebounce = setTimeout(() => { reRenderRendition(); }, 250);
  });
  observer.observe(surface);
}
startSurfaceResizeWatch();

el('fontIncBtn').addEventListener('click', () => adjustSetting('fontSize', 1, 12, 32));
el('fontDecBtn').addEventListener('click', () => adjustSetting('fontSize', -1, 12, 32));
el('lineIncBtn').addEventListener('click', () => adjustSetting('lineHeight', 0.1, 1.2, 2.4));
el('lineDecBtn').addEventListener('click', () => adjustSetting('lineHeight', -0.1, 1.2, 2.4));
el('marginIncBtn').addEventListener('click', () => adjustSetting('margin', 4, 0, 64));
el('marginDecBtn').addEventListener('click', () => adjustSetting('margin', -4, 0, 64));

async function adjustSetting(key, delta, min, max) {
  let val = state.settings[key] + delta;
  val = Math.round(val * 10) / 10;
  val = Math.max(min, Math.min(max, val));
  state.settings[key] = val;
  saveSettings();
  syncSettingsUI();
  scheduleRerender();
}

// Rapid taps on the font-size/line-height/margin steppers would otherwise
// trigger a full destroy+re-renderTo per tap; debouncing so only the final
// value after a burst of clicks actually re-renders keeps the settings
// sheet responsive.
let rerenderDebounce = null;
function scheduleRerender() {
  clearTimeout(rerenderDebounce);
  rerenderDebounce = setTimeout(() => { reRenderRendition(); }, 220);
}

$$('.chip-option[data-font]').forEach(chip => {
  chip.addEventListener('click', async () => {
    state.settings.fontFamily = chip.dataset.font;
    saveSettings();
    syncSettingsUI();
    await reRenderRendition();
  });
});

$$('.chip-option[data-flow]').forEach(chip => {
  chip.addEventListener('click', async () => {
    state.settings.flow = chip.dataset.flow;
    saveSettings();
    syncSettingsUI();
    await reRenderRendition();
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
  // Same criterion as the Currently Reading card — see renderLibrary().
  const inProgress = state.books
    .filter(b => b.lastOpenedAt && !b.finished && (b.progress || 0) < 0.995)
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
  // Best-effort rescan of the synced folder on launch. Silent: if the
  // permission grant lapsed we can't prompt without a user gesture here, so
  // it quietly does nothing and waits for the person to tap Rescan.
  scanSyncFolder({ silent: true });
}

init();
