// ============================================================
// Sequence categories (v0.33.200+)
// ============================================================
// Operators can group sequences into categories ("Christmas Classics",
// "Kids", "Rock", ...). Categories are:
//   - shown on the viewer page as header rows above each group
//   - individually enable/disable-able: a DISABLED category's sequences
//     drop out of the viewer list entirely and are rejected server-side
//     for votes / jukebox requests / race taps.
//
// Disabling a category affects VIEWER INTERACTION ONLY. It does not touch
// FPP's playlist or the normal scheduled rotation.
//
// Storage — deliberately NOT a new table:
//   - sequences.category (TEXT, pre-existing column) holds the category
//     NAME for each sequence. It already round-trips through backups and
//     sequence snapshots.
//   - config.sequence_categories holds a JSON array, in display order:
//       [{ "name": "Kids", "enabled": 1 }, ...]
//     Optional "schedule" (v0.33.248-beta.6+):
//       { "days": [5,6,0], "from": "17:00", "to": "20:00" }
//     days = 0 (Sunday) … 6 (Saturday), empty/missing = every day; from/to
//     = show-time-zone wall clock, both empty = all day on those days,
//     from > to = overnight (a window that starts Friday 22:00 and ends
//     01:00 counts as Friday's). Outside its schedule a category behaves
//     exactly like a disabled one (see isCategoryAvailable).
//     Living in config means backup/restore carries it with zero changes
//     to lib/backup.js.
// Names match case-insensitively (trimmed). A sequence whose category text
// isn't in the list is treated as an enabled category sorted after the
// known ones (and is auto-registered the next time admin touches it).
//
// Related config columns:
//   viewer_show_categories (INTEGER, default 1) — emit header rows + group
//     the viewer list by category. 0 = categories still gate visibility
//     but the list keeps its plain admin ordering with no headers.
//   uncategorized_label (TEXT, default 'Other') — header text for
//     sequences with no category. Only emitted when at least one
//     categorized sequence is also in the list.

const { db, getConfig, updateConfig } = require('./db');

const MAX_NAME_LEN = 60;

function norm(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

function parseList(cfg) {
  let raw = [];
  try { raw = JSON.parse((cfg && cfg.sequence_categories) || '[]'); } catch { raw = []; }
  if (!Array.isArray(raw)) raw = [];
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.name !== 'string') continue;
    const name = cleanName(c.name);
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = { name, enabled: c.enabled === 0 || c.enabled === false ? 0 : 1 };
    const sched = cleanSchedule(c.schedule);
    if (sched) entry.schedule = sched;
    out.push(entry);
  }
  return out;
}

// ---- Time-slot schedules (v0.33.248-beta.6) ----
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function cleanSchedule(s) {
  if (!s || typeof s !== 'object') return null;
  const days = Array.isArray(s.days)
    ? Array.from(new Set(s.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort()
    : [];
  const from = TIME_RE.test(String(s.from || '')) ? String(s.from) : '';
  const to = TIME_RE.test(String(s.to || '')) ? String(s.to) : '';
  const hasTimes = !!(from && to);
  // Every day + no times would mean "always", which is no schedule at all.
  if (!hasTimes && (days.length === 0 || days.length === 7)) return null;
  return { days: days.length === 7 ? [] : days, from: hasTimes ? from : '', to: hasTimes ? to : '' };
}

function showTimezone(cfg) {
  const tz = String((cfg && cfg.show_timezone) || '').trim();
  if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch {} }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function nowInZone(tz, nowMs) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(new Date(nowMs))) p[x.type] = x.value;
  return { dow: WD[p.weekday], minutes: (+p.hour % 24) * 60 + (+p.minute) };
}
const toMin = (t) => { const m = TIME_RE.exec(t); return m ? (+m[1]) * 60 + (+m[2]) : null; };

// Is a schedule open at nowMs? No schedule = always open.
function scheduleOpen(sched, cfg, nowMs = Date.now()) {
  if (!sched) return true;
  const { dow, minutes } = nowInZone(showTimezone(cfg), nowMs);
  const onDay = (d) => !sched.days || sched.days.length === 0 || sched.days.includes(d);
  const from = toMin(sched.from), to = toMin(sched.to);
  if (from === null || to === null || from === to) return onDay(dow); // all day
  if (from < to) return onDay(dow) && minutes >= from && minutes < to;
  // Overnight: the part after midnight belongs to the previous day.
  return (minutes >= from && onDay(dow)) || (minutes < to && onDay((dow + 6) % 7));
}

