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
 *
 * Check-in (v0.33.241+): the User-Agent list only catches clients that say
 * what they are. Scanners, link-preview fetchers and scripts often send a
 * normal browser User-Agent and no cookies, so every hit used to count as a
 * new unique visitor. Now a page load is stored with confirmed = 0 and only
 * counts once the page's own script sends its first heartbeat
 * (confirmVisit, called from POST /api/heartbeat). Clients that don't run
 * the page never check in. Rows from before this change have
 * confirmed = NULL and still count.
 */

const crypto = require('crypto');

const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /scraper/i,
  /facebookexternalhit/i, /meta-externalagent/i, /pulsemesh/i,
  /headless/i, /pingdom/i, /uptimerobot/i,
  /curl\//i, /wget/i, /python/i, /go-http-client/i, /okhttp/i, /java\//i,
  /libwww/i, /httpclient/i, /axios/i, /node-fetch/i, /undici/i,
  /scan/i, /zgrab/i, /masscan/i, /nmap/i, /nuclei/i, /censys/i, /expanse/i,
  /preview/i, /whatsapp/i, /monitor/i, /checker/i,
];

// How long after a page load its heartbeat can still confirm it.
const CONFIRM_WINDOW = '-10 minutes';
// Unconfirmed page loads are kept this long (they feed the "left out"
// count on the Stats tab), then deleted.
const UNCONFIRMED_KEEP = '-30 days';
let lastPrune = 0;

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
 * Anonymize an IP address by truncating identifying bits while preserving
 * coarse geographic/ISP signal. Same approach as Google Analytics, Plausible,
 * and Matomo.
 *
 *   IPv4: drop the last octet      192.168.1.42      → 192.168.1.0
 *   IPv6: drop the last 80 bits    2001:db8:1::abcd  → 2001:db8:1::
 *
 * Empty/unrecognized inputs return ''.
 */
function anonymizeIp(ip) {
  if (!ip) return '';
  const s = String(ip).trim();

  // Express may give us "::ffff:192.168.1.1" for IPv4-mapped IPv6 — strip that prefix
  const v4mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = v4mapped ? v4mapped[1] : s;

  // IPv4
  const v4 = candidate.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  }

  // IPv6 — keep first 3 groups (48 bits = approx country/region resolution)
  if (candidate.includes(':')) {
    // Split on ::, then on : to handle compressed forms
    // Simple approach: take everything before any :: shorthand, take first 3 groups, append ::
    const parts = candidate.split(':').filter(p => p !== ''); // drop empties from ::
    if (parts.length >= 3) {
      return `${parts[0]}:${parts[1]}:${parts[2]}::`;
    }
    // Fallback: short-form already, just return prefix + ::
    return candidate.replace(/(:[^:]+){0,3}::?.*$/, '') + '::';
  }

  // Unknown format — return blank rather than store unrecognized data
  return '';
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
    // An admin's browser isn't a visitor (see lib/admin-viewers.js).
    if (require('./admin-viewers').isAdminVisitor(req.cookies?.of_vid)) return;

    let visitorId = req.cookies?.of_vid || null;
    if (!visitorId) {
      visitorId = uuid();
      res.cookie('of_vid', visitorId, {
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
        httpOnly: false, // not security-critical; let JS read it for debugging if needed
        sameSite: 'lax',
      });
    }

    const ip = anonymizeIp(getClientIp(req));
    db.prepare(`
      INSERT INTO viewer_visits (visitor_id, ip, ua_hash, path, confirmed)
      VALUES (?, ?, ?, ?, 0)
    `).run(visitorId, ip, uaHash(ua), path);

    if (Date.now() - lastPrune > 60 * 60 * 1000) {
      lastPrune = Date.now();
      db.prepare(`DELETE FROM viewer_visits WHERE confirmed = 0 AND visited_at < datetime('now', ?)`).run(UNCONFIRMED_KEEP);
    }
  } catch (err) {
    // Never let analytics break the viewer page
    console.error('[visit-tracking] log failed:', err.message);
  }
}

/**
 * Mark this browser's recent page loads as real visits. Called on every
 * viewer heartbeat; a no-op once they're confirmed. Matches on the of_vid
 * cookie, or, when cookies are blocked, on the anonymized IP + User-Agent
 * of a page load in the last minute.
 */
function confirmVisit(req, db) {
  try {
    const visitorId = req.cookies?.of_vid || null;
    if (visitorId) {
      db.prepare(`
        UPDATE viewer_visits SET confirmed = 1
        WHERE visitor_id = ? AND confirmed = 0 AND visited_at > datetime('now', ?)
      `).run(visitorId, CONFIRM_WINDOW);
      return;
    }
    const ua = req.headers['user-agent'] || '';
    db.prepare(`
      UPDATE viewer_visits SET confirmed = 1
      WHERE id = (SELECT id FROM viewer_visits
                  WHERE confirmed = 0 AND ip = ? AND ua_hash = ? AND visited_at > datetime('now', '-1 minute')
                  ORDER BY id DESC LIMIT 1)
    `).run(anonymizeIp(getClientIp(req)), uaHash(ua));
  } catch (err) {
    console.error('[visit-tracking] confirm failed:', err.message);
  }
}

module.exports = { logVisit, confirmVisit, anonymizeIp };
