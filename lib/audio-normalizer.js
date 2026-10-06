// ============================================================
// ShowPilot — Audio Normalizer (tool)
// ============================================================
// Makes a show's songs equally loud by changing the files themselves,
// so the operator can put the fixed copies back on FPP. It is a stand-
// alone tool: it never touches the audio cache, the viewer audio stream
// or anything FPP is playing. Identical file in ShowPilot and Lite.
//
// Why loudness (LUFS) and not peak: most "normalize" tools make every
// file's loudest sample the same, or write a ReplayGain/MP3Gain tag that
// FPP ignores. Neither makes songs *sound* equally loud. This measures
// integrated loudness (ITU-R BS.1770 / EBU R128, via ffmpeg's loudnorm
// filter, which also measures true peak) and applies one fixed gain per
// song, so the mix and dynamics are untouched.
//
// Per song:
//   1. measure  — loudnorm in measure-only mode (input_i / input_tp …)
//   2. decide   — gain = target − measured. Skip if already within
//                 0.5 LU and under the ceiling. If the gain would push
//                 true peak over the ceiling: either catch just those
//                 peaks with a look-ahead limiter running at 4× the
//                 sample rate (so inter-sample peaks are caught too;
//                 allowLimiter) or raise only as far as the peaks allow
//                 (song ends up a little quieter). ffmpeg's loudnorm is
//                 used only to measure — its own dynamic mode made a
//                 quiet song with sharp peaks QUIETER in testing.
//   3. encode   — same container/codec family as the original, same
//                 sample rate and channel count (loudnorm works at
//                 192 kHz internally; resampling back matters because
//                 xLights sequences were timed against the original),
//                 tags and cover art kept. MP3 → LAME 320k.
//   4. verify   — measure the result again and compare DECODED lengths
//                 (not header estimates); a change over 50 ms is flagged. If MP3 encoding pushed
//                 the peak over the ceiling, redo it once with a lower
//                 limit; if a song somehow ended further from the
//                 target than it started, fall back to the safe gain.
//
// Work happens in os.tmpdir()/showpilot-normalize/<batch>/ and batches
// expire after 3 h idle. One song at a time across the whole server,
// single-threaded ffmpeg at the lowest CPU priority, so a running show
// is disturbed as little as possible.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const WORK_ROOT = path.join(os.tmpdir(), 'showpilot-normalize');
const BATCH_TTL_MS = 3 * 60 * 60 * 1000;
const SKIP_TOLERANCE_LU = 0.5;
const DURATION_WARN_SEC = 0.05;   // decoded length, 10 ms resolution
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_ITEMS_PER_BATCH = 300;

// Output encoding per extension. Same format as the original so the file
// keeps its name on FPP (sequences point at the media file by name).
const FORMATS = {
  '.mp3':  { codec: ['-c:a', 'libmp3lame', '-b:a', '320k'], encoder: 'libmp3lame', muxer: 'mp3', id3: true, art: true },
  '.m4a':  { codec: ['-c:a', 'aac', '-b:a', '256k'], encoder: 'aac', muxer: 'ipod', art: false },
  '.aac':  { codec: ['-c:a', 'aac', '-b:a', '256k'], encoder: 'aac', muxer: 'adts', art: false },
  '.wav':  { codec: ['-c:a', 'pcm_s16le'], encoder: 'pcm_s16le', muxer: 'wav', art: false },
  '.flac': { codec: ['-c:a', 'flac'], encoder: 'flac', muxer: 'flac', art: false },
  '.ogg':  { codec: ['-c:a', 'libvorbis', '-q:a', '8'], encoder: 'libvorbis', muxer: 'ogg', art: false },
};
const AUDIO_EXTS = Object.keys(FORMATS);

function extOf(name) { return path.extname(String(name || '')).toLowerCase(); }
function isAudioName(name) { return AUDIO_EXTS.includes(extOf(name)); }

// A name as FPP knows it: relative to the music folder, may contain
// sub-folders with "/", never "..", backslashes, NULs or a leading "/".
function safeMediaName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 255) return null;
  if (s.includes('\\') || s.includes('\0') || s.startsWith('/')) return null;
  if (s.split('/').some(p => p === '' || p === '.' || p === '..')) return null;
  if (/[\x00-\x1f]/.test(s)) return null;
  if (!isAudioName(s)) return null;
  return s;
}

