// ============================================================
// ShowPilot install counter — Cloudflare Worker
// ============================================================
// Receives a once-a-day "I'm running" ping from each ShowPilot /
// ShowPilot-Lite install and shows how many are running.
//
// What a ping contains:   a random install ID, the product name,
//                         the version number, and the owner's
//                         location choice: off | country | region | city.
// What we store:          a SHA-256 hash of the install ID, product,
//                         version, last-seen date, and — ONLY at the
//                         level the owner opted into — country, state
//                         and town (from Cloudflare's own lookup; the
//                         install never sends a location).
// What we never store:    IP addresses, show names, URLs, anything else.
// What we send back:      nothing (204 No Content).
// ============================================================

const PRODUCTS = new Set(['showpilot', 'showpilot-lite']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,5}(-[0-9A-Za-z.]{1,20})?$/;
const DAY = 86400;
const ACTIVE_DAYS = 30;
const FORGET_AFTER_DAYS = 400; // seasonal shows come back each year; forget after ~13 months
const LEVELS = new Set(['off', 'country', 'region', 'city']);

import MAP_JS from './vendor/jsvectormap.min.js.txt';
import MAP_CSS from './vendor/jsvectormap.min.css.txt';
import WORLD_JS from './vendor/world.js.txt';
const ASSETS = {
  '/assets/jsvectormap.min.js': [MAP_JS, 'text/javascript'],
  '/assets/jsvectormap.min.css': [MAP_CSS, 'text/css'],
  '/assets/world.js': [WORLD_JS, 'text/javascript'],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/ping' && request.method === 'POST') return await handlePing(request, env);
      if (url.pathname === '/ping' && request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (ASSETS[url.pathname] && request.method === 'GET') {
        const [body, type] = ASSETS[url.pathname];
        return new Response(body, { headers: { 'content-type': type + '; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
      }
      if (url.pathname === '/api/stats' && request.method === 'GET') {
        if (!authorized(url, env)) return new Response('Not found', { status: 404 });
        return json(await getStats(env));
      }
      if (url.pathname === '/' && request.method === 'GET') {
        if (!authorized(url, env)) return new Response('Not found', { status: 404 });
        return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response('Error', { status: 500 });
    }
  },

  async scheduled(_event, env) {
    const now = Math.floor(Date.now() / 1000);
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      'SELECT product, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY product'
    ).bind(now - ACTIVE_DAYS * DAY).all();
    const stmts = [];
    for (const p of PRODUCTS) {
      const row = results.find(r => r.product === p);
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO daily (day, product, active) VALUES (?, ?, ?)').bind(day, p, row ? row.n : 0));
    }
    stmts.push(env.DB.prepare('DELETE FROM installs WHERE last_seen < ?').bind(now - FORGET_AFTER_DAYS * DAY));
    await env.DB.batch(stmts);
  },
};

function authorized(url, env) {
  if (!env.STATS_KEY) return true;
  return url.searchParams.get('key') === env.STATS_KEY;
}

async function handlePing(request, env) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 1024) return new Response(null, { status: 413 });
  let body;
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
  const id = String(body.id || '').toLowerCase();
  const product = String(body.product || '');
  const version = String(body.version || '');
  if (!ID_RE.test(id) || !PRODUCTS.has(product)) return new Response(null, { status: 400 });
  const safeVersion = VERSION_RE.test(version) ? version : null;

  // Location only to the level the owner opted into. Cloudflare supplies
  // it from the connection; the install never sends it. XX = unknown, T1 = Tor.
  const level = LEVELS.has(body.location) ? body.location : 'off';
  const cf = request.cf || {};
  let country = null, region = null, city = null, lat = null, lon = null;
  if (level !== 'off' && typeof cf.country === 'string' && /^[A-Z]{2}$/.test(cf.country) && cf.country !== 'XX' && cf.country !== 'T1') {
    country = cf.country;
    if (level === 'region' || level === 'city') region = clean(cf.region);
    if (level === 'city') {
      city = clean(cf.city);
      const la = Number(cf.latitude), lo = Number(cf.longitude);
      if (city && Number.isFinite(la) && Number.isFinite(lo)) { lat = Math.round(la * 10) / 10; lon = Math.round(lo * 10) / 10; }
    }
  }

  const idHash = await sha256(id);
  const now = Math.floor(Date.now() / 1000);
  // Lowering or turning off the location option clears the extra detail on the next ping.
  await env.DB.prepare(
    `INSERT INTO installs (id_hash, product, version, country, region, city, lat, lon, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(id_hash) DO UPDATE SET product = ?2, version = ?3, country = ?4, region = ?5,
       city = ?6, lat = ?7, lon = ?8, last_seen = ?9`
  ).bind(idHash, product, safeVersion, country, region, city, lat, lon, now).run();
  return new Response(null, { status: 204 });
}

