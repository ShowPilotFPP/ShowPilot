// ============================================================
// ShowPilot install counter
// ============================================================
// Small Node app that receives a once-a-day "I'm running" check-in from
// each ShowPilot / ShowPilot-Lite install and shows how many are running.
// Meant to sit behind a Cloudflare Tunnel (see README.md).
//
// What a check-in contains:  a random install ID, the product name, the
//                            version, and the owner's map choice:
//                            off | country | region | city.
// What we store:             a SHA-256 hash of the ID, product, version,
//                            last-seen date, and — ONLY at the level the
//                            owner opted into — country, state and town,
//                            read from Cloudflare's visitor-location
//                            headers. The install never sends a location.
// What we never store:       IP addresses, show names, URLs, anything else.
// What we send back:         nothing (204 No Content).
// ============================================================
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3040);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATS_KEY = process.env.STATS_KEY || ''; // set to make the stats page private (?key=...)

const PRODUCTS = ['showpilot', 'showpilot-lite'];
const LEVELS = new Set(['off', 'country', 'region', 'city']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,5}(-[0-9A-Za-z.]{1,20})?$/;
const DAY = 86400;
const ACTIVE_DAYS = 30;
const FORGET_AFTER_DAYS = 400; // seasonal shows come back each year; forget after ~13 months

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'installs.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS installs (
  id_hash    TEXT PRIMARY KEY,
  product    TEXT NOT NULL,
  version    TEXT,
  country    TEXT,      -- level: country, region, city
  region     TEXT,      -- level: region, city
  city       TEXT,      -- level: city
  lat        REAL,      -- level: city, rounded to ~10 km
  lon        REAL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs(last_seen);
