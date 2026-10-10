// ============================================================
// ShowPilot — Audio Normalizer routes  (/api/admin/tools/normalize)
// ============================================================
// Admin-only (mounted behind requireAdmin in server.js). See
// lib/audio-normalizer.js for how the tool works. Identical file in
// ShowPilot and Lite; the edition only changes the FPP host fallback
// (Lite runs on the FPP host itself) and a few hints in the UI.
// ============================================================

const express = require('express');
const path = require('path');
const norm = require('../lib/audio-normalizer');
const { getConfig, getNowPlaying } = require('../lib/db');
const config = require('../lib/config-loader');

const router = express.Router();
const EDITION = (() => {
  try { return require('../package.json').name === 'showpilot-lite' ? 'lite' : 'main'; } catch (_) { return 'main'; }
})();

norm.start();

// The public demo instance has no real FPP and must not fetch or write
// files for visitors: status works (so the page renders), the rest is off.
const DEMO = !!config.demoMode;
router.use((req, res, next) => {
  if (DEMO && !(req.method === 'GET' && req.path === '/status')) {
    return res.status(403).json({ error: 'The audio normalizer is turned off in the demo.' });
  }
  next();
});

function fppHost() {
  const cfg = getConfig() || {};
  const h = String(cfg.plugin_fpp_host || '').trim();
  if (h && /^[A-Za-z0-9.\-:\[\]]+$/.test(h)) return h;
  return EDITION === 'lite' ? '127.0.0.1' : null;
}

// Which show player ShowPilot is connected to. ShowPilot Player reports
// itself as "player-<version>" in its heartbeat; anything else is FPP with
// the ShowPilot plugin. Both answer the same FPP file API, so only the
// wording changes.
function target() {
  const v = String((getConfig() || {}).plugin_version || '');
  return /^player-/i.test(v)
    ? { kind: 'player', name: 'ShowPilot Player' }
    : { kind: 'fpp', name: 'FPP' };
}

function noHostMsg() {
  return target().kind === 'player'
    ? 'ShowPilot doesn\'t know your ShowPilot Player\'s address yet — turn on ShowPilot on the Player and press Test.'
    : 'ShowPilot doesn\'t know your FPP address yet — make sure the ShowPilot plugin has connected.';
}

function showActive() {
  try {
    const np = getNowPlaying();
    return !!(np && np.sequence_name);
  } catch (_) { return false; }
}

function installHint() {
  if (process.env.SHOWPILOT_DOCKER || require('fs').existsSync('/.dockerenv')) {
    return 'Update to the latest ShowPilot Docker image (it includes ffmpeg).';
  }
  if (process.platform === 'win32') return 'Install ffmpeg (for example: winget install ffmpeg) and restart ShowPilot.';
  if (process.platform === 'darwin') return 'Install ffmpeg (brew install ffmpeg) and restart ShowPilot.';
  return 'Install ffmpeg (sudo apt-get install -y ffmpeg) and restart ShowPilot.';
}

const fail = (res, code, msg) => res.status(code).json({ error: msg });

router.get('/status', async (req, res) => {
  const tools = await norm.checkTools();
  res.json({
    edition: EDITION,
    demo: DEMO,
    tools: Object.assign({}, tools, { hint: tools.ok ? null : installHint() }),
    fppHost: fppHost(),
    target: target().name,
    targetKind: target().kind,
    showActive: showActive(),
    busy: norm.busyInfo(),
  });
});

router.get('/fpp-files', async (req, res) => {
  const host = fppHost();
  if (!host) return fail(res, 409, noHostMsg());
  const who = target().name;
  try {
    res.json({ files: await norm.listFppMusic(host, who) });
  } catch (e) {
    fail(res, 502, 'Could not list ' + who + '\'s music folder: ' + (e.message || e));
  }
});

router.post('/batches', (req, res) => {
  const body = req.body || {};
  try {
    const b = norm.createBatch({
      targetLufs: body.targetLufs,
      truePeak: body.truePeak,
      allowLimiter: body.allowLimiter !== false,
    });
    b.fppHost = fppHost();
    b.targetName = target().name;
    res.json(norm.publicBatch(b));
  } catch (e) {
    fail(res, 400, e.message || String(e));
  }
});

router.get('/batches/:id', (req, res) => {
  const b = norm.getBatch(req.params.id);
  if (!b) return fail(res, 404, 'This batch has expired — start a new one.');
  res.json(norm.publicBatch(b));
});

router.delete('/batches/:id', (req, res) => {
  res.json({ ok: norm.deleteBatch(req.params.id) });
});

