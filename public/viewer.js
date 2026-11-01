// ShowPilot viewer page client logic.

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const state = {
    mode: 'OFF',
    sequences: [],
    voteCounts: {},
    queue: [],
    hasVoted: false,
    // v0.32.6+: when allowVoteChange is true, the user can click another
    // song to switch their vote. votedFor tracks the current pick so we
    // can highlight it and no-op a click on the same song.
    allowVoteChange: false,
    votedFor: null,
    // Tracks the last round id we saw so we can clear hasVoted/votedFor
    // when the server advances past it. Without this, a user who voted
    // in round N would stay locked out for round N+1 until reload.
    lastKnownRoundId: null,
    serverRequirements: { requiresLocation: false },
  };

  async function fetchState() {
    try {
      const res = await fetch('/api/state', { credentials: 'include' });
      const data = await res.json();
      applyState(data);
    } catch (e) {
      console.error('Failed to fetch state:', e);
    }
  }

  // Under Now Playing: "Artist"; after Up Next: " — Artist" (hidden when
  // the song has no artist). The inner element carries the data attribute.
  function setArtist(id, after, tag, text) {
    if (!after) return;
    let a = el(id);
    if (!a) {
      const wrap = document.createElement(tag);
      wrap.className = 'sp-artist';
      wrap.style.cssText = tag === 'div'
        ? 'font-size:0.9em;opacity:0.75;margin-top:0.15em'
        : 'opacity:0.75';
      a = document.createElement('span');
      a.id = id;
      a.setAttribute(id === 'nowPlayingArtist' ? 'data-showpilot-now-artist' : 'data-showpilot-next-artist', '');
      if (tag === 'span') wrap.append(' — ');
      wrap.appendChild(a);
      after.insertAdjacentElement('afterend', wrap);
    }
    const t = text || '';
    if (a.textContent !== t) a.textContent = t;
    a.parentElement.style.display = t ? '' : 'none';
  }

  function applyState(data) {
    el('showName').textContent = data.showName || 'Light Show';
    el('viewerCount').textContent = data.activeViewers || 0;
    el('nowPlayingName').textContent = data.nowPlaying
      ? (data.nowPlayingDisplayName || data.sequences.find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying)
      : '—';
    // v0.32.8+: Up Next is shown in all modes. Server computes nextScheduled
    // as the queue head in JUKEBOX, the current vote leader in VOTING, and
    // whatever the schedule reports otherwise. Display name lookup falls
    // back to the raw sequence name if the sequence isn't in the visible list
    // (cooldown / hidden) — fine, since the server still returns the name.
    const nextEl = el('nextUpName');
    if (nextEl) {
      nextEl.textContent = data.nextScheduled
        ? (data.nextScheduledDisplayName || data.sequences.find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled)
        : '—';
    }
    // Artists under Now Playing and after Up Next (v0.33.249+). Created here
    // rather than in viewer.html because the built-in page is copied into
    // the database once, so existing installs get them too.
    setArtist('nowPlayingArtist', el('nowPlayingName'), 'div', data.nowPlaying ? data.nowPlayingArtist : '');
    setArtist('nextUpArtist', nextEl, 'span', data.nextScheduled ? data.nextScheduledArtist : '');

    state.mode = data.viewerControlMode;
    state.sequences = data.sequences;
    state.categoryHeaders = data.categoryHeaders !== false;
    state.uncategorizedLabel = data.uncategorizedLabel || 'Other';
    state.voteCounts = Object.fromEntries((data.voteCounts || []).map(v => [v.sequence_name, v.count]));
    state.queue = data.queue || [];
    state.allowVoteChange = data.allowVoteChange === true;
    state.serverRequirements = { requiresLocation: data.requiresLocation === true };

    // Round-advance detection (v0.32.6+): when the server's currentVotingRound
    // changes, our local hasVoted/votedFor are stale. Clear them so the user
    // can vote in the new round without reloading. Mirrors the same logic in
    // rf-compat.js.
    if (typeof data.currentVotingRound === 'number') {
      if (state.lastKnownRoundId !== null && data.currentVotingRound !== state.lastKnownRoundId) {
        state.hasVoted = false;
        state.votedFor = null;
      }
      state.lastKnownRoundId = data.currentVotingRound;
    }

    // Listen Only (v0.33.249+): keep showing the last active mode's list,
    // with every button disabled.
    const shown = data.listDisplayMode || data.viewerControlMode;
    el('modeVoting').classList.toggle('hidden', shown !== 'VOTING');
    el('modeJukebox').classList.toggle('hidden', shown !== 'JUKEBOX');
    el('modeOff').classList.toggle('hidden', data.viewerControlMode !== 'OFF');

    if (shown === 'VOTING') renderVoteList();
    if (shown === 'JUKEBOX') renderJukeboxList();
    if (data.viewerControlMode === 'LISTEN') {
      document.querySelectorAll('#voteList button, #jukeboxList button').forEach(b => {
        b.disabled = true;
        b.title = 'Requests and voting are closed for now. You can still listen along!';
      });
    }
  }

  // Category headings. /api/state delivers sequences pre-grouped by
  // category; emit a heading <li> whenever the category changes. Returns a
  // function to call once per sequence, before appending its row.
  function categoryHeaderEmitter(list, seqs) {
    const on = state.categoryHeaders !== false &&
      seqs.some(s => s.category && String(s.category).trim());
    let prevKey = null;
    return function (seq) {
      if (!on) return;
      const label = (seq.category && String(seq.category).trim()) || state.uncategorizedLabel || 'Other';
      const key = label.toLowerCase();
      if (key === prevKey) return;
      prevKey = key;
      const li = document.createElement('li');
      li.className = 'sequence-category-header';
      li.setAttribute('data-showpilot-category', label);
      li.textContent = label;
      list.appendChild(li);
    };
  }

  // Song badge (New, Fan Favorite, ...) set on the Sequences page (v0.33.249+).
  function badgeHtml(seq) {
    const b = seq.badge ? String(seq.badge).trim() : '';
    return b ? ' <span class="sequence-badge">' + escapeHtml(b) + '</span>' : '';
  }

  function renderVoteList() {
    const list = el('voteList');
    list.innerHTML = '';
    const votableSeqs = state.sequences.filter(s => s.votable);
    const emitVoteHeader = categoryHeaderEmitter(list, votableSeqs);
    votableSeqs.forEach(seq => {
      emitVoteHeader(seq);
      const count = state.voteCounts[seq.name] || 0;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      // Disable buttons only when the user has voted AND can't shift.
      // When shifting is allowed, leave them all enabled so the user can
      // click a different song. The current pick is highlighted so it's
      // obvious which one their vote is on.
      btn.disabled = state.hasVoted && !state.allowVoteChange;
      if (state.votedFor === seq.name) btn.classList.add('voted');
      btn.innerHTML = `
        <span>${escapeHtml(seq.display_name)}${badgeHtml(seq)}${seq.artist ? ' — ' + escapeHtml(seq.artist) : ''}</span>
        <span class="vote-count">${count}</span>
      `;
      btn.onclick = () => vote(seq.name);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function renderJukeboxList() {
    const list = el('jukeboxList');
    list.innerHTML = '';
    // Sequences in cooldown are filtered out server-side (in /state) so
    // we don't need to render them as disabled — they simply aren't here.
    const jukeboxSeqs = state.sequences.filter(s => s.jukeboxable);
    const queuedPos = {};
    state.queue.forEach((q, i) => { if (!queuedPos[q.sequence_name]) queuedPos[q.sequence_name] = i + 1; });
    const emitJukeboxHeader = categoryHeaderEmitter(list, jukeboxSeqs);
    jukeboxSeqs.forEach(seq => {
      emitJukeboxHeader(seq);
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.innerHTML = `<span>${escapeHtml(seq.display_name)}${badgeHtml(seq)}${seq.artist ? ' — ' + escapeHtml(seq.artist) : ''}</span><span>${queuedPos[seq.name] ? 'Queued' : '+'}</span>`;
      // Already in the request queue (v0.33.249+).
      if (queuedPos[seq.name]) { btn.classList.add('queued'); li.classList.add('showpilot-queued'); }
      btn.onclick = () => addToQueue(seq.name);
      li.appendChild(btn);
      list.appendChild(li);
    });

    const q = el('queueList');
    q.innerHTML = '';
    state.queue.forEach(entry => {
      const seq = state.sequences.find(s => s.name === entry.sequence_name);
      const li = document.createElement('li');
      li.textContent = seq ? seq.display_name : entry.sequence_name;
      q.appendChild(li);
    });
  }

  // Cache GPS location once acquired (reused across votes/requests)
  let cachedLocation = null;

  // Get viewer location (if server requires it). Resolves with {lat, lng} or rejects.
  async function getViewerLocation() {
    if (cachedLocation) return cachedLocation;
    if (!navigator.geolocation) {
      throw new Error('Your browser does not support location. You may not be able to vote or request.');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(cachedLocation);
        },
        (err) => {
          const ua = navigator.userAgent || '';
          const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
          let msg = 'Could not get your location. Make sure Location is on, then try again.';
          if (/FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger/i.test(ua)) msg = 'This app\'s built-in browser won\'t share your location. Open this page in ' + (ios ? 'Safari' : 'Chrome') + ' and try again.';
          else if (err.code === 1) msg = ios
            ? 'Your iPhone blocked location for this page. Open Settings → Privacy & Security → Location Services, tap Safari Websites, choose "While Using the App", then reload this page.'
            : 'Location access was denied. Allow location for this site in your browser settings, then reload the page.';
          else if (err.code === 3) msg = 'Location request timed out. Try again.';
          reject(new Error(msg));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  // Build request body, attaching viewerLat/Lng if server says location is required
  async function buildBody(baseBody, data) {
    const body = { ...baseBody };
    if (data && data.requiresLocation) {
      const loc = await getViewerLocation();
      body.viewerLat = loc.lat;
      body.viewerLng = loc.lng;
    }
    return body;
  }

  async function vote(sequenceName) {
    // No-op if the user clicked the same song they already voted for.
    // (Server would also no-op, but skipping the round-trip keeps the
    // UI quiet and avoids a misleading "Vote cast" toast.)
    if (state.hasVoted && state.votedFor === sequenceName) return;
    let body;
    try {
      body = await buildBody({ sequenceName }, state.serverRequirements);
    } catch (e) {
      toast(e.message);
      return;
    }
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      state.hasVoted = true;
      state.votedFor = sequenceName;
      toast(data.shifted ? 'Vote changed!' : 'Vote cast!');
      renderVoteList();
    } else {
      toast(data.error || 'Vote failed');
    }
  }

  async function addToQueue(sequenceName) {
    let body;
    try {
      body = await buildBody({ sequenceName }, state.serverRequirements);
    } catch (e) {
      toast(e.message);
      return;
    }
    const res = await fetch('/api/jukebox/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      toast('Added to queue!');
      fetchState();
    } else {
      toast(data.error || 'Failed to add');
    }
  }

  async function heartbeat() {
    try {
      await fetch('/api/heartbeat', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {}
  }

  function toast(msg) {
    const prev = document.querySelector('.toast');
    if (prev) prev.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Initial load
  heartbeat();
  fetchState();

  // Socket.io live updates
  try {
    const socket = io();
    socket.on('nowPlaying', (data) => {
      // Only update from the list when the song is in it; otherwise wait for
      // fetchState() below (it carries the server's display name) instead
      // of flashing the raw file name.
      const seq = state.sequences.find(s => s.name === data.sequenceName);
      if (seq) el('nowPlayingName').textContent = seq.display_name;
      // Song change ⇒ next-up changes too. Fetch full state to refresh
      // the Up Next line + queue without a 30s wait.
      fetchState();
    });
    socket.on('voteUpdate', (data) => {
      state.voteCounts = Object.fromEntries(data.counts.map(v => [v.sequence_name, v.count]));
      if (state.mode === 'VOTING') {
        renderVoteList();
        // In voting mode, "next up" = current vote leader, which the
        // server recomputes on every vote. Refresh so the Up Next line
        // tracks live.
        fetchState();
      }
    });
    socket.on('queueUpdated', () => { fetchState(); });
    socket.on('nextScheduled', () => { fetchState(); });
    socket.on('viewerCount', (data) => { el('viewerCount').textContent = data.count || 0; });
  } catch (e) {
    console.warn('Socket.io unavailable; falling back to polling.');
  }

  // Heartbeat + state polling fallback
  setInterval(heartbeat, 15000);
  setInterval(fetchState, 30000);
})();
