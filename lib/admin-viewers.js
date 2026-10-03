// Admins aren't viewers (v0.33.231+ / Lite v0.5.70+).
//
// Opening the viewer page and then the admin would otherwise count the admin
// as a viewer. The browser sends the same cookies to both, so when a signed-in
// admin request arrives we know exactly which viewer that browser was:
//   - drop it from the live viewer count now,
//   - remove its page visits from the last 30 minutes from the visitor stats,
//   - and, for 12 hours after its latest admin activity, don't count that
//     browser's heartbeats or page visits (e.g. a viewer tab left open).
// Other devices are unaffected unless they sign in too. In memory only: after
// a restart, the next admin request marks the browser again.
'use strict';
const config = require('./config-loader');

const TTL_MS = 12 * 60 * 60 * 1000;      // how long a browser stays "admin"
const RECENT_MIN = 30;                     // recent visits to remove, in minutes
const THROTTLE_MS = 60 * 1000;             // at most one cleanup per browser per minute
const tokens = new Map();                  // viewer token -> expiry (ms)
const visitors = new Map();                // of_vid visitor id -> expiry (ms)
const lastCleanup = new Map();             // viewer token or visitor id -> ms

function live(map, key) {
  if (!key) return false;
  const exp = map.get(key);
  if (!exp) return false;
  if (exp < Date.now()) { map.delete(key); return false; }
  return true;
}
function isAdminViewerToken(token) { return live(tokens, token); }
function isAdminVisitor(visitorId) { return live(visitors, visitorId); }

function markAdminBrowser(req) {
  try {
    const cookies = req.cookies || {};
    const token = cookies[config.sessionCookieName + '_viewer'] || null;
    const vid = cookies.of_vid || null;
    if (!token && !vid) return;
    const now = Date.now();
    if (token) tokens.set(token, now + TTL_MS);
    if (vid) visitors.set(vid, now + TTL_MS);
    const key = token || vid;
    if (now - (lastCleanup.get(key) || 0) < THROTTLE_MS) return;
    lastCleanup.set(key, now);
    const { db } = require('./db');
    if (token) db.prepare('DELETE FROM active_viewers WHERE viewer_token = ?').run(token);
    if (vid) db.prepare(`DELETE FROM viewer_visits WHERE visitor_id = ? AND visited_at > datetime('now', ?)`).run(vid, `-${RECENT_MIN} minutes`);
    // keep the maps small
    if (lastCleanup.size > 500) for (const [k, t] of lastCleanup) if (now - t > TTL_MS) lastCleanup.delete(k);
  } catch (e) {
    console.error('[admin-viewers] could not exclude admin browser:', e.message);
  }
}

module.exports = { markAdminBrowser, isAdminViewerToken, isAdminVisitor };