// Switched on AND inside its schedule (if it has one).
function isCategoryAvailable(c, cfg, nowMs = Date.now()) {
  return !!c && c.enabled !== 0 && scheduleOpen(c.schedule, cfg, nowMs);
}

function setCategorySchedule(name, schedule) {
  const list = listCategories();
  const hit = list.find(c => norm(c.name) === norm(name));
  if (!hit) return { error: 'Unknown category' };
  let clean = null;
  if (schedule) {
    const from = String(schedule.from || ''), to = String(schedule.to || '');
    if (!!from !== !!to) return { error: 'Set both a start and an end time, or leave both empty for all day.' };
    if (from && (!TIME_RE.test(from) || !TIME_RE.test(to))) return { error: 'Times must be HH:MM (24-hour).' };
    if (from && from === to) return { error: 'Start and end time are the same. Leave both empty for all day.' };
    if (Array.isArray(schedule.days) && schedule.days.length === 0 && !from) {
      return { error: 'Pick at least one day, or set a time window.' };
    }
    clean = cleanSchedule(schedule); // null = every day, all day = no schedule
  }
  if (clean) hit.schedule = clean; else delete hit.schedule;
  saveCategories(list);
  return { ok: true, schedule: clean };
}

function listCategories(cfg) {
  return parseList(cfg || getConfig());
}

function saveCategories(list) {
  updateConfig({ sequence_categories: JSON.stringify(list) });
}

// Admin-facing list with per-category sequence counts.
function listCategoriesWithCounts() {
  const list = listCategories();
  const rows = db.prepare(
    `SELECT LOWER(TRIM(category)) AS k, COUNT(*) AS n FROM sequences
     WHERE category IS NOT NULL AND TRIM(category) != '' GROUP BY k`
  ).all();
  const counts = Object.fromEntries(rows.map(r => [r.k, r.n]));
  const cfg = getConfig();
  return list.map(c => ({ ...c, sequence_count: counts[norm(c.name)] || 0,
    available_now: isCategoryAvailable(c, cfg), timezone: showTimezone(cfg) }));
}

// Make sure a category name exists in the list. Returns the canonical
// (already-registered) spelling so sequences.category stays consistent.
function ensureCategory(name) {
  const clean = cleanName(name);
  if (!clean) return null;
  const list = listCategories();
  const hit = list.find(c => norm(c.name) === norm(clean));
  if (hit) return hit.name;
  list.push({ name: clean, enabled: 1 });
  saveCategories(list);
  return clean;
}

function addCategory(name) {
  const clean = cleanName(name);
  if (!clean) return { error: 'Category name required' };
  const list = listCategories();
  if (list.some(c => norm(c.name) === norm(clean))) return { error: 'Category already exists' };
  list.push({ name: clean, enabled: 1 });
  saveCategories(list);
  return { ok: true, name: clean };
}

function setCategoryEnabled(name, enabled) {
  const list = listCategories();
  const hit = list.find(c => norm(c.name) === norm(name));
  if (!hit) return { error: 'Unknown category' };
  hit.enabled = enabled ? 1 : 0;
  saveCategories(list);
  return { ok: true };
}

