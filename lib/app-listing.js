// ============================================================
// ShowPilot — list this show in the ShowPilot mobile app
// ============================================================
// Off by default. When the owner turns on Settings → Interaction
// Safeguards → "List my show in the ShowPilot app", this install checks
// in with the show directory once a minute so the app can list it to
// phones that are nearby.
//
// What a check-in contains (nothing else, ever):
//   id         this install's random ID (the directory keeps only a hash)
//   product    'showpilot' | 'showpilot-lite'
//   version
//   name, town           what the app shows (owner-entered)
//   viewerUrl, apiBaseUrl the show's public address (Public base URL)
//   lat, lng   ROUNDED to about a mile unless the owner turned that off
//   radiusMi   always 1: phones see a show only within about a mile of it
//              (fixed for every show, not a setting; master.17)
//   fuzzed     whether lat/lng are rounded, so the directory can allow for it
//   live, hasAudio, nowPlaying
//
// Exact location: when rounding is on (the default), the exact spot never
// leaves this install by any public route — not in the check-in, not in
// /api/public/show-info, and not in the viewer page (the audio distance
// gate switches to asking the server instead of comparing on the phone).
// The one exception is the owner's own choice: "Let the app give exact
// directions" puts the exact pin in /api/public/show-info.
//
// Turning listing off sends a remove request; if the directory can't be
// reached it keeps retrying once a minute until it succeeds.
// Demo mode never lists.
// ============================================================
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config-loader');
const db = require('./db');

const PRODUCT = 'showpilot';
const HAS_AUDIO_ENGINE = true;            // ShowPilot-Lite: false
const DEFAULT_URL = 'https://installs.showpilot.dev/api/shows'; // same app as the install counter
const HEARTBEAT_MS = 60 * 1000;
const LIVE_FRESH_MS = 10 * 1000;           // same threshold as the viewer's "show not playing"
const FUZZ_CELL_DEG = 0.015;               // ~1 mile north-south
// Phones see a listed show only within this distance of it. The same for
// every show on purpose (not a setting): the app is for people at or
// driving past a show, not for browsing shows across town.
const LISTING_RADIUS_MI = 1;

let timer = null;
let soonTimer = null;
let inFlight = false;
let lastResult = null;                     // { ok, at, message, action }

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return ''; }
}

function directoryBase() {
  const raw = String(config.appDirectoryUrl || process.env.SHOWPILOT_APP_DIRECTORY_URL || DEFAULT_URL).trim();
  return raw.replace(/\/+$/, '');
}

function installId() { return require('./install-count').getInstallId(); }

