/* Short Straw — global meeting planner
   Plain MV3 popup: no build step, no network calls. */

/* ---------------- storage (falls back to localStorage outside the extension) ---- */
const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const store = {
  async get(defaults){
    if (HAS_CHROME) return chrome.storage.local.get(defaults);
    const out = {};
    for (const k of Object.keys(defaults)){
      const raw = localStorage.getItem('tzmp_' + k);
      out[k] = raw === null ? defaults[k] : JSON.parse(raw);
    }
    return out;
  },
  async set(obj){
    if (HAS_CHROME) return chrome.storage.local.set(obj);
    for (const k of Object.keys(obj)) localStorage.setItem('tzmp_' + k, JSON.stringify(obj[k]));
  }
};

/* ---------------- time-zone maths (DST-correct via Intl) ----------------------- */
const _fmt = new Map();
function partsFor(ts, tz){
  let f = _fmt.get(tz);
  if (!f){
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    _fmt.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  const WD = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    y:+o.year, mo:+o.month, d:+o.day,
    H:+o.hour % 24, M:+o.minute, S:+o.second,
    wd: WD[o.weekday], wdName: o.weekday
  };
}
function tzOffset(ts, tz){
  const p = partsFor(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.H, p.M, p.S) - ts;
}
/** Wall-clock time in `tz` -> UTC ms. */
function wallToUtc(y, mo, d, h, mi, tz){
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let ts = target - tzOffset(target, tz);
  ts = target - tzOffset(ts, tz);
  return ts;
}
const _abbr = new Map();
function tzAbbr(ts, tz){
  const key = tz + '|' + Math.floor(ts / 36e5);
  if (_abbr.has(key)) return _abbr.get(key);
  // No single locale names every zone well (en-US says GMT+1 for London, en-GB says
  // GMT-4 for New York) — take the first locale that yields a real abbreviation.
  let v = '';
  for (const loc of ['en-GB', 'en-US', 'en-AU']){
    const parts = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ts));
    const got = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    if (!v) v = got;
    if (got && !/^GMT/.test(got)){ v = got; break; }
  }
  _abbr.set(key, v);
  return v;
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtTime(h, m){
  if (state.clockFmt === '24') return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ':' + String(m).padStart(2,'0') + ' ' + ap;
}
function fmtHourShort(h){
  if (state.clockFmt === '24') return String(h).padStart(2,'0');
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return (h % 12) + (h < 12 ? 'a' : 'p');
}
function fmtDate(p){ return p.wdName + ' ' + p.d + ' ' + MON[p.mo - 1]; }
function isoDate(p){ return p.y + '-' + String(p.mo).padStart(2,'0') + '-' + String(p.d).padStart(2,'0'); }

/* ---------------- state -------------------------------------------------------- */
const state = {
  people: [],            // {n,s,tz,f,who,flex}
  homeName: null,
  anchor: null,          // 'YYYY-MM-DD' in home local terms
  duration: 60,
  workStart: 9,
  workEnd: 17,
  clockFmt: '12',
  avoidWeekend: true,
  rotatePain: true,
  tally: {},             // cityName -> count
  selected: null,        // UTC ms of chosen slot
  slots: []              // computed each render
};

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

