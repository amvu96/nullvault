(() => {
  'use strict';

  /* =====================================================
     CONSTANTS / STATE
     ===================================================== */
  const HISTORY_KEY = 'scanr_history_v1';
  const VT_KEY_STORAGE = 'scanr_vt_api_key_v1';
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
  }

  function persistHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
    } catch (e) {
      toast('STORAGE FULL — COULD NOT SAVE', 'error');
    }
  }

  function getVtKey() {
    return localStorage.getItem(VT_KEY_STORAGE) || '';
  }
  function setVtKeyStorage(key) {
    localStorage.setItem(VT_KEY_STORAGE, key);
  }
  function clearVtKeyStorage() {
    localStorage.removeItem(VT_KEY_STORAGE);
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
      vt: type === 'url' ? { status: 'unchecked' } : null
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
    const flagged = history.filter((e) => e.vt && (e.vt.status === 'malicious' || e.vt.status === 'suspicious')).length;
    els.statTotal.textContent = total;
    els.statLinks.textContent = links;
    els.statFlagged.textContent = flagged;
  }

  /* =====================================================
     RENDER: HISTORY LISTS
     ===================================================== */
  function vtBadgeSnippet(entry) {
    if (entry.type !== 'url' || !entry.vt) return '';
    const s = entry.vt.status;
    const map = {
      unchecked: '',
      pending: '<span class="badge"><span class="spinner"></span>CHECKING</span>',
      clean: '<span class="badge badge-green">CLEAN</span>',
      suspicious: '<span class="badge badge-danger">SUSPICIOUS</span>',
      malicious: '<span class="badge badge-danger">THREAT</span>',
      unreachable: '<span class="badge">UNVERIFIED</span>'
    };
    return map[s] || '';
  }

  function historyItemHTML(entry) {
    const meta = TYPE_META[entry.type];
    const badge = vtBadgeSnippet(entry);
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
    const recent = history.slice(0, 5);
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
    document.querySelectorAll('.nav-btn').forEach((b) => { b.classList.toggle('active', b.dataset.view === view); });
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
  function buildSheetForEntry(entry, opts = {}) {
    activeSheetEntryId = entry.id;
    const isFresh = !!opts.fresh;
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
      <div id="vtBox">${vtStatusBoxHTML(entry)}</div>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="sheetOpenBtn">OPEN LINK</button>
        <button class="btn btn-ghost" id="sheetCopyBtn">COPY LINK</button>
      </div>`;
  }

  function vtStatusBoxHTML(entry) {
    const vt = entry.vt || { status: 'unchecked' };
    const hasKey = !!getVtKey();
    if (vt.status === 'unchecked') {
      return `<div class="vt-status-box">
        <div class="vt-status-label">Not checked yet<small>${hasKey ? 'Run a security check against VirusTotal' : 'Add an API key in Settings to enable checks'}</small></div>
        <button class="btn btn-secondary btn-sm" id="vtRunBtn" ${hasKey ? '' : 'disabled'}>CHECK</button>
      </div>`;
    }
    if (vt.status === 'pending') {
      return `<div class="vt-status-box">
        <div class="vt-status-label"><span class="spinner"></span> &nbsp;Scanning with VirusTotal…<small>This usually takes a few seconds</small></div>
      </div>`;
    }
    if (vt.status === 'unreachable') {
      return `<div class="vt-status-box">
        <div class="vt-status-label" style="color:var(--faint)">Engine unreachable from this browser<small>${escapeHtml(vt.message || 'Try a manual check instead')}</small></div>
        <button class="btn btn-ghost btn-sm" id="vtManualBtn">MANUAL CHECK</button>
      </div>`;
    }
    if (vt.status === 'clean') {
      const s = vt.stats || {};
      return `<div class="vt-status-box">
        <div class="vt-status-label"><span class="badge badge-green">CLEAN</span><small>${s.harmless || 0} engines reported no threats</small></div>
        <button class="btn btn-ghost btn-sm" id="vtRunBtn">RE-CHECK</button>
      </div>`;
    }
    if (vt.status === 'suspicious' || vt.status === 'malicious') {
      const s = vt.stats || {};
      const n = (s.malicious || 0) + (s.suspicious || 0);
      return `<div class="vt-status-box">
        <div class="vt-status-label"><span class="badge badge-danger">${vt.status === 'malicious' ? 'THREAT DETECTED' : 'SUSPICIOUS'}</span><small>${n} of ${(s.malicious||0)+(s.suspicious||0)+(s.harmless||0)+(s.undetected||0)} engines flagged this link</small></div>
        <button class="btn btn-ghost btn-sm" id="vtManualBtn">VIEW REPORT</button>
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

    const vtRunBtn = byId('vtRunBtn');
    if (vtRunBtn) vtRunBtn.addEventListener('click', () => runVtScan(entry));

    const vtManualBtn = byId('vtManualBtn');
    if (vtManualBtn) vtManualBtn.addEventListener('click', () => {
      window.open('https://www.virustotal.com/gui/search/' + encodeURIComponent(entry.parsed.url), '_blank', 'noopener,noreferrer');
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
     VIRUSTOTAL INTEGRATION
     ===================================================== */
  async function runVtScan(entry) {
    const key = getVtKey();
    if (!key) { toast('ADD A VIRUSTOTAL API KEY IN SETTINGS', 'error'); return; }

    entry.vt = { status: 'pending' };
    persistHistory();
    refreshVtUI(entry);

    try {
      const submitRes = await fetch('https://www.virustotal.com/api/v3/urls', {
        method: 'POST',
        headers: { 'x-apikey': key, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'url=' + encodeURIComponent(entry.parsed.url)
      });
      if (!submitRes.ok) throw new Error('submit_' + submitRes.status);
      const submitJson = await submitRes.json();
      const analysisId = submitJson.data.id;

      let result = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(2500);
        const anRes = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
          headers: { 'x-apikey': key }
        });
        if (!anRes.ok) throw new Error('poll_' + anRes.status);
        const anJson = await anRes.json();
        if (anJson.data.attributes.status === 'completed') {
          result = anJson.data.attributes.stats;
          break;
        }
      }

      if (!result) {
        entry.vt = { status: 'pending', message: 'Still analyzing — check back soon.' };
      } else {
        const malicious = result.malicious || 0;
        const suspicious = result.suspicious || 0;
        let status = 'clean';
        if (malicious > 0) status = 'malicious';
        else if (suspicious > 0) status = 'suspicious';
        entry.vt = { status, stats: result, checkedAt: Date.now() };
      }
    } catch (err) {
      entry.vt = {
        status: 'unreachable',
        message: 'Could not reach VirusTotal from this browser (often blocked by CORS). Use the manual check link instead.'
      };
    }

    persistHistory();
    refreshVtUI(entry);
    renderAll();
  }

  function refreshVtUI(entry) {
    if (activeSheetEntryId === entry.id) {
      const box = els.sheetContent.querySelector('#vtBox');
      if (box) {
        box.innerHTML = vtStatusBoxHTML(entry);
        wireSheetActions(entry);
      }
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
    try {
      const track = mediaStream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        els.torchBtn.hidden = false;
        torchOn = false;
        els.torchBtn.onclick = async () => {
          torchOn = !torchOn;
          try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) {}
        };
      } else {
        els.torchBtn.hidden = true;
      }
    } catch (e) {
      els.torchBtn.hidden = true;
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
    els.torchBtn.hidden = true;
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

    if (entry.type === 'url' && getVtKey()) {
      runVtScan(entry);
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
    const key = getVtKey();
    $('vtApiKey').value = key;
    updateVtKeyStatus();

    $('saveVtKey').addEventListener('click', () => {
      const val = $('vtApiKey').value.trim();
      if (!val) { toast('ENTER A KEY FIRST', 'error'); return; }
      setVtKeyStorage(val);
      updateVtKeyStatus();
      toast('API KEY SAVED');
    });

    $('clearVtKey').addEventListener('click', () => {
      clearVtKeyStorage();
      $('vtApiKey').value = '';
      updateVtKeyStatus();
      toast('API KEY CLEARED');
    });

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
      if (confirm('Wipe all local data — history and API key? This can\'t be undone.')) {
        clearAllHistory();
        clearVtKeyStorage();
        $('vtApiKey').value = '';
        updateVtKeyStatus();
        toast('ALL DATA WIPED');
      }
    });
  }

  function updateVtKeyStatus() {
    const key = getVtKey();
    els.vtKeyStatus = $('vtKeyStatus');
    if (key) {
      els.vtKeyStatus.textContent = '// KEY SAVED · ' + '•'.repeat(Math.min(key.length, 8));
      els.vtKeyStatus.className = 'badge badge-green';
    } else {
      els.vtKeyStatus.textContent = '// NO KEY SET';
      els.vtKeyStatus.className = 'badge';
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
      'heroScanBtn', 'clearHistoryBtn', 'filterChips',
      'scannerOverlay', 'video', 'canvas', 'scannerHint', 'scannerEmpty', 'torchBtn',
      'closeScannerBtn', 'manualEntryBtn',
      'sheetBackdrop', 'bottomSheet', 'sheetContent', 'sheetHandleWrap',
      'toast', 'scanFab', 'headerSettingsBtn', 'statusPill',
      'detectorApiBadge', 'cameraApiBadge'
    ].forEach((id) => { els[id] = $(id); });
  }

  function initNav() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
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
    els.closeScannerBtn.addEventListener('click', closeScanner);
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
