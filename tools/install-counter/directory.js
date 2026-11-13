// ============================================================
// ShowPilot app — nearby-shows directory
// ============================================================
// Lives in the install counter app (same process, same database file) but
// is a separate, opt-in thing: only shows whose owner turned on "List my
// show in the ShowPilot app" ever check in here.
//
//   POST /api/shows/checkin   from a listed show, about once a minute
//   POST /api/shows/remove    from a show whose owner turned listing off
//   GET  /api/shows/nearby?lat=&lng=&radius_mi=   from the phone app ("here now")
//   GET  /api/shows/directory?lat=&lng=&radius_mi= from the phone app's
//        Directory of Shows (map + list, the user picks the distance)
//
// What a listed show publishes: name, town, optional address, public URL,
// location (rounded to ~1 mile unless the owner entered an address — the
// rounding happens on the show, so the exact spot never reaches us), whether
// it's rounded, and live / phone-audio / now-playing. We keep a hash of the
// install ID, not the ID itself.
//
// Listing distance (master.17): the same for every show and not a setting.
// A phone sees a show within LISTING_RADIUS_MI of it; for a rounded
// location we add FUZZ_SLACK_MI (the farthest the rounded point can be from
// the real one), so a phone standing at the show always sees it. Check-ins
// from older installs still send their own radiusMi; it's ignored.
//
// Phone location: /nearby uses lat/lng only to answer the request. It is
// never stored or logged.
//
// Ownership check: before a show is listed (and again daily, or when its
// address changes) we fetch <apiBaseUrl>/api/public/show-info and require
// the listingId there to match the one derived from the install ID in the
// check-in. That proves the check-in came from the server at that address,
// so nobody can list someone else's site, and it proves phones can reach it.
//
// Admin (adminRouter, mounted by server.js behind sign-in): every show
// with its check-in and verification state, rejected check-ins and why,
// a live diagnosis of one show, and remove / block / unblock. A blocked
// show's check-ins are refused with a message its owner sees in ShowPilot.
// ============================================================
'use strict';
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const express = require('express');

const PRODUCTS = ['showpilot', 'showpilot-lite'];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,5}(-[0-9A-Za-z.]{1,20})?$/;
const LIVE_STALE_S = 150;              // no check-in for 2.5 min → not live
const LIST_STALE_S = 24 * 3600;        // no check-in for a day → not listed
const FORGET_S = 30 * 24 * 3600;       // gone for a month → deleted
const MIN_CHECKIN_GAP_S = 20;
const REVERIFY_S = 24 * 3600;
const REVERIFY_GRACE_S = 48 * 3600;    // keep a verified show listed through short outages
const MAX_RESULTS = 50;
// Directory of Shows: the user picks the distance in the app.
const DIRECTORY_DEFAULT_MI = 25;
const DIRECTORY_MAX_MI = 100;
const DIRECTORY_MAX_RESULTS = 200;
const MAX_VERIFY_AT_ONCE = 5;
const LISTING_RADIUS_MI = 1;
// The show rounds to the centre of a 0.015 degree grid cell (~1.04 mi
// north-south, similar east-west), so the published point is at most about
// 0.73 mi from the real spot.
const FUZZ_SLACK_MI = 0.75;

// Testing only: send the ownership check to a local server instead of the
// show's real address (e.g. VERIFY_REWRITE_TO=http://127.0.0.1:3100).
const VERIFY_REWRITE_TO = process.env.VERIFY_REWRITE_TO || '';

function idHash(id) { return crypto.createHash('sha256').update('showpilot-install:' + id).digest('hex'); }
function listingId(id) { return crypto.createHash('sha256').update('showpilot-listing:' + id).digest('hex').slice(0, 20); }

function text(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A public https URL with a real hostname, or null.
function publicHttpsUrl(v) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || String(v).length > 300) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || net.isIP(h) || h === 'localhost' || /\.(local|lan|internal|home|localhost)$/.test(h)) return null;
  return u;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9')
    || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

