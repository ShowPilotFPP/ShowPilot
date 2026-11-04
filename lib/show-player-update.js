// ============================================================
// Show player update notice (v0.33.249-beta.18+)
//
// Works out whether the show player connected to ShowPilot is running an
// old version, for the banner on the admin Dashboard and for the FPP plugin
// (which shows its own warning in FPP when ShowPilot tells it a newer
// version is out).
//
//   - FPP with the ShowPilot plugin: the newest plugin version is read from
//     the plugin's public GitHub repository (version.php on main, which is
//     what FPP's Plugin Manager installs), at most every 6 hours. Without
//     internet access the version bundled below is used, so the banner still
//     appears for plugins older than this ShowPilot release knows about.
//   - Any other show player reports "player-<version>" in its heartbeat and,
//     if it checks for its own updates, the newest version it found
//     (`latestVersion`). ShowPilot just passes that on.
// ============================================================
'use strict';

// Newest plugin version when this ShowPilot was released.
const BUNDLED_PLUGIN_LATEST = '0.14.22';
// Oldest plugin that works properly with this ShowPilot: 0.14.21 is the
// first that takes requests one at a time (older ones can play a request
// twice or skip it).
const PLUGIN_REQUIRED = '0.14.21';
const PLUGIN_REQUIRED_WHY = 'older versions can play a requested song twice or skip it';
const VERSION_URL = 'https://raw.githubusercontent.com/ShowPilotFPP/ShowPilot-plugin/main/version.php';
const RECHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;

let fetchedLatest = null;
let nextCheckAt = 0;
let inflight = null;

function parse(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
function clean(v) {
  const p = parse(v);
  return p ? p.join('.') : null;
}

// Checks GitHub in the background; never throws, never blocks a request.
function refresh() {
  if (inflight || Date.now() < nextCheckAt || typeof fetch !== 'function') return inflight;
  if (process.env.NODE_ENV === 'test') return null;   // scenario tests: bundled version only
  inflight = (async () => {
    let ok = false;
    try {
      const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'ShowPilot' } });
      if (r.ok) {
        const m = (await r.text()).match(/\$PLUGIN_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
        if (m) { fetchedLatest = m[1]; ok = true; }
      }
    } catch (e) { /* offline: the bundled version is used */ }
    nextCheckAt = Date.now() + (ok ? RECHECK_MS : RETRY_MS);
    inflight = null;
  })();
  return inflight;
}

function latestPlugin() {
  return fetchedLatest && cmp(fetchedLatest, BUNDLED_PLUGIN_LATEST) > 0 ? fetchedLatest : BUNDLED_PLUGIN_LATEST;
}

// What the FPP plugin is told in the heartbeat answer.
function forPlugin() {
  refresh();
  return { pluginLatest: latestPlugin(), pluginRequired: PLUGIN_REQUIRED };
}

// cfg: ShowPilot's config row. Returns null when there's nothing to say.
function status(cfg) {
  refresh();
  const raw = String((cfg && cfg.plugin_version) || '').trim();
  if (!raw) return null;
  if (/^player-/i.test(raw)) {
    const installed = clean(raw);
    const latest = clean(cfg.plugin_latest_reported);
    if (!installed || !latest || cmp(latest, installed) <= 0) return null;
    return { kind: 'player', installed, latest, required: null, belowRequired: false };
  }
  const installed = clean(raw);
  if (!installed) return null;
  const latest = latestPlugin();
  const belowRequired = cmp(installed, PLUGIN_REQUIRED) < 0;
  if (!belowRequired && cmp(latest, installed) <= 0) return null;
  return {
    kind: 'fpp', installed, latest, required: PLUGIN_REQUIRED, belowRequired,
    why: belowRequired ? PLUGIN_REQUIRED_WHY : null,
    fppHost: cfg.plugin_fpp_host || null,
  };
}

module.exports = { status, forPlugin, refresh, cmp, clean, BUNDLED_PLUGIN_LATEST, PLUGIN_REQUIRED };
