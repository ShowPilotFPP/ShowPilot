// ============================================================
// Test harness: a throwaway ShowPilot for one scenario
// ============================================================
// Each scenario gets its own copy of the app in a temp folder (node_modules
// is linked, not copied), its own port, its own data/ (fresh database) and
// fixed secrets, so scenarios never share state and nothing touches a real
// install. Everything is deleted afterwards unless KEEP_TEST_DIRS=1.
// ============================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SHOW_TOKEN = 'test-show-token-0123456789abcdef';
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef';
const COOKIE = 'showpilot_session';

// Copied into each run. Everything else (git data, installed packages, real
// data, earlier test output) stays out.
const SKIP = new Set(['.git', 'node_modules', 'data', 'config.js', '.release.json']);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startShowPilot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
  const app = path.join(dir, 'app');
  fs.cpSync(REPO, app, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(REPO, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (SKIP.has(top)) return false;
      if (rel.startsWith(path.join('tests', 'out'))) return false;
      return true;
    },
  });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  const port = await freePort();
  fs.writeFileSync(path.join(app, 'config.js'),
    `const c = require('./config.example.js');\nmodule.exports = { ...c, port: ${port}, host: '127.0.0.1', trustProxy: false, demoMode: false };\n`);

  const logPath = path.join(dir, 'server.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: app,
    env: { ...process.env, SHOWPILOT_SHOW_TOKEN: SHOW_TOKEN, SHOWPILOT_JWT_SECRET: JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', log, log],
  });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(base + '/api/plugin/health', { headers: { authorization: 'Bearer ' + SHOW_TOKEN } }); if (r.status < 500) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  if (!ready) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error('ShowPilot did not start:\n' + tail(logPath));
  }

  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(app, 'data', 'showpilot.db'));
  db.pragma('busy_timeout = 5000');
  // The fresh install's admin must change the password on first sign-in;
  // tests sign in with a token instead, so skip that prompt.
  db.prepare('UPDATE users SET must_change_password = 0').run();
  const jwt = require(path.join(REPO, 'node_modules', 'jsonwebtoken'));
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const adminToken = jwt.sign({ userId: adminId }, JWT_SECRET);

  return {
    dir, app, port, base, db, logPath,
    showToken: SHOW_TOKEN,
    cookieName: COOKIE,
    adminToken,
    adminCookie: `${COOKIE}=${adminToken}`,
    viewerCookie: (phone) => `${COOKIE}_viewer=phone-${String(phone).replace(/[^\w-]/g, '_')}`,
    log: () => tail(logPath, 60),
    async stop() {
      try { db.close(); } catch {}
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise(r => { const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
      }
      try { fs.closeSync(log); } catch {}
      if (process.env.KEEP_TEST_DIRS !== '1') fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function tail(file, n = 40) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; }
}

module.exports = { startShowPilot, REPO };