// ------------------------------------------------------------
// Process helpers
// ------------------------------------------------------------
function run(cmd, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), notFound: true });
    }
    try { os.setPriority(child.pid, 19); } catch (_) { /* not permitted / not supported */ }
    let out = '', err = '';
    const cap = (s, add) => (s.length > 2e6 ? s : s + add);
    child.stdout.on('data', d => { out = cap(out, d.toString()); });
    child.stderr.on('data', d => { err = cap(err, d.toString()); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: err + String(e && e.message || e), notFound: e && e.code === 'ENOENT' });
    });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

let toolsCache = null;
let toolsCacheAt = 0;
async function checkTools() {
  if (toolsCache && Date.now() - toolsCacheAt < 60 * 1000) return toolsCache;
  const v = await run(FFMPEG, ['-hide_banner', '-version'], { timeoutMs: 15000 });
  const p = await run(FFPROBE, ['-hide_banner', '-version'], { timeoutMs: 15000 });
  const r = { ok: false, ffmpeg: v.code === 0, ffprobe: p.code === 0, version: null, loudnorm: false, alimiter: false, limiterLatency: false, encoders: {} };
  if (r.ffmpeg) {
    const m = /ffmpeg version (\S+)/.exec(v.stdout);
    r.version = m ? m[1] : 'unknown';
    const f = await run(FFMPEG, ['-hide_banner', '-filters'], { timeoutMs: 15000 });
    r.loudnorm = /\bloudnorm\b/.test(f.stdout);
    r.alimiter = /\balimiter\b/.test(f.stdout);
    if (r.alimiter) {
      const h = await run(FFMPEG, ['-hide_banner', '-h', 'filter=alimiter'], { timeoutMs: 15000 });
      r.limiterLatency = /\blatency\b/.test(h.stdout + h.stderr);   // ffmpeg 5+: compensate look-ahead delay
    }
    const e = await run(FFMPEG, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
    for (const ext of AUDIO_EXTS) {
      const enc = FORMATS[ext].encoder;
      r.encoders[ext] = new RegExp('\\s' + enc + '\\s').test(e.stdout);
    }
  }
  r.ok = r.ffmpeg && r.ffprobe && r.loudnorm && !!r.encoders['.mp3'];
  toolsCache = r;
  toolsCacheAt = Date.now();
  return r;
}

async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error('Could not read the file (' + lastLine(r.stderr) + ')');
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { throw new Error('Could not read the file'); }
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  if (!a) throw new Error('No audio in this file');
  const hasArt = (j.streams || []).some(s => s.codec_type === 'video');
  const dur = parseFloat(a.duration) || parseFloat(j.format && j.format.duration) || 0;
  return {
    codec: a.codec_name,
    sampleRate: parseInt(a.sample_rate, 10) || 44100,
    channels: parseInt(a.channels, 10) || 2,
    duration: dur,
    hasArt,
  };
}

function lastLine(s) {
  const lines = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return (lines[lines.length - 1] || 'unknown error').slice(0, 200);
}

