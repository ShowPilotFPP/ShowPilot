// ============================================================
// HTML report for a test run: one page, readable without knowing code.
// Failed scenarios are listed first and open; each step shows ✓ / ✗, the
// reason when it failed, and screenshots of the phone or admin it involved.
// ============================================================
'use strict';
const fs = require('fs');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function writeReport(file, summary, results) {
  // Screenshots are embedded, so the report is one file that opens anywhere
  // (downloaded from GitHub, sent in a chat, ...).
  const dir = require('path').dirname(file);
  const img = (rel) => { try { return 'data:image/png;base64,' + fs.readFileSync(require('path').join(dir, rel)).toString('base64'); } catch { return rel; } };
  const ordered = results.slice().sort((a, b) => (a.status === b.status ? 0 : a.status === 'failed' ? -1 : 1));
  const rows = ordered.map((r) => `
    <details class="sc ${r.status}" ${r.status === 'failed' ? 'open' : ''}>
      <summary><span class="dot"></span><b>${esc(r.title)}</b> <span class="muted">${esc(r.feature)} · ${(r.ms / 1000).toFixed(1)}s · ${esc(r.file)}:${r.line}</span></summary>
      <ol class="steps">${r.steps.map(s => `
        <li class="${s.status}"><span class="kw">${esc(s.keyword)}</span> ${esc(s.text)}
          ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
          ${s.shots && s.shots.length ? `<div class="shots">${s.shots.map(x => `<a href="${img(x.file)}" target="_blank" title="${esc(x.who)}"><img src="${img(x.file)}" alt="${esc(x.who)}" loading="lazy"><span>${esc(x.who)}</span></a>`).join('')}</div>` : ''}
        </li>`).join('')}
      </ol>
      ${r.log ? `<details class="log"><summary>Server log (last lines)</summary><pre>${esc(r.log)}</pre></details>` : ''}
    </details>`).join('');

  fs.writeFileSync(file, `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShowPilot test report</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --muted: #94a3b8; --ok: #22c55e; --bad: #ef4444; --skip: #64748b; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .muted { color: var(--muted); font-weight: normal; font-size: 13px; }
  .sum { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 18px; }
  .pill { padding: 6px 12px; border-radius: 999px; background: var(--card); font-weight: 600; }
  .pill.ok { color: var(--ok); } .pill.bad { color: var(--bad); }
  .sc { background: var(--card); border-radius: 10px; margin-bottom: 8px; padding: 8px 12px; }
  .sc > summary { cursor: pointer; list-style: none; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--ok); flex: none; }
  .sc.failed .dot { background: var(--bad); }
  .steps { margin: 8px 0 4px; padding-left: 22px; }
  .steps li { margin: 4px 0; }
  .steps li.passed::marker { color: var(--ok); } .steps li.failed::marker { color: var(--bad); }
  .steps li.failed { color: #fecaca; } .steps li.skipped { color: var(--skip); }
  .kw { color: var(--muted); font-weight: 600; }
  .err { margin: 4px 0; padding: 6px 8px; border-left: 3px solid var(--bad); background: rgba(239,68,68,0.1); white-space: pre-wrap; font-size: 13px; }
  .shots { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
  .shots a { display: flex; flex-direction: column; align-items: center; color: var(--muted); font-size: 12px; text-decoration: none; }
  .shots img { max-height: 180px; max-width: 260px; border-radius: 6px; border: 1px solid #334155; }
  .log pre { white-space: pre-wrap; font-size: 12px; background: #0b1220; padding: 8px; border-radius: 6px; max-height: 300px; overflow: auto; }
</style></head><body>
<h1>ShowPilot test report</h1>
<div class="muted">${esc(new Date(summary.at).toLocaleString())} · ${summary.seconds}s</div>
<div class="sum"><span class="pill ok">${summary.passed} passed</span>${summary.failed ? `<span class="pill bad">${summary.failed} failed</span>` : ''}<span class="pill">${summary.total} scenarios</span></div>
${rows}
</body></html>
`);
}

// Short Markdown version for the GitHub run page (job summary).
function writeSummary(file, summary, results) {
  const failed = results.filter(r => r.status === 'failed');
  const lines = [
    `### ${failed.length ? '❌' : '✅'} ShowPilot scenarios: ${summary.passed} passed${failed.length ? `, ${failed.length} failed` : ''} (${summary.seconds}s)`,
    '',
  ];
  for (const r of failed) {
    lines.push(`**✗ ${r.feature} › ${r.title}** (${r.file}:${r.line})`, '', '```', r.error, '```', '');
  }
  lines.push('<details><summary>All scenarios</summary>', '');
  for (const r of results) lines.push(`- ${r.status === 'passed' ? '✓' : '✗'} ${r.feature} › ${r.title}`);
  lines.push('', '</details>', '', 'Full report with screenshots: download the **scenario-report** artifact below and open `report.html`.');
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

module.exports = { writeReport, writeSummary };