// GET something small from a show. Refuses private addresses (checked after
// DNS, and the checked address is the one connected to). Resolves
// { status, ms, json | error, network } and never rejects. With asJson
// false only the status is wanted (the body is read up to a limit and
// dropped).
function fetchFromShow(urlStr, { asJson = true, maxBytes = 16384 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let target;
    try {
      const u = new URL(urlStr);
      target = VERIFY_REWRITE_TO ? new URL(u.pathname + u.search, VERIFY_REWRITE_TO) : u;
    } catch { return resolve({ error: 'bad address', ms: 0 }); }
    const mod = target.protocol === 'http:' ? http : https;
    const lookup = (hostname, opts, cb) => {
      dns.lookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err);
        const ok = addrs.filter(a => VERIFY_REWRITE_TO || !isPrivateAddress(a.address));
        if (!ok.length) return cb(new Error('address is not public'));
        if (opts && opts.all) return cb(null, [ok[0]]);
        cb(null, ok[0].address, ok[0].family);
      });
    };
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ms: Date.now() - t0, ...r }); } };
    const req = mod.get(target, {
      lookup, timeout: 8000,
      headers: { 'Accept': asJson ? 'application/json' : 'text/html,*/*', 'User-Agent': 'ShowPilot-Directory' },
    }, (res) => {
      const status = res.statusCode;
      if (!asJson) {
        // Status is enough; read a little so the server isn't cut off mid-header.
        let n = 0;
        res.on('data', (d) => { n += d.length; if (n > maxBytes) { finish({ status, location: res.headers.location || null }); req.destroy(); } });
        res.on('end', () => finish({ status, location: res.headers.location || null }));
        res.on('error', () => finish({ status }));
        return;
      }
      if (status !== 200) { res.resume(); return finish({ status, error: 'answered ' + status }); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > maxBytes) req.destroy(new Error('reply too large')); });
      res.on('end', () => { try { finish({ status, json: JSON.parse(buf) }); } catch { finish({ status, error: 'reply was not JSON' }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => finish({ error: e.message, network: true }));
  });
}

function fetchShowInfo(base) {
  return fetchFromShow(String(base).replace(/\/+$/, '') + '/api/public/show-info');
}

