// ============================================================
// ShowPilot — Tools → Announcements routes (/api/admin/tools/announcer)
// ============================================================
// Admin-only (mounted behind requireAdmin in server.js). Long work runs as
// jobs: POST returns { job }, the page polls GET /jobs/:id. See
// lib/announcer.js and lib/tts-engines.js.
// ============================================================
'use strict';

const express = require('express');
const path = require('path');
const norm = require('../lib/audio-normalizer');
const tts = require('../lib/tts-engines');
const ann = require('../lib/announcer');
const config = require('../lib/config-loader');
const { getConfig, getNowPlaying } = require('../lib/db');

const router = express.Router();
const DEMO = !!config.demoMode;
ann.start();

router.use((req, res, next) => {
  if (DEMO && !(req.method === 'GET' && req.path === '/status')) {
    return res.status(403).json({ error: 'Announcements are turned off in the demo.' });
  }
  next();
});

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { if (!res.headersSent) fail(res, 400, e.message || String(e)); }
};

function fppHost() {
  const h = String((getConfig() || {}).plugin_fpp_host || '').trim();
  return (h && /^[A-Za-z0-9.\-:\[\]]+$/.test(h)) ? h : null;
}

router.get('/status', wrap(async (req, res) => {
  const tools = await norm.checkTools();
  let showActive = false;
  try { const np = getNowPlaying(); showActive = !!(np && np.sequence_name); } catch (_) {}
  res.json({
    demo: DEMO,
    ffmpegOk: !!tools.ok,
    kokoro: tts.kokoroStatus(),
    settings: tts.getSettings(),
    keys: tts.keyStatus(),
    catalog: {
      kokoroVoices: tts.kokoroVoices(),
      openaiVoices: tts.OPENAI_VOICES,
      openaiModels: tts.OPENAI_MODELS,
      elevenModels: tts.ELEVEN_MODELS,
    },
    fppHost: fppHost(),
    showActive,
    recent: ann.recentScripts(),
  });
}));

router.post('/settings', wrap(async (req, res) => { res.json({ settings: tts.saveSettings(req.body || {}) }); }));

router.post('/keys', wrap(async (req, res) => {
  const b = req.body || {};
  tts.setKey(String(b.provider || ''), b.key);
  res.json({ keys: tts.keyStatus() });
}));

router.post('/kokoro/install', wrap(async (req, res) => {
  await tts.installKokoro(String((req.body || {}).variant || 'best'));
  res.json({ kokoro: tts.kokoroStatus() });
}));
router.post('/kokoro/remove', wrap(async (req, res) => { tts.removeKokoro(); res.json({ kokoro: tts.kokoroStatus() }); }));
router.get('/kokoro/status', (req, res) => res.json({ kokoro: tts.kokoroStatus() }));

router.get('/elevenlabs/voices', wrap(async (req, res) => { res.json({ voices: await tts.elevenVoices() }); }));

router.post('/voices', wrap(async (req, res) => {
  const b = req.body || {};
  const engine = String(b.engine || '');
  const j = ann.generateVoice(engine, b.text, b.opts || {});
  res.json({ job: j.id });
}));

function uploadName(req) {
  const n = norm.safeMediaName(path.basename(String(req.query.name || '').replace(/\\/g, '/')));
  return n;
}

router.post('/voices/upload', wrap(async (req, res) => {
  const n = uploadName(req);
  if (!n) { req.resume(); return fail(res, 400, 'Unsupported file. Use MP3, M4A, AAC, WAV, FLAC or OGG.'); }
  const j = await ann.uploadVoice(req, n);
  res.json({ job: j.id });
}));

router.get('/voices/:id/audio', wrap(async (req, res) => {
  const f = await ann.voiceMp3(req.params.id);
  if (!f) return fail(res, 404, 'That voice has expired');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(f);
}));

router.get('/fpp-files', wrap(async (req, res) => {
  const host = fppHost();
  if (!host) return fail(res, 409, 'ShowPilot doesn\'t know your FPP address yet.');
  res.json({ files: await norm.listFppMusic(host) });
}));

router.post('/songs/fpp', wrap(async (req, res) => {
  const host = fppHost();
  if (!host) return fail(res, 409, 'ShowPilot doesn\'t know your FPP address yet.');
  const n = norm.safeMediaName((req.body || {}).name);
  if (!n) return fail(res, 400, 'Unsupported file name');
  res.json({ job: ann.songFromFpp(host, n).id });
}));

router.post('/songs/upload', wrap(async (req, res) => {
  const n = uploadName(req);
  if (!n) { req.resume(); return fail(res, 400, 'Unsupported file. Use MP3, M4A, AAC, WAV, FLAC or OGG.'); }
  const j = await ann.uploadSong(req, n);
  res.json({ job: j.id });
}));

router.post('/render/clip', wrap(async (req, res) => { res.json({ job: ann.renderClip(req.body || {}).id }); }));
router.post('/render/intro', wrap(async (req, res) => { res.json({ job: ann.renderIntro(req.body || {}).id }); }));

router.get('/jobs/:id', (req, res) => {
  const j = ann.getJob(req.params.id);
  if (!j) return fail(res, 404, 'Job not found (it may have expired)');
  res.json(j);
});

function attachmentName(name) {
  const base = path.basename(name);
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(base);
}

router.get('/outputs/:id', (req, res) => {
  const o = ann.getOutput(req.params.id);
  if (!o) return fail(res, 404, 'This file has expired — make it again');
  if (req.query.play === '1') {
    res.setHeader('Content-Type', o.ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream');
  } else {
    res.setHeader('Content-Disposition', attachmentName(o.name));
    res.setHeader('Content-Type', 'application/octet-stream');
  }
  res.sendFile(o.file);
});

router.post('/outputs/:id/send', wrap(async (req, res) => {
  const host = fppHost();
  if (!host) return fail(res, 409, 'ShowPilot doesn\'t know your FPP address yet.');
  res.json({ output: await ann.sendOutput(host, req.params.id, (req.body || {}).name) });
}));

router.post('/songs/:id/restore', wrap(async (req, res) => {
  const host = fppHost();
  if (!host) return fail(res, 409, 'ShowPilot doesn\'t know your FPP address yet.');
  await ann.restoreSong(host, req.params.id);
  res.json({ ok: true });
}));

router.post('/recent/forget', wrap(async (req, res) => { ann.forgetScript((req.body || {}).text); res.json({ recent: ann.recentScripts() }); }));

module.exports = router;
