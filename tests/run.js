#!/usr/bin/env node
// ============================================================
// ShowPilot scenario tests
// ============================================================
//   npm test                      run every scenario
//   npm test -- listen            only scenarios whose file or title contains "listen"
//   npm test -- --steps           list every sentence scenarios can use
//
// Scenarios are plain-English files in tests/scenarios/*.feature (see
// tests/README.md). Each one runs against its own throwaway ShowPilot with a
// fake show player and, where a step needs it, headless phones/admin in
// Chromium. Results: tests/out/report.html (with a screenshot after every
// step that involves a page) and tests/out/results.json. Exit code 1 if
// anything failed.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { startShowPilot } = require('./lib/harness');
const { ShowPlayer } = require('./lib/showplayer');
const { STEPS } = require('./lib/steps');
const { writeReport, writeSummary } = require('./lib/report');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const args = process.argv.slice(2);

if (args.includes('--steps')) {
  for (const s of STEPS) console.log('  ' + s.doc);
  process.exit(0);
}
const filters = args.filter(a => !a.startsWith('--')).map(a => a.toLowerCase());

// ---- Parse .feature files ------------------------------------------------
// Feature: <title>          (optional)
// Scenario: <title>
//   Given / When / Then / And / But <sentence>
// Lines starting with # are comments.
function parse(file) {
  const out = [];
  let feature = path.basename(file, '.feature');
  let cur = null;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = /^Feature:\s*(.+)$/i.exec(line))) { feature = m[1]; return; }
    if ((m = /^Scenario:\s*(.+)$/i.exec(line))) { cur = { feature, title: m[1], file: path.relative(ROOT, file), line: i + 1, steps: [] }; out.push(cur); return; }
    if ((m = /^(Given|When|Then|And|But)\s+(.+)$/i.exec(line))) {
      if (!cur) throw new Error(`${file}:${i + 1}: step before any "Scenario:"`);
      cur.steps.push({ keyword: m[1], text: m[2], line: i + 1 });
      return;
    }
    throw new Error(`${file}:${i + 1}: can't read this line: ${line}`);
  });
  return out;
}

function findStep(text) {
  for (const s of STEPS) { const m = s.re.exec(text); if (m) return { step: s, args: m.slice(1) }; }
  return null;
}
// For "I don't know this sentence": the closest known ones by shared words.
function suggestions(text) {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) || []);
  return STEPS.map(s => ({ doc: s.doc, score: (s.doc.toLowerCase().match(/[a-z]+/g) || []).filter(w => words.has(w)).length }))
    .sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.doc);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function main() {
  const files = fs.readdirSync(path.join(ROOT, 'scenarios')).filter(f => f.endsWith('.feature')).sort().map(f => path.join(ROOT, 'scenarios', f));
  let scenarios = files.flatMap(parse);
  if (filters.length) scenarios = scenarios.filter(s => filters.some(f => (s.file + ' ' + s.title).toLowerCase().includes(f)));

  // Check every sentence is known before starting anything.
  const unknown = [];
  for (const sc of scenarios) for (const st of sc.steps) if (!findStep(st.text)) unknown.push({ sc, st });
  if (unknown.length) {
    for (const { sc, st } of unknown) {
      console.error(`\n✗ ${sc.file}:${st.line} — I don't know this sentence:\n    ${st.keyword} ${st.text}\n  Closest ones I know:`);
      for (const s of suggestions(st.text)) console.error('    ' + s);
    }
    process.exit(2);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let browser = null;
  const getBrowser = async () => {
    if (!browser) { const { chromium } = require('playwright'); browser = await chromium.launch(); }
    return browser;
  };

  const results = [];
  const t0 = Date.now();
  for (const sc of scenarios) {
    const started = Date.now();
    const dir = path.join(OUT, slug(sc.feature) + '--' + slug(sc.title));
    fs.mkdirSync(dir, { recursive: true });
    const res = { feature: sc.feature, title: sc.title, file: sc.file, line: sc.line, status: 'passed', steps: [], error: null, log: null };
    let sp;
    const ctx = { last: {}, phoneLoc: new Map(), pages: new Map(), pageErrors: [], bulk: 0, browser: getBrowser };
    try {
      sp = await startShowPilot();
      ctx.sp = sp;
      ctx.player = new ShowPlayer(sp);
      for (let i = 0; i < sc.steps.length; i++) {
        const st = sc.steps[i];
        const { step, args } = findStep(st.text);
        const r = { keyword: st.keyword, text: st.text, status: 'passed', shots: [] };
        res.steps.push(r);
        const ts = Date.now();
        try {
          await step.fn(ctx, ...args);
          if (ctx.pageErrors.length) throw new Error('script error on the page: ' + ctx.pageErrors.join(' | '));
        } catch (e) {
          r.status = 'failed';
          r.error = e.message;
          res.status = 'failed';
          res.error = `${st.keyword} ${st.text}\n${e.message}`;
        }
        r.ms = Date.now() - ts;
        // A screenshot of every page this step talked about (all pages on failure).
        const who = /phone (\w+)/i.exec(st.text);
        const targets = r.status === 'failed' ? [...ctx.pages.keys()]
          : who && ctx.pages.has('phone ' + who[1]) ? ['phone ' + who[1]]
          : /\badmin\b/i.test(st.text) && ctx.pages.has('admin') ? ['admin'] : [];
        for (const t of targets) {
          const file = `${String(i + 1).padStart(2, '0')}-${slug(t)}.png`;
          try {
            await Promise.race([ctx.pages.get(t).screenshot({ path: path.join(dir, file) }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
            r.shots.push({ who: t, file: path.relative(OUT, path.join(dir, file)) });
          } catch {}
        }
        if (r.status === 'failed') { for (const rest of sc.steps.slice(i + 1)) res.steps.push({ keyword: rest.keyword, text: rest.text, status: 'skipped', shots: [] }); break; }
      }
    } catch (e) {
      res.status = 'failed';
      res.error = res.error || e.message;
    }
    if (res.status === 'failed' && sp) res.log = sp.log();
    for (const p of ctx.pages.values()) { try { await Promise.race([p.context().close(), new Promise(r => setTimeout(r, 3000))]); } catch {} }
    if (sp) await sp.stop();
    res.ms = Date.now() - started;
    results.push(res);
    console.log(`${res.status === 'passed' ? '✓' : '✗'} ${sc.feature} › ${sc.title} (${(res.ms / 1000).toFixed(1)}s)`);
    if (res.status === 'failed') console.log('    ' + res.error.replace(/\n/g, '\n    '));
  }
  if (browser) await browser.close().catch(() => {});

  const failed = results.filter(r => r.status === 'failed').length;
  const summary = { total: results.length, passed: results.length - failed, failed, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ summary, results }, null, 2));
  writeReport(path.join(OUT, 'report.html'), summary, results);
  writeSummary(path.join(OUT, 'summary.md'), summary, results);
  console.log(`\n${summary.passed} passed, ${failed} failed in ${summary.seconds}s — report: ${path.relative(process.cwd(), path.join(OUT, 'report.html'))}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
