(() => {
  'use strict';

  /* =====================================================
     CONSTANTS / STATE
     ===================================================== */
  const HISTORY_KEY = 'scanr_history_v1';
  const URLSCAN_KEY_STORAGE = 'scanr_urlscan_api_key_v1';
  const URLSCAN_VISIBILITY_STORAGE = 'scanr_urlscan_visibility_v1';
  const URLSCAN_PROXY_STORAGE = 'scanr_urlscan_proxy_url_v1';
  const MAX_HISTORY = 500;

  const els = {};
  let history = [];
  let currentView = 'home';
  let activeSheetEntryId = null;
  let deferredInstallPrompt = null;

  let mediaStream = null;
  let detectionRAF = null;
  let barcodeDetectorInstance = null;
  let usingJsQR = false;
  let scanningPaused = false;
  let torchOn = false;

  /* =====================================================
     UTIL
     ===================================================== */
  function $(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return 'JUST NOW';
    if (s < 60) return `${s}S AGO`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}M AGO`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}H AGO`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}D AGO`;
    return new Date(ts).toLocaleDateString();
  }

  function toast(message, type = 'ok') {
    clearTimeout(toast._t);
    els.toast.textContent = message;
    els.toast.className = 'toast visible' + (type === 'error' ? ' error' : '');
    toast._t = setTimeout(() => { els.toast.classList.remove('visible'); }, 2200);
  }

  async function copyToClipboard(text, label = 'COPIED TO CLIPBOARD') {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch (e) {
      // fallback
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast(label);
      } catch (e2) {
        toast('COPY FAILED', 'error');
      }
    }
  }

  /* =====================================================
     STORAGE
     ===================================================== */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      history = raw ? JSON.parse(raw) : [];
    } catch (e) {
      history = [];
    }
    migrateStalePendingScans();
  }

  // Any 'pending' urlscan status found at load time is necessarily stale —
  // a real in-flight scan only exists in memory for the current page
  // session, so a 'pending' entry surviving into a fresh page load means
  // its poll loop ended (tab closed, refresh, etc.) without ever writing a
  // final status. Older versions of this app also had a poll-timeout bug
  // that wrote 'pending' as its own dead-end outcome — this migrates those
  // permanently-stuck entries to 'timeout' so they get a retry action
  // instead of showing a spinner forever.
  function migrateStalePendingScans() {
    let changed = false;
    history.forEach((e) => {
      if (e.urlscan && e.urlscan.status === 'pending') {
        e.urlscan = {
          status: 'timeout',
          message: 'This scan didn\u2019t finish (interrupted or the app was closed mid-check).',
          reportUrl: e.urlscan.reportUrl,
          uuid: e.urlscan.uuid
        };
        changed = true;
      }
    });
    if (changed) persistHistory();
  }

  function persistHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
    } catch (e) {
      toast('STORAGE FULL — COULD NOT SAVE', 'error');
    }
  }

  function getUrlscanKey() {
    return localStorage.getItem(URLSCAN_KEY_STORAGE) || '';
  }
  function setUrlscanKeyStorage(key) {
    localStorage.setItem(URLSCAN_KEY_STORAGE, key);
  }
  function clearUrlscanKeyStorage() {
    localStorage.removeItem(URLSCAN_KEY_STORAGE);
  }

  function getUrlscanVisibility() {
    return localStorage.getItem(URLSCAN_VISIBILITY_STORAGE) || 'public';
  }
  function setUrlscanVisibility(v) {
    localStorage.setItem(URLSCAN_VISIBILITY_STORAGE, v);
  }

  function getUrlscanProxy() {
    return (localStorage.getItem(URLSCAN_PROXY_STORAGE) || '').replace(/\/+$/, '');
  }
  function setUrlscanProxy(url) {
    localStorage.setItem(URLSCAN_PROXY_STORAGE, url.replace(/\/+$/, ''));
  }
  function clearUrlscanProxy() {
    localStorage.removeItem(URLSCAN_PROXY_STORAGE);
  }

  /* =====================================================
     CONTENT PARSING
     ===================================================== */
  function unescapeField(v) {
    return v.replace(/\\(.)/g, '$1');
  }

  function splitUnescaped(str, sep) {
    const out = [];
    let buf = '';
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\\' && i + 1 < str.length) {
        buf += str[i] + str[i + 1];
        i++;
      } else if (str[i] === sep) {
        out.push(buf);
        buf = '';
      } else {
        buf += str[i];
      }
    }
    if (buf.length) out.push(buf);
    return out;
  }

  function parseWifi(raw) {
    const body = raw.replace(/^WIFI:/i, '');
    const fields = {};
    splitUnescaped(body, ';').forEach((pair) => {
      const idx = pair.indexOf(':');
      if (idx === -1) return;
      const key = pair.slice(0, idx).toUpperCase();
      const val = unescapeField(pair.slice(idx + 1));
      if (val !== '') fields[key] = val;
    });
    return {
      ssid: fields.S || '',
      password: fields.P || '',
      encryption: (fields.T || 'nopass').toUpperCase(),
      hidden: (fields.H || '').toLowerCase() === 'true'
    };
  }

  function parseVCard(raw) {
    const lines = raw.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
    const out = { name: '', org: '', phones: [], emails: [], urls: [], addresses: [] };
    lines.forEach((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return;
      const rawKey = line.slice(0, idx).toUpperCase();
      const key = rawKey.split(';')[0];
      const val = line.slice(idx + 1).trim();
      if (!val) return;
      if (key === 'FN') out.name = val;
      else if (key === 'N' && !out.name) out.name = val.split(';').filter(Boolean).reverse().join(' ');
      else if (key === 'ORG') out.org = val.replace(/;/g, ' ');
      else if (key === 'TEL') out.phones.push(val);
      else if (key === 'EMAIL') out.emails.push(val);
      else if (key === 'URL') out.urls.push(val);
      else if (key === 'ADR') out.addresses.push(val.split(';').filter(Boolean).join(', '));
    });
    return out;
  }

  function parseMecard(raw) {
    const body = raw.replace(/^MECARD:/i, '');
    const out = { name: '', org: '', phones: [], emails: [], urls: [], addresses: [] };
    splitUnescaped(body, ';').forEach((pair) => {
      const idx = pair.indexOf(':');
      if (idx === -1) return;
      const key = pair.slice(0, idx).toUpperCase();
      const val = unescapeField(pair.slice(idx + 1));
      if (!val) return;
      if (key === 'N') out.name = val.split(',').filter(Boolean).reverse().join(' ');
      else if (key === 'ORG') out.org = val;
      else if (key === 'TEL') out.phones.push(val);
      else if (key === 'EMAIL') out.emails.push(val);
      else if (key === 'URL') out.urls.push(val);
      else if (key === 'ADR') out.addresses.push(val);
    });
    return out;
  }

  function parseGeo(raw) {
    const m = raw.match(/^geo:([\-0-9.]+),([\-0-9.]+)/i);
    return m ? { lat: m[1], lng: m[2] } : { lat: '', lng: '' };
  }

  function detectType(raw) {
    const t = raw.trim();
    if (/^https?:\/\//i.test(t)) return 'url';
    if (/^www\./i.test(t)) return 'url';
    if (/^WIFI:/i.test(t)) return 'wifi';
    if (/^BEGIN:VCARD/i.test(t)) return 'vcard';
    if (/^MECARD:/i.test(t)) return 'mecard';
    if (/^mailto:/i.test(t)) return 'email';
    if (/^tel:/i.test(t)) return 'phone';
    if (/^(sms|smsto):/i.test(t)) return 'sms';
    if (/^geo:/i.test(t)) return 'geo';
    return 'text';
  }

  function parseContent(raw) {
    const t = raw.trim();
    const kind = detectType(t);
    switch (kind) {
      case 'url': {
        const url = /^www\./i.test(t) ? 'https://' + t : t;
        let hostname = url;
        try { hostname = new URL(url).hostname; } catch (e) {}
        return { type: 'url', parsed: { url, hostname } };
      }
      case 'wifi':
        return { type: 'wifi', parsed: parseWifi(t) };
      case 'vcard':
        return { type: 'contact', parsed: { ...parseVCard(t), source: 'vcard' } };
      case 'mecard':
        return { type: 'contact', parsed: { ...parseMecard(t), source: 'mecard' } };
      case 'email': {
        const m = t.match(/^mailto:([^?]*)(?:\?(.*))?$/i) || [];
        const params = new URLSearchParams(m[2] || '');
        return { type: 'email', parsed: { address: m[1] || '', subject: params.get('subject') || '', body: params.get('body') || '' } };
      }
      case 'phone':
        return { type: 'phone', parsed: { number: t.replace(/^tel:/i, '') } };
      case 'sms': {
        const m = t.match(/^(?:sms|smsto):([^:?]*)(?:[:?](?:body=)?(.*))?$/i) || [];
        return { type: 'sms', parsed: { number: m[1] || '', body: decodeURIComponent(m[2] || '') } };
      }
      case 'geo':
        return { type: 'geo', parsed: parseGeo(t) };
      default:
        return { type: 'text', parsed: { text: t } };
    }
  }

  /* =====================================================
     TYPE METADATA (icon glyph + label + list title)
     ===================================================== */
  const TYPE_META = {
    url: { glyph: 'URL', label: 'LINK' },
    wifi: { glyph: 'WIFI', label: 'WI-FI NETWORK' },
    contact: { glyph: 'VCF', label: 'CONTACT CARD' },
    email: { glyph: '@', label: 'EMAIL' },
    phone: { glyph: 'TEL', label: 'PHONE NUMBER' },
    sms: { glyph: 'SMS', label: 'TEXT MESSAGE' },
    geo: { glyph: 'GEO', label: 'LOCATION' },
    text: { glyph: 'TXT', label: 'PLAIN TEXT' }
  };

  function titleFor(entry) {
    switch (entry.type) {
      case 'url': return entry.parsed.hostname || entry.parsed.url;
      case 'wifi': return entry.parsed.ssid || 'Unnamed network';
      case 'contact': return entry.parsed.name || entry.parsed.phones[0] || entry.parsed.emails[0] || 'Unknown contact';
      case 'email': return entry.parsed.address || 'Email';
      case 'phone': return entry.parsed.number || 'Phone number';
      case 'sms': return entry.parsed.number || 'Text message';
      case 'geo': return `${entry.parsed.lat}, ${entry.parsed.lng}`;
      default: return entry.raw.length > 60 ? entry.raw.slice(0, 60) + '…' : entry.raw;
    }
  }

  /* =====================================================
     HISTORY MANAGEMENT
     ===================================================== */
  function addHistoryEntry(raw) {
    const { type, parsed } = parseContent(raw);
    const entry = {
      id: uid(),
      raw,
      type,
      parsed,
      timestamp: Date.now(),
      urlscan: type === 'url' ? { status: 'unchecked' } : null
    };
    history.unshift(entry);
    persistHistory();
    return entry;
  }

  function deleteHistoryEntry(id) {
    history = history.filter((e) => e.id !== id);
    persistHistory();
    renderAll();
  }

  function clearAllHistory() {
    history = [];
    persistHistory();
    renderAll();
  }

  /* =====================================================
     RENDER: STATS
     ===================================================== */
  function renderStats() {
    const total = history.length;
    const links = history.filter((e) => e.type === 'url').length;
    const flagged = history.filter((e) => {
      return e.urlscan && (e.urlscan.status === 'malicious' || e.urlscan.status === 'suspicious');
    }).length;
    els.statTotal.textContent = total;
    els.statLinks.textContent = links;
    els.statFlagged.textContent = flagged;
  }

  /* =====================================================
     RENDER: HISTORY LISTS
     ===================================================== */
  function statusBadgeMap(s) {
    const map = {
      unchecked: '',
      pending: '<span class="badge"><span class="spinner"></span>CHECKING</span>',
      clean: '<span class="badge badge-green">CLEAN</span>',
      suspicious: '<span class="badge badge-danger">SUSPICIOUS</span>',
      malicious: '<span class="badge badge-danger">THREAT</span>',
      unreachable: '<span class="badge">UNVERIFIED</span>',
      error: '<span class="badge badge-danger">CHECK FAILED</span>',
      timeout: '<span class="badge">TIMED OUT</span>'
    };
    return map[s] || '';
  }

  function scanBadgeSnippet(entry) {
    if (entry.type !== 'url') return '';
    const us = entry.urlscan || { status: 'unchecked' };
    return statusBadgeMap(us.status);
  }

  function historyItemHTML(entry) {
    const meta = TYPE_META[entry.type];
    const badge = scanBadgeSnippet(entry);
    return `
      <button class="history-item" data-id="${entry.id}">
        <div class="history-icon type-${entry.type}">${meta.glyph}</div>
        <div class="history-body">
          <div class="history-title">${escapeHtml(titleFor(entry))}</div>
          <div class="history-meta">
            <span>${meta.label}</span><span class="dot">·</span><span>${timeAgo(entry.timestamp)}</span>
          </div>
        </div>
        ${badge}
        <span class="history-chevron">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </span>
      </button>`;
  }

  function emptyStateHTML(msg) {
    return `<div class="history-empty">${msg}</div>`;
  }

  function renderRecentList() {
    const recent = history.slice(0, 20);
    els.recentList.innerHTML = recent.length
      ? recent.map(historyItemHTML).join('')
      : emptyStateHTML('// NO SCANS YET — TAP THE SCAN BUTTON TO BEGIN');
  }

  let activeFilter = 'all';
  function renderFullList() {
    const filtered = history.filter((e) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'text') return !['url', 'wifi', 'contact'].includes(e.type);
      return e.type === activeFilter;
    });
    els.fullList.innerHTML = filtered.length
      ? filtered.map(historyItemHTML).join('')
      : emptyStateHTML('// NOTHING HERE YET');
  }

  function renderAll() {
    renderStats();
    renderRecentList();
    renderFullList();
  }

  /* =====================================================
     VIEW SWITCHING
     ===================================================== */
  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    document.querySelectorAll('#homeBottomNav .nav-btn').forEach((b) => { b.classList.toggle('active', b.dataset.view === view); });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    if (view === 'history') renderFullList();
  }

  /* =====================================================
     BOTTOM SHEET
     ===================================================== */
  function openSheet(html) {
    els.sheetContent.innerHTML = html;
    els.sheetBackdrop.hidden = false;
    els.bottomSheet.hidden = false;
    els.bottomSheet.style.transform = '';
    requestAnimationFrame(() => { els.bottomSheet.classList.remove('dragging'); });
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    els.sheetBackdrop.hidden = true;
    els.bottomSheet.hidden = true;
    els.bottomSheet.style.transform = '';
    activeSheetEntryId = null;
    sheetIsFresh = false;
    document.body.style.overflow = '';
  }

  // swipe-to-dismiss
  function setupSheetDrag() {
    let startY = 0, currentY = 0, dragging = false;
    const threshold = 90;

    function onStart(e) {
      dragging = true;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      els.bottomSheet.classList.add('dragging');
    }
    function onMove(e) {
      if (!dragging) return;
      currentY = (e.touches ? e.touches[0].clientY : e.clientY);
      const delta = Math.max(0, currentY - startY);
      els.bottomSheet.style.transform = `translateX(-50%) translateY(${delta}px)`;
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      const delta = Math.max(0, currentY - startY);
      els.bottomSheet.classList.remove('dragging');
      if (delta > threshold) {
        els.bottomSheet.style.transform = `translateX(-50%) translateY(100%)`;
        setTimeout(closeSheet, 180);
      } else {
        els.bottomSheet.style.transform = '';
      }
      startY = currentY = 0;
    }

    els.sheetHandleWrap.addEventListener('touchstart', onStart, { passive: true });
    els.sheetHandleWrap.addEventListener('touchmove', onMove, { passive: true });
    els.sheetHandleWrap.addEventListener('touchend', onEnd);
    els.sheetHandleWrap.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  /* =====================================================
     SHEET CONTENT BUILDERS PER TYPE
     ===================================================== */
  let sheetIsFresh = false;
  function buildSheetForEntry(entry, opts = {}) {
    activeSheetEntryId = entry.id;
    if (opts.fresh !== undefined) sheetIsFresh = !!opts.fresh;
    const isFresh = sheetIsFresh;
    let body = '';

    switch (entry.type) {
      case 'url': body = sheetForUrl(entry); break;
      case 'wifi': body = sheetForWifi(entry); break;
      case 'contact': body = sheetForContact(entry); break;
      case 'email': body = sheetForEmail(entry); break;
      case 'phone': body = sheetForPhone(entry); break;
      case 'sms': body = sheetForSms(entry); break;
      case 'geo': body = sheetForGeo(entry); break;
      default: body = sheetForText(entry); break;
    }

    const footer = `
      <div class="row-buttons" style="margin-top:16px;">
        ${isFresh ? `<button class="btn btn-secondary btn-block" id="sheetScanAgainBtn">SCAN ANOTHER</button>` : ''}
        <button class="btn btn-danger-ghost ${isFresh ? '' : 'btn-block'}" id="sheetDeleteBtn">DELETE</button>
      </div>`;

    openSheet(body + footer);
    wireSheetActions(entry);
  }

  function sheetHeader(eyebrow, title) {
    return `<div class="sheet-eyebrow">${eyebrow}</div><div class="sheet-title">${escapeHtml(title)}</div>`;
  }

  function sheetForUrl(entry) {
    const { url, hostname } = entry.parsed;
    return `
      ${sheetHeader('// LINK DETECTED', hostname)}
      <div class="sheet-raw-box">${escapeHtml(url)}</div>
      ${urlscanPreviewHTML(entry)}
      <div id="urlscanBox">${urlscanStatusBoxHTML(entry)}</div>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetOpenBtn">OPEN LINK</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY LINK</button>
      </div>`;
  }

  function urlscanPreviewHTML(entry) {
    const us = entry.urlscan;
    if (!us || !us.screenshotUrl) return '';
    return `
      <div class="site-preview">
        <img src="${escapeHtml(us.screenshotUrl)}" alt="Site preview" loading="lazy">
        <div class="site-preview-label">// SITE PREVIEW · URLSCAN.IO</div>
      </div>`;
  }

  function urlscanStatusBoxHTML(entry) {
    const us = entry.urlscan || { status: 'unchecked' };
    const canCheck = !!getUrlscanKey() || !!getUrlscanProxy();
    if (us.status === 'unchecked') {
      return `<div class="vt-status-box">
        <div class="vt-status-label">Not checked yet<small>${canCheck ? 'Run a security scan with urlscan.io' : 'Add an API key or proxy URL in Settings to enable checks'}</small></div>
        <button class="btn btn-secondary btn-sm" id="urlscanRunBtn" ${canCheck ? '' : 'disabled'}>CHECK</button>
      </div>`;
    }
    if (us.status === 'pending') {
      const pct = Math.max(6, Math.round((us.progress || 0) * 100));
      return `<div class="vt-status-box vt-status-box-pending">
        <div class="vt-status-label"><span class="spinner"></span> &nbsp;${escapeHtml(us.stage || 'Scanning with urlscan.io…')}<small>This usually takes 10–20 seconds</small></div>
        <div class="scan-progress-track"><div class="scan-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
    }
    if (us.status === 'timeout') {
      return `<div class="vt-status-box">
        <div class="vt-status-label" style="color:var(--faint)">Scan is taking longer than expected<small>${escapeHtml(us.message || 'urlscan.io hasn\u2019t returned a result yet.')}</small></div>
        <button class="btn btn-ghost btn-sm" id="urlscanRunBtn">RETRY</button>
      </div>`;
    }
    if (us.status === 'unreachable') {
      return `<div class="vt-status-box">
        <div class="vt-status-label" style="color:var(--faint)">Engine unreachable from this browser<small>${escapeHtml(us.message || 'Try a manual check instead')}</small></div>
        <button class="btn btn-ghost btn-sm" id="urlscanManualBtn">MANUAL CHECK</button>
      </div>`;
    }
    if (us.status === 'error') {
      return `<div class="vt-status-box">
        <div class="vt-status-label" style="color:var(--danger)">urlscan.io returned an error${us.httpStatus ? ` (HTTP ${us.httpStatus})` : ''}<small>${escapeHtml(us.message || 'Something went wrong.')}</small></div>
        <button class="btn btn-ghost btn-sm" id="urlscanRunBtn">RETRY</button>
      </div>`;
    }
    if (us.status === 'clean') {
      return `<div class="vt-status-box">
        <div class="vt-status-label"><span class="badge badge-green">CLEAN</span><small>${us.verdictLabel || 'No malicious indicators found'}</small></div>
        <button class="btn btn-ghost btn-sm" id="urlscanManualBtn">VIEW REPORT</button>
      </div>`;
    }
    if (us.status === 'suspicious' || us.status === 'malicious') {
      return `<div class="vt-status-box">
        <div class="vt-status-label"><span class="badge badge-danger">${us.status === 'malicious' ? 'THREAT DETECTED' : 'SUSPICIOUS'}</span><small>${escapeHtml(us.verdictLabel || 'Flagged by urlscan.io')}</small></div>
        <button class="btn btn-ghost btn-sm" id="urlscanManualBtn">VIEW REPORT</button>
      </div>`;
    }
    return '';
  }

  function sheetForWifi(entry) {
    const p = entry.parsed;
    return `
      ${sheetHeader('// WI-FI NETWORK', p.ssid || 'Unnamed network')}
      <div class="kv-list">
        <div class="kv-row"><span class="kv-key">SSID</span><span class="kv-val">${escapeHtml(p.ssid || '—')}</span></div>
        <div class="kv-row"><span class="kv-key">Security</span><span class="kv-val">${escapeHtml(p.encryption)}</span></div>
        <div class="kv-row"><span class="kv-key">Password</span><span class="kv-val">${p.password ? escapeHtml(p.password) : '—'}</span></div>
        <div class="kv-row"><span class="kv-key">Hidden</span><span class="kv-val">${p.hidden ? 'Yes' : 'No'}</span></div>
      </div>
      <p class="muted-text small-text" style="margin-bottom:14px;">Browsers can't join Wi-Fi networks automatically — copy the password and connect from your device's Wi-Fi settings.</p>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetCopyPassBtn" ${p.password ? '' : 'disabled'}>COPY PASSWORD</button>
        <button class="btn btn-ghost" id="sheetCopySsidBtn">COPY SSID</button>
      </div>`;
  }

  function sheetForContact(entry) {
    const p = entry.parsed;
    const rows = [];
    if (p.org) rows.push(`<div class="kv-row"><span class="kv-key">Org</span><span class="kv-val">${escapeHtml(p.org)}</span></div>`);
    p.phones.forEach((ph, i) => rows.push(`<div class="kv-row"><span class="kv-key">Phone ${p.phones.length > 1 ? i + 1 : ''}</span><span class="kv-val">${escapeHtml(ph)}</span></div>`));
    p.emails.forEach((em, i) => rows.push(`<div class="kv-row"><span class="kv-key">Email ${p.emails.length > 1 ? i + 1 : ''}</span><span class="kv-val">${escapeHtml(em)}</span></div>`));
    p.addresses.forEach((ad) => rows.push(`<div class="kv-row"><span class="kv-key">Address</span><span class="kv-val">${escapeHtml(ad)}</span></div>`));
    return `
      ${sheetHeader('// CONTACT CARD', p.name || 'Unknown contact')}
      <div class="kv-list">${rows.join('') || '<div class="muted-text small-text">No additional details found.</div>'}</div>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetSaveContactBtn">SAVE CONTACT</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY DETAILS</button>
      </div>`;
  }

  function sheetForEmail(entry) {
    const p = entry.parsed;
    return `
      ${sheetHeader('// EMAIL ADDRESS', p.address || 'Email')}
      <div class="kv-list">
        ${p.subject ? `<div class="kv-row"><span class="kv-key">Subject</span><span class="kv-val">${escapeHtml(p.subject)}</span></div>` : ''}
        ${p.body ? `<div class="kv-row"><span class="kv-key">Body</span><span class="kv-val">${escapeHtml(p.body)}</span></div>` : ''}
      </div>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetOpenBtn">COMPOSE EMAIL</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY ADDRESS</button>
      </div>`;
  }

  function sheetForPhone(entry) {
    return `
      ${sheetHeader('// PHONE NUMBER', entry.parsed.number)}
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetOpenBtn">CALL</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY NUMBER</button>
      </div>`;
  }

  function sheetForSms(entry) {
    const p = entry.parsed;
    return `
      ${sheetHeader('// TEXT MESSAGE', p.number || 'Unknown number')}
      ${p.body ? `<div class="sheet-raw-box">${escapeHtml(p.body)}</div>` : ''}
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetOpenBtn">OPEN MESSAGES</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY NUMBER</button>
      </div>`;
  }

  function sheetForGeo(entry) {
    const p = entry.parsed;
    return `
      ${sheetHeader('// LOCATION', `${p.lat}, ${p.lng}`)}
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetOpenBtn">OPEN IN MAPS</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY COORDINATES</button>
      </div>`;
  }

  function sheetForText(entry) {
    return `
      ${sheetHeader('// PLAIN TEXT', entry.raw.length > 40 ? entry.raw.slice(0, 40) + '…' : entry.raw)}
      <div class="sheet-raw-box">${escapeHtml(entry.raw)}</div>
      <div class="sheet-actions single">
        <button class="btn btn-primary" id="sheetCopyBtn">COPY TEXT</button>
      </div>`;
  }

  function wireSheetActions(entry) {
    const byId = (id) => els.sheetContent.querySelector('#' + id) || document.getElementById(id);

    const openBtn = byId('sheetOpenBtn');
    if (openBtn) openBtn.addEventListener('click', () => performOpenAction(entry));

    const copyBtn = byId('sheetCopyBtn');
    if (copyBtn) copyBtn.addEventListener('click', () => performCopyAction(entry));

    const copyPassBtn = byId('sheetCopyPassBtn');
    if (copyPassBtn) copyPassBtn.addEventListener('click', () => copyToClipboard(entry.parsed.password, 'PASSWORD COPIED'));

    const copySsidBtn = byId('sheetCopySsidBtn');
    if (copySsidBtn) copySsidBtn.addEventListener('click', () => copyToClipboard(entry.parsed.ssid, 'SSID COPIED'));

    const saveContactBtn = byId('sheetSaveContactBtn');
    if (saveContactBtn) saveContactBtn.addEventListener('click', () => saveContactAsVcf(entry));

    const deleteBtn = byId('sheetDeleteBtn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => {
      deleteHistoryEntry(entry.id);
      closeSheet();
      toast('SCAN DELETED');
    });

    const scanAgainBtn = byId('sheetScanAgainBtn');
    if (scanAgainBtn) scanAgainBtn.addEventListener('click', () => {
      closeSheet();
      openScanner();
    });

    const urlscanRunBtn = byId('urlscanRunBtn');
    if (urlscanRunBtn) urlscanRunBtn.addEventListener('click', () => runUrlscanScan(entry));

    const urlscanManualBtn = byId('urlscanManualBtn');
    if (urlscanManualBtn) urlscanManualBtn.addEventListener('click', () => {
      if (entry.urlscan && entry.urlscan.reportUrl) {
        window.open(entry.urlscan.reportUrl, '_blank', 'noopener,noreferrer');
      } else {
        let hostname = entry.parsed.hostname;
        try { hostname = new URL(entry.parsed.url).hostname; } catch (e) {}
        window.open('https://urlscan.io/search/?q=' + encodeURIComponent('domain:' + hostname), '_blank', 'noopener,noreferrer');
      }
    });
  }

  function performOpenAction(entry) {
    switch (entry.type) {
      case 'url':
        if (/^https?:\/\//i.test(entry.parsed.url)) {
          window.open(entry.parsed.url, '_blank', 'noopener,noreferrer');
        }
        break;
      case 'email': {
        const params = new URLSearchParams();
        if (entry.parsed.subject) params.set('subject', entry.parsed.subject);
        if (entry.parsed.body) params.set('body', entry.parsed.body);
        const qs = params.toString();
        window.location.href = `mailto:${entry.parsed.address}${qs ? '?' + qs : ''}`;
        break;
      }
      case 'phone':
        window.location.href = `tel:${entry.parsed.number}`;
        break;
      case 'sms':
        window.location.href = `sms:${entry.parsed.number}${entry.parsed.body ? '?body=' + encodeURIComponent(entry.parsed.body) : ''}`;
        break;
      case 'geo':
        window.open(`https://www.google.com/maps/search/?api=1&query=${entry.parsed.lat},${entry.parsed.lng}`, '_blank', 'noopener,noreferrer');
        break;
    }
  }

  function performCopyAction(entry) {
    switch (entry.type) {
      case 'url': copyToClipboard(entry.parsed.url, 'LINK COPIED'); break;
      case 'contact': {
        const p = entry.parsed;
        const lines = [p.name, p.org, ...p.phones, ...p.emails, ...p.addresses].filter(Boolean);
        copyToClipboard(lines.join('\n'), 'DETAILS COPIED');
        break;
      }
      case 'email': copyToClipboard(entry.parsed.address, 'ADDRESS COPIED'); break;
      case 'phone': copyToClipboard(entry.parsed.number, 'NUMBER COPIED'); break;
      case 'sms': copyToClipboard(entry.parsed.number, 'NUMBER COPIED'); break;
      case 'geo': copyToClipboard(`${entry.parsed.lat}, ${entry.parsed.lng}`, 'COORDINATES COPIED'); break;
      default: copyToClipboard(entry.raw, 'TEXT COPIED'); break;
    }
  }

  function saveContactAsVcf(entry) {
    const p = entry.parsed;
    let vcf;
    if (p.source === 'vcard') {
      vcf = entry.raw;
    } else {
      vcf = ['BEGIN:VCARD', 'VERSION:3.0',
        `FN:${p.name || 'Unknown'}`,
        p.org ? `ORG:${p.org}` : '',
        ...p.phones.map((ph) => `TEL:${ph}`),
        ...p.emails.map((em) => `EMAIL:${em}`),
        ...p.addresses.map((ad) => `ADR:;;${ad};;;;`),
        'END:VCARD'
      ].filter(Boolean).join('\n');
    }
    const blob = new Blob([vcf], { type: 'text/vcard' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(p.name || 'contact').replace(/[^a-z0-9]+/gi, '_')}.vcf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('CONTACT FILE SAVED');
  }

  /* =====================================================
     URLSCAN.IO INTEGRATION
     ===================================================== */
  class UrlscanApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'UrlscanApiError';
      this.status = status;
    }
  }

  async function runUrlscanScan(entry) {
    const proxy = getUrlscanProxy();
    const key = getUrlscanKey();
    if (!proxy && !key) { toast('ADD A URLSCAN.IO API KEY IN SETTINGS', 'error'); return; }
    const visibility = getUrlscanVisibility();

    entry.urlscan = { status: 'pending', stage: 'Submitting URL to urlscan.io…' };
    persistHistory();
    refreshUrlscanUI(entry);

    // When a proxy is configured, calls go through it instead of directly to
    // urlscan.io — the proxy holds the key server-side and adds the CORS
    // headers urlscan.io's own API doesn't send on real (non-preflight)
    // responses. Without a proxy, we call urlscan.io directly, which may hit
    // that CORS gap and surface as a network error below.
    const submitUrl = proxy ? `${proxy}/scan` : 'https://urlscan.io/api/v1/scan/';
    const submitHeaders = proxy
      ? { 'content-type': 'application/json' }
      : { 'content-type': 'application/json', 'API-Key': key };

    try {
      let submitRes;
      try {
        submitRes = await fetch(submitUrl, {
          method: 'POST',
          headers: submitHeaders,
          body: JSON.stringify({ url: entry.parsed.url, visibility })
        });
      } catch (networkErr) {
        // fetch() itself throwing (TypeError) means the request never got a
        // response at all — DNS failure, offline, CORS block, etc.
        throw new UrlscanApiError('Network request failed — check your connection or try again.', null);
      }

      if (!submitRes.ok) {
        // We DID get a real response — this is an API error, not a network
        // failure. Surface the server's actual reason.
        const errJson = await submitRes.json().catch(() => ({}));
        const reason = errJson.message || errJson.description || errJson.error;
        if (submitRes.status === 401 || submitRes.status === 403) {
          throw new UrlscanApiError(reason || 'API key was rejected — check it in Settings.', submitRes.status);
        }
        if (submitRes.status === 429) {
          throw new UrlscanApiError(reason || 'Rate limit or quota exceeded — try again later.', submitRes.status);
        }
        if (submitRes.status === 400) {
          throw new UrlscanApiError(reason || 'This URL was rejected by urlscan.io (blocked, malformed, or on a blocklist).', submitRes.status);
        }
        throw new UrlscanApiError(reason || `urlscan.io returned an error (HTTP ${submitRes.status}).`, submitRes.status);
      }

      const submitJson = await submitRes.json();
      const uuid = submitJson.uuid;
      const reportUrl = submitJson.result || `https://urlscan.io/result/${uuid}/`;

      const POLL_ATTEMPTS = 8;
      let resultJson = null;
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        entry.urlscan = {
          status: 'pending',
          stage: `Waiting for urlscan.io to finish analyzing… (${attempt + 1}/${POLL_ATTEMPTS})`,
          progress: (attempt + 1) / POLL_ATTEMPTS,
          reportUrl, uuid
        };
        refreshUrlscanUI(entry);
        await sleep(3000);

        const resultUrl = proxy ? `${proxy}/result/${uuid}` : `https://urlscan.io/api/v1/result/${uuid}/`;
        const resultHeaders = proxy ? {} : { 'API-Key': key };
        let resRes;
        try {
          resRes = await fetch(resultUrl, { headers: resultHeaders });
        } catch (networkErr) {
          throw new UrlscanApiError('Lost connection while waiting for results.', null);
        }
        if (resRes.status === 404) continue; // not ready yet
        if (!resRes.ok) throw new UrlscanApiError(`urlscan.io returned an error while polling (HTTP ${resRes.status}).`, resRes.status);
        resultJson = await resRes.json();
        break;
      }

      if (!resultJson) {
        // urlscan.io didn't finish within our polling window. This is not
        // the same as "still checking forever" — surface it as a distinct,
        // actionable state with a retry, rather than leaving the spinner
        // running with no way out.
        entry.urlscan = {
          status: 'timeout',
          message: 'urlscan.io is taking longer than usual to finish this scan.',
          reportUrl, uuid
        };
      } else {
        const verdicts = resultJson.verdicts || {};
        const overall = verdicts.overall || {};
        const malicious = !!overall.malicious;
        const score = overall.score || 0;
        let status = 'clean';
        if (malicious) status = 'malicious';
        else if (score > 0) status = 'suspicious';

        const screenshotUrl = resultJson.task && resultJson.task.screenshotURL
          ? resultJson.task.screenshotURL
          : (uuid ? `https://urlscan.io/screenshots/${uuid}.png` : null);

        const categories = (overall.categories || []).join(', ');
        const verdictLabel = malicious
          ? (categories || 'Malicious indicators found')
          : score > 0
            ? (categories || `Risk score ${score}`)
            : 'No malicious indicators found';

        entry.urlscan = {
          status, verdictLabel, screenshotUrl, reportUrl, uuid,
          score, checkedAt: Date.now()
        };
      }
    } catch (err) {
      if (err instanceof UrlscanApiError && err.status) {
        // A real HTTP response came back — this is an API-level error, not
        // a network/CORS failure, so label and style it accordingly.
        entry.urlscan = { status: 'error', message: err.message, httpStatus: err.status };
      } else {
        entry.urlscan = {
          status: 'unreachable',
          message: err && err.message ? String(err.message) : 'Could not reach urlscan.io from this browser.'
        };
      }
    }

    persistHistory();
    refreshUrlscanUI(entry);
    renderAll();
  }

  function refreshUrlscanUI(entry) {
    if (activeSheetEntryId !== entry.id) return;
    // While still polling, only the status box changes (no screenshot yet),
    // so update it in place instead of rebuilding the whole sheet — that
    // keeps the progress bar smooth instead of flashing/resetting scroll
    // on every 3-second poll tick.
    const box = els.sheetContent && els.sheetContent.querySelector('#urlscanBox');
    if (entry.urlscan && entry.urlscan.status === 'pending' && box) {
      box.innerHTML = urlscanStatusBoxHTML(entry);
      wireSheetActions(entry);
    } else {
      buildSheetForEntry(entry);
    }
  }

  /* =====================================================
     CAMERA / SCANNING
     ===================================================== */
  async function openScanner() {
    els.scannerOverlay.hidden = false;
    scanningPaused = false;
    setHint('// STARTING CAMERA…');
    els.scannerEmpty.hidden = true;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      els.video.srcObject = mediaStream;
      await els.video.play();
      setHint('// POINT CAMERA AT A CODE');
      setupTorchButton();
      startDetectionLoop();
      updateCameraBadge('// ACTIVE');
    } catch (err) {
      els.scannerEmpty.hidden = false;
      $('scannerEmptyDetail').textContent = err && err.name === 'NotAllowedError'
        ? 'Camera permission was denied. Enable it in your browser settings, or paste content manually below.'
        : 'No camera could be reached. You can still paste content manually below.';
      setHint('');
      updateCameraBadge('// DENIED');
    }
  }

  function setupTorchButton() {
    // Always show the flash button — greying it out when unsupported is more
    // stable than hiding it, since torch capability detection can flicker
    // across devices/browsers and hiding it reflows the 3-button nav island.
    els.torchBtn.hidden = false;
    els.torchBtn.classList.remove('active');
    els.torchBtn.onclick = null;

    let track = null;
    let caps = {};
    try {
      track = mediaStream.getVideoTracks()[0];
      caps = (track && track.getCapabilities) ? track.getCapabilities() : {};
    } catch (e) {
      track = null;
    }

    if (track && caps.torch) {
      els.torchBtn.disabled = false;
      torchOn = false;
      els.torchBtn.onclick = async () => {
        torchOn = !torchOn;
        try {
          await track.applyConstraints({ advanced: [{ torch: torchOn }] });
          els.torchBtn.classList.toggle('active', torchOn);
        } catch (e) {
          // Constraint application failed (e.g. torch was revoked mid-session) —
          // reflect that the toggle didn't actually take effect.
          torchOn = !torchOn;
        }
      };
    } else {
      els.torchBtn.disabled = true;
    }
  }

  function setHint(text, cls) {
    els.scannerHint.textContent = text;
    els.scannerHint.className = 'scanner-hint' + (cls ? ' ' + cls : '');
  }

  function closeScanner() {
    scanningPaused = true;
    if (detectionRAF) cancelAnimationFrame(detectionRAF);
    detectionRAF = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    els.scannerOverlay.hidden = true;
    els.torchBtn.disabled = true;
    els.torchBtn.classList.remove('active');
    els.torchBtn.onclick = null;
  }

  function startDetectionLoop() {
    const canUseNativeDetector = 'BarcodeDetector' in window;
    if (canUseNativeDetector && !barcodeDetectorInstance) {
      try {
        barcodeDetectorInstance = new window.BarcodeDetector({
          formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'pdf417', 'aztec', 'data_matrix']
        });
        usingJsQR = false;
      } catch (e) {
        barcodeDetectorInstance = null;
      }
    }
    if (!barcodeDetectorInstance) usingJsQR = true;
    updateDetectorBadge();

    const canvas = els.canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function tick() {
      if (scanningPaused) return;
      if (els.video.readyState === els.video.HAVE_ENOUGH_DATA) {
        try {
          if (!usingJsQR && barcodeDetectorInstance) {
            const codes = await barcodeDetectorInstance.detect(els.video);
            if (codes && codes.length) {
              onCodeDetected(codes[0].rawValue);
              return;
            }
          } else if (window.jsQR) {
            canvas.width = els.video.videoWidth;
            canvas.height = els.video.videoHeight;
            ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
            if (code && code.data) {
              onCodeDetected(code.data);
              return;
            }
          }
        } catch (e) {
          // detection hiccup, keep looping
        }
      }
      detectionRAF = requestAnimationFrame(tick);
    }
    detectionRAF = requestAnimationFrame(tick);
  }

  function onCodeDetected(raw) {
    scanningPaused = true;
    if (detectionRAF) cancelAnimationFrame(detectionRAF);
    if (navigator.vibrate) navigator.vibrate(60);
    setHint('// CODE DETECTED', 'success');

    const entry = addHistoryEntry(raw);
    renderAll();
    closeScanner();
    buildSheetForEntry(entry, { fresh: true });

    if (entry.type === 'url' && (getUrlscanKey() || getUrlscanProxy())) {
      runUrlscanScan(entry);
    }
  }

  function updateDetectorBadge() {
    if (!els.detectorApiBadge) return;
    els.detectorApiBadge.textContent = usingJsQR ? '// JSQR FALLBACK' : '// BARCODEDETECTOR';
    els.detectorApiBadge.className = 'badge ' + (usingJsQR ? 'badge-cyan' : 'badge-green');
  }

  function updateCameraBadge(text) {
    if (!els.cameraApiBadge) return;
    els.cameraApiBadge.textContent = text;
    els.cameraApiBadge.className = 'badge ' + (text.includes('ACTIVE') ? 'badge-green' : text.includes('DENIED') ? 'badge-danger' : '');
  }

  /* =====================================================
     MANUAL ENTRY
     ===================================================== */
  function openManualEntry() {
    closeScanner();
    openSheet(`
      <div class="sheet-eyebrow">// MANUAL ENTRY</div>
      <div class="sheet-title">Paste content to analyze</div>
      <textarea class="text-input" id="manualText" placeholder="Paste a URL, Wi-Fi string, vCard, or any text…" rows="5"></textarea>
      <div class="sheet-actions single" style="margin-top:14px;">
        <button class="btn btn-primary" id="manualAnalyzeBtn">ANALYZE</button>
      </div>
    `);
    setTimeout(() => $('manualText') && $('manualText').focus(), 150);
    $('manualAnalyzeBtn') && ($('manualAnalyzeBtn').onclick = () => {
      const val = ($('manualText').value || '').trim();
      if (!val) { toast('NOTHING TO ANALYZE', 'error'); return; }
      closeSheet();
      onCodeDetected(val);
    });
  }

  /* =====================================================
     SETTINGS
     ===================================================== */
  function initSettings() {
    $('urlscanApiKey').value = getUrlscanKey();
    updateUrlscanKeyStatus();

    $('saveUrlscanKey').addEventListener('click', () => {
      const val = $('urlscanApiKey').value.trim();
      if (!val) { toast('ENTER A KEY FIRST', 'error'); return; }
      setUrlscanKeyStorage(val);
      updateUrlscanKeyStatus();
      toast('API KEY SAVED');
    });

    $('clearUrlscanKey').addEventListener('click', () => {
      clearUrlscanKeyStorage();
      $('urlscanApiKey').value = '';
      updateUrlscanKeyStatus();
      toast('API KEY CLEARED');
    });

    $('urlscanProxyUrl').value = getUrlscanProxy();
    updateUrlscanProxyStatus();

    $('saveUrlscanProxy').addEventListener('click', () => {
      const val = $('urlscanProxyUrl').value.trim();
      if (!val) { toast('ENTER A PROXY URL FIRST', 'error'); return; }
      if (!/^https?:\/\//i.test(val)) { toast('PROXY URL MUST START WITH HTTPS://', 'error'); return; }
      setUrlscanProxy(val);
      $('urlscanProxyUrl').value = getUrlscanProxy();
      updateUrlscanProxyStatus();
      toast('PROXY URL SAVED');
    });

    $('clearUrlscanProxy').addEventListener('click', () => {
      clearUrlscanProxy();
      $('urlscanProxyUrl').value = '';
      updateUrlscanProxyStatus();
      toast('PROXY URL CLEARED');
    });

    initUrlscanVisibility();

    $('clearHistoryBtn').addEventListener('click', () => {
      if (!history.length) return;
      if (confirm('Delete all scan history? This can\'t be undone.')) {
        clearAllHistory();
        toast('HISTORY CLEARED');
      }
    });

    $('exportHistoryBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scanr-history-export.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('EXPORT DOWNLOADED');
    });

    $('wipeAllBtn').addEventListener('click', () => {
      if (confirm('Wipe all local data — history and API keys? This can\'t be undone.')) {
        clearAllHistory();
        clearUrlscanKeyStorage();
        clearUrlscanProxy();
        $('urlscanApiKey').value = '';
        $('urlscanProxyUrl').value = '';
        updateUrlscanKeyStatus();
        updateUrlscanProxyStatus();
        toast('ALL DATA WIPED');
      }
    });
  }

  function initUrlscanVisibility() {
    const chips = $('urlscanVisibilityChips');
    if (!chips) return;
    const applyActive = (v) => {
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.visibility === v));
    };
    applyActive(getUrlscanVisibility());
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-visibility]');
      if (!chip) return;
      setUrlscanVisibility(chip.dataset.visibility);
      applyActive(chip.dataset.visibility);
    });
  }

  function updateUrlscanKeyStatus() {
    const key = getUrlscanKey();
    const el = $('urlscanKeyStatus');
    if (!el) return;
    if (key) {
      el.textContent = '// KEY SAVED · ' + '•'.repeat(Math.min(key.length, 8));
      el.className = 'badge badge-green';
    } else {
      el.textContent = '// NO KEY SET';
      el.className = 'badge';
    }
  }

  function updateUrlscanProxyStatus() {
    const proxy = getUrlscanProxy();
    const el = $('urlscanProxyStatus');
    if (!el) return;
    if (proxy) {
      let host = proxy;
      try { host = new URL(proxy).hostname; } catch (e) {}
      el.textContent = '// PROXY ACTIVE · ' + host;
      el.title = proxy;
      el.className = 'badge badge-green';
    } else {
      el.textContent = '// NO PROXY SET';
      el.removeAttribute('title');
      el.className = 'badge';
    }
  }

  /* =====================================================
     PWA INSTALL + SERVICE WORKER
     ===================================================== */
  function initPwa() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const btn = $('installBtn');
      if (btn) btn.disabled = false;
    });

    const installBtn = $('installBtn');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') toast('APP INSTALLED');
        deferredInstallPrompt = null;
        installBtn.disabled = true;
      });
    }

    window.addEventListener('appinstalled', () => {
      toast('APP INSTALLED');
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {
          const badge = $('offlineBadge');
          if (badge) { badge.textContent = '// UNAVAILABLE'; badge.className = 'badge'; }
        });
      });
    } else {
      const badge = $('offlineBadge');
      if (badge) { badge.textContent = '// UNSUPPORTED'; badge.className = 'badge'; }
    }
  }

  /* =====================================================
     WIRE UP GLOBAL UI
     ===================================================== */
  function cacheEls() {
    [
      'statTotal', 'statLinks', 'statFlagged', 'recentList', 'fullList', 'viewAllBtn',
      'heroScanBtn', 'heroPasteBtn', 'clearHistoryBtn', 'filterChips',
      'scannerOverlay', 'video', 'canvas', 'scannerHint', 'scannerEmpty', 'torchBtn',
      'closeScannerBtn', 'manualEntryBtn',
      'sheetBackdrop', 'bottomSheet', 'sheetContent', 'sheetHandleWrap',
      'toast', 'scanFab', 'headerSettingsBtn', 'statusPill',
      'detectorApiBadge', 'cameraApiBadge'
    ].forEach((id) => { els[id] = $(id); });
  }

  function initNav() {
    document.querySelectorAll('#homeBottomNav .nav-btn[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    els.viewAllBtn.addEventListener('click', () => switchView('history'));
    els.headerSettingsBtn.addEventListener('click', () => switchView('settings'));

    els.filterChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      activeFilter = chip.dataset.filter;
      els.filterChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderFullList();
    });

    document.querySelectorAll('.history-list').forEach((list) => {
      list.addEventListener('click', (e) => {
        const item = e.target.closest('.history-item');
        if (!item) return;
        const entry = history.find((h) => h.id === item.dataset.id);
        if (entry) buildSheetForEntry(entry);
      });
    });
  }

  function initScanner() {
    els.scanFab.addEventListener('click', openScanner);
    els.heroScanBtn.addEventListener('click', openScanner);
    els.heroPasteBtn.addEventListener('click', openManualEntry);
    els.closeScannerBtn.addEventListener('click', () => {
      closeScanner();
      switchView('home');
    });
    els.manualEntryBtn.addEventListener('click', openManualEntry);
  }

  /* =====================================================
     INIT
     ===================================================== */
  function init() {
    cacheEls();
    loadHistory();
    initNav();
    initScanner();
    initSettings();
    initPwa();
    setupSheetDrag();
    els.sheetBackdrop.addEventListener('click', closeSheet);
    renderAll();
    switchView('home');

    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'scan') {
      setTimeout(openScanner, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
