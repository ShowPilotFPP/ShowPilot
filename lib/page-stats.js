'use strict';
// ============================================================
// Viewer page stats (v0.33.265) — feeds the "Top Songs" and
// "Tonight's Stats" blocks through GET /api/page-stats.
// ============================================================
// "Tonight" runs from 4 AM to 4 AM in the show's time zone, so a show that
// goes past midnight still counts as one night. Times in the database are
// UTC 'YYYY-MM-DD HH:MM:SS' (SQLite CURRENT_TIMESTAMP).
//
// Top songs count plays the visitors chose (source 'jukebox' or 'vote'),
// leaving out PSAs. Results are cached for 30 seconds so busy pages don't
// query the database on every poll. All SQL here is static (Lite's rule).
// ============================================================

const { db, getConfig } = require('./db');

const DAY_START_HOUR = 4;
const CACHE_MS = 30_000;
let cache = { at: 0, data: null };

function sqlUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Start of tonight, in ms.
function tonightStartMs(nowMs = Date.now()) {
  let tz = String((getConfig() || {}).show_timezone || '').trim();
  try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = ''; }
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(nowMs)).forEach(p => { parts[p.type] = p.value; });
  const h = (parseInt(parts.hour, 10) || 0) % 24;
  const m = parseInt(parts.minute, 10) || 0;
  const s = parseInt(parts.second, 10) || 0;
  const sinceStart = (((h - DAY_START_HOUR) + 24) % 24) * 3600 + m * 60 + s;
  return nowMs - sinceStart * 1000;
}

const topStmt = () => db.prepare(`
  SELECT ph.sequence_name AS name, COALESCE(NULLIF(s.display_name, ''), ph.sequence_name) AS display_name,
         COALESCE(s.artist, '') AS artist, COUNT(*) AS n
  FROM play_history ph
  LEFT JOIN sequences s ON s.name = ph.sequence_name
  WHERE ph.played_at >= ? AND ph.source IN ('jukebox', 'vote') AND COALESCE(s.is_psa, 0) = 0
  GROUP BY ph.sequence_name
  ORDER BY n DESC, MAX(ph.played_at) DESC
  LIMIT 10`);

function count(sql, since) {
  try { return db.prepare(sql).get(since).n || 0; } catch { return 0; }
}

function compute(nowMs = Date.now()) {
  const tonight = sqlUtc(tonightStartMs(nowMs));
  const week = sqlUtc(nowMs - 7 * 86400_000);
  const top = (since) => {
    try { return topStmt().all(since).map(r => ({ name: r.display_name, artist: r.artist, count: r.n })); } catch { return []; }
  };
  return {
    tonight: {
      played: count(`SELECT COUNT(*) AS n FROM play_history WHERE played_at >= ?`, tonight),
      requests: count(`SELECT COUNT(*) AS n FROM jukebox_queue WHERE requested_at >= ?`, tonight),
      votes: count(`SELECT COUNT(*) AS n FROM vote_log WHERE voted_at >= ? AND kind = 'vote'`, tonight),
      visitors: count(`SELECT COUNT(DISTINCT COALESCE(visitor_id, ip || ua_hash)) AS n FROM viewer_visits WHERE visited_at >= ?`, tonight),
    },
    top: {
      tonight: top(tonight),
      week: top(week),
      all: top('0000-00-00 00:00:00'),
    },
  };
}

function get(nowMs = Date.now()) {
  if (!cache.data || nowMs - cache.at > CACHE_MS) cache = { at: nowMs, data: compute(nowMs) };
  return cache.data;
}

module.exports = { get, compute, tonightStartMs, DAY_START_HOUR };
