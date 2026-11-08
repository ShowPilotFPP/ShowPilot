// ============================================================
// ShowPilot — miles or kilometres, picked automatically from the show's location
// ============================================================
// Every distance is STORED in miles (check_radius_miles, audio_gate_radius_miles,
// app_listing_radius_miles). Only what people read changes: the admin page and
// the viewer's "you must be within …" message show kilometres when the show is
// in a country that doesn't use miles.
//
// The country comes from the show's own coordinates (Interaction Safeguards),
// looked up once with OpenStreetMap Nominatim's reverse geocoder whenever they
// change, and saved in config.show_country_code. No coordinates, or the lookup
// fails: miles, as before.
// ============================================================
'use strict';

const db = require('./db');
const config = require('./config-loader');

// Countries whose road distances are in miles.
const MILE_COUNTRIES = new Set(['US', 'GB', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM']);
const KM_PER_MI = 1.609344;

let lastLookupAt = 0;
let inFlight = null;
let soonTimer = null;

function coordsKey(cfg) {
  const la = Number(cfg.show_latitude), lo = Number(cfg.show_longitude);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return '';
  return la.toFixed(2) + ',' + lo.toFixed(2);
}

/** 'mi' or 'km' for this show. */
function unitsFor(cfg) {
  cfg = cfg || db.getConfig();
  const c = String(cfg.show_country_code || '').toUpperCase();
  return c && !MILE_COUNTRIES.has(c) ? 'km' : 'mi';
}

function trimNum(n) {
  const r = Math.round(n * 10) / 10;
  return String(r).replace(/\.0$/, '');
}

/** "0.5 miles", "1 mile", "0.8 km" for a distance stored in miles. */
function formatMiles(mi, cfg) {
  const m = Number(mi) || 0;
  if (unitsFor(cfg) === 'km') return trimNum(m * KM_PER_MI) + ' km';
  const t = trimNum(m);
  return t + (t === '1' ? ' mile' : ' miles');
}

// Looks up the country for the current coordinates if they changed since
// the last lookup. Resolves to the saved country code ('' if unknown).
function refresh() {
  if (inFlight) return inFlight;
  const cfg = db.getConfig();
  const key = coordsKey(cfg);
  if (!key) {
    if (cfg.show_country_code || cfg.show_country_coords) db.updateConfig({ show_country_code: '', show_country_coords: '' });
    return Promise.resolve('');
  }
  if (key === cfg.show_country_coords || config.demoMode || process.env.NODE_ENV === 'test') {
    return Promise.resolve(cfg.show_country_code || '');
  }
  inFlight = (async () => {
    // Nominatim's usage policy: at most one request a second.
    const wait = 1100 - (Date.now() - lastLookupAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastLookupAt = Date.now();
    const [la, lo] = [Number(cfg.show_latitude), Number(cfg.show_longitude)];
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&lat=${la}&lon=${lo}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'ShowPilot-Admin/1.0 (https://github.com/ShowPilotFPP/ShowPilot)', 'Accept': 'application/json' },
      });
      if (!r.ok) return cfg.show_country_code || '';
      const j = await r.json();
      const code = String((j && j.address && j.address.country_code) || '').toUpperCase();
      // Open water or no answer: keep what we had, but don't ask again for these coordinates.
      const keep = /^[A-Z]{2}$/.test(code) ? code : (cfg.show_country_code || '');
      db.updateConfig({ show_country_code: keep, show_country_coords: key });
      return keep;
    } catch {
      return cfg.show_country_code || '';
    } finally {
      clearTimeout(t);
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** After the admin saves new coordinates. */
function refreshSoon() {
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { soonTimer = null; refresh(); }, 1500);
  if (soonTimer.unref) soonTimer.unref();
}

/** Once at startup, for installs that set their location before this existed. */
function start() {
  const t = setTimeout(() => { refresh(); }, 30000);
  if (t.unref) t.unref();
}

async function status(refreshFirst) {
  if (refreshFirst) { try { await refresh(); } catch { /* keep saved */ } }
  const cfg = db.getConfig();
  return { units: unitsFor(cfg), country: String(cfg.show_country_code || '').toUpperCase() };
}

module.exports = { unitsFor, formatMiles, refresh, refreshSoon, start, status, KM_PER_MI, MILE_COUNTRIES };
