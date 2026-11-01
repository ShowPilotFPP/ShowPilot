// ============================================================
// Step library: the sentences scenarios can use.
// ============================================================
// Each step is a pattern and what it does. "Then" checks keep retrying for a
// few seconds, because viewer pages and the admin update on a short delay
// (sockets / 3 s polling), just like on a real phone.
//
// Song names, messages and other values go in "double quotes". A list of
// songs is written "Alpha", "Bravo" and "Charlie" (commas and/or "and").
//
// To add a sentence: add an entry below with a regular expression and an
// async function (ctx, ...captured values). Keep the wording plain; the
// list in tests/README.md is generated from the `doc` lines here
// (node tests/run.js --steps).
// ============================================================
'use strict';
const path = require('path');
const fs = require('fs');

const q = '"([^"]*)"';                       // one quoted value
const LIST = '((?:"[^"]*"(?:\\s*,\\s*|\\s+and\\s+)?)+)';  // "A", "B" and "C"
const names = (s) => [...s.matchAll(/"([^"]*)"/g)].map(m => m[1]);
const MODES = { voting: 'VOTING', jukebox: 'JUKEBOX', race: 'RACE', 'listen only': 'LISTEN', off: 'OFF', on: 'ON' };
const mode = (s) => { const m = MODES[s.toLowerCase()]; if (!m) throw new Error(`unknown mode "${s}"`); return m; };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// The show's location used by location steps ("at the show" / "N miles away").
const SHOW = { lat: 36.0, lng: -94.0 };
const milesNorth = (mi) => ({ lat: SHOW.lat + mi / 69.0, lng: SHOW.lng });

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function eventually(fn, { timeout = 8000, every = 250 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try { const v = await fn(); if (v !== false) return v; last = new Error('condition not met'); }
    catch (e) { last = e; }
    if (Date.now() > until) throw last;
    await new Promise(r => setTimeout(r, every));
  }
}

