/* =========================================================================
   LEDGER — UI rendering & interaction layer
   ========================================================================= */
(function(){
"use strict";

const STATE = window.LEDGER_STATE;
const CATEGORIES = window.LEDGER_CATEGORIES;
const CAT_MAP = window.LEDGER_CAT_MAP;
const { fmtDate, fmtMoney, fmtMonthKey, fmtMonthLabel, guessCategory, escapeHtml, normMerchant } = window.LEDGER_HELPERS;
const { detectAnomalies, detectRecurring, computeStats, computeCategoryBreakdown, computeMonthlyFlow, computeBalanceSeries, generateInsights } = window.LEDGER_ANALYTICS;
const { handleFiles } = window.LEDGER_INGEST;

let ANOMALIES = [];
let RECURRING = [];

/* ---------------------------------------------------------------------
   BOOTSTRAP / FILE INPUT WIRING
--------------------------------------------------------------------- */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');

browseBtn.addEventListener('click', ()=>fileInput.click());
dropzone.addEventListener('click', (e)=>{ if (e.target===dropzone || dropzone.contains(e.target)) { if(e.target.tagName!=='BUTTON') fileInput.click(); } });
fileInput.addEventListener('change', (e)=> handleFiles(e.target.files));

['dragenter','dragover'].forEach(evt=>{
  dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.add('drag'); });
});
['dragleave','drop'].forEach(evt=>{
  dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.remove('drag'); });
});
dropzone.addEventListener('drop', (e)=>{
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

document.getElementById('addMoreBtn').addEventListener('click', ()=>fileInput.click());
document.getElementById('resetBtn').addEventListener('click', ()=>{
  if (!confirm('Clear all loaded statements and notes? This cannot be undone.')) return;
  location.reload();
});

/* ---------------------------------------------------------------------
   LAUNCH: called once transactions exist
--------------------------------------------------------------------- */
window.launchApp = function(){
  // assign categories
  STATE.transactions.forEach(t=>{ t.category = guessCategory(t); });

  ANOMALIES = detectAnomalies(STATE.transactions);
  RECURRING = detectRecurring(STATE.transactions);
  ANOMALIES.forEach(a=> a.tx.isAnomaly = true);
  const anomalyById = {};
  ANOMALIES.forEach(a=> anomalyById[a.tx.id] = a);
  STATE.anomalyById = anomalyById;

  document.getElementById('landing').style.display = 'none';
  document.getElementById('app').classList.add('active');
  document.getElementById('topActions').style.display = 'flex';
  document.getElementById('topbarSub').textContent = STATE.sources.length + ' STATEMENT' + (STATE.sources.length>1?'S':'') + ' LOADED';
  document.getElementById('txCountPill').textContent = STATE.transactions.length + ' transactions';

  populateFilterOptions();
  renderAll();
};

function populateFilterOptions(){
  const catSel = document.getElementById('categoryFilter');
  const usedCats = [...new Set(STATE.transactions.map(t=>t.category))];
  CATEGORIES.filter(c=>usedCats.includes(c.key)).forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c.key; opt.textContent = c.icon + ' ' + c.label;
    catSel.appendChild(opt);
  });
  const acctSel = document.getElementById('accountFilter');
  const accounts = [...new Set(STATE.transactions.map(t=>t.account))];
  accounts.forEach(a=>{
    const opt = document.createElement('option');
    opt.value = a; opt.textContent = a;
    acctSel.appendChild(opt);
  });
}

function renderAll(){
  renderTape();
  renderOverview();
  renderLedger();
  renderAnomalies();
  renderSubscriptions();
  renderAccounts();
  document.getElementById('ledgerBadge').textContent = STATE.transactions.length;
  document.getElementById('anomalyBadge').textContent = ANOMALIES.length;
}