// loudnorm prints a JSON block at the end of stderr.
function parseLoudnormJson(stderr) {
  const s = String(stderr || '');
  const end = s.lastIndexOf('}');
  const start = s.lastIndexOf('{', end);
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Also returns the decoded length as a sample count (astats, overall
// "Number of samples" = samples per channel). Header durations from
// ffprobe are estimates for VBR MP3s without a Xing/VBRI header
// ("Estimating duration from bitrate") and were off by seconds on real
// show files. Don't use ffmpeg's progress time= either: after loudnorm it
// stops short of the end (57.2 s reported for a 60.0 s file in testing).
async function measure(file) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-threads', '1', '-i', file,
    '-map', '0:a:0', '-af', 'astats,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ]);
  if (r.code !== 0) throw new Error('Measuring failed (' + lastLine(r.stderr) + ')');
  const j = parseLoudnormJson(r.stderr);
  if (!j) throw new Error('Measuring failed (no loudness data)');
  const m = { i: num(j.input_i), tp: num(j.input_tp), lra: num(j.input_lra), thresh: num(j.input_thresh), samples: decodedSamples(r.stderr) };
  if (m.i === null || m.tp === null) throw new Error('This file is silent or too short to measure');
  return m;
}

function decodedSamples(stderr) {
  const s = String(stderr || '');
  const at = s.lastIndexOf('Overall');
  const mm = /Number of samples:\s*(\d+)/.exec(at >= 0 ? s.slice(at) : s);
  return mm ? parseInt(mm[1], 10) : null;
}

const r1 = (n) => Math.round(n * 10) / 10;

// Decide what to do with a song. Returned gainDb is what was applied
// (for the limiter case, the intended gain; the limiter shapes peaks).
function plan(m, opts, tools) {
  const gain = opts.targetLufs - m.i;
  if (Math.abs(gain) <= SKIP_TOLERANCE_LU && m.tp <= opts.truePeak) {
    return { action: 'none', gainDb: 0 };
  }
  if (m.tp + gain <= opts.truePeak) {
    return { action: 'gain', gainDb: r1(gain) };
  }
  if (opts.allowLimiter && (!tools || tools.alimiter)) {
    return { action: 'limiter', gainDb: r1(gain), limitDb: opts.truePeak - 0.5 };
  }
  // Raise only as far as the peaks allow (may still be a cut if the
  // original already peaks over the ceiling).
  return { action: 'peak-limited', gainDb: r1(Math.min(gain, opts.truePeak - m.tp)) };
}

function filterFor(p, info, tools) {
  const vol = 'volume=' + p.gainDb.toFixed(2) + 'dB';
  if (p.action !== 'limiter') return vol;
  // Look-ahead limiter at 4x the sample rate so peaks between samples
  // (true peak) are caught, then back to the original rate. level=false:
  // no auto make-up gain. latency=1 (when supported) removes the
  // limiter's look-ahead delay so timing doesn't move.
  const lin = Math.min(1, Math.max(0.0625, Math.pow(10, p.limitDb / 20)));
  const over = info.sampleRate * 4;
  let lim = 'alimiter=limit=' + lin.toFixed(5) + ':attack=5:release=50:level=false';
  if (tools && tools.limiterLatency) lim += ':latency=true';
  return vol + ',aresample=' + over + ',' + lim + ',aresample=' + info.sampleRate;
}

async function encode(src, dst, ext, info, filter) {
  const fmt = FORMATS[ext];
  const base = ['-hide_banner', '-nostats', '-threads', '1', '-y', '-i', src];
  const tail = ['-af', filter, '-ar', String(info.sampleRate), '-ac', String(info.channels)]
    .concat(fmt.codec, ['-map_metadata', '0']);
  if (fmt.id3) tail.push('-id3v2_version', '3', '-write_xing', '1');
  tail.push('-f', fmt.muxer, dst);

  const withArt = fmt.art && info.hasArt;
  const maps = withArt
    ? ['-map', '0:a:0', '-map', '0:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic']
    : ['-map', '0:a:0'];
  let r = await run(FFMPEG, base.concat(maps, tail));
  if (r.code !== 0 && withArt) {
    // Odd cover art can upset the muxer; the audio matters, the art doesn't.
    r = await run(FFMPEG, base.concat(['-map', '0:a:0'], tail));
  }
  if (r.code !== 0) throw new Error('Encoding failed (' + lastLine(r.stderr) + ')');
}

// ------------------------------------------------------------
// CRC32 + minimal ZIP writer (stored, no compression — audio doesn't
// compress). Kept here to avoid a dependency.
// ------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Update(crc, buf) {
  let c = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function crc32File(file) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    fs.createReadStream(file)
      .on('data', b => { crc = crc32Update(crc, b); })
      .on('error', reject)
      .on('end', () => resolve(crc >>> 0));
  });
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name, file, size, crc }] → streams a zip to res.
async function streamZip(res, entries) {
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());
  const write = (buf) => new Promise((resolve) => {
    offset += buf.length;
    if (res.write(buf)) resolve(); else res.once('drain', resolve);
  });
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);           // UTF-8 names
    h.writeUInt16LE(0, 8);                // stored
    h.writeUInt16LE(now.time, 10);
    h.writeUInt16LE(now.date, 12);
    h.writeUInt32LE(e.crc >>> 0, 14);
    h.writeUInt32LE(e.size, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    const localOffset = offset;
    await write(h);
    await write(nameBuf);
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(e.file);
      rs.on('data', (chunk) => {
        offset += chunk.length;
        if (!res.write(chunk)) { rs.pause(); res.once('drain', () => rs.resume()); }
      });
      rs.on('error', reject);
      rs.on('end', resolve);
    });
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(now.time, 12);
    c.writeUInt16LE(now.date, 14);
    c.writeUInt32LE(e.crc >>> 0, 16);
    c.writeUInt32LE(e.size, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([c, nameBuf]));
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  res.end();
}

