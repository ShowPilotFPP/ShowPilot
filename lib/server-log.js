// ============================================================
// Server log (v0.33.249+): keeps ShowPilot's own log so a show owner can
// download it from the admin (Settings → Debug → Server log) and send it
// with a problem report, whatever way ShowPilot runs (Docker, pm2, a
// service...).
//
// Everything written with console.log/info/warn/error still goes to the
// normal output, and is also:
//   - kept in memory (the last MEMORY_LINES lines), and
//   - appended to <data folder>/logs/showpilot.log, which rolls over to
//     showpilot.log.1 at MAX_FILE_BYTES (so at most about 2 x 5 MB on disk).
// Each line gets a timestamp and level. The show token, the JWT secret and
// any "Bearer ..." value are replaced with [hidden] before they're kept.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');

const MEMORY_LINES = 3000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let installed = false;
let dir = null;
let file = null;
let secrets = [];
const memory = [];
const startedAt = new Date();

function redact(s) {
  let out = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[hidden]');
  for (const v of secrets) if (v) out = out.split(v).join('[hidden]');
  return out;
}

function rollIfBig() {
  try {
    if (fs.statSync(file).size < MAX_FILE_BYTES) return;
    fs.renameSync(file, file + '.1');
  } catch (e) { /* no file yet */ }
}

function keep(level, args) {
  let text;
  try { text = util.format(...args); } catch (e) { text = String(args[0]); }
  const stamp = new Date().toISOString();
  const lines = redact(text).split('\n').map((l) => `${stamp} ${level.padEnd(5)} ${l}`);
  for (const l of lines) memory.push(l);
  if (memory.length > MEMORY_LINES) memory.splice(0, memory.length - MEMORY_LINES);
  if (!file) return;
  try {
    rollIfBig();
    fs.appendFileSync(file, lines.join('\n') + '\n');
  } catch (e) { /* disk full or read-only: the memory copy still works */ }
}

// dataDir: the folder holding ShowPilot's database. secretValues: strings
// that must never appear in the log.
function install(dataDir, secretValues = []) {
  if (installed) return;
  installed = true;
  secrets = secretValues.filter((v) => typeof v === 'string' && v.length >= 8);
  try {
    dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'showpilot.log');
  } catch (e) { file = null; }
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      keep(level, args);
    };
  }
  keep('INFO', ['[server-log] ShowPilot started; keeping its log for Settings → Debug → Server log']);
}

// The last n lines (newest last), optionally only those containing `filter`
// (case-insensitive).
function recent(n = 300, filter = '') {
  const f = String(filter || '').toLowerCase();
  const rows = f ? memory.filter((l) => l.toLowerCase().includes(f)) : memory;
  return rows.slice(-Math.max(1, Math.min(MEMORY_LINES, n)));
}

// The whole log on disk (previous file first), for download. Falls back to
// the memory copy when there is no file.
function fullText() {
  if (!file) return memory.join('\n') + '\n';
  let out = '';
  for (const f of [file + '.1', file]) {
    try { out += fs.readFileSync(f, 'utf8'); } catch (e) { /* missing */ }
  }
  return out || memory.join('\n') + '\n';
}

function info() {
  return { startedAt: startedAt.toISOString(), file: !!file };
}

module.exports = { install, recent, fullText, info, redact };