/* ---------------- scoring ------------------------------------------------------ */
/* Penalty for one person at one instant. 0 = squarely inside working hours. */
function penaltyAt(ts, person){
  const p = partsFor(ts, person.tz);
  const h = p.H + p.M / 60;
  const pad = person.flex ? 1.5 : 0;
  const s = state.workStart - pad, e = state.workEnd + pad;
  let pen;
  if (h >= s && h <= e) pen = 0;
  else {
    const d = h < s ? s - h : h - e;
    pen = d <= 1 ? 2 : d <= 3 ? 6 : 12;
    if (h < 6 || h >= 22) pen = Math.max(pen, 25);
  }
  const weekend = p.wd === 0 || p.wd === 6;
  if (weekend && state.avoidWeekend) pen += 12;
  return { pen, parts: p, weekend };
}
function evalSlot(ts){
  const durMs = state.duration * 60000;
  const per = state.people.map(person => {
    const a = penaltyAt(ts, person);
    const b = penaltyAt(ts + durMs - 60000, person);
    const worst = a.pen >= b.pen ? a : b;
    return { person, pen: worst.pen, start: a.parts, end: partsFor(ts + durMs, person.tz), weekend: a.weekend || b.weekend };
  });
  const total = per.reduce((s, x) => s + x.pen, 0);
  const maxPen = per.reduce((m, x) => Math.max(m, x.pen), 0);
  const straw = maxPen > 0 ? per.filter(x => x.pen === maxPen) : [];
  // "Rotate the pain": nudge slots that punish someone who already took the hit.
  const debt = straw.reduce((m, x) => Math.max(m, state.tally[x.person.n] || 0), 0);
  const rank = total + maxPen * 0.5 + (state.rotatePain ? Math.min(debt, 5) * 4 : 0);
  return { ts, per, total, maxPen, straw, rank };
}
function verdictFor(slot){
  if (slot.maxPen === 0) return { text: 'everyone in hours', cls: 'good' };
  if (slot.maxPen <= 2)  return { text: 'a nudge outside hours', cls: 'good' };
  if (slot.maxPen <= 6)  return { text: 'early / late for some', cls: 'warn' };
  if (slot.maxPen <= 12) return { text: 'rough for someone', cls: 'warn' };
  if (slot.maxPen < 25)  return { text: 'weekend hit', cls: 'bad' };
  return { text: 'someone is up at night', cls: 'bad' };
}
function bandOf(pen){
  if (pen === 0) return 0;
  if (pen <= 2) return 1;
  if (pen <= 12) return 2;
  return 3;
}

/* ---------------- derived helpers ---------------------------------------------- */
function homePerson(){
  return state.people.find(p => p.n === state.homeName) || state.people[0];
}
function orderedPeople(){
  const ref = anchorNoonUtc();
  return state.people.slice().sort((a, b) => tzOffset(ref, a.tz) - tzOffset(ref, b.tz));
}
function anchorNoonUtc(){
  const home = homePerson();
  const [y, m, d] = state.anchor.split('-').map(Number);
  return wallToUtc(y, m, d, 12, 0, home.tz);
}
function buildSlots(){
  const home = homePerson();
  const [y, m, d] = state.anchor.split('-').map(Number);
  const out = [];
  for (let h = 0; h < 24; h++) out.push(evalSlot(wallToUtc(y, m, d, h, 0, home.tz)));
  return out;
}

/* ---------------- persistence -------------------------------------------------- */
async function save(){
  await store.set({
    people: state.people, homeName: state.homeName, duration: state.duration,
    workStart: state.workStart, workEnd: state.workEnd, clockFmt: state.clockFmt,
    avoidWeekend: state.avoidWeekend, rotatePain: state.rotatePain, tally: state.tally
  });
}
async function load(){
  const d = await store.get({
    people: [], homeName: null, duration: 60, workStart: 9, workEnd: 17,
    clockFmt: '12', avoidWeekend: true, rotatePain: true, tally: {}
  });
  Object.assign(state, d);
  state.people = (state.people || []).map(p => ({ who: '', flex: false, ...p }));
  if (!state.people.length) seedLocalCity();
  if (!state.people.some(p => p.n === state.homeName)) state.homeName = state.people[0] ? state.people[0].n : null;
  const home = homePerson();
  state.anchor = home ? isoDate(partsFor(Date.now(), home.tz)) : isoDate(partsFor(Date.now(), 'UTC'));
}
function seedLocalCity(){
  const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const match = CITIES.find(c => c.tz === myTz);
  if (match) addCity(match, true);
}

/* ---------------- city add / remove -------------------------------------------- */
function addCity(city, silent){
  if (state.people.some(p => p.n === city.n)) return false;
  state.people.push({ n: city.n, s: city.s, tz: city.tz, f: city.f, who: '', flex: false });
  if (!state.homeName) state.homeName = city.n;
  if (!silent){ state.selected = null; save(); render(); }
  return true;
}
function removeCity(name){
  state.people = state.people.filter(p => p.n !== name);
  if (state.homeName === name) state.homeName = state.people[0] ? state.people[0].n : null;
  state.selected = null;
  save(); render();
}

/* ---------------- search -------------------------------------------------------- */
const searchInput = $('#citySearch');
const resultsBox = $('#cityResults');
let activeIdx = -1, currentResults = [];

