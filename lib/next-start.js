// ============================================================
// next-start.js — when the next song starts, as FPP sees it
// ============================================================
// The plugin (v0.14.30+) works out from FPP's live playlist how long until
// the next song starts: what's left of the playing song or lights-only
// sequence, plus pause steps in between. It sends that with /api/plugin/next.
// Players (app, web player) that already have the next song downloaded start
// it at this time instead of after hearing that it started, so the first
// moments aren't lost. Kept in memory only: it's meaningless after a restart.
'use strict';

let next = null; // { name, atMs }

const MAX_AHEAD_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 5000; // a start time this far in the past is no longer useful

/**
 * Records (or clears, when startsInMs is missing) the start time of [name].
 * rttMs is the plugin's last round trip to this server: half of it is how
 * long this report took to arrive.
 */
function setNextStart(name, startsInMs, rttMs) {
  const n = String(name || '').trim();
  const ms = Number(startsInMs);
  if (!n || !Number.isFinite(ms) || ms < -1000 || ms > MAX_AHEAD_MS) { next = null; return; }
  const rtt = Number(rttMs);
  const transit = Number.isFinite(rtt) && rtt > 0 ? Math.min(rtt / 2, 1000) : 0;
  next = { name: n, atMs: Math.round(Date.now() + ms - transit) };
}

/** Server time (ms) when [name] starts, or null if unknown or not that song. */
function getNextStartAt(name) {
  if (!next || !name) return null;
  if (String(name).toLowerCase() !== next.name.toLowerCase()) return null;
  if (next.atMs < Date.now() - STALE_AFTER_MS) return null;
  return next.atMs;
}

module.exports = { setNextStart, getNextStartAt };
