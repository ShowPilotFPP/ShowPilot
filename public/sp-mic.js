// ShowPilot microphone sync measurement — core math (v0.33.218+, debug).
//
// Loaded only when Settings → Debug → "Microphone sync measurement" is on
// (viewer-renderer adds the script tag). The player (rf-compat.js) records
// the microphone and calls SPMicCore.analyze(); everything here is pure math
// so it can be tested without a browser.
//
// Method: GCC-PHAT (generalized cross-correlation with phase transform)
// between the microphone recording and the song's own decoded audio. PHAT
// whitens the spectrum, so each copy of the song the microphone hears shows
// up as a sharp peak at its time offset, even with echoes and noise.
//
// Two captures:
//   A — phone playing: the mic hears the phone AND the show speakers → peaks
//   B — phone muted:   the mic hears only the show speakers → identifies
//                      which of A's peaks is the speakers
// Result = phone peak − speaker peak (content position, ms). Both copies go
// through the same mic at the same moment, so the unknown mic input delay and
// phone output delay cancel out: the number is exactly what a listener next
// to the speakers hears. Positive = the phone plays AHEAD of the speakers
// (raise the show offset by that much).
(function (root) {
  'use strict';

  // In-place iterative radix-2 complex FFT. inverse=true → unscaled inverse.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  // Cross-correlation c[k] = Σ mic[n]·ref[n+k] (PHAT-weighted, band-limited),
  // for k = 0 .. ref.length − mic.length. The peak k is where the mic's
  // content starts inside ref.
  function gccPhat(mic, ref, sampleRate, band) {
    const L = nextPow2(mic.length + ref.length);
    const mr = new Float64Array(L), mi = new Float64Array(L);
    const rr = new Float64Array(L), ri = new Float64Array(L);
    for (let i = 0; i < mic.length; i++) mr[i] = mic[i];
    for (let i = 0; i < ref.length; i++) rr[i] = ref[i];
    fft(mr, mi, false);
    fft(rr, ri, false);
    const lo = Math.floor(((band && band[0]) || 150) * L / sampleRate);
    const hi = Math.ceil(((band && band[1]) || 6000) * L / sampleRate);
    for (let i = 0; i < L; i++) {
      const f = i <= L / 2 ? i : L - i;
      if (f < lo || f > hi) { mr[i] = 0; mi[i] = 0; continue; }
      // conj(M) · R
      const pr = mr[i] * rr[i] + mi[i] * ri[i];
      const pi = mr[i] * ri[i] - mi[i] * rr[i];
      const mag = Math.hypot(pr, pi) + 1e-12;
      mr[i] = pr / mag; mi[i] = pi / mag;
    }
    fft(mr, mi, true);
    const valid = ref.length - mic.length + 1;
    const out = new Float64Array(Math.max(0, valid));
    for (let k = 0; k < out.length; k++) out[k] = mr[k] / L;
    return out;
  }

  // Top peaks at least minSep samples apart, strongest first.
  function findPeaks(corr, minSep, count) {
    const idx = [];
    for (let k = 1; k < corr.length - 1; k++) {
      if (corr[k] > 0 && corr[k] >= corr[k - 1] && corr[k] >= corr[k + 1]) idx.push(k);
    }
    idx.sort((a, b) => corr[b] - corr[a]);
    const picked = [];
    for (const k of idx) {
      if (picked.every(p => Math.abs(p - k) >= minSep)) picked.push(k);
      if (picked.length >= count) break;
    }
    // Sub-sample refinement (parabolic) for each picked peak.
    return picked.map(k => {
      const a = corr[k - 1], b = corr[k], c = corr[k + 1];
      const d = a - 2 * b + c;
      const off = d !== 0 ? 0.5 * (a - c) / d : 0;
      return { k: k + Math.max(-0.5, Math.min(0.5, off)), v: b };
    });
  }

  // Peak strength relative to the correlation's typical level.
  function peakRatio(corr, v) {
    const s = Array.from(corr, x => Math.abs(x)).sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)] || 1e-12;
    return v / median;
  }

  // One capture → peaks as content position relative to the expected
  // (rendered) position at the capture start, in seconds.
  function peaksFor(cap, sampleRate) {
    const corr = gccPhat(cap.mic, cap.ref, sampleRate);
    const peaks = findPeaks(corr, Math.round(0.006 * sampleRate), 8);
    return peaks.map(p => ({
      rel: cap.refStartSec + p.k / sampleRate - cap.expectedPosSec,
      strength: peakRatio(corr, p.v),
    }));
  }

  // a = capture with the phone playing, b = capture with the phone muted.
  // Each: { mic: Float32Array, ref: Float32Array, refStartSec, expectedPosSec }.
  // Real peaks score in the hundreds against the correlation's typical
  // level; background noise alone scores single digits.
  const MIN_SPEAKER = 20, MIN_PHONE = 15, SAME_PEAK_SEC = 0.003;
  // Music repeats (beats, bars), which leaves faint 'ghost' matches far
  // away. The phone is next to the mic, so its peak is strong and close to
  // the speakers': ignore anything beyond MAX_GAP_SEC or under
  // MIN_PHONE_SHARE of the strongest peak.
  const MAX_GAP_SEC = 0.5, MIN_PHONE_SHARE = 0.25;
  function analyze(a, b, sampleRate) {
    const pb = peaksFor(b, sampleRate);
    const pa = peaksFor(a, sampleRate);
    if (!pb.length || pb[0].strength < MIN_SPEAKER) {
      return { ok: false, reason: 'could not hear the show speakers clearly (move closer, turn them up, or reduce background noise)', pa, pb };
    }
    const speakerPeaks = pb.filter(p => p.strength >= MIN_SPEAKER / 2);
    const speakerRel = pb[0].rel;
    // Capture B holds the speakers' direct sound AND their room echoes. Any
    // peak in A that also appears in B is the speakers' signature; the phone
    // is the strongest peak that exists only in A.
    const inB = (p) => speakerPeaks.some(q => Math.abs(q.rel - p.rel) <= SAME_PEAK_SEC);
    const speakerInA = pa.find(p => Math.abs(p.rel - speakerRel) <= SAME_PEAK_SEC);
    if (!speakerInA) {
      return { ok: false, reason: 'the two captures disagree (was the song, the volume or your position changing?)', pa, pb };
    }
    const strongest = Math.max(...pa.map(p => p.strength));
    const phone = pa.filter(p => !inB(p) && p.strength >= MIN_PHONE &&
        p.strength >= MIN_PHONE_SHARE * strongest &&
        Math.abs(p.rel - speakerInA.rel) <= MAX_GAP_SEC)
      .sort((x, y) => y.strength - x.strength)[0];
    if (!phone) {
      // No phone-only peak: the phone and the speakers land together.
      return { ok: true, deltaMs: 0, merged: true, speakerStrength: pb[0].strength, pa, pb };
    }
    return {
      ok: true,
      deltaMs: Math.round((phone.rel - speakerInA.rel) * 1000),
      speakerStrength: pb[0].strength,
      phoneStrength: phone.strength,
      pa, pb,
    };
  }

  root.SPMicCore = { fft, gccPhat, findPeaks, analyze, nextPow2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SPMicCore;
})(typeof window !== 'undefined' ? window : globalThis);
