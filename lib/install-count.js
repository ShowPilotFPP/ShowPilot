// ============================================================
// ShowPilot — anonymous install count (v0.33.266+)
// ============================================================
// Once a day, tells the ShowPilot install counter "one more install is
// running". That's how we know how many ShowPilot and ShowPilot-Lite
// installs exist and which versions they run, so we know where to spend
// development time.
//
// Exactly what is sent (nothing else, ever):
//   { id: <random UUID made here>, product: 'showpilot', version: '0.33.266',
//     location: 'off' | 'country' | 'region' | 'city' }
//
// - The ID is random; it is not derived from the machine, show or network.
// - `location` is only the owner's choice for the opt-in map (default
//   'off'). No location is sent — the counter uses its own approximate
//   lookup, only at the level chosen.
// - The counter replies with an empty 204 and stores no IP address.
//
// Turn it off: Settings → General → Install count, or set the env var
// SHOWPILOT_NO_INSTALL_COUNT=1 (DO_NOT_TRACK=1 also works), or put
// `installCount: false` in config.js. Demo mode never sends.
// ============================================================

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config-loader');
const db = require('./db');

const PRODUCT = 'showpilot';
const DEFAULT_URL = 'https://installs.showpilot.dev/ping';
const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS = ['off', 'country', 'region', 'city'];

let timer = null;

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch { return ''; }
}

function truthy(v) { return v === '1' || /^(true|yes|on)$/i.test(String(v || '')); }

// Off for everyone who asked, from any of the places they might ask.
function disabledByEnvironment() {
  if (config.demoMode) return true;
  if (config.installCount === false) return true;
  if (truthy(process.env.SHOWPILOT_NO_INSTALL_COUNT) || truthy(process.env.DO_NOT_TRACK)) return true;
  return false;
}

function getInstallId() {
  const cfg = db.getConfig();
  if (cfg.install_id && /^[0-9a-f-]{36}$/.test(cfg.install_id)) return cfg.install_id;
  const id = crypto.randomUUID();
  db.updateConfig({ install_id: id });
  return id;
}

// Builds the exact check-in body. Exported so the admin page can show
// owners precisely what goes out.
function buildPayload() {
  const cfg = db.getConfig();
  return {
    id: getInstallId(),
    product: PRODUCT,
    version: readVersion(),
    location: LEVELS.includes(cfg.install_count_location) ? cfg.install_count_location : 'off',
  };
}

function isEnabled() {
  if (disabledByEnvironment()) return false;
  return db.getConfig().install_count_enabled !== 0;
}

function send() {
  if (!isEnabled()) return;
  let body;
  try { body = JSON.stringify(buildPayload()); } catch { return; }
  let url;
  try { url = new URL(config.installCountUrl || DEFAULT_URL); } catch { return; }
  const mod = url.protocol === 'http:' ? http : https;
  const req = mod.request({
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'ShowPilot-InstallCount' },
    timeout: 10000,
  }, (res) => { res.resume(); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => {}); // offline shows are normal; never log noise or retry-storm
  req.end(body);
}

// Check in shortly after the owner changes the setting or answers the notice
// (v0.33.267+), so it shows on the stats page right away. Several quick
// changes in a row send once. Does nothing when counting is off.
let soonTimer = null;
function sendSoon() {
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { soonTimer = null; send(); }, 5000);
  if (soonTimer.unref) soonTimer.unref();
}

// First check-in a few minutes after start (so a crash loop doesn't spam),
// then once a day.
function start() {
  if (timer || disabledByEnvironment()) return;
  const firstDelay = (2 + Math.random() * 8) * 60 * 1000;
  timer = setTimeout(function tick() {
    send();
    timer = setTimeout(tick, DAY_MS + Math.random() * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }, firstDelay);
  if (timer.unref) timer.unref();
}

// What the admin page shows: whether it's on, and if something outside
// the setting turned it off.
function status() {
  let lockedReason = null;
  if (config.demoMode) lockedReason = 'demo';
  else if (config.installCount === false) lockedReason = 'config';
  else if (truthy(process.env.SHOWPILOT_NO_INSTALL_COUNT) || truthy(process.env.DO_NOT_TRACK)) lockedReason = 'env';
  const cfg = db.getConfig();
  return {
    enabled: !lockedReason && cfg.install_count_enabled !== 0,
    lockedReason,
    location: LEVELS.includes(cfg.install_count_location) ? cfg.install_count_location : 'off',
    sample: { id: '(random ID for this install)', product: PRODUCT, version: readVersion(),
              location: LEVELS.includes(cfg.install_count_location) ? cfg.install_count_location : 'off' },
  };
}

module.exports = { start, send, sendSoon, status, buildPayload };