function runSearch(q){
  q = q.trim().toLowerCase();
  if (!q){ closeResults(); return; }
  currentResults = CITIES.filter(c =>
    c.n.toLowerCase().includes(q) || c.s.toLowerCase().includes(q) || c.tz.toLowerCase().includes(q)
  ).slice(0, 40);
  activeIdx = currentResults.length ? 0 : -1;
  drawResults();
}
function drawResults(){
  resultsBox.innerHTML = '';
  if (!currentResults.length){
    resultsBox.appendChild(el('div', 'result dim', 'No city matches — try a country or time-zone name.'));
    resultsBox.classList.remove('hidden');
    return;
  }
  const now = Date.now();
  currentResults.forEach((c, i) => {
    const already = state.people.some(p => p.n === c.n);
    const row = el('div', 'result' + (already ? ' dim' : '') + (i === activeIdx ? ' active' : ''));
    row.appendChild(el('span', 'flag', c.f));
    row.appendChild(el('span', 'rn', c.n));
    row.appendChild(el('span', 'rs', c.s));
    const p = partsFor(now, c.tz);
    row.appendChild(el('span', 'rt', (already ? 'added · ' : '') + fmtTime(p.H, p.M)));
    if (!already) row.addEventListener('mousedown', ev => { ev.preventDefault(); pick(c); });
    resultsBox.appendChild(row);
  });
  resultsBox.classList.remove('hidden');
}
function pick(c){
  addCity(c);
  searchInput.value = '';
  closeResults();
  searchInput.focus();
}
function closeResults(){ resultsBox.classList.add('hidden'); currentResults = []; activeIdx = -1; }

