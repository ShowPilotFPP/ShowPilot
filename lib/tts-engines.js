// ============================================================
// ShowPilot — voices for Tools → Announcements
// ============================================================
// Three ways to get a voice, all ending as one WAV file:
//
//   kokoro      Free, runs on this server, no account. Kokoro-82M
//               (Apache-2.0) through sherpa-onnx (Apache-2.0). Nothing is
//               bundled: the admin clicks "Install free voices" and we
//               npm-install the engine into data/tts/engine (~60 MB) and
//               download the model from the sherpa-onnx GitHub release into
//               data/tts/models (Standard ~130 MB int8 / Best ~350 MB).
//               Speech runs in lib/kokoro-worker.js (separate process).
//   openai      Bring your own API key. /v1/audio/speech, gpt-4o-mini-tts
//               (style instructions) or tts-1-hd.
//   elevenlabs  Bring your own API key. /v1/text-to-speech/{voice_id}.
//
// Uploaded recordings skip this module entirely.
//
// Keys live in data/tts/keys.json (0600) — never in the database, so they
// are not in backups, and never sent back to the browser (only "set").
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const norm = require('./audio-normalizer');

const ENGINE_DEPS = {
  'sherpa-onnx-node': '1.13.8',
  'sherpa-onnx': '1.13.8',
  'tar': '7.4.3',
  'unbzip2-stream': '1.4.3',
};

const MODEL_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/';
const MODELS = {
  standard: { archive: 'kokoro-int8-multi-lang-v1_0', file: 'model.int8.onnx', sizeMb: 132, label: 'Standard (about 130 MB download)' },
  best:     { archive: 'kokoro-multi-lang-v1_0',      file: 'model.onnx',      sizeMb: 350, label: 'Best quality (about 350 MB download)' },
};

// Speaker ids come from the model's own metadata (speaker_names). English
// voices only; ★ = the ones that sound best for announcements.
const KOKORO_IDS = ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
const KOKORO_STAR = new Set(['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable']);
const KOKORO_GROUP = { af: 'American — female', am: 'American — male', bf: 'British — female', bm: 'British — male' };

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const OPENAI_MODELS = [
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (follows style instructions)' },
  { id: 'tts-1-hd', label: 'tts-1-hd' },
];
const ELEVEN_MODELS = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (natural, reliable)' },
  { id: 'eleven_v3', label: 'v3 (most expressive)' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (fastest, cheapest)' },
];

function kokoroVoices() {
  return KOKORO_IDS.map((id, sid) => ({
    id, sid,
    group: KOKORO_GROUP[id.slice(0, 2)],
    label: (KOKORO_STAR.has(id) ? '★ ' : '') + id.slice(3, 4).toUpperCase() + id.slice(4) +
      (id === 'am_santa' ? ' (Santa!)' : ''),
  }));
}

// ------------------------------------------------------------
// Paths and small JSON stores
// ------------------------------------------------------------
function dataDir() {
  const config = require('./config-loader');
  const dbPath = config.dbPath || './data/showpilot.db';
  const projectRoot = path.resolve(__dirname, '..');
  return path.isAbsolute(dbPath) ? path.dirname(dbPath) : path.resolve(projectRoot, path.dirname(dbPath));
}
function ttsDir() {
  const d = path.join(dataDir(), 'tts');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const engineDir = () => path.join(ttsDir(), 'engine');
const modelsDir = () => path.join(ttsDir(), 'models');

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return dflt; }
}
function writeJson(file, obj, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
  if (mode) { try { fs.chmodSync(file, mode); } catch (_) {} }
}

const keysFile = () => path.join(ttsDir(), 'keys.json');
function getKeys() { return readJson(keysFile(), {}); }
function setKey(provider, key) {
  if (!['openai', 'elevenlabs'].includes(provider)) throw new Error('Unknown provider');
  const k = getKeys();
  const v = String(key || '').trim();
  if (v) {
    if (v.length > 300 || /\s/.test(v)) throw new Error('That doesn\'t look like an API key');
    k[provider] = v;
  } else {
    delete k[provider];
  }
  writeJson(keysFile(), k, 0o600);
}
function keyStatus() {
  const k = getKeys();
  const tail = (v) => (v ? '…' + v.slice(-4) : null);
  return { openai: tail(k.openai), elevenlabs: tail(k.elevenlabs) };
}

