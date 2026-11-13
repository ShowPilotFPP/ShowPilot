// ============================================================
// Directory admin sign-in
// ============================================================
// Username + password for /admin. Users live in the counter's database
// (admin_users) and are added on the server with `node admin-user.js add
// <name>`; there is no sign-up page. Passwords are scrypt hashes.
//
// Signing in sets an HttpOnly, Secure, SameSite=Strict session cookie (14
// days). Sessions are stored as hashes of their tokens, so a copy of the
// database can't be used to sign in. Admin requests that change something
// must also carry X-Requested-With (a page on another site can't add it
// without a CORS preflight, which we never answer).
//
// Wrong passwords: 5 per username in 15 minutes locks that username; 30
// overall in 15 minutes locks sign-in for everyone (we never look at IPs).
// ============================================================
'use strict';
const crypto = require('crypto');
const express = require('express');

const COOKIE = 'sp_dir_admin';
const SESSION_S = 14 * 24 * 3600;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILS_PER_USER = 5;
const FAILS_TOTAL = 30;
const MIN_PASSWORD = 10;
const USER_RE = /^[A-Za-z0-9._@-]{2,40}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}

function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const want = Buffer.from(parts[2], 'base64');
  const got = crypto.scryptSync(String(password), salt, want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}

const tokenHash = (t) => crypto.createHash('sha256').update('sp-dir-admin:' + t).digest('hex');

function readCookie(req, name) {
  const all = req.get('cookie') || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function initTables(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    username   TEXT PRIMARY KEY COLLATE NOCASE,
    pass_hash  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `);
}

// Used by admin-user.js (command line) as well as the page.
function setPassword(db, username, password) {
  if (!USER_RE.test(username)) throw new Error('Usernames are 2–40 letters, numbers, . _ @ or -.');
  if (String(password).length < MIN_PASSWORD) throw new Error('Passwords need at least ' + MIN_PASSWORD + ' characters.');
  initTables(db);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO admin_users (username, pass_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET pass_hash = excluded.pass_hash`).run(username, hashPassword(password), now);
  // A new password signs that user out everywhere.
  db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(username);
}

function createAdminAuth(db) {
  initTables(db);
  const dummyHash = hashPassword(crypto.randomBytes(12).toString('hex'));
  const userFails = new Map();
  let allFails = [];

  const recent = (list, now) => list.filter(t => now - t < FAIL_WINDOW_MS);
  const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n > 0;

  function currentUser(req) {
    const t = readCookie(req, COOKIE);
    if (!t || t.length > 200) return null;
    const now = Math.floor(Date.now() / 1000);
    const s = db.prepare('SELECT username, expires_at FROM admin_sessions WHERE token_hash = ?').get(tokenHash(t));
    if (!s || s.expires_at < now) return null;
    const u = db.prepare('SELECT username FROM admin_users WHERE username = ?').get(s.username);
    return u ? u.username : null;
  }

  function setCookie(res, value, maxAge) {
    res.set('Set-Cookie', COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge);
  }

  const router = express.Router();
  const json = express.json({ limit: '2kb' });
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.post('/login', json, (req, res) => {
    if (!hasUsers()) return res.status(404).json({ error: 'No admin users yet.' });
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    const now = Date.now();
    allFails = recent(allFails, now);
    const key = username.toLowerCase();
    const mine = recent(userFails.get(key) || [], now);
    if (allFails.length >= FAILS_TOTAL || mine.length >= FAILS_PER_USER) {
      return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    }
    const user = USER_RE.test(username) ? db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username) : null;
    // Hash something either way so a missing user takes as long as a wrong password.
    const ok = checkPassword(password, user ? user.pass_hash : dummyHash) && !!user;
    if (!ok) {
      mine.push(now); allFails.push(now);
      userFails.set(key, mine);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    userFails.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const s = Math.floor(now / 1000);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(s);
    db.prepare('INSERT INTO admin_sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), user.username, s, s + SESSION_S);
    db.prepare('UPDATE admin_users SET last_login = ? WHERE username = ?').run(s, user.username);
    setCookie(res, token, SESSION_S);
    res.json({ ok: true, username: user.username });
  });

  router.post('/logout', (req, res) => {
    const t = readCookie(req, COOKIE);
    if (t) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash(t));
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Not signed in.', setup: !hasUsers() });
    res.json({ username: u });
  });

  // Everything after this needs a session.
  function requireSession(req, res, next) {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Not signed in.' });
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'ShowPilotAdmin') return res.status(403).json({ error: 'Missing request header.' });
    req.adminUser = u;
    next();
  }

  router.post('/password', requireSession, json, (req, res) => {
    const b = req.body || {};
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(req.adminUser);
    if (!user || !checkPassword(String(b.current || ''), user.pass_hash)) return res.status(400).json({ error: 'Your current password is wrong.' });
    try { setPassword(db, user.username, String(b.next || '')); } catch (e) { return res.status(400).json({ error: e.message }); }
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  return { router, requireSession, hasUsers };
}

module.exports = { createAdminAuth, setPassword, initTables, MIN_PASSWORD };