// ------------------------------------------------------------
// FPP file API (GET /api/files/music, GET/POST /api/file/Music/<name>)
// ------------------------------------------------------------
function fppPath(name) {
  return '/api/file/Music/' + String(name).split('/').map(encodeURIComponent).join('/');
}

function fppRequest(host, method, reqPath, { body, bodyFile, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const [hostname, port] = String(host).split(':');
    const headers = {};
    let size = 0;
    if (bodyFile) {
      size = fs.statSync(bodyFile).size;
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = size;
    }
    const req = http.request({ hostname, port: port ? parseInt(port, 10) : 80, method, path: reqPath, headers, timeout: timeoutMs }, (res) => resolve(res));
    req.on('timeout', () => req.destroy(new Error('FPP did not respond in time')));
    req.on('error', reject);
    if (bodyFile) fs.createReadStream(bodyFile).on('error', reject).pipe(req);
    else req.end(body);
  });
}

function readAll(res, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let s = '';
    res.on('data', d => { if (s.length < limit) s += d.toString(); });
    res.on('end', () => resolve(s));
    res.on('error', reject);
  });
}

async function listFppMusic(host) {
  const res = await fppRequest(host, 'GET', '/api/files/music', { timeoutMs: 20000 });
  const text = await readAll(res);
  if (res.statusCode === 401 || res.statusCode === 403) throw new Error('FPP refused the request (password protected?)');
  if (res.statusCode !== 200) throw new Error('FPP answered ' + res.statusCode);
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('Unexpected answer from FPP'); }
  const list = Array.isArray(j) ? j : (j.files || []);
  return list
    .map(f => (typeof f === 'string' ? { name: f, size: null } : { name: f.name, size: Number(f.sizeBytes) || null, dir: !!f.isDirectory }))
    .filter(f => f.name && !f.dir && isAudioName(f.name))
    .map(f => ({ name: f.name, size: f.size }));
}

async function downloadFromFpp(host, name, dest) {
  const res = await fppRequest(host, 'GET', fppPath(name));
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error('FPP answered ' + res.statusCode + ' for this file');
  }
  const ct = String(res.headers['content-type'] || '');
  if (/json|html/i.test(ct)) { res.resume(); throw new Error('FPP did not return audio for this file'); }
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    res.pipe(ws);
    res.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
  });
}

async function uploadToFpp(host, name, file) {
  if (name.includes('/')) throw new Error('This file is in a sub-folder on FPP — download it and upload it with FPP\'s File Manager');
  const res = await fppRequest(host, 'POST', fppPath(name), { bodyFile: file, timeoutMs: 300000 });
  const text = await readAll(res);
  if (res.statusCode === 401 || res.statusCode === 403) throw new Error('FPP refused the upload (password protected?)');
  if (res.statusCode !== 200) throw new Error('FPP answered ' + res.statusCode);
  let j = null;
  try { j = JSON.parse(text); } catch (_) { /* older FPP may not answer JSON */ }
  const size = fs.statSync(file).size;
  if (j && j.status && String(j.status).toUpperCase() !== 'OK') throw new Error('FPP: ' + j.status);
  if (j && j.written != null && Number(j.written) !== size) throw new Error('FPP stored ' + j.written + ' of ' + size + ' bytes');
}

// ------------------------------------------------------------
// Batches and the worker
// ------------------------------------------------------------
const batches = new Map();
const queue = [];        // [{ batchId, itemId }]
let working = null;      // { batchId, itemId }

function newId() { return crypto.randomBytes(8).toString('hex'); }

function cleanWorkRoot() {
  try { fs.rmSync(WORK_ROOT, { recursive: true, force: true }); } catch (_) {}
}

