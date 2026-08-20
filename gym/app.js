/* ============================================================
   NULLVAULT — training log
   Vanilla JS, offline-first, localStorage-backed.
   ============================================================ */
(function(){
'use strict';

const STORAGE_KEY = 'gymtracker_data_v1';
const LB_PER_KG = 2.20462;

/* ---------------- STATE ---------------- */
let state = loadState();
let currentView = 'home';
let activeWorkout = null; // {startedAt, exercises:[{exId, name, sets:[{weight,reps,done}], notes}]}
let workoutTimerInterval = null;
let calCursor = new Date(); // month being viewed in calendar
let customExercises = [];

function defaultState(){
  return {
    sessions: [],          // {id, date(ISO), exercises:[{exId,name,sets,notes}], durationMin, kcal, type}
    settings: {
      bodyWeightKg: 75,
      weeklyGoal: 4,
      useLbs: false,
      lastBackupAt: null
    },
    customExercises: []
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed, {
      settings: Object.assign(defaultState().settings, parsed.settings || {})
    });
  }catch(e){
    console.error('Failed to load state', e);
    return defaultState();
  }
}

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ---------------- HELPERS ---------------- */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function fmtDateISO(d){ return d.toISOString().slice(0,10); }
function todayISO(){ return fmtDateISO(new Date()); }
function parseISO(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }
function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function allExercises(){ return EXERCISE_DB.concat(state.customExercises); }
function findExercise(id){ return allExercises().find(e=>e.id===id); }
function kgToDisplay(kg){ return state.settings.useLbs ? Math.round(kg*LB_PER_KG*10)/10 : kg; }
function displayToKg(val){ return state.settings.useLbs ? val/LB_PER_KG : val; }
function unitLabel(){ return state.settings.useLbs ? 'lb' : 'kg'; }

function toast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------------- KCAL ESTIMATION ----------------
   Strength: kcal = MET * bodyWeightKg * (setTime_hr) — approximated using
   ~30s effective work time per set at moderate intensity.
   Cardio/incline walk: standard treadmill MET formula (ACSM walking) adjusted for grade.
------------------------------------------------- */
function estimateSetKcal(met, bodyWeightKg, seconds){
  // kcal = MET * 3.5 * weight(kg) / 200 * minutes
  const minutes = seconds/60;
  return met * 3.5 * bodyWeightKg / 200 * minutes;
}

function estimateStrengthExerciseKcal(exercise, sets, bodyWeightKg){
  const met = exercise.met || 4.5;
  const workSeconds = sets.filter(s=>s.done).length * 35; // ~35s time-under-tension per set
  return estimateSetKcal(met, bodyWeightKg, workSeconds);
}

// ACSM walking MET estimate: VO2 (ml/kg/min) = 0.1*speed(m/min) + 1.8*speed(m/min)*grade + 3.5
function estimateInclineWalkKcal(speedKmh, inclinePct, minutes, bodyWeightKg){
  const speedMmin = (speedKmh*1000)/60;
  const grade = inclinePct/100;
  const vo2 = 0.1*speedMmin + 1.8*speedMmin*grade + 3.5;
  const met = vo2/3.5;
  return estimateSetKcal(met, bodyWeightKg, minutes*60);
}

function estimateCardioKcal(exercise, minutes, bodyWeightKg){
  return estimateSetKcal(exercise.met, bodyWeightKg, minutes*60);
}

function sessionTotalKcal(session){
  return session.kcal || 0;
}

/* ---------------- NAVIGATION ---------------- */
function showView(name){
  currentView = name;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.view===name);
  });

  const tabbar = document.querySelector('.tabbar');
  if(name==='workout'){
    tabbar.classList.add('hidden');
    document.body.classList.add('workout-active');
  } else {
    tabbar.classList.remove('hidden');
    document.body.classList.remove('workout-active');
  }

  if(name==='home') renderHome();
  if(name==='calendar') renderCalendar();
  if(name==='log') renderExerciseLibrary();
  if(name==='progress') renderProgressList();
  window.scrollTo(0,0);
}

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(btn.dataset.view==='log' && activeWorkout){
      showView('workout');
      renderWorkoutView();
      return;
    }
    showView(btn.dataset.view);
  });
});

document.getElementById('btnSettings').addEventListener('click', ()=>{
  showView('settings');
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-settings').classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  loadSettingsIntoForm();
});

