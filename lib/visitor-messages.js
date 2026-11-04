'use strict';
// ============================================================
// Visitor messages (ShowPilot v0.33.250+ / Lite v0.5.91+)
// ============================================================
// Visitors send a short message to the show owner from the viewer page
// ({MESSAGE_BOX} placeholder). Messages are private by default: listed only
// in the admin (Messages tab). From v0.33.252 the show owner can turn on a
// message wall ({MESSAGE_WALL}); then a visitor may tick "show my message on
// this page", and only those messages can appear there, after the owner
// approves each one (default) or automatically if the owner chose that.
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
// v0.33.252: message wall. allow_public = the visitor agreed to have it shown;
// is_public = it is on the wall (approved, or auto-approved).
const MSG_COLUMNS = db.prepare('PRAGMA table_info(visitor_messages)').all().map(c => c.name);
if (!MSG_COLUMNS.includes('allow_public')) db.exec('ALTER TABLE visitor_messages ADD COLUMN allow_public INTEGER DEFAULT 0');
if (!MSG_COLUMNS.includes('is_public')) db.exec('ALTER TABLE visitor_messages ADD COLUMN is_public INTEGER DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_public ON visitor_messages(is_public, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_created ON visitor_messages(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_viewer ON visitor_messages(viewer_hash, created_at)');

const NAME_MAX = 40;
const NIGHT_MODIFIER = '-12 hours'; // "per night" = the last 12 hours (bound as a value)
const WALL_STYLES = ['cards', 'bubbles', 'ticker'];
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
    // "Only while the show is on": the box closes this long after the last song started.
    idleMinutes: clampInt(c.visitor_messages_idle_minutes, 1, 120, 15),
    // Message wall (v0.33.252+)
    wall: c.visitor_messages_wall === 1,
    wallApprove: c.visitor_messages_wall_approve !== 0,
    wallStyle: WALL_STYLES.includes(c.visitor_messages_wall_style) ? c.visitor_messages_wall_style : 'cards',
    wallCount: clampInt(c.visitor_messages_wall_count, 1, 30, 8),
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
  if ('visitor_messages_idle_minutes' in u) u.visitor_messages_idle_minutes = clampInt(u.visitor_messages_idle_minutes, 1, 120, 15);
  if ('visitor_messages_wall' in u) u.visitor_messages_wall = u.visitor_messages_wall ? 1 : 0;
  if ('visitor_messages_wall_approve' in u) u.visitor_messages_wall_approve = u.visitor_messages_wall_approve ? 1 : 0;
  if ('visitor_messages_wall_style' in u) u.visitor_messages_wall_style = WALL_STYLES.includes(u.visitor_messages_wall_style) ? u.visitor_messages_wall_style : 'cards';
  if ('visitor_messages_wall_count' in u) u.visitor_messages_wall_count = clampInt(u.visitor_messages_wall_count, 1, 30, 8);
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
// started in the last idleMinutes (setting, default 15). now_playing.last_updated alone is
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
  return Number.isFinite(last) && (Date.now() - last) <= settings(cfg).idleMinutes * 60_000;
}

// What the viewer page needs (bootstrap + every /api/state poll).
function viewerState(cfg, np) {
  const s = settings(cfg);
  const open = s.enabled && (s.when === 'always' || showIsOn(cfg, np));
  const accent = s.accent || DEFAULT_ACCENT;
  return {
    enabled: s.enabled, open, maxLength: s.maxLength, accent, accentText: textOn(accent), customAccent: !!s.accent,
    // Message wall: the box offers "show my message on this page" while it's on.
    wall: { enabled: s.wall, style: s.wallStyle, items: s.wall ? wallItems(s.wallCount) : [] },
  };
}

// Messages currently on the wall, newest first. Only what a visitor agreed
// to share and the owner approved (or auto-approve put there).
function wallItems(count) {
  return db.prepare('SELECT id, created_at, name, message FROM visitor_messages WHERE is_public = 1 AND allow_public = 1 ORDER BY id DESC LIMIT ?')
    .all(clampInt(count, 1, 30, 8))
    .map(r => { const ms = utcMs(r.created_at); return { id: r.id, name: r.name || '', message: r.message, at: Number.isFinite(ms) ? new Date(ms).toISOString() : '' }; });
}

