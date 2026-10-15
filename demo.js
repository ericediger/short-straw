/* Builds the demo stage: seeds a fictional team into localStorage, draws the chat page, then loads
   the extension's real popup (markup from popup.html, logic from cities.js + popup.js) into
   #popupRoot. Signals readiness by adding #stageReady, the explainer recorder's readySelector. */
"use strict";
(() => {
  const el = (id) => document.getElementById(id);

  /* ---- fictional team (no real people) ---- */
  const CITY = {
    ny:     { n: 'New York', s: 'United States',  tz: 'America/New_York',  f: '🇺🇸' },
    london: { n: 'London',   s: 'United Kingdom', tz: 'Europe/London',     f: '🇬🇧' },
    sydney: { n: 'Sydney',   s: 'Australia',      tz: 'Australia/Sydney',  f: '🇦🇺' },
  };
  const person = (c, who) => ({ ...c, who, flex: false });
  const TEAM = [person(CITY.ny, 'Maya'), person(CITY.london, 'Tom'), person(CITY.sydney, 'Priya')];
  const UNNAMED = TEAM.map((p) => ({ ...p, who: '' }));

  /* ---- scenarios, by hash ---- */
  const SCENES = {
    cities: { people: [person(CITY.ny, '')] },   // first run: only your own city
    grid:   { people: UNNAMED },
    best:   { people: UNNAMED },
    tools:  { people: UNNAMED },                  // names get attached on camera
    share:  { people: TEAM },
    rotate: { people: TEAM, tally: { Sydney: 1 } }, // Priya already took one late call
  };
  const hash = location.hash.replace('#', '');
  const scene = SCENES[hash];

  function seed(s) {
    const put = (k, v) => localStorage.setItem('tzmp_' + k, JSON.stringify(v));
    put('people', s.people);
    put('homeName', 'New York');
    put('tally', s.tally || {});
    put('duration', 60); put('workStart', 9); put('workEnd', 17);
    put('clockFmt', '12'); put('avoidWeekend', true); put('rotatePain', true);
  }
  // A recorder scenario always starts from its seed; a visitor keeps whatever they did last time.
  if (scene) seed(scene);
  else if (localStorage.getItem('tzmp_people') === null) seed({ people: TEAM });

  /* ---- the chat behind the popup ---- */
  const MSGS = [
    { who: 'Maya Chen', where: 'New York', av: '#d9822b', t: '9:02 AM', text: 'Kickoff sync this week? I was thinking <em>Thursday 9:00 AM ET</em>.' },
    { who: 'Tom Okafor', where: 'London', av: '#3f8f6b', t: '9:04 AM', text: '2 PM for me, works.' },
    { who: 'Priya Raman', where: 'Sydney', av: '#7b5cc4', t: '9:11 AM', text: 'That’s <em>midnight</em> here 😅 Any chance of another slot?' },
    { who: 'Maya Chen', where: 'New York', av: '#d9822b', t: '9:12 AM', text: 'Ugh, sorry Priya. Let me find something fairer.' },
  ];
  el('chatMsgs').innerHTML = MSGS.map((m) => `
    <div class="ch-msg">
      <div class="ch-av" style="background:${m.av}">${m.who.split(' ').map((w) => w[0]).join('')}</div>
      <div><div class="ch-name">${m.who}<small>${m.where} · ${m.t}</small></div><div class="ch-text">${m.text}</div></div>
    </div>`).join('');

  /* ---- scale the 1600x900 stage to the window (the recorder's 2400x1350 viewport gives exactly 1.5x) ---- */
  function fit() {
    el('stage').style.zoom = Math.min(innerWidth / 1600, innerHeight / 900);
  }
  fit();
  addEventListener('resize', fit);

  /* ---- toolbar icon toggles the popup ---- */
  el('extBtn').addEventListener('click', () => {
    const closed = el('popupWrap').classList.toggle('closed');
    el('extBtn').classList.toggle('on', !closed);
  });

  /* ---- "Calendar" opens a new tab: show it in the tab strip with a plain loading page ---- */
  window.open = (url) => {
    el('tabChat').classList.remove('active');
    el('tabCal').classList.remove('cx-hidden');
    el('tabCal').classList.add('active');
    const shown = decodeURIComponent(String(url).replace(/^https?:\/\//, ''));
    el('omniText').textContent = shown.slice(0, 60) + (shown.length > 60 ? '…' : '');
    el('ldUrl').textContent = shown.slice(0, 160) + (shown.length > 160 ? '…' : '');
    el('chatPage').classList.add('cx-hidden');
    el('calPage').classList.remove('cx-hidden');
    el('popupWrap').classList.add('closed');
    el('extBtn').classList.remove('on');
    return null;
  };

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.body.appendChild(s);
  });
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  };

  (async () => {
    const html = await (await fetch('popup.html', { cache: 'no-store' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, link').forEach((n) => n.remove());
    el('popupRoot').append(...doc.body.childNodes);
    await loadScript('cities.js');
    await loadScript('popup.js');
    await until(() => document.querySelector('#grid .cell') || !el('empty').classList.contains('hidden'));
    const ready = document.createElement('div');
    ready.id = 'stageReady';
    ready.hidden = true;
    ready.textContent = 'ready';
    document.body.appendChild(ready);
  })();
})();