/* ---------------- HOME VIEW ---------------- */
function renderHome(){
  const now = new Date();
  document.getElementById('todayDateLabel').textContent = now.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

  const todaySession = state.sessions.find(s=>s.date===todayISO());
  document.getElementById('todayStatusLabel').textContent = todaySession
    ? `Logged: ${todaySession.exercises.length} exercise${todaySession.exercises.length!==1?'s':''}`
    : 'Ready when you are.';

  // streak
  const streak = computeStreak();
  document.getElementById('streakText').innerHTML = `<b>${streak}</b> day streak`;

  // week stats
  const weekSessions = sessionsInLastNDays(7);
  const weekKcal = Math.round(weekSessions.reduce((a,s)=>a+sessionTotalKcal(s),0));
  document.getElementById('statWeekSessions').textContent = weekSessions.length;
  document.getElementById('statWeekKcal').textContent = weekKcal;
  document.getElementById('statTotalSessions').textContent = state.sessions.length;

  // week ring
  const goal = state.settings.weeklyGoal || 4;
  const pct = Math.min(1, weekSessions.length/goal);
  const circumference = 201;
  document.getElementById('weekRingFg').style.strokeDashoffset = circumference*(1-pct);
  document.getElementById('weekRingPct').textContent = Math.round(pct*100)+'%';

  // week days strip (Mon-Sun of current week)
  const strip = document.getElementById('weekDaysStrip');
  strip.innerHTML = '';
  const dow = ['M','T','W','T','F','S','S'];
  const monday = startOfWeek(now);
  for(let i=0;i<7;i++){
    const d = new Date(monday); d.setDate(monday.getDate()+i);
    const iso = fmtDateISO(d);
    const has = state.sessions.some(s=>s.date===iso);
    const el = document.createElement('div');
    el.className = 'week-day' + (has?' done':'') + (sameDay(d,now)?' today':'');
    el.textContent = dow[i];
    strip.appendChild(el);
  }

  renderRecentSessions();
}

function startOfWeek(d){
  const date = new Date(d);
  const day = (date.getDay()+6)%7; // 0=Mon
  date.setDate(date.getDate()-day);
  date.setHours(0,0,0,0);
  return date;
}

function sessionsInLastNDays(n){
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-n); cutoff.setHours(0,0,0,0);
  return state.sessions.filter(s=>parseISO(s.date) >= cutoff);
}

function computeStreak(){
  if(state.sessions.length===0) return 0;
  const dates = new Set(state.sessions.map(s=>s.date));
  let streak = 0;
  let cursor = new Date(); cursor.setHours(0,0,0,0);
  // if no session today, check if yesterday continues streak (grace)
  if(!dates.has(fmtDateISO(cursor))){
    cursor.setDate(cursor.getDate()-1);
  }
  while(dates.has(fmtDateISO(cursor))){
    streak++;
    cursor.setDate(cursor.getDate()-1);
  }
  return streak;
}

