#!/usr/bin/env node
// ============================================================
// ShowPilot sync rig — compare an Android phone's browser player with a
// reference device (e.g. a Mac) across many fresh player sessions.
// ============================================================
// Debug tool for the maintainer; not part of the server.
//
// Each round:
//   1. Reloads the viewer page in Chrome on the phone (over adb + Chrome
//      remote debugging) and starts the player.
//   2. Waits for it to settle, then reads what the phone's player reported
//      (window.__spDiag: speaker delay, audio setup, last drift check).
//   3. Reads what Android's audio system says about the output Chrome is
//      using (dumpsys media.audio_flinger; raw copy saved per round).
//   4. Asks you whether it sounds in sync with the reference device (y/n),
//      or — with --mic and a reference computer that HAS a microphone —
//      measures it (window.__spCompare.run(), the "Compare devices" tool).
// One line per round on screen, plus a CSV and the raw dumps in ./sync-rig-out/.
//
// Setup (once):
//   - Phone: wireless debugging on and paired (`adb devices` lists it); Chrome
//     open on the viewer page with ?debug=1 (e.g. https://your-show/?debug=1).
//   - Reference device (e.g. the Mac) playing the same page normally, so you
//     can compare by ear.
//   - Only with --mic: the reference must be a separate Chrome with remote
//     debugging and a working microphone; open the page with ?debug=1, tap
//     Listen, press "🎤 Compare devices" once to grant the mic:
//       open -na "Google Chrome" --args --remote-debugging-port=9223 --user-data-dir=/tmp/sp-rig-chrome
//
// Run:
//   node sync-rig.mjs [--rounds 10] [--settle 14] [--measures 2]
//                     [--ref-port 9223] [--phone-port 9222] [--serial <adb serial>]
//                     [--no-reload]   (measure the current session only)
//                     [--no-audioflinger]
//                     [--mic]          (measure with the reference's microphone instead of asking)
//                     [--socket <name>] (a specific browser debugging socket; found automatically otherwise)
//                     [--url https://your-show/] (open the viewer page in Chrome on the phone first)
// Needs Node 22+ (built-in WebSocket and fetch) and adb on the PATH.
// ============================================================
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const ROUNDS = Number(opt('rounds', 10));
const SETTLE = Number(opt('settle', 14)) * 1000;
const MEASURES = Number(opt('measures', 2));
const REF_PORT = Number(opt('ref-port', 9223));
const PHONE_PORT = Number(opt('phone-port', 9222));
const SERIAL = opt('serial', null);
const SOCKET = opt('socket', null);
// --url https://your-show/ : open the viewer page (with ?debug=1) in Chrome
// on the phone ourselves, so it can't end up in the wrong tab or app.
let OPEN_URL = opt('url', null);
if (OPEN_URL && !/[?&]debug=1/.test(OPEN_URL)) OPEN_URL += (OPEN_URL.includes('?') ? '&' : '?') + 'debug=1';
const OUT = path.resolve('sync-rig-out');
const USE_MIC = flag('mic');
// Answers typed (or piped) one per line; queued so piped input works too.
const rl = USE_MIC ? null : readline.createInterface({ input: process.stdin });
const answers = []; let waiter = null;
if (rl) rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else answers.push(l); });
function ask(prompt) {
  process.stdout.write(prompt);
  if (answers.length) { const a = answers.shift(); process.stdout.write(a + '\n'); return Promise.resolve(a); }
  return new Promise(r => { waiter = r; });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const step = (msg) => console.log('· ' + msg);
function withTimeout(p, ms, what) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out after ' + Math.round(ms / 1000) + ' s')), ms); })]).finally(() => clearTimeout(t));
}

if (typeof WebSocket === 'undefined') { console.error('Needs Node 22 or newer (built-in WebSocket).'); process.exit(1); }