function clean(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, 80);
  return t || null;
}

async function getStats(env) {
  const now = Math.floor(Date.now() / 1000);
  const since30 = now - ACTIVE_DAYS * DAY;
  const since7 = now - 7 * DAY;
  const db = env.DB;
  const [byProduct, byVersion, byCountry, week, ever, trend, byRegion, towns] = await db.batch([
    db.prepare('SELECT product, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY product').bind(since30),
    db.prepare('SELECT product, COALESCE(version, \'unknown\') AS version, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY product, version ORDER BY n DESC').bind(since30),
    db.prepare('SELECT COALESCE(country, \'\') AS country, COUNT(*) AS n FROM installs WHERE last_seen >= ? GROUP BY country ORDER BY n DESC').bind(since30),
    db.prepare('SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?').bind(since7),
    db.prepare('SELECT COUNT(*) AS n FROM installs'),
    db.prepare('SELECT day, product, active FROM daily WHERE day >= ? ORDER BY day').bind(new Date((now - 365 * DAY) * 1000).toISOString().slice(0, 10)),
    db.prepare('SELECT country, region, COUNT(*) AS n FROM installs WHERE last_seen >= ? AND region IS NOT NULL GROUP BY country, region ORDER BY n DESC').bind(since30),
    db.prepare('SELECT country, region, city, AVG(lat) AS lat, AVG(lon) AS lon, COUNT(*) AS n FROM installs WHERE last_seen >= ? AND city IS NOT NULL AND lat IS NOT NULL GROUP BY country, region, city ORDER BY n DESC').bind(since30),
  ]);
  const products = {};
  for (const p of PRODUCTS) products[p] = 0;
  for (const r of byProduct.results) products[r.product] = r.n;
  const countries = {};
  let countryHidden = 0;
  for (const r of byCountry.results) {
    if (r.country) countries[r.country] = r.n; else countryHidden += r.n;
  }
  return {
    generatedAt: new Date(now * 1000).toISOString(),
    activeDays: ACTIVE_DAYS,
    active: Object.values(products).reduce((a, b) => a + b, 0),
    activeLast7Days: week.results[0].n,
    seenThisYear: ever.results[0].n,
    products,
    versions: byVersion.results,
    countries,
    countryHidden,
    regions: byRegion.results,
    towns: towns.results.map(t => ({ ...t, lat: Math.round(t.lat * 10) / 10, lon: Math.round(t.lon * 10) / 10 })),
    trend: trend.results,
  };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('showpilot-install:' + s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// ------------------------------------------------------------
// Stats page
// ------------------------------------------------------------
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShowPilot Installs</title>
<link rel="stylesheet" href="/assets/jsvectormap.min.css">
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6470;--line:#e3e6eb;--accent:#2563eb;--accent2:#d97706;--map-empty:#e6e9ee}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0f1115;--card:#171a21;--text:#e8eaef;--muted:#9aa2b1;--line:#2a2f3a;--accent:#60a5fa;--accent2:#fbbf24;--map-empty:#262b35}}
:root[data-theme="dark"]{--bg:#0f1115;--card:#171a21;--text:#e8eaef;--muted:#9aa2b1;--line:#2a2f3a;--accent:#60a5fa;--accent2:#fbbf24;--map-empty:#262b35}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 24px;font-size:.9rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.kpi .label{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.kpi .value{font-size:2rem;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.kpi .note{color:var(--muted);font-size:.8rem}
h2{font-size:1rem;margin:0 0 12px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
@media (max-width:720px){.two{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:.9rem}
td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-weight:500;font-size:.8rem}
td.n{text-align:right;font-variant-numeric:tabular-nums}
#map{height:420px;margin-bottom:8px}
@media (max-width:720px){#map{height:260px}}
.muted{color:var(--muted);font-size:.85rem}
.scroll{max-height:320px;overflow:auto}
svg text{fill:var(--muted);font-size:11px}
</style>
</head>
<body>
<main>
  <h1>ShowPilot installs</h1>
  <p class="sub" id="sub">Loading…</p>
  <div class="grid">
    <div class="card kpi"><div class="label">Running now</div><div class="value" id="kActive">–</div><div class="note">checked in within 30 days</div></div>
    <div class="card kpi"><div class="label">ShowPilot</div><div class="value" id="kMain">–</div><div class="note">full version</div></div>
    <div class="card kpi"><div class="label">ShowPilot-Lite</div><div class="value" id="kLite">–</div><div class="note">no audio</div></div>
    <div class="card kpi"><div class="label">Last 7 days</div><div class="value" id="k7">–</div><div class="note">checked in this week</div></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h2>Trend</h2>
    <div id="trend" class="muted">The trend fills in after the first daily snapshot.</div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h2>Where shows are</h2>
    <div id="map"></div>
    <p class="muted" id="countryNote"></p>
  </div>
  <div class="two">
    <div class="card"><h2>By country</h2><div class="scroll"><table id="tCountry"><thead><tr><th>Country</th><th style="text-align:right">Installs</th></tr></thead><tbody></tbody></table></div></div>
    <div class="card"><h2>By state / region</h2><div class="scroll"><table id="tRegion"><thead><tr><th>Region</th><th style="text-align:right">Installs</th></tr></thead><tbody></tbody></table></div></div>
    <div class="card"><h2>By town</h2><div class="scroll"><table id="tTown"><thead><tr><th>Town</th><th style="text-align:right">Installs</th></tr></thead><tbody></tbody></table></div></div>
    <div class="card"><h2>By version</h2><div class="scroll"><table id="tVersion"><thead><tr><th>Product</th><th>Version</th><th style="text-align:right">Installs</th></tr></thead><tbody></tbody></table></div></div>
  </div>
  <p class="muted">Installs send one anonymous check-in a day: a random ID, the product and its version. Location (country, state or town) is only counted for owners who turned it on, at the level they picked, and is approximate. No IP addresses, show names or URLs are kept.</p>
</main>
<script src="/assets/jsvectormap.min.js"></script>
<script src="/assets/world.js"></script>
<script>
(async function(){
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const names = (typeof Intl !== 'undefined' && Intl.DisplayNames) ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const cname = c => { try { return names ? names.of(c) : c; } catch { return c; } };
  const r = await fetch('/api/stats' + location.search);
  if (!r.ok) { document.getElementById('sub').textContent = 'Could not load stats.'; return; }
  const s = await r.json();
  document.getElementById('sub').textContent = 'Updated ' + new Date(s.generatedAt).toLocaleString() + ' · ' + s.seenThisYear + ' installs seen in the past year';
  document.getElementById('kActive').textContent = s.active;
  document.getElementById('kMain').textContent = s.products['showpilot'] || 0;
  document.getElementById('kLite').textContent = s.products['showpilot-lite'] || 0;
  document.getElementById('k7').textContent = s.activeLast7Days;

  const shared = Object.values(s.countries).reduce((a,b)=>a+b,0);
  document.getElementById('countryNote').textContent = shared + ' of ' + s.active + ' installs share their location' + (s.countryHidden ? ' (' + s.countryHidden + ' keep it private).' : '.') + (s.towns.length ? ' Dots are towns.' : '');
  const cb = document.querySelector('#tCountry tbody');
  const entries = Object.entries(s.countries).sort((a,b)=>b[1]-a[1]);
  cb.innerHTML = entries.length ? entries.map(([c,n]) => '<tr><td>' + esc(cname(c)) + '</td><td class="n">' + n + '</td></tr>').join('') : '<tr><td colspan="2" class="muted">No one has shared a country yet.</td></tr>';
  if (s.countryHidden) cb.innerHTML += '<tr><td class="muted">Not shared</td><td class="n muted">' + s.countryHidden + '</td></tr>';

  const rb = document.querySelector('#tRegion tbody');
  rb.innerHTML = s.regions.length ? s.regions.map(r => '<tr><td>' + esc(r.region) + ', ' + esc(r.country) + '</td><td class="n">' + r.n + '</td></tr>').join('') : '<tr><td colspan="2" class="muted">No one has shared a state yet.</td></tr>';
  const tb = document.querySelector('#tTown tbody');
  tb.innerHTML = s.towns.length ? s.towns.map(t => '<tr><td>' + esc(t.city) + (t.region ? ', ' + esc(t.region) : '') + ', ' + esc(t.country) + '</td><td class="n">' + t.n + '</td></tr>').join('') : '<tr><td colspan="2" class="muted">No one has shared a town yet.</td></tr>';

  const vb = document.querySelector('#tVersion tbody');
  vb.innerHTML = s.versions.length ? s.versions.map(v => '<tr><td>' + (v.product === 'showpilot-lite' ? 'Lite' : 'ShowPilot') + '</td><td>' + esc(v.version) + '</td><td class="n">' + v.n + '</td></tr>').join('') : '<tr><td colspan="3" class="muted">No installs yet.</td></tr>';

  try {
    const values = {}; for (const [c,n] of entries) values[c] = n;
    new jsVectorMap({
      selector: '#map', map: 'world', zoomButtons: true, zoomOnScroll: false,
      regionStyle: { initial: { fill: css('--map-empty'), stroke: css('--card'), strokeWidth: 0.4 }, hover: { fillOpacity: 0.8 } },
      // Light to dark blue by installs (square-root so small countries still show).
      // ZZ is not a real region: it pins the low end of the scale at 0.
      visualizeData: { scale: ['#bfdbfe', '#1d4ed8'], values: Object.assign({ ZZ: 0 }, Object.fromEntries(entries.map(([c, n]) => [c, Math.sqrt(n)]))) },
      markers: s.towns.map(t => ({ name: t.city + (t.region ? ', ' + t.region : '') + ' — ' + t.n + (t.n === 1 ? ' install' : ' installs'), coords: [t.lat, t.lon] })),
      markerStyle: { initial: { fill: css('--accent2'), stroke: css('--card'), strokeWidth: 1.5, r: 5 }, hover: { fill: css('--accent2'), stroke: css('--text') } },
      onRegionTooltipShow(e, tip, code) { tip.text(tip.text() + ' — ' + (values[code] || 0) + ((values[code] || 0) === 1 ? ' install' : ' installs')); },
    });
  } catch (e) { document.getElementById('map').textContent = 'Map could not load.'; }

  // Trend: one line per product, plain SVG.
  const days = [...new Set(s.trend.map(t => t.day))];
  if (days.length >= 2) {
    const W = 960, H = 160, P = 24, max = Math.max(1, ...s.trend.map(t => t.active));
    const x = i => P + i * (W - 2*P) / (days.length - 1), y = v => H - P - v * (H - 2*P) / max;
    const line = (prod, color) => {
      const pts = days.map((d,i) => { const t = s.trend.find(t => t.day === d && t.product === prod); return x(i) + ',' + y(t ? t.active : 0); }).join(' ');
      return '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts + '"/>';
    };
    document.getElementById('trend').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Active installs over time">'
      + '<line x1="' + P + '" y1="' + (H-P) + '" x2="' + (W-P) + '" y2="' + (H-P) + '" stroke="' + css('--line') + '"/>'
      + line('showpilot', css('--accent')) + line('showpilot-lite', css('--accent2'))
      + '<text x="' + P + '" y="' + (H-6) + '">' + days[0] + '</text><text x="' + (W-P) + '" y="' + (H-6) + '" text-anchor="end">' + days[days.length-1] + '</text>'
      + '<text x="' + P + '" y="14">max ' + max + '</text></svg>'
      + '<div class="muted"><span style="color:' + css('--accent') + '">■</span> ShowPilot &nbsp; <span style="color:' + css('--accent2') + '">■</span> Lite</div>';
  }
})();
</script>
</body>
</html>`;
