// ============================================================
// ShowPilot — Kokoro speech worker (Tools → Announcements)
// ============================================================
// Runs as its own short-lived process so the voice model (a few hundred
// MB of RAM) never lives inside the ShowPilot server, and a crash in the
// native engine can't take ShowPilot down with it.
//
// Input (stdin, JSON): { engineDir, model: { file, voices, tokens, dataDir,
//   lexicon, lang }, sid, speed, text, out, threads }
// Output: raw 32-bit float mono PCM written to `out`; one JSON line on
// stdout: { ok, sampleRate, samples, engine } or { ok:false, error }.
//
// Engine: sherpa-onnx (Apache-2.0). The native addon (sherpa-onnx-node)
// is tried first; where it can't load (e.g. Alpine/musl Docker images) the
// WebAssembly build (sherpa-onnx) is used instead — slower, same voices.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

function finish(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(code));
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let job;
  try { job = JSON.parse(input); } catch (e) { return finish({ ok: false, error: 'bad input' }, 1); }
  try {
    const nm = path.join(job.engineDir, 'node_modules');
    const m = job.model;
    let audio = null;
    let engine = null;
    let nativeErr = null;
    if (!process.env.SHOWPILOT_TTS_FORCE_WASM) {
      try {
        const s = require(path.join(nm, 'sherpa-onnx-node'));
        const tts = new s.OfflineTts({
          model: {
            kokoro: { model: m.file, voices: m.voices, tokens: m.tokens, dataDir: m.dataDir, lexicon: m.lexicon, lang: m.lang },
            numThreads: job.threads || 2, debug: 0, provider: 'cpu',
          },
          maxNumSentences: 1,
        });
        audio = tts.generate({ text: job.text, sid: job.sid, speed: job.speed || 1 });
        engine = 'native';
      } catch (e) { nativeErr = e; audio = null; }
    }
    if (!audio) {
      const s = require(path.join(nm, 'sherpa-onnx'));
      const tts = s.createOfflineTts({
        offlineTtsModelConfig: {
          offlineTtsKokoroModelConfig: { model: m.file, voices: m.voices, tokens: m.tokens, dataDir: m.dataDir, lexicon: m.lexicon, lang: m.lang, lengthScale: 1.0 },
          numThreads: 1, debug: 0, provider: 'cpu',
        },
        maxNumSentences: 1,
      });
      audio = tts.generate({ text: job.text, sid: job.sid, speed: job.speed || 1 });
      engine = nativeErr ? 'wasm (native unavailable: ' + String(nativeErr.message || nativeErr).slice(0, 120) + ')' : 'wasm';
    }
    const samples = audio.samples;
    if (!samples || !samples.length) return finish({ ok: false, error: 'The voice engine returned no audio' }, 1);
    fs.writeFileSync(job.out, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    finish({ ok: true, sampleRate: audio.sampleRate, samples: samples.length, engine }, 0);
  } catch (e) {
    finish({ ok: false, error: String(e && e.message || e).slice(0, 300) }, 1);
  }
});
