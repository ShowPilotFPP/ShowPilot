'use strict';
// ============================================================
// FPP monitor (ShowPilot v0.33.278-master.13+ / Lite v0.5.125+)
// ============================================================
// An FPPmon-style page for the show's main FPP: what's playing, what's next,
// health (temperature and other sensors, CPU, memory, disk, uptime), the
// MultiSync remotes FPP sees, and a few controls (start a playlist, stop,
// run a command preset, restart FPPD).
//
// ShowPilot never connects to FPP itself (that only works on the same
// network, and never from a hosted server). The show player sends a status
// snapshot instead, and picks up controls in the answer:
//
//   heartbeat answer        { fppMonitor: true }  → the player starts sending
//   POST /api/plugin/fpp-status  { status, multisync, disk, playlists?, presets?, now, results? }
//     answer  { ok, commands: [{id, action, name?}], nextInSec }
//
// nextInSec is 5 normally and 1 while someone has the FPP page open or a
// control is waiting, so the page feels live without constant traffic.
// `status` is FPP's own /api/system/status answer (ShowPilot Player sends
// the same shape); `normalize()` turns it into what the page shows.
//
// Controls (`ACTIONS`) are queued in memory and dropped after 30 s if the
// player never picks them up. The player reports each result in its next
// snapshot (`results`), which goes into the activity list with who pressed it.
//
// This file is byte-identical between ShowPilot and ShowPilot-Lite.
// ============================================================

const crypto = require('crypto');

const ACTIONS = {
  startPlaylist: { label: 'Start playlist', needsName: true },
  stopGracefully: { label: 'Stop gracefully' },
  stopNow: { label: 'Stop now' },
  preset: { label: 'Run command preset', needsName: true },
  restartFppd: { label: 'Restart FPPD' },
};
const STALE_MS = 60_000;          // no snapshot this long = not checking in
const WATCH_MS = 15_000;          // page counts as open this long after its last poll
const COMMAND_MAX_AGE_MS = 30_000;
const ACTIVITY_MAX = 25;
const TEMP_WARN = 70, TEMP_BAD = 80;         // °C
const DISK_WARN = 0.15, DISK_BAD = 0.05;     // free fraction

let snap = null;          // { raw, view, at }
let lists = { playlists: [], presets: [], at: 0 };
let queue = [];           // { id, action, name, by, at }
let activity = [];        // { id, action, name, by, at, result: null | {ok, message, at} }
let watchedUntil = 0;