async function adb(...a) {
  const full = SERIAL ? ['-s', SERIAL, ...a] : a;
  const { stdout } = await run('adb', full, { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  return stdout;
}

// ---- Minimal Chrome DevTools Protocol client ----
async function cdpConnect(port, label) {
  let targets;
  // The list can come back empty for a moment (phone waking, tab loading):
  // ask a few times, via /json/list and /json.
  targets = [];
  let lastErr = null;
  for (let i = 0; i < 4 && !targets.some(t => t.type === 'page'); i++) {
    if (i) await sleep(1000);
    for (const p of ['/json/list', '/json']) {
      try {
        const got = await withTimeout(fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()), 9000, `${label}: asking for its pages`);
        if (Array.isArray(got) && got.length) { targets = got; break; }
      } catch (e) { lastErr = e; }
    }
  }
  if (!targets.length && lastErr) throw new Error(`${label}: no answer from browser debugging on port ${port} (${lastErr.message}). On the phone: keep the browser on screen and the phone unlocked.`);
  step(`${label}: Chrome lists ${targets.length} tab(s)`);
  // Only a viewer page opened with ?debug=1 (not /admin or other tabs).
  const page = targets.find(t => t.type === 'page' && /[?&]debug=1/.test(t.url) && !/\/admin\b/.test(t.url));
  if (!page) {
    const tabs = targets.filter(t => t.type === 'page').map(t => '    ' + t.url).join('\n') || '    (none)';
    throw new Error(`${label}: no viewer page with ?debug=1 is open in Chrome. Open your show's viewer page with ?debug=1 at the end (not /admin). Tabs found:\n${tabs}`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`${label}: could not attach to ${page.url}`)); }), 10000, `${label}: attaching to the page`);
  step(`${label}: attached to ${page.url}`);
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const send = (method, params = {}) => withTimeout(new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }), method === 'Runtime.evaluate' && params.awaitPromise ? 60000 : 15000, `${label}: ${method}`);
  const evaluate = async (expression, { awaitPromise = false, userGesture = false } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, userGesture, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  return { url: page.url, send, evaluate, close: () => ws.close() };
}

// ---- Android audio: the output Chrome plays through ----
function summarizeAudioFlinger(txt, chromeUids) {
  // Output threads, each with its type, latency and buffer sizes, and
  // whether a Chrome track is active on it. Formats differ by Android
  // version, so this is best-effort; the raw dump is saved too.
  const blocks = txt.split(/\n(?=Output thread )/).filter(b => b.startsWith('Output thread'));
  const out = [];
  for (const b of blocks) {
    const head = b.split('\n')[0];
    const type = (head.match(/type \d+ \(([A-Z_]+)\)/) || [])[1] || (head.match(/\(([A-Z_]+)\)/) || [])[1] || '?';
    const num = (re) => { const m = b.match(re); return m ? Number(m[1]) : null; };
    const hasChrome = chromeUids.some(u => new RegExp(`\\b${u}\\b`).test(b));
    out.push({
      type,
      chrome: hasChrome,
      latencyMs: num(/Latency:\s*(\d+(?:\.\d+)?)\s*ms/i) ?? num(/latency\s*(\d+)\s*ms/i),
      halFrames: num(/HAL frame count:\s*(\d+)/i),
      normalFrames: num(/Normal frame count:\s*(\d+)/i),
      sampleRate: num(/Sample rate:\s*(\d+)/i),
      fastTracks: num(/Fast tracks?:\s*(\d+)/i) ?? num(/Fast track availability:\s*(\d+)/i),
      activeTracks: num(/(\d+)\s+Tracks? of which (\d+) are active/i),
    });
  }
  return out;
}

async function chromeUids() {
  try {
    const out = await adb('shell', 'dumpsys', 'package', 'com.android.chrome');
    const m = out.match(/userId=(\d+)/);
    return m ? [m[1]] : [];
  } catch (_) { return []; }
}

