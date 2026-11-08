// Phone listener counts (v0.33.249+).
//
// A phone that is playing the show audio ("Listen on Phone") polls
// /api/now-playing-audio about once a second while its player is open, so
// each poll is a heartbeat. A phone counts as listening while its last
// heartbeat is under WINDOW_MS old. Phones are told apart by the viewer
// cookie (the same one the viewer count uses); an admin's own browser is
// not counted.
//
// For the Stats page we keep, per day (show time zone), the most phones
// listening at once (peak) and how many different phones listened. Only an
// opaque per-day hash of the cookie is stored, and rows older than
// KEEP_DAYS are dropped.
//
// Phones that lock their screen may pause their polling, so the live count
// is a close estimate rather than an exact one.
//
// Listener limit (hosted installs only): when the install is hosted and the
// host sets SHOWPILOT_MAX_LISTENERS to a positive number, admit() lets a
// phone in only while fewer than that many are listening. Phones already
// listening keep their place; a place frees up when a phone stops polling
// for WINDOW_MS. Self-hosted installs have no limit.
'use strict';
const crypto = require('crypto');
const { db, getConfig } = require('./db');

const WINDOW_MS = 15 * 1000;
const KEEP_DAYS = 90;

db.exec(`
  CREATE TABLE IF NOT EXISTS listener_daily (
    day TEXT PRIMARY KEY,
    peak INTEGER NOT NULL DEFAULT 0,
    peak_at TEXT
  );
  CREATE TABLE IF NOT EXISTS listener_seen (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY (day, key)
  );
`);

const lastSeen = new Map();   // viewer token -> ms of last heartbeat
let seenToday = { day: null, keys: new Set() };
let lastCount = 0;
let onChange = null;

function today() {
  let tz = String(getConfig().show_timezone || '').trim();
  try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = ''; }
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function prune(now = Date.now()) {
  for (const [k, t] of lastSeen) if (now - t > WINDOW_MS) lastSeen.delete(k);
}

function current() {
  prune();
  return lastSeen.size;
}

// Record the count and today's peak; tell the admin pages when it changes.
function settle() {
  const n = current();
  if (n === lastCount) return n;
  lastCount = n;
  if (n > 0) {
    const day = today();
    const row = db.prepare('SELECT peak FROM listener_daily WHERE day = ?').get(day);
    if (!row || n > row.peak) {
      db.prepare(`INSERT INTO listener_daily (day, peak, peak_at) VALUES (?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET peak = excluded.peak, peak_at = excluded.peak_at`).run(day, n, new Date().toISOString());
    }
  }
  if (onChange) { try { onChange(n); } catch {} }
  return n;
}

function cap() {
  if (!require('./config-loader').hosted) return 0;
  const n = parseInt(process.env.SHOWPILOT_MAX_LISTENERS, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// May this phone listen? Always yes without a limit; with one, yes for phones
// already listening and while there's room.
function admit(token) {
  const max = cap();
  if (!max) return true;
  if (!token) return false;
  prune();
  return lastSeen.has(token) || lastSeen.size < max;
}

// Called on every listener heartbeat.
function touch(token) {
  if (!token) return;
  lastSeen.set(token, Date.now());
  const day = today();
  if (seenToday.day !== day) seenToday = { day, keys: new Set() };
  if (!seenToday.keys.has(token)) {
    seenToday.keys.add(token);
    const key = crypto.createHash('sha256').update(day + ':' + token).digest('hex').slice(0, 24);
    db.prepare('INSERT OR IGNORE INTO listener_seen (day, key) VALUES (?, ?)').run(day, key);
  }
  settle();
}

function todayStats() {
  const day = today();
  const row = db.prepare('SELECT peak, peak_at FROM listener_daily WHERE day = ?').get(day);
  const uniq = db.prepare('SELECT COUNT(*) AS n FROM listener_seen WHERE day = ?').get(day).n;
  return { day, now: current(), peakToday: row ? row.peak : 0, peakAt: row ? row.peak_at : null, uniqueToday: uniq };
}

// Per-day rows between two YYYY-MM-DD dates (inclusive; either may be empty).
function byDay(from, to) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const rows = db.prepare(`
    SELECT s.day, COUNT(*) AS unique_count, COALESCE(d.peak, 0) AS peak
    FROM listener_seen s LEFT JOIN listener_daily d ON d.day = s.day
    WHERE (? IS NULL OR s.day >= ?) AND (? IS NULL OR s.day <= ?)
    GROUP BY s.day ORDER BY s.day DESC LIMIT 400
  `).all(ok(from) ? from : null, ok(from) ? from : null, ok(to) ? to : null, ok(to) ? to : null);
  return rows.map(r => ({ day: r.day, peak: r.peak, unique: r.unique_count }));
}

function cleanup() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM listener_seen WHERE day < ?').run(cutoff);
  db.prepare('DELETE FROM listener_daily WHERE day < ?').run(cutoff);
}

// Phones that stop polling drop out after WINDOW_MS; check every few seconds
// so the admin count goes down too, not only up.
function start(changeHandler) {
  onChange = changeHandler || null;
  setInterval(settle, 5000).unref();
  try { cleanup(); } catch {}
  setInterval(() => { try { cleanup(); } catch {} }, 6 * 3600 * 1000).unref();
}

module.exports = { touch, admit, cap, current, todayStats, byDay, start, WINDOW_MS };
