// ShowPilot admin — shared helpers for
// Cockpit (cockpit.html), v0.33.208+. The classic admin (index.html) is
// self-contained and does not use this file.
//
// Everything talks to the same /api/admin endpoints the classic page uses;
// there is no server logic specific to these pages beyond the per-user
// layout preference (/me/layout, /me/layout-notice-seen).
(function () {
  'use strict';
  const SP = (window.SP = {});

  SP.THEMES = [
    ['stage-dark', 'Stage · Dark'],
    ['stage-light', 'Stage · Light'],
    ['christmas', 'Christmas'],
    ['halloween', 'Halloween'],
    ['easter', 'Easter'],
    ['stpatricks', "St. Patrick's"],
    ['independence', 'Independence Day'],
    ['valentines', "Valentine's"],
  ];

  SP.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  SP.fmtTime = function (sec) {
    if (sec == null || !isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  // Same contract as the classic page's api(): { ok, status, data }.
  SP.api = async function (path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && typeof opts.body === 'string' &&
        !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      const res = await fetch('/api/admin' + path, Object.assign({ credentials: 'include' }, opts, { headers }));
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null };
    }
  };

  SP.put = (path, body) => SP.api(path, { method: 'PUT', body: JSON.stringify(body || {}) });
  SP.post = (path, body) => SP.api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

  // ---- Themes (same body class + storage as the classic page) ----
  SP.applyTheme = function (theme) {
    const valid = SP.THEMES.some(t => t[0] === theme) ? theme : 'stage-dark';
    SP.THEMES.forEach(t => document.body.classList.remove('theme-' + t[0]));
    document.body.classList.add('theme-' + valid);
    try { localStorage.setItem('showpilot_theme', valid); } catch (_) {}
    return valid;
  };
  SP.setTheme = async function (theme) {
    const t = SP.applyTheme(theme);
    await SP.put('/me/theme', { theme: t });
  };
  // Paint the cached theme immediately so the page doesn't flash.
  try { SP.applyTheme(localStorage.getItem('showpilot_theme') || 'stage-dark'); } catch (_) {}

  // ---- Session ----
  // Signed out, or a password change pending: hand off to the classic page,
  // which owns sign-in, first-boot setup and the change-password flow. After
  // sign-in it sends the user back here (their layout preference is 'new').
  SP.me = null;
  SP.requireLogin = async function () {
    const r = await SP.api('/me');
    if (!r.ok || !r.data) {
      location.href = '/admin/?login=1';
      return new Promise(() => {});
    }
    if (r.data.mustChangePassword) {
      location.href = '/admin/?classic=1';
      return new Promise(() => {});
    }
    SP.me = r.data;
    if (r.data.theme) SP.applyTheme(r.data.theme);
    return r.data;
  };


  SP.logout = async function () {
    await SP.post('/logout');
    location.href = '/admin/?login=1';
  };

  // ---- Viewer-side live state (/api/state): votes, timing, race ----
  // Also estimates the server clock so song progress is right on devices
  // whose clock is off (same approach as the viewer page).
  let clockOffsetMs = 0;
  let bestRtt = Infinity;
  SP.serverNow = () => Date.now() + clockOffsetMs;
  SP.viewerState = async function () {
    try {
      const sent = Date.now();
      const res = await fetch('/api/state', { credentials: 'include' });
      const got = Date.now();
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data.serverNowMs === 'number' && got - sent <= bestRtt * 1.5) {
        bestRtt = Math.min(bestRtt, got - sent);
        clockOffsetMs = data.serverNowMs - (sent + got) / 2;
      }
      return data;
    } catch (_) {
      return null;
    }
  };

  // ---- Live updates (the same socket events the classic page listens to) ----
  // The page loads /socket.io/socket.io.js with a plain <script> tag.
  SP.onLive = function (handler) {
    const events = ['viewerModeChanged', 'voteUpdate', 'voteReset', 'queueUpdated',
      'nowPlaying', 'pluginStatus', 'sequencesSynced', 'raceUpdate', 'raceReset'];
    if (typeof window.io !== 'function') return;
    try {
      const socket = window.io();
      events.forEach(ev => socket.on(ev, () => handler(ev)));
    } catch (_) {}
  };

  // Small non-blocking toast for action feedback.
  SP.toast = function (text, isError) {
    let el = document.getElementById('sp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sp-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.className = 'sp-toast show' + (isError ? ' error' : '');
    clearTimeout(SP._toastTimer);
    SP._toastTimer = setTimeout(() => { el.className = 'sp-toast'; }, 2600);
  };
})();