function renameCategory(oldName, newName) {
  const clean = cleanName(newName);
  if (!clean) return { error: 'New name required' };
  const list = listCategories();
  const hit = list.find(c => norm(c.name) === norm(oldName));
  if (!hit) return { error: 'Unknown category' };
  if (norm(clean) !== norm(oldName) && list.some(c => norm(c.name) === norm(clean))) {
    return { error: 'A category with that name already exists' };
  }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE sequences SET category = ? WHERE LOWER(TRIM(category)) = ?`)
      .run(clean, norm(oldName));
    hit.name = clean;
    saveCategories(list);
  });
  tx();
  return { ok: true, name: clean };
}

// Deleting a category un-categorizes its sequences; it never deletes them.
function deleteCategory(name) {
  const list = listCategories();
  const next = list.filter(c => norm(c.name) !== norm(name));
  if (next.length === list.length) return { error: 'Unknown category' };
  const tx = db.transaction(() => {
    db.prepare(`UPDATE sequences SET category = NULL WHERE LOWER(TRIM(category)) = ?`).run(norm(name));
    saveCategories(next);
  });
  tx();
  return { ok: true };
}

function reorderCategories(names) {
  if (!Array.isArray(names)) return { error: 'names array required' };
  const list = listCategories();
  const byKey = new Map(list.map(c => [norm(c.name), c]));
  const next = [];
  for (const n of names) {
    const c = byKey.get(norm(n));
    if (c) { next.push(c); byKey.delete(norm(n)); }
  }
  for (const c of byKey.values()) next.push(c); // anything the caller omitted keeps its relative order at the end
  saveCategories(next);
  return { ok: true };
}

// One-shot style seed: register any category text already present on
// sequences (the column predates this feature) so it shows up in admin.
// Idempotent; cheap; called at startup.
function seedFromSequences() {
  const rows = db.prepare(
    `SELECT DISTINCT TRIM(category) AS c FROM sequences
     WHERE category IS NOT NULL AND TRIM(category) != ''`
  ).all();
  if (!rows.length) return;
  const list = listCategories();
  let changed = false;
  for (const r of rows) {
    const clean = cleanName(r.c);
    if (clean && !list.some(c => norm(c.name) === norm(clean))) {
      list.push({ name: clean, enabled: 1 });
      changed = true;
    }
  }
  if (changed) saveCategories(list);
}

function isCategoryDisabled(categoryName, cfg) {
  const key = norm(categoryName);
  if (!key) return false; // uncategorized is always enabled
  const hit = listCategories(cfg).find(c => norm(c.name) === key);
  return !!hit && !isCategoryAvailable(hit, cfg);
}

function headersEnabled(cfg) {
  return !cfg || cfg.viewer_show_categories !== 0;
}

function uncategorizedLabel(cfg) {
  const l = cfg && typeof cfg.uncategorized_label === 'string' ? cfg.uncategorized_label.trim() : '';
  return l || 'Other';
}

// The single place that decides what the viewer list looks like:
//   1. drop sequences whose category is disabled
//   2. if headers are on, stable-sort into category order (known categories
//      in admin order, then unknown names alphabetically, uncategorized last).
//      Within a category the incoming (admin display_order) order is kept.
// Both the server renderer and rf-compat.js then emit a header row each
// time `category` changes between consecutive sequences — so ordering
// logic lives ONLY here and the two renderers can't drift.
function applyCategoryView(sequences, cfg) {
  const list = listCategories(cfg);
  const rank = new Map();
  const disabled = new Set();
  list.forEach((c, i) => {
    rank.set(norm(c.name), i);
    if (!isCategoryAvailable(c, cfg)) disabled.add(norm(c.name)); // off, or outside its schedule
  });
  const visible = (sequences || []).filter(s => !disabled.has(norm(s.category)));
  if (!headersEnabled(cfg)) return visible;

  const UNKNOWN = list.length;
  const UNCAT = list.length + 1;
  const keyed = visible.map((s, i) => {
    const k = norm(s.category);
    const r = !k ? UNCAT : (rank.has(k) ? rank.get(k) : UNKNOWN);
    return { s, i, r, k };
  });
  keyed.sort((a, b) =>
    a.r - b.r ||
    (a.r === UNKNOWN ? a.k.localeCompare(b.k) : 0) ||
    a.i - b.i
  );
  return keyed.map(x => {
    // Normalize spelling to the registered name so header text is consistent.
    const reg = x.k && rank.has(x.k) ? list[rank.get(x.k)].name : null;
    return reg && reg !== x.s.category ? { ...x.s, category: reg } : x.s;
  });
}

module.exports = {
  listCategories,
  listCategoriesWithCounts,
  ensureCategory,
  addCategory,
  setCategoryEnabled,
  setCategorySchedule,
  scheduleOpen,
  isCategoryAvailable,
  renameCategory,
  deleteCategory,
  reorderCategories,
  seedFromSequences,
  isCategoryDisabled,
  headersEnabled,
  uncategorizedLabel,
  applyCategoryView,
};