searchInput.addEventListener('input', e => runSearch(e.target.value));
searchInput.addEventListener('focus', e => { if (e.target.value) runSearch(e.target.value); });
searchInput.addEventListener('blur', () => setTimeout(closeResults, 120));
searchInput.addEventListener('keydown', e => {
  if (!currentResults.length) return;
  if (e.key === 'ArrowDown'){ activeIdx = Math.min(activeIdx + 1, currentResults.length - 1); drawResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp'){ activeIdx = Math.max(activeIdx - 1, 0); drawResults(); e.preventDefault(); }
  else if (e.key === 'Enter' && activeIdx >= 0){
    const c = currentResults[activeIdx];
    if (!state.people.some(p => p.n === c.n)) pick(c);
    e.preventDefault();
  } else if (e.key === 'Escape'){ closeResults(); }
});

/* ---------------- rendering ----------------------------------------------------- */
function render(){
  const enough = state.people.length >= 1;
  $('#empty').classList.toggle('hidden', enough);
  $('#main').classList.toggle('hidden', !enough);
  $('#quickstart').classList.toggle('hidden', state.people.length === 0 || state.people.length > 2);
  if (!enough) return;

  $('#anchorDate').value = state.anchor;
  $('#duration').value = String(state.duration);

  state.slots = buildSlots();
  if (state.selected == null || !state.slots.some(s => s.ts === state.selected)){
    const best = state.slots.slice().sort((a, b) => a.rank - b.rank)[0];
    state.selected = best ? best.ts : null;
  }
  renderBest();
  renderGrid();
  renderDetail();
  renderTally();
}

function renderBest(){
  const box = $('#bestChips');
  box.innerHTML = '';
  const home = homePerson();
  const top = state.slots.slice().sort((a, b) => a.rank - b.rank).slice(0, 4);
  top.forEach((slot, i) => {
    const p = partsFor(slot.ts, home.tz);
    const v = verdictFor(slot);
    const chip = el('button', 'best-chip' + (slot.ts === state.selected ? ' sel' : ''));
    chip.appendChild(el('span', 'rank', '#' + (i + 1)));
    chip.appendChild(el('span', 'bt', fmtTime(p.H, p.M)));
    const ok = slot.per.filter(x => x.pen === 0).length;
    const detail = state.people.length > 1
      ? ok + '/' + state.people.length + ' in hours' + (slot.straw.length ? ' · 🥤 ' + slot.straw.map(x => x.person.n).join(', ') : '')
      : v.text;
    chip.appendChild(el('span', 'verdict' + (v.cls === 'good' ? ' good' : ''), detail));
    chip.title = v.text;
    chip.addEventListener('click', () => { state.selected = slot.ts; render(); });
    box.appendChild(chip);
  });
}

function renderGrid(){
  const grid = $('#grid');
  grid.innerHTML = '';
  const home = homePerson();
  const people = orderedPeople();

  const corner = el('div', 'g-corner');
  corner.textContent = home.n + ' · ' + tzAbbr(state.slots[0].ts, home.tz);
  grid.appendChild(corner);

  state.slots.forEach(slot => {
    const p = partsFor(slot.ts, home.tz);
    const h = el('div', 'g-hour' + (slot.ts === state.selected ? ' sel' : ''), fmtHourShort(p.H));
    h.title = 'Select ' + fmtTime(p.H, p.M) + ' in ' + home.n;
    h.addEventListener('click', () => { state.selected = slot.ts; render(); });
    grid.appendChild(h);
  });

  people.forEach(person => {
    grid.appendChild(nameCell(person));
    state.slots.forEach(slot => {
      const entry = slot.per.find(x => x.person.n === person.n);
      const p = entry.start;
      const cell = el('div', 'cell b' + bandOf(entry.pen));
      if (entry.weekend && state.avoidWeekend) cell.classList.add('wknd');
      if (p.H === 0) cell.classList.add('dayline');
      if (slot.ts === state.selected) cell.classList.add('sel');
      cell.textContent = fmtHourShort(p.H);
      cell.title = person.n + ' — ' + fmtDate(p) + ' ' + fmtTime(p.H, p.M);
      cell.addEventListener('click', () => { state.selected = slot.ts; render(); });
      grid.appendChild(cell);
    });
  });
}

function nameCell(person){
  const wrap = el('div', 'g-name');
  wrap.appendChild(el('span', 'flag', person.f));
  const txt = el('div', 'txt');
  const cn = el('span', 'cn', person.n);
  const who = el('span', 'who', person.who || '+ add a name');
  who.title = 'Click to name this person';
  who.addEventListener('click', () => editName(person, who));
  txt.appendChild(cn); txt.appendChild(who);
  wrap.appendChild(txt);

  const tools = el('div', 'g-tools');
  const homeBtn = el('button', 'tool' + (person.n === state.homeName ? ' on' : ''), '⌂');
  homeBtn.title = 'Use as the reference city';
  homeBtn.addEventListener('click', () => {
    const prev = homePerson();
    const keep = state.anchor;
    state.homeName = person.n;
    state.anchor = keep || isoDate(partsFor(Date.now(), prev.tz));
    save(); render();
  });
  const flexBtn = el('button', 'tool' + (person.flex ? ' on' : ''), '⚡');
  flexBtn.title = person.flex ? 'Flexible hours: on' : 'Mark as flexible (±1.5 h)';
  flexBtn.addEventListener('click', () => { person.flex = !person.flex; save(); render(); });
  const delBtn = el('button', 'tool', '✕');
  delBtn.title = 'Remove';
  delBtn.addEventListener('click', () => removeCity(person.n));
  tools.appendChild(homeBtn); tools.appendChild(flexBtn); tools.appendChild(delBtn);
  wrap.appendChild(tools);
  return wrap;
}

function editName(person, node){
  const input = el('input');
  input.type = 'text';
  input.value = person.who || '';
  input.placeholder = 'Name';
  input.style.cssText = 'width:100%;font-size:10px;padding:1px 4px';
  node.replaceWith(input);
  input.focus(); input.select();
  const commit = () => { person.who = input.value.trim(); save(); render(); };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape'){ input.removeEventListener('blur', commit); render(); }
  });
}

