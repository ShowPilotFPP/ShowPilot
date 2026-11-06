'use strict';
// ============================================================
// Song cooldowns — tiered (v0.33.258, GitHub issue #41)
// ============================================================
// After a song plays it can't be requested or voted for again until a
// cooldown has passed. The cooldown is counted in SONGS (the other songs
// that start after it, like Remote Falcon) or in MINUTES (ShowPilot's
// original behaviour), chosen once for the whole show:
//
//   config.cooldown_unit     'songs' | 'minutes'   (default 'minutes', so
//                                                   existing shows behave the same)
//   config.cooldown_default  the show-wide cooldown (default 0 = none)
//   category  "cooldown"     in config.sequence_categories, per category;
//                            missing/null = use the show-wide value
//   sequences.cooldown       per song; NULL = use its category's value
//                            (or the show-wide one). 0 = never cools down.
//
// Songs set before the tiers existed kept their value in
// sequences.cooldown_minutes (> 0). That still counts as the song's own
// cooldown until the song is edited (the admin then writes `cooldown` and
// clears the old column), so restoring an old backup keeps working too.
//
// Songs-mode counting uses sequences.plays_since_hidden: it is reset to 0
// when the song starts and raised by 1 whenever any other song starts.
//
// config.cooldown_show_cooled = 1 keeps cooling-down songs in the viewer
// list, marked with .showpilot-cooldown + data-cooldown-* attributes and a
// .sequence-cooldown note, instead of removing them (default 0 = remove).
//
// All SQL here is static (Lite's rule).
// ============================================================

const MAX = 1440;

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(MAX, n));
}

function settings(cfg) {
  cfg = cfg || {};
  return {
    unit: cfg.cooldown_unit === 'songs' ? 'songs' : 'minutes',
    global: toInt(cfg.cooldown_default) || 0,
    showCooled: Number(cfg.cooldown_show_cooled) === 1,
  };
}

// The song's own setting: a number, or null to use its category / the show's.
function ownCooldown(seq) {
  if (!seq) return null;
  const own = toInt(seq.cooldown);
  if (own !== null) return own;
  const legacy = toInt(seq.cooldown_minutes);
  return legacy && legacy > 0 ? legacy : null;
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// name (lower-case) -> category cooldown or null.
function categoryMap(cfg) {
  const map = new Map();
  let list = [];
  try { list = require('./categories').listCategories(cfg); } catch (_) { list = []; }
  for (const c of list) map.set(norm(c.name), c.cooldown === undefined ? null : toInt(c.cooldown));
  return map;
}

// Where the song's cooldown comes from and its value.
function resolve(seq, cfg, catMap) {
  const own = ownCooldown(seq);
  if (own !== null) return { value: own, from: 'song' };
  const cat = seq && seq.category ? (catMap || categoryMap(cfg)).get(norm(seq.category)) : null;
  if (cat !== null && cat !== undefined) return { value: cat, from: 'category' };
  return { value: settings(cfg).global, from: 'show' };
}
function effective(seq, cfg, catMap) { return resolve(seq, cfg, catMap).value; }

function playedAtMs(seq) {
  if (!seq || !seq.last_played_at) return null;
  const lpa = String(seq.last_played_at);
  // SQLite CURRENT_TIMESTAMP is UTC without a zone ('YYYY-MM-DD HH:MM:SS').
  const utc = /(Z|[+\-]\d{2}:?\d{2})$/.test(lpa) ? lpa : lpa.replace(' ', 'T') + 'Z';
  const ms = Date.parse(utc);
  return Number.isFinite(ms) ? ms : null;
}

// null when the song can be picked; otherwise
//   { unit: 'songs',   left: <songs still to play> }
//   { unit: 'minutes', left: <minutes, rounded up>, until: ISO }
function status(seq, cfg, catMap, nowMs = Date.now()) {
  const n = effective(seq, cfg, catMap);
  if (!n || !seq.last_played_at) return null;
  if (settings(cfg).unit === 'songs') {
    const played = Math.max(0, parseInt(seq.plays_since_hidden, 10) || 0);
    if (played >= n) return null;
    return { unit: 'songs', left: n - played };
  }
  const at = playedAtMs(seq);
  if (at === null) return null;
  const untilMs = at + n * 60_000;
  if (untilMs <= nowMs) return null;
  return { unit: 'minutes', left: Math.max(1, Math.ceil((untilMs - nowMs) / 60_000)), until: new Date(untilMs).toISOString() };
}

// "after 3 more songs" / "in about 12 minutes"
function describe(st) {
  if (!st) return '';
  if (st.unit === 'songs') return st.left === 1 ? 'after 1 more song' : 'after ' + st.left + ' more songs';
  return st.left <= 1 ? 'in about a minute' : 'in about ' + st.left + ' minutes';
}
function message(st) {
  return 'That song was just played. You can pick it again ' + describe(st) + '.';
}

// Viewer list: drop cooling-down songs, or (show-cooled option) keep them
// with a `cooldown` field the page uses to mark them.
function applyToList(list, cfg, nowMs = Date.now()) {
  const s = settings(cfg);
  const catMap = categoryMap(cfg);
  const out = [];
  for (const seq of list) {
    const st = status(seq, cfg, catMap, nowMs);
    if (!st) { out.push(seq); continue; }
    if (!s.showCooled) continue;
    out.push({ ...seq, cooldown: { unit: st.unit, left: st.left, text: describe(st) } });
  }
  return out;
}

module.exports = { MAX, toInt, settings, ownCooldown, categoryMap, resolve, effective, status, describe, message, applyToList };
