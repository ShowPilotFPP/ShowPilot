// ============================================================
// mp3-tail.js — "the rest of the song from here" for MP3 files
// ============================================================
// A phone joining mid-song used to download and decode the whole file before
// any sound came out (5–10 s on cellular). With ?from=<sec> on
// /api/audio-stream the server sends only the part from just before that
// point, cut on an MP3 frame boundary, and says exactly where it starts
// (X-Audio-Start-Sec). Players put it at that position and start at once.
//
// Exactness: the slice is the file's own header (ID3v2 tag and the
// Xing/Info/LAME frame, if any) followed by audio frames K..end. Any decoder
// handles the start of the slice the same way it handles the start of the
// whole file (gapless trimming from the LAME tag, its own delay), so output
// sample n of the slice is output sample K*samplesPerFrame + n of the whole
// file: X-Audio-Start-Sec = K * samplesPerFrame / sampleRate, exactly. A few
// frames before the asked-for point are included so the bit reservoir (MP3
// frames borrowing bytes from earlier frames) is warm by then.
//
// Only Layer III (MP3). Anything else returns null and the caller sends the
// whole file as before.

'use strict';

const fs = require('fs');

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       // MPEG-2/2.5 Layer III
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const WARMUP_FRAMES = 3;
const CACHE_MAX = 24;
const cache = new Map(); // path -> { mtimeMs, size, index }

/** Parses the 4-byte frame header at buf[i]; null if it isn't a usable Layer III header. */
function parseHeader(buf, i) {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (buf[i + 1] >> 3) & 3;     // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (buf[i + 1] >> 1) & 3;   // 1 = Layer III
  if (ver === 1 || layer !== 1) return null;
  const brIdx = (buf[i + 2] >> 4) & 15;
  const srIdx = (buf[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null; // free format / bad
  const pad = (buf[i + 2] >> 1) & 1;
  const mono = ((buf[i + 3] >> 6) & 3) === 3;
  const mpeg1 = ver === 3;
  const bitrate = BITRATES[mpeg1 ? 1 : 2][brIdx] * 1000;
  const sampleRate = SAMPLE_RATES[ver][srIdx];
  const size = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + pad;
  return { ver, sampleRate, mono, mpeg1, size, spf: mpeg1 ? 1152 : 576 };
}

function id3v2Size(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) ? 10 : 0;
  return 10 + sz + footer;
}

/** True if the frame at [off] is a Xing/Info (LAME) or VBRI header frame, not audio. */
function isInfoFrame(buf, off, h) {
  const side = h.mpeg1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
  const tag = buf.toString('latin1', off + 4 + side, off + 8 + side);
  if (tag === 'Xing' || tag === 'Info') return true;
  return buf.toString('latin1', off + 36, off + 40) === 'VBRI';
}

/**
 * Indexes an MP3 file: where its audio frames start and the header bytes to
 * send in front of a slice. Returns null for anything that isn't a clean
 * Layer III stream (the caller then sends the whole file).
 */
function buildIndex(buf) {
  let pos = id3v2Size(buf);
  // Find the first frame: a valid header followed by another valid header
  // with the same version and sample rate (guards against false syncs).
  let first = null;
  const scanEnd = Math.min(buf.length - 4, pos + 64 * 1024);
  for (let i = pos; i < scanEnd; i++) {
    const h = parseHeader(buf, i);
    if (!h) continue;
    const n = parseHeader(buf, i + h.size);
    if (n && n.ver === h.ver && n.sampleRate === h.sampleRate) { first = { off: i, h }; break; }
  }
  if (!first) return null;
  const { sampleRate, spf, ver } = first.h;
  let off = first.off;
  let headerEnd = off; // bytes [0, headerEnd) go in front of every slice
  if (isInfoFrame(buf, off, first.h)) {
    off += first.h.size;
    headerEnd = off;
  }
  const offsets = [];
  while (off + 4 <= buf.length) {
    const h = parseHeader(buf, off);
    if (!h || h.ver !== ver || h.sampleRate !== sampleRate) {
      // Trailing tags (ID3v1 "TAG", APE) or junk: the audio ends here.
      break;
    }
    if (off + h.size > buf.length) { offsets.push(off); break; } // last, truncated frame
    offsets.push(off);
    off += h.size;
  }
  if (offsets.length < 10) return null;
  return { sampleRate, spf, headerEnd, offsets: Uint32Array.from(offsets), size: buf.length };
}

function getIndex(path) {
  let st;
  try { st = fs.statSync(path); } catch (_) { return null; }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    cache.delete(path); cache.set(path, hit); // most recent last
    return hit.index;
  }
  let index = null;
  try { index = buildIndex(fs.readFileSync(path)); } catch (_) { index = null; }
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, index });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return index;
}

/**
 * Where to cut [path] to cover song time [fromSec] onward.
 * Returns { startSec, headerEnd, sliceStart, size } or null (send the whole
 * file). startSec is the exact song time of the slice's first sample.
 */
function planTail(path, fromSec) {
  if (!(fromSec > 0)) return null;
  const idx = getIndex(path);
  if (!idx) return null;
  const k = Math.min(idx.offsets.length - 1, Math.floor((fromSec * idx.sampleRate) / idx.spf) - WARMUP_FRAMES);
  if (k <= 0) return null;
  return {
    startSec: (k * idx.spf) / idx.sampleRate,
    headerEnd: idx.headerEnd,
    sliceStart: idx.offsets[k],
    size: idx.size,
  };
}

/** Builds the slice bytes in memory (tests). The route streams it instead. */
function sliceBuffer(buf, plan) {
  return Buffer.concat([buf.subarray(0, plan.headerEnd), buf.subarray(plan.sliceStart)]);
}

module.exports = { planTail, buildIndex, sliceBuffer, _parseHeader: parseHeader };