function renderDetail(){
  const box = $('#detail');
  box.innerHTML = '';
  const slot = state.slots.find(s => s.ts === state.selected);
  if (!slot) return;
  const home = homePerson();
  const hp = partsFor(slot.ts, home.tz);
  const v = verdictFor(slot);

  const card = el('div', 'detail-card');
  const head = el('div', 'detail-head');
  const endHome = partsFor(slot.ts + state.duration * 60000, home.tz);
  head.appendChild(el('h2', null, fmtDate(hp) + ' · ' + fmtTime(hp.H, hp.M) + ' – ' + fmtTime(endHome.H, endHome.M) + ' ' + tzAbbr(slot.ts, home.tz)));
  head.appendChild(el('span', 'verdict-pill ' + v.cls, v.text));

  const actions = el('div', 'detail-actions');
  const copyBtn = el('button', 'btn ghost', 'Copy times');
  copyBtn.addEventListener('click', () => copySummary(slot));
  const calBtn = el('button', 'btn ghost', 'Calendar');
  calBtn.title = 'Open a pre-filled Google Calendar event in a new tab';
  calBtn.addEventListener('click', () => openCalendar(slot));
  actions.appendChild(copyBtn); actions.appendChild(calBtn);
  if (slot.straw.length){
    const logBtn = el('button', 'btn', 'Log short straw');
    logBtn.title = 'Record who took the hit, so the next pick can spread it around';
    logBtn.addEventListener('click', () => logStraw(slot));
    actions.appendChild(logBtn);
  }
  head.appendChild(actions);
  card.appendChild(head);

  const rows = el('div', 'rows');
  const order = orderedPeople();
  order.forEach(person => {
    const e = slot.per.find(x => x.person.n === person.n);
    const isStraw = slot.straw.some(x => x.person.n === person.n);
    const row = el('div', 'drow' + (isStraw ? ' straw' : ''));
    row.appendChild(el('span', 'flag', person.f));
    const who = el('span');
    who.appendChild(el('b', null, person.n));
    if (person.who) who.appendChild(el('span', 'dwho', '  ' + person.who));
    if (person.flex) who.appendChild(el('span', 'dwho', '  ⚡flex'));
    row.appendChild(who);
    row.appendChild(el('span', 'dtime', fmtTime(e.start.H, e.start.M) + ' – ' + fmtTime(e.end.H, e.end.M)));
    row.appendChild(el('span', 'ddate', fmtDate(e.start)));
    const tag = el('span', 'dtag' + (isStraw ? ' straw-tag' : ''), tagFor(e, isStraw));
    row.appendChild(tag);
    rows.appendChild(row);
  });
  card.appendChild(rows);

  const note = el('p', 'straw-note');
  if (!slot.straw.length){
    note.textContent = 'No short straw — this lands inside working hours for everyone. 🎉';
  } else {
    note.appendChild(document.createTextNode('Short straw: '));
    const names = slot.straw.map(x => x.person.who ? x.person.who + ' (' + x.person.n + ')' : x.person.n);
    note.appendChild(el('b', null, names.join(', ')));
    const counts = slot.straw.map(x => state.tally[x.person.n] || 0);
    const totalPrev = counts.reduce((a, b) => a + b, 0);
    if (totalPrev) note.appendChild(document.createTextNode(' — already taken the hit ' + totalPrev + '×.'));
  }
  card.appendChild(note);
  box.appendChild(card);
}

function tagFor(entry, isStraw){
  if (isStraw) return '🥤 short straw';
  const h = entry.start.H;
  if (entry.weekend && state.avoidWeekend) return 'weekend';
  if (entry.pen === 0) return 'in hours';
  if (h < state.workStart) return h < 6 ? 'night' : 'early';
  return h >= 22 ? 'night' : 'late';
}