const str = (v, max = 200) => (v === null || v === undefined ? '' : String(v)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const cleanList = (a) => (Array.isArray(a) ? a : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 500);

// ---- From FPP's status JSON to what the page shows ----
const STATES = { playing: 'playing', idle: 'idle', paused: 'paused', testing: 'testing',
  'stopping gracefully': 'stopping', 'stopping gracefully after loop': 'stopping', 'stopping now': 'stopping' };

function normalize(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.status && typeof b.status === 'object' ? b.status : {};
  const adv = s.advancedView && typeof s.advancedView === 'object' ? s.advancedView : {};
  const util = adv.Utilization && typeof adv.Utilization === 'object' ? adv.Utilization : {};
  const cp = s.current_playlist && typeof s.current_playlist === 'object' ? s.current_playlist : {};
  const sched = s.scheduler && typeof s.scheduler === 'object' ? s.scheduler : {};
  const np = sched.nextPlaylist && typeof sched.nextPlaylist === 'object' ? sched.nextPlaylist : {};
  const nextOld = s.next_playlist && typeof s.next_playlist === 'object' ? s.next_playlist : {};
  const statusName = str(s.status_name, 40) || 'unknown';

  const sensors = (Array.isArray(s.sensors) ? s.sensors : []).slice(0, 30).map((x) => ({
    label: str(x && x.label, 60).replace(/:\s*$/, ''),
    formatted: str(x && x.formatted, 40),
    value: num(x && x.value),
    type: str(x && x.valueType, 30),
  })).filter((x) => x.label || x.formatted);
  const temps = sensors.filter((x) => /temp/i.test(x.type) && x.value !== null);
  const cpuTempSensor = temps.find((x) => /cpu|soc|core/i.test(x.label)) || temps[0] || null;

  const disk = b.disk && typeof b.disk === 'object' ? b.disk : {};
  const free = num(disk.freeBytes), total = num(disk.totalBytes);
  const ips = (Array.isArray(adv.IPs) ? adv.IPs : []).map((x) => str(x, 64)).filter(Boolean).slice(0, 8);

  // MultiSync: other systems FPP sees. Ages use FPP's own clock (b.now), so
  // the server's clock doesn't matter.
  const fppNow = num(b.now);
  const msys = (b.multisync && Array.isArray(b.multisync.systems) ? b.multisync.systems : [])
    .filter((x) => x && !x.local).slice(0, 100).map((x) => {
      const seen = num(x.lastSeen);
      const age = seen !== null && fppNow !== null ? Math.max(0, fppNow - seen) : null;
      return {
        hostName: str(x.hostname || x.HostName, 80),
        address: str(x.address, 64),
        mode: str(x.fppModeString, 30),
        type: str(x.type, 60),
        version: str(x.version, 40),
        ageSeconds: age,
        online: age === null ? null : age <= 120,
      };
    });

  const secondsRemaining = num(s.seconds_remaining);
  return {
    state: STATES[statusName] || (statusName === 'unknown' ? 'unknown' : statusName),
    statusName,
    playlist: str(cp.playlist, 200),
    playlistIndex: num(cp.index),
    playlistCount: num(cp.count),
    sequence: str(s.current_sequence, 200),
    media: str(s.current_song, 200),
    secondsElapsed: num(s.seconds_played !== undefined ? s.seconds_played : s.seconds_elapsed),
    secondsRemaining,
    next: { playlist: str(np.playlistName || nextOld.playlist, 200), when: str(np.scheduledStartTimeStr || nextOld.start_time, 80) },
    schedulerEnabled: sched.enabled === undefined ? null : !!Number(sched.enabled),
    mode: str(s.mode_name || adv.Mode, 30),
    hostName: str(s.host_name || adv.HostName, 80),
    hostDescription: str(s.host_description || adv.HostDescription, 120),
    platform: str(adv.Platform || s.platform, 60),
    variant: str(adv.Variant, 60),
    version: str(adv.Version, 40),
    branch: str(adv.Branch, 40),
    osVersion: str(adv.OSVersion, 40),
    ips,
    uptime: str(s.uptimeStr || util.Uptime, 60),
    cpuPercent: num(util.CPU),
    memoryPercent: num(util.Memory),
    cpuTemp: cpuTempSensor ? cpuTempSensor.value : null,
    sensors,
    disk: free !== null && total ? { freeBytes: free, totalBytes: total, freeFraction: Math.max(0, Math.min(1, free / total)) } : null,
    warnings: (Array.isArray(s.warnings) ? s.warnings : []).slice(0, 10).map((w) => str(typeof w === 'object' && w ? w.message || JSON.stringify(w) : w, 300)).filter(Boolean),
    remotes: msys,
    player: str(b.source, 20) === 'player' ? 'player' : 'fpp',
  };
}

// Problems worth a color: 'bad' (red) beats 'warn' (amber).
function health(view, ageMs) {
  const items = [];
  if (ageMs > STALE_MS) items.push({ level: 'bad', text: `No update from your show player for ${Math.round(ageMs / 60000) || 1} min` });
  if (!view) return { level: items.length ? 'bad' : 'unknown', items };
  if (view.cpuTemp !== null) {
    if (view.cpuTemp >= TEMP_BAD) items.push({ level: 'bad', text: `CPU is hot (${Math.round(view.cpuTemp)}°C)` });
    else if (view.cpuTemp >= TEMP_WARN) items.push({ level: 'warn', text: `CPU is warm (${Math.round(view.cpuTemp)}°C)` });
  }
  if (view.disk) {
    const pct = Math.round(view.disk.freeFraction * 100);
    if (view.disk.freeFraction <= DISK_BAD) items.push({ level: 'bad', text: `Disk almost full (${pct}% free)` });
    else if (view.disk.freeFraction <= DISK_WARN) items.push({ level: 'warn', text: `Disk getting full (${pct}% free)` });
  }
  const offline = view.remotes.filter((r) => r.online === false && /remote/i.test(r.mode));
  if (offline.length) items.push({ level: 'warn', text: `${offline.length} MultiSync remote${offline.length === 1 ? '' : 's'} not seen recently` });
  for (const w of view.warnings) items.push({ level: 'warn', text: w });
  const level = items.some((i) => i.level === 'bad') ? 'bad' : items.length ? 'warn' : 'ok';
  return { level, items };
}

// ---- From the show player ----
// body: one snapshot. Returns the answer for the player.
function report(body, opts) {
  const b = body && typeof body === 'object' ? body : {};
  const now = Date.now();
  if (b.status && typeof b.status === 'object') {
    snap = { view: normalize(b), at: now, pluginVersion: str(opts && opts.pluginVersion, 40) };
  }
  if (Array.isArray(b.playlists) || Array.isArray(b.presets)) {
    lists = { playlists: cleanList(b.playlists), presets: cleanList(b.presets), at: now };
  }
  for (const r of Array.isArray(b.results) ? b.results.slice(0, 20) : []) {
    const a = activity.find((x) => x.id === str(r && r.id, 40));
    if (a && !a.result) a.result = { ok: !!(r && r.ok), message: str(r && r.message, 200), at: new Date(now).toISOString() };
  }
  pruneQueue(now);
  const commands = queue.map((q) => ({ id: q.id, action: q.action, ...(q.name ? { name: q.name } : {}) }));
  for (const q of queue) {
    const a = activity.find((x) => x.id === q.id);
    if (a) a.sentAt = new Date(now).toISOString();
  }
  queue = [];
  return { ok: true, commands, nextInSec: now < watchedUntil ? 1 : 5 };
}

function pruneQueue(now) {
  const old = queue.filter((q) => now - q.at > COMMAND_MAX_AGE_MS);
  for (const q of old) {
    const a = activity.find((x) => x.id === q.id);
    if (a && !a.result) a.result = { ok: false, message: 'Your show player never picked this up.', at: new Date(now).toISOString() };
  }
  queue = queue.filter((q) => now - q.at <= COMMAND_MAX_AGE_MS);
}

// ---- From the admin ----
// Returns { ok, id } or { error }.
function command(action, name, by) {
  const a = ACTIONS[action];
  if (!a) return { error: 'Unknown control.' };
  const n = str(name, 200);
  if (a.needsName && !n) return { error: action === 'preset' ? 'Pick a command preset.' : 'Pick a playlist.' };
  const now = Date.now();
  pruneQueue(now);
  if (queue.length >= 10) return { error: 'Too many controls waiting for your show player. Try again in a moment.' };
  const id = crypto.randomBytes(6).toString('hex');
  queue.push({ id, action, name: a.needsName ? n : '', by: str(by, 60), at: now });
  activity.unshift({ id, action, label: a.label, name: a.needsName ? n : '', by: str(by, 60), at: new Date(now).toISOString(), sentAt: null, result: null });
  activity = activity.slice(0, ACTIVITY_MAX);
  watchedUntil = Math.max(watchedUntil, now + WATCH_MS); // fast answers until it's done
  return { ok: true, id };
}

// The FPP page asks every couple of seconds; that also keeps the player on
// its 1-second schedule while the page is open.
function adminState(cfg) {
  const now = Date.now();
  watchedUntil = now + WATCH_MS;
  pruneQueue(now);
  const ageMs = snap ? now - snap.at : null;
  const c = cfg || {};
  const view = snap ? snap.view : null;
  return {
    connected: !!snap && ageMs <= STALE_MS,
    receivedAt: snap ? new Date(snap.at).toISOString() : null,
    ageMs,
    view,
    health: health(view, ageMs === null ? 0 : ageMs),
    playlists: lists.playlists,
    presets: lists.presets,
    pluginVersion: (snap && snap.pluginVersion) || str(c.plugin_version, 40),
    pluginLastSeen: c.plugin_last_seen_at || null,
    fppHost: str(c.plugin_fpp_host, 64),
    activity,
    waiting: queue.length,
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label])),
  };
}

// Small summary for the Dashboard card (doesn't count as watching).
function summary() {
  const now = Date.now();
  const ageMs = snap ? now - snap.at : null;
  const v = snap ? snap.view : null;
  return {
    reporting: !!snap,
    connected: !!snap && ageMs <= STALE_MS,
    health: snap ? health(v, ageMs) : { level: 'unknown', items: [] },
    state: v ? v.state : null,
    playlist: v ? v.playlist : '',
    sequence: v ? v.sequence : '',
    cpuTemp: v ? v.cpuTemp : null,
    hostName: v ? v.hostName : '',
  };
}

module.exports = {
  ACTIONS, STALE_MS, normalize, health, report, command, adminState, summary,
  _resetForTests() { snap = null; lists = { playlists: [], presets: [], at: 0 }; queue = []; activity = []; watchedUntil = 0; },
};
