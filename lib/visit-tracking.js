'use strict';
/**
 * Visit tracking — logs viewer page loads to the viewer_visits table for
 * the analytics dashboard.
 *
 * Identity strategy:
 *   - Primary: of_vid cookie (UUID, 90-day expiry) set on first visit.
 *     Survives reverse proxies (Cloudflare, NPM) that hide real client IPs,
 *     so it's the canonical "unique visitor" identifier.
 *   - Fallback: ip + ua_hash. Used to dedupe when cookies are blocked.
 *
 * Things we deliberately skip:
 *   - Bot User-Agents (Googlebot, etc.) — they'd inflate counts misleadingly
 *   - preview=N requests — admin's live-preview iframe, not a real visitor
 *   - Other query params don't matter; '/' is the only logged path right now
 */

const crypto = require('crypto');

const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /scraper/i,
  /facebookexternalhit/i, /pulsemesh/i,
  /headless/i, /pingdom/i, /uptimerobot/i,
];

function isBot(ua) {
  if (!ua) return true; // empty UA is almost always a script
  return BOT_PATTERNS.some(re => re.test(ua));
}

function uaHash(ua) {
  return crypto.createHash('sha1').update(String(ua || '')).digest('hex').slice(0, 12);
}

function uuid() {
  // RFC4122 v4 — good enough for an analytics cookie. crypto.randomUUID exists
  // on Node 14.17+ so we'll use it directly; FPP and Proxmox containers ship
  // newer Node anyway.
  return crypto.randomUUID();
}

function getClientIp(req) {
  // Trust X-Forwarded-For first hop (Express's req.ip already does this when
  // app.set('trust proxy', true) is set, but for safety read raw header too).
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

/**
 * Log a viewer visit. Sets the of_vid cookie if not already present.
 * Returns nothing — failures are swallowed (analytics shouldn't break the page).
 */
function logVisit(req, res, db, path = '/') {
  try {
    const ua = req.headers['user-agent'] || '';
    if (isBot(ua)) return;
    if (req.query && req.query.preview) return;

    let visitorId = req.cookies?.of_vid || null;
    if (!visitorId) {
      visitorId = uuid();
      res.cookie('of_vid', visitorId, {
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
        httpOnly: false, // not security-critical; let JS read it for debugging if needed
        sameSite: 'lax',
      });
    }

    const ip = getClientIp(req);
    db.prepare(`
      INSERT INTO viewer_visits (visitor_id, ip, ua_hash, path)
      VALUES (?, ?, ?, ?)
    `).run(visitorId, ip, uaHash(ua), path);
  } catch (err) {
    // Never let analytics break the viewer page
    console.error('[visit-tracking] log failed:', err.message);
  }
}

module.exports = { logVisit };