function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function createDirectory(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS shows (
    id_hash       TEXT PRIMARY KEY,
    public_id     TEXT NOT NULL,
    product       TEXT NOT NULL,
    version       TEXT,
    name          TEXT NOT NULL,
    town          TEXT,
    viewer_url    TEXT NOT NULL,
    api_base_url  TEXT NOT NULL,
    lat           REAL NOT NULL,   -- as published by the show (rounded unless the owner chose exact)
    lng           REAL NOT NULL,
    radius_mi     REAL NOT NULL,
    live          INTEGER NOT NULL DEFAULT 0,
    has_audio     INTEGER NOT NULL DEFAULT 0,
    now_playing   TEXT,
    verified_base TEXT,
    verified_at   INTEGER NOT NULL DEFAULT 0,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shows_lat ON shows(lat);
  CREATE INDEX IF NOT EXISTS idx_shows_last_seen ON shows(last_seen);
  `);
  // master.17: whether the published location is rounded (older rows: assume yes).
  const cols = db.prepare('PRAGMA table_info(shows)').all().map(c => c.name);
  if (!cols.includes('fuzzed')) db.exec('ALTER TABLE shows ADD COLUMN fuzzed INTEGER NOT NULL DEFAULT 1');
  // Optional show address (shown in the app with a Navigate button).
  if (!cols.includes('address')) db.exec('ALTER TABLE shows ADD COLUMN address TEXT');
  // Admin: the last failed re-verification that the grace period let through.
  if (!cols.includes('verify_error')) db.exec('ALTER TABLE shows ADD COLUMN verify_error TEXT');
  if (!cols.includes('verify_error_at')) db.exec('ALTER TABLE shows ADD COLUMN verify_error_at INTEGER');
  db.exec(`
  -- Shows the admin keeps out of the directory. Their check-ins are refused.
  CREATE TABLE IF NOT EXISTS shows_blocked (
    id_hash         TEXT PRIMARY KEY,
    public_id       TEXT,
    name            TEXT,
    api_base_url    TEXT,
    reason          TEXT,
    blocked_at      INTEGER NOT NULL,
    last_attempt_at INTEGER
  );
  -- The latest refused check-in per install, so "my show isn't in the app"
  -- can be answered. Cleared when that install's check-in succeeds.
  CREATE TABLE IF NOT EXISTS shows_rejects (
    id_hash       TEXT PRIMARY KEY,
    public_id     TEXT,
    product       TEXT,
    version       TEXT,
    name          TEXT,
    town          TEXT,
    api_base_url  TEXT,
    status        INTEGER,
    reason        TEXT NOT NULL,
    first_at      INTEGER NOT NULL,
    last_at       INTEGER NOT NULL,
    count         INTEGER NOT NULL DEFAULT 1
  );
  `);

  const getRow = db.prepare('SELECT * FROM shows WHERE id_hash = ?');
  const upsert = db.prepare(`
    INSERT INTO shows (id_hash, public_id, product, version, name, town, address, viewer_url, api_base_url, lat, lng, radius_mi,
                       fuzzed, live, has_audio, now_playing, verified_base, verified_at, verify_error, verify_error_at, first_seen, last_seen)
    VALUES (@id_hash, @public_id, @product, @version, @name, @town, @address, @viewer_url, @api_base_url, @lat, @lng, @radius_mi,
            @fuzzed, @live, @has_audio, @now_playing, @verified_base, @verified_at, @verify_error, @verify_error_at, @now, @now)
    ON CONFLICT(id_hash) DO UPDATE SET product=@product, version=@version, name=@name, town=@town, address=@address, viewer_url=@viewer_url,
      api_base_url=@api_base_url, lat=@lat, lng=@lng, radius_mi=@radius_mi, fuzzed=@fuzzed, live=@live, has_audio=@has_audio,
      now_playing=@now_playing, verified_base=@verified_base, verified_at=@verified_at,
      verify_error=@verify_error, verify_error_at=@verify_error_at, last_seen=@now`);
  const del = db.prepare('DELETE FROM shows WHERE id_hash = ?');
  const getBlocked = db.prepare('SELECT * FROM shows_blocked WHERE id_hash = ?');
  const touchBlocked = db.prepare('UPDATE shows_blocked SET last_attempt_at = ? WHERE id_hash = ?');
  const getReject = db.prepare('SELECT * FROM shows_rejects WHERE id_hash = ?');
  const delReject = db.prepare('DELETE FROM shows_rejects WHERE id_hash = ?');
  const putReject = db.prepare(`
    INSERT INTO shows_rejects (id_hash, public_id, product, version, name, town, api_base_url, status, reason, first_at, last_at, count)
    VALUES (@id_hash, @public_id, @product, @version, @name, @town, @api_base_url, @status, @reason, @now, @now, 1)
    ON CONFLICT(id_hash) DO UPDATE SET public_id=@public_id, product=@product, version=@version, name=@name, town=@town,
      api_base_url=@api_base_url, status=@status, reason=@reason, last_at=@now,
      count = CASE WHEN shows_rejects.reason = @reason THEN shows_rejects.count + 1 ELSE 1 END,
      first_at = CASE WHEN shows_rejects.reason = @reason THEN shows_rejects.first_at ELSE @now END`);

  const BLOCKED_MESSAGE = 'this show was removed from the ShowPilot app directory. If you think that is a mistake, contact ShowPilot support.';

  let verifying = 0;
  const busy = new Set();

  const router = express.Router();
  const json = express.json({ limit: '4kb' });

  router.post('/api/shows/checkin', json, async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').toLowerCase();
    if (!ID_RE.test(id) || !PRODUCTS.includes(b.product)) return res.status(400).json({ error: 'bad id or product' });
    const h = idHash(id);
    const now = Math.floor(Date.now() / 1000);
    const blocked = getBlocked.get(h);
    if (blocked) {
      touchBlocked.run(now, h);
      return res.status(403).json({ error: BLOCKED_MESSAGE, blocked: true });
    }
    // Every refusal from here on is kept (latest per install) for the admin page.
    const reject = (status, error) => {
      try {
        putReject.run({
          id_hash: h, public_id: listingId(id), product: b.product,
          version: VERSION_RE.test(String(b.version || '')) ? String(b.version) : null,
          name: text(b.name, 60) || null, town: text(b.town, 60) || null,
          api_base_url: text(b.apiBaseUrl, 300) || null, status, reason: text(error, 300), now,
        });
      } catch { /* the log is best-effort */ }
      return res.status(status).json({ error });
    };
    const api = publicHttpsUrl(b.apiBaseUrl);
    const viewer = publicHttpsUrl(b.viewerUrl);
    if (!api) return reject(400, 'apiBaseUrl must be a public https:// address');
    if (!viewer || viewer.hostname !== api.hostname) return reject(400, 'viewerUrl must be https:// on the same host as apiBaseUrl');
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      return reject(400, 'bad location');
    }
    const name = text(b.name, 60);
    if (!name) return reject(400, 'name is required');
    const town = text(b.town, 60) || null;
    const address = text(b.address, 160) || null;
    const rLat = Math.round(lat * 1e5) / 1e5, rLng = Math.round(lng * 1e5) / 1e5;
    const fuzzed = b.fuzzed === false ? 0 : 1;   // older installs don't say: assume rounded (the default)

    const prev = getRow.get(h);
    // The rate limit is for the heartbeat. A check-in that changes what's
    // listed (the owner just edited a detail) goes through at once.
    const changed = !prev || prev.name !== name || (prev.town || null) !== town || (prev.address || null) !== address
      || prev.lat !== rLat || prev.lng !== rLng || prev.fuzzed !== fuzzed || prev.viewer_url !== viewer.href
      || prev.has_audio !== (b.hasAudio === true ? 1 : 0);
    if (prev && !changed && now - prev.last_seen < MIN_CHECKIN_GAP_S) return res.status(429).json({ error: 'checking in too often' });
    if (busy.has(h)) return res.status(429).json({ error: 'check-in already in progress' });

    const apiBase = (api.origin + api.pathname).replace(/\/+$/, '');
    const pid = listingId(id);
    let verifiedBase = prev ? prev.verified_base : null;
    let verifiedAt = prev ? prev.verified_at : 0;
    let verifyError = prev ? prev.verify_error : null;
    let verifyErrorAt = prev ? prev.verify_error_at : null;
    const needVerify = verifiedBase !== apiBase || now - verifiedAt > REVERIFY_S;

    if (needVerify) {
      if (verifying >= MAX_VERIFY_AT_ONCE) return res.status(503).json({ error: 'busy, try again in a minute' });
      verifying++; busy.add(h);
      let r;
      try { r = await fetchShowInfo(apiBase); } finally { verifying--; busy.delete(h); }
      const ok = r.json && r.json.listed === true && r.json.listingId === pid;
      if (ok) {
        verifiedBase = apiBase; verifiedAt = now;
        verifyError = null; verifyErrorAt = null;
      } else {
        const sameBaseStillFresh = verifiedBase === apiBase && now - verifiedAt <= REVERIFY_GRACE_S && r.network;
        if (!sameBaseStillFresh) {
          if (prev) del.run(h);
          // "Address" here is the web address; name it so nobody reads it as a street address.
          const why = r.json ? (r.json.listed === true
                                  ? 'a different ShowPilot answers at ' + apiBase + '. Check the Public web address in Settings → General'
                                  : 'the ShowPilot at ' + apiBase + ' says it is not listed. Check the Public web address in Settings → General')
                             : ('could not read ' + apiBase + '/api/public/show-info (' + (r.error || 'no reply') + ')');
          return reject(422, why);
        }
        // Still listed on its earlier check, but the admin should see this.
        verifyError = 'could not read /api/public/show-info (' + (r.error || 'no reply') + ')';
        verifyErrorAt = now;
      }
    }

    const live = b.live === true;
    upsert.run({
      id_hash: h, public_id: pid, product: b.product,
      version: VERSION_RE.test(String(b.version || '')) ? String(b.version) : null,
      name, town, address,
      viewer_url: viewer.href, api_base_url: apiBase,
      lat: rLat, lng: rLng, radius_mi: LISTING_RADIUS_MI,
      fuzzed,
      live: live ? 1 : 0, has_audio: b.hasAudio === true ? 1 : 0,
      now_playing: live ? (text(b.nowPlaying, 120) || null) : null,
      verified_base: verifiedBase, verified_at: verifiedAt,
      verify_error: verifyError, verify_error_at: verifyErrorAt, now,
    });
    if (getReject.get(h)) delReject.run(h);
    res.json({ ok: true, listed: true, id: pid });
  });

  router.post('/api/shows/remove', json, (req, res) => {
    const id = String((req.body || {}).id || '').toLowerCase();
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const r = del.run(idHash(id));
    delReject.run(idHash(id));
    res.status(r.changes ? 200 : 404).json({ ok: true, removed: r.changes > 0 });
  });

  router.get('/api/shows/nearby', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    // radius_mi from the app can only narrow the search; a show is never
    // listed farther than its fixed listing distance.
    const maxListing = LISTING_RADIUS_MI + FUZZ_SLACK_MI;
    let radius = Number(req.query.radius_mi);
    if (!Number.isFinite(radius)) radius = maxListing;
    radius = Math.min(maxListing, Math.max(0.5, radius));
    const now = Math.floor(Date.now() / 1000);
    const dLat = radius / 69;
    const dLng = radius / (69 * Math.max(Math.cos(lat * Math.PI / 180), 0.05));
    const rows = db.prepare(`SELECT * FROM shows WHERE verified_at > 0 AND last_seen >= ? AND id_hash NOT IN (SELECT id_hash FROM shows_blocked)
      AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`).all(now - LIST_STALE_S, lat - dLat, lat + dLat, lng - dLng, lng + dLng);
    const shows = [];
    for (const r of rows) {
      const d = distanceMiles(lat, lng, r.lat, r.lng);
      const reach = LISTING_RADIUS_MI + (r.fuzzed === 0 ? 0 : FUZZ_SLACK_MI);
      if (d > radius || d > reach) continue;
      const live = r.live === 1 && now - r.last_seen <= LIVE_STALE_S;
      shows.push({
        id: r.public_id, name: r.name, viewerUrl: r.viewer_url, apiBaseUrl: r.api_base_url,
        lat: r.lat, lng: r.lng, distanceMi: Math.round(d * 10) / 10, town: r.town || '', address: r.address || '',
        fuzzed: r.fuzzed !== 0,
        live, hasAudio: r.has_audio === 1, nowPlaying: live ? (r.now_playing || '') : '',
      });
    }
    shows.sort((a, b) => (b.live - a.live) || (a.distanceMi - b.distanceMi));
    res.json({ shows: shows.slice(0, MAX_RESULTS) });
  });

  // Directory of Shows: every listed show within the distance the user
  // picked (1–100 miles; the app converts km). Nearest first. A show
  // without an address has a rounded pin (fuzzed: true) and no address, so
  // the app shows its area, not its spot, and no Navigate button.
  router.get('/api/shows/directory', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    let radius = Number(req.query.radius_mi);
    if (!Number.isFinite(radius)) radius = DIRECTORY_DEFAULT_MI;
    radius = Math.min(DIRECTORY_MAX_MI, Math.max(1, radius));
    const now = Math.floor(Date.now() / 1000);
    const dLat = radius / 69;
    const dLng = radius / (69 * Math.max(Math.cos(lat * Math.PI / 180), 0.05));
    const rows = db.prepare(`SELECT * FROM shows WHERE verified_at > 0 AND last_seen >= ? AND id_hash NOT IN (SELECT id_hash FROM shows_blocked)
      AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`).all(now - LIST_STALE_S, lat - dLat, lat + dLat, lng - dLng, lng + dLng);
    const shows = [];
    for (const r of rows) {
      const d = distanceMiles(lat, lng, r.lat, r.lng);
      if (d > radius) continue;
      const live = r.live === 1 && now - r.last_seen <= LIVE_STALE_S;
      shows.push({
        id: r.public_id, name: r.name, viewerUrl: r.viewer_url, apiBaseUrl: r.api_base_url,
        lat: r.lat, lng: r.lng, fuzzed: r.fuzzed !== 0, distanceMi: Math.round(d * 10) / 10,
        town: r.town || '', address: r.address || '',
        live, hasAudio: r.has_audio === 1, nowPlaying: live ? (r.now_playing || '') : '',
      });
    }
    shows.sort((a, b) => a.distanceMi - b.distanceMi);
    res.json({ radiusMi: radius, shows: shows.slice(0, DIRECTORY_MAX_RESULTS) });
  });

  function cleanup() {
    const cutoff = Math.floor(Date.now() / 1000) - FORGET_S;
    db.prepare('DELETE FROM shows WHERE last_seen < ?').run(cutoff);
    db.prepare('DELETE FROM shows_rejects WHERE last_at < ?').run(cutoff);
  }

  // ------------------------------------------------------------
  // Admin
  // ------------------------------------------------------------
  function showStatus(r, now) {
    const age = now - r.last_seen;
    if (age > LIST_STALE_S) return 'dropped';            // out of the app, deleted after FORGET_S
    if (age > LIVE_STALE_S) return 'silent';             // still listed, shown as not live
    return r.live === 1 ? 'live' : 'online';
  }

  function adminShow(r, now) {
    return {
      idHash: r.id_hash, publicId: r.public_id, product: r.product, version: r.version,
      name: r.name, town: r.town || '', address: r.address || '',
      viewerUrl: r.viewer_url, apiBaseUrl: r.api_base_url,
      lat: r.lat, lng: r.lng, fuzzed: r.fuzzed !== 0,
      live: r.live === 1, hasAudio: r.has_audio === 1, nowPlaying: r.now_playing || '',
      verifiedAt: r.verified_at, verifiedBase: r.verified_base,
      verifyError: r.verify_error || null, verifyErrorAt: r.verify_error_at || null,
      firstSeen: r.first_seen, lastSeen: r.last_seen, status: showStatus(r, now),
      reachMi: LISTING_RADIUS_MI + (r.fuzzed === 0 ? 0 : FUZZ_SLACK_MI),
    };
  }

  function overview() {
    const now = Math.floor(Date.now() / 1000);
    const shows = db.prepare('SELECT * FROM shows WHERE id_hash NOT IN (SELECT id_hash FROM shows_blocked) ORDER BY last_seen DESC').all().map(r => adminShow(r, now));
    const rejects = db.prepare('SELECT * FROM shows_rejects ORDER BY last_at DESC').all().map(r => ({
      idHash: r.id_hash, publicId: r.public_id, product: r.product, version: r.version,
      name: r.name || '', town: r.town || '', apiBaseUrl: r.api_base_url || '',
      status: r.status, reason: r.reason, firstAt: r.first_at, lastAt: r.last_at, count: r.count,
      listed: shows.some(s => s.idHash === r.id_hash),
    }));
    const blocked = db.prepare('SELECT * FROM shows_blocked ORDER BY blocked_at DESC').all().map(r => ({
      idHash: r.id_hash, publicId: r.public_id, name: r.name || '', apiBaseUrl: r.api_base_url || '',
      reason: r.reason || '', blockedAt: r.blocked_at, lastAttemptAt: r.last_attempt_at || null,
      kept: !!getRow.get(r.id_hash),
    }));
    return {
      now,
      limits: { liveStaleS: LIVE_STALE_S, listStaleS: LIST_STALE_S, forgetS: FORGET_S, reverifyS: REVERIFY_S,
                reverifyGraceS: REVERIFY_GRACE_S, listingRadiusMi: LISTING_RADIUS_MI, fuzzSlackMi: FUZZ_SLACK_MI },
      shows, rejects, blocked,
    };
  }

  const ago = (s) => s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago'
    : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';

  // Runs the same checks a check-in and a phone depend on, against the show
  // as it is right now. Re-verifies the listing when ownership checks out.
  async function diagnose(h) {
    const now = Math.floor(Date.now() / 1000);
    const row = getRow.get(h), rej = getReject.get(h), blk = getBlocked.get(h);
    const base = (row && row.api_base_url) || (rej && rej.api_base_url) || (blk && blk.api_base_url) || '';
    const pid = (row && row.public_id) || (rej && rej.public_id) || (blk && blk.public_id) || null;
    const checks = [];
    const add = (level, label, detail) => checks.push({ level, label, detail });

    if (blk) add('bad', 'Blocked', 'Blocked ' + ago(now - blk.blocked_at) + (blk.reason ? ' (' + blk.reason + ')' : '') + '. Its check-ins are refused'
      + (blk.last_attempt_at ? '; the last one came ' + ago(now - blk.last_attempt_at) + '.' : ' and none have come since.'));
    if (row) {
      const age = now - row.last_seen;
      if (age <= LIVE_STALE_S) add('ok', 'Checking in', 'Last check-in ' + ago(age) + (row.version ? ' from ' + row.product + ' ' + row.version : '') + '.');
      else if (age <= LIST_STALE_S) add('warn', 'Not checking in', 'Last check-in ' + ago(age) + '. Still in the app, but shown as not live. ShowPilot may be stopped, or it can\'t reach the directory.');
      else add('bad', 'Dropped from the app', 'Last check-in ' + ago(age) + '. Shows that are quiet for a day drop out; this one is deleted after 30 days.');
      if (row.verify_error) add('warn', 'Last ownership check failed', ago(now - row.verify_error_at) + ': ' + row.verify_error + '. Kept listed for up to 2 days while its earlier check is fresh.');
      else add('ok', 'Ownership verified', ago(now - row.verified_at) + ' (re-checked daily).');
    } else if (rej) {
      add('bad', 'Not in the directory', 'Its last check-in (' + ago(now - rej.last_at) + ', ' + rej.count + '× in a row) was refused: ' + rej.reason);
    } else if (!blk) {
      add('info', 'Not in the directory', 'No check-in on record.');
    }

    if (!base) { add('info', 'Web address', 'No web address on record, so there is nothing to test.'); return { at: now, checks }; }
    const api = publicHttpsUrl(base);
    if (!api) { add('bad', 'Web address', base + ' is not a public https:// address, so phones and the directory can\'t use it.'); return { at: now, checks }; }
    if (verifying >= MAX_VERIFY_AT_ONCE) { add('warn', 'Live checks', 'Directory is busy verifying other shows; try again in a moment.'); return { at: now, checks }; }

    const apiBase = base.replace(/\/+$/, '');
    const wantAudio = row ? row.has_audio === 1 : (rej ? rej.product === 'showpilot' : false);
    verifying++;
    let info, page, audio;
    try {
      [info, page, audio] = await Promise.all([
        fetchShowInfo(apiBase),
        row ? fetchFromShow(row.viewer_url, { asJson: false, maxBytes: 65536 }) : Promise.resolve(null),
        wantAudio ? fetchFromShow(apiBase + '/api/now-playing-audio' + (row ? '?lat=' + row.lat + '&lng=' + row.lng : ''), { maxBytes: 262144 }) : Promise.resolve(null),
      ]);
    } finally { verifying--; }

    if (!info.json) {
      add('bad', 'Show info', 'Couldn\'t read ' + apiBase + '/api/public/show-info: ' + (info.error || 'no reply') + ' (' + info.ms + ' ms). The directory can\'t verify it and phones can\'t reach it.');
    } else {
      const j = info.json;
      const slow = info.ms > 2500 ? ' Slow to answer (' + info.ms + ' ms).' : ' Answered in ' + info.ms + ' ms.';
      if (j.listed !== true) add('bad', 'Show info', 'The show says it is not listed (its owner turned "List my show" off, or it\'s missing a location or name).' + slow);
      else if (pid && j.listingId !== pid) add('bad', 'Show info', 'A different ShowPilot answers at this address (listing ID doesn\'t match). Usually a wrong Public web address in Settings → General.' + slow);
      else {
        add(info.ms > 2500 ? 'warn' : 'ok', 'Show info', 'Listed as "' + text(j.name, 60) + '"' + (j.town ? ', ' + text(j.town, 60) : '')
          + (j.live ? ', live' : ', not live') + (j.hasAudio ? ', phone audio on' : '') + '.' + slow);
        if (row) db.prepare('UPDATE shows SET verified_base = ?, verified_at = ?, verify_error = NULL, verify_error_at = NULL WHERE id_hash = ?').run(apiBase, now, h);
      }
    }
    if (page) {
      if (page.status === 200) add(page.ms > 4000 ? 'warn' : 'ok', 'Viewer page', 'Loads (' + page.ms + ' ms).');
      else if (page.status >= 300 && page.status < 400) add('warn', 'Viewer page', 'Redirects (' + page.status + ') to ' + (page.location || '?') + '. The app follows it, but the listed address should be the final one.');
      else add('bad', 'Viewer page', page.status ? 'Answered ' + page.status + '.' : 'Couldn\'t load: ' + (page.error || 'no reply') + '.');
    }
    if (audio) {
      if (!audio.json) add('bad', 'Phone audio', 'Couldn\'t read /api/now-playing-audio: ' + (audio.error || 'no reply') + '. The app can show the page but not play audio.');
      else {
        const a = audio.json;
        if (a.audioDisabled) add('warn', 'Phone audio', 'Audio is turned off on this show, but it is listed as having phone audio.');
        else if (a.audioGateBlocked) add('info', 'Phone audio', 'Reachable. At the listed pin the show says: ' + text(a.audioGateReason, 160));
        else add('ok', 'Phone audio', 'Reachable (' + audio.ms + ' ms)' + (a.playing ? ', playing ' + (text(a.displayName || a.sequenceName || '', 80) || 'a song') : ', nothing playing right now') + '.');
      }
    }
    if (row) {
      add('info', 'Where phones see it', 'Home screen: within ' + (LISTING_RADIUS_MI + (row.fuzzed === 0 ? 0 : FUZZ_SLACK_MI))
        + ' mi of its pin (' + row.lat + ', ' + row.lng + (row.fuzzed === 0 ? ', exact from its address' : ', rounded to about a mile') + '). Directory map: within the distance the user picks.');
    }
    return { at: now, checks };
  }

  function nameFor(h) {
    const row = getRow.get(h), rej = getReject.get(h), blk = getBlocked.get(h);
    const src = row || rej || blk || null;
    return src ? { public_id: src.public_id || null, name: src.name || null, api_base_url: src.api_base_url || null } : null;
  }

  const adminRouter = express.Router();
  const H_RE = /^[0-9a-f]{64}$/;
  const hashFrom = (req) => { const v = String((req.body || {}).idHash || '').toLowerCase(); return H_RE.test(v) ? v : null; };

  adminRouter.get('/directory', (req, res) => { res.set('Cache-Control', 'no-store').json(overview()); });

  adminRouter.post('/directory/check', json, async (req, res) => {
    const h = hashFrom(req);
    if (!h) return res.status(400).json({ error: 'bad idHash' });
    if (!nameFor(h)) return res.status(404).json({ error: 'not found' });
    try { res.json(await diagnose(h)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Takes it out now. If its owner still has listing on, it comes back on
  // the next check-in (about a minute) — use block to keep it out.
  adminRouter.post('/directory/remove', json, (req, res) => {
    const h = hashFrom(req);
    if (!h) return res.status(400).json({ error: 'bad idHash' });
    const r = del.run(h);
    delReject.run(h);
    res.json({ ok: true, removed: r.changes > 0 });
  });

  adminRouter.post('/directory/block', json, (req, res) => {
    const h = hashFrom(req);
    if (!h) return res.status(400).json({ error: 'bad idHash' });
    const src = nameFor(h);
    if (!src) return res.status(404).json({ error: 'not found' });
    const reason = text((req.body || {}).reason, 200) || null;
    db.transaction(() => {
      db.prepare(`INSERT INTO shows_blocked (id_hash, public_id, name, api_base_url, reason, blocked_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id_hash) DO UPDATE SET reason = excluded.reason`).run(h, src.public_id, src.name, src.api_base_url, reason, Math.floor(Date.now() / 1000));
      // The listing row stays (hidden from the app while blocked), so
      // unblocking brings the show straight back.
      delReject.run(h);
    })();
    res.json({ ok: true });
  });

  adminRouter.post('/directory/unblock', json, (req, res) => {
    const h = hashFrom(req);
    if (!h) return res.status(400).json({ error: 'bad idHash' });
    const r = db.prepare('DELETE FROM shows_blocked WHERE id_hash = ?').run(h);
    res.json({ ok: true, unblocked: r.changes > 0, restored: !!getRow.get(h) });
  });

  adminRouter.post('/directory/dismiss', json, (req, res) => {
    const h = hashFrom(req);
    if (!h) return res.status(400).json({ error: 'bad idHash' });
    delReject.run(h);
    res.json({ ok: true });
  });

  function counts() {
    const now = Math.floor(Date.now() / 1000);
    return {
      listed: db.prepare('SELECT COUNT(*) AS n FROM shows WHERE verified_at > 0 AND last_seen >= ? AND id_hash NOT IN (SELECT id_hash FROM shows_blocked)').get(now - LIST_STALE_S).n,
      live: db.prepare('SELECT COUNT(*) AS n FROM shows WHERE verified_at > 0 AND live = 1 AND last_seen >= ? AND id_hash NOT IN (SELECT id_hash FROM shows_blocked)').get(now - LIVE_STALE_S).n,
    };
  }

  return { router, adminRouter, cleanup, counts };
}

module.exports = { createDirectory, listingId, isPrivateAddress, publicHttpsUrl };
