// Scheduled template switches (v0.33.231+).
//
// Each schedule switches the active viewer template at a date/time in the
// show's time zone — once, every year on a date (e.g. October 1), or every
// year on the nth weekday of a month (e.g. the fourth Thursday of November).
// It can also restore a sequence snapshot and set the viewer mode, so one
// entry can change the whole season. Open viewer pages switch live.
//
// Times are stored as wall-clock time + the show's time zone and converted
// to UTC with Intl, so daylight-saving changes are handled. If the server
// was down when a switch was due, it runs as soon as the server is back;
// if several were missed, only the latest one is applied.
'use strict';
const { db, getConfig, restoreSnapshot } = require('./db');

const MODES = ['VOTING', 'JUKEBOX', 'RACE', 'OFF'];

function validTimezone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function showTimezone() {
  const tz = String(getConfig().show_timezone || '').trim();
  return validTimezone(tz) ? tz : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
}

// ---- time zone math (no dependencies) ----
function wallTime(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function offsetMs(ms, tz) {
  const w = wallTime(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}
// Wall-clock time in tz -> UTC ms. A time skipped by a spring-forward change
// runs right after the jump; a time that happens twice runs the first time.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const a = guess - offsetMs(guess, tz);
  const b = guess - offsetMs(a, tz);
  const matches = t => { const w = wallTime(t, tz); return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi; };
  const ok = [a, b].filter(matches);
  if (ok.length) return Math.min(...ok);
  return Math.max(a, b);                          // in a gap: after the jump
}
function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
function nthWeekday(y, mo, nth, weekday) {
  if (nth === -1) {
    const last = daysInMonth(y, mo), dow = new Date(Date.UTC(y, mo - 1, last)).getUTCDay();
    return last - ((dow - weekday + 7) % 7);
  }
  const dow1 = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const d = 1 + ((weekday - dow1 + 7) % 7) + (nth - 1) * 7;
  return d <= daysInMonth(y, mo) ? d : null;
}
function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return [+m[1], +m[2]];
}
// The run in a given year (UTC ms), or null if that year has none.
function occurrenceIn(s, year, tz) {
  const t = parseTime(s.run_time); if (!t) return null;
  if (s.repeat === 'yearly_date') {
    const d = Math.min(s.day, daysInMonth(year, s.month));       // Feb 29 -> Feb 28 in other years
    return zonedToUtc(year, s.month, d, t[0], t[1], tz);
  }
  if (s.repeat === 'yearly_weekday') {
    const d = nthWeekday(year, s.month, s.nth, s.weekday);
    return d ? zonedToUtc(year, s.month, d, t[0], t[1], tz) : null;
  }
  return null;
}
// Next run strictly after afterMs (UTC ms), or null if there is none.
function nextRun(s, afterMs, tz) {
  const t = parseTime(s.run_time); if (!t) return null;
  if (s.repeat === 'once') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s.run_date || ''));
    if (!m) return null;
    const at = zonedToUtc(+m[1], +m[2], +m[3], t[0], t[1], tz);
    return at > afterMs ? at : null;
  }
  const y0 = wallTime(afterMs, tz).y;
  for (let y = y0; y <= y0 + 8; y++) {
    const at = occurrenceIn(s, y, tz);
    if (at != null && at > afterMs) return at;
  }
  return null;
}