function touch(b) { b.touchedAt = Date.now(); }

function createBatch(opts) {
  const t = Number(opts.targetLufs);
  const p = Number(opts.truePeak);
  if (!Number.isFinite(t) || t < -30 || t > -5) throw new Error('Target loudness must be between -30 and -5 LUFS');
  if (!Number.isFinite(p) || p < -9 || p > 0) throw new Error('Peak ceiling must be between -9 and 0 dBTP');
  const id = newId();
  const dir = path.join(WORK_ROOT, id);
  fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const b = {
    id, dir,
    opts: { targetLufs: r1(t), truePeak: r1(p), allowLimiter: opts.allowLimiter !== false },
    items: [], createdAt: Date.now(), touchedAt: Date.now(),
  };
  batches.set(id, b);
  return b;
}

function getBatch(id) {
  const b = batches.get(String(id || ''));
  if (b) touch(b);
  return b || null;
}

function deleteBatch(id) {
  const b = batches.get(id);
  if (!b) return false;
  b.deleted = true;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].batchId === id) queue.splice(i, 1);
  batches.delete(id);
  // If the worker is on this batch, it notices b.deleted and the folder
  // removal below makes its next step fail harmlessly.
  try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch (_) {}
  return true;
}

function addItem(b, name, source) {
  if (b.items.length >= MAX_ITEMS_PER_BATCH) throw new Error('Too many songs in one batch');
  const ext = extOf(name);
  const item = {
    id: newId(), name, ext, source,
    status: source === 'fpp' ? 'queued' : 'uploading',
    inFile: path.join(b.dir, 'in', '__ID__' + ext),
    outFile: path.join(b.dir, 'out', '__ID__' + ext),
  };
  item.inFile = item.inFile.replace('__ID__', item.id);
  item.outFile = item.outFile.replace('__ID__', item.id);
  b.items.push(item);
  touch(b);
  return item;
}

function enqueue(b, item) {
  item.status = 'queued';
  queue.push({ batchId: b.id, itemId: item.id });
  setImmediate(pump);
}

async function pump() {
  if (working) return;
  const next = queue.shift();
  if (!next) return;
  const b = batches.get(next.batchId);
  const item = b && b.items.find(i => i.id === next.itemId);
  if (!b || !item) return setImmediate(pump);
  working = next;
  try {
    await processItem(b, item);
  } catch (e) {
    if (!b.deleted) { item.status = 'error'; item.error = String(e && e.message || e); }
  } finally {
    working = null;
    setImmediate(pump);
  }
}

