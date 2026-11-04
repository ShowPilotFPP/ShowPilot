'use strict';
// ============================================================
// Visitor messages (ShowPilot v0.33.250+ / Lite v0.5.91+)
// ============================================================
// Visitors send a short message to the show owner from the viewer page
// ({MESSAGE_BOX} placeholder). Messages are private: they are only ever
// listed in the admin (Messages tab) and never shown on any public page.
//
// Off by default (config.visitor_messages_enabled = 0). Abuse limits are on
// by default: one message per visitor every few minutes, a nightly cap per
// visitor and per network address, a flood cap for the whole show, an
// optional word filter (matches are masked, not rejected, so a visitor
// can't probe the list), and the same access code / GPS checks used for
// voting and requests when those are turned on (routes/viewer.js).
//
// This file is byte-identical between ShowPilot and ShowPilot-Lite.
// ============================================================

const crypto = require('crypto');
const { db } = require('./db');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS visitor_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- UTC
  name TEXT,                                      -- optional, as typed (trimmed, max 40)
  message TEXT NOT NULL,                          -- word-filtered text
  filtered INTEGER DEFAULT 0,                     -- 1 = the word filter masked something
  viewer_hash TEXT,                               -- hash of the viewer cookie (rate limits only)
  ip_hash TEXT,                                   -- hash of the IP (rate limits only)
  is_read INTEGER DEFAULT 0
)`;
db.exec(CREATE_TABLE_SQL);
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_created ON visitor_messages(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_viewer ON visitor_messages(viewer_hash, created_at)');

const NAME_MAX = 40;
const NIGHT_MODIFIER = '-12 hours'; // "per night" = the last 12 hours (bound as a value)
const SHOW_IDLE_MINUTES = 15;    // "during the show" = a song played in the last 15 minutes
const FLOOD_PER_HOUR = 300;      // whole show: stop accepting past this many in an hour

// Built-in word list, used while config.visitor_messages_filter_words is NULL.
// A trailing * matches any word starting with it.
const DEFAULT_FILTER_WORDS = [
  'fuck*', 'motherfuck*', 'shit*', 'bullshit', 'bitch*', 'cunt*', 'cock', 'cocks', 'dick', 'dicks', 'dickhead*',
  'pussy', 'pussies', 'asshole*', 'bastard*', 'slut*', 'whore*', 'fag', 'fags', 'faggot*', 'nigger*', 'nigga*',
  'retard*', 'twat*', 'wanker*', 'porn*', 'penis*', 'vagina*', 'tits', 'boobs', 'cum',
].join('\n');

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_ACCENT = '#e11d48';

// Black or white text, whichever reads better on the accent color.
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#ffffff' : '#111111';
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Normalized settings from the config row.
function settings(cfg) {
  const c = cfg || {};
  return {
    enabled: c.visitor_messages_enabled === 1,
    when: c.visitor_messages_when === 'always' ? 'always' : 'show',
    maxLength: clampInt(c.visitor_messages_max_length, 20, 1000, 280),
    cooldownMinutes: clampInt(c.visitor_messages_cooldown_minutes, 0, 120, 2),
    nightlyLimit: clampInt(c.visitor_messages_nightly_limit, 0, 100, 5),
    filterEnabled: c.visitor_messages_filter_enabled !== 0,
    filterWords: (c.visitor_messages_filter_words === null || c.visitor_messages_filter_words === undefined)
      ? DEFAULT_FILTER_WORDS : String(c.visitor_messages_filter_words),
    accent: HEX_COLOR.test(String(c.visitor_messages_accent || '').trim()) ? String(c.visitor_messages_accent).trim().toLowerCase() : '',
  };
}

// Clean up values coming from the admin's PUT /config before they're saved.
function sanitizeSettings(updates) {
  const u = updates;
  if ('visitor_messages_enabled' in u) u.visitor_messages_enabled = u.visitor_messages_enabled ? 1 : 0;
  if ('visitor_messages_filter_enabled' in u) u.visitor_messages_filter_enabled = u.visitor_messages_filter_enabled ? 1 : 0;
  if ('visitor_messages_when' in u) u.visitor_messages_when = u.visitor_messages_when === 'always' ? 'always' : 'show';
  if ('visitor_messages_max_length' in u) u.visitor_messages_max_length = clampInt(u.visitor_messages_max_length, 20, 1000, 280);
  if ('visitor_messages_cooldown_minutes' in u) u.visitor_messages_cooldown_minutes = clampInt(u.visitor_messages_cooldown_minutes, 0, 120, 2);
  if ('visitor_messages_nightly_limit' in u) u.visitor_messages_nightly_limit = clampInt(u.visitor_messages_nightly_limit, 0, 100, 5);
  if ('visitor_messages_accent' in u) {
    const a = String(u.visitor_messages_accent == null ? '' : u.visitor_messages_accent).trim();
    u.visitor_messages_accent = HEX_COLOR.test(a) ? a.toLowerCase() : '';
  }
  if ('visitor_messages_filter_words' in u) {
    // null = back to the built-in list; otherwise keep the text (max 20 KB).
    u.visitor_messages_filter_words = u.visitor_messages_filter_words === null ? null : String(u.visitor_messages_filter_words).slice(0, 20000);
  }
  return u;
}

// Is the show "on" for the purpose of the "only during the show" choice?
// Viewer control must not be Off, and a song must be playing now or have
// started in the last SHOW_IDLE_MINUTES. now_playing.last_updated alone is
// NOT a signal: the plugin refreshes it on every check-in, even while idle
// (setNextScheduled etc.), so it stayed fresh all night (fixed in v0.33.251).
function utcMs(v) {
  if (!v) return NaN;
  const s = String(v);
  return Date.parse(s.replace(' ', 'T') + (/[Z+]|-\d\d:\d\d$/.test(s) ? '' : 'Z'));
}
function showIsOn(cfg, np) {
  if (!cfg || cfg.viewer_control_mode === 'OFF') return false;
  // A song is playing right now (position reports refresh last_updated
  // about once a second while it plays).
  if (np && np.sequence_name) {
    const ms = utcMs(np.last_updated);
    if (Number.isFinite(ms) && Date.now() - ms <= 60_000) return true;
  }
  // Otherwise: did a song start recently?
  const row = db.prepare('SELECT MAX(played_at) AS t FROM play_history').get();
  const last = utcMs(row && row.t);
  return Number.isFinite(last) && (Date.now() - last) <= SHOW_IDLE_MINUTES * 60_000;
}

// What the viewer page needs (bootstrap + every /api/state poll).
function viewerState(cfg, np) {
  const s = settings(cfg);
  const open = s.enabled && (s.when === 'always' || showIsOn(cfg, np));
  const accent = s.accent || DEFAULT_ACCENT;
  return { enabled: s.enabled, open, maxLength: s.maxLength, accent, accentText: textOn(accent), customAccent: !!s.accent };
}

// ---- Look ----
// Markup for {MESSAGE_BOX}. Emitted hidden while messages are closed; the
// viewer page opens/closes it live. The accent is set as --sp-message-accent
// on the form only when the admin picked one, so a template's own
// --sp-message-accent (e.g. on :root) wins otherwise. Values are '#rrggbb'
// only (validated above), so they are safe inside the style attribute.
const ICON_CHAT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
function boxHtml(state) {
  const st = state || {};
  const max = Number(st.maxLength) || 280;
  const style = st.customAccent && HEX_COLOR.test(st.accent || '')
    ? ` style="--sp-message-accent:${st.accent};--sp-message-accent-text:${textOn(st.accent)}"` : '';
  return `<form class="sp-message-box" data-showpilot-message-box autocomplete="off"${st.open ? '' : ' hidden'}${style}>` +
    `<div class="sp-message-head"><span class="sp-message-icon">${ICON_CHAT}</span>` +
    `<span class="sp-message-heading"><span class="sp-message-title">Send a message to the show</span>` +
    `<span class="sp-message-sub">Only the show owner can see it</span></span></div>` +
    `<input type="text" class="sp-message-name" name="name" maxlength="40" placeholder="Your name (optional)" aria-label="Your name (optional)">` +
    `<textarea class="sp-message-text" name="message" maxlength="${max}" rows="3" placeholder="Say thanks, request a song, or let us know if something's not working" aria-label="Message to the show"></textarea>` +
    `<div class="sp-message-row"><span class="sp-message-count" aria-hidden="true">0/${max}</span>` +
    `<button type="submit" class="sp-message-send"><span>Send</span>${ICON_SEND}</button></div>` +
    `<div class="sp-message-status" role="status" aria-live="polite"></div>` +
    `</form>`;
}

// Default look. Goes in ShowPilot's base style block at the top of <head>,
// so any template rule wins. Template knobs (CSS variables, set on :root or
// on .sp-message-box): --sp-message-accent, --sp-message-accent-text,
// --sp-message-bg, --sp-message-text, --sp-message-border, --sp-message-field-bg.
const BOX_CSS = `/* Visitor message box ({MESSAGE_BOX}). Template rules win. */
.sp-message-box { position: relative; display: flex; flex-direction: column; gap: 0.7em; width: 100%; max-width: 30em; margin: 1em auto; padding: 1.15em 1.15em 1em; box-sizing: border-box; text-align: left; line-height: 1.35; color: var(--sp-message-text, #f8fafc); background: var(--sp-message-bg, linear-gradient(160deg, rgba(34,30,52,0.88), rgba(10,12,22,0.9))); border: 1px solid var(--sp-message-border, rgba(255,255,255,0.14)); border-radius: 18px; box-shadow: 0 12px 32px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.06); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); overflow: hidden; }
.sp-message-box::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--sp-message-accent, ${DEFAULT_ACCENT}); }
.sp-message-box[hidden] { display: none; }
.sp-message-head { display: flex; align-items: center; gap: 0.7em; margin-bottom: 0.1em; }
.sp-message-icon { flex: 0 0 2.4em; width: 2.4em; height: 2.4em; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--sp-message-accent, ${DEFAULT_ACCENT}); background: rgba(255,255,255,0.08); background: color-mix(in srgb, var(--sp-message-accent, ${DEFAULT_ACCENT}) 20%, transparent); }
.sp-message-heading { display: flex; flex-direction: column; min-width: 0; }
.sp-message-title { font-weight: 700; font-size: 1.05em; letter-spacing: 0.01em; }
.sp-message-sub { font-size: 0.8em; opacity: 0.7; }
.sp-message-box input, .sp-message-box textarea { display: block; width: 100%; box-sizing: border-box; margin: 0; padding: 0.7em 0.85em; font-family: inherit; font-size: max(16px, 0.95em); line-height: 1.4; color: inherit; background: var(--sp-message-field-bg, rgba(255,255,255,0.07)); border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; -webkit-appearance: none; appearance: none; }
.sp-message-box input::placeholder, .sp-message-box textarea::placeholder { color: currentColor; opacity: 0.5; }
.sp-message-box input:focus, .sp-message-box textarea:focus { background: rgba(255,255,255,0.1); border-color: var(--sp-message-accent, ${DEFAULT_ACCENT}); box-shadow: 0 0 0 3px rgba(255,255,255,0.12); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sp-message-accent, ${DEFAULT_ACCENT}) 35%, transparent); }
.sp-message-box textarea { min-height: 5.5em; resize: vertical; }
.sp-message-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75em; }
.sp-message-count { font-size: 0.8em; opacity: 0.6; font-variant-numeric: tabular-nums; }
.sp-message-count[data-near] { opacity: 1; color: #fbbf24; }
.sp-message-send { display: inline-flex; align-items: center; gap: 0.45em; margin: 0; padding: 0.6em 1.35em; font-family: inherit; font-size: 0.95em; font-weight: 700; letter-spacing: 0.02em; color: var(--sp-message-accent-text, #fff); background: var(--sp-message-accent, ${DEFAULT_ACCENT}); border: 0; border-radius: 999px; cursor: pointer; box-shadow: 0 6px 16px rgba(0,0,0,0.3); box-shadow: 0 6px 16px color-mix(in srgb, var(--sp-message-accent, ${DEFAULT_ACCENT}) 40%, transparent); transition: transform 0.12s, filter 0.12s, opacity 0.12s; }
.sp-message-send:hover { filter: brightness(1.08); transform: translateY(-1px); }
.sp-message-send:active { transform: scale(0.97); }
.sp-message-send[disabled] { opacity: 0.6; cursor: default; transform: none; }
.sp-message-status { font-size: 0.88em; }
.sp-message-status:empty { display: none; }
.sp-message-status[data-kind="ok"], .sp-message-status[data-kind="error"] { padding: 0.6em 0.8em; border-radius: 10px; }
.sp-message-status[data-kind="ok"] { color: #bbf7d0; background: rgba(34,197,94,0.16); border: 1px solid rgba(34,197,94,0.35); }
.sp-message-status[data-kind="error"] { color: #fde68a; background: rgba(245,158,11,0.14); border: 1px solid rgba(245,158,11,0.35); }
.sp-message-status[data-kind=""] { opacity: 0.75; }
.sp-message-box.sp-message-sent { animation: sp-message-pop 0.5s ease; }
@keyframes sp-message-pop { 0% { transform: scale(1); } 40% { transform: scale(1.015); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .sp-message-box.sp-message-sent, .sp-message-send { animation: none; transition: none; } }
#messageSent, #messageFailed, #messageTooSoon { display: none; }
`;

// ---- Word filter ----
// Same-length character folding, so match positions line up with the
// original text and only the offending letters get masked.
const FOLD = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't' };
function fold(text) {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    // Keep one output unit per input unit so indexes stay aligned.
    const f = FOLD[lower] || lower;
    out += f.length === ch.length ? f : ch;
  }
  return out;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
let filterCache = { src: null, re: null };
function filterRegex(words) {
  if (filterCache.src === words) return filterCache.re;
  const parts = String(words || '').split(/[\n,]+/).map(w => w.trim().toLowerCase()).filter(Boolean).slice(0, 2000)
    .map(w => w.endsWith('*') ? escapeRe(w.slice(0, -1)) + '[a-z]*' : escapeRe(w));
  const re = parts.length ? new RegExp('(?<![a-z])(?:' + parts.join('|') + ')(?![a-z])', 'g') : null;
  filterCache = { src: words, re };
  return re;
}
function applyFilter(text, words) {
  const re = filterRegex(words);
  if (!re) return { text, filtered: false };
  const folded = fold(text);
  if (folded.length !== text.length) return { text, filtered: false };
  const chars = text.split('');
  let hit = false;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(folded)) !== null) {
    if (!m[0].length) { re.lastIndex++; continue; }
    hit = true;
    for (let i = m.index; i < m.index + m[0].length; i++) chars[i] = '*';
  }
  return { text: hit ? chars.join('') : text, filtered: hit };
}

function hash(s) {
  return crypto.createHash('sha256').update('sp-msg:' + (s || '')).digest('hex').slice(0, 16);
}

function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

// Accept (or refuse) a message from a viewer.
// Returns { ok: true } or { ok: false, status, reason: 'closed'|'empty'|'tooSoon'|'busy', error, retryAfterSeconds? }
function submit(cfg, np, { text, name, viewerToken, ip }) {
  const s = settings(cfg);
  const vs = viewerState(cfg, np);
  if (!vs.enabled || !vs.open) {
    return { ok: false, status: 400, reason: 'closed', error: 'Messages are closed right now.' };
  }
  const rawText = String(text == null ? '' : text);
  if (rawText.trim().length > s.maxLength + 20) {
    return { ok: false, status: 400, reason: 'empty', error: 'That message is too long (' + s.maxLength + ' characters max).' };
  }
  let message = cleanText(rawText, s.maxLength);
  let who = cleanText(name, NAME_MAX).replace(/\n/g, ' ');
  if (!message) return { ok: false, status: 400, reason: 'empty', error: 'Please type a message first.' };

  const vh = hash(viewerToken || ('ip:' + (ip || '')));
  const ih = hash(ip || '');

  if (s.cooldownMinutes > 0) {
    const last = db.prepare('SELECT created_at FROM visitor_messages WHERE viewer_hash = ? ORDER BY id DESC LIMIT 1').get(vh);
    if (last) {
      const lastMs = Date.parse(String(last.created_at).replace(' ', 'T') + 'Z');
      const waitMs = lastMs + s.cooldownMinutes * 60_000 - Date.now();
      if (Number.isFinite(waitMs) && waitMs > 0) {
        const secs = Math.ceil(waitMs / 1000);
        const mins = Math.ceil(secs / 60);
        return { ok: false, status: 429, reason: 'tooSoon', retryAfterSeconds: secs,
          error: 'Thanks! You can send another message in ' + (secs < 60 ? secs + ' seconds.' : mins + (mins === 1 ? ' minute.' : ' minutes.')) };
      }
    }
  }
  if (s.nightlyLimit > 0) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE viewer_hash = ? AND created_at > datetime('now', ?)").get(vh, NIGHT_MODIFIER).n;
    if (n >= s.nightlyLimit) {
      return { ok: false, status: 429, reason: 'tooSoon', error: "Thanks for all your messages! That's the limit for tonight." };
    }
  }
  // Per network address: generous (families and phone carriers share
  // addresses), but stops one device from clearing its cookie to spam.
  const ipCap = s.nightlyLimit > 0 ? Math.max(20, s.nightlyLimit * 4) : 100;
  const ipCount = db.prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE ip_hash = ? AND created_at > datetime('now', ?)").get(ih, NIGHT_MODIFIER).n;
  if (ipCount >= ipCap) {
    return { ok: false, status: 429, reason: 'tooSoon', error: "Thanks for all your messages! That's the limit for tonight." };
  }
  const hourCount = db.prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE created_at > datetime('now', '-1 hours')").get().n;
  if (hourCount >= FLOOD_PER_HOUR) {
    return { ok: false, status: 503, reason: 'busy', error: 'Messages are busy right now. Please try again later.' };
  }

  let filtered = false;
  if (s.filterEnabled) {
    const a = applyFilter(message, s.filterWords);
    const b = who ? applyFilter(who, s.filterWords) : { text: who, filtered: false };
    message = a.text; who = b.text; filtered = a.filtered || b.filtered;
  }
  const info = db.prepare('INSERT INTO visitor_messages (name, message, filtered, viewer_hash, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .run(who || null, message, filtered ? 1 : 0, vh, ih);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

// ---- Admin ----
function unreadCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM visitor_messages WHERE is_read = 0').get().n;
}

function list({ filter = 'all', limit = 200, offset = 0 } = {}) {
  // Static SQL only (no string-built queries; Lite's plugin review rule).
  // unreadOnly is bound as 0/1: "? = 0 OR is_read = 0".
  const unreadOnly = filter === 'unread' ? 1 : 0;
  const lim = clampInt(limit, 1, 1000, 200);
  const off = clampInt(offset, 0, 1e9, 0);
  const rows = db.prepare('SELECT id, created_at, name, message, filtered, is_read FROM visitor_messages WHERE (? = 0 OR is_read = 0) ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(unreadOnly, lim, off);
  const total = db.prepare('SELECT COUNT(*) AS n FROM visitor_messages WHERE (? = 0 OR is_read = 0)').get(unreadOnly).n;
  return { messages: rows, total, unread: unreadCount() };
}

function cleanIds(ids) {
  return (Array.isArray(ids) ? ids : []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0).slice(0, 5000);
}

function setRead({ ids, all, read }) {
  const v = read === false ? 0 : 1;
  if (all) return db.prepare('UPDATE visitor_messages SET is_read = ?').run(v).changes;
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const stmt = db.prepare('UPDATE visitor_messages SET is_read = ? WHERE id = ?');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(v, id).changes, 0))();
}

function remove({ ids, allRead, all }) {
  if (all) return db.prepare('DELETE FROM visitor_messages').run().changes;
  if (allRead) return db.prepare('DELETE FROM visitor_messages WHERE is_read = 1').run().changes;
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const stmt = db.prepare('DELETE FROM visitor_messages WHERE id = ?');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(id).changes, 0))();
}

// CSV for spreadsheets. Cells starting with = + - @ are prefixed with ' so a
// visitor can't plant a formula.
function toCsv() {
  const rows = db.prepare('SELECT id, created_at, name, message, filtered, is_read FROM visitor_messages ORDER BY id DESC').all();
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [['Time (UTC)', 'Name', 'Message', 'Filtered', 'Read'].map(cell).join(',')];
  rows.forEach(r => lines.push([r.created_at, r.name || '', r.message, r.filtered ? 'yes' : '', r.is_read ? 'yes' : ''].map(cell).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  DEFAULT_FILTER_WORDS, DEFAULT_ACCENT, BOX_CSS, boxHtml, settings, sanitizeSettings, showIsOn, viewerState, applyFilter,
  submit, unreadCount, list, setRead, remove, toCsv,
};