function renderRecentSessions(){
  const list = document.getElementById('recentSessionsList');
  const sorted = [...state.sessions].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
  if(sorted.length===0){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4v16M18 4v16M2 9h4M2 15h4M18 9h4M18 15h4M6 12h12"/></svg>
      <p>No sessions logged yet. Start your first session to begin building your log.</p>
    </div>`;
    return;
  }
  list.innerHTML = sorted.map(s=>{
    const d = parseISO(s.date);
    const exNames = s.exercises.slice(0,3).map(e=>e.name).join(', ');
    const more = s.exercises.length>3 ? ` +${s.exercises.length-3}` : '';
    return `<div class="session-item" data-session="${s.id}">
      <div class="session-date-badge">
        <div class="d num">${d.getDate()}</div>
        <div class="m">${d.toLocaleDateString(undefined,{month:'short'})}</div>
      </div>
      <div class="session-info">
        <div class="session-title">${s.exercises.length} exercise${s.exercises.length!==1?'s':''}${s.type==='walk'?' · Walk':''}</div>
        <div class="session-meta">${exNames}${more || (s.exercises.length===0?'Cardio session':'')}</div>
      </div>
      <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
    </div>`;
  }).join('');
}

/* ---------------- START SESSION / WORKOUT LOGGING ---------------- */
document.getElementById('btnStartSession').addEventListener('click', ()=>{
  if(!activeWorkout){
    activeWorkout = {
      startedAt: Date.now(),
      exercises: []
    };
    startWorkoutTimer();
  }
  showView('workout');
  renderWorkoutView();
});

function startWorkoutTimer(){
  clearInterval(workoutTimerInterval);
  workoutTimerInterval = setInterval(()=>{
    if(!activeWorkout) return;
    const el = document.getElementById('workoutTimerLabel');
    if(el) el.textContent = formatElapsed(Date.now()-activeWorkout.startedAt);
  }, 1000);
}

function formatElapsed(ms){
  const totalSec = Math.floor(ms/1000);
  const m = Math.floor(totalSec/60).toString().padStart(2,'0');
  const s = (totalSec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

document.getElementById('btnAddExercise').addEventListener('click', ()=>{
  showView('log');
  renderExerciseLibrary();
});

function renderWorkoutView(){
  if(!activeWorkout){
    document.getElementById('workoutExerciseCards').innerHTML='';
    document.getElementById('workoutEmptyState').style.display='block';
    return;
  }
  document.getElementById('workoutExCount').textContent = `${activeWorkout.exercises.length} exercise${activeWorkout.exercises.length!==1?'s':''}`;
  document.getElementById('workoutTimerLabel').textContent = formatElapsed(Date.now()-activeWorkout.startedAt);

  const wrap = document.getElementById('workoutExerciseCards');
  const empty = document.getElementById('workoutEmptyState');
  if(activeWorkout.exercises.length===0){
    wrap.innerHTML='';
    empty.style.display='block';
    // still need finish bar controls
    ensureFinishBar();
    return;
  }
  empty.style.display='none';

  wrap.innerHTML = activeWorkout.exercises.map((ex,exIdx)=>{
    const exDef = findExercise(ex.exId) || {name:ex.name, met:4.5};
    const history = getExerciseHistory(ex.exId);
    const best = history.length ? Math.max(...history.map(h=>h.maxWeight)) : 0;
    const currentMax = Math.max(0,...ex.sets.map(s=>parseFloat(s.weight)||0));
    const isPR = best>0 && currentMax>best;

    const sparkPoints = history.slice(-6).map(h=>h.maxWeight);
    const sparkline = sparkPoints.length>=2 ? buildSparkline(sparkPoints) : '';

    return `<div class="logging-exercise-card" data-ex-idx="${exIdx}">
      <div class="logging-exercise-header">
        <h3>${ex.name}</h3>
        <button class="remove-ex-btn" data-remove-ex="${exIdx}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
        </button>
      </div>
      ${sparkline ? `<div class="sparkline-row">${sparkline}<span class="sparkline-label">last ${sparkPoints.length} sessions</span>${isPR?'<span class="pr-badge">PR</span>':''}</div>` : ''}
      <div class="set-headers">
        <span>#</span><span>${unitLabel()}</span><span>Reps</span><span>RPE</span><span></span>
      </div>
      ${ex.sets.map((set,setIdx)=>`
        <div class="set-row">
          <div class="set-num num">${setIdx+1}</div>
          <input type="number" inputmode="decimal" placeholder="0" value="${set.weight||''}" data-set-field="weight" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <input type="number" inputmode="numeric" placeholder="0" value="${set.reps||''}" data-set-field="reps" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <input type="number" inputmode="numeric" placeholder="–" min="1" max="10" value="${set.rpe||''}" data-set-field="rpe" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <button class="set-check ${set.done?'checked':''}" data-toggle-done="${exIdx}:${setIdx}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </div>
      `).join('')}
      <button class="add-set-btn" data-add-set="${exIdx}">+ Add set</button>
      <textarea class="notes-input" rows="1" placeholder="Notes (optional)" data-notes-ex="${exIdx}">${ex.notes||''}</textarea>
    </div>`;
  }).join('');

  ensureFinishBar();
  attachWorkoutCardListeners();
}

function ensureFinishBar(){
  if(document.getElementById('finishBar')) return;
  const bar = document.createElement('div');
  bar.className = 'finish-bar';
  bar.id = 'finishBar';
  bar.innerHTML = `
    <button class="btn btn-ghost" id="btnCancelWorkout">Cancel</button>
    <button class="btn btn-primary" id="btnFinishWorkout">Finish session</button>
  `;
  document.body.appendChild(bar);
  document.getElementById('btnCancelWorkout').addEventListener('click', cancelWorkout);
  document.getElementById('btnFinishWorkout').addEventListener('click', finishWorkout);
}

function removeFinishBar(){
  const bar = document.getElementById('finishBar');
  if(bar) bar.remove();
}

function attachWorkoutCardListeners(){
  document.querySelectorAll('[data-set-field]').forEach(input=>{
    input.addEventListener('input', (e)=>{
      const exIdx = +e.target.dataset.exIdx, setIdx = +e.target.dataset.setIdx, field = e.target.dataset.setField;
      activeWorkout.exercises[exIdx].sets[setIdx][field] = e.target.value;
    });
  });
  document.querySelectorAll('[data-toggle-done]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const [exIdx,setIdx] = e.currentTarget.dataset.toggleDone.split(':').map(Number);
      const set = activeWorkout.exercises[exIdx].sets[setIdx];
      set.done = !set.done;
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-add-set]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.addSet;
      const sets = activeWorkout.exercises[exIdx].sets;
      const last = sets[sets.length-1];
      sets.push({weight:last?last.weight:'', reps:last?last.reps:'', rpe:'', done:false});
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-remove-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.removeEx;
      activeWorkout.exercises.splice(exIdx,1);
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-notes-ex]').forEach(ta=>{
    ta.addEventListener('input',(e)=>{
      activeWorkout.exercises[+e.target.dataset.notesEx].notes = e.target.value;
    });
  });
}

function buildSparkline(points){
  const w=90,h=26,pad=3;
  const min = Math.min(...points), max = Math.max(...points);
  const range = (max-min)||1;
  const stepX = (w-pad*2)/(points.length-1);
  const coords = points.map((p,i)=>{
    const x = pad+i*stepX;
    const y = h-pad-((p-min)/range)*(h-pad*2);
    return [x,y];
  });
  const path = coords.map((c,i)=>(i===0?'M':'L')+c[0].toFixed(1)+' '+c[1].toFixed(1)).join(' ');
  const lastPoint = coords[coords.length-1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${path}" fill="none" stroke="#39ff9a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="2.5" fill="#39ff9a"/>
  </svg>`;
}

function getExerciseHistory(exId){
  const out = [];
  const sorted = [...state.sessions].sort((a,b)=>a.date.localeCompare(b.date));
  sorted.forEach(s=>{
    const ex = s.exercises.find(e=>e.exId===exId);
    if(ex && ex.sets && ex.sets.length){
      const weights = ex.sets.map(st=>parseFloat(st.weight)||0).filter(w=>w>0);
      if(weights.length) out.push({date:s.date, maxWeight:Math.max(...weights)});
    }
  });
  return out;
}

function cancelWorkout(){
  if(activeWorkout.exercises.length>0){
    if(!confirm('Discard this session? All logged sets will be lost.')) return;
  }
  activeWorkout = null;
  clearInterval(workoutTimerInterval);
  removeFinishBar();
  showView('home');
}

function finishWorkout(){
  if(activeWorkout.exercises.length===0){
    toast('Add at least one exercise first');
    return;
  }
  const durationMin = Math.max(1, Math.round((Date.now()-activeWorkout.startedAt)/60000));
  const bodyWeightKg = state.settings.bodyWeightKg || 75;

  let totalKcal = 0;
  const exercisesOut = activeWorkout.exercises.map(ex=>{
    const def = findExercise(ex.exId) || {met:4.5};
    const completedSets = ex.sets.filter(s=>s.done && (s.weight||s.reps));
    const kcal = estimateStrengthExerciseKcal(def, ex.sets, bodyWeightKg);
    totalKcal += kcal;
    return {
      exId: ex.exId,
      name: ex.name,
      sets: ex.sets.filter(s=>s.weight||s.reps||s.done).map(s=>({
        weight: displayToKgIfNeeded(s.weight),
        reps: s.reps||'',
        rpe: s.rpe||'',
        done: !!s.done
      })),
      notes: ex.notes||''
    };
  }).filter(ex=>ex.sets.length>0);

  if(exercisesOut.length===0){
    toast('Log at least one set before finishing');
    return;
  }

  const session = {
    id: uid(),
    date: todayISO(),
    exercises: exercisesOut,
    durationMin,
    kcal: Math.round(totalKcal),
    type: 'strength'
  };

  // merge with existing session today if present
  const existingIdx = state.sessions.findIndex(s=>s.date===session.date && s.type==='strength');
  if(existingIdx>=0){
    const existing = state.sessions[existingIdx];
    existing.exercises = existing.exercises.concat(exercisesOut);
    existing.kcal += session.kcal;
    existing.durationMin += durationMin;
  } else {
    state.sessions.push(session);
  }
  saveState();

  activeWorkout = null;
  clearInterval(workoutTimerInterval);
  removeFinishBar();
  showSessionSummary(session);
}

function displayToKgIfNeeded(val){
  if(val==='' || val==null) return val;
  const n = parseFloat(val);
  if(isNaN(n)) return val;
  return state.settings.useLbs ? Math.round((n/LB_PER_KG)*100)/100 : n;
}

function showSessionSummary(session){
  const content = document.getElementById('summaryContent');
  const totalSets = session.exercises.reduce((a,e)=>a+e.sets.length,0);
  content.innerHTML = `
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-box"><div class="v num">${session.exercises.length}</div><div class="l">Exercises</div></div>
      <div class="stat-box"><div class="v num">${totalSets}</div><div class="l">Sets</div></div>
      <div class="stat-box"><div class="v num" style="color:var(--positive);">${session.kcal}</div><div class="l">Kcal burned</div></div>
    </div>
    <div class="mt-16">
      ${session.exercises.map(e=>`<div class="row" style="padding:8px 2px; border-bottom:1px solid var(--border-soft);">
        <span class="text-sm">${e.name}</span>
        <span class="text-sm text-faint num">${e.sets.length} sets</span>
      </div>`).join('')}
    </div>
  `;
  openSheet('sheetSessionSummary');
}

document.getElementById('btnCloseSummary').addEventListener('click', ()=>{
  closeSheet('sheetSessionSummary');
  showView('home');
});

/* ---------------- EXERCISE LIBRARY (picker) ---------------- */
let activeMuscleFilter = 'all';

function renderMuscleFilters(){
  const wrap = document.getElementById('muscleFilterScroll');
  wrap.innerHTML = MUSCLE_GROUPS.map(g=>
    `<button class="chip ${g.id===activeMuscleFilter?'active':''}" data-muscle="${g.id}">${g.label}</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      activeMuscleFilter = chip.dataset.muscle;
      renderExerciseLibrary();
    });
  });
}

function renderExerciseLibrary(){
  renderMuscleFilters();
  const barWrap = document.getElementById('activeSessionBarWrap');
  barWrap.innerHTML = activeWorkout ? `<div class="pill pill-accent mb-12">Session active — adding to current workout</div>` : '';

  const query = (document.getElementById('exerciseSearchInput').value||'').toLowerCase().trim();
  let list = allExercises().filter(e=>{
    const matchesMuscle = activeMuscleFilter==='all' || e.muscle===activeMuscleFilter;
    const matchesQuery = !query || e.name.toLowerCase().includes(query);
    return matchesMuscle && matchesQuery;
  });

  const container = document.getElementById('exerciseLibraryList');
  if(list.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <p>No exercises match "${query}".</p>
    </div>`;
    return;
  }

  container.innerHTML = list.map(e=>`
    <div class="exercise-list-item" data-ex-id="${e.id}">
      <div class="ex-icon">${e.icon}</div>
      <div class="ex-info">
        <div class="ex-name">${e.name}</div>
        <div class="ex-meta">${capitalize(e.muscle)} · ${capitalize(e.type)}</div>
      </div>
      <button class="ex-add-btn" data-add-ex="${e.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `).join('');

  container.querySelectorAll('[data-add-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      addExerciseToWorkout(btn.dataset.addEx);
    });
  });
  container.querySelectorAll('.exercise-list-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      addExerciseToWorkout(item.dataset.exId);
    });
  });
}