// ---- validation (shared by create and update) ----
function clean(body) {
  const b = body || {};
  const out = {
    template_id: parseInt(b.template_id, 10),
    repeat: ['once', 'yearly_date', 'yearly_weekday'].includes(b.repeat) ? b.repeat : 'once',
    run_date: b.run_date ? String(b.run_date) : null,
    month: b.month != null && b.month !== '' ? parseInt(b.month, 10) : null,
    day: b.day != null && b.day !== '' ? parseInt(b.day, 10) : null,
    nth: b.nth != null && b.nth !== '' ? parseInt(b.nth, 10) : null,
    weekday: b.weekday != null && b.weekday !== '' ? parseInt(b.weekday, 10) : null,
    run_time: String(b.run_time || ''),
    snapshot_id: b.snapshot_id ? parseInt(b.snapshot_id, 10) : null,
    viewer_mode: MODES.includes(b.viewer_mode) ? b.viewer_mode : null,
    enabled: b.enabled === 0 || b.enabled === false || b.enabled === '0' ? 0 : 1,
  };
  if (!db.prepare('SELECT 1 FROM viewer_page_templates WHERE id = ?').get(out.template_id)) return { error: 'Choose a template.' };
  if (out.snapshot_id && !db.prepare('SELECT 1 FROM sequence_snapshots WHERE id = ?').get(out.snapshot_id)) return { error: 'That sequence snapshot no longer exists.' };
  if (!parseTime(out.run_time)) return { error: 'Enter a time like 18:00.' };
  if (out.repeat === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(out.run_date || '')) return { error: 'Enter a date.' };
  if (out.repeat !== 'once' && !(out.month >= 1 && out.month <= 12)) return { error: 'Choose a month.' };
  if (out.repeat === 'yearly_date' && !(out.day >= 1 && out.day <= 31)) return { error: 'Choose a day of the month.' };
  if (out.repeat === 'yearly_weekday' && !([1, 2, 3, 4, -1].includes(out.nth) && out.weekday >= 0 && out.weekday <= 6)) return { error: 'Choose which weekday of the month.' };
  if (out.repeat !== 'once') out.run_date = null;
  if (out.repeat !== 'yearly_date') out.day = null;
  if (out.repeat !== 'yearly_weekday') { out.nth = null; out.weekday = null; }
  return { value: out };
}
const iso = ms => (ms == null ? null : new Date(ms).toISOString());

function create(body) {
  const c = clean(body); if (c.error) return c;
  const next = nextRun(c.value, Date.now(), showTimezone());
  if (next == null) return { error: c.value.repeat === 'once' ? 'That date and time has already passed.' : 'That rule never happens (for example, a fifth Thursday).' };
  const v = c.value;
  const r = db.prepare(`INSERT INTO template_schedules (template_id, repeat, run_date, month, day, nth, weekday, run_time, snapshot_id, viewer_mode, enabled, next_run_at)
    VALUES (@template_id, @repeat, @run_date, @month, @day, @nth, @weekday, @run_time, @snapshot_id, @viewer_mode, @enabled, @next)`).run({ ...v, next: iso(next) });
  return { id: r.lastInsertRowid };
}
function update(id, body) {
  if (!db.prepare('SELECT 1 FROM template_schedules WHERE id = ?').get(id)) return { error: 'Schedule not found.', status: 404 };
  const c = clean(body); if (c.error) return c;
  const next = nextRun(c.value, Date.now(), showTimezone());
  if (next == null && c.value.enabled) return { error: c.value.repeat === 'once' ? 'That date and time has already passed.' : 'That rule never happens (for example, a fifth Thursday).' };
  db.prepare(`UPDATE template_schedules SET template_id=@template_id, repeat=@repeat, run_date=@run_date, month=@month, day=@day, nth=@nth, weekday=@weekday,
    run_time=@run_time, snapshot_id=@snapshot_id, viewer_mode=@viewer_mode, enabled=@enabled, next_run_at=@next WHERE id=@id`).run({ ...c.value, next: iso(next), id });
  return { ok: true };
}
function remove(id) { return db.prepare('DELETE FROM template_schedules WHERE id = ?').run(id).changes > 0; }

// Recompute every upcoming run (after the time zone setting changes).
// Runs that are already due are left alone, so they still catch up.
function recomputeAll() {
  const tz = showTimezone(), now = Date.now();
  for (const s of db.prepare('SELECT * FROM template_schedules WHERE enabled = 1').all()) {
    if (s.next_run_at && Date.parse(s.next_run_at) <= now) continue;
    db.prepare('UPDATE template_schedules SET next_run_at = ? WHERE id = ?').run(iso(nextRun(s, now, tz)), s.id);
  }
}

