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
  ctx.pages.set('phone ' + phone, page);
  // A page whose script hangs never finishes loading; later steps say
  // whether that was expected ("... is frozen") or not ("... responds").
  await page.goto(ctx.sp.base + '/', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
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
  const map = { dashboard: 'dashboard', sequences: 'sequences', 'viewer page': 'viewer', queue: 'queue', stats: 'stats', settings: 'settings', tools: 'tools' };
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
  { doc: 'there is also a viewer page "Name"   (a copy of the test template with that name in its title)',
    re: new RegExp(`^there is (?:also )?a viewer page ${q}$`, 'i'),
    fn: async (ctx, name) => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'rf-test.html'), 'utf8').replace(/<body[^>]*>/i, (b) => `${b}<h1 class="page-name">${name}</h1>`);
      ctx.sp.db.prepare('INSERT INTO viewer_page_templates (name, html, is_active) VALUES (?, ?, 0)').run(name, html);
    } },
  { doc: 'the template\'s draft is the file "name.html"   (from tests/templates)',
    re: new RegExp(`^the template's draft is the file ${q}$`, 'i'),
    fn: async (ctx, file) => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'templates', file), 'utf8');
      ctx.sp.db.prepare("UPDATE viewer_page_templates SET draft_html = ?, mode = 'code' WHERE is_active = 1").run(html);
    } },
  { doc: 'the live viewer page is the file "name.html"   (from tests/templates)',
    re: new RegExp(`^the live viewer page is the file ${q}$`, 'i'),
    fn: async (ctx, file) => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'templates', file), 'utf8');
      ctx.sp.db.prepare('UPDATE viewer_page_templates SET html = ? WHERE is_active = 1').run(html);
    } },
  { doc: 'the global CSS is "css"',
    re: new RegExp(`^the global CSS is ${q}$`, 'i'),
    fn: async (ctx, css) => { await adminOk(ctx, 'PUT', '/global-css', { css, enabled: true }); } },
  { doc: 'the global CSS is turned off | on',
    re: /^the global CSS is turned (off|on)$/i,
    fn: async (ctx, onoff) => { await adminOk(ctx, 'PUT', '/global-css', { enabled: onoff.toLowerCase() === 'on' }); } },
  { doc: 'the admin restores the previous global CSS',
    re: /^the admin restores the previous global CSS$/i,
    fn: async (ctx) => { await adminOk(ctx, 'POST', '/global-css/restore'); } },
  { doc: 'the viewer page is built from the Now Playing and Up Next blocks | the Settings designer   (saved like the admin does)',
    re: /^the viewer page is built (?:from the now playing and up next blocks|with the (settings) designer)$/i,
    fn: async (ctx, settings) => {
      const id = ctx.sp.db.prepare('SELECT id FROM viewer_page_templates WHERE is_active = 1').get().id;
      const body = settings ? { mode: 'settings', settings: {} }
        : { mode: 'blocks', settings: {}, blocks: [{ type: 'nowPlaying', props: {} }, { type: 'nextUp', props: {} }] };
      await adminOk(ctx, 'POST', `/templates/${id}/draft`, body);
      await adminOk(ctx, 'POST', `/templates/${id}/commit`);
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
  { doc: 'the show player takes every waiting request   (into its own queue, like the FPP plugin near the end of a song)',
    re: /^the show player takes every waiting request$/i,
    fn: async (ctx) => { ctx.last.taken = await ctx.player.takeAll(); } },
  { doc: 'the show player checks the mode [with peek]   (the plugin\'s once-a-minute check; without peek it ignores everything but the mode)',
    re: /^the show player checks the mode( with peek)?$/i,
    fn: async (ctx, peek) => { await ctx.player.checkMode({ peek: !!peek }); } },
  { doc: 'the mode check tells the show player requests come one at a time   (peek: true; plugin 0.14.21+ relies on it)',
    re: /^the mode check tells the show player requests come one at a time$/i,
    fn: async (ctx) => { assert(ctx.player.lastModeCheck && ctx.player.lastModeCheck.peek === true, `the mode check answered ${JSON.stringify(ctx.player.lastModeCheck)}`); } },
  { doc: 'nothing has been handed to the show player',
    re: /^nothing has been handed to the show player$/i,
    fn: async (ctx) => {
      const n = ctx.sp.db.prepare('SELECT COUNT(*) AS n FROM jukebox_queue WHERE handed_off_at IS NOT NULL').get().n;
      assert(n === 0, `${n} request(s) were handed to the show player`);
    } },
  { doc: '"A" has been playing for N seconds   (moves its start time back)',
    re: new RegExp(`^${q} has been playing for (\\d+) seconds$`, 'i'),
    fn: async (ctx, name, n) => {
      const at = new Date(Date.now() - Number(n) * 1000).toISOString().replace('T', ' ').replace('Z', '');
      ctx.sp.db.prepare('UPDATE now_playing SET started_at = ? WHERE id = 1 AND sequence_name = ?').run(at, name);
    } },
  { doc: 'the show player reports "A" at N seconds   (its playback position)',
    re: new RegExp(`^the show player reports ${q} at ([\\d.]+) seconds$`, 'i'),
    fn: async (ctx, name, s) => { await ctx.player.reportPosition(name, Number(s)); } },
  { doc: 'the song shows N seconds played   (within 2 s, from the viewer state)',
    re: /^the song shows (\d+) seconds played$/i,
    fn: async (ctx, n) => eventually(async () => {
      const st = await state(ctx);
      const el = (Date.now() - Date.parse(st.nowPlayingStartedAtIso)) / 1000;
      assert(Math.abs(el - Number(n)) <= 2, `the song shows ${el.toFixed(1)} s played, expected about ${n}`);
    }) },
  { doc: 'the show player\'s own queue is "A" and "B"',
    re: new RegExp(`^the show player's own queue is ${LIST}$`, 'i'),
    fn: async (ctx, list) => {
      const want = names(list);
      assert(JSON.stringify(ctx.player.queue) === JSON.stringify(want), `the show player's queue is [${ctx.player.queue.join(', ')}], expected [${want.join(', ')}]`);
    } },
  { doc: 'the show player clears the queue   (the "Clear Queue" FPP command)',
    re: /^the show player clears the queue$/i,
    fn: async (ctx) => { ctx.last.cleared = await ctx.player.clearQueue(); } },
  { doc: 'the show player sets the viewer page to "Name"   (the "Set Viewer Page" command)',
    re: new RegExp(`^the show player sets the viewer page to ${q}$`, 'i'),
    fn: async (ctx, name) => {
      try { ctx.last.result = { ok: true, body: await ctx.player.setViewerPage(name) }; }
      catch (e) { ctx.last.result = { ok: false, error: e.message }; }
    } },
  { doc: 'the show player is the FPP plugin version "0.14.18"   (its heartbeat)',
    re: new RegExp(`^the show player is the FPP plugin version ${q}$`, 'i'),
    fn: async (ctx, v) => { ctx.last.heartbeat = await ctx.player.heartbeat({ pluginVersion: v }); } },
  { doc: 'the show player is version "player-0.13.6" and says "0.13.7" is the newest   (a non-FPP show player\'s heartbeat)',
    re: new RegExp(`^the show player is version ${q} and says ${q} is the newest$`, 'i'),
    fn: async (ctx, v, latest) => { ctx.last.heartbeat = await ctx.player.heartbeat({ pluginVersion: v, latestVersion: latest }); } },
  { doc: 'the show player is told "0.14.21" is the newest plugin | is told nothing about updates',
    re: new RegExp(`^the show player is (?:told ${q} is the newest plugin|told nothing about updates)$`, 'i'),
    fn: async (ctx, v) => {
      const h = ctx.last.heartbeat || {};
      if (v) assert(h.pluginLatest === v, `the heartbeat answer says the newest plugin is ${h.pluginLatest}`);
      else assert(!('pluginLatest' in h), `the heartbeat answer mentions plugin ${h.pluginLatest}`);
    } },
  { doc: 'ShowPilot "9.9.9" is out   (the newest release the update check finds)',
    re: new RegExp(`^ShowPilot ${q} is out$`, 'i'),
    fn: async (ctx, v) => {
      require('fs').writeFileSync(require('path').join(ctx.sp.app, 'data', 'test-release.json'), JSON.stringify({ stable: v }));
    } },
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
  { doc: 'phone 1 opens Listen on Phone   (taps the headphones button)',
    re: /^phone (\w+) opens listen on phone$/i,
    fn: async (ctx, phone) => {
      const p = pageOf(ctx, 'phone ' + phone);
      await p.click('#of-listen-btn');
      await p.waitForTimeout(2500);
    } },
  { doc: 'phone 1\'s player shows "Title" with the cover of "A" | with the no-cover picture',
    re: new RegExp(`^phone (\\w+)'s player shows ${q} with (?:the cover of ${q}|the no-cover picture)$`, 'i'),
    fn: async (ctx, phone, title, coverOf) => eventually(async () => {
      const r = await pageOf(ctx, 'phone ' + phone).evaluate(() => {
        const c = document.getElementById('of-listen-cover');
        return { title: document.getElementById('of-listen-title').textContent, src: c.getAttribute('src') || '', loaded: c.complete && c.naturalWidth > 0, visible: getComputedStyle(c).visibility !== 'hidden' && c.offsetWidth > 0 };
      });
      assert(r.title === title, `the player's title is "${r.title}"`);
      assert(r.visible && r.loaded, `the player's picture isn't showing properly (${JSON.stringify(r).slice(0, 160)})`);
      if (coverOf) {
        const want = ctx.sp.db.prepare('SELECT image_url FROM sequences WHERE name = ?').get(coverOf).image_url.split('#')[0];
        assert(r.src.startsWith(want), `the player shows ${r.src.slice(0, 80)}, expected the cover of "${coverOf}"`);
      } else {
        assert(r.src.startsWith('data:image/svg'), `expected the no-cover picture, got ${r.src.slice(0, 80)}`);
      }
    }) },
  { doc: 'phone 1 opens Audio timing   (the timing button on the player)',
    re: /^phone (\w+) opens audio timing$/i,
    fn: async (ctx, phone) => { const p = pageOf(ctx, 'phone ' + phone); await p.click('#sp-lt-btn'); await p.waitForTimeout(600); } },
  { doc: 'phone 1\'s player has the "christmas" decoration',
    re: new RegExp(`^phone (\\w+)'s player has the ${q} decoration$`, 'i'),
    fn: async (ctx, phone, theme) => eventually(async () => {
      const cls = await pageOf(ctx, 'phone ' + phone).evaluate(() => document.getElementById('of-listen-panel').className);
      assert(cls.split(/\s+/).includes('of-theme-' + theme), `the player's classes are "${cls}"`);
    }) },
  { doc: 'phone 1 taps "A"',
    re: new RegExp(`^phone (\\w+) taps ${q}$`, 'i'),
    browser: true,
    fn: async (ctx, phone, name) => {
      const page = pageOf(ctx, 'phone ' + phone);
      await page.click(tileSel(name));
      await page.waitForTimeout(1200);
    } },
  { doc: 'the admin opens the Dashboard | Sequences | Viewer Page | Queue | Stats page',
    re: /^the admin opens the (dashboard|sequences|viewer page|queue|stats|settings|tools) page$/i,
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
  { doc: 'phone 1 shows "Name" as the Now Playing | Up Next artist | shows no Now Playing | Up Next artist',
    re: new RegExp(`^phone (\\w+) shows (?:${q} as the|no) (now playing|up next) artist$`, 'i'),
    fn: async (ctx, phone, artist, which) => eventually(async () => {
      const sel = /next/i.test(which) ? '[data-showpilot-next-artist]' : '[data-showpilot-now-artist]';
      const t = await pageOf(ctx, 'phone ' + phone).$eval(sel, el => el.textContent.trim());
      assert(t === (artist || ''), `${which} artist is "${t}"`);
    }) },
  { doc: 'the phone player is sent the cover of "A" with no audio   (Listen on Phone, for a song without an audio file)',
    re: new RegExp(`^the phone player is sent the cover of ${q} with no audio$`, 'i'),
    fn: async (ctx, name) => {
      const r = await http(ctx, 'GET', '/api/now-playing-audio', { cookie: ctx.sp.viewerCookie('player') });
      const want = ctx.sp.db.prepare('SELECT image_url FROM sequences WHERE name = ?').get(name).image_url;
      assert(r.body.playing && r.body.hasAudio === false, `expected a playing song without audio, got ${JSON.stringify(r.body).slice(0, 150)}`);
      assert(r.body.imageUrl && r.body.imageUrl.startsWith(want.split('#')[0]), `the player was sent cover ${JSON.stringify(r.body.imageUrl)}`);
      assert(r.body.sequenceName === name, `the player was sent "${r.body.sequenceName}"`);
    } },
  { doc: 'phone 1 is in Listen Only   (body class + notice)',
    re: /^phone (\w+) is (not )?in listen only$/i,
    fn: async (ctx, phone, not) => eventually(async () => {
      const on = await pageOf(ctx, 'phone ' + phone).evaluate(() => document.body.classList.contains('showpilot-listen-only') && !!document.getElementById('showpilot-listen-notice'));
      assert(not ? !on : on, not ? 'phone is still in Listen Only' : 'phone is not in Listen Only');
    }) },

  { doc: 'phone 1\'s page says the mode is "listen-only"   (data-showpilot-mode on <html> and <body>)',
    re: new RegExp(`^phone (\\w+)'s page says the mode is ${q}$`, 'i'),
    fn: async (ctx, phone, want) => eventually(async () => {
      const r = await pageOf(ctx, 'phone ' + phone).evaluate(() => [document.documentElement.getAttribute('data-showpilot-mode'), document.body.getAttribute('data-showpilot-mode')]);
      assert(r[0] === want && r[1] === want, `<html> says "${r[0]}", <body> says "${r[1]}", expected "${want}"`);
    }) },
  { doc: 'the viewer page as first sent says the mode is "listen-only"   (before any script runs)',
    re: new RegExp(`^the viewer page as first sent says the mode is ${q}$`, 'i'),
    fn: async (ctx, want) => {
      const html = await (await fetch(ctx.sp.base + '/')).text();
      const h = /<html\b[^>]*>/i.exec(html), b = /<body\b[^>]*>/i.exec(html);
      const attr = (t) => t && (/data-showpilot-mode="([^"]*)"/.exec(t[0]) || [])[1];
      assert(attr(h) === want && attr(b) === want, `sent <html> says "${attr(h)}", <body> says "${attr(b)}", expected "${want}"`);
      if (want === 'listen-only') assert(/showpilot-listen-only/.test(b[0]), 'sent <body> has no showpilot-listen-only class');
    } },
  { doc: 'on phone 1, the "color" of "selector" is [not] "rgb(1, 2, 3)"',
    re: new RegExp(`^on phone (\\w+), the ${q} of ${q} is (not )?${q}$`, 'i'),
    fn: async (ctx, phone, prop, sel, not, want) => eventually(async () => {
      const v = await pageOf(ctx, 'phone ' + phone).evaluate(([sel, prop]) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(prop) : null; }, [sel, prop]);
      assert(v !== null, `nothing on the page matches "${sel}"`);
      if (not) assert(v.trim() !== want, `${prop} of ${sel} is still "${want}"`);
      else assert(v.trim() === want, `${prop} of ${sel} is "${v}", expected "${want}"`);
    }) },
  { doc: 'phone 1\'s page still responds',
    re: /^phone (\w+)'s page (?:still )?responds$/i,
    fn: async (ctx, phone) => {
      const ok = await Promise.race([pageOf(ctx, 'phone ' + phone).evaluate(() => 1).then(() => true), new Promise(r => setTimeout(() => r(false), 3000))]);
      assert(ok, `phone ${phone}'s page is frozen`);
    } },
  { doc: 'phone 1\'s page is frozen',
    re: /^phone (\w+)'s page is frozen$/i,
    fn: async (ctx, phone) => {
      const ok = await Promise.race([pageOf(ctx, 'phone ' + phone).evaluate(() => 1).then(() => true), new Promise(r => setTimeout(() => r(false), 3000))]);
      assert(!ok, `phone ${phone}'s page still responds`);
      ctx.pages.delete('phone ' + phone); // no screenshots of a frozen page
    } },
  { doc: 'the live viewer page is "Name"',
    re: new RegExp(`^the live viewer page is ${q}$`, 'i'),
    fn: async (ctx, name) => {
      const r = ctx.sp.db.prepare('SELECT name FROM viewer_page_templates WHERE is_active = 1').get();
      assert(r && r.name === name, `the live viewer page is "${r && r.name}", expected "${name}"`);
    } },
  { doc: 'it fails with "text"   (the last show player command)',
    re: new RegExp(`^it fails with ${q}$`, 'i'),
    fn: async (ctx, text) => {
      const r = ctx.last.result;
      assert(r && !r.ok, 'the command did not fail');
      assert(r.error.includes(text), `it failed with "${r.error}", expected "${text}"`);
    } },

  // ===== Checks: admin in a browser =====
  { doc: 'the admin sees "text"',
    re: new RegExp(`^the admin sees ${q}$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const t = await visibleText(pageOf(ctx, 'admin'));
      assert(t.includes(text), `the admin page doesn't show "${text}"`);
    }) },
  { doc: 'the admin does not see "text"',
    re: new RegExp(`^the admin does not see ${q}$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const t = await visibleText(pageOf(ctx, 'admin'));
      assert(!t.includes(text), `the admin page shows "${text}"`);
    }) },
  { doc: 'the server log says "text"   (Settings → Debug → Server log)',
    re: new RegExp(`^the server log says ${q}$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const r = await adminOk(ctx, 'GET', '/server-log?lines=3000&filter=' + encodeURIComponent(text));
      assert(r.lines.length > 0, `the server log has no line containing "${text}"`);
    }) },
  { doc: 'the downloaded server log has "text"',
    re: new RegExp(`^the downloaded server log has ${q}$`, 'i'),
    fn: async (ctx, yes) => {
      const r = await http(ctx, 'GET', '/api/admin/server-log/download', { cookie: ctx.sp.adminCookie });
      assert(r.status === 200, `download → HTTP ${r.status}`);
      assert(String(r.body).includes(yes), `the downloaded log doesn't contain "${yes}"`);
      assert(!String(r.body).includes(ctx.sp.showToken), 'the downloaded log contains the show token');
    } },
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
  { doc: 'the admin loads the file "name.html" into the template   (Load from file…, from tests/templates)',
    re: new RegExp(`^the admin loads the file ${q} into the template$`, 'i'),
    fn: async (ctx, file) => {
      const p = pageOf(ctx, 'admin');
      await p.setInputFiles('#tplUploadFile', path.join(__dirname, '..', 'templates', file));
      await p.waitForTimeout(500);
    } },
  { doc: 'the draft contains "text"',
    re: new RegExp(`^the draft contains ${q}$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const r = ctx.sp.db.prepare('SELECT draft_html FROM viewer_page_templates WHERE is_active = 1').get();
      assert(r.draft_html && r.draft_html.includes(text), "the draft doesn't contain " + JSON.stringify(text));
    }) },
  { doc: 'the admin\'s code editor shows "text"',
    re: new RegExp(`^the admin's code editor shows ${q}$`, 'i'),
    fn: async (ctx, text) => eventually(async () => {
      const t = await pageOf(ctx, 'admin').evaluate(() => { const v = document.querySelector('#monacoContainer .view-lines'); return v && v.offsetHeight > 50 ? v.innerText : ''; });
      assert(t.replace(/ /g, ' ').includes(text), `the code editor shows ${JSON.stringify(t.slice(0, 120))}`);
    }) },
  { doc: 'the admin switches the editor to Code',
    re: /^the admin switches the editor to code$/i,
    fn: async (ctx) => { const p = pageOf(ctx, 'admin'); await p.click('[data-designer-tab="code"]'); await p.waitForTimeout(800); } },
  { doc: 'the admin opens the "Announcements" tab   (a sub-tab, by its label)',
    re: new RegExp(`^the admin opens the ${q} tab$`, 'i'),
    fn: async (ctx, label) => {
      const p = pageOf(ctx, 'admin');
      const ok = await p.evaluate((label) => { const t = [...document.querySelectorAll('.sub-tab')].find(x => x.textContent.trim() === label); if (!t) return false; t.click(); return true; }, label);
      assert(ok, `no "${label}" tab`);
      await p.waitForTimeout(1500);
    } },
  { doc: 'the admin\'s cockpit has the tiles "cat:Kids" and "spacer1" (spacer1 2 rows tall)',
    re: new RegExp(`^the admin's cockpit has the tiles ${LIST}$`, 'i'),
    fn: async (ctx, list) => {
      const layout = names(list).map(id => /^spacer\d+$/.test(id) ? { id, size: 4, rows: 2 } : { id, size: 1 });
      await adminOk(ctx, 'PUT', '/me/cockpit-layout', { layout });
    } },
  { doc: 'the admin opens the Cockpit [in edit mode]',
    re: /^the admin opens the cockpit( in edit mode)?$/i,
    browser: true,
    fn: async (ctx, edit) => {
      let page = ctx.pages.get('admin');
      if (!page) { await openAdmin(ctx, 'dashboard'); page = ctx.pages.get('admin'); }
      await page.goto(ctx.sp.base + '/admin/cockpit.html' + (edit ? '?edit=1' : ''));
      await page.waitForTimeout(1500);
    } },
  { doc: 'the admin taps the "Kids" tile on the cockpit',
    re: new RegExp(`^the admin taps the ${q} tile on the cockpit$`, 'i'),
    fn: async (ctx, label) => {
      const p = pageOf(ctx, 'admin');
      const ok = await p.evaluate((label) => { const t = [...document.querySelectorAll('.tile')].find(x => (x.querySelector('.tile-label') || {}).textContent === label); const b = t && t.querySelector('[data-act]'); if (!b) return false; b.click(); return true; }, label);
      assert(ok, `no "${label}" tile with a control`);
      await p.waitForTimeout(1200);
    } },
  { doc: 'the "Kids" tile on the cockpit says "Off"',
    re: new RegExp(`^the ${q} tile on the cockpit says ${q}$`, 'i'),
    fn: async (ctx, label, want) => eventually(async () => {
      const t = await pageOf(ctx, 'admin').evaluate((label) => { const x = [...document.querySelectorAll('.tile')].find(e => (e.querySelector('.tile-label') || {}).textContent === label); return x ? x.querySelector('.tile-body').innerText.trim() : null; }, label);
      assert(t === want, `the "${label}" tile says ${JSON.stringify(t)}`);
    }) },
  { doc: 'the category "Kids" is off | on   (in the saved settings)',
    re: new RegExp(`^the category ${q} is (off|on)$`, 'i'),
    fn: async (ctx, name, onoff) => eventually(async () => {
      const cats = JSON.parse(ctx.sp.db.prepare('SELECT sequence_categories FROM config WHERE id = 1').get().sequence_categories || '[]');
      const c = cats.find(x => x.name === name);
      assert(c, `no category "${name}"`);
      const on = c.enabled !== false && Number(c.enabled) !== 0;
      assert(on === (onoff.toLowerCase() === 'on'), `the category "${name}" is ${on ? 'on' : 'off'}`);
    }) },
  { doc: 'the cockpit spacer is N rows tall and hidden | and visible',
    re: /^the cockpit spacer is (\d) rows? tall and (hidden|visible)$/i,
    fn: async (ctx, rows, vis) => {
      const r = await pageOf(ctx, 'admin').evaluate(() => {
        const sp = document.querySelector('.tile.spacer'), other = [...document.querySelectorAll('.tile')].find(t => !t.classList.contains('spacer'));
        return sp && { h: sp.getBoundingClientRect().height, row: other ? other.getBoundingClientRect().height : 0, vis: getComputedStyle(sp).visibility };
      });
      assert(r, 'no spacer on the cockpit');
      const est = Math.round((r.h + 12) / (r.row + 12));
      assert(est === Number(rows), `the spacer is about ${est} rows tall (${Math.round(r.h)}px; a tile is ${Math.round(r.row)}px)`);
      assert((r.vis === 'hidden') === (vis.toLowerCase() === 'hidden'), `the spacer is ${r.vis}`);
    } },
  { doc: 'the admin adds a Spacer on the cockpit   (edit mode, + Add)',
    re: /^the admin adds a spacer on the cockpit$/i,
    fn: async (ctx) => { const p = pageOf(ctx, 'admin'); await p.click('[data-add="spacer"]'); await p.waitForTimeout(800); } },
  { doc: 'the saved cockpit has N spacers',
    re: /^the saved cockpit has (\d+) spacers?$/i,
    fn: async (ctx, n) => eventually(async () => {
      const me = await adminOk(ctx, 'GET', '/me');
      const k = (me.cockpitLayout || []).filter(t => /^spacer\d+$/.test(t.id)).length;
      assert(k === Number(n), `the saved cockpit has ${k} spacers`);
    }) },
  { doc: 'the admin goes to the Dashboard and back to the Viewer Page   (without reloading)',
    re: /^the admin goes to the dashboard and back to the viewer page$/i,
    fn: async (ctx) => {
      const p = pageOf(ctx, 'admin');
      await p.evaluate(() => { switchMainTab('dashboard'); });
      await p.waitForTimeout(300);
      await p.evaluate(() => { switchMainTab('viewer'); });
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
