// ============================================================
// ShowPilot app — nearby-shows directory
// ============================================================
// Lives in the install counter app (same process, same database file) but
// is a separate, opt-in thing: only shows whose owner turned on "List my
// show in the ShowPilot app" ever check in here.
//
//   POST /api/shows/checkin   from a listed show, about once a minute
//   POST /api/shows/remove    from a show whose owner turned listing off
//   GET  /api/shows/nearby?lat=&lng=&radius_mi=   from the phone app
//
// What a listed show publishes: name, town, public URL, location (rounded
// to ~1 mile unless the owner chose otherwise — the rounding happens on
// the show, so the exact spot never reaches us), its listing radius, and
// live / phone-audio / now-playing. We keep a hash of the install ID, not
// the ID itself.
//
// Phone location: /nearby uses lat/lng only to answer the request. It is
// never stored or logged.
//
// Ownership check: before a show is listed (and again daily, or when its
// address changes) we fetch <apiBaseUrl>/api/public/show-info and require
// the listingId there to match the one derived from the install ID in the
// check-in. That proves the check-in came from the server at that address,
// so nobody can list someone else's site, and it proves phones can reach it.
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
const MAX_VERIFY_AT_ONCE = 5;

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

// GET a small JSON document from a show. Refuses private addresses (checked
// after DNS, and the checked address is the one connected to).
function fetchShowInfo(base) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL((VERIFY_REWRITE_TO || base).replace(/\/+$/, '') + '/api/public/show-info');
    } catch { return resolve({ error: 'bad address' }); }
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
    const req = mod.get(target, {
      lookup, timeout: 8000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'ShowPilot-Directory' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ error: 'answered ' + res.statusCode }); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > 16384) req.destroy(new Error('reply too large')); });
      res.on('end', () => { try { resolve({ json: JSON.parse(buf) }); } catch { resolve({ error: 'reply was not JSON' }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ error: e.message, network: true }));
  });
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

  const getRow = db.prepare('SELECT * FROM shows WHERE id_hash = ?');
  const upsert = db.prepare(`
    INSERT INTO shows (id_hash, public_id, product, version, name, town, viewer_url, api_base_url, lat, lng, radius_mi,
                       live, has_audio, now_playing, verified_base, verified_at, first_seen, last_seen)
    VALUES (@id_hash, @public_id, @product, @version, @name, @town, @viewer_url, @api_base_url, @lat, @lng, @radius_mi,
            @live, @has_audio, @now_playing, @verified_base, @verified_at, @now, @now)
    ON CONFLICT(id_hash) DO UPDATE SET product=@product, version=@version, name=@name, town=@town, viewer_url=@viewer_url,
      api_base_url=@api_base_url, lat=@lat, lng=@lng, radius_mi=@radius_mi, live=@live, has_audio=@has_audio,
      now_playing=@now_playing, verified_base=@verified_base, verified_at=@verified_at, last_seen=@now`);
  const del = db.prepare('DELETE FROM shows WHERE id_hash = ?');

  let verifying = 0;
  const busy = new Set();

  const router = express.Router();
  const json = express.json({ limit: '4kb' });

  router.post('/api/shows/checkin', json, async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').toLowerCase();
    if (!ID_RE.test(id) || !PRODUCTS.includes(b.product)) return res.status(400).json({ error: 'bad id or product' });
    const api = publicHttpsUrl(b.apiBaseUrl);
    const viewer = publicHttpsUrl(b.viewerUrl);
    if (!api) return res.status(400).json({ error: 'apiBaseUrl must be a public https:// address' });
    if (!viewer || viewer.hostname !== api.hostname) return res.status(400).json({ error: 'viewerUrl must be https:// on the same host as apiBaseUrl' });
    const lat = Number(b.lat), lng = Number(b.lng), radius = Number(b.radiusMi);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      return res.status(400).json({ error: 'bad location' });
    }
    if (!Number.isFinite(radius) || radius < 0.5 || radius > 100) return res.status(400).json({ error: 'radiusMi must be 0.5 to 100' });
    const name = text(b.name, 60);
    if (!name) return res.status(400).json({ error: 'name is required' });

    const h = idHash(id);
    const now = Math.floor(Date.now() / 1000);
    const prev = getRow.get(h);
    if (prev && now - prev.last_seen < MIN_CHECKIN_GAP_S) return res.status(429).json({ error: 'checking in too often' });
    if (busy.has(h)) return res.status(429).json({ error: 'check-in already in progress' });

    const apiBase = (api.origin + api.pathname).replace(/\/+$/, '');
    const pid = listingId(id);
    let verifiedBase = prev ? prev.verified_base : null;
    let verifiedAt = prev ? prev.verified_at : 0;
    const needVerify = verifiedBase !== apiBase || now - verifiedAt > REVERIFY_S;

    if (needVerify) {
      if (verifying >= MAX_VERIFY_AT_ONCE) return res.status(503).json({ error: 'busy, try again in a minute' });
      verifying++; busy.add(h);
      let r;
      try { r = await fetchShowInfo(apiBase); } finally { verifying--; busy.delete(h); }
      const ok = r.json && r.json.listed === true && r.json.listingId === pid;
      if (ok) {
        verifiedBase = apiBase; verifiedAt = now;
      } else {
        const sameBaseStillFresh = verifiedBase === apiBase && now - verifiedAt <= REVERIFY_GRACE_S && r.network;
        if (!sameBaseStillFresh) {
          if (prev) del.run(h);
          const why = r.json ? (r.json.listed === true ? 'a different show answers at that address' : 'the show at that address says it is not listed')
                             : ('could not read ' + apiBase + '/api/public/show-info (' + (r.error || 'no reply') + ')');
          return res.status(422).json({ error: why });
        }
      }
    }

    const live = b.live === true;
    upsert.run({
      id_hash: h, public_id: pid, product: b.product,
      version: VERSION_RE.test(String(b.version || '')) ? String(b.version) : null,
      name, town: text(b.town, 60) || null,
      viewer_url: viewer.href, api_base_url: apiBase,
      lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, radius_mi: radius,
      live: live ? 1 : 0, has_audio: b.hasAudio === true ? 1 : 0,
      now_playing: live ? (text(b.nowPlaying, 120) || null) : null,
      verified_base: verifiedBase, verified_at: verifiedAt, now,
    });
    res.json({ ok: true, listed: true, id: pid });
  });

  router.post('/api/shows/remove', json, (req, res) => {
    const id = String((req.body || {}).id || '').toLowerCase();
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const r = del.run(idHash(id));
    res.status(r.changes ? 200 : 404).json({ ok: true, removed: r.changes > 0 });
  });

  router.get('/api/shows/nearby', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    let radius = Number(req.query.radius_mi);
    if (!Number.isFinite(radius)) radius = 25;
    radius = Math.min(100, Math.max(1, radius));
    const now = Math.floor(Date.now() / 1000);
    const dLat = radius / 69;
    const dLng = radius / (69 * Math.max(Math.cos(lat * Math.PI / 180), 0.05));
    const rows = db.prepare(`SELECT * FROM shows WHERE verified_at > 0 AND last_seen >= ?
      AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`).all(now - LIST_STALE_S, lat - dLat, lat + dLat, lng - dLng, lng + dLng);
    const shows = [];
    for (const r of rows) {
      const d = distanceMiles(lat, lng, r.lat, r.lng);
      if (d > radius || d > r.radius_mi) continue;
      const live = r.live === 1 && now - r.last_seen <= LIVE_STALE_S;
      shows.push({
        id: r.public_id, name: r.name, viewerUrl: r.viewer_url, apiBaseUrl: r.api_base_url,
        lat: r.lat, lng: r.lng, distanceMi: Math.round(d * 10) / 10, town: r.town || '',
        live, hasAudio: r.has_audio === 1, nowPlaying: live ? (r.now_playing || '') : '',
      });
    }
    shows.sort((a, b) => (b.live - a.live) || (a.distanceMi - b.distanceMi));
    res.json({ shows: shows.slice(0, MAX_RESULTS) });
  });

  function cleanup() {
    db.prepare('DELETE FROM shows WHERE last_seen < ?').run(Math.floor(Date.now() / 1000) - FORGET_S);
  }

  function counts() {
    const now = Math.floor(Date.now() / 1000);
    return {
      listed: db.prepare('SELECT COUNT(*) AS n FROM shows WHERE verified_at > 0 AND last_seen >= ?').get(now - LIST_STALE_S).n,
      live: db.prepare('SELECT COUNT(*) AS n FROM shows WHERE verified_at > 0 AND live = 1 AND last_seen >= ?').get(now - LIVE_STALE_S).n,
    };
  }

  return { router, cleanup, counts };
}

module.exports = { createDirectory, listingId, isPrivateAddress, publicHttpsUrl };