function describe(s, tz) {
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const NTH = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
  const [h, m] = parseTime(s.run_time) || [0, 0];
  const time = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  if (s.repeat === 'yearly_date') return `Every year on ${MO[s.month - 1]} ${s.day} at ${time}`;
  if (s.repeat === 'yearly_weekday') return `Every year on the ${NTH[s.nth]} ${WD[s.weekday]} of ${MO[s.month - 1]} at ${time}`;
  return `Once, ${s.run_date} at ${time}`;
}
function formatLocal(isoStr, tz) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
function list() {
  const tz = showTimezone();
  const rows = db.prepare(`SELECT s.*, t.name AS template_name, sn.name AS snapshot_name FROM template_schedules s
    LEFT JOIN viewer_page_templates t ON t.id = s.template_id LEFT JOIN sequence_snapshots sn ON sn.id = s.snapshot_id
    ORDER BY (s.next_run_at IS NULL), s.next_run_at, s.id`).all();
  return { timezone: tz, configuredTimezone: getConfig().show_timezone || '', serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    schedules: rows.map(s => ({ ...s, rule: describe(s, tz), next_run_local: formatLocal(s.next_run_at, tz), last_run_local: formatLocal(s.last_run_at, tz) })) };
}

// ---- applying a switch ----
function apply(s, io) {
  const tpl = db.prepare('SELECT id, name FROM viewer_page_templates WHERE id = ?').get(s.template_id);
  if (!tpl) { console.warn(`[schedule] #${s.id}: template ${s.template_id} no longer exists; skipped`); return false; }
  if (s.snapshot_id) {
    try { restoreSnapshot(s.snapshot_id); } catch (e) { console.warn(`[schedule] #${s.id}: snapshot restore failed: ${e.message}`); }
  }
  if (s.viewer_mode) {
    // Same effects as the admin's mode switch; the template change below
    // reloads open pages, so the separate mode-change message is skipped.
    require('../routes/viewer').setViewerMode(io, s.viewer_mode, { announce: false });
  }
  db.transaction(() => {
    db.prepare('UPDATE viewer_page_templates SET is_active = 0').run();
    db.prepare('UPDATE viewer_page_templates SET is_active = 1 WHERE id = ?').run(tpl.id);
  })();
  if (io) io.emit('viewerTemplateChanged', { templateId: tpl.id });
  console.log(`[schedule] #${s.id}: switched the viewer page to "${tpl.name}"` + (s.snapshot_id ? ', restored a snapshot' : '') + (s.viewer_mode ? `, mode ${s.viewer_mode}` : ''));
  return true;
}
function markRun(s, nowMs) {
  const next = s.repeat === 'once' ? null : nextRun(s, nowMs, showTimezone());
  db.prepare('UPDATE template_schedules SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?')
    .run(iso(nowMs), iso(next), s.repeat === 'once' ? 0 : s.enabled, s.id);
}
// Run whatever is due. If several are due (the server was down), only the
// latest one is applied; the others are marked as passed.
function tick(io, nowMs = Date.now()) {
  const due = db.prepare("SELECT * FROM template_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id").all(iso(nowMs));
  if (!due.length) return null;
  const latest = due[due.length - 1];
  for (const s of due) { if (s !== latest) markRun(s, nowMs); }
  apply(latest, io);
  markRun(latest, nowMs);
  return latest.id;
}
function runNow(id, io) {
  const s = db.prepare('SELECT * FROM template_schedules WHERE id = ?').get(id);
  if (!s) return false;
  return apply(s, io);
}
let timer = null;
function start(io) {
  // Fill in any missing next runs, then catch up on anything missed while down.
  const tz = showTimezone(), now = Date.now();
  for (const s of db.prepare('SELECT * FROM template_schedules WHERE enabled = 1 AND next_run_at IS NULL').all()) {
    db.prepare('UPDATE template_schedules SET next_run_at = ? WHERE id = ?').run(iso(nextRun(s, now - 1, tz)), s.id);
  }
  setTimeout(() => tick(io), 5000);
  if (timer) clearInterval(timer);
  timer = setInterval(() => { try { tick(io); } catch (e) { console.error('[schedule] tick failed:', e.message); } }, 20 * 1000);
}

module.exports = { start, tick, list, create, update, remove, runNow, recomputeAll, nextRun, zonedToUtc, wallTime, showTimezone, validTimezone };