const settingsFile = () => path.join(ttsDir(), 'settings.json');
const DEFAULT_SETTINGS = {
  engine: 'kokoro',
  kokoro: { voice: 'af_heart', speed: 1.0 },
  openai: { model: 'gpt-4o-mini-tts', voice: 'coral', speed: 1.0, instructions: 'Warm, upbeat holiday announcer. Clear and friendly.' },
  elevenlabs: { model: 'eleven_multilingual_v2', voice: '', voiceName: '' },
};
function getSettings() {
  const s = readJson(settingsFile(), {});
  return {
    engine: s.engine || DEFAULT_SETTINGS.engine,
    kokoro: Object.assign({}, DEFAULT_SETTINGS.kokoro, s.kokoro),
    openai: Object.assign({}, DEFAULT_SETTINGS.openai, s.openai),
    elevenlabs: Object.assign({}, DEFAULT_SETTINGS.elevenlabs, s.elevenlabs),
  };
}
function saveSettings(input) {
  const cur = getSettings();
  const out = JSON.parse(JSON.stringify(cur));
  if (input && ['kokoro', 'openai', 'elevenlabs'].includes(input.engine)) out.engine = input.engine;
  for (const k of ['kokoro', 'openai', 'elevenlabs']) {
    if (input && input[k] && typeof input[k] === 'object') Object.assign(out[k], cleanVoiceOpts(k, input[k]));
  }
  writeJson(settingsFile(), out);
  return out;
}
function cleanVoiceOpts(engine, o) {
  const r = {};
  const speed = Number(o.speed);
  if (Number.isFinite(speed)) r.speed = Math.min(1.5, Math.max(0.6, speed));
  if (engine === 'kokoro' && KOKORO_IDS.includes(o.voice)) r.voice = o.voice;
  if (engine === 'openai') {
    if (OPENAI_VOICES.includes(o.voice)) r.voice = o.voice;
    if (OPENAI_MODELS.some(m => m.id === o.model)) r.model = o.model;
    if (typeof o.instructions === 'string') r.instructions = o.instructions.slice(0, 500);
  }
  if (engine === 'elevenlabs') {
    if (typeof o.voice === 'string' && /^[A-Za-z0-9]{1,64}$/.test(o.voice)) r.voice = o.voice;
    if (typeof o.voiceName === 'string') r.voiceName = o.voiceName.slice(0, 100);
    if (ELEVEN_MODELS.some(m => m.id === o.model)) r.model = o.model;
  }
  return r;
}

// ------------------------------------------------------------
// Kokoro install (engine + model)
// ------------------------------------------------------------
const install = { running: false, stage: null, bytes: 0, total: 0, error: null, variant: null };

function installedModel() {
  const info = readJson(path.join(modelsDir(), 'installed.json'), null);
  if (!info || !MODELS[info.variant]) return null;
  const m = MODELS[info.variant];
  const dir = path.join(modelsDir(), m.archive);
  const need = [m.file, 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'espeak-ng-data'];
  if (!need.every(f => fs.existsSync(path.join(dir, f)))) return null;
  return { variant: info.variant, label: m.label, dir, file: path.join(dir, m.file) };
}
function engineInstalled() {
  const nm = path.join(engineDir(), 'node_modules');
  return ['sherpa-onnx', 'tar', 'unbzip2-stream'].every(p => fs.existsSync(path.join(nm, p, 'package.json')));
}

function kokoroStatus() {
  const model = installedModel();
  return {
    engineInstalled: engineInstalled(),
    model: model ? { variant: model.variant, label: model.label } : null,
    ready: engineInstalled() && !!model,
    install: Object.assign({}, install),
    variants: Object.keys(MODELS).map(k => ({ id: k, label: MODELS[k].label })),
  };
}

function npmCmd() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

function runNpmInstall(dir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'package.json'), { name: 'showpilot-tts-engine', private: true, dependencies: ENGINE_DEPS });
    const child = spawn(npmCmd(), ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
      env: Object.assign({}, process.env, { npm_config_update_notifier: 'false' }),
    });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', () => {});
    child.on('error', e => reject(new Error('npm is not available: ' + e.message)));
    child.on('close', code => (code === 0 ? resolve() : reject(new Error('Installing the voice engine failed: ' + norm.lastLine(err)))));
  });
}