/* ---------------------------------------------------------------------
   TABS
--------------------------------------------------------------------- */
document.getElementById('tabs').addEventListener('click', (e)=>{
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  tab.classList.add('active');
  const view = tab.dataset.view;
  document.querySelectorAll('.panel-view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  STATE.view = view;
});

/* ---------------------------------------------------------------------
   RECEIPT TAPE (top summary strip)
--------------------------------------------------------------------- */
function renderTape(){
  const stats = computeStats(STATE.transactions);
  const tape = document.getElementById('tape');
  const period = stats.minDate && stats.maxDate
    ? `${fmtDate(stats.minDate)} → ${fmtDate(stats.maxDate)}`
    : '—';

  tape.innerHTML = `
    <div class="tape-cell">
      <div class="tape-label">Period</div>
      <div class="tape-value" style="font-size:15px;">${period}</div>
      <div class="tape-sub">${stats.count} transactions</div>
    </div>
    <div class="tape-cell">
      <div class="tape-label">Income</div>
      <div class="tape-value credit">${fmtMoney(stats.income,'RON')}</div>
      <div class="tape-sub">tracked deposits</div>
    </div>
    <div class="tape-cell">
      <div class="tape-label">Spending</div>
      <div class="tape-value debit">${fmtMoney(stats.spending,'RON')}</div>
      <div class="tape-sub">excl. transfers &amp; savings</div>
    </div>
    <div class="tape-cell">
      <div class="tape-label">P2P net</div>
      <div class="tape-value" style="color:${stats.transfersIn-stats.transfersOut>=0?'var(--credit)':'var(--ink)'}">${fmtMoney(stats.transfersIn-stats.transfersOut,'RON')}</div>
      <div class="tape-sub">sent ${fmtMoney(stats.transfersOut,'RON')} · recv ${fmtMoney(stats.transfersIn,'RON')}</div>
    </div>
    <div class="tape-cell">
      <div class="tape-label">Moved to savings</div>
      <div class="tape-value" style="color:var(--blue);font-size:20px;">${fmtMoney(stats.savingsMoved,'RON')}</div>
      <div class="tape-sub">pockets / round-ups</div>
    </div>
    <div class="tape-cell">
      <div class="tape-label">Anomalies</div>
      <div class="tape-value amber">${ANOMALIES.length}</div>
      <div class="tape-sub">${ANOMALIES.filter(a=>a.severity==='high').length} high priority</div>
    </div>
  `;
}

/* ---------------------------------------------------------------------
   OVERVIEW
--------------------------------------------------------------------- */
function renderOverview(){
  const catBreakdown = computeCategoryBreakdown(STATE.transactions);
  const monthlyFlow = computeMonthlyFlow(STATE.transactions);
  const stats = computeStats(STATE.transactions);
  const insights = generateInsights(STATE.transactions, stats, catBreakdown, ANOMALIES, RECURRING);

  // category breakdown list
  const catEl = document.getElementById('catBreakdown');
  if (catBreakdown.length === 0){
    catEl.innerHTML = '<div class="empty-state"><p>No spending transactions found.</p></div>';
  } else {
    catEl.innerHTML = catBreakdown.slice(0,10).map(c=>`
      <div class="cat-row">
        <div class="cat-dot" style="background:${c.meta.color}"></div>
        <div class="cat-name">${c.meta.icon} ${c.meta.label}</div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${c.pct}%;background:${c.meta.color}"></div></div>
        <div class="cat-amount">${fmtMoney(c.amt,'RON')}</div>
        <div class="cat-pct">${c.pct.toFixed(0)}%</div>
      </div>
    `).join('');
  }

  // insights
  const insEl = document.getElementById('insightsList');
  insEl.innerHTML = insights.length ? insights.map(i=>`
    <div class="insight">
      <div class="insight-icon">${i.icon}</div>
      <div class="insight-text">${i.html}</div>
    </div>
  `).join('') : '<div class="empty-state"><p>Not enough data yet for insights.</p></div>';

  drawFlowChart(monthlyFlow);
  drawBalanceChart();
}

/* ---------------------------------------------------------------------
   CANVAS CHARTS (no external deps)
--------------------------------------------------------------------- */
function setupCanvas(canvas){
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width+'px';
  canvas.style.height = rect.height+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return {ctx, w: rect.width, h: rect.height};
}

function drawFlowChart(monthlyFlow){
  const canvas = document.getElementById('flowChart');
  if (!canvas) return;
  const {ctx, w, h} = setupCanvas(canvas);
  ctx.clearRect(0,0,w,h);
  if (monthlyFlow.length === 0){
    ctx.fillStyle = '#565e69'; ctx.font='12px Inter'; ctx.fillText('No data', 10, 20);
    return;
  }

  const padL = 46, padR = 10, padT = 14, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxVal = Math.max(1, ...monthlyFlow.flatMap(m=>[m.income, m.spending]));
  const barGroupW = plotW / monthlyFlow.length;
  const barW = Math.min(22, barGroupW*0.32);

  // gridlines
  ctx.strokeStyle = '#1c2126'; ctx.lineWidth = 1;
  ctx.fillStyle = '#565e69'; ctx.font = '10px JetBrains Mono';
  for (let i=0;i<=3;i++){
    const y = padT + plotH - (plotH*i/3);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w-padR, y); ctx.stroke();
    const val = maxVal*i/3;
    ctx.fillText(val>=1000? (val/1000).toFixed(1)+'k' : val.toFixed(0), 4, y+3);
  }

  monthlyFlow.forEach((m, i)=>{
    const cx = padL + barGroupW*i + barGroupW/2;
    const incH = (m.income/maxVal)*plotH;
    const spdH = (m.spending/maxVal)*plotH;

    ctx.fillStyle = '#4ade80';
    roundRect(ctx, cx-barW-2, padT+plotH-incH, barW, incH, 3);
    ctx.fill();

    ctx.fillStyle = '#edeff2';
    roundRect(ctx, cx+2, padT+plotH-spdH, barW, spdH, 3);
    ctx.fill();

    ctx.fillStyle = '#8b93a0'; ctx.font='10.5px Inter'; ctx.textAlign='center';
    ctx.fillText(m.label, cx, h-8);
  });
  ctx.textAlign = 'left';

  // legend
  const legendEl = document.querySelector('#view-overview .legend');
  if (!legendEl){
    const l = document.createElement('div');
    l.className = 'legend';
    l.innerHTML = `<div class="legend-item"><div style="width:9px;height:9px;border-radius:2px;background:#4ade80;"></div>Income</div>
                    <div class="legend-item"><div style="width:9px;height:9px;border-radius:2px;background:#edeff2;"></div>Spending</div>`;
    canvas.closest('.card').appendChild(l);
  }
}

