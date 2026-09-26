// ShowPilot Cockpit tile catalog (main v0.33.214 / Lite v0.5.61).
//
// One definition of every tile the Cockpit can show. The Cockpit layout is
// a per-user list of { id, size } (PUT /api/admin/me/cockpit-layout); ids
// here, plus 'cat:<category name>' generated from the show's categories.
// Unknown ids in a saved layout are skipped, so tiles can be added or
// retired without breaking anyone's layout.
//
// Every setting a tile changes is already on the admin's PUT /config
// allow-list (routes/admin.js) — tiles never reach anything the admin
// itself can't. Kinds:
//   switch  on/off config key (or custom get/set)
//   seg     a few choices (buttons)        select  many choices (dropdown)
//   step    a number with − / +            action  button that asks to confirm
//   status  read-only value                now     current song panel
//   board   live standings / queue / song list
(function () {
  'use strict';

  const GROUPS = ['Show control', 'Safeguards', 'Songs & categories', 'Viewer page', 'Status'];

  const cfgSwitch = (id, group, label, key, hint) =>
    ({ id, group, label, kind: 'switch', key, hint, size: 1 });

  const STATIC = [
    // ---- Show control ----
    { id: 'nowPlaying', group: 'Show control', label: 'Now playing', kind: 'now', size: 4, hint: 'Current song, time left and what\u2019s next' },
    { id: 'viewerControl', group: 'Show control', label: 'Viewer control', kind: 'switch', size: 1, hint: 'Let visitors vote or request',
      get: (c) => (c.cfg.viewer_control_mode || 'OFF') !== 'OFF',
      set: (c, on) => SP.put('/config', { viewer_control_mode: on ? (c.cfg.last_active_mode && c.cfg.last_active_mode !== 'OFF' ? c.cfg.last_active_mode : 'VOTING') : 'OFF' }) },
    { id: 'mode', group: 'Show control', label: 'Mode', kind: 'seg', size: 2, hint: 'Off, Voting, Jukebox or Race',
      options: [['OFF', 'Off'], ['VOTING', 'Voting'], ['JUKEBOX', 'Jukebox'], ['RACE', 'Race']],
      get: (c) => c.cfg.viewer_control_mode || 'OFF',
      set: (c, v) => SP.put('/config', { viewer_control_mode: v }) },
    { id: 'liveBoard', group: 'Show control', label: 'Live standings', kind: 'board', board: 'live', size: 2, hint: 'Vote counts, queue or race taps' },
    { id: 'queueBoard', group: 'Show control', label: 'Request queue', kind: 'board', board: 'queue', size: 2, hint: 'Pending requests, with remove' },
    { id: 'resetVotes', group: 'Show control', label: 'Reset votes', kind: 'action', size: 1, path: '/reset-votes', done: 'Votes reset' },
    { id: 'purgeQueue', group: 'Show control', label: 'Purge queue', kind: 'action', size: 1, path: '/purge-queue', done: 'Queue purged' },
    { id: 'resetRace', group: 'Show control', label: 'Reset race', kind: 'action', size: 1, path: '/race/reset', done: 'Race reset' },

    // ---- Safeguards ----
    cfgSwitch('gate', 'Safeguards', 'Location check', 'check_viewer_present', 'Only nearby visitors can interact'),
    cfgSwitch('locationCode', 'Safeguards', 'Location code', 'location_code_enabled', 'Visitors enter the posted code'),
    cfgSwitch('oneVote', 'Safeguards', 'One vote per round', 'prevent_multiple_votes'),
    cfgSwitch('changeVote', 'Safeguards', 'Viewers can change vote', 'allow_vote_change'),
    cfgSwitch('tiebreak', 'Safeguards', 'Tiebreak rounds', 'tiebreak_enabled'),
    cfgSwitch('oneRequest', 'Safeguards', 'One request at a time', 'prevent_multiple_requests'),
    cfgSwitch('blockPlaying', 'Safeguards', 'Block requests for the playing song', 'block_request_currently_playing'),
    cfgSwitch('blockNext', 'Safeguards', 'Block requests for the next song', 'block_request_next_up'),
    { id: 'queueDepth', group: 'Safeguards', label: 'Queue depth', kind: 'step', size: 1, key: 'jukebox_queue_depth', min: 1, max: 50, hint: 'Most requests waiting at once' },
    { id: 'perViewer', group: 'Safeguards', label: 'Requests per viewer', kind: 'step', size: 1, key: 'viewer_request_limit', min: 1, max: 20 },

    // ---- Songs & categories ----
    { id: 'songList', group: 'Songs & categories', label: 'Songs', kind: 'board', board: 'songs', size: 2, hint: 'Show or hide each song' },
    cfgSwitch('cooldownFpp', 'Songs & categories', 'Skip cooled-down songs in FPP', 'cooldown_suppress_fpp_playlist', 'Also in FPP\u2019s normal playlist'),

    // ---- Viewer page ----
    { id: 'template', group: 'Viewer page', label: 'Viewer page template', kind: 'seg', size: 2, hint: 'Switch the active page',
      optionsFrom: (c) => (c.templates || []).slice(0, 4).map(t => [String(t.id), t.name]),
      get: (c) => { const a = (c.templates || []).find(t => t.is_active); return a ? String(a.id) : ''; },
      set: (c, v) => SP.post('/templates/' + encodeURIComponent(v) + '/activate') },
    { id: 'pageEffect', group: 'Viewer page', label: 'Page effect', kind: 'select', size: 1, key: 'page_effect',
      options: [['none', 'None'], ['snow', 'Snow'], ['leaves', 'Leaves'], ['fireworks', 'Fireworks'], ['hearts', 'Hearts'], ['stars', 'Stars'],
        ['bats', 'Bats'], ['confetti', 'Confetti'], ['petals', 'Petals'], ['embers', 'Embers'], ['bubbles', 'Bubbles'], ['rain', 'Rain']] },
    cfgSwitch('progressBar', 'Viewer page', 'Song progress bar', 'viewer_progress_bar'),
    cfgSwitch('translation', 'Viewer page', 'Translation', 'translation_enabled'),

    // ---- Status (read-only) ----
    { id: 'sWatching', group: 'Status', label: 'Watching now', kind: 'status', size: 1, value: (c) => String(c.stats.activeViewers ?? 0) },
    { id: 'sVotes', group: 'Status', label: 'Votes this round', kind: 'status', size: 1, value: (c) => String(c.stats.totalVotes ?? 0) },
    { id: 'sQueue', group: 'Status', label: 'Requests waiting', kind: 'status', size: 1, value: (c) => String(c.stats.queueLength ?? 0) },
    { id: 'sLeft', group: 'Status', label: 'Time left in song', kind: 'status', size: 1, live: true,
      value: (c) => { const v = c.vstate; if (!c.stats.nowPlaying || !v || !v.nowPlayingStartedAtIso || !v.nowPlayingDurationSeconds) return '--:--';
        return SP.fmtTime(v.nowPlayingDurationSeconds - (SP.serverNow() - Date.parse(v.nowPlayingStartedAtIso)) / 1000); } },
    { id: 'sFpp', group: 'Status', label: 'FPP', kind: 'status', size: 1, value: (c) => (c.fppOnline ? 'Online' : 'Offline') },
  ];

  function parseCategories(cfg) {
    try { const c = JSON.parse(cfg.sequence_categories || '[]'); return Array.isArray(c) ? c : []; } catch (_) { return []; }
  }

  // The full catalog for the current show: static tiles + one per category.
  function catalog(ctx) {
    const cats = parseCategories(ctx.cfg || {}).map(c => ({
      id: 'cat:' + c.name, group: 'Songs & categories', label: c.name, kind: 'switch', size: 1, hint: 'Song category on the viewer page',
      get: (cx) => { const x = parseCategories(cx.cfg).find(y => y.name === c.name); return !!x && x.enabled !== false; },
      set: (cx, on) => SP.post('/categories/enabled', { name: c.name, enabled: on }),
    }));
    return STATIC.concat(cats);
  }

  const DEFAULT_LAYOUT = [
    { id: 'nowPlaying', size: 4 },
    { id: 'viewerControl', size: 1 }, { id: 'mode', size: 2 }, { id: 'sWatching', size: 1 },
    { id: 'liveBoard', size: 2 }, { id: 'queueBoard', size: 2 },
    { id: 'gate', size: 1 }, { id: 'resetVotes', size: 1 }, { id: 'purgeQueue', size: 1 }, { id: 'sLeft', size: 1 },
  ];

  window.SPTiles = { GROUPS, catalog, DEFAULT_LAYOUT, parseCategories };
})();