// ---- One round ----
async function round(n, phone, ref, uids, csv) {
  const t0 = Date.now();
  let started = true;
  if (!flag('no-reload')) {
    await phone.send('Page.reload', { ignoreCache: false });
    await sleep(1500);
    // Wait for the page (up to 20 s), then tap Listen as a user gesture so
    // audio may start, then wait for the player's first start (up to 20 s).
    let tapped = false;
    for (let i = 0; i < 40 && !tapped; i++) {
      tapped = await phone.evaluate(`(() => { const b = document.getElementById('of-listen-btn'); if (!b || document.readyState !== 'complete') return false; b.click(); return true; })()`, { userGesture: true }).catch(() => false);
      if (!tapped) await sleep(500);
    }
    if (!tapped) throw new Error('the Listen button never appeared on the phone page');
    started = false;
    for (let i = 0; i < 40 && !started; i++) {
      await sleep(500);
      started = await phone.evaluate(`!!(window.__spDiag && window.__spDiag['start detail'])`).catch(() => false);
    }
    if (!started) console.log(`  round ${n}: the phone player didn't start within 20 s (is the show playing, and the page opened with ?debug=1?)`);
  }
  await sleep(SETTLE);
  const diag = await phone.evaluate(`JSON.stringify(window.__spDiag || {})`).then(JSON.parse).catch(() => ({}));
  let af = [], raw = '';
  if (!flag('no-audioflinger')) {
    try { raw = await adb('shell', 'dumpsys', 'media.audio_flinger'); af = summarizeAudioFlinger(raw, uids); } catch (e) { raw = 'dumpsys failed: ' + e.message; }
    fs.writeFileSync(path.join(OUT, `round-${String(n).padStart(2, '0')}-audioflinger.txt`), raw);
  }
  const measures = [];
  let ear = null;
  if (!USE_MIC) {
    const a = (await ask(`  round ${n}: does the phone sound in sync with the reference? [y = in sync / b = phone behind / a = phone ahead / s = skip] `)).trim().toLowerCase();
    ear = a.startsWith('y') ? 'in-sync' : a.startsWith('b') ? 'phone-behind' : a.startsWith('a') ? 'phone-ahead' : 'skip';
  }
  for (let i = 0; USE_MIC && i < MEASURES; i++) {
    const r = await ref.evaluate(`window.__spCompare ? window.__spCompare.run() : Promise.resolve({ ok: false, reason: 'Compare devices not available (open the page with ?debug=1)' })`, { awaitPromise: true })
      .catch(e => ({ ok: false, reason: e.message }));
    measures.push(r);
    if (i + 1 < MEASURES) await sleep(2000);
  }
  const okM = measures.filter(m => m && m.ok).map(m => m.otherBehindMs);
  const gap = okM.length ? Math.round(okM.reduce((a, b) => a + b, 0) / okM.length) : null;
  const setup = diag['audio setup'] || {};
  const start = diag['start detail'] || {};
  const drift = diag['drift check'] || {};
  const chromeOut = af.find(o => o.chrome) || null;
  const row = {
    round: n, time: new Date().toISOString().slice(11, 19),
    byEar: ear,
    phoneBehindMs: gap, measures: measures.map(m => m && m.ok ? m.otherBehindMs : 'x').join('/'),
    phoneSpeakerDelayMs: drift.speakerDelayMs ?? start.speakerDelayMs ?? null,
    phoneReportedMs: start.reportedLatencyMs ?? null,
    blockMs: setup.blockMs ?? null, blockMaxMs: setup.blockMaxMs ?? null,
    baseLatencyMs: setup.baseLatencyMs ?? null, outputLatencyMs: setup.outputLatencyMs ?? null,
    phoneDriftMs: drift.driftMs ?? null,
    afType: chromeOut ? chromeOut.type : af.map(o => o.type).join('+'),
    afLatencyMs: chromeOut ? chromeOut.latencyMs : null,
    afHalFrames: chromeOut ? chromeOut.halFrames : null,
    refSpeakerDelayMs: measures.find(m => m && m.thisSpeakerDelayMs != null)?.thisSpeakerDelayMs ?? null,
    secs: Math.round((Date.now() - t0) / 1000),
  };
  if (n === 1) fs.writeFileSync(csv, Object.keys(row).join(',') + '\n');
  fs.appendFileSync(csv, Object.values(row).map(v => v === null ? '' : String(v).includes(',') ? `"${v}"` : v).join(',') + '\n');
  fs.appendFileSync(path.join(OUT, 'rounds.jsonl'), JSON.stringify({ row, diag, measures, audioflinger: af }) + '\n');
  return row;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  step('checking adb…');
  const devices = await adb('devices').catch(e => { console.error('adb not found:', e.message); process.exit(1); });
  if (!/\tdevice\b/.test(devices)) { console.error('No phone in `adb devices` — pair wireless debugging first.'); process.exit(1); }
  const listed = devices.split('\n').filter(l => /\tdevice\b/.test(l)).map(l => l.split('\t')[0]);
  step(`phone(s): ${listed.join(', ')}`);
  if (listed.length > 1 && !SERIAL) { console.error('More than one device in `adb devices` — pick one with --serial <name>.'); process.exit(1); }
  // Every browser on the phone with remote debugging has its own socket:
  // chrome_devtools_remote (Chrome), Terrace/… (Samsung Internet),
  // webview_devtools_remote_<pid> (apps and web views), and others.
  // Try each until one has the viewer page open with ?debug=1.
  let sockets = [];
  try {
    const unix = await adb('shell', 'cat', '/proc/net/unix');
    sockets = [...new Set((unix.match(/@[\w.:-]*devtools_remote[\w.:-]*/g) || []).map(x => x.slice(1)))];
  } catch (_) {}
  if (SOCKET) sockets = [SOCKET];
  if (OPEN_URL) {
    // Open the page in Chrome on the phone (a new tab), then use Chrome.
    sockets = ['chrome_devtools_remote'];
    try { await adb('forward', '--remove', `tcp:${PHONE_PORT}`); } catch (_) {}
    await adb('forward', `tcp:${PHONE_PORT}`, 'localabstract:chrome_devtools_remote');
    step(`opening ${OPEN_URL} in Chrome on the phone…`);
    const r = await fetch(`http://127.0.0.1:${PHONE_PORT}/json/new?${encodeURI(OPEN_URL)}`, { method: 'PUT', signal: AbortSignal.timeout(10000) }).catch(e => ({ ok: false, statusText: e.message }));
    if (!r.ok) {
      // Older Chrome only accepts GET here.
      const g = await fetch(`http://127.0.0.1:${PHONE_PORT}/json/new?${encodeURI(OPEN_URL)}`, { signal: AbortSignal.timeout(10000) }).catch(e => ({ ok: false, statusText: e.message }));
      if (!g.ok) { console.error('Could not open a tab in Chrome on the phone (' + (g.statusText || r.statusText) + '). Open the page there yourself and run without --url.'); process.exit(1); }
    }
    await sleep(5000);
  }
  if (!sockets.length) sockets = ['chrome_devtools_remote'];
  step(`browser debugging sockets on the phone: ${sockets.join(', ')}`);
  let phone = null; const seen = [];
  for (const sock of sockets) {
    step(`linking port ${PHONE_PORT} to ${sock}…`);
    try { await adb('forward', '--remove', `tcp:${PHONE_PORT}`); } catch (_) {}
    await adb('forward', `tcp:${PHONE_PORT}`, 'localabstract:' + sock);
    try { phone = await cdpConnect(PHONE_PORT, 'phone'); step(`using ${sock}`); break; }
    catch (e) { seen.push(`  ${sock}: ${e.message.split('\n').slice(1).join(' ').trim() || e.message}`); }
  }
  if (!phone) {
    console.error('No browser on the phone has the viewer page open with ?debug=1.\n' + seen.join('\n') +
      '\nOpen the show\'s viewer page with ?debug=1 in a browser on the phone (Chrome works; Samsung Internet needs its own remote debugging turned on).');
    process.exit(1);
  }
  const ref = USE_MIC ? await cdpConnect(REF_PORT, 'reference') : null;
  await phone.send('Page.enable');
  step('reading Chrome\'s app id on the phone…');
  const uids = await chromeUids();
  console.log(`phone page:     ${phone.url}\nreference page: ${ref ? ref.url : '(by ear)'}\nChrome uid on phone: ${uids.join(',') || 'unknown'}\nwriting to ${OUT}\n`);
  const csv = path.join(OUT, 'rounds.csv');
  const cols = ['round', USE_MIC ? 'phoneBehindMs' : 'byEar', 'measures', 'phoneSpeakerDelayMs', 'blockMs', 'blockMaxMs', 'outputLatencyMs', 'afType', 'afLatencyMs', 'afHalFrames'];
  console.log(cols.join('\t'));
  for (let n = 1; n <= ROUNDS; n++) {
    try {
      const r = await round(n, phone, ref, uids, csv);
      console.log(cols.map(c => r[c] ?? '-').join('\t'));
    } catch (e) {
      console.log(`${n}\tround failed: ${e.message}`);
    }
  }
  phone.close(); if (ref) ref.close(); if (rl) rl.close();
  console.log(`\nDone. Send me ${path.join(OUT, 'rounds.csv')} (and rounds.jsonl / the audioflinger dumps if asked).`);
})().catch(e => { console.error(e.message); process.exit(1); });