function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ShowPilot' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed (' + res.statusCode + ')')); }
      resolve(res);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Download timed out')); });
  });
}

async function downloadModel(variant) {
  const m = MODELS[variant];
  const dest = modelsDir();
  fs.mkdirSync(dest, { recursive: true });
  // Remove any other variant first (keeps one model on disk).
  for (const k of Object.keys(MODELS)) {
    try { fs.rmSync(path.join(dest, MODELS[k].archive), { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(path.join(dest, 'installed.json'), { force: true }); } catch (_) {}
  const nm = path.join(engineDir(), 'node_modules');
  const tar = require(path.join(nm, 'tar'));
  const bz2 = require(path.join(nm, 'unbzip2-stream'));
  const res = await httpsGet(MODEL_RELEASE + m.archive + '.tar.bz2');
  install.total = parseInt(res.headers['content-length'], 10) || m.sizeMb * 1e6;
  install.bytes = 0;
  res.on('data', d => { install.bytes += d.length; });
  await new Promise((resolve, reject) => {
    const x = tar.x({ cwd: dest });
    res.on('error', reject);
    x.on('error', reject);
    x.on('finish', resolve);
    x.on('close', resolve);
    res.pipe(bz2()).on('error', reject).pipe(x);
  });
  writeJson(path.join(dest, 'installed.json'), { variant, installedAt: new Date().toISOString() });
  if (!installedModel()) throw new Error('The voice model download was incomplete — please try again');
}

async function installKokoro(variant) {
  if (install.running) throw new Error('Already installing');
  if (!MODELS[variant]) throw new Error('Unknown model choice');
  Object.assign(install, { running: true, stage: 'engine', bytes: 0, total: 0, error: null, variant });
  (async () => {
    try {
      if (!engineInstalled()) await runNpmInstall(engineDir());
      install.stage = 'model';
      if (!installedModel() || installedModel().variant !== variant) await downloadModel(variant);
      install.stage = 'done';
    } catch (e) {
      install.error = String(e && e.message || e);
      install.stage = 'error';
    } finally {
      install.running = false;
    }
  })();
}

function removeKokoro() {
  if (install.running) throw new Error('An install is running');
  fs.rmSync(engineDir(), { recursive: true, force: true });
  fs.rmSync(modelsDir(), { recursive: true, force: true });
  Object.assign(install, { stage: null, bytes: 0, total: 0, error: null, variant: null });
}

// ------------------------------------------------------------
// Synthesis → WAV (float, engine's own sample rate)
// ------------------------------------------------------------
async function toWav(src, dst, rawFmt) {
  const args = ['-hide_banner', '-nostats', '-y'];
  if (rawFmt) args.push('-f', 'f32le', '-ar', String(rawFmt.sampleRate), '-ac', '1');
  args.push('-i', src, '-map', '0:a:0', '-c:a', 'pcm_f32le', dst);
  const r = await norm.run(norm.FFMPEG, args, { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error('Could not read the voice audio (' + norm.lastLine(r.stderr) + ')');
}

function synthKokoro(text, o, outWav) {
  const model = installedModel();
  if (!engineInstalled() || !model) throw new Error('Install the free voices first');
  const voice = KOKORO_IDS.includes(o.voice) ? o.voice : 'af_heart';
  const british = voice.startsWith('b');
  const raw = outWav + '.f32';
  const job = {
    engineDir: engineDir(),
    model: {
      file: model.file, voices: path.join(model.dir, 'voices.bin'), tokens: path.join(model.dir, 'tokens.txt'),
      dataDir: path.join(model.dir, 'espeak-ng-data'),
      lexicon: path.join(model.dir, british ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt'),
      // sherpa-onnx's Kokoro has no 'en-gb' mode (it fails and the
      // engine crashes on exit): British voices use en-us with the British
      // lexicon, which carries the British pronunciations.
      lang: 'en-us',
    },
    sid: KOKORO_IDS.indexOf(voice),
    speed: Math.min(1.5, Math.max(0.6, Number(o.speed) || 1)),
    text, out: raw,
    threads: Math.max(1, Math.min(4, (os.cpus() || []).length - 1)),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'kokoro-worker.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, 10); } catch (_) {}
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 10 * 60 * 1000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { if (err.length < 20000) err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      let res = null;
      try { res = JSON.parse(out.trim().split('\n').pop()); } catch (_) {}
      if (!res || !res.ok) {
        return reject(new Error((res && res.error) || ('The voice engine stopped unexpectedly' + (err ? ' (' + norm.lastLine(err) + ')' : ''))));
      }
      try {
        await toWav(raw, outWav, { sampleRate: res.sampleRate });
        fs.rmSync(raw, { force: true });
        resolve({ engine: 'kokoro (' + res.engine + ')' });
      } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

async function apiError(res, who) {
  let msg = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      msg = (j.error && (j.error.message || j.error)) || (j.detail && (j.detail.message || j.detail.status || JSON.stringify(j.detail))) || t;
    } catch (_) { msg = t; }
  } catch (_) {}
  if (res.status === 401) return new Error(who + ' rejected the API key');
  return new Error(who + ' error ' + res.status + (msg ? ': ' + String(msg).slice(0, 200) : ''));
}

async function synthOpenAI(text, o, outWav) {
  const key = getKeys().openai;
  if (!key) throw new Error('Add your OpenAI API key first');
  const body = {
    model: OPENAI_MODELS.some(m => m.id === o.model) ? o.model : 'gpt-4o-mini-tts',
    voice: OPENAI_VOICES.includes(o.voice) ? o.voice : 'coral',
    input: text,
    response_format: 'wav',
  };
  if (body.model === 'gpt-4o-mini-tts' && o.instructions) body.instructions = String(o.instructions).slice(0, 500);
  const sp = Number(o.speed);
  if (Number.isFinite(sp) && Math.abs(sp - 1) > 0.01) body.speed = Math.min(1.5, Math.max(0.6, sp));
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, 'OpenAI');
  const tmp = outWav + '.src';
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  await toWav(tmp, outWav);
  fs.rmSync(tmp, { force: true });
  return { engine: 'openai ' + body.model + ' / ' + body.voice };
}

async function elevenVoices() {
  const key = getKeys().elevenlabs;
  if (!key) throw new Error('Add your ElevenLabs API key first');
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  if (!res.ok) throw await apiError(res, 'ElevenLabs');
  const j = await res.json();
  return (j.voices || []).map(v => ({
    id: v.voice_id, name: v.name, category: v.category || '',
    description: [v.labels && v.labels.accent, v.labels && v.labels.gender, v.labels && (v.labels.description || v.labels.use_case)].filter(Boolean).join(', '),
  })).filter(v => /^[A-Za-z0-9]{1,64}$/.test(v.id));
}

async function synthEleven(text, o, outWav) {
  const key = getKeys().elevenlabs;
  if (!key) throw new Error('Add your ElevenLabs API key first');
  if (!o.voice || !/^[A-Za-z0-9]{1,64}$/.test(o.voice)) throw new Error('Pick an ElevenLabs voice first');
  const model = ELEVEN_MODELS.some(m => m.id === o.model) ? o.model : 'eleven_multilingual_v2';
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + o.voice + '?output_format=mp3_44100_192', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw await apiError(res, 'ElevenLabs');
  const tmp = outWav + '.src';
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  await toWav(tmp, outWav);
  fs.rmSync(tmp, { force: true });
  return { engine: 'elevenlabs ' + model + ' / ' + (o.voiceName || o.voice) };
}

async function synthesize(engine, text, opts, outWav) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Type what the voice should say');
  if (t.length > 2000) throw new Error('Keep announcements under 2,000 characters');
  if (engine === 'kokoro') return synthKokoro(t, opts || {}, outWav);
  if (engine === 'openai') return synthOpenAI(t, opts || {}, outWav);
  if (engine === 'elevenlabs') return synthEleven(t, opts || {}, outWav);
  throw new Error('Unknown voice engine');
}

module.exports = {
  MODELS, OPENAI_VOICES, OPENAI_MODELS, ELEVEN_MODELS,
  kokoroVoices, kokoroStatus, installKokoro, removeKokoro,
  getSettings, saveSettings, setKey, keyStatus, elevenVoices,
  synthesize, toWav, ttsDir,
};
