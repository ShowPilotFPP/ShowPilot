// ShowPilot admin — new layout (v0.33.209+).
//
// The new layout is a redesign of the one admin page, not a separate page:
// every section, setting and button is the classic admin's own markup and
// code, restyled by ui-new.css and reorganized here. SPNew.apply(me) is
// called by index.html after sign-in; users whose preference is 'classic'
// get nothing added, so the page renders exactly as before.
//
// What this script does, all additively:
//   - builds the sidebar rail from the page's real sections (.tab-btn) and
//     sub-pages (.sub-tab), so new sections appear automatically
//   - wraps switchMainTab()/switchTab() to keep the rail and title in sync
//   - moves the existing header controls (theme, account, viewer count,
//     FPP status, viewer page link) into the rail/top bar — same elements
//     and ids, so the classic code keeps updating them
//   - renders the new dashboard inside the dashboard pane, using the
//     classic page's own functions for every action
//   - shows the one-time "how to switch back" notice
(function () {
  'use strict';

  const ICON = {
    dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
    sequences: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    queue: 'M4 6h16M4 12h10M4 18h7M17 15v6M14 18h6',
    stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    viewer: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    plugin: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    cockpit: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 12h8M12 8v8',
    classic: 'M4 5h16v14H4zM4 9h16M9 9v10',
    pin: 'M9 6l6 6-6 6',
    unpin: 'M15 6l-6 6 6 6',
    fallback: 'M5 12h14',
  };
  const svg = (d) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  let sections = [];      // [{ tab, label, subs: [{ id, label }] }]
  let currentTab = 'dashboard';
  let currentSub = null;
  let applied = false;
  let urlSync = false;    // off during setup so an incoming ?section= link isn't erased

  // ---------- Rail ----------
  function readSections() {
    return Array.from(document.querySelectorAll('.tab-nav .tab-btn')).map(btn => {
      const tab = btn.dataset.tab;
      const pane = document.querySelector('.tab-pane[data-pane="' + tab + '"]');
      const subs = pane ? Array.from(pane.querySelectorAll('.sub-tabs .sub-tab')).map(s => ({ id: s.dataset.subtab, label: s.textContent.trim() })) : [];
      return { tab, label: btn.textContent.trim(), subs };
    });
  }

  function buildRail() {
    const version = (document.querySelector('.app-version') || {}).textContent || '';
    const rail = el('<aside class="spn-rail" aria-label="Main"></aside>');
    rail.appendChild(el('<div class="spn-brand"><div class="spn-mark" aria-hidden="true">' + '<span></span>'.repeat(9) + '</div>' +
      '<div class="spn-label"><div class="spn-brand-name">' + esc(document.querySelector('.app-brand-text') ? document.querySelector('.app-brand-text').textContent : 'ShowPilot') + '</div>' +
      '<div class="spn-brand-version">' + esc(version) + '</div></div></div>'));
    const nav = el('<nav class="spn-nav"></nav>');
    sections.forEach(sec => {
      const item = el('<button type="button" class="spn-item" data-tab="' + esc(sec.tab) + '" title="' + esc(sec.label) + '">' +
        svg(ICON[sec.tab] || ICON.fallback) + '<span class="spn-label">' + esc(sec.label) + '</span>' +
        (sec.subs.length ? '<svg class="spn-chev spn-label" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' : '') +
        '</button>');
      if (sec.subs.length) item.setAttribute('aria-expanded', 'false');
      item.addEventListener('click', () => go(sec.tab, sec.subs.length ? (currentTab === sec.tab ? currentSub : sec.subs[0].id) : null));
      nav.appendChild(item);
      if (sec.subs.length) {
        const sub = el('<div class="spn-sub" data-parent="' + esc(sec.tab) + '"></div>');
        sec.subs.forEach(s => {
          const b = el('<button type="button" class="spn-subitem" data-sub="' + esc(s.id) + '">' + esc(s.label) + '</button>');
          b.addEventListener('click', () => go(sec.tab, s.id));
          sub.appendChild(b);
        });
        nav.appendChild(sub);
      }
    });
    nav.appendChild(el('<div class="spn-sep" aria-hidden="true"></div>'));
    nav.appendChild(el('<a class="spn-item" href="/admin/cockpit.html" title="Cockpit (tablet mode)">' + svg(ICON.cockpit) + '<span class="spn-label">Cockpit (tablet)</span></a>'));
    rail.appendChild(nav);

    const foot = el('<div class="spn-foot"></div>');
    const status = el('<div class="spn-status" title="FPP connection"></div>');
    const dot = document.getElementById('headerPluginDot');
    const txt = document.getElementById('headerPluginText');
    if (dot) status.appendChild(dot);
    const lbl = el('<span class="spn-label"></span>');
    if (txt) lbl.appendChild(txt);
    status.appendChild(lbl);
    foot.appendChild(status);
    const classic = el('<button type="button" class="spn-item" title="Switch to classic layout">' + svg(ICON.classic) + '<span class="spn-label">Classic layout</span></button>');
    classic.addEventListener('click', useClassic);
    foot.appendChild(classic);
    const pin = el('<button type="button" class="spn-item" id="spnPin" aria-pressed="false">' + svg(ICON.pin) + '<span class="spn-label">Keep menu open</span></button>');
    pin.addEventListener('click', () => setPinned(!document.body.classList.contains('rail-pinned')));
    foot.appendChild(pin);
    rail.appendChild(foot);
    // A mouse click leaves the clicked button focused; release it so the rail
    // collapses as soon as the pointer leaves. Keyboard activation (detail 0)
    // keeps focus, so keyboard users stay in the menu.
    rail.addEventListener('click', (e) => {
      if (e.detail > 0) {
        const b = e.target.closest('button');
        if (b) b.blur();
      }
    });
    document.body.appendChild(rail);
  }

  function setPinned(on) {
    document.body.classList.toggle('rail-pinned', on);
    const pin = document.getElementById('spnPin');
    if (pin) {
      pin.setAttribute('aria-pressed', on ? 'true' : 'false');
      pin.querySelector('.spn-label').textContent = on ? 'Collapse menu' : 'Keep menu open';
      pin.querySelector('path').setAttribute('d', on ? ICON.unpin : ICON.pin);
    }
    try { localStorage.setItem('sp_rail_pinned', on ? '1' : '0'); } catch (_) {}
  }

  // ---------- Top bar ----------
  function buildTopbar() {
    const main = document.querySelector('main');
    if (!main) return;
    const top = el('<div class="spn-top"><div><h1 id="spnTitle">Dashboard</h1><div class="spn-crumb" id="spnCrumb"></div></div><span class="spn-spacer"></span></div>');
    const count = document.getElementById('headerViewerCount');
    if (count) { const chip = el('<span class="spn-chip"></span>'); chip.appendChild(count); top.appendChild(chip); }
    const show = document.querySelector('.app-header .header-show-btn[href]');
    if (show) top.appendChild(show);
    const theme = document.getElementById('themeSelect');
    if (theme) top.appendChild(theme);
    const user = document.getElementById('headerUserSlot');
    if (user) top.appendChild(user);
    main.parentNode.insertBefore(top, main);
  }

  function showNotice(me) {
    if (me.layoutNoticeSeen) return;
    const main = document.querySelector('main');
    const n = el('<div class="spn-notice" role="status"><p><strong>This is the new ShowPilot admin.</strong> Everything from the original is still here, now in the menu on the left. Prefer the original layout? Choose <em>Classic layout</em> at the bottom of the menu. You can switch back and forth anytime.</p>' +
      '<button type="button" class="secondary" id="spnNoticeClassic">Switch to classic now</button><button type="button" id="spnNoticeOk">Got it</button></div>');
    main.parentNode.insertBefore(n, main);
    const seen = () => api('/me/layout-notice-seen', { method: 'PUT' });
    document.getElementById('spnNoticeOk').addEventListener('click', async () => { n.remove(); await seen(); });
    document.getElementById('spnNoticeClassic').addEventListener('click', async () => { await seen(); useClassic(); });
  }

  async function useClassic() {
    await api('/me/layout', { method: 'PUT', body: JSON.stringify({ layout: 'classic' }) });
    location.reload();
  }

  // ---------- Navigation sync ----------
  function go(tab, sub) {
    window.switchMainTab(tab);
    if (sub) window.switchTab(sub);
  }
  function syncRail() {
    const sec = sections.find(s => s.tab === currentTab);
    document.querySelectorAll('.spn-item[data-tab]').forEach(b => {
      const on = b.dataset.tab === currentTab;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      if (b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    document.querySelectorAll('.spn-sub').forEach(s => s.classList.toggle('open', s.dataset.parent === currentTab));
    document.querySelectorAll('.spn-subitem').forEach(b => {
      const on = sec && sec.subs.some(x => x.id === b.dataset.sub) && b.dataset.sub === currentSub;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const title = document.getElementById('spnTitle');
    const crumb = document.getElementById('spnCrumb');
    if (title && sec) {
      const s = sec.subs.find(x => x.id === currentSub);
      title.textContent = s ? s.label : sec.label;
      crumb.textContent = s ? sec.label : '';
    }
    // Keep the address bar on the current section so a refresh stays here
    // (replaceState: no navigation, no history entries).
    if (urlSync) try {
      const url = new URL(location.href);
      if (currentTab === 'dashboard') url.searchParams.delete('section');
      else url.searchParams.set('section', currentTab);
      if (url.href !== location.href) history.replaceState(history.state, '', url.href);
    } catch (_) {}
    if (currentTab === 'dashboard') refreshDash();
  }
  function wrapNavigation() {
    const origMain = window.switchMainTab;
    const origSub = window.switchTab;
    window.switchMainTab = function (name) {
      origMain.apply(this, arguments);
      currentTab = name;
      const sec = sections.find(s => s.tab === name);
      if (sec && sec.subs.length) {
        const active = document.querySelector('.tab-pane[data-pane="' + name + '"] .sub-tab.active');
        currentSub = active ? active.dataset.subtab : sec.subs[0].id;
      } else currentSub = null;
      syncRail();
    };
    window.switchTab = function (name) {
      origSub.apply(this, arguments);
      currentSub = name;
      syncRail();
    };
  }

  // ---------- Dashboard ----------
  let dashCfg = {}, dashStats = {}, dashState = null, dashQueue = [];
  let clockOffset = 0, bestRtt = Infinity;
  const serverNow = () => Date.now() + clockOffset;
  const fmt = (sec) => (sec == null || !isFinite(sec)) ? '--:--' : Math.floor(Math.max(0, sec) / 60) + ':' + String(Math.floor(Math.max(0, sec)) % 60).padStart(2, '0');
  function seqInfo(name) {
    const list = (typeof sequencesCache !== 'undefined' && Array.isArray(sequencesCache)) ? sequencesCache : [];
    const s = list.find(x => x.name === name) || ((dashState && dashState.sequences) || []).find(x => x.name === name);
    return { title: (s && s.display_name) || name || '', artist: (s && s.artist) || '' };
  }

  function buildDash() {
    const pane = document.querySelector('.tab-pane[data-pane="dashboard"]');
    if (!pane || document.getElementById('spnDash')) return;
    pane.insertBefore(el(
      '<div id="spnDash">' +
      '<section class="spn-strip" aria-label="Show control">' +
        '<div class="spn-group"><span>Viewer control</span><button type="button" class="spn-toggle" id="spnVc" aria-pressed="false"><span class="t" aria-hidden="true"><i></i></span><span id="spnVcLabel">Off</span></button></div>' +
        '<span class="spn-vsep" aria-hidden="true"></span>' +
        '<div class="spn-group"><span id="spnModeLabel">Mode</span><div class="spn-seg" role="group" aria-labelledby="spnModeLabel" id="spnModes"></div></div>' +
        '<div class="spn-actions" id="spnActions"></div>' +
      '</section>' +
      '<div class="spn-row">' +
        '<section class="spn-panel spn-onair" aria-label="Now playing">' +
          '<span class="spn-tally" id="spnTally"><i aria-hidden="true"></i><span id="spnTallyText">ON AIR</span></span>' +
          '<div><h2 class="spn-title" id="spnNow">Nothing playing</h2><div class="spn-artist" id="spnArtist"></div></div>' +
          '<div id="spnProg" hidden><div class="spn-track" role="progressbar" aria-label="Song progress" aria-valuemin="0" aria-valuemax="100" id="spnBar"><div class="spn-fill" id="spnFill"></div></div>' +
          '<div class="spn-times"><span id="spnEl">0:00</span><span id="spnRem">-0:00</span></div></div>' +
          '<div class="spn-next"><span class="spn-muted">Up next</span><b id="spnNext">—</b><span class="spn-pill" id="spnNextSrc" hidden></span></div>' +
        '</section>' +
        '<section class="spn-stats" aria-label="Show numbers">' +
          '<div class="spn-stat"><span class="spn-muted">Watching now</span><span class="v" id="spnS1">0</span><small>on the viewer page</small></div>' +
          '<div class="spn-stat"><span class="spn-muted" id="spnS2L">Votes this round</span><span class="v" id="spnS2">0</span><small id="spnS2H">for the next song</small></div>' +
          '<div class="spn-stat"><span class="spn-muted">Played by viewers</span><span class="v" id="spnS3">0</span><small>votes and requests, all time</small></div>' +
          '<div class="spn-stat"><span class="spn-muted">Sequences</span><span class="v" id="spnS4">0</span><small>on the viewer page</small></div>' +
        '</section>' +
      '</div>' +
      '<div class="spn-row">' +
        '<section class="spn-panel" aria-labelledby="spnLiveT"><div class="spn-head"><h2 id="spnLiveT">Live vote</h2><span class="spn-muted" id="spnLiveS"></span></div><div id="spnLive"></div></section>' +
        '<section class="spn-panel" aria-labelledby="spnTopT"><div class="spn-head"><h2 id="spnTopT">Top sequences</h2><span class="spn-muted">all time</span></div><ol class="spn-top-list" id="spnTop"></ol></section>' +
      '</div>' +
      '</div>'), pane.firstChild);

    document.getElementById('spnVc').addEventListener('click', () => window.toggleViewerControl());
  }

  const MODES = [['OFF', 'Off'], ['VOTING', 'Voting'], ['JUKEBOX', 'Jukebox'], ['RACE', 'Race']];
  function renderDash() {
    const $ = (id) => document.getElementById(id);
    if (!$('spnDash')) return;
    const mode = dashCfg.viewer_control_mode || 'OFF';
    $('spnVc').setAttribute('aria-pressed', mode !== 'OFF' ? 'true' : 'false');
    $('spnVcLabel').textContent = mode !== 'OFF' ? 'On' : 'Off';
    $('spnModes').innerHTML = MODES.map(m => '<button type="button" data-mode="' + m[0] + '" aria-pressed="' + (m[0] === mode) + '">' + m[1] + '</button>').join('');
    $('spnModes').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
      const sel = document.getElementById('modeSelect');
      if (sel) sel.value = b.dataset.mode;
      await window.updateMode(b.dataset.mode);
      refreshDash();
    }));
    const acts = mode === 'RACE' ? [['resetRace', 'Reset race']] : mode === 'JUKEBOX' ? [['purgeQueue', 'Purge queue']] : [['resetVotes', 'Reset votes'], ['purgeQueue', 'Purge queue']];
    $('spnActions').innerHTML = acts.map(a => '<button type="button" data-fn="' + a[0] + '">' + a[1] + '</button>').join('');
    $('spnActions').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => { await window[b.dataset.fn](); refreshDash(); }));

    const now = dashStats.nowPlaying;
    const tally = $('spnTally');
    if (now) { const i = seqInfo(now); $('spnNow').textContent = i.title; $('spnArtist').textContent = i.artist; tally.classList.remove('off'); $('spnTallyText').textContent = 'ON AIR'; }
    else { $('spnNow').textContent = 'Nothing playing'; $('spnArtist').textContent = 'The show is idle.'; tally.classList.add('off'); $('spnTallyText').textContent = 'OFF AIR'; }
    const next = dashStats.nextUp;
    $('spnNext').textContent = next ? seqInfo(next).title : '—';
    $('spnNextSrc').hidden = !next;
    $('spnNextSrc').textContent = mode === 'VOTING' ? 'Vote leader' : mode === 'JUKEBOX' ? 'From the queue' : mode === 'RACE' ? 'Race leader' : 'Scheduled';
    paintProgress();

    $('spnS1').textContent = dashStats.activeViewers ?? 0;
    if (mode === 'JUKEBOX') { $('spnS2L').textContent = 'Requests waiting'; $('spnS2').textContent = dashStats.queueLength ?? 0; $('spnS2H').textContent = 'in the jukebox queue'; }
    else { $('spnS2L').textContent = 'Votes this round'; $('spnS2').textContent = dashStats.totalVotes ?? 0; $('spnS2H').textContent = 'for the next song'; }
    $('spnS3').textContent = dashStats.totalPlays ?? 0;
    $('spnS4').textContent = ((dashState && dashState.sequences) || []).length;
    const top = dashStats.topSequences || [];
    $('spnTop').innerHTML = top.length ? top.slice(0, 6).map((s, i) => '<li><span class="n">' + (i + 1) + '</span><span>' + esc(seqInfo(s.sequence_name).title) + '</span><span class="p">' + s.plays + '</span></li>').join('')
      : '<li class="spn-muted">No songs played by viewers yet.</li>';

    const live = $('spnLive');
    const bars = (rows) => {
      const max = Math.max(1, ...rows.map(r => r.count));
      return '<div class="spn-bars">' + rows.map((r, i) => { const inf = seqInfo(r.name);
        return '<div class="spn-bar-row"><span class="spn-muted num">' + (i + 1) + '</span><div><b>' + esc(inf.title) + '</b> <span class="spn-muted">' + esc(inf.artist) + '</span>' +
          '<div class="spn-bar"><div style="width:' + Math.round(r.count / max * 100) + '%"></div></div></div><span class="c">' + r.count + '</span></div>'; }).join('') + '</div>';
    };
    if (mode === 'OFF') {
      $('spnLiveT').textContent = 'Viewer control is off'; $('spnLiveS').textContent = '';
      live.innerHTML = '<div class="spn-empty"><strong>Viewers can watch, but not vote or request.</strong><span class="spn-muted">Turn viewer control on to open voting, the jukebox or a race.</span><button type="button" id="spnTurnOn">Turn on viewer control</button></div>';
      $('spnTurnOn').addEventListener('click', () => window.toggleViewerControl());
    } else if (mode === 'VOTING') {
      const rows = ((dashState && dashState.voteCounts) || []).map(v => ({ name: v.sequence_name, count: v.count })).sort((a, b) => b.count - a.count).slice(0, 8);
      $('spnLiveT').textContent = 'Live vote'; $('spnLiveS').textContent = rows.length ? 'Round closes when the current song ends' : '';
      live.innerHTML = rows.length ? bars(rows) : '<div class="spn-empty"><strong>No votes yet this round.</strong><span class="spn-muted">Votes show up here the moment viewers cast them.</span></div>';
    } else if (mode === 'JUKEBOX') {
      const pending = dashQueue.filter(q => !q.handed_off_at);
      $('spnLiveT').textContent = 'Request queue'; $('spnLiveS').textContent = pending.length ? pending.length + ' waiting' : '';
      live.innerHTML = pending.length ? pending.map((q, i) => '<div class="spn-q"><span class="spn-muted">' + (i + 1) + '</span><div><div style="font-weight:600">' + esc(q.display_name || q.sequence_name) + '</div><div class="spn-muted" style="font-size:13px">' + esc(q.artist || '') + '</div></div><span></span>' +
        '<button type="button" class="spn-x" data-id="' + esc(q.id) + '" aria-label="Remove ' + esc(q.display_name || q.sequence_name) + ' from the queue"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>').join('')
        : '<div class="spn-empty"><strong>The queue is empty.</strong><span class="spn-muted">Requests from viewers appear here in the order they will play.</span></div>';
      live.querySelectorAll('.spn-x').forEach(b => b.addEventListener('click', async () => { await window.removeQueueEntry(Number(b.dataset.id)); refreshDash(); }));
    } else {
      const race = dashState && dashState.race;
      const rows = ((race && race.tapCounts) || []).map(r => ({ name: r.sequence_name, count: r.count })).slice(0, 8);
      $('spnLiveT').textContent = 'Tap race'; $('spnLiveS').textContent = race && race.targetTaps ? 'First to ' + race.targetTaps + ' taps plays next' : '';
      live.innerHTML = rows.length ? bars(rows) : '<div class="spn-empty"><strong>No taps yet.</strong><span class="spn-muted">Race standings show up here as viewers tap.</span></div>';
    }
  }

  function paintProgress() {
    const wrap = document.getElementById('spnProg');
    if (!wrap) return;
    const start = dashState && dashState.nowPlayingStartedAtIso;
    const dur = dashState && dashState.nowPlayingDurationSeconds;
    if (!dashStats.nowPlaying || !start || !dur) { wrap.hidden = true; return; }
    const elapsed = Math.max(0, (serverNow() - Date.parse(start)) / 1000);
    const frac = Math.min(1, elapsed / dur);
    wrap.hidden = false;
    document.getElementById('spnFill').style.width = (frac * 100).toFixed(1) + '%';
    document.getElementById('spnBar').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    document.getElementById('spnEl').textContent = fmt(Math.min(elapsed, dur));
    document.getElementById('spnRem').textContent = '-' + fmt(dur - elapsed);
  }

  let dashBusy = false;
  async function refreshDash() {
    if (!applied || dashBusy || currentTab !== 'dashboard') return;
    dashBusy = true;
    try {
      const sent = Date.now();
      const [c, s, q, st] = await Promise.all([
        api('/config'), api('/stats'), api('/queue'),
        fetch('/api/state', { credentials: 'include' }).then(async r => ({ r, got: Date.now(), d: r.ok ? await r.json() : null })).catch(() => null),
      ]);
      if (c.ok && c.data) dashCfg = c.data;
      if (s.ok && s.data) dashStats = s.data;
      if (q.ok && q.data) dashQueue = q.data.pending || [];
      if (st && st.d) {
        dashState = st.d;
        if (typeof st.d.serverNowMs === 'number' && st.got - sent <= bestRtt * 1.5) {
          bestRtt = Math.min(bestRtt, st.got - sent);
          clockOffset = st.d.serverNowMs - (sent + st.got) / 2;
        }
      }
      renderDash();
    } finally { dashBusy = false; }
  }

  // ---------- Entry point ----------
  window.SPNew = {
    apply(me) {
      if (applied || !me || me.adminLayout === 'classic') return;
      applied = true;
      document.body.classList.add('ui-new');
      sections = readSections();
      buildRail();
      buildTopbar();
      buildDash();
      showNotice(me);
      wrapNavigation();
      setPinned((() => { try { return localStorage.getItem('sp_rail_pinned') === '1'; } catch (_) { return false; } })());
      // Refresh the dashboard whenever the classic page refreshes its stats
      // (socket events, actions), and on a slow timer as a backstop.
      if (typeof window.loadStats === 'function') {
        const origStats = window.loadStats;
        window.loadStats = function () { const r = origStats.apply(this, arguments); refreshDash(); return r; };
      }
      setInterval(refreshDash, 5000);
      setInterval(paintProgress, 1000);
      const active = document.querySelector('.tab-btn.active');
      currentTab = active ? active.dataset.tab : 'dashboard';
      const sec = sections.find(s => s.tab === currentTab);
      if (sec && sec.subs.length) {
        const a = document.querySelector('.tab-pane[data-pane="' + currentTab + '"] .sub-tab.active');
        currentSub = a ? a.dataset.subtab : sec.subs[0].id;
      }
      syncRail();
      refreshDash();
      // index.html opens any ?section= tab right after apply(); start
      // mirroring navigation into the address bar only after that.
      setTimeout(() => { urlSync = true; }, 0);
    },
  };
})();