CREATE TABLE IF NOT EXISTS daily (
  day     TEXT NOT NULL,
  product TEXT NOT NULL,
  active  INTEGER NOT NULL,
  PRIMARY KEY (day, product)
);
`);

const upsert = db.prepare(`
  INSERT INTO installs (id_hash, product, version, country, region, city, lat, lon, first_seen, last_seen)
  VALUES (@id_hash, @product, @version, @country, @region, @city, @lat, @lon, @now, @now)
  ON CONFLICT(id_hash) DO UPDATE SET product = @product, version = @version, country = @country,
    region = @region, city = @city, lat = @lat, lon = @lon, last_seen = @now`);

// Cloudflare headers may be percent-encoded for non-ASCII names.
function header(req, name) {
  const v = req.get(name);
  if (typeof v !== 'string' || !v.trim()) return null;
  let t = v.trim();
  try { t = decodeURIComponent(t); } catch { /* keep raw */ }
  return t.slice(0, 80) || null;
}

function locationFor(req, level) {
  const out = { country: null, region: null, city: null, lat: null, lon: null };
  if (level === 'off') return out;
  const c = (req.get('cf-ipcountry') || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return out;
  out.country = c;
  if (level === 'region' || level === 'city') out.region = header(req, 'cf-region');
  if (level === 'city') {
    out.city = header(req, 'cf-ipcity');
    const la = Number(req.get('cf-iplatitude')), lo = Number(req.get('cf-iplongitude'));
    if (out.city && Number.isFinite(la) && Number.isFinite(lo) && (la || lo)) {
      out.lat = Math.round(la * 10) / 10; out.lon = Math.round(lo * 10) / 10;
    } else { out.lat = out.lon = null; }
  }
  return out;
}

function snapshot() {
  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const rows = db.prepare('SELECT product, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY product').all(now - ACTIVE_DAYS * DAY);
  const put = db.prepare('INSERT OR REPLACE INTO daily (day, product, active) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const p of PRODUCTS) { const r = rows.find(x => x.product === p); put.run(day, p, r ? r.n : 0); }
    db.prepare('DELETE FROM installs WHERE last_seen < ?').run(now - FORGET_AFTER_DAYS * DAY);
  })();
}

function getStats() {
  const now = Math.floor(Date.now() / 1000);
  const since30 = now - ACTIVE_DAYS * DAY;
  const products = Object.fromEntries(PRODUCTS.map(p => [p, 0]));
  for (const r of db.prepare('SELECT product, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY product').all(since30)) products[r.product] = r.n;
  const countries = {}; let countryHidden = 0;
  for (const r of db.prepare("SELECT COALESCE(country, '') AS country, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY country ORDER BY n DESC").all(since30)) {
    if (r.country) countries[r.country] = r.n; else countryHidden += r.n;
  }
  return {
    generatedAt: new Date(now * 1000).toISOString(),
    activeDays: ACTIVE_DAYS,
    active: Object.values(products).reduce((a, b) => a + b, 0),
    activeLast7Days: db.prepare('SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?').get(now - 7 * DAY).n,
    seenThisYear: db.prepare('SELECT COUNT(*) AS n FROM installs').get().n,
    products,
    versions: db.prepare("SELECT product, COALESCE(version, 'unknown') AS version, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY product, version ORDER BY n DESC").all(since30),
    countries,
    countryHidden,
    regions: db.prepare('SELECT country, region, COUNT(*) AS n FROM installs WHERE last_seen >= ? AND region IS NOT NULL GROUP BY country, region ORDER BY n DESC').all(since30),
    towns: db.prepare('SELECT country, region, city, ROUND(AVG(lat), 1) AS lat, ROUND(AVG(lon), 1) AS lon, COUNT(*) AS n FROM installs WHERE last_seen >= ? AND city IS NOT NULL AND lat IS NOT NULL GROUP BY country, region, city ORDER BY n DESC').all(since30),
    trend: db.prepare('SELECT day, product, active FROM daily WHERE day >= ? ORDER BY day').all(new Date((now - 365 * DAY) * 1000).toISOString().slice(0, 10)),
  };
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false); // we never look at the client IP

app.post('/ping', express.json({ limit: '1kb' }), (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').toLowerCase();
  const product = String(b.product || '');
  if (!ID_RE.test(id) || !PRODUCTS.includes(product)) return res.status(400).end();
  const version = VERSION_RE.test(String(b.version || '')) ? String(b.version) : null;
  const level = LEVELS.has(b.location) ? b.location : 'off';
  const id_hash = crypto.createHash('sha256').update('showpilot-install:' + id).digest('hex');
  // Lowering or turning off the map option clears the extra detail on this check-in.
  upsert.run({ id_hash, product, version, ...locationFor(req, level), now: Math.floor(Date.now() / 1000) });
  res.status(204).end();
  pushSoon();
});

// ------------------------------------------------------------
// Live stats page: Server-Sent Events. Open pages get fresh numbers
// whenever an install checks in (bursts are combined into one push per
// second). A comment every 25 s keeps the connection open through
// Cloudflare.
// ------------------------------------------------------------
const MAX_LIVE = 500;
const liveClients = new Set();
let pushTimer = null;

function pushSoon() {
  if (pushTimer || liveClients.size === 0) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const data = 'event: stats\ndata: ' + JSON.stringify(getStats()) + '\n\n';
    for (const res of liveClients) res.write(data);
  }, 1000);
}

setInterval(() => { for (const res of liveClients) res.write(': ping\n\n'); }, 25000).unref();

function requireKey(req, res, next) {
  if (!STATS_KEY || req.query.key === STATS_KEY) return next();
  res.status(404).send('Not found');
}

app.get('/api/stats', requireKey, (req, res) => {
  res.set('Cache-Control', 'no-store').json(getStats());
});
app.get('/api/live', requireKey, (req, res) => {
  if (liveClients.size >= MAX_LIVE) return res.status(503).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  liveClients.add(res);
  req.on('close', () => liveClients.delete(res));
});
app.get('/', requireKey, (req, res) => {
  res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1d' }));
app.use((req, res) => res.status(404).send('Not found'));

// Daily totals for the trend line: once at start, then every 6 hours
// (the row for today is simply replaced).
snapshot();
setInterval(() => { snapshot(); pushSoon(); }, 6 * 60 * 60 * 1000).unref();

app.listen(PORT, HOST, () => console.log(`ShowPilot install counter on http://${HOST}:${PORT}`));