/* ---------------- actions -------------------------------------------------------- */
function summaryText(slot){
  const home = homePerson();
  const hp = partsFor(slot.ts, home.tz);
  const lines = ['Meeting — ' + fmtDate(hp) + ', ' + state.duration + ' min'];
  orderedPeople().forEach(person => {
    const e = slot.per.find(x => x.person.n === person.n);
    const isStraw = slot.straw.some(x => x.person.n === person.n);
    const label = person.who ? person.n + ' (' + person.who + ')' : person.n;
    lines.push('• ' + label + ' — ' + fmtTime(e.start.H, e.start.M) + '–' + fmtTime(e.end.H, e.end.M) +
      ' ' + tzAbbr(slot.ts, person.tz) + ', ' + fmtDate(e.start) + (isStraw ? '  🥤' : ''));
  });
  if (slot.straw.length){
    lines.push('Short straw: ' + slot.straw.map(x => x.person.who || x.person.n).join(', '));
  }
  return lines.join('\n');
}
async function copySummary(slot){
  const text = summaryText(slot);
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied everyone’s local times');
  } catch {
    const ta = el('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast('Copied everyone’s local times');
  }
}
function gcalStamp(ts){
  const d = new Date(ts);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2,'0') + String(d.getUTCDate()).padStart(2,'0')
    + 'T' + String(d.getUTCHours()).padStart(2,'0') + String(d.getUTCMinutes()).padStart(2,'0') + '00Z';
}
function openCalendar(slot){
  const end = slot.ts + state.duration * 60000;
  const url = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent('Global sync')
    + '&dates=' + gcalStamp(slot.ts) + '/' + gcalStamp(end)
    + '&details=' + encodeURIComponent(summaryText(slot));
  if (HAS_CHROME && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}
function logStraw(slot){
  slot.straw.forEach(x => { state.tally[x.person.n] = (state.tally[x.person.n] || 0) + 1; });
  save(); render();
  toast('Logged — ' + slot.straw.map(x => x.person.n).join(', '));
}
function renderTally(){
  const box = $('#tallyList');
  box.innerHTML = '';
  const entries = Object.entries(state.tally).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length){
    box.appendChild(el('p', 'hint', 'Nothing logged yet. Pick a slot and hit “Log short straw” to start keeping score.'));
    return;
  }
  entries.forEach(([name, count]) => {
    const city = CITIES.find(c => c.n === name);
    const item = el('div', 'tally-item');
    item.appendChild(document.createTextNode((city ? city.f + ' ' : '') + name + '  '));
    item.appendChild(el('b', null, '×' + count));
    box.appendChild(item);
  });
}
let toastTimer = null;
function toast(msg){
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 1900);
}

/* ---------------- controls wiring ------------------------------------------------ */
function shiftDay(delta){
  const [y, m, d] = state.anchor.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  state.anchor = dt.toISOString().slice(0, 10);
  state.selected = null;
  render();
}
$('#prevDay').addEventListener('click', () => shiftDay(-1));
$('#nextDay').addEventListener('click', () => shiftDay(1));
$('#today').addEventListener('click', () => {
  state.anchor = isoDate(partsFor(Date.now(), homePerson().tz));
  state.selected = null; render();
});
$('#anchorDate').addEventListener('change', e => {
  if (e.target.value){ state.anchor = e.target.value; state.selected = null; render(); }
});
$('#duration').addEventListener('change', e => { state.duration = +e.target.value; state.selected = null; save(); render(); });
$('#clearAll').addEventListener('click', () => {
  state.people = []; state.homeName = null; state.selected = null; save(); render();
});
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.dataset.preset.split('|').forEach(n => {
      const c = CITIES.find(x => x.n === n);
      if (c) addCity(c, true);
    });
    state.selected = null; save(); render();
  });
});
$('#settingsBtn').addEventListener('click', () => {
  const p = $('#settings');
  p.classList.toggle('hidden');
  $('#settingsBtn').classList.toggle('on', !p.classList.contains('hidden'));
});
$('#tallyBtn').addEventListener('click', () => {
  const p = $('#tally');
  p.classList.toggle('hidden');
  $('#tallyBtn').classList.toggle('on', !p.classList.contains('hidden'));
});
$('#resetTally').addEventListener('click', () => { state.tally = {}; save(); render(); toast('Tally cleared'); });
$('#workStart').addEventListener('change', e => {
  state.workStart = Math.min(23, Math.max(0, +e.target.value || 0));
  e.target.value = state.workStart; save(); render();
});
$('#workEnd').addEventListener('change', e => {
  state.workEnd = Math.min(24, Math.max(state.workStart + 1, +e.target.value || 17));
  e.target.value = state.workEnd; save(); render();
});
$('#clockFmt').addEventListener('change', e => { state.clockFmt = e.target.value; save(); render(); });
$('#avoidWeekend').addEventListener('change', e => { state.avoidWeekend = e.target.checked; state.selected = null; save(); render(); });
$('#rotatePain').addEventListener('change', e => { state.rotatePain = e.target.checked; state.selected = null; save(); render(); });

/* ---------------- boot ------------------------------------------------------------ */
(async function init(){
  await load();
  $('#workStart').value = state.workStart;
  $('#workEnd').value = state.workEnd;
  $('#clockFmt').value = state.clockFmt;
  $('#avoidWeekend').checked = state.avoidWeekend;
  $('#rotatePain').checked = state.rotatePain;
  render();
})();
