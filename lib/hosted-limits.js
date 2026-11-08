// Plan limits a hosting service can change while the show runs (hosted
// installs only). The host points SHOWPILOT_HOSTED_FILE at a small JSON file:
//   { "audioLocked": false, "maxListeners": 50 }
// It's re-read at most every 2 s (and only when it changed), so a plan change
// applies within a couple of seconds, without restarting the show. Without
// the file, the environment variables are used (SHOWPILOT_AUDIO_LOCKED,
// SHOWPILOT_MAX_LISTENERS), as before. Self-hosted installs set neither.
'use strict';
const fs = require('fs');

const CHECK_MS = 2000;
let checkedAt = 0;
let mtime = 0;
let data = null;

function read() {
  const file = process.env.SHOWPILOT_HOSTED_FILE;
  if (!file) return null;
  const now = Date.now();
  if (now - checkedAt < CHECK_MS) return data;
  checkedAt = now;
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== mtime) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') { data = parsed; mtime = st.mtimeMs; }
    }
  } catch { /* missing or half-written: keep the last good values */ }
  return data;
}

function audioLocked() {
  const d = read();
  if (d && typeof d.audioLocked === 'boolean') return d.audioLocked;
  return process.env.SHOWPILOT_AUDIO_LOCKED === '1';
}

function maxListeners() {
  const d = read();
  const v = d && Number.isFinite(d.maxListeners) ? d.maxListeners : parseInt(process.env.SHOWPILOT_MAX_LISTENERS, 10);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

module.exports = { audioLocked, maxListeners };
