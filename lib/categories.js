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
    out.push({ name, enabled: c.enabled === 0 || c.enabled === false ? 0 : 1 });
  }
  return out;
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
  return list.map(c => ({ ...c, sequence_count: counts[norm(c.name)] || 0 }));
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
  return !!hit && hit.enabled === 0;
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
    if (c.enabled === 0) disabled.add(norm(c.name));
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
  renameCategory,
  deleteCategory,
  reorderCategories,
  seedFromSequences,
  isCategoryDisabled,
  headersEnabled,
  uncategorizedLabel,
  applyCategoryView,
};