function drawBalanceChart(){
  const canvas = document.getElementById('balChart');
  if (!canvas) return;
  const {ctx, w, h} = setupCanvas(canvas);
  ctx.clearRect(0,0,w,h);

  const accounts = [...new Set(STATE.transactions.map(t=>t.account))];
  const primaryAccount = accounts.sort((a,b)=>
    STATE.transactions.filter(t=>t.account===b).length - STATE.transactions.filter(t=>t.account===a).length
  )[0];
  const series = computeBalanceSeries(STATE.transactions, primaryAccount);

  if (series.length < 2){
    ctx.fillStyle = '#565e69'; ctx.font='12px Inter'; ctx.fillText('Not enough balance data', 10, 20);
    return;
  }

  const padL = 42, padR = 10, padT = 10, padB = 18;
  const plotW = w-padL-padR, plotH = h-padT-padB;
  const vals = series.map(t=>t.balance);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const range = (maxV-minV) || 1;

  ctx.strokeStyle = '#1c2126';
  ctx.fillStyle = '#565e69'; ctx.font='9.5px JetBrains Mono';
  for (let i=0;i<=2;i++){
    const y = padT + plotH - (plotH*i/2);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
    const val = minV + range*i/2;
    ctx.fillText(val>=1000?(val/1000).toFixed(1)+'k':val.toFixed(0), 2, y+3);
  }

  ctx.beginPath();
  series.forEach((t,i)=>{
    const x = padL + (plotW * i/(series.length-1));
    const y = padT + plotH - ((t.balance-minV)/range)*plotH;
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  const grad = ctx.createLinearGradient(0,padT,0,padT+plotH);
  grad.addColorStop(0,'rgba(74,222,128,0.25)');
  grad.addColorStop(1,'rgba(74,222,128,0)');
  ctx.lineTo(padL+plotW, padT+plotH);
  ctx.lineTo(padL, padT+plotH);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  series.forEach((t,i)=>{
    const x = padL + (plotW * i/(series.length-1));
    const y = padT + plotH - ((t.balance-minV)/range)*plotH;
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.6; ctx.stroke();
}

function roundRect(ctx,x,y,w,h,r){
  if (h<=0){ h=0.5; y = y; }
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

window.addEventListener('resize', debounce(()=>{
  if (STATE.transactions.length){
    drawFlowChart(computeMonthlyFlow(STATE.transactions));
    drawBalanceChart();
  }
}, 200));
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

/* ---------------------------------------------------------------------
   LEDGER TABLE
--------------------------------------------------------------------- */
function getFilteredSortedTx(){
  let list = STATE.transactions.slice();
  const f = STATE.filters;

  if (f.search){
    const q = f.search.toLowerCase();
    list = list.filter(t=>
      (t.description||'').toLowerCase().includes(q) ||
      (t.merchant||'').toLowerCase().includes(q) ||
      (STATE.notes[t.id]||'').toLowerCase().includes(q)
    );
  }
  if (f.category) list = list.filter(t=>t.category===f.category);
  if (f.account) list = list.filter(t=>t.account===f.account);
  if (f.type === 'credit') list = list.filter(t=>t.amount>0);
  if (f.type === 'debit') list = list.filter(t=>t.amount<0);
  if (f.type === 'anomaly') list = list.filter(t=>t.isAnomaly);
  if (f.type === 'noted') list = list.filter(t=>STATE.notes[t.id]);

  const {key, dir} = STATE.sort;
  list.sort((a,b)=>{
    let av, bv;
    switch(key){
      case 'date': av=a.date; bv=b.date; break;
      case 'desc': av=(a.description||''); bv=(b.description||''); break;
      case 'category': av=a.category; bv=b.category; break;
      case 'account': av=a.account; bv=b.account; break;
      case 'amount': av=a.amount; bv=b.amount; break;
      case 'balance': av=a.balance??-Infinity; bv=b.balance??-Infinity; break;
      default: av=a.date; bv=b.date;
    }
    if (av<bv) return dir==='asc'?-1:1;
    if (av>bv) return dir==='asc'?1:-1;
    return 0;
  });
  return list;
}

function renderLedger(){
  const list = getFilteredSortedTx();
  const body = document.getElementById('ledgerBody');
  const empty = document.getElementById('ledgerEmpty');

  if (list.length === 0){
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = list.map(t=>{
    const cat = CAT_MAP[t.category] || CAT_MAP.other;
    const anomaly = STATE.anomalyById[t.id];
    const note = STATE.notes[t.id];
    return `
    <tr class="${anomaly?'anomaly-row':''}" data-id="${t.id}">
      <td class="date">${fmtDate(t.date)}</td>
      <td>
        <div class="tx-desc">${escapeHtml(t.merchant || t.description)}</div>
        <div class="tx-meta"><span class="src-tag">${t.format}</span>${escapeHtml(t.rawLabel||'')}</div>
        ${anomaly?`<div class="anomaly-flag" data-action="goto-anomaly" data-id="${t.id}">⚠ ${escapeHtml(anomaly.reason)}</div>`:''}
        ${note?`<div class="note-text">${escapeHtml(note)}</div>`:`<div class="note-btn" data-action="add-note" data-id="${t.id}">+ add note</div>`}
      </td>
      <td><span class="cat-chip" data-action="edit-cat" data-id="${t.id}" title="Recategorize all transactions from this merchant">${cat.icon} ${cat.label}</span></td>
      <td style="font-size:12px;color:var(--ink-faint);">${escapeHtml(t.account)}</td>
      <td class="amt ${t.amount>0?'credit':''}">${t.amount>0?'+':''}${fmtMoney(t.amount, t.currency)}</td>
      <td class="bal">${t.balance!=null ? fmtMoney(t.balance, t.currency) : '—'}</td>
    </tr>`;
  }).join('');
}

// filter/sort wiring
document.getElementById('searchInput').addEventListener('input', (e)=>{
  STATE.filters.search = e.target.value; renderLedger();
});
document.getElementById('categoryFilter').addEventListener('change', (e)=>{
  STATE.filters.category = e.target.value; renderLedger();
});
document.getElementById('accountFilter').addEventListener('change', (e)=>{
  STATE.filters.account = e.target.value; renderLedger();
});
document.getElementById('typeFilter').addEventListener('change', (e)=>{
  STATE.filters.type = e.target.value; renderLedger();
});
document.querySelectorAll('.ledger thead th[data-sort]').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.sort;
    if (STATE.sort.key === key){
      STATE.sort.dir = STATE.sort.dir==='asc'?'desc':'asc';
    } else {
      STATE.sort.key = key; STATE.sort.dir = key==='date'?'desc':'asc';
    }
    document.querySelectorAll('.ledger thead th').forEach(t=>t.classList.remove('sorted'));
    th.classList.add('sorted');
    renderLedger();
  });
});

// row action delegation
document.getElementById('ledgerBody').addEventListener('click', (e)=>{
  const noteBtn = e.target.closest('[data-action="add-note"]');
  const catChip = e.target.closest('[data-action="edit-cat"]');
  const gotoAnomaly = e.target.closest('[data-action="goto-anomaly"]');

  if (noteBtn){
    const id = noteBtn.dataset.id;
    const txt = prompt('Add a note explaining this transaction:');
    if (txt && txt.trim()){
      STATE.notes[id] = txt.trim();
      renderLedger(); renderAnomalies();
    }
    return;
  }
  if (catChip){
    openCategoryModal(catChip.dataset.id);
    return;
  }
  if (gotoAnomaly){
    document.querySelector('.tab[data-view="anomalies"]').click();
    setTimeout(()=>{
      const card = document.querySelector(`.anomaly-card[data-id="${gotoAnomaly.dataset.id}"]`);
      if (card){ card.scrollIntoView({behavior:'smooth', block:'center'}); card.style.borderLeftColor='#4ade80'; setTimeout(()=>card.style.borderLeftColor='',1200); }
    }, 100);
  }
});

/* ---------------------------------------------------------------------
   MERCHANT CATEGORY MODAL
   Clicking any category chip in the ledger opens this. It groups every
   transaction that shares the same merchant key and lets the user set a
   category for that merchant as a whole — applied to existing rows, future
   imports, or both.
--------------------------------------------------------------------- */
const { merchantKey } = window.LEDGER_HELPERS;
const catModal = document.getElementById('catModal');
let modalSelectedCat = null;
let modalMerchantTxs = [];
let modalMKey = '';

function openCategoryModal(txId){
  const tx = STATE.transactions.find(t=>t.id===txId);
  if (!tx) return;

  modalMKey = merchantKey(tx);
  modalMerchantTxs = STATE.transactions.filter(t=> merchantKey(t) === modalMKey);
  modalSelectedCat = STATE.merchantOverrides[modalMKey] || tx.category;

  document.getElementById('catModalMerchant').textContent = tx.merchant || tx.description;
  document.getElementById('catModalDesc').textContent =
    modalMerchantTxs.length + ' transaction' + (modalMerchantTxs.length===1?'':'s') + ' from this merchant';

  renderCatPicker();
  renderModalTxList();
  updateScopeCounts();
  updateApplyButton();

  document.getElementById('scopeExisting').checked = true;
  document.getElementById('scopeFuture').checked = true;

  catModal.classList.add('active');
}

function renderCatPicker(){
  const picker = document.getElementById('catPicker');
  picker.innerHTML = CATEGORIES.map(c=>`
    <div class="cat-option ${c.key===modalSelectedCat?'selected':''}" data-cat="${c.key}"
         style="${c.key===modalSelectedCat?'border-color:'+c.color+';color:'+c.color:''}">
      ${c.icon} ${c.label}
    </div>
  `).join('');
  picker.querySelectorAll('.cat-option').forEach(opt=>{
    opt.addEventListener('click', ()=>{
      modalSelectedCat = opt.dataset.cat;
      renderCatPicker();
      updateApplyButton();
    });
  });
}

function updateScopeCounts(){
  document.getElementById('scopeExistingCount').textContent = modalMerchantTxs.length;
  document.getElementById('scopeExistingPlural').textContent = modalMerchantTxs.length===1 ? '' : 's';
}

function updateApplyButton(){
  const btn = document.getElementById('catModalApply');
  const cat = CAT_MAP[modalSelectedCat];
  if (!cat){
    btn.disabled = true;
    btn.textContent = 'Choose a category above';
    return;
  }
  btn.disabled = false;
  btn.textContent = `Apply "${cat.label}" to ${document.getElementById('scopeExisting').checked ? 'this merchant' : 'future transactions'}`;
}

function renderModalTxList(){
  const list = document.getElementById('catModalTxList');
  const sorted = modalMerchantTxs.slice().sort((a,b)=>b.date-a.date);
  list.innerHTML = sorted.map(t=>{
    const cat = CAT_MAP[t.category] || CAT_MAP.other;
    return `<div class="modal-tx-row">
      <div class="modal-tx-date">${fmtDate(t.date)}</div>
      <div class="modal-tx-desc">${escapeHtml(t.description)}</div>
      <div class="modal-tx-cat">${cat.icon}</div>
      <div class="modal-tx-amt" style="color:${t.amount>0?'var(--credit)':'var(--ink)'}">${t.amount>0?'+':''}${fmtMoney(t.amount,t.currency)}</div>
    </div>`;
  }).join('');
}

document.getElementById('scopeExisting').addEventListener('change', updateApplyButton);
document.getElementById('scopeFuture').addEventListener('change', updateApplyButton);

document.getElementById('catModalApply').addEventListener('click', ()=>{
  if (!modalSelectedCat) return;
  const applyExisting = document.getElementById('scopeExisting').checked;
  const applyFuture = document.getElementById('scopeFuture').checked;
  if (!applyExisting && !applyFuture) return;

  if (applyFuture){
    // Standing rule: guessCategory() checks this first, so any transaction
    // parsed from a future statement with a matching merchant key picks it up.
    STATE.merchantOverrides[modalMKey] = modalSelectedCat;
  } else {
    // User wants existing only — don't leave a standing rule behind.
    delete STATE.merchantOverrides[modalMKey];
  }

  if (applyExisting){
    modalMerchantTxs.forEach(t=>{
      STATE.categoryOverrides[t.id] = modalSelectedCat;
      t.category = modalSelectedCat;
    });
  } else if (applyFuture){
    // Future-only: re-resolve category for existing rows so ones without a
    // per-transaction override still reflect the new merchant rule going
    // forward, without touching any per-transaction manual overrides the
    // user set separately.
    STATE.transactions.forEach(t=>{
      if (merchantKey(t) === modalMKey) t.category = guessCategory(t);
    });
  }

  catModal.classList.remove('active');
  renderAll();
});

document.getElementById('catModalClose').addEventListener('click', ()=>catModal.classList.remove('active'));
catModal.addEventListener('click', (e)=>{ if (e.target===catModal) catModal.classList.remove('active'); });

/* ---------------------------------------------------------------------
   ANOMALIES VIEW
--------------------------------------------------------------------- */
function renderAnomalies(){
  ANOMALIES = detectAnomalies(STATE.transactions); // recompute in case categories changed
  ANOMALIES.forEach(a=> a.tx.isAnomaly = true);
  STATE.anomalyById = Object.fromEntries(ANOMALIES.map(a=>[a.tx.id,a]));
  document.getElementById('anomalyBadge').textContent = ANOMALIES.length;

  const list = document.getElementById('anomalyList');
  const empty = document.getElementById('anomalyEmpty');
  if (ANOMALIES.length === 0){
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const sevColor = {high:'#e85a5a', medium:'#f2a93b', low:'#8b93a0'};
  list.innerHTML = ANOMALIES.map(a=>{
    const t = a.tx;
    const note = STATE.notes[t.id];
    return `
    <div class="anomaly-card" data-id="${t.id}" style="border-left-color:${sevColor[a.severity]}">
      <div class="anomaly-top">
        <div>
          <div class="anomaly-title">${escapeHtml(t.merchant || t.description)}</div>
          <div class="anomaly-reason" style="color:${sevColor[a.severity]}">${escapeHtml(a.reason)} · ${fmtDate(t.date)}</div>
        </div>
        <div class="anomaly-amt" style="color:${t.amount>0?'#4ade80':'#edeff2'}">${t.amount>0?'+':''}${fmtMoney(t.amount, t.currency)}</div>
      </div>
      <div class="anomaly-detail">${escapeHtml(a.detail)}</div>
      ${note
        ? `<div class="note-text">${escapeHtml(note)}<div class="note-btn" data-action="edit" style="margin-top:6px;">edit note</div></div>`
        : `<textarea class="note-input" placeholder="Explain what this was — helps you spot the difference between a real anomaly and normal life next time." data-id="${t.id}"></textarea>
           <div class="note-actions"><button class="btn btn-sm btn-primary" data-action="save-note" data-id="${t.id}">Save note</button>
           <button class="btn btn-sm btn-ghost" data-action="dismiss" data-id="${t.id}">Not an anomaly</button></div>`
      }
    </div>`;
  }).join('');
}

document.getElementById('anomalyList').addEventListener('click', (e)=>{
  const saveBtn = e.target.closest('[data-action="save-note"]');
  const editBtn = e.target.closest('[data-action="edit"]');
  const dismissBtn = e.target.closest('[data-action="dismiss"]');

  if (saveBtn){
    const id = saveBtn.dataset.id;
    const textarea = document.querySelector(`textarea[data-id="${id}"]`);
    if (textarea && textarea.value.trim()){
      STATE.notes[id] = textarea.value.trim();
      renderAnomalies();
      renderLedger();
    }
  }
  if (editBtn){
    const card = editBtn.closest('.anomaly-card');
    const id = card.dataset.id;
    delete STATE.notes[id];
    renderAnomalies();
  }
  if (dismissBtn){
    const id = dismissBtn.dataset.id;
    STATE.notes[id] = '(marked as not an anomaly)';
    renderAnomalies();
    renderLedger();
  }
});

/* ---------------------------------------------------------------------
   SUBSCRIPTIONS / RECURRING VIEW
--------------------------------------------------------------------- */
function renderSubscriptions(){
  const subList = document.getElementById('subList');
  if (RECURRING.length === 0){
    subList.innerHTML = '<div class="empty-state"><p>No recurring payment patterns detected yet — need more history.</p></div>';
  } else {
    subList.innerHTML = RECURRING.map(r=>{
      const cat = CAT_MAP[r.category] || CAT_MAP.other;
      return `
      <div class="sub-row">
        <div>
          <div class="sub-name">${cat.icon} ${escapeHtml(r.merchant)}</div>
          <div class="sub-meta">${r.count} charges · last ${fmtDate(r.lastDate)}</div>
        </div>
        <div>
          <div class="sub-amt">${fmtMoney(r.avgAmount, r.currency)}</div>
          <div class="sub-freq">${r.freq.toUpperCase()}</div>
        </div>
      </div>`;
    }).join('');
  }

  // top merchants overall (by total spend)
  const merchants = {};
  STATE.transactions.filter(t=>t.amount<0).forEach(t=>{
    const key = t.merchant || t.description;
    merchants[key] = merchants[key] || {name:key, total:0, count:0, category:t.category};
    merchants[key].total += Math.abs(t.amount);
    merchants[key].count += 1;
  });
  const topMerchants = Object.values(merchants).sort((a,b)=>b.total-a.total).slice(0,10);
  const merchantList = document.getElementById('merchantList');
  merchantList.innerHTML = topMerchants.map(m=>{
    const cat = CAT_MAP[m.category]||CAT_MAP.other;
    return `<div class="sub-row">
      <div><div class="sub-name">${cat.icon} ${escapeHtml(m.name)}</div><div class="sub-meta">${m.count} transaction${m.count>1?'s':''}</div></div>
      <div class="sub-amt">${fmtMoney(m.total,'RON')}</div>
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------------------
   ACCOUNTS VIEW
--------------------------------------------------------------------- */
function renderAccounts(){
  const accounts = {};
  STATE.transactions.forEach(t=>{
    accounts[t.account] = accounts[t.account] || {name:t.account, txs:[], format:t.format};
    accounts[t.account].txs.push(t);
  });

  const acctList = document.getElementById('acctList');
  acctList.innerHTML = Object.values(accounts).map(a=>{
    const sorted = a.txs.slice().sort((x,y)=>y.date-x.date);
    const latest = sorted.find(t=>t.balance!=null);
    const initials = a.format.slice(0,2).toUpperCase();
    const color = a.format==='ING' ? '#f2a93b' : a.format==='Revolut' ? '#5b9dd9' : '#8b93a0';
    return `<div class="acct-row">
      <div class="acct-icon" style="background:${color}22;color:${color};border:1px solid ${color}44;">${initials}</div>
      <div>
        <div class="acct-name">${escapeHtml(a.name)}</div>
        <div class="acct-meta">${a.txs.length} transactions</div>
      </div>
      <div class="acct-bal">${latest ? fmtMoney(latest.balance, latest.currency) : '—'}</div>
    </div>`;
  }).join('');

  const sourceList = document.getElementById('sourceList');
  sourceList.innerHTML = STATE.sources.map(s=>`
    <div class="acct-row">
      <div class="acct-icon" style="background:#26313522;color:#8b93a0;border:1px solid var(--line);">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
      </div>
      <div>
        <div class="acct-name">${escapeHtml(s.name)}</div>
        <div class="acct-meta">detected as ${s.format}</div>
      </div>
      <div class="acct-bal" style="font-size:12px;color:var(--ink-faint);">${s.count} rows</div>
    </div>
  `).join('');
}

})();
