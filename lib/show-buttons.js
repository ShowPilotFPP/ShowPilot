'use strict';
// ============================================================
// Show buttons (ShowPilot v0.33.278-master.12+ / Lite v0.5.124+)
// ============================================================
// Buttons on the viewer page that run something on the show player while
// the show plays: an FPP effect (.eseq) on top of the running sequence, an
// FPP command preset (anything FPP can do: overlay model effects, GPIO,
// fog, a flood light...) or an FPP script.
//
// Flow: a visitor presses a button ({SHOW_BUTTONS} on the page) → POST
// /api/show-button → checks here (button cooldown, per-visitor gap, a
// show-wide flood cap, show open) → the press is queued in memory → the
// FPP plugin, which asks for presses about twice a second while buttons are
// on (the heartbeat tells it: {showButtons: true}), takes it from GET
// /api/plugin/show-buttons and runs it with FPP's POST /api/command.
// Every viewer page gets the new cooldown at once (socket
// 'showButtonsUpdate'), so the crowd sees a button was just used.
//
// Off by default (config.show_buttons_enabled = 0). A press waits at most
// QUEUE_MAX_AGE_MS for the plugin; older ones are dropped rather than
// firing late (e.g. the plugin was restarting).
//
// The plugin only runs the three FPP commands in ACTIONS (its own
// allow-list matches), so a show token can't be used to run anything else.
//
// This file is byte-identical between ShowPilot and ShowPilot-Lite.
// ============================================================

const crypto = require('crypto');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS show_buttons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,                       -- shown on the button (max 40)
  icon TEXT DEFAULT '',                      -- optional emoji/short text before the label (max 8)
  color TEXT DEFAULT '',                     -- '#rrggbb' button color; '' = page accent
  action TEXT NOT NULL DEFAULT 'effect',     -- 'effect' | 'preset' | 'script' (see ACTIONS)
  target TEXT NOT NULL,                      -- effect / preset / script name in FPP
  cooldown_seconds INTEGER DEFAULT 30,       -- whole-show wait after a press (0-3600)
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  last_pressed_at INTEGER DEFAULT 0,         -- ms since epoch
  press_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// action → FPP command + arguments. Effect Start: name, start channel (0 =