function capitalize(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

function addExerciseToWorkout(exId){
  const def = findExercise(exId);
  if(!def) return;
  if(!activeWorkout){
    activeWorkout = {startedAt: Date.now(), exercises:[]};
    startWorkoutTimer();
  }
  activeWorkout.exercises.push({
    exId: def.id,
    name: def.name,
    sets: [{weight:'', reps:'', rpe:'', done:false}],
    notes:''
  });
  toast(`Added ${def.name}`);
  showView('workout');
  renderWorkoutView();
}

document.getElementById('exerciseSearchInput').addEventListener('input', renderExerciseLibrary);

/* ---------------- QUICK WALK LOGGING ---------------- */
document.getElementById('btnQuickWalk').addEventListener('click', ()=>{
  document.getElementById('walkDuration').value = 30;
  document.getElementById('walkSpeed').value = 5.5;
  document.getElementById('walkIncline').value = 8;
  updateWalkPreview();
  openSheet('sheetQuickWalk');
});

['walkDuration','walkSpeed','walkIncline'].forEach(id=>{
  document.getElementById(id).addEventListener('input', updateWalkPreview);
});

function updateWalkPreview(){
  const dur = parseFloat(document.getElementById('walkDuration').value)||0;
  const speed = parseFloat(document.getElementById('walkSpeed').value)||0;
  const incline = parseFloat(document.getElementById('walkIncline').value)||0;
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = estimateInclineWalkKcal(speed, incline, dur, bw);
  document.getElementById('walkKcalPreview').textContent = Math.round(kcal);
}

document.getElementById('btnSaveWalk').addEventListener('click', ()=>{
  const dur = parseFloat(document.getElementById('walkDuration').value)||0;
  const speed = parseFloat(document.getElementById('walkSpeed').value)||0;
  const incline = parseFloat(document.getElementById('walkIncline').value)||0;
  if(dur<=0){ toast('Enter a duration'); return; }
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = Math.round(estimateInclineWalkKcal(speed, incline, dur, bw));

  const session = {
    id: uid(),
    date: todayISO(),
    exercises: [{
      exId: 'incline-walk',
      name: `Incline Walk (${incline}% @ ${speed} km/h)`,
      sets: [{weight:incline, reps:dur, rpe:'', done:true, isWalk:true, speed, incline, duration:dur}],
      notes: ''
    }],
    durationMin: dur,
    kcal,
    type: 'walk'
  };

  const existingIdx = state.sessions.findIndex(s=>s.date===session.date && s.type==='walk');
  if(existingIdx>=0){
    state.sessions[existingIdx].exercises.push(session.exercises[0]);
    state.sessions[existingIdx].kcal += kcal;
    state.sessions[existingIdx].durationMin += dur;
  } else {
    state.sessions.push(session);
  }
  saveState();
  closeSheet('sheetQuickWalk');
  toast(`Saved · ${kcal} kcal`);
  renderHome();
});

/* ---------------- CALENDAR VIEW ---------------- */
function renderCalendar(){
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  document.getElementById('calMonthLabel').textContent = calCursor.toLocaleDateString(undefined,{month:'long', year:'numeric'});

  const dowRow = document.getElementById('calDowRow');
  dowRow.innerHTML = ['M','T','W','T','F','S','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

  const grid = document.getElementById('calGrid');
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay()+6)%7; // Monday=0
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const today = new Date();

  let cells = [];
  for(let i=0;i<startOffset;i++) cells.push(null);
  for(let d=1; d<=daysInMonth; d++) cells.push(d);

  const sessionDatesInMonth = {};
  state.sessions.forEach(s=>{
    const sd = parseISO(s.date);
    if(sd.getFullYear()===year && sd.getMonth()===month){
      sessionDatesInMonth[sd.getDate()] = (sessionDatesInMonth[sd.getDate()]||0) + sessionTotalKcal(s);
    }
  });

  grid.innerHTML = cells.map(d=>{
    if(d===null) return `<div class="cal-cell empty"></div>`;
    const trained = sessionDatesInMonth[d]!==undefined;
    const isToday = sameDay(new Date(year,month,d), today);
    return `<div class="cal-cell ${trained?'trained':''} ${isToday?'today':''}" data-day="${d}">
      <span class="num">${d}</span>
      ${trained?'<span class="dot"></span>':''}
    </div>`;
  }).join('');

  // month summary
  const monthSessions = state.sessions.filter(s=>{
    const sd = parseISO(s.date);
    return sd.getFullYear()===year && sd.getMonth()===month;
  });
  document.getElementById('monthSessions').textContent = monthSessions.length;
  document.getElementById('monthKcal').textContent = Math.round(monthSessions.reduce((a,s)=>a+sessionTotalKcal(s),0));

  const list = document.getElementById('calSessionsList');
  if(monthSessions.length===0){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      <p>No sessions logged this month yet.</p>
    </div>`;
  } else {
    const sorted = [...monthSessions].sort((a,b)=>b.date.localeCompare(a.date));
    list.innerHTML = sorted.map(s=>{
      const d = parseISO(s.date);
      return `<div class="session-item" data-session="${s.id}">
        <div class="session-date-badge">
          <div class="d num">${d.getDate()}</div>
          <div class="m">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>
        </div>
        <div class="session-info">
          <div class="session-title">${s.exercises.length} exercise${s.exercises.length!==1?'s':''}${s.type==='walk'?' · Walk':''}</div>
          <div class="session-meta">${s.durationMin} min</div>
        </div>
        <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
      </div>`;
    }).join('');
  }
}

document.getElementById('calPrevMonth').addEventListener('click', ()=>{
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth()-1, 1);
  renderCalendar();
});
document.getElementById('calNextMonth').addEventListener('click', ()=>{
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth()+1, 1);
  renderCalendar();
});

/* ---------------- PROGRESS VIEW ---------------- */
function renderProgressList(){
  const query = (document.getElementById('progressSearchInput').value||'').toLowerCase().trim();

  // build map of exId -> {name, sessions[]}
  const map = {};
  state.sessions.forEach(s=>{
    s.exercises.forEach(ex=>{
      if(!ex.sets || !ex.sets.length) return;
      if(!map[ex.exId]) map[ex.exId] = {name:ex.name, entries:[]};
      const weights = ex.sets.map(st=>parseFloat(st.weight)||0).filter(w=>w>0);
      const maxW = weights.length ? Math.max(...weights) : 0;
      const totalReps = ex.sets.reduce((a,st)=>a+(parseFloat(st.reps)||0),0);
      map[ex.exId].entries.push({date:s.date, maxWeight:maxW, sets:ex.sets.length, totalReps});
    });
  });

  let entries = Object.entries(map);
  if(query){
    entries = entries.filter(([id,v])=>v.name.toLowerCase().includes(query));
  }
  entries.sort((a,b)=>b[1].entries.length-a[1].entries.length);

  const container = document.getElementById('progressList');
  if(entries.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v18h18"/><path d="M18 8l-5 5-3-3-4 4"/></svg>
      <p>${query? 'No matching exercises logged yet.' : 'Log a few sessions to see your strength progress here.'}</p>
    </div>`;
    return;
  }

  container.innerHTML = entries.map(([exId,v])=>{
    const sorted = v.entries.sort((a,b)=>a.date.localeCompare(b.date));
    const points = sorted.map(e=>e.maxWeight).filter(w=>w>0);
    const best = points.length ? Math.max(...points) : 0;
    const latest = sorted[sorted.length-1];
    const spark = points.length>=2 ? buildSparkline(points.slice(-10)) : '<span class="text-faint text-sm">Not enough data</span>';
    const displayBest = kgToDisplay(best);
    return `<div class="progress-ex-card">
      <div class="progress-ex-header">
        <h3>${v.name}</h3>
        <span class="pill">${sorted.length} session${sorted.length!==1?'s':''}</span>
      </div>
      <div class="sparkline-row mt-8">${spark}<span class="sparkline-label">progression</span></div>
      <div class="progress-ex-stats">
        <div class="progress-ex-stat"><div class="v num">${displayBest||'–'}</div><div class="l">Best ${unitLabel()}</div></div>
        <div class="progress-ex-stat"><div class="v num">${latest.sets}</div><div class="l">Last sets</div></div>
        <div class="progress-ex-stat"><div class="v num">${latest.totalReps}</div><div class="l">Last reps</div></div>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('progressSearchInput').addEventListener('input', renderProgressList);

/* ---------------- SETTINGS ---------------- */
function loadSettingsIntoForm(){
  document.getElementById('settingBodyWeight').value = state.settings.bodyWeightKg;
  document.getElementById('settingWeeklyGoal').value = state.settings.weeklyGoal;
  document.getElementById('toggleUnits').classList.toggle('on', state.settings.useLbs);
  updateLastBackupLabel();
}

document.getElementById('settingBodyWeight').addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  if(!isNaN(v) && v>0){ state.settings.bodyWeightKg = v; saveState(); }
});
document.getElementById('settingWeeklyGoal').addEventListener('input', (e)=>{
  const v = parseInt(e.target.value);
  if(!isNaN(v) && v>0){ state.settings.weeklyGoal = v; saveState(); }
});
document.getElementById('toggleUnits').addEventListener('click', (e)=>{
  state.settings.useLbs = !state.settings.useLbs;
  e.target.classList.toggle('on', state.settings.useLbs);
  saveState();
  toast(state.settings.useLbs ? 'Switched to lbs' : 'Switched to kg');
});

function updateLastBackupLabel(){
  const el = document.getElementById('lastBackupLabel');
  if(state.settings.lastBackupAt){
    const d = new Date(state.settings.lastBackupAt);
    el.textContent = `Last backup exported ${d.toLocaleDateString()} at ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
  } else {
    el.textContent = 'No backup exported yet.';
  }
}

/* ---------------- BACKUP / RESTORE ---------------- */
document.getElementById('btnExportBackup').addEventListener('click', ()=>{
  const payload = {
    app: 'gym-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = todayISO();
  a.href = url;
  a.download = `gym-tracker-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  state.settings.lastBackupAt = Date.now();
  saveState();
  updateLastBackupLabel();
  toast('Backup exported');
});

document.getElementById('btnImportBackup').addEventListener('click', ()=>{
  document.getElementById('fileImportInput').click();
});

document.getElementById('fileImportInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (evt)=>{
    try{
      const parsed = JSON.parse(evt.target.result);
      const incoming = parsed.data || parsed; // support raw state too
      if(!incoming.sessions || !Array.isArray(incoming.sessions)){
        toast('Invalid backup file');
        return;
      }
      const doMerge = confirm(
        `This backup contains ${incoming.sessions.length} session(s).\n\nOK = Merge with current data\nCancel = Replace current data entirely`
      );
      if(doMerge){
        mergeState(incoming);
      } else {
        state = Object.assign(defaultState(), incoming, {
          settings: Object.assign(defaultState().settings, incoming.settings||{})
        });
      }
      saveState();
      toast('Backup restored');
      renderHome();
      loadSettingsIntoForm();
    }catch(err){
      console.error(err);
      toast('Could not read backup file');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function mergeState(incoming){
  const existingIds = new Set(state.sessions.map(s=>s.id));
  incoming.sessions.forEach(s=>{
    if(!existingIds.has(s.id)){
      state.sessions.push(s);
    }
  });
  if(incoming.customExercises){
    const existingCustomIds = new Set(state.customExercises.map(e=>e.id));
    incoming.customExercises.forEach(e=>{
      if(!existingCustomIds.has(e.id)) state.customExercises.push(e);
    });
  }
}

document.getElementById('btnResetAll').addEventListener('click', ()=>{
  if(!confirm('This will permanently erase all sessions and settings on this device. This cannot be undone. Continue?')) return;
  if(!confirm('Are you absolutely sure? Consider exporting a backup first.')) return;
  state = defaultState();
  saveState();
  toast('All data erased');
  showView('home');
});

/* ---------------- SHEETS ---------------- */
function openSheet(id){
  document.getElementById('sheetBackdrop').classList.add('open');
  document.getElementById(id).classList.add('open');
  document.body.classList.add('sheet-open');
}
function closeSheet(id){
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.getElementById(id).classList.remove('open');
  document.body.classList.remove('sheet-open');
}
document.getElementById('sheetBackdrop').addEventListener('click', ()=>{
  document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open'));
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.body.classList.remove('sheet-open');
});

/* ---------------- SESSION DETAIL (tap from list) ---------------- */
document.addEventListener('click', (e)=>{
  const item = e.target.closest('[data-session]');
  if(!item) return;
  const session = state.sessions.find(s=>s.id===item.dataset.session);
  if(!session) return;
  showSessionDetail(session);
});

function showSessionDetail(session){
  const content = document.getElementById('exerciseDetailContent');
  const d = parseISO(session.date);
  content.innerHTML = `
    <div class="sheet-title">${d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</div>
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr); margin-bottom:16px;">
      <div class="stat-box"><div class="v num">${session.exercises.length}</div><div class="l">Exercises</div></div>
      <div class="stat-box"><div class="v num">${session.durationMin}</div><div class="l">Minutes</div></div>
      <div class="stat-box"><div class="v num" style="color:var(--positive);">${Math.round(sessionTotalKcal(session))}</div><div class="l">Kcal</div></div>
    </div>
    ${session.exercises.map(ex=>`
      <div class="mb-12">
        <div class="settings-row-label mb-8">${ex.name}</div>
        ${ex.sets.map((s,i)=>{
          if(s.isWalk){
            return `<div class="text-sm text-muted">${s.duration} min @ ${s.speed} km/h, ${s.incline}% incline</div>`;
          }
          const w = kgToDisplay(parseFloat(s.weight)||0);
          return `<div class="text-sm text-muted num">Set ${i+1}: ${w||'–'} ${unitLabel()} × ${s.reps||'–'} reps${s.rpe?' · RPE '+s.rpe:''}</div>`;
        }).join('')}
        ${ex.notes ? `<div class="text-sm text-faint mt-4">"${ex.notes}"</div>` : ''}
      </div>
    `).join('')}
    <button class="btn btn-danger btn-block mt-16" id="btnDeleteSession" data-del="${session.id}">Delete this session</button>
  `;
  openSheet('sheetExerciseDetail');
  document.getElementById('btnDeleteSession').addEventListener('click', (e)=>{
    if(confirm('Delete this session? This cannot be undone.')){
      state.sessions = state.sessions.filter(s=>s.id!==e.target.dataset.del);
      saveState();
      closeSheet('sheetExerciseDetail');
      renderHome();
      renderCalendar();
      toast('Session deleted');
    }
  });
}

/* ---------------- SERVICE WORKER / PWA ---------------- */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(err=>console.warn('SW registration failed', err));
  });
}

/* ---------------- INIT ---------------- */
function init(){
  showView('home');
  loadSettingsIntoForm();
}
init();

})();