router.post('/batches/:id/fpp', (req, res) => {
  const b = norm.getBatch(req.params.id);
  if (!b) return fail(res, 404, 'This batch has expired — start a new one.');
  if (!b.fppHost) return fail(res, 409, noHostMsg());
  const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
  const added = [];
  const rejected = [];
  for (const raw of names) {
    const n = norm.safeMediaName(raw);
    if (!n) { rejected.push(String(raw)); continue; }
    try {
      const item = norm.addItem(b, n, 'fpp');
      norm.enqueue(b, item);
      added.push(item.id);
    } catch (e) {
      rejected.push(String(raw));
    }
  }
  res.json({ added: added.length, rejected, batch: norm.publicBatch(b) });
});

// Raw file body (any content type), streamed to disk. ?name=<file name>
router.post('/batches/:id/upload', async (req, res) => {
  const b = norm.getBatch(req.params.id);
  if (!b) { req.resume(); return fail(res, 404, 'This batch has expired — start a new one.'); }
  const n = norm.safeMediaName(path.basename(String(req.query.name || '').replace(/\\/g, '/')));
  if (!n) { req.resume(); return fail(res, 400, 'Unsupported file. Use MP3, M4A, AAC, WAV, FLAC or OGG.'); }
  let item;
  try { item = norm.addItem(b, n, 'upload'); } catch (e) { req.resume(); return fail(res, 400, e.message); }
  try {
    await norm.receiveUpload(req, b, item);
    norm.enqueue(b, item);
    res.json({ ok: true, itemId: item.id });
  } catch (e) {
    item.status = 'error';
    item.error = e.message || String(e);
    fail(res, 400, item.error);
  }
});

function findItem(req, res) {
  const b = norm.getBatch(req.params.id);
  if (!b) { fail(res, 404, 'This batch has expired — start a new one.'); return {}; }
  const item = b.items.find(i => i.id === req.params.itemId);
  if (!item) { fail(res, 404, 'Song not found in this batch'); return {}; }
  return { b, item };
}

function attachmentName(name) {
  const base = path.basename(name);
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(base);
}

router.get('/batches/:id/items/:itemId/file', (req, res) => {
  const { item } = findItem(req, res);
  if (!item) return;
  const original = req.query.original === '1';
  if (!original && item.status !== 'done') return fail(res, 409, 'This song has no normalized version');
  if (original && !item.origSize) return fail(res, 409, 'Original not available');
  res.setHeader('Content-Disposition', attachmentName(item.name));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(original ? item.inFile : item.outFile);
});

router.get('/batches/:id/zip', async (req, res) => {
  const b = norm.getBatch(req.params.id);
  if (!b) return fail(res, 404, 'This batch has expired — start a new one.');
  const original = req.query.original === '1';
  const picked = b.items.filter(i => (original ? (i.status === 'done' && i.origSize) : i.status === 'done'));
  if (!picked.length) return fail(res, 409, 'No files to download yet');
  try {
    const entries = [];
    for (const i of picked) {
      const file = original ? i.inFile : i.outFile;
      const size = original ? i.origSize : i.size;
      const crc = original ? (i.origCrc != null ? i.origCrc : (i.origCrc = await norm.crc32File(file))) : i.crc;
      entries.push({ name: i.name, file, size, crc });
    }
    const zipName = original ? 'original-audio.zip' : 'normalized-audio.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + zipName + '"');
    await norm.streamZip(res, entries);
  } catch (e) {
    if (!res.headersSent) fail(res, 500, e.message || String(e));
    else res.destroy();
  }
});

// Send the normalized (or, with {original:true}, the original) file back
// to the player's music folder (FPP or ShowPilot Player) under the same name.
router.post('/batches/:id/items/:itemId/send', async (req, res) => {
  const { b, item } = findItem(req, res);
  if (!item) return;
  if (!b.fppHost) return fail(res, 409, noHostMsg());
  const original = !!(req.body && req.body.original);
  if (!original && item.status !== 'done') return fail(res, 409, 'This song has no normalized version');
  if (original && !item.origSize) return fail(res, 409, 'Original not available');
  try {
    await norm.uploadToFpp(b.fppHost, item.name, original ? item.inFile : item.outFile, target().name);
    item.sent = original ? 'original' : 'normalized';
    item.sendError = null;
    res.json({ ok: true, item: norm.publicBatch(b).items.find(i => i.id === item.id) });
  } catch (e) {
    item.sendError = e.message || String(e);
    fail(res, 502, item.sendError);
  }
});

module.exports = router;