// the effect's own), loop=false (play once), background=false,
// ifNotRunning=true (a second press while it plays doesn't restart it).
const ACTIONS = {
  effect: { label: 'FPP effect (.eseq)', command: 'Effect Start', args: (t) => [t, '0', 'false', 'false', 'true'] },
  preset: { label: 'FPP command preset', command: 'Trigger Command Preset', args: (t) => [t] },
  script: { label: 'FPP script', command: 'Run Script', args: (t) => [t, '', ''] },
};
const LAYOUTS = ['row', 'grid'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const QUEUE_MAX_AGE_MS = 15_000;
const QUEUE_MAX = 20;
const FLOOD_PER_MINUTE = 30;   // presses that reach the show, all visitors together
const PLUGIN_FRESH_MS = 60_000; // plugin heartbeats every 15s

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function cleanText(v, max) {
  // One line, no control characters.
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Black or white text, whichever reads better on the color.
function textOn(hex) {
  if (!HEX_COLOR.test(hex || '')) return '#ffffff';
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}

// ---- Settings ----
function settings(cfg) {
  const c = cfg || {};
  return {
    enabled: c.show_buttons_enabled === 1,
    when: c.show_buttons_when === 'always' ? 'always' : 'show',
    viewerGapSeconds: clampInt(c.show_buttons_viewer_gap_seconds, 0, 600, 10),
    heading: c.show_buttons_heading == null ? 'Light up the show' : cleanText(c.show_buttons_heading, 80),
    layout: LAYOUTS.includes(c.show_buttons_layout) ? c.show_buttons_layout : 'row',
  };
}
// Admin saves (routes/admin.js) pass through here.
function sanitizeSettings(u) {
  if ('show_buttons_enabled' in u) u.show_buttons_enabled = u.show_buttons_enabled ? 1 : 0;
  if ('show_buttons_when' in u) u.show_buttons_when = u.show_buttons_when === 'always' ? 'always' : 'show';
  if ('show_buttons_viewer_gap_seconds' in u) u.show_buttons_viewer_gap_seconds = clampInt(u.show_buttons_viewer_gap_seconds, 0, 600, 10);
  if ('show_buttons_heading' in u) u.show_buttons_heading = cleanText(u.show_buttons_heading, 80);
  if ('show_buttons_layout' in u) u.show_buttons_layout = LAYOUTS.includes(u.show_buttons_layout) ? u.show_buttons_layout : 'row';
  return u;
}

// ---- Buttons (admin) ----
function rowOut(r) {
  return {
    id: r.id, label: r.label, icon: r.icon || '', color: r.color || '', action: r.action, target: r.target,
    cooldownSeconds: r.cooldown_seconds, enabled: r.enabled === 1, sortOrder: r.sort_order,
    lastPressedAt: r.last_pressed_at || 0, pressCount: r.press_count || 0,
  };
}
function list() {
  return db.prepare('SELECT * FROM show_buttons ORDER BY sort_order, id').all().map(rowOut);
}
function get(id) {
  const r = db.prepare('SELECT * FROM show_buttons WHERE id = ?').get(Number(id));
  return r ? rowOut(r) : null;
}
// Create (no id) or update. Returns { ok, button } or { error }.
function save(b) {
  b = b || {};
  const label = cleanText(b.label, 40);
  const target = cleanText(b.target, 200);
  const action = Object.prototype.hasOwnProperty.call(ACTIONS, b.action) ? b.action : null;
  if (!label) return { error: 'Give the button a label.' };
  if (!action) return { error: 'Pick what the button does.' };
  if (!target) return { error: 'Enter the name of the ' + (action === 'effect' ? 'effect' : action === 'preset' ? 'command preset' : 'script') + ' in FPP.' };
  const color = HEX_COLOR.test(String(b.color || '').trim()) ? String(b.color).trim().toLowerCase() : '';
  const icon = cleanText(b.icon, 8);
  const cooldown = clampInt(b.cooldownSeconds, 0, 3600, 30);
  const enabled = b.enabled === false || b.enabled === 0 ? 0 : 1;
  if (b.id) {
    const info = db.prepare('UPDATE show_buttons SET label=?, icon=?, color=?, action=?, target=?, cooldown_seconds=?, enabled=? WHERE id=?')
      .run(label, icon, color, action, target, cooldown, enabled, Number(b.id));
    if (!info.changes) return { error: 'That button no longer exists.' };
    return { ok: true, button: get(b.id) };
  }
  const next = (db.prepare('SELECT MAX(sort_order) AS m FROM show_buttons').get().m || 0) + 1;
  const info = db.prepare('INSERT INTO show_buttons (label, icon, color, action, target, cooldown_seconds, enabled, sort_order) VALUES (?,?,?,?,?,?,?,?)')
    .run(label, icon, color, action, target, cooldown, enabled, next);
  return { ok: true, button: get(info.lastInsertRowid) };
}
function remove(id) {
  return db.prepare('DELETE FROM show_buttons WHERE id = ?').run(Number(id)).changes;
}
// ids in the new order.
function reorder(ids) {
  if (!Array.isArray(ids)) return 0;
  const st = db.prepare('UPDATE show_buttons SET sort_order = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => { ids.forEach((id, i) => { n += st.run(i + 1, Number(id)).changes; }); })();
  return n;
}

// ---- Open / closed ----
function utcMs(v) {
  if (!v) return NaN;
  const s = String(v);
  return Date.parse(s.replace(' ', 'T') + (/[Z+]|-\d\d:\d\d$/.test(s) ? '' : 'Z'));
}
function pluginConnected(cfg) {
  const ms = Date.parse(cfg && cfg.plugin_last_seen_at || '');
  return Number.isFinite(ms) && Date.now() - ms <= PLUGIN_FRESH_MS;
}
// A song is playing right now: the plugin refreshes now_playing.last_updated
// about once a second while one plays.
function songPlaying(np) {
  if (!np || !np.sequence_name) return false;
  const ms = utcMs(np.last_updated);
  return Number.isFinite(ms) && Date.now() - ms <= 60_000;
}
// Buttons are pressable: turned on, viewer control not Off, the plugin is
// connected, and (unless "any time") a song is playing.
function isOpen(cfg, np) {
  const s = settings(cfg);
  if (!s.enabled || !cfg || cfg.viewer_control_mode === 'OFF' || !pluginConnected(cfg)) return false;
  return s.when === 'always' || songPlaying(np);
}
// Does the plugin need to ask for presses? (heartbeat answer)
function pluginWanted(cfg) {
  if (!settings(cfg).enabled) return false;
  return !!db.prepare('SELECT 1 FROM show_buttons WHERE enabled = 1 LIMIT 1').get();
}

// What the viewer page needs (bootstrap, every /api/state poll, and the
// 'showButtonsUpdate' socket event). waitMs: how long until each button
// can be pressed again, measured now (the page counts down locally).
function viewerState(cfg, np) {
  const s = settings(cfg);
  const now = Date.now();
  const buttons = s.enabled
    ? db.prepare('SELECT id, label, icon, color, cooldown_seconds, last_pressed_at FROM show_buttons WHERE enabled = 1 ORDER BY sort_order, id').all()
      .map(r => ({
        id: r.id, label: r.label, icon: r.icon || '', color: r.color || '', textColor: r.color ? textOn(r.color) : '',
        waitMs: Math.max(0, (r.last_pressed_at || 0) + r.cooldown_seconds * 1000 - now),
      }))
    : [];
  return { enabled: s.enabled, open: isOpen(cfg, np) && buttons.length > 0, heading: s.heading, layout: s.layout, viewerGapSeconds: s.viewerGapSeconds, buttons };
}

// ---- Presses ----
let queue = [];                 // { pressId, buttonId, command, args, at }
const lastByViewer = new Map(); // viewer hash → ms of their last accepted press
let recent = [];                // ms of accepted presses in the last minute (flood cap)

function viewerHash(token, ipHash) {
  return crypto.createHash('sha256').update(String(token || '') + '|' + String(ipHash || '')).digest('hex').slice(0, 24);
}
function prune(now) {
  queue = queue.filter(q => now - q.at <= QUEUE_MAX_AGE_MS);
  recent = recent.filter(t => now - t < 60_000);
  if (lastByViewer.size > 5000) {
    for (const [k, t] of lastByViewer) if (now - t > 3_600_000) lastByViewer.delete(k);
  }
}
function enqueue(r, now) {
  const a = ACTIONS[r.action];
  if (!a) return null;
  const item = { pressId: crypto.randomBytes(6).toString('hex'), buttonId: r.id, command: a.command, args: a.args(r.target), at: now };
  queue.push(item);
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
  return item;
}

// A visitor pressed a button. opts: { viewer } (from viewerHash).
// Returns { ok } or { error, status, waitMs? }.
function press(buttonId, cfg, np, opts) {
  const now = Date.now();
  prune(now);
  const s = settings(cfg);
  if (!isOpen(cfg, np)) return { error: 'The show buttons are off right now.', status: 400, closed: true };
  const r = db.prepare('SELECT * FROM show_buttons WHERE id = ? AND enabled = 1').get(Number(buttonId));
  if (!r) return { error: 'That button is gone. Reload the page.', status: 404 };
  const ready = (r.last_pressed_at || 0) + r.cooldown_seconds * 1000;
  if (now < ready) return { error: 'Someone just pressed that one!', status: 429, waitMs: ready - now };
  const viewer = opts && opts.viewer;
  if (viewer && s.viewerGapSeconds > 0) {
    const last = lastByViewer.get(viewer) || 0;
    if (now - last < s.viewerGapSeconds * 1000) {
      return { error: 'Give it a few seconds before pressing again.', status: 429, waitMs: last + s.viewerGapSeconds * 1000 - now, viewerWait: true };
    }
  }
  if (recent.length >= FLOOD_PER_MINUTE) return { error: 'Lots of button presses right now. Try again in a moment.', status: 429, waitMs: 5000 };
  // Claim the cooldown atomically so two presses at once can't both fire.
  const claimed = db.prepare('UPDATE show_buttons SET last_pressed_at = ?, press_count = press_count + 1 WHERE id = ? AND last_pressed_at = ?')
    .run(now, r.id, r.last_pressed_at || 0).changes;
  if (!claimed) return { error: 'Someone just pressed that one!', status: 429, waitMs: r.cooldown_seconds * 1000 };
  if (viewer) lastByViewer.set(viewer, now);
  recent.push(now);
  enqueue(r, now);
  return { ok: true };
}

// Admin "Test" button: runs it now, ignoring cooldowns and open/closed
// (but not whether the plugin is connected — the result says so).
function test(buttonId, cfg) {
  const r = db.prepare('SELECT * FROM show_buttons WHERE id = ?').get(Number(buttonId));
  if (!r) return { error: 'That button no longer exists.' };
  prune(Date.now());
  enqueue(r, Date.now());
  return { ok: true, pluginConnected: pluginConnected(cfg), pluginPolling: pluginWanted(cfg) };
}

// The plugin takes every waiting press (oldest first).
function take() {
  prune(Date.now());
  const out = queue.map(q => ({ id: q.pressId, command: q.command, args: q.args }));
  queue = [];
  return out;
}

// ---- Look ----
// Markup for {SHOW_BUTTONS}. rf-compat re-renders the buttons from state
// (renderShowButtons), so keep the two in step:
//   section.sp-show-buttons[data-showpilot-show-buttons][data-layout=row|grid]
//     .sp-sb-heading
//     .sp-sb-list > button.sp-sb-btn[data-sp-button-id] > span.sp-sb-icon + span.sp-sb-label + span.sp-sb-wait
//     .sp-sb-status (role=status)
function buttonHtml(b) {
  const style = b.color ? ` style="--sp-sb-bg:${b.color};--sp-sb-fg:${b.textColor || textOn(b.color)}"` : '';
  const waiting = b.waitMs > 0;
  return `<button type="button" class="sp-sb-btn${waiting ? ' sp-sb-cooling' : ''}" data-sp-button-id="${Number(b.id) || 0}"${waiting ? ' disabled' : ''}${style}>` +
    (b.icon ? `<span class="sp-sb-icon" aria-hidden="true">${esc(b.icon)}</span>` : '') +
    `<span class="sp-sb-label">${esc(b.label)}</span><span class="sp-sb-wait" aria-hidden="true">${waiting ? Math.ceil(b.waitMs / 1000) + 's' : ''}</span></button>`;
}
function buttonsHtml(state) {
  const st = state || {};
  const items = Array.isArray(st.buttons) ? st.buttons : [];
  const layout = LAYOUTS.includes(st.layout) ? st.layout : 'row';
  return `<section class="sp-show-buttons" data-showpilot-show-buttons data-layout="${layout}" aria-label="Show buttons"${st.open ? '' : ' hidden'}>` +
    `<div class="sp-sb-heading"${st.heading ? '' : ' hidden'}>${esc(st.heading || '')}</div>` +
    `<div class="sp-sb-list">${items.map(buttonHtml).join('')}</div>` +
    `<div class="sp-sb-status" role="status" aria-live="polite"></div></section>`;
}

// Default look. Goes in ShowPilot's base style block at the top of <head>,
// so any template rule wins. Template knobs (CSS variables, on :root or on
// .sp-show-buttons): --sp-sb-bg, --sp-sb-fg (button colors; a button's own
// color from the admin wins), --sp-sb-radius.
const CSS = `
.sp-show-buttons { box-sizing: border-box; max-width: 720px; margin: 1rem auto; padding: 0 1rem; text-align: center; }
.sp-show-buttons[hidden] { display: none !important; }
.sp-show-buttons .sp-sb-heading { font-weight: 700; font-size: 1.1em; margin: 0 0 0.6em; }
.sp-show-buttons .sp-sb-heading[hidden] { display: none; }
.sp-show-buttons .sp-sb-list { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.sp-show-buttons[data-layout="grid"] .sp-sb-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sp-sb-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 52px; min-width: 120px; padding: 0 20px; border: 0; border-radius: var(--sp-sb-radius, 14px); cursor: pointer; font: inherit; font-weight: 700; font-size: 1em; background: var(--sp-sb-bg, #dc2626); color: var(--sp-sb-fg, #ffffff); box-shadow: 0 4px 14px rgba(0,0,0,.3); overflow: hidden; -webkit-tap-highlight-color: transparent; touch-action: manipulation; transition: transform .08s ease, filter .2s ease, opacity .2s ease; }
.sp-sb-btn:active:not(:disabled) { transform: scale(.95); }
.sp-sb-btn:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
.sp-sb-btn:disabled { cursor: default; filter: grayscale(.85); opacity: .55; }
.sp-sb-btn .sp-sb-icon { font-size: 1.25em; line-height: 1; }
.sp-sb-btn .sp-sb-wait { font-variant-numeric: tabular-nums; font-size: .85em; opacity: .9; }
.sp-sb-btn .sp-sb-wait:empty { display: none; }
.sp-sb-btn.sp-sb-fired { animation: sp-sb-pop .6s ease; }
@keyframes sp-sb-pop { 0% { box-shadow: 0 0 0 0 rgba(255,255,255,.75); } 100% { box-shadow: 0 0 0 18px rgba(255,255,255,0); } }
.sp-show-buttons .sp-sb-status { min-height: 1.3em; margin-top: .5em; font-size: .9em; opacity: .9; }
@media (prefers-reduced-motion: reduce) { .sp-sb-btn, .sp-sb-btn.sp-sb-fired { transition: none; animation: none; } }
`;

module.exports = {
  ACTIONS, LAYOUTS, CSS, settings, sanitizeSettings, list, get, save, remove, reorder,
  isOpen, pluginWanted, viewerState, viewerHash, press, test, take, buttonsHtml, textOn,
  _resetForTests() { queue = []; lastByViewer.clear(); recent = []; },
};