// ---- Look ----
// Markup for {MESSAGE_BOX}. Emitted hidden while messages are closed; the
// viewer page opens/closes it live. The accent is set as --sp-message-accent
// on the form only when the admin picked one, so a template's own
// --sp-message-accent (e.g. on :root) wins otherwise. Values are '#rrggbb'
// only (validated above), so they are safe inside the style attribute.
const ICON_CHAT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
function accentStyle(st) {
  return st && st.customAccent && HEX_COLOR.test(st.accent || '')
    ? ` style="--sp-message-accent:${st.accent};--sp-message-accent-text:${textOn(st.accent)}"` : '';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// "just now", "5 min ago", "2 hr ago", or a date. rf-compat has the same
// wording so server-rendered and live-updated walls match.
function timeAgo(iso, nowMs) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(((nowMs || Date.now()) - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  const d = new Date(ms);
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate();
}
// Stable avatar hue from the name (0-359), so the same name keeps its color.
function hueFor(name) {
  let h = 0;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Markup for {MESSAGE_WALL}. rf-compat re-renders the same markup from the
// /api/state poll (renderMessageWall), so keep the two in step.
//   .sp-message-wall[data-showpilot-message-wall][data-style=cards|bubbles|ticker]
//     .sp-wall-head (icon + "From our visitors")
//     ul.sp-wall-list > li.sp-wall-item > .sp-wall-avatar + .sp-wall-body > .sp-wall-text + .sp-wall-meta (.sp-wall-name, time.sp-wall-time)
// The ticker repeats the list once (aria-hidden) for a seamless loop.
const ICON_WALL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8h10M7 12h6"/><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg>';
function wallItemHtml(m, nowMs) {
  const name = m.name ? esc(m.name) : 'A visitor';
  const initial = esc((m.name || '♥').trim().charAt(0).toUpperCase() || '♥');
  return `<li class="sp-wall-item" data-id="${Number(m.id) || 0}">` +
    `<span class="sp-wall-avatar" style="--sp-wall-hue:${hueFor(m.name)}" aria-hidden="true">${initial}</span>` +
    `<div class="sp-wall-body"><div class="sp-wall-text">${esc(m.message)}</div>` +
    `<div class="sp-wall-meta"><span class="sp-wall-name">${name}</span>` +
    `<time class="sp-wall-time" datetime="${esc(m.at)}">${esc(timeAgo(m.at, nowMs))}</time></div></div></li>`;
}
function wallHtml(state, nowMs) {
  const st = state || {};
  const w = st.wall || {};
  const items = Array.isArray(w.items) ? w.items : [];
  const style = WALL_STYLES.includes(w.style) ? w.style : 'cards';
  const show = !!(w.enabled && items.length);
  const list = items.map(m => wallItemHtml(m, nowMs)).join('');
  const loop = style === 'ticker' && items.length ? `<ul class="sp-wall-list sp-wall-list--dup" aria-hidden="true">${list}</ul>` : '';
  return `<section class="sp-message-wall" data-showpilot-message-wall data-style="${style}" aria-label="Messages from visitors"${show ? '' : ' hidden'}${accentStyle(st)}>` +
    `<div class="sp-wall-head"><span class="sp-wall-icon">${ICON_WALL}</span><span class="sp-wall-title">From our visitors</span></div>` +
    `<div class="sp-wall-track"><ul class="sp-wall-list">${list}</ul>${loop}</div></section>`;
}

function boxHtml(state) {
  const st = state || {};
  const max = Number(st.maxLength) || 280;
  const style = accentStyle(st);
  const wallOn = !!(st.wall && st.wall.enabled);
  return `<form class="sp-message-box" data-showpilot-message-box autocomplete="off"${st.open ? '' : ' hidden'}${style}>` +
    `<div class="sp-message-head"><span class="sp-message-icon">${ICON_CHAT}</span>` +
    `<span class="sp-message-heading"><span class="sp-message-title">Send a message to the show</span>` +
    `<span class="sp-message-sub" data-sp-sub-private${wallOn ? ' hidden' : ''}>Only the show owner can see it</span>` +
    `<span class="sp-message-sub" data-sp-sub-public${wallOn ? '' : ' hidden'}>Messages you choose to share may appear on this page</span></span></div>` +
    `<input type="text" class="sp-message-name" name="name" maxlength="40" placeholder="Your name (optional)" aria-label="Your name (optional)">` +
    `<textarea class="sp-message-text" name="message" maxlength="${max}" rows="3" placeholder="Say thanks, request a song, or let us know if something's not working" aria-label="Message to the show"></textarea>` +
    `<label class="sp-message-public"${wallOn ? '' : ' hidden'}><input type="checkbox" name="public" checked><span class="sp-message-check" aria-hidden="true"></span>` +
    `<span>Show my message on this page</span></label>` +
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
/* "Show my message on this page" (only while the message wall is on). */
.sp-message-public { display: flex; align-items: center; gap: 0.55em; font-size: 0.88em; cursor: pointer; user-select: none; }
.sp-message-public[hidden], .sp-message-sub[hidden] { display: none; }
.sp-message-public input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.sp-message-check { flex: 0 0 1.25em; width: 1.25em; height: 1.25em; border-radius: 6px; border: 1.5px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.06); display: inline-flex; align-items: center; justify-content: center; transition: background 0.15s, border-color 0.15s; }
.sp-message-public input:checked + .sp-message-check { background: var(--sp-message-accent, ${DEFAULT_ACCENT}); border-color: var(--sp-message-accent, ${DEFAULT_ACCENT}); }
.sp-message-public input:checked + .sp-message-check::after { content: ""; width: 0.32em; height: 0.62em; margin-top: -0.12em; border: solid var(--sp-message-accent-text, #fff); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.sp-message-public input:focus-visible + .sp-message-check { box-shadow: 0 0 0 3px rgba(255,255,255,0.25); }
#messageSent, #messageFailed, #messageTooSoon { display: none; }

/* ---- Message wall ({MESSAGE_WALL}). Same knobs as the box. ---- */
.sp-message-wall { width: 100%; max-width: 44em; margin: 1.2em auto; box-sizing: border-box; text-align: left; line-height: 1.4; color: var(--sp-message-text, #f8fafc); }
.sp-message-wall[hidden] { display: none; }
.sp-wall-head { display: flex; align-items: center; justify-content: center; gap: 0.5em; margin: 0 0 0.8em; font-weight: 700; font-size: 0.95em; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.9; }
.sp-wall-icon { display: inline-flex; color: var(--sp-message-accent, ${DEFAULT_ACCENT}); }
.sp-wall-list { list-style: none; margin: 0; padding: 0; }
.sp-wall-list--dup { display: none; }
.sp-wall-avatar { flex: 0 0 2.2em; width: 2.2em; height: 2.2em; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.9em; color: #fff; background: hsl(var(--sp-wall-hue, 340), 62%, 45%); box-shadow: inset 0 0 0 2px rgba(255,255,255,0.18); }
.sp-wall-body { min-width: 0; }
.sp-wall-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.sp-wall-meta { display: flex; align-items: baseline; gap: 0.5em; margin-top: 0.35em; font-size: 0.8em; }
.sp-wall-name { font-weight: 700; color: var(--sp-message-accent, ${DEFAULT_ACCENT}); }
.sp-wall-time { opacity: 0.6; }
.sp-wall-item.sp-wall-new { animation: sp-wall-in 0.6s ease both; }
@keyframes sp-wall-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }

/* Cards: a grid of frosted note cards with a big quote mark. */
.sp-message-wall[data-style="cards"] .sp-wall-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15em), 1fr)); gap: 0.8em; }
.sp-message-wall[data-style="cards"] .sp-wall-item { position: relative; display: flex; flex-direction: column; gap: 0.6em; padding: 1em 1em 0.9em; border-radius: 16px; background: var(--sp-message-bg, linear-gradient(160deg, rgba(34,30,52,0.86), rgba(10,12,22,0.88))); border: 1px solid var(--sp-message-border, rgba(255,255,255,0.13)); box-shadow: 0 8px 24px rgba(0,0,0,0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; }
.sp-message-wall[data-style="cards"] .sp-wall-item::before { content: "\\201C"; position: absolute; right: 0.25em; top: -0.18em; font-family: Georgia, serif; font-size: 4.2em; line-height: 1; color: var(--sp-message-accent, ${DEFAULT_ACCENT}); opacity: 0.35; pointer-events: none; }
.sp-message-wall[data-style="cards"] .sp-wall-avatar { display: none; }
.sp-message-wall[data-style="cards"] .sp-wall-text { font-size: 1.02em; padding-right: 1.2em; }

/* Chat bubbles: alternating left/right speech bubbles with avatars. */
.sp-message-wall[data-style="bubbles"] .sp-wall-list { display: flex; flex-direction: column; gap: 0.75em; max-width: 34em; margin: 0 auto; }
.sp-message-wall[data-style="bubbles"] .sp-wall-item { display: flex; align-items: flex-end; gap: 0.55em; }
.sp-message-wall[data-style="bubbles"] .sp-wall-item:nth-child(even) { flex-direction: row-reverse; }
.sp-message-wall[data-style="bubbles"] .sp-wall-body { position: relative; max-width: 80%; padding: 0.65em 0.9em; border-radius: 18px 18px 18px 6px; background: var(--sp-message-bg, rgba(30,28,46,0.9)); border: 1px solid var(--sp-message-border, rgba(255,255,255,0.13)); box-shadow: 0 6px 18px rgba(0,0,0,0.28); }
.sp-message-wall[data-style="bubbles"] .sp-wall-item:nth-child(even) .sp-wall-body { border-radius: 18px 18px 6px 18px; background: var(--sp-message-accent, ${DEFAULT_ACCENT}); color: var(--sp-message-accent-text, #fff); border-color: transparent; }
.sp-message-wall[data-style="bubbles"] .sp-wall-item:nth-child(even) .sp-wall-name { color: inherit; }
.sp-message-wall[data-style="bubbles"] .sp-wall-item:nth-child(even) .sp-wall-meta { justify-content: flex-end; }

/* Ticker: one line that scrolls across, like a news crawl. Pauses on hover/tap. */
.sp-message-wall[data-style="ticker"] { max-width: none; }
.sp-message-wall[data-style="ticker"] .sp-wall-head { display: none; }
.sp-message-wall[data-style="ticker"] .sp-wall-track { display: flex; width: 100%; overflow: hidden; padding: 0.6em 0; border-radius: 999px; background: var(--sp-message-bg, rgba(10,12,22,0.82)); border: 1px solid var(--sp-message-border, rgba(255,255,255,0.13)); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03), 0 6px 18px rgba(0,0,0,0.3); -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); }
.sp-message-wall[data-style="ticker"] .sp-wall-list, .sp-message-wall[data-style="ticker"] .sp-wall-list--dup { display: flex; flex: 0 0 auto; align-items: center; animation: sp-wall-crawl var(--sp-wall-duration, 40s) linear infinite; }
.sp-message-wall[data-style="ticker"] .sp-wall-track:hover .sp-wall-list, .sp-message-wall[data-style="ticker"] .sp-wall-track:active .sp-wall-list { animation-play-state: paused; }
.sp-message-wall[data-style="ticker"] .sp-wall-item { display: flex; align-items: center; gap: 0.5em; padding: 0 1.4em; white-space: nowrap; }
.sp-message-wall[data-style="ticker"] .sp-wall-item::after { content: "\\2726"; margin-left: 1.4em; color: var(--sp-message-accent, ${DEFAULT_ACCENT}); opacity: 0.8; }
.sp-message-wall[data-style="ticker"] .sp-wall-avatar { flex-basis: 1.7em; width: 1.7em; height: 1.7em; font-size: 0.75em; }
.sp-message-wall[data-style="ticker"] .sp-wall-body { display: flex; align-items: baseline; gap: 0.6em; }
.sp-message-wall[data-style="ticker"] .sp-wall-text { white-space: nowrap; }
.sp-message-wall[data-style="ticker"] .sp-wall-meta { order: -1; margin: 0; }
.sp-message-wall[data-style="ticker"] .sp-wall-time { display: none; }
.sp-message-wall[data-style="ticker"] .sp-wall-name::after { content: ":"; }
@keyframes sp-wall-crawl { from { transform: translateX(0); } to { transform: translateX(-100%); } }
@media (prefers-reduced-motion: reduce) {
  .sp-wall-item.sp-wall-new { animation: none; }
  .sp-message-wall[data-style="ticker"] .sp-wall-track { overflow-x: auto; -webkit-mask-image: none; mask-image: none; }
  .sp-message-wall[data-style="ticker"] .sp-wall-list { animation: none; }
  .sp-message-wall[data-style="ticker"] .sp-wall-list--dup { display: none; }
}
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
function submit(cfg, np, { text, name, viewerToken, ip, allowPublic }) {
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
  // Message wall: only if the wall is on AND the visitor ticked "show my
  // message". Auto-approve puts it straight on the wall.
  const share = s.wall && allowPublic === true ? 1 : 0;
  const onWall = share && !s.wallApprove ? 1 : 0;
  const info = db.prepare('INSERT INTO visitor_messages (name, message, filtered, viewer_hash, ip_hash, allow_public, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(who || null, message, filtered ? 1 : 0, vh, ih, share, onWall);
  return { ok: true, id: Number(info.lastInsertRowid), shared: !!share, onWall: !!onWall, needsApproval: !!(share && !onWall) };
}

// ---- Admin ----
function unreadCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM visitor_messages WHERE is_read = 0').get().n;
}

function pendingCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM visitor_messages WHERE allow_public = 1 AND is_public = 0').get().n;
}

// filter: all | unread | pending (shared, waiting for approval) | public (on the wall)
// Static SQL only (no string-built queries; Lite's plugin review rule): each
// filter is a 0/1 flag bound into the same WHERE clause.
const LIST_SQL = 'SELECT id, created_at, name, message, filtered, is_read, allow_public, is_public FROM visitor_messages WHERE (? = 0 OR is_read = 0) AND (? = 0 OR (allow_public = 1 AND is_public = 0)) AND (? = 0 OR is_public = 1) ORDER BY id DESC LIMIT ? OFFSET ?';
const LIST_COUNT_SQL = 'SELECT COUNT(*) AS n FROM visitor_messages WHERE (? = 0 OR is_read = 0) AND (? = 0 OR (allow_public = 1 AND is_public = 0)) AND (? = 0 OR is_public = 1)';
function list({ filter = 'all', limit = 200, offset = 0 } = {}) {
  const flags = [filter === 'unread' ? 1 : 0, filter === 'pending' ? 1 : 0, filter === 'public' ? 1 : 0];
  const lim = clampInt(limit, 1, 1000, 200);
  const off = clampInt(offset, 0, 1e9, 0);
  const rows = db.prepare(LIST_SQL)
    .all(...flags, lim, off);
  const total = db.prepare(LIST_COUNT_SQL).get(...flags).n;
  return { messages: rows, total, unread: unreadCount(), pending: pendingCount() };
}

// Put messages on the wall or take them off. Only messages the visitor
// agreed to share can go on it.
function setPublic({ ids, show }) {
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const v = show === false ? 0 : 1;
  const stmt = db.prepare('UPDATE visitor_messages SET is_public = ? WHERE id = ? AND allow_public = 1');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(v, id).changes, 0))();
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
  const rows = db.prepare('SELECT id, created_at, name, message, filtered, is_read, allow_public, is_public FROM visitor_messages ORDER BY id DESC').all();
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [['Time (UTC)', 'Name', 'Message', 'Filtered', 'Read', 'OK to share', 'On page'].map(cell).join(',')];
  rows.forEach(r => lines.push([r.created_at, r.name || '', r.message, r.filtered ? 'yes' : '', r.is_read ? 'yes' : '',
    r.allow_public ? 'yes' : '', r.is_public ? 'yes' : ''].map(cell).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  DEFAULT_FILTER_WORDS, DEFAULT_ACCENT, WALL_STYLES, BOX_CSS, boxHtml, wallHtml, timeAgo, settings, sanitizeSettings, showIsOn, viewerState, applyFilter,
  submit, unreadCount, pendingCount, list, setRead, setPublic, remove, toCsv,
};