// The public ID the app and directory use for this show. Derived from the
// install ID with a one-way hash, so seeing it tells nobody the install ID.
function listingId(id) {
  return crypto.createHash('sha256').update('showpilot-listing:' + String(id || installId()).toLowerCase()).digest('hex').slice(0, 20);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

function hasCoords(cfg) {
  const la = num(cfg.show_latitude), lo = num(cfg.show_longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && !(la === 0 && lo === 0)
    && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
}

// Snap to the centre of a fixed ~1 mile grid cell. A fixed grid (not random
// noise) means repeated check-ins can't be averaged to find the real spot.
function fuzz(lat, lng) {
  const la = (Math.floor(lat / FUZZ_CELL_DEG) + 0.5) * FUZZ_CELL_DEG;
  const cellLng = FUZZ_CELL_DEG / Math.max(Math.cos(la * Math.PI / 180), 0.2);
  const lo = (Math.floor(lng / cellLng) + 0.5) * cellLng;
  return { lat: Math.round(la * 1e5) / 1e5, lng: Math.round(lo * 1e5) / 1e5 };
}

// The show's public base URL (no trailing slash), or '' if it isn't one a
// phone on cellular could reach.
function publicBase(cfg) {
  let raw = String((cfg.public_base_url || '')).trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')
      || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return '';
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function enabled(cfg) { return !config.demoMode && Number(cfg.app_listing_enabled) === 1; }
function fuzzOn(cfg) { return Number(cfg.app_listing_fuzz) !== 0; }

// True when the viewer page must not carry the exact show coordinates.
function exactCoordsHidden(cfg) { return enabled(cfg) && fuzzOn(cfg); }

// Why this show can't be listed right now (empty = fine).
function problems(cfg) {
  const out = [];
  if (!hasCoords(cfg)) out.push('Set your show location (latitude and longitude) above.');
  if (!publicBase(cfg)) out.push('Set a Public base URL that starts with https:// (Settings → Audio → External audio access). Phones reach your show through it.');
  return out;
}

function liveInfo(cfg) {
  if (cfg.viewer_control_mode === 'OFF') return { live: false, nowPlaying: '' };
  const np = db.getNowPlaying();
  if (!np || !np.sequence_name) return { live: false, nowPlaying: '' };
  const lastMs = Date.parse(String(np.last_updated || '') + 'Z');
  if (!Number.isFinite(lastMs) || Date.now() - lastMs > LIVE_FRESH_MS) return { live: false, nowPlaying: '' };
  let title = np.sequence_name;
  try {
    const seq = db.getSequenceByName(np.sequence_name);
    if (seq && seq.display_name) title = seq.display_name;
  } catch { /* keep the file name */ }
  return { live: true, nowPlaying: cleanText(title, 120) };
}

function hasAudio(cfg) { return HAS_AUDIO_ENGINE && Number(cfg.audio_enabled) !== 0; }

function publishedCoords(cfg) {
  const la = num(cfg.show_latitude), lo = num(cfg.show_longitude);
  return fuzzOn(cfg) ? fuzz(la, lo) : { lat: la, lng: lo };
}

function radius() { return LISTING_RADIUS_MI; }

function showName(cfg) { return cleanText(cfg.app_listing_name || cfg.show_name || 'Light show', 60); }

// The exact check-in body. Exported so the admin page can show it.
function buildPayload(cfg) {
  cfg = cfg || db.getConfig();
  const base = publicBase(cfg);
  const c = publishedCoords(cfg);
  const li = liveInfo(cfg);
  return {
    id: installId(),
    product: PRODUCT,
    version: readVersion(),
    name: showName(cfg),
    town: cleanText(cfg.app_listing_town, 60),
    viewerUrl: base + '/',
    apiBaseUrl: base,
    lat: c.lat,
    lng: c.lng,
    radiusMi: radius(),
    fuzzed: fuzzOn(cfg),
    live: li.live,
    hasAudio: hasAudio(cfg),
    nowPlaying: li.nowPlaying,
  };
}

// GET /api/public/show-info — what the app (and the directory, to confirm
// a check-in really came from this show) reads from the show itself.
function showInfo() {
  const cfg = db.getConfig();
  if (!enabled(cfg) || problems(cfg).length) return { listed: false };
  const p = buildPayload(cfg);
  const exact = { lat: num(cfg.show_latitude), lng: num(cfg.show_longitude) };
  return {
    listed: true,
    listingId: listingId(),
    product: PRODUCT,
    name: p.name,
    town: p.town,
    viewerUrl: p.viewerUrl,
    apiBaseUrl: p.apiBaseUrl,
    lat: p.lat,
    lng: p.lng,
    radiusMi: p.radiusMi,
    fuzzed: fuzzOn(cfg),
    live: p.live,
    hasAudio: p.hasAudio,
    nowPlaying: p.nowPlaying,
    directions: Number(cfg.app_listing_directions) === 1 ? exact : null,
  };
}

function postJson(url, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0, body: null, error: 'Bad directory address' }); }
    const data = JSON.stringify(body);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'ShowPilot-AppListing' },
      timeout: 20000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 8192) buf += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
    req.end(data);
  });
}

async function checkIn() {
  const cfg = db.getConfig();
  const probs = problems(cfg);
  if (probs.length) {
    lastResult = { ok: false, at: Date.now(), action: 'checkin', message: probs.join(' ') };
    return lastResult;
  }
  const r = await postJson(directoryBase() + '/checkin', buildPayload(cfg));
  if (r.status >= 200 && r.status < 300) {
    lastResult = { ok: true, at: Date.now(), action: 'checkin', message: 'Listed in the ShowPilot app.' };
  } else {
    const why = (r.body && r.body.error) || r.error || ('directory answered ' + r.status);
    lastResult = { ok: false, at: Date.now(), action: 'checkin', message: 'Not listed: ' + why };
  }
  return lastResult;
}

