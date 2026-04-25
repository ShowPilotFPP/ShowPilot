// ============================================================
// OpenFalcon — Remote Falcon Compatibility Layer
//
// Provides the global functions that RF-style templates expect
// to call from inline onclick handlers, mapped to OpenFalcon's
// real API. Also handles showing the standard error message divs
// RF templates include (requestSuccessful, alreadyVoted, etc.)
// ============================================================

(function () {
  'use strict';

  const boot = window.__OPENFALCON__ || {};
  let cachedLocation = null;
  let hasVoted = false;

  // ======= Error/success message helpers =======
  // RF templates include divs with these IDs; we show the appropriate one.
  const MSG_IDS = {
    success: 'requestSuccessful',
    invalidLocation: 'invalidLocation',
    failed: 'requestFailed',
    alreadyQueued: 'requestPlaying',
    queueFull: 'queueFull',
    alreadyVoted: 'alreadyVoted',
  };

  function showMessage(id, durationMs) {
    const el = document.getElementById(id);
    if (!el) {
      console.warn('OpenFalcon compat: no element with id', id);
      return;
    }
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, durationMs || 3000);
  }

  function mapErrorToId(error) {
    const msg = (error || '').toLowerCase();
    if (msg.includes('location')) return MSG_IDS.invalidLocation;
    if (msg.includes('already voted')) return MSG_IDS.alreadyVoted;
    if (msg.includes('already') && (msg.includes('request') || msg.includes('queue'))) return MSG_IDS.alreadyQueued;
    if (msg.includes('queue is full') || msg.includes('full')) return MSG_IDS.queueFull;
    return MSG_IDS.failed;
  }

  // ======= GPS =======
  async function getLocation() {
    if (cachedLocation) return cachedLocation;
    if (!navigator.geolocation) {
      throw new Error('Location not supported');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(cachedLocation);
        },
        () => reject(new Error('Location required but denied')),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  async function buildBody(baseBody) {
    const body = { ...baseBody };
    if (boot.requiresLocation) {
      try {
        const loc = await getLocation();
        body.viewerLat = loc.lat;
        body.viewerLng = loc.lng;
      } catch (e) {
        showMessage(MSG_IDS.invalidLocation);
        throw e;
      }
    }
    return body;
  }

  // ======= API calls =======
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // Globals exposed to template onclick handlers
  window.OpenFalconVote = async function (sequenceName) {
    if (hasVoted) {
      showMessage(MSG_IDS.alreadyVoted);
      return;
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/vote', body);
    if (result.ok) {
      hasVoted = true;
      showMessage(MSG_IDS.success);
    } else {
      showMessage(mapErrorToId(result.data?.error));
    }
  };

  window.OpenFalconRequest = async function (sequenceName) {
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/jukebox/add', body);
    if (result.ok) {
      showMessage(MSG_IDS.success);
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error));
    }
  };

  // RF aliases in case templates call these names
  window.vote = window.OpenFalconVote;
  window.request = window.OpenFalconRequest;

  // ======= Live state refresh =======
  async function refreshState() {
    try {
      const res = await fetch('/api/state', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      applyStateUpdate(data);
    } catch {}
  }

  function applyStateUpdate(data) {
    // --- Vote counts ---
    if (data.voteCounts) {
      // First clear all existing counts to 0 so a removed vote drops visibly
      document.querySelectorAll('[data-seq-count]').forEach(el => {
        el.textContent = '0';
      });
      data.voteCounts.forEach(v => {
        const el = document.querySelector(`[data-seq-count="${v.sequence_name}"]`);
        if (el) el.textContent = v.count;
      });
    }

    // --- Reset "already voted" gate when a new round begins ---
    if (data.viewerControlMode === 'VOTING' && data.voteCounts && data.voteCounts.length === 0) {
      hasVoted = false;
    }

    // --- NOW_PLAYING text ---
    const nowEl = document.querySelector('.now-playing-text');
    if (nowEl) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      if (nowEl.textContent !== nowDisplay) nowEl.textContent = nowDisplay;
    }

    // --- NEXT_PLAYLIST text (RF templates use .body_text inside the jukebox container) ---
    // We can't reliably pick "the right" .body_text element without a data attribute,
    // so we tag it during render-time. Fall back: leave it alone.
    // In templates we render server-side, we add data-openfalcon-next to the NEXT_PLAYLIST spot.
    const nextEl = document.querySelector('[data-openfalcon-next]');
    if (nextEl) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      if (nextEl.textContent !== nextDisplay) nextEl.textContent = nextDisplay;
    }

    // --- Queue size & queue list ---
    const queueSizeEl = document.querySelector('[data-openfalcon-queue-size]');
    if (queueSizeEl) queueSizeEl.textContent = String((data.queue || []).length);

    const queueListEl = document.querySelector('[data-openfalcon-queue-list]');
    if (queueListEl) {
      const byName = Object.fromEntries((data.sequences || []).map(s => [s.name, s]));
      if ((data.queue || []).length === 0) {
        queueListEl.textContent = 'Queue is empty.';
      } else {
        queueListEl.innerHTML = data.queue.map(e => {
          const seq = byName[e.sequence_name];
          const name = seq ? seq.display_name : e.sequence_name;
          return escapeHtml(name);
        }).join('<br />');
      }
    }

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated.
    (data.sequences || []).forEach(seq => {
      if (!seq.image_url) return;
      const imgs = document.querySelectorAll(`img[data-seq-name="${CSS.escape(seq.name)}"]`);
      imgs.forEach(img => {
        if (img.getAttribute('src') !== seq.image_url) {
          img.setAttribute('src', seq.image_url);
        }
      });
    });

    // --- Mode container visibility ---
    document.querySelectorAll('[data-openfalcon-container="jukebox"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'JUKEBOX' ? '' : 'none';
    });
    document.querySelectorAll('[data-openfalcon-container="voting"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'VOTING' ? '' : 'none';
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Heartbeat (for active viewer count)
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  }, 15000);

  // Poll state every 3s for live updates (Socket.io provides instant updates too)
  setInterval(refreshState, 3000);

  // Initial heartbeat + immediate state refresh
  fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  refreshState();

  // Try Socket.io if available for instant updates
  try {
    if (window.io) {
      const socket = window.io();
      socket.on('voteUpdate', () => refreshState());
      socket.on('queueUpdated', () => refreshState());
      socket.on('nowPlaying', () => refreshState());
      socket.on('voteReset', () => { hasVoted = false; refreshState(); });
      socket.on('sequencesReordered', () => refreshState()); // covers updated, sequences edited, etc.
      socket.on('sequencesSynced', () => refreshState());
    }
  } catch {}

  // ============================================================
  // LISTEN ON PHONE — optional in-browser audio player
  //
  // Toggleable floating button + bottom sheet. When enabled, polls
  // /api/now-playing-audio for the active sequence + elapsed time, then
  // streams the audio via /api/audio-stream/<seq>. Seeks forward to match
  // FPP's playback position so users hear the song approximately in sync
  // with the lights — within a second or two on good networks.
  //
  // NOT a perfect-sync solution (no continuous time correction). Sufficient
  // for "I'm in the driveway and the radio sucks" — a useful fallback.
  // ============================================================
  (function initListenOnPhone() {
    const btn = document.createElement('button');
    btn.id = 'of-listen-btn';
    btn.setAttribute('aria-label', 'Listen on phone');
    btn.title = 'Listen on phone';
    btn.innerHTML = '🎧';
    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(220,38,38,0.95); color: white;
      border: 2px solid rgba(255,255,255,0.4);
      font-size: 24px; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: transform 0.15s, background 0.15s;
      padding: 0; line-height: 1;
    `;
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };

    const panel = document.createElement('div');
    panel.id = 'of-listen-panel';
    panel.style.cssText = `
      position: fixed; bottom: 78px; right: 16px; z-index: 9999;
      width: min(340px, calc(100vw - 32px));
      background: rgba(20,20,30,0.96); color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px; padding: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 14px; line-height: 1.4;
      display: none;
    `;
    panel.innerHTML = `
      <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 10px;">
        <img id="of-listen-cover" src="" alt="" style="width: 56px; height: 56px; border-radius: 6px; object-fit: cover; background: #333; flex-shrink: 0;" />
        <div style="flex: 1; min-width: 0;">
          <div id="of-listen-title" style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Not playing</div>
          <div id="of-listen-artist" style="font-size: 12px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></div>
        </div>
        <button id="of-listen-close" aria-label="Close" style="background: transparent; border: 0; color: #aaa; font-size: 22px; cursor: pointer; padding: 0; line-height: 1;">×</button>
      </div>
      <audio id="of-listen-audio" controls style="width: 100%; height: 36px; margin-bottom: 8px;"></audio>
      <div id="of-listen-status" style="font-size: 11px; color: #888; text-align: center; min-height: 14px;"></div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    const audio = panel.querySelector('#of-listen-audio');
    const titleEl = panel.querySelector('#of-listen-title');
    const artistEl = panel.querySelector('#of-listen-artist');
    const coverEl = panel.querySelector('#of-listen-cover');
    const statusEl = panel.querySelector('#of-listen-status');
    const closeBtn = panel.querySelector('#of-listen-close');

    let panelOpen = false;
    let pollTimer = null;
    let currentSequence = null;
    let userSeeking = false;

    btn.onclick = () => {
      panelOpen = !panelOpen;
      panel.style.display = panelOpen ? 'block' : 'none';
      if (panelOpen) startPolling();
      else stopPolling();
    };
    closeBtn.onclick = () => { btn.click(); };

    audio.addEventListener('seeking', () => { userSeeking = true; });
    audio.addEventListener('seeked', () => { setTimeout(() => { userSeeking = false; }, 500); });

    async function startPolling() {
      await syncToNowPlaying();
      pollTimer = setInterval(syncToNowPlaying, 5000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      currentSequence = null;
    }

    async function syncToNowPlaying() {
      try {
        const r = await fetch('/api/now-playing-audio', { credentials: 'include' });
        if (!r.ok) {
          statusEl.textContent = 'Server error fetching audio info';
          return;
        }
        const data = await r.json();

        if (!data.playing || !data.hasAudio) {
          titleEl.textContent = data.playing ? (data.sequenceName || 'Playing — no audio') : 'Not playing';
          artistEl.textContent = '';
          coverEl.src = '';
          statusEl.textContent = data.playing ? 'No audio file linked to this sequence' : 'Show is not playing';
          if (currentSequence) {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            currentSequence = null;
          }
          return;
        }

        // New song — switch streams and seek to elapsed position
        if (data.sequenceName !== currentSequence) {
          currentSequence = data.sequenceName;
          titleEl.textContent = data.displayName || data.sequenceName;
          artistEl.textContent = data.artist || '';
          coverEl.src = data.imageUrl || '';
          coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';
          statusEl.textContent = 'Loading audio…';

          audio.src = data.streamUrl;
          // Wait for metadata before seeking — required by browser audio API
          audio.addEventListener('loadedmetadata', function onMeta() {
            audio.removeEventListener('loadedmetadata', onMeta);
            try {
              if (data.elapsedSec > 0 && data.elapsedSec < (audio.duration || Infinity)) {
                audio.currentTime = data.elapsedSec;
              }
            } catch (e) {}
            audio.play().catch(err => {
              statusEl.textContent = 'Tap play to start audio';
            });
          }, { once: true });
          audio.addEventListener('canplay', () => {
            statusEl.textContent = '';
          }, { once: true });
        } else if (!userSeeking && audio.paused === false) {
          // Same song, drift correction: if our position is more than 3s off
          // from server's elapsed, gently snap to it. Skipped if user is seeking.
          const drift = Math.abs(audio.currentTime - data.elapsedSec);
          if (drift > 3 && data.elapsedSec < (audio.duration || Infinity)) {
            audio.currentTime = data.elapsedSec;
          }
        }
      } catch (err) {
        statusEl.textContent = 'Network error — retrying…';
      }
    }
  })();
})();