async function processItem(b, item) {
  const tools = await checkTools();
  if (!tools.ok) throw new Error('ffmpeg with loudnorm and an MP3 encoder is required');
  if (!tools.encoders[item.ext]) throw new Error('This ffmpeg can\'t write ' + item.ext + ' files');

  if (item.source === 'fpp') {
    item.status = 'fetching';
    await downloadFromFpp(b.fppHost, item.name, item.inFile);
  }
  if (b.deleted) return;
  item.origSize = fs.statSync(item.inFile).size;

  item.status = 'measuring';
  const info = await probe(item.inFile);
  const m = await measure(item.inFile);
  item.durBefore = m.samples ? m.samples / info.sampleRate : info.duration;
  item.before = { i: r1(m.i), tp: r1(m.tp), lra: r1(m.lra || 0) };
  if (b.deleted) return;

  let p = plan(m, b.opts, tools);
  item.action = p.action;
  item.gainDb = p.gainDb;
  if (p.action === 'none') {
    item.status = 'skipped';
    return;
  }

  let after = null;
  let outInfo = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    item.status = 'encoding';
    await encode(item.inFile, item.outFile, item.ext, info, filterFor(p, info, tools));
    if (b.deleted) return;
    item.status = 'verifying';
    outInfo = await probe(item.outFile);
    after = await measure(item.outFile);
    if (b.deleted) return;
    const over = after.tp - b.opts.truePeak;
    const worse = Math.abs(b.opts.targetLufs - after.i) > Math.abs(b.opts.targetLufs - m.i) + 0.2;
    if (worse && p.action !== 'peak-limited') {
      // Never hand back a song further from the target than it started.
      p = { action: 'peak-limited', gainDb: r1(Math.min(b.opts.targetLufs - m.i, b.opts.truePeak - 0.5 - m.tp)) };
      continue;
    }
    // Limiting short peaks also lowers loudness a little (a lot, for
    // songs whose loudness comes mostly from big transients). Make up
    // the shortfall, but never push more than 6 dB past the plain gain.
    const short = b.opts.targetLufs - after.i;
    if (p.action === 'limiter' && short > 0.5 && attempt < 2 && over <= 0.1) {
      const base = r1(b.opts.targetLufs - m.i);
      const next = r1(Math.min(base + 6, p.gainDb + short));
      if (next > p.gainDb + 0.2) {
        p = Object.assign({}, p, { gainDb: next });
        continue;
      }
    }
    if (over > 0.1 && attempt < 2) {
      // Encoding overshoot: tighten and redo.
      if (p.action === 'limiter') p = Object.assign({}, p, { limitDb: p.limitDb - over - 0.2 });
      else if (b.opts.allowLimiter && tools.alimiter) p = { action: 'limiter', gainDb: p.gainDb, limitDb: b.opts.truePeak - 0.5 - over };
      else p = Object.assign({}, p, { gainDb: r1(p.gainDb - over - 0.2) });
      continue;
    }
    break;
  }
  item.action = p.action;
  item.gainDb = p.gainDb;
  item.durAfter = after.samples ? after.samples / outInfo.sampleRate : outInfo.duration;
  item.after = { i: r1(after.i), tp: r1(after.tp), lra: r1(after.lra || 0) };
  item.durationDelta = Math.round((item.durAfter - item.durBefore) * 1000) / 1000;
  item.durationWarning = Math.abs(item.durationDelta) > DURATION_WARN_SEC;
  item.size = fs.statSync(item.outFile).size;
  item.crc = await crc32File(item.outFile);
  item.status = 'done';
}

// Upload from the browser, streamed straight to disk (no buffering a
// whole WAV in memory on a Pi).
function receiveUpload(req, b, item) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const ws = fs.createWriteStream(item.inFile);
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        req.unpipe(ws);
        ws.destroy();
        reject(new Error('File is too large'));
        req.resume();
      }
    });
    req.pipe(ws);
    req.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => (bytes > 0 ? resolve(bytes) : reject(new Error('Empty file'))));
  });
}

function publicItem(i) {
  return {
    id: i.id, name: i.name, source: i.source, status: i.status, error: i.error || null,
    action: i.action || null, gainDb: i.gainDb == null ? null : i.gainDb,
    before: i.before || null, after: i.after || null,
    durBefore: i.durBefore == null ? null : Math.round(i.durBefore * 1000) / 1000,
    durAfter: i.durAfter == null ? null : Math.round(i.durAfter * 1000) / 1000,
    durationDelta: i.durationDelta == null ? null : i.durationDelta,
    durationWarning: !!i.durationWarning,
    size: i.size || null, origSize: i.origSize || null,
    sent: i.sent || null, sendError: i.sendError || null,
    canSend: !i.name.includes('/'),
  };
}

function publicBatch(b) {
  const pos = new Map(queue.map((q, idx) => [q.itemId, idx + 1]));
  return {
    id: b.id, opts: b.opts, fppHost: b.fppHost || null,
    items: b.items.map(i => Object.assign(publicItem(i), { queuePosition: pos.get(i.id) || null })),
  };
}

function sweep() {
  const now = Date.now();
  for (const b of batches.values()) {
    const busy = (working && working.batchId === b.id) || queue.some(q => q.batchId === b.id);
    if (!busy && now - b.touchedAt > BATCH_TTL_MS) deleteBatch(b.id);
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  cleanWorkRoot();               // leftovers from a previous run
  setInterval(sweep, 10 * 60 * 1000).unref();
}

function busyInfo() {
  return { running: !!working, queued: queue.length };
}

module.exports = {
  AUDIO_EXTS, FORMATS,
  checkTools, probe, measure, plan, filterFor, encode,
  isAudioName, safeMediaName, crc32Update, crc32File, streamZip,
  listFppMusic, downloadFromFpp, uploadToFpp,
  createBatch, getBatch, deleteBatch, addItem, enqueue, receiveUpload,
  publicBatch, busyInfo, start,
  _internal: { batches, queue },
};
