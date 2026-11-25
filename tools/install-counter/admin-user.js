#!/usr/bin/env node
// ============================================================
// Manage directory admin users (run on the counter's server).
//
//   node admin-user.js add <username>      add a user, or set a new password
//   node admin-user.js remove <username>   remove a user (signs them out)
//   node admin-user.js list                list users
//
// Uses the same database as the running counter (DATA_DIR, default ./data).
// The password is typed at a hidden prompt, never on the command line.
// ============================================================
'use strict';
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const { setPassword, initTables } = require('./admin-auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = new Database(path.join(DATA_DIR, 'installs.db'));
db.pragma('journal_mode = WAL');
initTables(db);

// Typed at a hidden prompt; when input is piped (scripts), lines are read in order.
let rl = null;
let muted = false;
let piped = null;
function ask(question) {
  if (!process.stdin.isTTY) {
    if (!piped) piped = require('fs').readFileSync(0, 'utf8').split(/\r?\n/);
    return Promise.resolve(piped.shift() || '');
  }
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
  }
  return new Promise((resolve) => {
    muted = false;
    rl.output.write(question);
    muted = true; // hide what's typed
    rl.question('', (a) => { muted = false; rl.output.write('\n'); resolve(a); });
  });
}

(async () => {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'list') {
    const rows = db.prepare('SELECT username, created_at, last_login FROM admin_users ORDER BY username').all();
    if (!rows.length) console.log('No admin users yet.');
    for (const r of rows) {
      console.log(r.username.padEnd(24) + ' last sign-in: ' + (r.last_login ? new Date(r.last_login * 1000).toLocaleString() : 'never'));
    }
    return;
  }
  if (cmd === 'remove' && name) {
    const n = db.prepare('DELETE FROM admin_users WHERE username = ?').run(name).changes;
    db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(name);
    console.log(n ? 'Removed ' + name + '.' : 'No user called ' + name + '.');
    return;
  }
  if (cmd === 'add' && name) {
    const p1 = await ask('Password for ' + name + ': ');
    const p2 = await ask('Same password again: ');
    if (rl) rl.close();
    if (p1 !== p2) { console.error('The passwords did not match.'); process.exit(1); }
    try { setPassword(db, name, p1); } catch (e) { console.error(e.message); process.exit(1); }
    console.log('Saved. ' + name + ' can sign in at /admin.');
    return;
  }
  console.log('Usage:\n  node admin-user.js add <username>\n  node admin-user.js remove <username>\n  node admin-user.js list');
})();
