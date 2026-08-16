/* =========================================================================
   LEDGER — local statement parser & budget dashboard
   All processing happens client-side. No network calls, no storage beyond
   the current tab's memory.
   ========================================================================= */

(function(){
"use strict";

/* ---------------------------------------------------------------------
   STATE
--------------------------------------------------------------------- */
const STATE = {
  transactions: [],   // unified transaction objects
  sources: [],        // {name, format, count, error}
  notes: {},          // id -> note text
  categoryOverrides: {}, // id -> category (single-transaction override)
  merchantOverrides: {}, // normalizedMerchantKey -> category (applies to future + can be bulk-applied to existing)
  view: 'overview',
  sort: {key:'date', dir:'desc'},
  filters: {search:'', category:'', account:'', type:''}
};

const ROMANIAN_MONTHS = {
  'ianuarie':1,'februarie':2,'martie':3,'aprilie':4,'mai':5,'iunie':6,
  'iulie':7,'august':8,'septembrie':9,'octombrie':10,'noiembrie':11,'decembrie':12
};

/* ---------------------------------------------------------------------
   CATEGORY DEFINITIONS
--------------------------------------------------------------------- */
const CATEGORIES = [
  {key:'groceries',   label:'Groceries',        color:'#4ade80', icon:'🛒'},
  {key:'dining',      label:'Dining & Takeout',  color:'#f2a93b', icon:'🍽️'},
  {key:'transport',   label:'Transport & Fuel',  color:'#5b9dd9', icon:'⛽'},
  {key:'shopping',    label:'Shopping',          color:'#e879c9', icon:'🛍️'},
  {key:'bills',       label:'Bills & Utilities',  color:'#e85a5a', icon:'💡'},
  {key:'subscriptions',label:'Subscriptions',    color:'#a78bfa', icon:'🔁'},
  {key:'health',      label:'Health',            color:'#34d399', icon:'💊'},
  {key:'entertainment',label:'Entertainment',    color:'#fb923c', icon:'🎬'},
  {key:'travel',      label:'Travel',            color:'#22d3ee', icon:'✈️'},
  {key:'transfer_out',label:'Transfer out (P2P)',color:'#8b93a0', icon:'↗️'},
  {key:'transfer_in', label:'Transfer in (P2P)', color:'#6ee7b7', icon:'↘️'},
  {key:'income',      label:'Income',            color:'#4ade80', icon:'💰'},
  {key:'savings',     label:'Savings / Pockets',  color:'#60a5fa', icon:'🏦'},
  {key:'investing',   label:'Investing',         color:'#facc15', icon:'📈'},
  {key:'fees',        label:'Fees & Charges',    color:'#e85a5a', icon:'⚠️'},
  {key:'cash',        label:'Cash & ATM',        color:'#d4a373', icon:'🏧'},
  {key:'other',       label:'Other',             color:'#565e69', icon:'•'}
];
const CAT_MAP = Object.fromEntries(CATEGORIES.map(c=>[c.key,c]));

// Merchant / keyword -> category rules (checked against uppercased description)
const RULES = [
  [/MEGAIMAGE|KAUFLAND|LIDL|CARREFOUR|MEGA IMAGE|PROFI|AUCHAN|PENNY|BIBI MARKET|LA IEFTINACHE/i,'groceries'],
  [/BOLT FOOD|GLOVO|FOODPANDA|GOOD FOOD|SPERANTA PROD|NYX\*SPERANTA|FROO\b/i,'dining'],
  [/RESTAURANT|BISTRO|CAFE|CAFFE|COFFEE|PIZZA|SUSHI|KFC|MCDONALD|BURGER KING|STARBUCKS|VAMA VECHE|1 MINUTE\b|PRANZO/i,'dining'],
  [/BOLT SERVICES|UBER|TAXI|RATBV|CFR|METROREX|STB\b|AMPARCAT|CARWASH|PARKING/i,'transport'],
  [/OMV|ROMPETROL|LUKOIL|MOL\b|PETROM|SOCAR|SHELL|STATIE DISTRIBUTIE|GAS STATION|BENZINARIE|BENZINARIA/i,'transport'],
  [/INFRASTRUCTURI RUTIERE|ROVINIETA/i,'transport'],
  [/SINSAY|H&M|ZARA|IKEA|DECATHLON|EMAG|ALTEX|FASHION|BOUTIQUE|NEW YORKER|DEICHMANN|DS DAMAT|DEDEMAN|ALIEXPRESS|CCC\b|LC WAIKIKI|INTERSPORT/i,'shopping'],
  [/PPC ENERGIE|PPC\b|ENGIE|ELECTRICA|DIGI|VODAFONE|ORANGE|TELEKOM|APA NOVA|RADET|PRIMARIA/i,'bills'],
  [/NETFLIX|SPOTIFY|HBO|DISNEY|YOUTUBE PREMIUM|APPLE\.COM\/BILL|GOOGLE \*|TORBOX|7CARD/i,'subscriptions'],
  [/PHARMACY|FARMACIE|CATENA|SENSIBLU|HELP NET|DR\.MAX|CLINICA|SPITAL/i,'health'],
  [/CINEMA|CINEMA CITY|BOOKING\.COM|AIRBNB|HOTEL/i,'entertainment'],
  [/WIZZ AIR|TAROM|RYANAIR|BLUE AIR|AIRLINES/i,'travel'],
  [/XTB S\.A|TRADING212|INTERACTIVE BROKERS|DEGIRO/i,'investing'],
  [/ROUND UP/i,'savings'],
  [/TO POCKET|FROM POCKET|POCKET WITHDRAWAL/i,'savings'],
  [/SALARIU|SALARY|SALARIUL|PAYROLL/i,'income'],
  [/ATM|RETRAGERE NUMERAR|CASH WITHDRAWAL/i,'cash'],
  [/COMISION|FEE\b|TAXA\b|PENALIZARE/i,'fees'],
];

// Stable merchant key for per-merchant category rules. Deliberately less
// aggressive than the anomaly-detection normMerchant() (which truncates for
// duplicate-matching) — this one keeps the full cleaned name so "Bolt Services
// RO S.R.L." from different cities/dates all resolve to the same rule.
function merchantKey(tx){
  return (tx.merchant || tx.description || '')
    .toUpperCase()
    .replace(/\s+RO\s+[A-ZĂÂÎȘŞȚŢ\s]+$/,'')   // strip trailing " RO <city>" country/city suffix
    .replace(/[^A-Z0-9 ]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

function guessCategory(tx){
  if (STATE.categoryOverrides[tx.id]) return STATE.categoryOverrides[tx.id];
  const mKey = merchantKey(tx);
  if (mKey && STATE.merchantOverrides[mKey]) return STATE.merchantOverrides[mKey];
  const desc = (tx.merchant || tx.description || '').toUpperCase();

  for (const [re, cat] of RULES){
    if (re.test(desc)) return cat;
  }

  // structural fallbacks
  if (tx.kind === 'transfer_p2p'){
    return tx.amount >= 0 ? 'transfer_in' : 'transfer_out';
  }
  if (tx.kind === 'income') return 'income';
  if (tx.kind === 'topup') return 'income';
  if (tx.kind === 'savings') return 'savings';
  if (tx.kind === 'fee') return 'fees';
  return 'other';
}

/* ---------------------------------------------------------------------
   NUMBER / DATE HELPERS
--------------------------------------------------------------------- */
// "1.548,41" -> 1548.41   (Romanian: . thousands, , decimal)
function parseRoNumber(str){
  if (str==null || str==='') return null;
  let s = String(str).trim().replace(/"/g,'');
  if (s==='') return null;
  s = s.replace(/\./g,'').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
// "278.00" or "-13.59" -> float (Revolut style, already dot-decimal)
function parseDotNumber(str){
  if (str==null || str==='') return null;
  const n = parseFloat(String(str).replace(/,/g,''));
  return isNaN(n) ? null : n;
}
function parseRoDate(str){
  // "16 august 2026" -> Date
  const m = String(str).trim().match(/^(\d{1,2})\s+([a-zăâîșşțţ]+)\s+(\d{4})$/i);
  if (!m) return null;
  const day = parseInt(m[1],10);
  const monthName = m[2].toLowerCase()
    .replace('ă','a').replace('â','a').replace('î','i').replace('ș','s').replace('ş','s').replace('ț','t').replace('ţ','t');
  const month = ROMANIAN_MONTHS[monthName];
  if (!month) return null;
  const year = parseInt(m[3],10);
  return new Date(Date.UTC(year, month-1, day, 12, 0, 0));
}
function parseIsoDateTime(str){
  if (!str) return null;
  const d = new Date(str.replace(' ','T')+ (str.includes('T')?'':'Z'));
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(d){
  if (!d) return '—';
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtMonthKey(d){
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
}
function fmtMonthLabel(key){
  const [y,m] = key.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,1)).toLocaleDateString('en-GB',{month:'short',year:'numeric'});
}
function fmtMoney(n, currency){
  currency = currency || 'RON';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  return sign + abs + ' ' + currency;
}
function csvSplitLine(line){
  // simple CSV split respecting quoted fields
  const out = [];
  let cur = '', inQ = false;
  for (let i=0;i<line.length;i++){
    const c = line[i];
    if (c === '"'){
      if (inQ && line[i+1] === '"'){ cur+='"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ){
      out.push(cur); cur='';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

let ID_SEQ = 1;
function nextId(){ return 'tx_' + (ID_SEQ++); }

/* ---------------------------------------------------------------------
   PARSER: ING Bank Romania export
   Multi-line records: header row (date,,,label,debit,,credit,balance)
   followed by indented detail lines (,,,Key:Value,,,,) until next header
   or blank/footer row. Statements are paginated with repeated headers
   and signature blocks — both are skipped.
--------------------------------------------------------------------- */
function looksLikeINGFormat(text){
  return /Titular cont/i.test(text) && /Detalii tranzactie/i.test(text);
}

function parseING(text, sourceName){
  const lines = text.split(/\r?\n/);
  const txs = [];
  let i = 0;
  let currentHeader = null; // {date, label, debit, credit, balance, details:[]}
  const flush = () => {
    if (!currentHeader) return;
    const h = currentHeader;
    currentHeader = null;
    if (!h.date || (h.debit==null && h.credit==null)) return;

    const detailsText = h.details.join(' | ');
    let merchant = null, note = null, ref = null, cardLast4 = null, authDate=null;

    for (const d of h.details){
      let m;
      if ((m = d.match(/^Tranzactie la:(.+)$/i))) merchant = m[1].trim();
      else if ((m = d.match(/^Platita la:\s*(.+)$/i))) merchant = m[1].trim();
      else if ((m = d.match(/^Beneficiar:(.+)$/i))) merchant = m[1].trim();
      else if ((m = d.match(/^Ordonator:(.+)$/i))) merchant = m[1].trim();
      else if ((m = d.match(/^Detalii:(.+)$/i))) note = m[1].trim();
      else if ((m = d.match(/^Referinta:(.+)$/i))) ref = m[1].trim();
      else if ((m = d.match(/^Numar card:\s*(.+)$/i))) cardLast4 = m[1].trim();
      else if ((m = d.match(/^Data autorizarii:(.+)$/i))) authDate = m[1].trim();
      else if ((m = d.match(/^In contul:(.+)$/i)) && !merchant) merchant = 'Pocket transfer';
    }

    const isDebit = h.debit != null;
    const amount = isDebit ? -h.debit : h.credit;
    const label = h.label;

    let kind = 'purchase';
    if (/Round Up/i.test(label)) kind = 'savings';
    else if (/Incasare/i.test(label)) kind = 'income';
    else if (/Transfer Home.?Bank/i.test(label)) kind = 'transfer_p2p';
    else if (/Plati cu cardul de tip transfer fonduri/i.test(label)) kind = 'transfer_p2p';
    else if (/Cumparare POS/i.test(label)) kind = 'purchase';
    else kind = 'other';

    // Skip internal round-up / pocket-transfer noise? Keep them, categorizer + UI will bucket as savings.
    if (!merchant){
      merchant = note || label;
    }

    const tx = {
      id: nextId(),
      date: h.date,
      description: label + (merchant ? ' · ' + merchant : ''),
      merchant: merchant,
      note: note,
      amount: amount,
      currency: 'RON',
      balance: h.balance,
      account: 'ING Current (RON)',
      source: sourceName,
      format: 'ING',
      kind: kind,
      cardLast4: cardLast4,
      ref: ref,
      rawLabel: label,
      fileSeq: txs.length // preserves the statement's true ledger order (newest-first),
                           // needed because displayed 'date' is calendar-only and same-day
                           // transactions can post in an order the date field can't express
    };
    txs.push(tx);
  };

  for (; i<lines.length; i++){
    const raw = lines[i];
    if (raw.trim()==='') continue;
    if (/^Titular cont/i.test(raw)) { flush(); continue; }
    if (/^Data,,,Detalii tranzactie/i.test(raw)) { flush(); continue; } // page header row
    // footer / signature block lines - skip (no leading comma pattern match needed, just heuristic)
    if (/Şef Serviciu|Sef Serviciu|ING Bank N\.V\.|Sucursala Bucure/i.test(raw)) continue;

    const cols = csvSplitLine(raw);
    const dateStr = cols[0] ? cols[0].trim() : '';
    const label = cols[3] ? cols[3].trim() : '';
    const debitStr = cols[4] ? cols[4].trim() : '';
    const creditStr = cols[6] ? cols[6].trim() : '';
    const balStr = cols[7] ? cols[7].trim() : '';

    const parsedDate = dateStr ? parseRoDate(dateStr) : null;

    if (parsedDate){
      // new transaction header line
      flush();
      currentHeader = {
        date: parsedDate,
        label: label,
        debit: parseRoNumber(debitStr),
        credit: parseRoNumber(creditStr),
        balance: parseRoNumber(balStr),
        details: []
      };
    } else if (currentHeader) {
      // detail line — the meaningful content is usually in column 4 (index 3)
      const detail = label;
      if (detail) currentHeader.details.push(detail);
    }
    // else: stray line (blank leading commas, signatory names etc) — ignore
  }
  flush();
  return txs;
}

/* ---------------------------------------------------------------------
   PARSER: Revolut-style export
   Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
--------------------------------------------------------------------- */
function looksLikeRevolutFormat(headerLine){
  const h = headerLine.toLowerCase();
  return h.includes('type') && h.includes('started date') && h.includes('completed date') && h.includes('amount');
}

function parseRevolut(text, sourceName){
  const lines = text.split(/\r?\n/).filter(l=>l.trim()!=='');
  const header = csvSplitLine(lines[0]).map(h=>h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);

  const iType = idx('type'), iProduct = idx('product'), iStarted = idx('started date'),
        iCompleted = idx('completed date'), iDesc = idx('description'), iAmount = idx('amount'),
        iFee = idx('fee'), iCurrency = idx('currency'), iState = idx('state'), iBalance = idx('balance');

  const txs = [];
  for (let i=1;i<lines.length;i++){
    const cols = csvSplitLine(lines[i]);
    if (cols.length < 2) continue;
    const type = cols[iType] ? cols[iType].trim() : '';
    const product = cols[iProduct] ? cols[iProduct].trim() : 'Current';
    const startedRaw = cols[iStarted] ? cols[iStarted].trim() : '';
    const completedRaw = cols[iCompleted] ? cols[iCompleted].trim() : '';
    const desc = cols[iDesc] ? cols[iDesc].trim() : '';
    const amount = parseDotNumber(cols[iAmount]);
    const fee = parseDotNumber(cols[iFee]) || 0;
    const currency = cols[iCurrency] ? cols[iCurrency].trim() : 'RON';
    const state = cols[iState] ? cols[iState].trim() : '';
    const balance = parseDotNumber(cols[iBalance]);

    if (amount == null) continue;
    const dateObj = parseIsoDateTime(completedRaw) || parseIsoDateTime(startedRaw);
    if (!dateObj) continue;

    let kind = 'purchase';
    let merchant = desc;
    if (type === 'Card Payment') kind = 'purchase';
    else if (type === 'Topup') kind = 'income';
    else if (type === 'Exchange') kind = 'other';
    else if (type === 'Transfer'){
      if (/^to pocket|^from pocket|pocket withdrawal/i.test(desc)) kind = 'savings';
      else if (/^transfer (to|from)/i.test(desc)) kind = 'transfer_p2p';
      else if (/^to /i.test(desc)) kind = 'transfer_p2p';
      else kind = 'transfer_p2p';
    }

    const mMatch = desc.match(/^(?:Transfer (?:to|from)|To|From)\s+(.+)$/i);
    if (mMatch) merchant = mMatch[1];

    txs.push({
      id: nextId(),
      date: dateObj,
      description: desc,
      merchant: merchant,
      note: null,
      amount: amount,
      fee: fee,
      currency: currency,
      balance: balance,
      account: 'Revolut ' + product + ' (' + currency + ')',
      source: sourceName,
      format: 'Revolut',
      kind: kind,
      state: state,
      rawLabel: type
    });
  }
  return txs;
}

/* ---------------------------------------------------------------------
   PARSER: Generic CSV fallback (best-effort column guessing)
--------------------------------------------------------------------- */
function parseGeneric(text, sourceName){
  const lines = text.split(/\r?\n/).filter(l=>l.trim()!=='');
  if (lines.length < 2) return [];
  const header = csvSplitLine(lines[0]).map(h=>h.trim().toLowerCase());

  const findCol = (patterns) => {
    for (const p of patterns){
      const idx = header.findIndex(h=>h.includes(p));
      if (idx>=0) return idx;
    }
    return -1;
  };
  const iDate = findCol(['date']);
  const iDesc = findCol(['description','details','narrative','memo']);
  const iAmount = findCol(['amount','value','suma']);
  const iDebit = findCol(['debit']);
  const iCredit = findCol(['credit']);
  const iBalance = findCol(['balance','sold','balanta']);
  const iCurrency = findCol(['currency','moneda']);

  if (iDate < 0 || (iAmount<0 && iDebit<0 && iCredit<0)) return [];

  const txs = [];
  for (let i=1;i<lines.length;i++){
    const cols = csvSplitLine(lines[i]);
    if (cols.length < 2) continue;
    const dateStr = cols[iDate] ? cols[iDate].trim() : '';
    let dateObj = parseIsoDateTime(dateStr) || parseRoDate(dateStr);
    if (!dateObj){
      const m = dateStr.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
      if (m) dateObj = new Date(Date.UTC(+m[3], +m[2]-1, +m[1], 12,0,0));
    }
    if (!dateObj) continue;

    let amount = null;
    if (iAmount>=0) amount = parseDotNumber(cols[iAmount]) ?? parseRoNumber(cols[iAmount]);
    else {
      const d = parseDotNumber(cols[iDebit]) ?? parseRoNumber(cols[iDebit]);
      const c = parseDotNumber(cols[iCredit]) ?? parseRoNumber(cols[iCredit]);
      amount = d ? -Math.abs(d) : (c || 0);
    }
    if (amount == null) continue;

    const desc = iDesc>=0 ? cols[iDesc].trim() : 'Transaction';
    txs.push({
      id: nextId(),
      date: dateObj,
      description: desc,
      merchant: desc,
      note: null,
      amount: amount,
      currency: iCurrency>=0 ? (cols[iCurrency].trim()||'RON') : 'RON',
      balance: iBalance>=0 ? (parseDotNumber(cols[iBalance]) ?? parseRoNumber(cols[iBalance])) : null,
      account: sourceName.replace(/\.csv$/i,''),
      source: sourceName,
      format: 'Generic',
      kind: amount<0 ? 'purchase':'income',
      rawLabel: desc
    });
  }
  return txs;
}

/* ---------------------------------------------------------------------
   MAIN FILE PROCESSOR
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   FILE INGESTION
--------------------------------------------------------------------- */
function detectAndParse(text, filename){
  const firstLine = text.split(/\r?\n/)[0] || '';
  if (looksLikeINGFormat(text)){
    return { format:'ING', txs: parseING(text, filename) };
  }
  if (looksLikeRevolutFormat(firstLine)){
    return { format:'Revolut', txs: parseRevolut(text, filename) };
  }
  const generic = parseGeneric(text, filename);
  return { format: 'Generic', txs: generic };
}

function readFile(file){
  return new Promise((resolve)=>{
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => resolve(null);
    reader.readAsText(file, 'UTF-8');
  });
}

async function handleFiles(fileList){
  const files = Array.from(fileList).filter(f => /\.(csv|txt)$/i.test(f.name));
  if (files.length === 0) return;

  const fileListEl = document.getElementById('fileList');
  const errorsEl = document.getElementById('parseErrors');
  const errors = [];

  for (const file of files){
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `<div class="fname">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8b93a0" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
        ${escapeHtml(file.name)}
      </div><div class="fmeta">parsing…</div>`;
    fileListEl.appendChild(row);

    const text = await readFile(file);
    if (!text){
      row.querySelector('.fmeta').outerHTML = '<div class="status-err">read failed</div>';
      errors.push(`${file.name}: could not be read.`);
      continue;
    }

    try {
      const result = detectAndParse(text, file.name);
      if (result.txs.length === 0){
        row.querySelector('.fmeta').outerHTML = '<div class="status-err">0 transactions found</div>';
        errors.push(`${file.name}: recognized as "${result.format}" format but found no transactions. The file may use an unsupported layout.`);
      } else {
        row.querySelector('.fmeta').outerHTML = `<div class="status-ok">${result.format} · ${result.txs.length} transactions</div>`;
        STATE.transactions.push(...result.txs);
        STATE.sources.push({name:file.name, format:result.format, count:result.txs.length});
      }
    } catch(err){
      row.querySelector('.fmeta').outerHTML = '<div class="status-err">parse error</div>';
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  if (errors.length){
    errorsEl.style.display = 'block';
    errorsEl.innerHTML = '<b>Some files had issues:</b><br>' + errors.map(escapeHtml).join('<br>');
  } else {
    errorsEl.style.display = 'none';
  }

  if (STATE.transactions.length > 0){
    STATE.transactions.sort((a,b)=> b.date - a.date);
    launchApp();
  }
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------------------------------------------------------------
   ANOMALY DETECTION
   Rules, each returns an array of {tx, reason, detail, severity}
--------------------------------------------------------------------- */
function detectAnomalies(txs){
  const flags = [];
  const debits = txs.filter(t=>t.amount<0 && t.kind==='purchase');

  // 1) Statistical outliers per category (z-score-ish on log scale using MAD)
  const byCat = {};
  debits.forEach(t=>{
    const cat = t.category;
    (byCat[cat] = byCat[cat] || []).push(t);
  });
  Object.entries(byCat).forEach(([cat, list])=>{
    if (list.length < 4) return;
    const amounts = list.map(t=>Math.abs(t.amount));
    const median = quantile(amounts, 0.5);
    const mad = quantile(amounts.map(a=>Math.abs(a-median)), 0.5) || 1;
    list.forEach(t=>{
      const dev = Math.abs(Math.abs(t.amount) - median) / (mad * 1.4826 || 1);
      if (dev > 3.5 && Math.abs(t.amount) > median * 2 && Math.abs(t.amount) > 50){
        flags.push({
          tx: t,
          reason: 'Unusual amount for ' + (CAT_MAP[cat]?.label || cat),
          detail: `${fmtMoney(Math.abs(t.amount), t.currency)} is far above the typical ${fmtMoney(median, t.currency)} spend in this category.`,
          severity: dev > 6 ? 'high':'medium'
        });
      }
    });
  });

  // 2) Large single transactions overall (top 1.5% by absolute amount, min threshold)
  const allAmounts = txs.map(t=>Math.abs(t.amount)).sort((a,b)=>a-b);
  const p97 = quantile(allAmounts, 0.97);
  txs.forEach(t=>{
    if (Math.abs(t.amount) >= p97 && Math.abs(t.amount) > 300 && !flags.find(f=>f.tx.id===t.id)){
      flags.push({
        tx: t,
        reason: t.amount<0 ? 'Large outgoing payment' : 'Large incoming payment',
        detail: `Among the largest ${t.amount<0?'payments':'deposits'} in this statement (top 3%).`,
        severity: 'medium'
      });
    }
  });

  // 3) Duplicate-looking charges: same merchant + same amount within 6h.
  // Excludes round-up/pocket transfers and sub-10-unit micro-charges, which are
  // routinely repeated by design (round-ups, small top-ups) and aren't anomalies.
  const sorted = [...txs].sort((a,b)=>a.date-b.date);
  for (let i=0;i<sorted.length;i++){
    for (let j=i+1;j<sorted.length;j++){
      const dt = (sorted[j].date - sorted[i].date) / 36e5;
      if (dt > 6) break;
      const a = sorted[i], b = sorted[j];
      if (a.kind==='savings' || b.kind==='savings') continue;
      if (Math.abs(a.amount) < 10) continue;
      if (a.amount === b.amount &&
          a.amount < 0 &&
          normMerchant(a) === normMerchant(b) &&
          normMerchant(a) !== ''){
        if (!flags.find(f=>f.tx.id===b.id && f.reason.includes('Possible duplicate'))){
          flags.push({
            tx: b,
            reason: 'Possible duplicate charge',
            detail: `Same amount (${fmtMoney(Math.abs(b.amount), b.currency)}) from "${b.merchant||b.description}" as a charge ${dt.toFixed(1)}h earlier.`,
            severity: 'high',
            relatedId: a.id
          });
        }
      }
    }
  }

  // 4) New / one-off merchant with an unusually large first charge
  const merchantFirstSeen = {};
  sorted.forEach(t=>{
    const key = normMerchant(t);
    if (!key || t.amount>=0) return;
    if (!(key in merchantFirstSeen)) merchantFirstSeen[key] = t;
  });

  // 5) Low balance / near-zero balance moments
  const withBalance = sorted.filter(t=>t.balance!=null);
  withBalance.forEach(t=>{
    if (t.balance < 30 && t.balance >= 0){
      flags.push({
        tx: t,
        reason: 'Balance ran low',
        detail: `Account balance dropped to ${fmtMoney(t.balance, t.currency)} after this transaction.`,
        severity: 'low'
      });
    }
  });

  // 6) Fee transactions
  txs.forEach(t=>{
    if (t.category === 'fees'){
      flags.push({tx:t, reason:'Fee charged', detail:'This looks like a bank fee or commission.', severity:'low'});
    }
  });

  // Dedup: keep highest severity per tx, cap balance-low flags to avoid spam (max 3)
  const sevRank = {high:3, medium:2, low:1};
  const byTx = {};
  flags.forEach(f=>{
    const existing = byTx[f.tx.id];
    if (!existing || sevRank[f.severity] > sevRank[existing.severity]){
      byTx[f.tx.id] = f;
    }
  });
  let result = Object.values(byTx);

  const lowBalanceFlags = result.filter(f=>f.reason==='Balance ran low');
  if (lowBalanceFlags.length > 3){
    const keep = new Set(lowBalanceFlags.sort((a,b)=>a.tx.balance-b.tx.balance).slice(0,3).map(f=>f.tx.id));
    result = result.filter(f=> f.reason!=='Balance ran low' || keep.has(f.tx.id));
  }

  result.sort((a,b)=> sevRank[b.severity]-sevRank[a.severity] || b.tx.date-a.tx.date);
  return result;
}

function normMerchant(t){
  return (t.merchant || t.description || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20);
}
function quantile(sortedOrArr, q){
  const arr = [...sortedOrArr].sort((a,b)=>a-b);
  if (arr.length===0) return 0;
  const pos = (arr.length-1)*q;
  const base = Math.floor(pos), rest = pos-base;
  return arr[base+1]!==undefined ? arr[base] + rest*(arr[base+1]-arr[base]) : arr[base];
}

/* ---------------------------------------------------------------------
   RECURRING / SUBSCRIPTION DETECTION
--------------------------------------------------------------------- */
function detectRecurring(txs){
  const debits = txs.filter(t=>t.amount<0);
  const groups = {};
  debits.forEach(t=>{
    const key = normMerchant(t);
    if (!key) return;
    (groups[key]=groups[key]||[]).push(t);
  });

  const recurring = [];
  Object.entries(groups).forEach(([key, list])=>{
    if (list.length < 2) return;
    list.sort((a,b)=>a.date-b.date);
    const gaps = [];
    for (let i=1;i<list.length;i++){
      gaps.push((list[i].date - list[i-1].date)/86400000);
    }
    const avgGap = gaps.reduce((a,b)=>a+b,0)/gaps.length;
    const amounts = list.map(t=>Math.abs(t.amount));
    const avgAmt = amounts.reduce((a,b)=>a+b,0)/amounts.length;
    const amtVariance = Math.max(...amounts) - Math.min(...amounts);
    const consistent = amtVariance < avgAmt * 0.15 + 2;

    if (list.length >= 2 && avgGap >= 5 && avgGap <= 40 && consistent){
      let freq = 'Monthly';
      if (avgGap < 10) freq='Weekly';
      else if (avgGap < 20) freq='Bi-weekly';
      recurring.push({
        merchant: list[list.length-1].merchant || list[list.length-1].description,
        count: list.length,
        avgAmount: avgAmt,
        lastAmount: amounts[amounts.length-1],
        lastDate: list[list.length-1].date,
        currency: list[0].currency,
        freq,
        category: list[list.length-1].category,
        txs: list
      });
    }
  });

  recurring.sort((a,b)=> b.avgAmount - a.avgAmount);
  return recurring;
}

/* ---------------------------------------------------------------------
   ANALYTICS / AGGREGATES
--------------------------------------------------------------------- */
function computeStats(txs){
  const income = txs.filter(t=>t.amount>0 && (t.kind==='income')).reduce((s,t)=>s+t.amount,0);
  const spending = txs.filter(t=>t.amount<0 && t.kind!=='savings' && t.kind!=='transfer_p2p').reduce((s,t)=>s+Math.abs(t.amount),0);
  const transfersOut = txs.filter(t=>t.amount<0 && t.kind==='transfer_p2p').reduce((s,t)=>s+Math.abs(t.amount),0);
  const transfersIn = txs.filter(t=>t.amount>0 && t.kind==='transfer_p2p').reduce((s,t)=>s+t.amount,0);
  const savingsMoved = txs.filter(t=>t.kind==='savings' && t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0);
  const net = txs.reduce((s,t)=>s+t.amount,0);

  const dates = txs.map(t=>t.date).filter(Boolean);
  const minDate = dates.length ? new Date(Math.min(...dates)) : null;
  const maxDate = dates.length ? new Date(Math.max(...dates)) : null;

  return {income, spending, transfersOut, transfersIn, savingsMoved, net, minDate, maxDate, count: txs.length};
}

function computeCategoryBreakdown(txs){
  // "Spending" here means actual outflow on goods/services/bills — it excludes
  // internal moves (savings/pockets) and P2P transfers, which are money changing
  // hands between people rather than being spent. P2P is tracked separately.
  const spend = txs.filter(t=>t.amount<0 && t.kind!=='savings' && t.kind!=='transfer_p2p');
  const byCat = {};
  spend.forEach(t=>{
    byCat[t.category] = (byCat[t.category]||0) + Math.abs(t.amount);
  });
  const total = Object.values(byCat).reduce((a,b)=>a+b,0) || 1;
  return Object.entries(byCat)
    .map(([key, amt])=>({key, amt, pct: amt/total*100, meta: CAT_MAP[key]||CAT_MAP.other}))
    .sort((a,b)=>b.amt-a.amt);
}

function computeMonthlyFlow(txs){
  const months = {};
  txs.forEach(t=>{
    const key = fmtMonthKey(t.date);
    months[key] = months[key] || {income:0, spending:0};
    if (t.amount>0 && (t.kind==='income')) months[key].income += t.amount;
    else if (t.amount<0 && t.kind!=='savings' && t.kind!=='transfer_p2p') months[key].spending += Math.abs(t.amount);
  });
  const keys = Object.keys(months).sort();
  return keys.map(k=>({key:k, label:fmtMonthLabel(k), ...months[k]}));
}

function computeBalanceSeries(txs, account){
  const withBal = txs.filter(t=> t.balance!=null && (!account || t.account===account));
  // ING statements list transactions in true posting order (fileSeq), newest first;
  // that order is more reliable for balance continuity than the calendar date field,
  // since same-day transactions can post in a sequence the date alone can't capture.
  const hasSeq = withBal.some(t=>t.fileSeq!=null);
  if (hasSeq){
    return withBal.slice().sort((a,b)=> (b.fileSeq??0) - (a.fileSeq??0));
  }
  return withBal.slice().sort((a,b)=>a.date-b.date);
}

function generateInsights(txs, stats, catBreakdown, anomalies, recurring){
  const insights = [];

  if (stats.income > 0){
    const leftover = stats.income - stats.spending;
    const rate = (leftover / stats.income) * 100;
    if (rate < 0){
      insights.push({icon:'📉', html:`Category spending alone (<b>${fmtMoney(stats.spending,'RON')}</b>) came to <span class="r">${Math.abs(rate).toFixed(0)}% more</span> than tracked income (<b>${fmtMoney(stats.income,'RON')}</b>) — before counting P2P transfers or savings moves.`});
    } else {
      insights.push({icon:'📈', html:`Tracked spending used about <span class="g">${(100-rate).toFixed(0)}%</span> of income this period, leaving roughly <b>${fmtMoney(leftover,'RON')}</b> before transfers and savings.`});
    }
  }

  if (catBreakdown.length){
    const top = catBreakdown[0];
    insights.push({icon: top.meta.icon, html:`<b>${top.meta.label}</b> is your largest spending category at <b>${fmtMoney(top.amt,'RON')}</b> (${top.pct.toFixed(0)}% of tracked spending).`});
  }

  if (recurring.length){
    const totalMonthly = recurring.filter(r=>r.freq==='Monthly').reduce((s,r)=>s+r.avgAmount,0);
    if (totalMonthly > 0){
      insights.push({icon:'🔁', html:`<b>${recurring.filter(r=>r.freq==='Monthly').length}</b> recurring monthly payments detected, totaling about <span class="a">${fmtMoney(totalMonthly,'RON')}/mo</span>.`});
    }
  }

  const highAnomalies = anomalies.filter(a=>a.severity==='high');
  if (highAnomalies.length){
    insights.push({icon:'⚠️', html:`<span class="a">${highAnomalies.length} high-priority anomal${highAnomalies.length===1?'y':'ies'}</span> flagged — including possible duplicate charges. Check the Anomalies tab.`});
  }

  const p2pOut = txs.filter(t=>t.kind==='transfer_p2p' && t.amount<0);
  if (p2pOut.length >= 5){
    const uniqueRecipients = new Set(p2pOut.map(t=>normMerchant(t))).size;
    insights.push({icon:'👥', html:`<b>${p2pOut.length}</b> peer-to-peer payments sent to <b>${uniqueRecipients}</b> different people, totaling ${fmtMoney(p2pOut.reduce((s,t)=>s+Math.abs(t.amount),0),'RON')}.`});
  }

  const weekendSpend = txs.filter(t=>t.amount<0 && t.kind==='purchase' && [0,6].includes(t.date.getUTCDay()));
  const weekdaySpend = txs.filter(t=>t.amount<0 && t.kind==='purchase' && ![0,6].includes(t.date.getUTCDay()));
  if (weekendSpend.length > 3 && weekdaySpend.length > 3){
    const wkndAvg = weekendSpend.reduce((s,t)=>s+Math.abs(t.amount),0)/weekendSpend.length;
    const wkdyAvg = weekdaySpend.reduce((s,t)=>s+Math.abs(t.amount),0)/weekdaySpend.length;
    if (wkndAvg > wkdyAvg * 1.4){
      insights.push({icon:'🎉', html:`Weekend purchases average <b>${fmtMoney(wkndAvg,'RON')}</b> vs <b>${fmtMoney(wkdyAvg,'RON')}</b> on weekdays — spending skews noticeably higher on weekends.`});
    }
  }

  const accounts = new Set(txs.map(t=>t.account));
  if (accounts.size > 1){
    insights.push({icon:'🏦', html:`Activity spans <b>${accounts.size} accounts</b>. Balances and totals below are shown per-account where it matters.`});
  }

  return insights;
}

window.LEDGER_PARSERS = { parseING, parseRevolut, parseGeneric, looksLikeINGFormat, looksLikeRevolutFormat, csvSplitLine };
window.LEDGER_STATE = STATE;
window.LEDGER_CATEGORIES = CATEGORIES;
window.LEDGER_CAT_MAP = CAT_MAP;
window.LEDGER_HELPERS = { fmtDate, fmtMoney, fmtMonthKey, fmtMonthLabel, guessCategory, nextId, escapeHtml, normMerchant, merchantKey };
window.LEDGER_ANALYTICS = { detectAnomalies, detectRecurring, computeStats, computeCategoryBreakdown, computeMonthlyFlow, computeBalanceSeries, generateInsights, quantile };
window.LEDGER_INGEST = { handleFiles, detectAndParse };

})();