async function removeListing() {
  const r = await postJson(directoryBase() + '/remove', { id: installId() });
  if ((r.status >= 200 && r.status < 300) || r.status === 404) {
    db.updateConfig({ app_listing_remove_pending: 0 });
    lastResult = { ok: true, at: Date.now(), action: 'remove', message: 'Removed from the ShowPilot app.' };
  } else {
    lastResult = { ok: false, at: Date.now(), action: 'remove', message: 'Removal will retry: ' + ((r.body && r.body.error) || r.error || ('directory answered ' + r.status)) };
  }
  return lastResult;
}

async function tick() {
  if (inFlight || config.demoMode) return lastResult;
  inFlight = true;
  try {
    const cfg = db.getConfig();
    if (enabled(cfg)) return await checkIn();
    if (Number(cfg.app_listing_remove_pending) === 1) return await removeListing();
    return lastResult;
  } catch (e) {
    return lastResult;
  } finally {
    inFlight = false;
  }
}

function sendSoon() {
  if (config.demoMode) return;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { soonTimer = null; tick(); }, 3000);
  if (soonTimer.unref) soonTimer.unref();
}

const WATCHED = ['app_listing_', 'show_latitude', 'show_longitude', 'show_name', 'public_base_url', 'audio_enabled', 'viewer_control_mode'];

// Called after the admin saves settings. `before` is the config row before
// the save, so we can tell when listing was just turned off.
function onSettingsSaved(updates, before) {
  if (config.demoMode) return;
  const keys = Object.keys(updates || {});
  if (!keys.some(k => WATCHED.some(w => k.startsWith(w)))) return;
  const wasOn = before && Number(before.app_listing_enabled) === 1;
  if ('app_listing_enabled' in updates) {
    if (Number(updates.app_listing_enabled) !== 1 && wasOn) db.updateConfig({ app_listing_remove_pending: 1 });
    if (Number(updates.app_listing_enabled) === 1) db.updateConfig({ app_listing_remove_pending: 0 });
  }
  sendSoon();
}

// Settings sanitizer for PUT /config.
function sanitizeSettings(updates) {
  for (const k of ['app_listing_enabled', 'app_listing_fuzz', 'app_listing_directions']) {
    if (k in updates) updates[k] = (updates[k] === true || Number(updates[k]) === 1 || updates[k] === '1') ? 1 : 0;
  }
  if ('app_listing_name' in updates) updates.app_listing_name = cleanText(updates.app_listing_name, 60);
  if ('app_listing_town' in updates) updates.app_listing_town = cleanText(updates.app_listing_town, 60);
  // The listing distance is fixed (LISTING_RADIUS_MI), not a setting.
  delete updates.app_listing_radius_miles;
}

function status() {
  const cfg = db.getConfig();
  let sample = null;
  try { sample = { ...buildPayload(cfg), id: '(this install\'s random ID — the directory keeps only a hash)' }; } catch {}
  return {
    enabled: enabled(cfg),
    demo: !!config.demoMode,
    problems: problems(cfg),
    removePending: Number(cfg.app_listing_remove_pending) === 1,
    lastResult,
    sample,
    exact: hasCoords(cfg) ? { lat: num(cfg.show_latitude), lng: num(cfg.show_longitude) } : null,
    published: hasCoords(cfg) ? publishedCoords(cfg) : null,
  };
}

function start() {
  if (timer || config.demoMode) return;
  // First check-in shortly after start, then once a minute.
  const first = setTimeout(() => { tick(); }, 20000 + Math.random() * 20000);
  if (first.unref) first.unref();
  timer = setInterval(() => { tick(); }, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
}

function router() {
  const express = require('express');
  const r = express.Router();
  r.get('/api/public/show-info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');
    try { res.json(showInfo()); } catch { res.json({ listed: false }); }
  });
  return r;
}

module.exports = {
  start, tick, sendSoon, onSettingsSaved, sanitizeSettings, status, showInfo, buildPayload,
  exactCoordsHidden, listingId, fuzz, publicBase, router,
};
