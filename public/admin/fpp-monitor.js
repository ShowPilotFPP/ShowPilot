// ShowPilot FPP monitor page (main v0.33.278-master.13+ / Lite v0.5.125+).
//
// An FPPmon-style view of the show's main FPP, built from the status the show
// player sends ShowPilot (lib/fpp-monitor.js). While the page is open it asks
// GET /api/admin/fpp every 2 s; that also tells the show player to report
// every second. Controls go to POST /api/admin/fpp/command and run on the
// show player's next report.
//
//   SPFpp.open()          the FPP page was shown (starts polling)
//   SPFpp.close()         it was hidden (stops polling)
//   SPFpp.dashboard(s)    /api/admin/stats .fpp → the Dashboard strip
//
// Everything visible is built with textContent, never innerHTML with data.
// This file is identical between ShowPilot and ShowPilot-Lite.
(function () {
  'use strict';

  const POLL_MS = 2000;
  let timer = null;
  let tick = null;
  let last = null;        // last /api/admin/fpp answer
  // What the show player calls itself ('FPP' unless it says otherwise in its
  // status reports); used everywhere the page would say "FPP".
  let sysName = 'FPP';
  function setName(n) {
    const name = (typeof n === 'string' && n.trim()) || 'FPP';
    const changed = name !== sysName;
    sysName = name;
    const title = name + ' Monitor';
    const tab = document.querySelector('.tab-btn[data-tab="fpp"]');
    if (tab && tab.textContent !== title) tab.textContent = title;
    document.querySelectorAll('.spn-item[data-tab="fpp"] .spn-label').forEach((e) => { if (e.textContent !== title) e.textContent = title; });
    const t = document.getElementById('spnTitle');
    if (t && /^\S+ Monitor$/.test(t.textContent) && t.textContent !== title) t.textContent = title;
    const open = $('fppmOpen');
    if (open && changed) { open.textContent = 'Open ' + name + ' \u2197'; open.title = 'Opens ' + name + ' in a new tab. Works when you are on the same network as ' + name + '.'; }
    const rst = $('fppmRestart');
    if (rst && changed) rst.textContent = name === 'FPP' ? 'Restart FPPD' : 'Restart ' + name;
  }
  let lastAt = 0;         // Date.now() when it arrived
  let busy = false;
  let built = false;

  // ------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
    return e;
  }
  function clock(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function ago(ms) {
    if (ms === null || ms === undefined) return '';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return Math.floor(s / 3600) + ' h ago';
  }
  function bytes(n) {
    if (!isFinite(n)) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i >= 3 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  const STATE_TEXT = { playing: 'Playing', idle: 'Idle', paused: 'Paused', stopping: 'Stopping', testing: 'Test mode', unknown: 'Unknown' };
  const LEVEL_COLOR = { ok: 'var(--status-success)', warn: 'var(--status-warning)', bad: 'var(--status-danger)', unknown: 'var(--status-neutral)' };

  function ensureStyle() {
    if ($('fppMonStyle')) return;
    const css = `
#fppMonRoot { display: flex; flex-direction: column; gap: 1rem; }
.fppm-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.fppm-dot { width: 14px; height: 14px; border-radius: 50%; flex: none; box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 22%, transparent); background: currentColor; }
.fppm-dot.fppm-live { animation: fppm-pulse 2s ease-in-out infinite; }
@keyframes fppm-pulse { 50% { box-shadow: 0 0 0 7px color-mix(in srgb, currentColor 8%, transparent); } }
.fppm-title { font-size: 1.35rem; font-weight: 700; line-height: 1.2; }
.fppm-sub { color: var(--text-muted); font-size: 0.85rem; }
.fppm-issues { list-style: none; margin: 0.75rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.fppm-issues li { padding: 6px 10px; border-radius: 6px; font-size: 0.88rem; }
.fppm-issues li[data-level="bad"] { background: var(--status-danger-soft); color: var(--status-danger); }
.fppm-issues li[data-level="warn"] { background: var(--status-warning-soft); color: var(--status-warning); }
.fppm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
.fppm-grid > .card { margin: 0; }
.fppm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 0.9rem; }
.fppm-kv dt { color: var(--text-muted); }
.fppm-kv dd { margin: 0; overflow-wrap: anywhere; }
.fppm-big { font-size: 1.15rem; font-weight: 700; overflow-wrap: anywhere; }
.fppm-bar { height: 8px; border-radius: 99px; background: var(--bg-tertiary); overflow: hidden; margin: 6px 0 4px; }
.fppm-bar > span { display: block; height: 100%; border-radius: 99px; background: var(--rgb-blue); transition: width .6s ease; }
.fppm-meter { display: grid; grid-template-columns: 90px 1fr 64px; align-items: center; gap: 10px; font-size: 0.88rem; margin: 6px 0; }
.fppm-meter .fppm-bar { margin: 0; }
.fppm-meter b { text-align: right; font-variant-numeric: tabular-nums; }
.fppm-temp { font-size: 2rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; }
.fppm-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.fppm-chip { padding: 3px 9px; border-radius: 99px; background: var(--bg-tertiary); font-size: 0.8rem; }
.fppm-table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
.fppm-table th, .fppm-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.fppm-table th { color: var(--text-muted); font-weight: 600; }
.fppm-ctl { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.fppm-ctl select { flex: 1; min-width: 160px; width: auto; }
.fppm-act { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 0.86rem; }
.fppm-act li { display: flex; gap: 8px; justify-content: space-between; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--border); }
.fppm-muted { color: var(--text-muted); }
#fppDashCard { cursor: pointer; display: flex; align-items: center; gap: 10px; }
#fppDashCard .fppm-dot { width: 10px; height: 10px; box-shadow: none; }
@media (prefers-reduced-motion: reduce) { .fppm-dot.fppm-live { animation: none; } .fppm-bar > span { transition: none; } }
`;
    document.head.appendChild(h('style', { id: 'fppMonStyle' }, css));
  }

  // ------------------------------------------------------------ layout
  // Built once; render() only fills in values, so open menus and focus survive.
  function build() {
    const root = $('fppMonRoot');
    if (!root || built) return;
    built = true;
    root.textContent = '';
    root.appendChild(h('div', { class: 'card', id: 'fppmHeadCard' },
      h('div', { class: 'fppm-head' },
        h('span', { class: 'fppm-dot', id: 'fppmDot' }),
        h('div', { style: 'flex:1;min-width:200px;' },
          h('div', { class: 'fppm-title', id: 'fppmState' }, 'Waiting for your show player…'),
          h('div', { class: 'fppm-sub', id: 'fppmHost' })),
        h('a', { class: 'secondary', id: 'fppmOpen', target: '_blank', rel: 'noopener', style: 'display:none;padding:0.45rem 0.9rem;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;font-size:0.9rem;', title: 'Opens ' + sysName + ' in a new tab. Works when you are on the same network as ' + sysName + '.' }, 'Open ' + sysName + ' ↗')),
      h('ul', { class: 'fppm-issues', id: 'fppmIssues' }),
      h('p', { class: 'fppm-sub', id: 'fppmHint', style: 'margin:0.75rem 0 0;display:none;' })));

    const grid = h('div', { class: 'fppm-grid' });
    grid.appendChild(h('div', { class: 'card card-accent-red' },
      h('h2', {}, 'Now playing'),
      h('div', { class: 'fppm-big', id: 'fppmSeq' }, '—'),
      h('div', { class: 'fppm-sub', id: 'fppmPl' }),
      h('div', { class: 'fppm-bar' }, h('span', { id: 'fppmProg', style: 'width:0%' })),
      h('div', { class: 'fppm-sub', style: 'display:flex;justify-content:space-between;font-variant-numeric:tabular-nums;' },
        h('span', { id: 'fppmElapsed' }, '--:--'), h('span', { id: 'fppmLeft' }, '--:--')),
      h('dl', { class: 'fppm-kv', style: 'margin-top:12px;' },
        h('dt', {}, 'Next'), h('dd', { id: 'fppmNext' }, '—'),
        h('dt', {}, 'Scheduler'), h('dd', { id: 'fppmSched' }, '—'))));
    grid.appendChild(h('div', { class: 'card card-accent-amber' },
      h('h2', {}, 'Health'),
      h('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-bottom:6px;' },
        h('span', { class: 'fppm-temp', id: 'fppmTemp' }, '—'), h('span', { class: 'fppm-sub' }, 'CPU temperature')),
      meter('CPU', 'fppmCpu'), meter('Memory', 'fppmMem'), meter('Disk used', 'fppmDisk'),
      h('div', { class: 'fppm-sub', id: 'fppmDiskText' }),
      h('dl', { class: 'fppm-kv', style: 'margin-top:10px;' }, h('dt', {}, 'Uptime'), h('dd', { id: 'fppmUptime' }, '—')),
      h('div', { class: 'fppm-chips', id: 'fppmSensors' })));
    grid.appendChild(h('div', { class: 'card card-accent-blue' },
      h('h2', {}, 'System'),
      h('dl', { class: 'fppm-kv', id: 'fppmSys' })));
    grid.appendChild(h('div', { class: 'card card-accent-green' },
      h('h2', {}, 'Controls'),
      h('div', { class: 'fppm-ctl' },
        h('select', { id: 'fppmPlSel', 'aria-label': 'Playlist' }),
        h('button', { type: 'button', id: 'fppmStartBtn', onclick: () => send('startPlaylist', $('fppmPlSel').value) }, 'Start playlist')),
      h('div', { class: 'fppm-ctl' },
        h('select', { id: 'fppmPresetSel', 'aria-label': 'Command preset' }),
        h('button', { type: 'button', id: 'fppmPresetBtn', class: 'secondary', onclick: () => send('preset', $('fppmPresetSel').value) }, 'Run preset')),
      h('div', { class: 'fppm-ctl' },
        h('button', { type: 'button', class: 'secondary', 'data-fppm-ctl': '', onclick: () => send('stopGracefully') }, 'Stop gracefully'),
        h('button', { type: 'button', class: 'danger', 'data-fppm-ctl': '', onclick: () => { if (confirm('Stop the show right now? Lights and music stop mid-song.')) send('stopNow'); } }, 'Stop now'),
        h('button', { type: 'button', class: 'secondary', id: 'fppmRestart', 'data-fppm-ctl': '', onclick: () => { if (confirm('Restart ' + (sysName === 'FPP' ? 'FPPD' : sysName) + '? The show stops for a few seconds while it restarts.')) send('restartFppd'); } }, sysName === 'FPP' ? 'Restart FPPD' : 'Restart ' + sysName)),
      h('div', { class: 'fppm-sub', id: 'fppmCtlMsg', role: 'status', 'aria-live': 'polite' })));
    root.appendChild(grid);
    root.appendChild(h('div', { class: 'card', id: 'fppmRemotesCard' },
      h('h2', {}, 'MultiSync'),
      h('div', { id: 'fppmRemotes' })));
    root.appendChild(h('div', { class: 'card' },
      h('h2', {}, 'Recent controls'),
      h('ul', { class: 'fppm-act', id: 'fppmAct' })));
  }
  function meter(label, id) {
    return h('div', { class: 'fppm-meter' }, h('span', { class: 'fppm-muted' }, label),
      h('div', { class: 'fppm-bar' }, h('span', { id: id + 'Bar', style: 'width:0%' })), h('b', { id: id }, '—'));
  }
  function setMeter(id, pct, warnAt, badAt) {
    const bar = $(id + 'Bar'), val = $(id);
    if (!bar || !val) return;
    if (pct === null || pct === undefined || !isFinite(pct)) { bar.style.width = '0%'; val.textContent = '—'; return; }
    const p = Math.max(0, Math.min(100, pct));
    bar.style.width = p + '%';
    bar.style.background = p >= badAt ? 'var(--status-danger)' : p >= warnAt ? 'var(--status-warning)' : 'var(--rgb-blue)';
    val.textContent = Math.round(p) + '%';
  }
  function setOptions(sel, list, empty) {
    if (!sel) return;
    const key = JSON.stringify(list);
    if (sel.dataset.key === key) return;
    const keep = sel.value;
    sel.dataset.key = key;
    sel.textContent = '';
    if (!list.length) sel.appendChild(h('option', { value: '' }, empty));
    list.forEach((n) => sel.appendChild(h('option', { value: n }, n)));
    if (list.includes(keep)) sel.value = keep;
  }

  // ------------------------------------------------------------ render
  function render() {
    build();
    const d = last;
    if (!d) return;
    setName(d.systemName);
    const v = d.view;
    const age = (d.ageMs || 0) + (Date.now() - lastAt);
    const level = d.health ? d.health.level : 'unknown';
    const dot = $('fppmDot');
    dot.style.color = d.connected ? LEVEL_COLOR[level] || LEVEL_COLOR.unknown : LEVEL_COLOR[d.receivedAt ? 'bad' : 'unknown'];
    dot.classList.toggle('fppm-live', !!(d.connected && v && v.state === 'playing'));
    $('fppmHeadCard').className = 'card ' + (!d.receivedAt ? '' : level === 'bad' || !d.connected ? 'card-accent-red' : level === 'warn' ? 'card-accent-amber' : 'card-accent-green');

    const hint = $('fppmHint');
    if (!d.receivedAt) {
      $('fppmState').textContent = 'Waiting for your show player…';
      $('fppmHost').textContent = '';
      hint.style.display = '';
      hint.textContent = 'This page fills in once your show player reports its status. On FPP that needs the ShowPilot plugin (ShowPilot Blackbox) 0.14.26 or newer.';
    } else {
      hint.style.display = 'none';
      $('fppmState').textContent = !d.connected ? 'Not checking in' : (STATE_TEXT[v.state] || v.statusName);
      $('fppmHost').textContent = [v.hostName, v.hostDescription, 'updated ' + ago(age)].filter(Boolean).join(' · ');
    }
    const open = $('fppmOpen');
    if (d.fppHost) { open.href = 'http://' + d.fppHost + '/'; open.style.display = ''; } else open.style.display = 'none';

    const issues = $('fppmIssues');
    issues.textContent = '';
    ((d.health && d.health.items) || []).forEach((i) => issues.appendChild(h('li', { 'data-level': i.level }, i.text)));
    issues.style.display = issues.children.length ? '' : 'none';

    // Controls are usable while the show player is checking in.
    document.querySelectorAll('#fppMonRoot [data-fppm-ctl], #fppmStartBtn, #fppmPresetBtn').forEach((b) => { b.disabled = !d.connected; });
    setOptions($('fppmPlSel'), d.playlists || [], 'No playlists reported yet');
    setOptions($('fppmPresetSel'), d.presets || [], 'No command presets');
    $('fppmStartBtn').disabled = !d.connected || !(d.playlists || []).length;
    $('fppmPresetBtn').disabled = !d.connected || !(d.presets || []).length;

    renderActivity(d.activity || []);
    if (!v) return;

    // Now playing
    const playing = v.state === 'playing' || v.state === 'paused' || v.state === 'stopping';
    $('fppmSeq').textContent = playing ? (v.sequence || v.media || v.playlist || '—') : 'Nothing playing';
    $('fppmPl').textContent = playing && v.playlist
      ? 'Playlist: ' + v.playlist + (v.playlistIndex && v.playlistCount ? ' (item ' + v.playlistIndex + ' of ' + v.playlistCount + ')' : '') : '';
    paintProgress();
    $('fppmNext').textContent = v.next && v.next.playlist ? v.next.playlist + (v.next.when ? ' — ' + v.next.when : '') : 'Nothing scheduled';
    $('fppmSched').textContent = v.schedulerEnabled === null ? '—' : v.schedulerEnabled ? 'On' : 'Off';

    // Health
    const t = $('fppmTemp');
    t.textContent = v.cpuTemp === null ? '—' : Math.round(v.cpuTemp) + '°C';
    t.style.color = v.cpuTemp === null ? '' : v.cpuTemp >= 80 ? 'var(--status-danger)' : v.cpuTemp >= 70 ? 'var(--status-warning)' : 'var(--status-success)';
    setMeter('fppmCpu', v.cpuPercent, 80, 95);
    setMeter('fppmMem', v.memoryPercent, 85, 95);
    setMeter('fppmDisk', v.disk ? (1 - v.disk.freeFraction) * 100 : null, 85, 95);
    $('fppmDiskText').textContent = v.disk ? bytes(v.disk.freeBytes) + ' free of ' + bytes(v.disk.totalBytes) : '';
    $('fppmUptime').textContent = v.uptime || '—';
    const sens = $('fppmSensors');
    sens.textContent = '';
    v.sensors.forEach((s) => sens.appendChild(h('span', { class: 'fppm-chip', title: s.type }, (s.label ? s.label + ': ' : '') + s.formatted)));

    // System
    const sys = $('fppmSys');
    sys.textContent = '';
    const row = (k, val) => { if (val) { sys.appendChild(h('dt', {}, k)); sys.appendChild(h('dd', {}, val)); } };
    row('Mode', v.mode ? v.mode.charAt(0).toUpperCase() + v.mode.slice(1) : '');
    row('Version', [v.version, v.branch && v.branch !== 'master' ? '(' + v.branch + ')' : ''].filter(Boolean).join(' '));
    row('Hardware', [v.platform, v.variant].filter(Boolean).join(' · '));
    row('OS', v.osVersion);
    row('Host name', v.hostName);
    row('IP address', v.ips.join(', '));
    row('Plugin', d.pluginVersion ? 'v' + String(d.pluginVersion).replace(/^v/, '') : '');
    row('Last report', d.receivedAt ? ago(age) : '');

    // MultiSync
    const rem = $('fppmRemotes');
    rem.textContent = '';
    if (!v.remotes.length) {
      rem.appendChild(h('p', { class: 'fppm-sub', style: 'margin:0;' }, sysName + ' doesn’t see any other systems.'));
    } else {
      const tb = h('tbody');
      v.remotes.forEach((r) => tb.appendChild(h('tr', {},
        h('td', {}, h('span', { class: 'fppm-dot', style: 'display:inline-block;width:9px;height:9px;box-shadow:none;margin-right:8px;color:' + (r.online === null ? LEVEL_COLOR.unknown : r.online ? LEVEL_COLOR.ok : LEVEL_COLOR.bad) }), r.hostName || r.address),
        h('td', {}, r.address), h('td', {}, r.mode || r.type), h('td', {}, r.version),
        h('td', {}, r.ageSeconds === null ? '' : ago(r.ageSeconds * 1000)))));
      rem.appendChild(h('div', { style: 'overflow-x:auto;' }, h('table', { class: 'fppm-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'System'), h('th', {}, 'Address'), h('th', {}, 'Mode'), h('th', {}, 'Version'), h('th', {}, 'Last seen'))), tb)));
    }
  }
  // Time left counts down locally between reports.
  function paintProgress() {
    const d = last;
    const v = d && d.view;
    if (!v) return;
    const playing = v.state === 'playing' || v.state === 'stopping';
    const drift = playing ? ((d.ageMs || 0) + (Date.now() - lastAt)) / 1000 : 0;
    const left = v.secondsRemaining === null ? null : Math.max(0, v.secondsRemaining - drift);
    const el = v.secondsElapsed === null ? null : v.secondsElapsed + drift;
    $('fppmElapsed').textContent = playing || v.state === 'paused' ? clock(el) : '--:--';
    $('fppmLeft').textContent = playing || v.state === 'paused' ? '-' + clock(left) : '--:--';
    const total = el !== null && left !== null ? el + left : null;
    $('fppmProg').style.width = total ? Math.min(100, (el / total) * 100) + '%' : '0%';
  }
  function renderActivity(list) {
    const ul = $('fppmAct');
    if (!ul) return;
    ul.textContent = '';
    if (!list.length) { ul.appendChild(h('li', { class: 'fppm-muted' }, 'Nothing yet.')); return; }
    list.forEach((a) => {
      const st = a.result ? (a.result.ok ? '✓ Done' : '✕ ' + (a.result.message || 'Failed')) : a.sentAt ? 'Sent to your show player…' : 'Waiting for your show player…';
      ul.appendChild(h('li', {},
        h('span', {}, h('b', {}, a.label), a.name ? ' — ' + a.name : ''),
        h('span', { class: 'fppm-muted' }, (a.by ? a.by + ' · ' : '') + new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · ',
          h('span', { style: a.result && !a.result.ok ? 'color:var(--status-danger)' : a.result ? 'color:var(--status-success)' : '' }, st))));
    });
  }

  // ------------------------------------------------------------ talk to the server
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch('/api/admin/fpp', { credentials: 'include', cache: 'no-store' });
      if (r.ok) { last = await r.json(); lastAt = Date.now(); render(); }
    } catch (_) { /* next poll */ } finally { busy = false; }
  }
  async function send(action, name) {
    const msg = $('fppmCtlMsg');
    msg.textContent = 'Sending…';
    try {
      const r = await fetch('/api/admin/fpp/command', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name: name || '' }),
      });
      const d = await r.json().catch(() => ({}));
      msg.textContent = r.ok ? 'Sent. Your show player runs it within a second or two.' : (d.error || 'That didn’t work.');
      setTimeout(() => { if (msg.textContent.startsWith('Sent.')) msg.textContent = ''; }, 5000);
    } catch (_) {
      msg.textContent = 'That didn’t work. Check your connection.';
    }
    poll();
  }

  function open() {
    ensureStyle();
    build();
    if (!timer) {
      poll();
      timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
      tick = setInterval(paintProgress, 500);
    }
  }
  function close() {
    clearInterval(timer); clearInterval(tick);
    timer = tick = null;
  }

  // Dashboard strip, from /api/admin/stats (every few seconds).
  function dashboard(s) {
    const el = $('fppDashCard');
    if (!el) return;
    if (s) setName(s.systemName);
    if (!s || !s.reporting) { el.style.display = 'none'; return; }
    ensureStyle();
    const level = s.connected ? (s.health && s.health.level) || 'ok' : 'bad';
    const parts = [];
    if (!s.connected) parts.push('not checking in');
    else {
      parts.push(STATE_TEXT[s.state] || s.state || 'Unknown');
      if (s.state === 'playing' && (s.sequence || s.playlist)) parts.push(s.sequence || s.playlist);
      if (s.cpuTemp !== null && s.cpuTemp !== undefined) parts.push(Math.round(s.cpuTemp) + '°C');
    }
    const first = s.health && s.health.items && s.health.items[0];
    el.textContent = '';
    el.appendChild(h('span', { class: 'fppm-dot', style: 'color:' + LEVEL_COLOR[level] }));
    el.appendChild(h('span', { style: 'flex:1;' }, h('b', {}, (s.hostName || sysName) + ': '), parts.join(' · '), level !== 'ok' && first ? ' — ' + first.text : ''));
    el.appendChild(h('span', { style: 'text-decoration:underline;font-weight:600;' }, sysName + ' Monitor'));
    el.style.borderColor = LEVEL_COLOR[level];
    el.style.display = '';
    const dash = $('spnDash');
    if (dash && dash.parentNode === el.parentNode && (el.compareDocumentPosition(dash) & Node.DOCUMENT_POSITION_PRECEDING)) dash.parentNode.insertBefore(el, dash);
  }

  window.SPFpp = { open, close, dashboard };
})();
