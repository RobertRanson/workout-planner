/* Workout Planner — a small, dependency-free single page app.
 * All data lives in localStorage on this device; use Settings → Export to back it up. */
'use strict';

const APP_VERSION = '2026-10-18.3';
const STORE_KEY = 'wp:data:v1';
const DRAFT_KEY = 'wp:draft:v1';
const ROTATION = ['chest', 'legs1', 'back', 'legs2', 'upper'];
const DEFAULT_SETTINGS = { rest: 90, weightStep: 1, unit: 'kg', theme: 'auto' };

const $app = document.getElementById('app');
const $rest = document.getElementById('rest');
const $toast = document.getElementById('toast');

let db = null;      // { version, workouts, sessions, videos, settings }
let draft = null;   // in-progress session
let builtinVideos = {}; // "workoutId/exerciseId" -> { video, link } (data/videos.json)

/* ---------- utils ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => toISO(new Date());
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fromISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => fromISO(s).toLocaleDateString(undefined, opts);
function agoText(iso) {
  const n = daysBetween(iso, todayISO());
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  if (n < 730) return `${Math.round(n / 30)} months ago`;
  return `${Math.round(n / 365)} years ago`;
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function parseVal(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : s;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n) => Math.round(n * 100) / 100;

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2200);
}

/* ---------- storage ---------- */

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { toast('Could not save — storage full or blocked'); }
}
function saveDraft() {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch (e) { /* ignore */ }
}
async function load() {
  try { db = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { db = null; }
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { draft = null; }
  if (!db) {
    const seed = await fetch('data/seed.json').then((r) => r.json());
    db = { ...seed, videos: {}, settings: { ...DEFAULT_SETTINGS } };
    save();
  }
  db.videos ||= {};
  try { builtinVideos = await fetch('data/videos.json').then((r) => (r.ok ? r.json() : {})); } catch (e) { builtinVideos = {}; }
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  applyTheme();
}
function applyTheme() {
  const t = db.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

/* ---------- domain helpers ---------- */

const workout = (id) => db.workouts.find((w) => w.id === id);
const exercise = (wid, eid) => workout(wid)?.exercises.find((e) => e.id === eid);
const sortedSessions = () => [...db.sessions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const sessionsOf = (wid) => sortedSessions().filter((s) => s.workout === wid);
const lastSession = (wid) => sessionsOf(wid).at(-1) || null;

/** Most recent logged sets for an exercise, ignoring the session being edited. */
function previousSets(wid, eid, excludeId) {
  const list = sessionsOf(wid).filter((s) => s.id !== excludeId && s.exercises?.[eid]?.some(Boolean));
  const s = list.at(-1);
  return s ? { date: s.date, sets: s.exercises[eid] } : null;
}

/** Next workout in the rotation after the most recent session. */
function upNext() {
  const order = ROTATION.filter((id) => workout(id));
  const recent = sortedSessions().at(-1);
  return recent ? order[(order.indexOf(recent.workout) + 1) % order.length] : order[0];
}

function topSet(sets) {
  let best = null;
  for (const s of sets || []) {
    if (!s) continue;
    if (isNum(s.weight) && (!best || s.weight > best.weight || (s.weight === best.weight && (s.reps || 0) > (best.reps || 0)))) best = s;
  }
  return best;
}
const volume = (sets) => (sets || []).reduce((t, s) => t + (s && isNum(s.weight) && isNum(s.reps) ? s.weight * s.reps : 0), 0);
function setText(s, ex) {
  if (!s) return '—';
  if (ex?.kind === 'time') return s.time != null ? `${s.time}s` : '—';
  const w = s.weight ?? '–';
  const r = s.reps ?? '–';
  return `${w} × ${r}`;
}
const repText = (ex) => {
  if (ex.kind === 'time') return `${ex.sets} sets · hold`;
  const r = ex.reps ? (ex.reps[0] === ex.reps[1] ? `${ex.reps[0]}` : `${ex.reps[0]}–${ex.reps[1]}`) : '';
  return `${ex.sets} × ${r || 'reps'}${ex.each ? ' each side' : ''}`;
};

/** Progressive-overload nudge based on last time's sets. */
function progressionHint(ex, prev) {
  if (!prev || ex.kind === 'time' || !ex.reps) return null;
  const sets = prev.sets.filter(Boolean);
  if (!sets.length) return null;
  const [lo, hi] = ex.reps;
  const allTop = sets.length >= ex.sets && sets.every((s) => isNum(s.reps) && s.reps >= hi);
  if (allTop) return { kind: 'good', text: `You hit ${hi}+ reps on every set last time — time to go heavier.` };
  const under = sets.filter((s) => isNum(s.reps) && s.reps < lo).length;
  if (under) return { kind: 'warn', text: `${under} set${under > 1 ? 's' : ''} fell short of ${lo} reps last time — keep the weight and aim for ${lo}+.` };
  return null;
}

/** YouTube or Vimeo link -> { platform, id }. */
function parseVideo(url) {
  if (!url) return null;
  const s = String(url).trim();
  const yt = s.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { platform: 'youtube', id: yt[1] };
  const vm = s.match(/vimeo\.com\/(?:video\/|.*\/)?(\d{6,})/);
  if (vm) return { platform: 'vimeo', id: vm[1] };
  if (/^[\w-]{11}$/.test(s)) return { platform: 'youtube', id: s };
  return null;
}
const videoKey = (wid, eid) => `${wid}/${eid}`;
/** A video you added yourself wins over the built-in one for that exercise. */
const videoFor = (wid, ex) => parseVideo(db.videos[videoKey(wid, ex.id)]) || parseVideo(builtinVideos[videoKey(wid, ex.id)]?.video);
const linkFor = (wid, ex) => ex.link || builtinVideos[videoKey(wid, ex.id)]?.link || null;
const howTo = (wid, ex) => {
  const link = linkFor(wid, ex);
  return link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">How-to (Muscle &amp; Strength) ↗</a>` : '';
};
function videoEmbed(v, title, link) {
  if (!v) return '';
  const src = v.platform === 'vimeo'
    ? `https://player.vimeo.com/video/${v.id}?dnt=1&playsinline=1`
    : `https://www.youtube-nocookie.com/embed/${v.id}?rel=0&modestbranding=1&playsinline=1`;
  // Some Muscle & Strength Vimeo videos only play on their own site; the player can't tell us, so offer a way out.
  const note = v.platform === 'vimeo'
    ? `<p class="small muted vidnote">Says it can't be played here? ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Watch it on Muscle &amp; Strength ↗</a> or ` : ''}tap Change video to use a YouTube link.</p>`
    : '';
  return `<div class="video"><iframe src="${src}" title="${esc(title)} video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>${note}`;
}

/* ---------- rendering ---------- */

const routes = [
  [/^#?\/?$/, viewHome],
  [/^#\/workout\/([\w-]+)$/, viewWorkout],
  [/^#\/session$/, viewSession],
  [/^#\/history$/, viewHistory],
  [/^#\/history\/(\d{4})$/, viewHistory],
  [/^#\/s\/([\w-]+)$/, viewSavedSession],
  [/^#\/exercise\/([\w-]+)\/([\w-]+)$/, viewExercise],
  [/^#\/settings$/, viewSettings],
];

function render() {
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      const tab = hash.startsWith('#/history') || hash.startsWith('#/s/') ? 'history' : hash.startsWith('#/settings') ? 'settings' : 'home';
      document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
      document.body.classList.toggle('in-session', hash === '#/session');
      fn(...m.slice(1));
      return;
    }
  }
  location.hash = '#/';
}
function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

const wcolor = (wid) => `var(--c-${wid})`;

/* ----- Home ----- */

function viewHome() {
  const nextId = upNext();
  const next = workout(nextId);
  const last = lastSession(nextId);
  const all = sortedSessions();
  const thisWeek = all.filter((s) => s.date >= toISO(mondayOf(new Date()))).length;
  const last30 = all.filter((s) => daysBetween(s.date, todayISO()) < 30).length;

  const resume = draft ? `
    <div class="card next" style="--wc:${wcolor(draft.workout)}">
      <div class="label">In progress</div>
      <h2>${esc(workout(draft.workout)?.name)}</h2>
      <p class="muted small">Started ${esc(fmtDate(draft.date))} · ${countDone(draft)} sets logged</p>
      <div class="row"><a class="btn primary big grow" href="#/session">Resume workout</a>
      <button class="btn ghost" data-act="discard">Discard</button></div>
    </div>` : '';

  $app.innerHTML = `
    ${resume}
    ${draft ? '' : `
    <section class="card next" style="--wc:${wcolor(nextId)}">
      <div class="label">Up next</div>
      <h2>${esc(next.name)}</h2>
      <p class="muted small">${next.exercises.length} exercises · last done ${last ? esc(agoText(last.date).toLowerCase()) : 'never'}</p>
      <div class="row">
        <button class="btn primary big grow" data-start="${nextId}">Start ${esc(next.name)}</button>
        <a class="btn big" href="#/workout/${nextId}">Preview</a>
      </div>
    </section>`}

    <section>
      <div class="stats">
        <div class="stat"><b>${thisWeek}</b><span>this week</span></div>
        <div class="stat"><b>${last30}</b><span>last 30 days</span></div>
        <div class="stat"><b>${all.length}</b><span>all time</span></div>
      </div>
    </section>

    <section>
      <h2>Workouts</h2>
      <div class="wgrid">
        ${ROTATION.map((id) => {
          const w = workout(id); if (!w) return '';
          const l = lastSession(id);
          const due = !l || daysBetween(l.date, todayISO()) > 10;
          return `<a class="wcard ${due ? 'due' : ''}" style="--wc:${wcolor(id)}" href="#/workout/${id}">
            <strong>${esc(w.name)}</strong>
            <span class="ago">${l ? esc(agoText(l.date)) : 'Not done yet'}</span>
            <span class="muted small">${sessionsOf(id).length} sessions</span>
          </a>`;
        }).join('')}
      </div>
    </section>

    <section class="card">
      <div class="row split"><h2>Last 12 weeks</h2><a href="#/history" class="small">Full calendar →</a></div>
      ${calendar(addDays(mondayOf(new Date()), -7 * 11), 12)}
      ${legend()}
    </section>`;

  $app.querySelector('[data-start]')?.addEventListener('click', (e) => startSession(e.currentTarget.dataset.start));
  $app.querySelector('[data-act="discard"]')?.addEventListener('click', discardDraft);
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function calendar(startMonday, weeks, newestFirst = true) {
  const byDate = {};
  for (const s of db.sessions) (byDate[s.date] ||= []).push(s);
  const today = todayISO();
  const rows = [];
  for (let i = 0; i < weeks; i++) {
    const mon = addDays(startMonday, i * 7);
    let cells = `<div class="wk">${esc(mon.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</div>`;
    for (let d = 0; d < 7; d++) {
      const iso = toISO(addDays(mon, d));
      const list = byDate[iso] || [];
      const cls = ['d', list.length ? 'on' : '', iso === today ? 'today' : '', iso > today ? 'future' : ''].join(' ');
      let bg = '';
      if (list.length === 1) bg = `background:${wcolor(list[0].workout)}`;
      else if (list.length > 1) bg = `background:linear-gradient(135deg, ${wcolor(list[0].workout)} 50%, ${wcolor(list[1].workout)} 50%)`;
      const title = list.map((s) => workout(s.workout)?.name).join(', ');
      const day = addDays(mon, d).getDate();
      cells += list.length
        ? `<a class="${cls}" style="${bg}" href="#/s/${esc(list[0].id)}" title="${esc(fmtDate(iso))}: ${esc(title)}">${day}</a>`
        : `<div class="${cls}" title="${esc(fmtDate(iso))}">${day}</div>`;
    }
    rows.push(cells);
  }
  if (newestFirst) rows.reverse();
  return `<div class="cal">
    <div></div>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="h">${d}</div>`).join('')}
    ${rows.join('')}
  </div>`;
}
const legend = () => `<div class="legend">${ROTATION.map((id) => `<span><i class="dot" style="--wc:${wcolor(id)}"></i>${esc(workout(id)?.name)}</span>`).join('')}</div>`;

/* ----- Workout overview ----- */

function viewWorkout(wid) {
  const w = workout(wid);
  if (!w) return go('#/');
  const ss = sessionsOf(wid);
  const last = ss.at(-1);
  $app.innerHTML = `
    <section class="card next" style="--wc:${wcolor(wid)}">
      <div class="label">Workout</div>
      <h1>${esc(w.name)}</h1>
      <p class="muted small">${ss.length} sessions logged · last ${last ? esc(fmtDate(last.date)) + ' (' + esc(agoText(last.date).toLowerCase()) + ')' : 'never'}</p>
      ${draft && draft.workout !== wid ? `<p class="small muted">You have another workout in progress — starting this one will replace it.</p>` : ''}
      <button class="btn primary big block" data-start="${wid}">${draft?.workout === wid ? 'Resume' : 'Start'} workout</button>
    </section>
    <section class="card">
      <h2>Exercises</h2>
      <ul class="exlist">
        ${w.exercises.map((ex, i) => {
          const prev = previousSets(wid, ex.id);
          const top = prev && topSet(prev.sets);
          return `<li><span class="n">${i + 1}</span>
            <a href="#/exercise/${wid}/${ex.id}"><strong>${esc(ex.name)}</strong><br><span class="muted small">${esc(repText(ex))}</span></a>
            <span class="small muted" style="text-align:right">${prev ? (ex.kind === 'time' ? esc(setText(prev.sets.find(Boolean), ex)) : top ? `${esc(top.weight)} ${esc(db.settings.unit)}` : '') + `<br>${esc(fmtDate(prev.date, { day: 'numeric', month: 'short', year: '2-digit' }))}` : ''}</span>
          </li>`;
        }).join('')}
      </ul>
    </section>
    <section class="card">
      <h2>Recent sessions</h2>
      <div class="hist">${ss.slice(-6).reverse().map(histItem).join('') || '<p class="muted">Nothing yet.</p>'}</div>
    </section>`;
  $app.querySelector('[data-start]').addEventListener('click', () => {
    if (draft?.workout === wid) return go('#/session');
    startSession(wid);
  });
}

/* ----- Session flow ----- */

function startSession(wid, existing) {
  if (draft && !existing && draft.workout !== wid && countDone(draft) > 0 && !confirm('Discard the workout in progress?')) return;
  const w = workout(wid);
  draft = {
    id: existing?.id || `${wid}-${Date.now().toString(36)}`,
    editing: !!existing,
    workout: wid,
    date: existing?.date || todayISO(),
    startedAt: Date.now(),
    step: 0,
    notes: existing?.notes || '',
    exercises: Object.fromEntries(w.exercises.map((ex) => {
      const old = existing?.exercises?.[ex.id] || [];
      const n = Math.max(ex.sets, old.length);
      return [ex.id, Array.from({ length: n }, (_, i) => {
        const o = old[i];
        return o ? { ...o, done: true } : (ex.kind === 'time' ? { time: null, done: false } : { weight: null, reps: null, done: false });
      })];
    })),
  };
  saveDraft();
  go('#/session');
}
function countDone(d) { return Object.values(d.exercises).flat().filter((s) => s.done).length; }
function discardDraft() {
  if (!confirm('Discard this workout? Logged sets will be lost.')) return;
  draft = null; saveDraft(); stopRest(); releaseWakeLock(); go('#/');
}

function viewSession() {
  if (!draft) return go('#/');
  const w = workout(draft.workout);
  const steps = w.exercises.length + 1; // last step = finish
  const step = Math.min(draft.step, steps - 1);
  requestWakeLock();
  if (step === w.exercises.length) return viewFinish(w);
  const ex = w.exercises[step];
  const sets = draft.exercises[ex.id];
  const prev = previousSets(w.id, ex.id, draft.id);
  const hint = progressionHint(ex, prev);
  const vid = videoFor(w.id, ex);
  const unit = db.settings.unit;
  const exDone = (e) => draft.exercises[e.id].some((s) => s.done);

  $app.innerHTML = `
    <div style="--wc:${wcolor(w.id)}">
      <div class="row split">
        <span class="chip"><i class="dot" style="--wc:${wcolor(w.id)}"></i>${esc(w.name)}${draft.editing ? ' · editing' : ''}</span>
        <span class="muted small">Exercise ${step + 1} of ${w.exercises.length}</span>
      </div>
      <div class="progress"><i style="width:${(step / w.exercises.length) * 100}%"></i></div>
      <div class="pills">
        ${w.exercises.map((e, i) => `<button class="pill ${i === step ? 'cur' : ''} ${exDone(e) ? 'done' : ''}" data-step="${i}">${esc(e.name.replace(/^Dumbbell /, ''))}</button>`).join('')}
        <button class="pill ${step === w.exercises.length ? 'cur' : ''}" data-step="${w.exercises.length}">Finish</button>
      </div>

      <h1>${esc(ex.name)}</h1>
      <p class="muted">${esc(repText(ex))}${prev ? ` · last time ${esc(fmtDate(prev.date))}` : ' · first time logging this'}</p>

      ${videoEmbed(vid, ex.name, linkFor(w.id, ex))}
      <div class="vidbar">
        ${howTo(w.id, ex)}
        <button class="btn" data-act="video">${vid ? 'Change video' : '＋ Add video'}</button>
        ${vid ? '' : `<a class="btn ghost" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent('Muscle and Strength ' + ex.name)}">Find on YouTube ↗</a>`}
      </div>

      ${hint ? `<div class="hint ${hint.kind === 'warn' ? 'warn' : ''}">${hint.kind === 'good' ? '💪 ' : '🎯 '}${esc(hint.text)}</div>` : ''}

      <div class="sets">
        ${sets.map((s, i) => setRow(ex, s, i, prev?.sets?.[i], unit)).join('')}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" data-act="addset">＋ Add set</button>
        ${sets.length > 1 ? `<button class="btn ghost" data-act="rmset">− Remove set</button>` : ''}
        <span class="grow"></span>
        ${prev ? `<button class="btn ghost" data-act="copyall">Copy last session</button>` : ''}
      </div>
    </div>
    <div class="flownav"><div class="inner">
      <button class="btn big" data-act="prev" ${step === 0 ? 'disabled' : ''}>← Back</button>
      <button class="btn primary big" data-act="next">${step === w.exercises.length - 1 ? 'Review & finish →' : 'Next exercise →'}</button>
    </div></div>`;

  bindSession(w, ex, prev);
}

function setRow(ex, s, i, p, unit) {
  const prevTxt = p ? setText(p, ex) : '—';
  if (ex.kind === 'time') {
    return `<div class="set time ${s.done ? 'done' : ''}" data-i="${i}">
      <span class="num">${i + 1}</span>
      <label>Seconds <span class="prev">last: ${esc(prevTxt)}</span>
        ${stepper('time', s.time, p?.time)}
      </label>
      <button class="tick" data-act="tick" aria-label="Set ${i + 1} done">✓</button>
    </div>`;
  }
  return `<div class="set ${s.done ? 'done' : ''}" data-i="${i}">
    <span class="num">${i + 1}</span>
    <label>${esc(unit)} <span class="prev">last: ${esc(p?.weight ?? '—')}</span>
      ${stepper('weight', s.weight, p?.weight)}
    </label>
    <label>Reps <span class="prev">last: ${esc(p?.reps ?? '—')}</span>
      ${stepper('reps', s.reps, p?.reps)}
    </label>
    <button class="tick" data-act="tick" aria-label="Set ${i + 1} done">✓</button>
  </div>`;
}
const stepper = (field, val, ph) => `<div class="stepper">
  <button type="button" data-step-field="${field}" data-dir="-1" aria-label="Decrease ${field}">−</button>
  <input type="text" inputmode="decimal" autocomplete="off" data-field="${field}" value="${esc(val ?? '')}" placeholder="${esc(ph ?? '')}">
  <button type="button" data-step-field="${field}" data-dir="1" aria-label="Increase ${field}">+</button>
</div>`;

function bindSession(w, ex, prev) {
  const sets = draft.exercises[ex.id];
  const rowOf = (el) => Number(el.closest('.set').dataset.i);
  const rerender = () => { const y = window.scrollY; viewSession(); window.scrollTo(0, y); };

  $app.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    draft.step = Number(b.dataset.step); saveDraft(); viewSession(); window.scrollTo(0, 0);
  }));
  $app.querySelectorAll('input[data-field]').forEach((inp) => {
    inp.addEventListener('input', () => {
      sets[rowOf(inp)][inp.dataset.field] = parseVal(inp.value);
      saveDraft();
    });
    inp.addEventListener('focus', () => inp.select());
  });
  $app.querySelectorAll('[data-step-field]').forEach((b) => b.addEventListener('click', () => {
    const i = rowOf(b);
    const f = b.dataset.stepField;
    const p = prev?.sets?.[i];
    const cur = sets[i][f];
    const base = isNum(cur) ? cur : isNum(p?.[f]) ? p[f] : isNum(sets[i - 1]?.[f]) ? sets[i - 1][f] : 0;
    const inc = f === 'weight' ? Number(db.settings.weightStep) || 1 : f === 'time' ? 5 : 1;
    // First tap on an empty field just fills last time's value.
    const next = !isNum(cur) && isNum(p?.[f]) ? base : Math.max(0, round(base + inc * Number(b.dataset.dir)));
    sets[i][f] = next;
    b.parentElement.querySelector('input').value = next;
    saveDraft();
  }));
  $app.querySelectorAll('[data-act="tick"]').forEach((b) => b.addEventListener('click', () => {
    const i = rowOf(b);
    const s = sets[i];
    if (s.done) { s.done = false; saveDraft(); return rerender(); }
    // Empty fields take the value shown as the placeholder (last session), else today's previous set.
    for (const f of ex.kind === 'time' ? ['time'] : ['weight', 'reps']) {
      if (s[f] == null) s[f] = prev?.sets?.[i]?.[f] ?? sets[i - 1]?.[f] ?? null;
    }
    const hasValue = ex.kind === 'time' ? s.time != null : s.weight != null || s.reps != null;
    if (!hasValue) { toast('Enter weight and reps first'); return; }
    s.done = true;
    saveDraft();
    const exDone = sets.every((x) => x.done);
    startRest(exDone ? Math.max(db.settings.rest, 120) : db.settings.rest);
    rerender();
    if (exDone && draft.step < w.exercises.length - 1) toast('Exercise done — tap Next when ready');
  }));
  const act = (name, fn) => $app.querySelector(`[data-act="${name}"]`)?.addEventListener('click', fn);
  act('addset', () => { sets.push(ex.kind === 'time' ? { time: null, done: false } : { weight: null, reps: null, done: false }); saveDraft(); rerender(); });
  act('rmset', () => { sets.pop(); saveDraft(); rerender(); });
  act('copyall', () => {
    prev.sets.forEach((p, i) => {
      if (!p) return;
      sets[i] ||= { done: false };
      for (const f of Object.keys(p)) if (sets[i][f] == null) sets[i][f] = p[f];
    });
    saveDraft(); rerender(); toast('Filled from last session — adjust and tick each set');
  });
  act('video', () => editVideo(w.id, ex, viewSession));
  act('prev', () => { draft.step = Math.max(0, draft.step - 1); saveDraft(); viewSession(); window.scrollTo(0, 0); });
  act('next', () => { draft.step += 1; saveDraft(); viewSession(); window.scrollTo(0, 0); });
}
const stripEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => v != null && k !== 'done'));

function editVideo(wid, ex, after) {
  const key = videoKey(wid, ex.id);
  const cur = db.videos[key] || '';
  const url = prompt(`Paste a YouTube or Vimeo link for "${ex.name}".\nLeave empty to use the built-in video (if any).`, cur);
  if (url === null) return;
  if (url.trim() && !parseVideo(url)) { toast("That doesn't look like a YouTube or Vimeo link"); return; }
  if (url.trim()) db.videos[key] = url.trim(); else delete db.videos[key];
  // Same exercise in other workouts (same M&S page) gets the same video.
  for (const w of db.workouts) for (const e of w.exercises) {
    if (e !== ex && e.link && e.link === ex.link && !db.videos[videoKey(w.id, e.id)] && url.trim()) db.videos[videoKey(w.id, e.id)] = url.trim();
  }
  save();
  after();
}

function draftToSession() {
  const exercises = {};
  for (const [eid, sets] of Object.entries(draft.exercises)) {
    const clean = sets.map((s) => {
      const o = stripEmpty(s);
      return Object.keys(o).length ? o : null;
    });
    while (clean.length && clean.at(-1) == null) clean.pop();
    if (clean.length) exercises[eid] = clean;
  }
  return { id: draft.id, workout: draft.workout, date: draft.date, exercises, ...(draft.notes ? { notes: draft.notes } : {}) };
}

function viewFinish(w) {
  const sess = draftToSession();
  const mins = draft.editing ? null : Math.round((Date.now() - draft.startedAt) / 60000);
  let vol = 0, prs = [];
  for (const ex of w.exercises) {
    const sets = sess.exercises[ex.id];
    if (!sets) continue;
    vol += volume(sets);
    const best = topSet(sets);
    const history = sessionsOf(w.id).filter((s) => s.id !== draft.id && s.date <= draft.date);
    const prevBest = Math.max(-Infinity, ...history.map((s) => topSet(s.exercises?.[ex.id])?.weight ?? -Infinity));
    if (best && prevBest !== -Infinity && best.weight > prevBest) prs.push(`${ex.name}: ${best.weight} ${db.settings.unit}`);
  }
  const done = countDone(draft);
  $app.innerHTML = `
    <div style="--wc:${wcolor(w.id)}">
      <div class="progress"><i style="width:100%"></i></div>
      <div class="pills">
        ${w.exercises.map((e, i) => `<button class="pill ${draft.exercises[e.id].some((s) => s.done) ? 'done' : ''}" data-step="${i}">${esc(e.name.replace(/^Dumbbell /, ''))}</button>`).join('')}
        <button class="pill cur">Finish</button>
      </div>
      <h1>${draft.editing ? 'Save changes' : 'Nice work!'}</h1>
      <div class="summary">
        <div class="stat"><b>${done}</b><span>sets</span></div>
        <div class="stat"><b>${Math.round(vol).toLocaleString()}</b><span>${esc(db.settings.unit)} volume</span></div>
        <div class="stat"><b>${mins ?? '—'}</b><span>minutes</span></div>
      </div>
      ${prs.length ? `<div class="hint">🏆 New best: ${prs.map(esc).join(', ')}</div>` : ''}
      <div class="card">
        <label class="field"><span>Date</span><input type="date" id="f-date" value="${esc(draft.date)}" max="${todayISO()}"></label>
        <label class="field"><span>Notes (optional)</span><textarea id="f-notes" placeholder="How did it feel? Anything to change next time?">${esc(draft.notes)}</textarea></label>
        <table><tbody>
          ${w.exercises.map((ex) => {
            const sets = sess.exercises[ex.id];
            return `<tr><td>${esc(ex.name)}</td><td class="muted">${sets ? sets.map((s) => esc(setText(s, ex))).join(', ') : 'skipped'}</td></tr>`;
          }).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="flownav"><div class="inner">
      <button class="btn big danger" data-act="discard">Discard</button>
      <button class="btn primary big" data-act="save" ${done ? '' : 'disabled'}>${draft.editing ? 'Save changes' : 'Save workout'}</button>
    </div></div>`;

  $app.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { draft.step = Number(b.dataset.step); saveDraft(); viewSession(); }));
  $app.querySelector('#f-date').addEventListener('change', (e) => { if (e.target.value) { draft.date = e.target.value; saveDraft(); } });
  $app.querySelector('#f-notes').addEventListener('input', (e) => { draft.notes = e.target.value; saveDraft(); });
  $app.querySelector('[data-act="discard"]').addEventListener('click', discardDraft);
  $app.querySelector('[data-act="save"]').addEventListener('click', () => {
    const s = draftToSession();
    db.sessions = db.sessions.filter((x) => x.id !== s.id);
    db.sessions.push(s);
    save();
    draft = null; saveDraft(); stopRest(); releaseWakeLock();
    toast('Workout saved 💪');
    go('#/');
  });
}

/* ----- Rest timer ----- */

let rest = null;
function startRest(seconds) {
  if (!seconds) return;
  stopRest();
  rest = { end: Date.now() + seconds * 1000, total: seconds, beeped: false };
  rest.iv = setInterval(tickRest, 250);
  document.body.classList.add('has-rest');
  tickRest();
}
function stopRest() {
  if (rest) clearInterval(rest.iv);
  rest = null;
  $rest.hidden = true;
  document.body.classList.remove('has-rest');
}
function tickRest() {
  if (!rest) return;
  const left = Math.round((rest.end - Date.now()) / 1000);
  const over = left <= 0;
  if (over && !rest.beeped) { rest.beeped = true; beep(); navigator.vibrate?.([200, 100, 200]); }
  if (left < -60) return stopRest();
  const t = Math.abs(left);
  const pct = over ? 100 : (1 - left / rest.total) * 100;
  $rest.hidden = false;
  $rest.classList.toggle('over', over);
  $rest.innerHTML = `<span>${over ? 'Go!' : 'Rest'}</span><span class="t">${over ? '+' : ''}${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</span>
    <span class="bar"><i style="width:${pct}%"></i></span>
    <button data-r="-15">−15</button><button data-r="15">+15</button><button data-r="x" aria-label="Dismiss timer">✕</button>`;
}
$rest.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !rest) return;
  if (b.dataset.r === 'x') return stopRest();
  rest.end += Number(b.dataset.r) * 1000;
  rest.total = Math.max(rest.total, Math.round((rest.end - Date.now()) / 1000));
  rest.beeped = rest.end <= Date.now();
  tickRest();
});
let audioCtx;
function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25].forEach((t) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.15;
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.15);
    });
  } catch (e) { /* no audio */ }
}

/* ----- Screen wake lock while training ----- */

let wakeLock = null;
async function requestWakeLock() {
  try { if (!wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* not allowed */ }
}
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && location.hash === '#/session') requestWakeLock(); });

/* ----- History ----- */

function histItem(s) {
  const w = workout(s.workout);
  const n = Object.keys(s.exercises || {}).length;
  return `<a class="hitem card" href="#/s/${esc(s.id)}">
    <i class="dot" style="--wc:${wcolor(s.workout)}"></i>
    <span><strong>${esc(w?.name || s.workout)}</strong><br><span class="muted small">${n ? `${n} exercises` : 'ticked on calendar (no sets logged)'}</span></span>
    <span class="date">${esc(fmtDate(s.date, { day: 'numeric', month: 'short', year: '2-digit' }))}</span>
  </a>`;
}

function viewHistory(year) {
  const all = sortedSessions();
  const years = [...new Set(all.map((s) => s.date.slice(0, 4)))];
  const thisYear = String(new Date().getFullYear());
  if (!years.includes(thisYear)) years.push(thisYear);
  years.sort();
  year ||= thisYear;
  const inYear = all.filter((s) => s.date.startsWith(year));
  const jan1 = new Date(Number(year), 0, 1);
  const start = mondayOf(jan1);
  const end = year === thisYear ? new Date() : new Date(Number(year), 11, 31);
  const weeks = Math.floor((mondayOf(end) - start) / (7 * 86400000)) + 1;
  const counts = ROTATION.map((id) => [id, inYear.filter((s) => s.workout === id).length]);

  $app.innerHTML = `
    <h1>History</h1>
    <div class="yeartabs">${years.map((y) => `<a class="btn ${y === year ? 'primary' : ''}" href="#/history/${y}">${y}</a>`).join('')}</div>
    <section class="card">
      <div class="row split"><h2>${year}</h2><span class="muted small">${inYear.length} workouts</span></div>
      <div class="legend" style="margin:0 0 12px">${counts.map(([id, n]) => `<span><i class="dot" style="--wc:${wcolor(id)}"></i>${esc(workout(id)?.name)} · ${n}</span>`).join('')}</div>
      ${calendar(start, weeks)}
    </section>
    <section>
      <h2>Sessions</h2>
      <div class="hist">${inYear.slice().reverse().map(histItem).join('') || '<p class="muted">No workouts logged this year.</p>'}</div>
    </section>`;
}

function viewSavedSession(id) {
  const s = db.sessions.find((x) => x.id === id);
  if (!s) return go('#/history');
  const w = workout(s.workout);
  $app.innerHTML = `
    <section class="card next" style="--wc:${wcolor(s.workout)}">
      <div class="label">${esc(fmtDate(s.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</div>
      <h1>${esc(w.name)}</h1>
      ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
      <div class="row">
        <button class="btn" data-act="edit">Edit</button>
        <button class="btn danger" data-act="del">Delete</button>
      </div>
    </section>
    <section class="card scroll-x">
      ${Object.keys(s.exercises || {}).length ? `<table>
        <thead><tr><th>Exercise</th>${Array.from({ length: Math.max(...w.exercises.map((e) => s.exercises[e.id]?.length || 0)) }, (_, i) => `<th>Set ${i + 1}</th>`).join('')}</tr></thead>
        <tbody>${w.exercises.filter((e) => s.exercises[e.id]).map((e) => `<tr>
          <td><a href="#/exercise/${w.id}/${e.id}">${esc(e.name)}</a></td>
          ${s.exercises[e.id].map((x) => `<td>${esc(setText(x, e))}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table>` : '<p class="muted">This day was ticked on the calendar but no sets were recorded.</p>'}
    </section>`;
  $app.querySelector('[data-act="edit"]').addEventListener('click', () => {
    if (draft && countDone(draft) > 0 && !confirm('Replace the workout in progress?')) return;
    draft = null;
    startSession(s.workout, s);
  });
  $app.querySelector('[data-act="del"]').addEventListener('click', () => {
    if (!confirm('Delete this session?')) return;
    db.sessions = db.sessions.filter((x) => x.id !== id);
    save(); toast('Session deleted'); go('#/history');
  });
}

/* ----- Exercise progress ----- */

function viewExercise(wid, eid) {
  const w = workout(wid), ex = exercise(wid, eid);
  if (!ex) return go('#/');
  const rows = sessionsOf(wid).filter((s) => s.exercises?.[eid]?.some(Boolean));
  const pts = rows.map((s) => {
    const sets = s.exercises[eid];
    const v = ex.kind === 'time' ? Math.max(...sets.map((x) => x?.time || 0)) : topSet(sets)?.weight;
    return { date: s.date, v: isNum(v) ? v : null, sets };
  }).filter((p) => p.v != null);
  const vid = videoFor(wid, ex);
  const best = pts.length ? Math.max(...pts.map((p) => p.v)) : null;

  $app.innerHTML = `
    <p><a href="#/workout/${wid}">← ${esc(w.name)}</a></p>
    <h1>${esc(ex.name)}</h1>
    <p class="muted">${esc(repText(ex))}${best != null ? ` · best ${best}${ex.kind === 'time' ? 's' : ' ' + esc(db.settings.unit)}` : ''}</p>
    ${videoEmbed(vid, ex.name, linkFor(wid, ex))}
    <div class="vidbar">
      ${howTo(wid, ex)}
      <button class="btn" data-act="video">${vid ? 'Change video' : '＋ Add video'}</button>
    </div>
    <section class="card">
      <h2>${ex.kind === 'time' ? 'Longest hold' : 'Top set weight'}</h2>
      ${pts.length > 1 ? lineChart(pts) : '<p class="muted">Log a couple of sessions to see a trend.</p>'}
    </section>
    <section class="card scroll-x">
      <h2>All sessions</h2>
      <table><thead><tr><th>Date</th><th>Sets</th>${ex.kind === 'time' ? '' : '<th>Volume</th>'}</tr></thead><tbody>
        ${rows.slice().reverse().map((s) => `<tr><td><a href="#/s/${esc(s.id)}">${esc(fmtDate(s.date, { day: 'numeric', month: 'short', year: '2-digit' }))}</a></td>
          <td>${s.exercises[eid].map((x) => esc(setText(x, ex))).join(', ')}</td>
          ${ex.kind === 'time' ? '' : `<td>${Math.round(volume(s.exercises[eid]))}</td>`}</tr>`).join('')}
      </tbody></table>
    </section>`;
  $app.querySelector('[data-act="video"]').addEventListener('click', () => editVideo(wid, ex, () => viewExercise(wid, eid)));
}

function lineChart(pts) {
  const W = 600, H = 220, P = { l: 44, r: 10, t: 14, b: 30 };
  const t0 = fromISO(pts[0].date).getTime(), t1 = fromISO(pts.at(-1).date).getTime();
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const x = (d) => P.l + ((fromISO(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">
    <line class="ax" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"/>
    <text x="0" y="${y(hi) + 6}">${hi}</text><text x="0" y="${y(lo) + 6}">${lo}</text>
    <text x="${P.l}" y="${H - 6}">${esc(fmtDate(pts[0].date, { month: 'short', year: '2-digit' }))}</text>
    <text x="${W - P.r}" y="${H - 6}" text-anchor="end">${esc(fmtDate(pts.at(-1).date, { month: 'short', year: '2-digit' }))}</text>
    <path class="ln" d="${path}"/>
    ${pts.map((p) => `<circle class="pt" cx="${x(p.date)}" cy="${y(p.v)}" r="3.5"><title>${esc(fmtDate(p.date))}: ${p.v}</title></circle>`).join('')}
  </svg>`;
}

/* ----- Settings ----- */

function viewSettings() {
  const st = db.settings;
  const vids = db.workouts.reduce((n, w) => n + w.exercises.filter((e) => videoFor(w.id, e)).length, 0);
  const total = db.workouts.reduce((n, w) => n + w.exercises.length, 0);
  $app.innerHTML = `
    <div class="row split"><h1>Settings</h1><span class="chip">v${APP_VERSION}</span></div>
    <section class="card">
      <label class="field"><span>Rest timer (seconds, 0 = off)</span><input type="number" id="s-rest" min="0" step="15" value="${esc(st.rest)}"></label>
      <label class="field"><span>Weight +/− step</span><input type="number" id="s-step" min="0.25" step="0.25" value="${esc(st.weightStep)}"></label>
      <label class="field"><span>Weight unit</span><select id="s-unit">${['kg', 'lb'].map((u) => `<option ${u === st.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <label class="field"><span>Theme</span><select id="s-theme">${['auto', 'light', 'dark'].map((u) => `<option ${u === st.theme ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    </section>
    <section class="card">
      <h2>Your data</h2>
      <p class="muted small">Workouts are stored in this browser only (${db.sessions.length} sessions, ${vids}/${total} exercise videos set). Export a backup now and then, and import it to move to another phone or computer.</p>
      <div class="row">
        <button class="btn" data-act="export">Export backup (.json)</button>
        <button class="btn" data-act="import">Import backup</button>
        <button class="btn" data-act="csv">Export CSV</button>
      </div>
      <input type="file" id="s-file" accept="application/json,.json" hidden>
    </section>
    <section class="card">
      <h2>Reset</h2>
      <p class="muted small">Restore the history imported from the original spreadsheet. Anything logged here since will be lost (export first).</p>
      <button class="btn danger" data-act="reset">Reset to spreadsheet data</button>
    </section>`;
  const num = (id, key) => $app.querySelector(id).addEventListener('change', (e) => { st[key] = Math.max(0, Number(e.target.value) || 0); save(); toast('Saved'); });
  num('#s-rest', 'rest'); num('#s-step', 'weightStep');
  $app.querySelector('#s-unit').addEventListener('change', (e) => { st.unit = e.target.value; save(); toast('Saved'); });
  $app.querySelector('#s-theme').addEventListener('change', (e) => { st.theme = e.target.value; save(); applyTheme(); });
  const act = (n, fn) => $app.querySelector(`[data-act="${n}"]`).addEventListener('click', fn);
  act('export', () => download(`workouts-${todayISO()}.json`, JSON.stringify(db, null, 1), 'application/json'));
  act('csv', () => download(`workouts-${todayISO()}.csv`, toCSV(), 'text/csv'));
  act('import', () => $app.querySelector('#s-file').click());
  $app.querySelector('#s-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.sessions) || !Array.isArray(data.workouts)) throw new Error('bad file');
      if (!confirm(`Replace current data with ${data.sessions.length} sessions from this backup?`)) return;
      db = { ...data, videos: data.videos || {}, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
      save(); applyTheme(); toast('Backup imported'); viewSettings();
    } catch (err) { toast('Could not read that file'); }
  });
  act('reset', async () => {
    if (!confirm('Reset all data to the spreadsheet import? This cannot be undone.')) return;
    const seed = await fetch('data/seed.json', { cache: 'reload' }).then((r) => r.json());
    db = { ...seed, videos: db.videos, settings: db.settings };
    save(); toast('Reset done'); go('#/');
  });
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function toCSV() {
  const lines = [['date', 'workout', 'exercise', 'set', 'weight', 'reps', 'seconds'].join(',')];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  for (const s of sortedSessions()) {
    const w = workout(s.workout);
    for (const ex of w?.exercises || []) {
      (s.exercises?.[ex.id] || []).forEach((x, i) => {
        if (x) lines.push([s.date, w.name, ex.name, i + 1, x.weight, x.reps, x.time].map(q).join(','));
      });
    }
  }
  return lines.join('\n');
}

/* ---------- boot ---------- */

load().then(render).catch((e) => {
  console.error(e);
  $app.innerHTML = '<div class="card"><h2>Could not load data</h2><p class="muted">Check your connection and reload.</p></div>';
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Check for a new version on every launch; when one takes over, reload so the new code runs.
  // (Any in-progress workout is already saved, so the reload loses nothing.)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