// ---- HTTP helpers --------------------------------------------------------
async function http(ctx, method, url, { cookie, body } = {}) {
  const r = await fetch(ctx.sp.base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const admin = (ctx, method, url, body) => http(ctx, method, '/api/admin' + url, { cookie: ctx.sp.adminCookie, body });
async function adminOk(ctx, method, url, body) {
  const r = await admin(ctx, method, url, body);
  assert(r.status < 400, `admin ${method} ${url} → HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
const seqId = (ctx, name) => {
  const row = ctx.sp.db.prepare('SELECT id FROM sequences WHERE name = ? COLLATE NOCASE').get(name);
  assert(row, `no song called "${name}"`);
  return row.id;
};
function phoneBody(ctx, phone, extra) {
  const loc = ctx.phoneLoc.get(phone);
  return loc ? { ...extra, viewerLat: loc.lat, viewerLng: loc.lng } : extra;
}
const state = (ctx) => http(ctx, 'GET', '/api/state', { cookie: ctx.sp.viewerCookie('state-check') }).then(r => r.body);

// ---- Browser helpers -----------------------------------------------------
async function openPhone(ctx, phone, how = '') {
  const h = how.toLowerCase();
  const ua = /facebook/.test(h) ? IPHONE_UA + ' [FBAN/FBIOS;FBAV/450.0]' : /iphone/.test(h) ? IPHONE_UA : undefined;
  const opts = { viewport: { width: 390, height: 844 }, userAgent: ua };
  const loc = ctx.phoneLoc.get(phone);
  if (loc) { opts.geolocation = { latitude: loc.lat, longitude: loc.lng, accuracy: loc.accuracy || 10 }; opts.permissions = ['geolocation']; }
  const browser = await ctx.browser();
  const c = await browser.newContext(opts);
  await c.addCookies([{ name: ctx.sp.cookieName + '_viewer', value: 'phone-' + phone, url: ctx.sp.base }]);
  const page = await c.newPage();
  page.on('pageerror', e => ctx.pageErrors.push(`phone ${phone}: ${e.message}`));
  await page.goto(ctx.sp.base + '/');
  await page.waitForLoadState('networkidle').catch(() => {});
  ctx.pages.set('phone ' + phone, page);
  return page;
}
function pageOf(ctx, who) {
  const p = ctx.pages.get(who);
  assert(p, `${who} hasn't opened a page yet`);
  return p;
}
// A song tile in the song list that's showing (not the queue list).
const tileSel = (name) => `[data-showpilot-container]:not([hidden]) .sequence-item[data-seq="${name.replace(/"/g, '\\"')}"]`;
async function visibleText(page) { return page.evaluate(() => document.body.innerText); }
async function shownMessage(page) {
  return page.evaluate(() => {
    const ids = ['requestSuccessful', 'voteSuccessful', 'requestFailed', 'invalidLocation', 'invalidLocationCode', 'alreadyVoted', 'requestPlaying', 'queueFull', 'songPlaying', 'songNextUp'];
    return ids.map(id => document.getElementById(id)).filter(el => el && getComputedStyle(el).display !== 'none').map(el => el.textContent.trim()).join(' | ');
  });
}
async function openAdmin(ctx, section) {
  let page = ctx.pages.get('admin');
  if (!page) {
    const browser = await ctx.browser();
    const c = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await c.addCookies([{ name: ctx.sp.cookieName, value: ctx.sp.adminToken, url: ctx.sp.base }]);
    page = await c.newPage();
    page.on('pageerror', e => ctx.pageErrors.push(`admin: ${e.message}`));
    ctx.pages.set('admin', page);
  }
  const map = { dashboard: 'dashboard', sequences: 'sequences', 'viewer page': 'viewer', queue: 'queue', stats: 'stats', settings: 'settings' };
  const key = map[section.toLowerCase()];
  assert(key, `unknown admin page "${section}"`);
  await page.goto(ctx.sp.base + '/admin/?section=' + key);
  await page.mouse.move(1390, 890); // keep the hover menu closed
  await page.waitForTimeout(1500);
  return page;
}

// ---- The sentences -------------------------------------------------------
const STEPS = [
  // ===== Show setup =====
  { doc: 'the show has songs "A", "B" and "C"',
    re: new RegExp(`^the show has songs? ${LIST}$`, 'i'),
    fn: async (ctx, list) => {
      const songs = names(list);
      await ctx.player.sync(songs);
      ctx.sp.db.prepare(`UPDATE sequences SET visible = 1, votable = 1, jukeboxable = 1, cooldown_minutes = 0 WHERE name IN (${songs.map(() => '?').join(',')})`).run(...songs);
    } },
  { doc: '"A" is a PSA',
    re: new RegExp(`^${q} is a PSA$`, 'i'),
    fn: async (ctx, name) => { await adminOk(ctx, 'PATCH', '/sequences/' + seqId(ctx, name), { is_psa: 1 }); } },
  { doc: 'a PSA plays after every N songs',
    re: /^a PSA plays after every (\d+) songs?$/i,
    fn: async (ctx, n) => { await adminOk(ctx, 'PUT', '/config', { play_psa_enabled: 1, psa_frequency: Number(n), psa_trigger_mode: 'sequences' }); } },
  { doc: '"A" has the artist "Name"',
    re: new RegExp(`^${q} has the artist ${q}$`, 'i'),
    fn: async (ctx, name, artist) => { await adminOk(ctx, 'PATCH', '/sequences/' + seqId(ctx, name), { artist }); } },
  { doc: '"A" has the badge "New"',
    re: new RegExp(`^${q} has the badge ${q}$`, 'i'),
    fn: async (ctx, name, badge) => { await adminOk(ctx, 'PATCH', '/sequences/' + seqId(ctx, name), { badge }); } },
  { doc: '"A" has a cover',
    re: new RegExp(`^${q} has a cover$`, 'i'),
    fn: async (ctx, name) => { await adminOk(ctx, 'PATCH', '/sequences/' + seqId(ctx, name), { image_url: '/favicons/favicon-monogram.svg#' + encodeURIComponent(name) }); } },
  { doc: '"A" has a cooldown of N minutes',
    re: new RegExp(`^${q} has a cooldown of (\\d+) minutes?$`, 'i'),
    fn: async (ctx, name, n) => { await adminOk(ctx, 'PATCH', '/sequences/' + seqId(ctx, name), { cooldown_minutes: Number(n) }); } },
  { doc: 'the category "Kids" has "A" and "B"',
    re: new RegExp(`^the category ${q} has ${LIST}$`, 'i'),
    fn: async (ctx, cat, list) => {
      await admin(ctx, 'POST', '/categories', { name: cat });
      for (const n of names(list)) await adminOk(ctx, 'PATCH', '/sequences/' + seqId(ctx, n), { category: cat });
    } },
  { doc: 'the viewer page uses the test template (Remote Falcon style)',
    re: /^the viewer page uses the test template$/i,
    fn: async (ctx) => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'rf-test.html'), 'utf8');
      const db = ctx.sp.db;
      db.prepare("DELETE FROM viewer_page_templates WHERE name = 'Scenario test template'").run();
      db.prepare("INSERT INTO viewer_page_templates (name, html, is_active) VALUES ('Scenario test template', ?, 0)").run(html);
      db.prepare("UPDATE viewer_page_templates SET is_active = (name = 'Scenario test template')").run();
    } },
  { doc: 'phones must be within N miles to vote or request',
    re: /^phones must be within ([\d.]+) miles? to vote or request$/i,
    fn: async (ctx, mi) => { await adminOk(ctx, 'PUT', '/config', { check_viewer_present: 1, viewer_present_mode: 'GPS', show_latitude: SHOW.lat, show_longitude: SHOW.lng, check_radius_miles: Number(mi) }); } },
  { doc: 'the setting "name" is on / off (any admin setting by its database name)',
    re: new RegExp(`^the setting ${q} is (on|off|${q})$`, 'i'),
    fn: async (ctx, key, onoff, val) => { await adminOk(ctx, 'PUT', '/config', { [key]: val !== undefined ? val : (onoff.toLowerCase() === 'on' ? 1 : 0) }); } },

  // ===== Show player (FPP or another show player) =====
  { doc: 'the mode is Voting | Jukebox | Race | Listen only | Off   (set by the show player, like an FPP command)',
    re: /^the mode is (voting|jukebox|race|listen only|off)$/i,
    fn: async (ctx, m) => { await ctx.player.setMode(mode(m)); } },
  { doc: 'the show player switches to Voting | Jukebox | Race | Listen only | Off | On',
    re: /^the show player switches (?:to |viewer control )?(voting|jukebox|race|listen only|off|on)(?: mode)?$/i,
    fn: async (ctx, m) => { await ctx.player.setMode(mode(m)); } },
  { doc: 'the show player plays "A"',
    re: new RegExp(`^the show player (?:plays|starts) ${q}$`, 'i'),
    fn: async (ctx, name) => { await ctx.player.play(name); } },
  { doc: 'the song ends   (the show player plays whatever ShowPilot asks for, else the next song)',
    re: /^the song ends$/i,
    fn: async (ctx) => { ctx.last.played = await ctx.player.playNext(); } },
  { doc: 'the show player clears the queue   (the "Clear Queue" FPP command)',
    re: /^the show player clears the queue$/i,
    fn: async (ctx) => { ctx.last.cleared = await ctx.player.clearQueue(); } },
  { doc: 'the show player switches the category "Kids" off | on',
    re: new RegExp(`^the show player switches the category ${q} (off|on)$`, 'i'),
    fn: async (ctx, name, onoff) => { await ctx.player.setCategory(name, onoff.toLowerCase() === 'on'); } },

  // ===== Phones (quick, no browser) =====
  { doc: 'phone 1 is at the show | is N miles away [with a rough location]',
    re: /^phone (\w+) is (at the show|([\d.]+) miles? away)( with a rough location)?$/i,
    fn: async (ctx, phone, _w, mi, rough) => {
      const loc = mi ? milesNorth(Number(mi)) : { ...SHOW };
      loc.accuracy = rough ? 6000 : 10;
      ctx.phoneLoc.set(phone, loc);
    } },
  { doc: 'phone 1 votes for "A"',
    re: new RegExp(`^phone (\\w+) votes for ${q}$`, 'i'),
    fn: async (ctx, phone, name) => { ctx.last.answer = await http(ctx, 'POST', '/api/vote', { cookie: ctx.sp.viewerCookie(phone), body: phoneBody(ctx, phone, { sequenceName: name }) }); } },
  { doc: 'N phones vote for "A"',
    re: new RegExp(`^(\\d+) phones vote for ${q}$`, 'i'),
    fn: async (ctx, n, name) => {
      for (let i = 0; i < Number(n); i++) {
        const r = await http(ctx, 'POST', '/api/vote', { cookie: ctx.sp.viewerCookie(`bulk-${name}-${ctx.bulk++}`), body: { sequenceName: name } });
        assert(r.status < 400, `vote ${i + 1} refused: ${JSON.stringify(r.body)}`);
      }
    } },
  { doc: 'phone 1 requests "A"',
    re: new RegExp(`^phone (\\w+) requests ${q}$`, 'i'),
    fn: async (ctx, phone, name) => { ctx.last.answer = await http(ctx, 'POST', '/api/jukebox/add', { cookie: ctx.sp.viewerCookie(phone), body: phoneBody(ctx, phone, { sequenceName: name }) }); } },
  { doc: 'N phones are listening   (Listen on Phone open)',
    re: /^(\d+) phones? (?:are|is) listening$/i,
    fn: async (ctx, n) => {
      for (let i = 0; i < Number(n); i++) await http(ctx, 'GET', '/api/now-playing-audio', { cookie: ctx.sp.viewerCookie('listener-' + i) });
    } },

  // ===== Phones in a browser =====
  { doc: 'phone 1 opens the viewer page [as an iPhone | in Facebook\'s browser]',
    re: /^phone (\w+) opens the viewer page(?: (as an iphone|in facebook's browser))?$/i,
    browser: true,
    fn: async (ctx, phone, how) => { await openPhone(ctx, phone, how || ''); } },
  { doc: 'phone 1 taps "A"',
    re: new RegExp(`^phone (\\w+) taps ${q}$`, 'i'),
    browser: true,
    fn: async (ctx, phone, name) => {
      const page = pageOf(ctx, 'phone ' + phone);
      await page.click(tileSel(name));
      await page.waitForTimeout(1200);
    } },
  { doc: 'the admin opens the Dashboard | Sequences | Viewer Page | Queue | Stats page',
    re: /^the admin opens the (dashboard|sequences|viewer page|queue|stats|settings) page$/i,
    browser: true,
    fn: async (ctx, section) => { await openAdmin(ctx, section); } },
  { doc: 'the admin ticks "Hide PSAs"',
    re: /^the admin ticks "hide psas"$/i,
    browser: true,
    fn: async (ctx) => { const p = pageOf(ctx, 'admin'); await p.$eval('#spnTopHidePsa', c => { if (!c.checked) c.click(); }); await p.waitForTimeout(400); } },

  // ===== Admin actions (no browser) =====
  { doc: 'the admin switches to Voting | Jukebox | Race | Listen only | Off',
    re: /^the admin switches (?:the mode )?to (voting|jukebox|race|listen only|off)$/i,
    fn: async (ctx, m) => { await adminOk(ctx, 'PUT', '/config', { viewer_control_mode: mode(m) }); } },
  { doc: 'the admin clears the queue',
    re: /^the admin clears the queue$/i,
    fn: async (ctx) => { await adminOk(ctx, 'POST', '/purge-queue'); } },
  { doc: 'the template\'s draft has a script that never finishes',
    re: /^the template's draft has a script that never finishes$/i,
    fn: async (ctx) => {
      const id = ctx.sp.db.prepare('SELECT id FROM viewer_page_templates WHERE is_active = 1').get().id;
      ctx.sp.db.prepare("UPDATE viewer_page_templates SET draft_html = ?, mode = 'code' WHERE id = ?").run('<html><body><h1>stuck</h1><script>while (true) {}</script></body></html>', id);
    } },

  // ===== Checks: votes, queue, what plays =====
  { doc: '"A" has N votes',
    re: new RegExp(`^${q} has (\\d+) votes?$`, 'i'),
    fn: async (ctx, name, n) => eventually(async () => {
      const st = await state(ctx);
      const c = ((st.voteCounts || []).find(v => v.sequence_name === name) || {}).count || 0;
      assert(c === Number(n), `"${name}" has ${c} votes, expected ${n}`);
    }) },
  { doc: 'the queue is "A" and "B" | the queue is empty',
    re: new RegExp(`^the queue is (empty|${LIST})$`, 'i'),
    fn: async (ctx, what) => eventually(async () => {
      const st = await state(ctx);
      const got = (st.queue || []).map(x => x.sequence_name);
      const want = /^empty$/i.test(what) ? [] : names(what);
      assert(JSON.stringify(got) === JSON.stringify(want), `queue is [${got.join(', ')}], expected [${want.join(', ')}]`);
    }) },
  { doc: '"A" plays next | "A" plays next as a vote | request | PSA',
    re: new RegExp(`^${q} plays next(?: as an? (vote|request|psa))?$`, 'i'),
    fn: async (ctx, name, why) => {
      const r = await ctx.player.playNext();
      ctx.last.played = r;
      assert(r.name === name, `"${r.name}" played next (${r.why}), expected "${name}"`);
      if (why) assert(r.why === why.toLowerCase(), `"${name}" played as ${r.why}, expected ${why.toLowerCase()}`);
    } },
  { doc: 'the show player is not given a song   (it follows its own schedule)',
    re: /^the show player is not given a song$/i,
    fn: async (ctx) => { const a = await ctx.player.ask(); assert(!a.name, `ShowPilot asked for "${a.name}" (${a.why})`); } },
  { doc: 'no PSA is handed out',
    re: /^no psa is handed out$/i,
    fn: async (ctx) => { const a = await ctx.player.ask(); assert(!(a.state.psa && a.state.psa.sequence), `PSA "${a.state.psa && a.state.psa.sequence}" was handed out`); } },
  { doc: 'it is refused with "text"   (the last vote or request)',
    re: new RegExp(`^it is refused(?: with ${q})?$`, 'i'),
    fn: async (ctx, text) => {
      const a = ctx.last.answer; assert(a, 'no vote or request to check');
      assert(a.status >= 400, `it was accepted (HTTP ${a.status})`);
      if (text) assert(String(a.body && a.body.error).toLowerCase().includes(text.toLowerCase()), `refused with "${a.body && a.body.error}", expected "${text}"`);
    } },
  { doc: 'it is accepted',
    re: /^it is accepted$/i,
    fn: async (ctx) => { const a = ctx.last.answer; assert(a && a.status < 400, `refused: HTTP ${a && a.status} ${JSON.stringify(a && a.body)}`); } },
  { doc: 'the mode is now Voting | Jukebox | … ',
    re: /^the mode is now (voting|jukebox|race|listen only|off)$/i,
    fn: async (ctx, m) => { const st = await state(ctx); assert(st.viewerControlMode === mode(m), `mode is ${st.viewerControlMode}`); } },
  { doc: 'the admin shows N listening',
    re: /^the admin shows (\d+) listening$/i,
    fn: async (ctx, n) => eventually(async () => {
      const s = await adminOk(ctx, 'GET', '/stats');
      assert(s.listenersNow === Number(n), `admin shows ${s.listenersNow} listening, expected ${n}`);
    }) },
  { doc: 'the Top Sequences list is "A" and "B" [with PSAs hidden]',
    re: new RegExp(`^the top sequences list is ${LIST}( with psas hidden)?$`, 'i'),
    fn: async (ctx, list, hidden) => {
      const s = await adminOk(ctx, 'GET', '/stats');
      const got = (hidden ? s.topSequencesNoPsa : s.topSequences).map(x => x.sequence_name);
      assert(JSON.stringify(got) === JSON.stringify(names(list)), `Top Sequences is [${got.join(', ')}]`);
    } },

  // ===== Checks: what a phone sees =====
  { doc: 'phone 1 sees "text"',
    re: new RegExp(`^phone (\\w+) sees ${q}$`, 'i'),
    fn: async (ctx, phone, text) => eventually(async () => {
      const t = await visibleText(pageOf(ctx, 'phone ' + phone));
      assert(t.includes(text), `phone ${phone} doesn't show "${text}"`);
    }) },
  { doc: 'phone 1 does not see "text"',
    re: new RegExp(`^phone (\\w+) does not see ${q}$`, 'i'),
    fn: async (ctx, phone, text) => eventually(async () => {
      const t = await visibleText(pageOf(ctx, 'phone ' + phone));
      assert(!t.includes(text), `phone ${phone} still shows "${text}"`);
    }) },
  { doc: 'phone 1 gets the message "text"   (the pop-up after a tap)',
    re: new RegExp(`^phone (\\w+) gets the message ${q}$`, 'i'),
    fn: async (ctx, phone, text) => eventually(async () => {
      const m = await shownMessage(pageOf(ctx, 'phone ' + phone));
      assert(m.toLowerCase().includes(text.toLowerCase()), `phone ${phone} shows "${m || 'no message'}"`);
    }, { timeout: 5000 }) },
  { doc: 'on phone 1, "A" is marked as queued [#N] | is not marked as queued',
    re: new RegExp(`^on phone (\\w+), ${q} is (not )?marked as queued(?: #(\\d+))?$`, 'i'),
    fn: async (ctx, phone, name, not, pos) => eventually(async () => {
      const r = await pageOf(ctx, 'phone ' + phone).$eval(tileSel(name), el => ({ q: el.classList.contains('showpilot-queued'), p: el.getAttribute('data-queue-position') }));
      if (not) assert(!r.q, `"${name}" is marked as queued`);
      else { assert(r.q, `"${name}" is not marked as queued`); if (pos) assert(r.p === pos, `"${name}" is queued #${r.p}, expected #${pos}`); }
    }) },
  { doc: 'on phone 1, "A" shows the badge "New" fully',
    re: new RegExp(`^on phone (\\w+), ${q} shows the badge ${q}(?: fully)?$`, 'i'),
    fn: async (ctx, phone, name, badge) => eventually(async () => {
      const r = await pageOf(ctx, 'phone ' + phone).$eval(tileSel(name), el => {
        const b = el.querySelector('.sequence-badge'); if (!b) return null;
        const t = el.getBoundingClientRect(), r = b.getBoundingClientRect();
        return { text: b.textContent, shown: getComputedStyle(b).display !== 'none' && r.width > 0, inside: r.left >= t.left - 1 && r.right <= t.right + 1 && r.top >= t.top - 1 && r.bottom <= t.bottom + 1, whole: b.scrollWidth <= b.clientWidth + 1 };
      });
      assert(r, `"${name}" has no badge`);
      assert(r.text === badge, `"${name}" shows the badge "${r.text}"`);
      assert(r.shown && r.inside && r.whole, `the badge on "${name}" is hidden or cut off: ${JSON.stringify(r)}`);
    }) },
  { doc: 'phone 1 shows the cover of "A" for Now Playing | Up Next',
    re: new RegExp(`^phone (\\w+) shows the cover of ${q} for (now playing|up next)$`, 'i'),
    fn: async (ctx, phone, name, which) => eventually(async () => {
      const sel = /now/i.test(which) ? '[data-showpilot-now-img]' : '[data-showpilot-next-img]';
      const r = await pageOf(ctx, 'phone ' + phone).$eval(sel, el => ({ src: el.getAttribute('src') || '', shown: el.style.display !== 'none' && el.offsetWidth > 0 }));
      assert(r.shown && r.src.includes('#' + encodeURIComponent(name)), `${which} cover is ${r.shown ? r.src : 'hidden'}`);
    }) },
  { doc: 'phone 1 shows no cover for Up Next | Now Playing',
    re: /^phone (\w+) shows no cover for (now playing|up next)$/i,
    fn: async (ctx, phone, which) => eventually(async () => {
      const sel = /now/i.test(which) ? '[data-showpilot-now-img]' : '[data-showpilot-next-img]';
      const shown = await pageOf(ctx, 'phone ' + phone).$eval(sel, el => el.style.display !== 'none' && el.offsetWidth > 0);
      assert(!shown, `${which} cover is still showing`);
    }) },
  { doc: 'phone 1 shows "Name" as the Now Playing artist | shows no Now Playing artist',
    re: new RegExp(`^phone (\\w+) shows (?:${q} as the|no) now playing artist$`, 'i'),
    fn: async (ctx, phone, artist) => eventually(async () => {
      const t = await pageOf(ctx, 'phone ' + phone).$eval('[data-showpilot-now-artist]', el => el.textContent.trim());
      assert(t === (artist || ''), `Now Playing artist is "${t}"`);
    }) },
  { doc: 'phone 1 is in Listen Only   (body class + notice)',
    re: /^phone (\w+) is (not )?in listen only$/i,
    fn: async (ctx, phone, not) => eventually(async () => {
      const on = await pageOf(ctx, 'phone ' + phone).evaluate(() => document.body.classList.contains('showpilot-listen-only') && !!document.getElementById('showpilot-listen-notice'));
      assert(not ? !on : on, not ? 'phone is still in Listen Only' : 'phone is not in Listen Only');
    }) },

  // ===== Checks: admin in a browser =====
  { doc: 'the admin sees "text"',
    re: new RegExp(`^the admin sees ${q}$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const t = await visibleText(pageOf(ctx, 'admin'));
      assert(t.includes(text), `the admin page doesn't show "${text}"`);
    }) },
  { doc: 'the admin does not see "text" in Top sequences',
    re: new RegExp(`^the admin does not see ${q} in top sequences$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const t = await pageOf(ctx, 'admin').$eval('#spnTop', el => el.innerText);
      assert(!t.includes(text), `Top sequences still shows "${text}"`);
    }) },
  { doc: 'the admin page still responds',
    re: /^the admin page (still )?responds$/i,
    fn: async (ctx) => {
      const ok = await Promise.race([pageOf(ctx, 'admin').evaluate(() => 1).then(() => true), new Promise(r => setTimeout(() => r(false), 3000))]);
      assert(ok, 'the admin page is frozen');
    } },
  { doc: 'the preview is paused',
    re: /^the preview is (paused|loaded)$/i,
    fn: async (ctx, what) => eventually(async () => {
      const r = await pageOf(ctx, 'admin').evaluate(() => ({ paused: getComputedStyle(document.getElementById('previewPaused')).display !== 'none', src: document.getElementById('designerPreview').getAttribute('src') || '' }));
      if (what.toLowerCase() === 'paused') assert(r.paused, 'the preview is not paused');
      else assert(!r.paused && r.src.includes('preview='), `the preview is not loaded (${JSON.stringify(r)})`);
    }) },
  { doc: 'the admin\'s preview froze earlier   (simulates a freeze on the last visit)',
    re: /^the admin's preview froze earlier$/i,
    browser: true,
    fn: async (ctx) => {
      const p = pageOf(ctx, 'admin');
      const id = ctx.sp.db.prepare('SELECT id FROM viewer_page_templates WHERE is_active = 1').get().id;
      await p.evaluate((id) => localStorage.setItem('sp_preview_loading', JSON.stringify({ id, at: Date.now() })), id);
    } },
  { doc: 'the admin clicks "Button text"',
    re: new RegExp(`^the admin clicks ${q}$`, 'i'),
    fn: async (ctx, label) => {
      const p = pageOf(ctx, 'admin');
      const ok = await p.evaluate((label) => { const b = [...document.querySelectorAll('button')].filter(x => x.offsetParent && x.textContent.trim() === label); if (!b.length) return false; b[b.length - 1].click(); return true; }, label);
      assert(ok, `no visible "${label}" button`);
      await p.waitForTimeout(800);
    } },
  { doc: 'the draft is gone',
    re: /^the draft is gone$/i,
    fn: async (ctx) => eventually(async () => {
      const r = ctx.sp.db.prepare('SELECT draft_html FROM viewer_page_templates WHERE is_active = 1').get();
      assert(!r.draft_html, 'the draft is still there');
    }) },

  // ===== Timing =====
  { doc: 'N seconds pass',
    re: /^(\d+) seconds? pass(?:es)?$/i,
    fn: async (_ctx, n) => { await new Promise(r => setTimeout(r, Number(n) * 1000)); } },
];

module.exports = { STEPS };
