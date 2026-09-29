// ============================================================
// ShowPilot — Remote Falcon Compatibility Layer
//
// Provides the global functions that RF-style templates expect
// to call from inline onclick handlers, mapped to ShowPilot's
// real API. Also handles showing the standard error message divs
// RF templates include (requestSuccessful, alreadyVoted, etc.)
// ============================================================

(function () {
  'use strict';

  const boot = window.__SHOWPILOT__ || {};
  let cachedLocation = null;
  let hasVoted = false;
  // Vote shifting (v0.32.6+): when allowVoteChange is true, a user who has
  // already voted can click another song to switch. Track which song they
  // last voted for so we can no-op a click on the same one and show
  // friendlier feedback ("Vote changed" vs. "Vote cast").
  // allowVoteChange is read from boot first and refreshed on every /api/state.
  let votedFor = null;
  let allowVoteChange = !!boot.allowVoteChange;
  // Last-known voting round id, refreshed on every /api/state response.
  // When this changes (server advanced past our vote), we clear hasVoted
  // so the user can vote in the new round. Backup mechanism for
  // voteReset socket events that may be missed on mobile when the
  // socket dies during backgrounding.
  let lastKnownRoundId = null;
  // Show name as last seen from the server. When this changes, we update
  // document.title — but only if the title currently matches what we last
  // saw, so a template that hard-coded its own <title> isn't stomped on.
  let lastKnownShowName = null;
  // Tiebreak state — separate from main-round vote tracking. A user who
  // voted in the main round can still cast a tiebreak vote; this flag
  // tracks the latter independently.
  let hasTiebreakVoted = false;
  // Active tiebreak metadata. Populated by socket event 'tiebreakStarted'
  // OR by /api/state when reconnecting mid-tiebreak (page reload during
  // a tiebreak window). Null when no tiebreak is in progress.
  let tiebreakState = null; // { candidates: [{sequenceName,...}], deadline_ms }
  let tiebreakCountdownTimer = null;

  // Now-playing timer (v0.32.9+).
  // RF compatibility: implements the {NOW_PLAYING_TIMER} placeholder
  // (countdown of remaining time in the current sequence). The renderer
  // emits <span data-showpilot-timer> elements with initial server-computed
  // text; this code ticks them client-side once a second. State is the
  // server-anchored start time + duration. When either is missing, the
  // ticker writes --:--; once remaining hits zero, it writes 0:00 and
  // stops updating until /api/state reports a new song.
  //
  // We deliberately do NOT use the audio engine's clock-sync (clockOffset)
  // here. The timer ticks at second granularity; sub-second sync isn't
  // visible. Avoiding the dependency keeps this code module-isolated and
  // works even when audio is disabled.
  let timerStartedAtMs = null;     // ms epoch when the song started (server's clock)
  let timerDurationSec = null;     // seconds, total length
  let timerInterval = null;        // setInterval handle
  // v0.33.206: estimated (server clock − this device's clock), from the
  // serverNowMs in /api/state responses. Keeps {NOW_PLAYING_TIMER} and the
  // progress bar right on phones whose clock is off. Lowest-round-trip
  // sample of the last few polls wins (least network asymmetry).
  let viewerClockOffsetMs = 0;
  let clockSamples = [];           // [{ rtt, offset }]
  function serverNowMs() { return Date.now() + viewerClockOffsetMs; }
  // Rough seed from the page's bootstrap (off by however long the page took
  // to arrive); the first /api/state poll replaces it with a timed sample.
  if (typeof boot.serverNowMs === 'number' && isFinite(boot.serverNowMs)) {
    viewerClockOffsetMs = boot.serverNowMs - Date.now();
  }
  function noteServerTime(serverMs, sentAt, receivedAt) {
    if (typeof serverMs !== 'number' || !isFinite(serverMs)) return;
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || rtt > 10000) return;
    clockSamples.push({ rtt, offset: serverMs - (sentAt + receivedAt) / 2 });
    if (clockSamples.length > 8) clockSamples.shift();
    let best = clockSamples[0];
    for (const c of clockSamples) if (c.rtt < best.rtt) best = c;
    viewerClockOffsetMs = best.offset;
  }

  // ======= Error/success message helpers =======
  // RF templates include divs with these IDs; we show the appropriate one.
  // Vote-specific success goes to #voteSuccessful when present (so templates
  // can word it differently from the jukebox "Successfully Added"); falls
  // back to #requestSuccessful for templates that don't define a separate
  // vote message. This keeps backward compatibility with all imported RF
  // templates while letting newer templates differentiate the two flows.
  const MSG_IDS = {
    success: 'requestSuccessful',
    voteSuccess: 'voteSuccessful',
    invalidLocation: 'invalidLocation',
    invalidLocationCode: 'invalidLocationCode',
    failed: 'requestFailed',
    alreadyQueued: 'requestPlaying',
    queueFull: 'queueFull',
    alreadyVoted: 'alreadyVoted',
    songPlaying: 'songPlaying',
    songNextUp:  'songNextUp',
  };

  function showMessage(id, durationMs, textOverride, fallbackText) {
    let el = document.getElementById(id);
    let usedFallback = false;
    // Fallback: if a vote-specific success isn't defined in this template,
    // use the generic success element. Some templates only have one.
    if (!el && id === MSG_IDS.voteSuccess) {
      el = document.getElementById(MSG_IDS.success);
      usedFallback = true;
    }
    // Fallback: if a specific error element isn't in this template (e.g. code-mode
    // or imported RF templates that predate these IDs), show #requestFailed with
    // the actual server error text so the user gets a meaningful message.
    if (!el && fallbackText) {
      el = document.getElementById(MSG_IDS.failed);
      if (el) textOverride = fallbackText;
    }
    if (!el) {
      console.warn('[ShowPilot] no element with id', id, '— message could not be displayed');
      return;
    }
    // If we fell back from voteSuccess to requestSuccess, override the
    // text so the user doesn't see jukebox wording ("Successfully Added")
    // for a vote action. We stash the original HTML the first time we
    // override so the element returns to its original wording for
    // subsequent jukebox successes (templates may use the same element
    // for both, just changing wording per-action).
    //
    // Templates with their own #voteSuccessful div get whatever wording
    // they put inside it; this only kicks in for templates that don't
    // define one. textOverride lets callers pass custom wording too.
    const desiredText = textOverride || (
      (id === MSG_IDS.voteSuccess || (usedFallback && id === MSG_IDS.voteSuccess))
        ? 'You\'ve Successfully Voted! 🗳️'
        : null
    );
    if (desiredText) {
      if (!el.__showpilotOriginalHtml) {
        el.__showpilotOriginalHtml = el.innerHTML;
      }
      el.textContent = desiredText;
    } else if (el.__showpilotOriginalHtml) {
      // Restore original wording for non-vote uses of the same element
      el.innerHTML = el.__showpilotOriginalHtml;
    }
    el.style.display = 'block';
    // Tap-to-dismiss: most templates style these as floating overlays
    // with cursor: pointer, but no actual click handler. Add one so
    // users who tap the message can dismiss it immediately rather than
    // wait for the timeout. Idempotent — set once per element.
    if (!el.__showpilotDismissBound) {
      el.addEventListener('click', () => { el.style.display = 'none'; });
      el.__showpilotDismissBound = true;
    }
    if (el.__showpilotHideTimer) clearTimeout(el.__showpilotHideTimer);
    el.__showpilotHideTimer = setTimeout(() => {
      el.style.display = 'none';
    }, durationMs || 3000);
  }

  function mapErrorToId(error, data) {
    // Server explicitly flags code failures (v0.33.24+) — use the dedicated toast.
    if (data && data.invalidLocationCode) return MSG_IDS.invalidLocationCode;
    const msg = (error || '').toLowerCase();
    if (msg.includes('access code')) return MSG_IDS.invalidLocationCode;
    if (msg.includes('location')) return MSG_IDS.invalidLocation;
    if (msg.includes('already voted')) return MSG_IDS.alreadyVoted;
    if (msg.includes('already') && (msg.includes('request') || msg.includes('queue'))) return MSG_IDS.alreadyQueued;
    if (msg.includes('queue is full') || msg.includes('full')) return MSG_IDS.queueFull;
    if (msg.includes('playing right now')) return MSG_IDS.songPlaying;
    if (msg.includes('already up next')) return MSG_IDS.songNextUp;
    return MSG_IDS.failed;
  }

  // ======= Now-playing timer ({NOW_PLAYING_TIMER}) =======
  // Format remaining seconds as m:ss. Negative/NaN → 0:00 (timer expired).
  // null → --:-- (no song or duration unknown). Matches RF's display.
  function formatTimerText(remainingSec) {
    if (remainingSec === null || !isFinite(remainingSec)) return '--:--';
    const sec = Math.max(0, Math.floor(remainingSec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // Update every <span data-showpilot-timer> on the page with the current
  // remaining-time text. Called from the 1-second interval AND once
  // immediately on each /api/state poll (in case the song changed and the
  // tick is up to a second away from firing). Idempotent.
  function paintTimer() {
    const els = document.querySelectorAll('[data-showpilot-timer]');
    const bars = document.querySelectorAll('[data-showpilot-progress]');
    if (!els.length && !bars.length) return; // nothing on the page to update
    let text;
    let frac = null;
    if (timerStartedAtMs === null || timerDurationSec === null) {
      text = '--:--';
    } else {
      const elapsedSec = (serverNowMs() - timerStartedAtMs) / 1000;
      text = formatTimerText(timerDurationSec - elapsedSec);
      frac = Math.min(1, Math.max(0, elapsedSec / timerDurationSec));
    }
    els.forEach(el => { if (el.textContent !== text) el.textContent = text; });
    // Progress bars (v0.33.206+): fixed bar and {NOW_PLAYING_PROGRESS}.
    bars.forEach(bar => {
      bar.classList.toggle('sp-progress--idle', frac === null);
      const fill = bar.querySelector('.sp-progress-fill');
      if (fill) fill.style.width = (frac === null ? 0 : Math.round(frac * 1000) / 10) + '%';
      const tEl = bar.querySelector('[data-showpilot-progress-time]');
      if (tEl && tEl.textContent !== text) tEl.textContent = text;
      bar.setAttribute('aria-valuenow', frac === null ? '0' : String(Math.round(frac * 100)));
    });
    if (typeof placeProgressBar === 'function') placeProgressBar();
  }

  // ======= Song progress bar (v0.33.206+, placement v0.33.207+) =======
  // Admin setting: a slim bar with time left on every viewer page regardless
  // of template. Placement:
  //   'player' (default) — sits on the top edge of the Listen-on-Phone player
  //       while it's open; when the player is closed/minimized (or the build
  //       has no player, e.g. ShowPilot-Lite) it sits on the bottom edge of
  //       the screen instead.
  //   'top' — a strip across the top of the screen (stored 'screen-top').
  // Color: the admin override if set, else the player's theme accent
  // (--of-border of an of-theme-* decoration), else a light default. Custom
  // player colors only change the background (--of-border stays a faint
  // default), so they fall through to the light default.
  // Templates can instead place {NOW_PLAYING_PROGRESS}; both share
  // paintTimer() and the CSS below (overridable: .sp-progress,
  // .sp-progress-track, .sp-progress-fill, .sp-progress-time,
  // --sp-progress-color).
  let lastProgressCfgKey = null;
  let progressCfg = null;
  function ensureProgressStyles() {
    if (document.getElementById('sp-progress-styles')) return;
    const st = document.createElement('style');
    st.id = 'sp-progress-styles';
    st.textContent =
      '.sp-progress{--sp-progress-color:#f5f5f5;display:flex;align-items:center;gap:10px;box-sizing:border-box;' +
        'font:600 13px/1 system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;color:#fff;transition:opacity .3s}' +
      '.sp-progress-track{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.22);overflow:hidden}' +
      '.sp-progress-fill{height:100%;width:0;border-radius:999px;background:var(--sp-progress-color);transition:width 1s linear}' +
      '.sp-progress--idle{opacity:0}' +
      '.sp-progress--inline{width:100%;color:inherit}' +
      '.sp-progress--inline .sp-progress-track{background:rgba(127,127,127,.3)}' +
      // Top-of-screen strip
      '.sp-progress--fixed{position:fixed;left:0;right:0;z-index:9990;padding:8px 14px;pointer-events:none;' +
        'background:rgba(10,10,14,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
      '.sp-progress--top{top:0;padding-top:calc(8px + env(safe-area-inset-top,0px))}' +
      '.sp-progress--fixed.sp-progress--no-time{padding-top:0;padding-bottom:0;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none}' +
      '.sp-progress--fixed.sp-progress--no-time .sp-progress-track{height:4px;border-radius:0;background:rgba(127,127,127,.25)}' +
      '.sp-progress--fixed.sp-progress--no-time .sp-progress-fill{border-radius:0}' +
      // Edge bar: on the player's top edge, or the screen's bottom edge
      '.sp-progress--edge{left:0;right:0;height:4px;padding:0;pointer-events:none;display:block}' +
      '.sp-progress--edge .sp-progress-track{height:4px;border-radius:0;background:rgba(127,127,127,.28)}' +
      '.sp-progress--edge .sp-progress-fill{border-radius:0}' +
      '.sp-progress--edge .sp-progress-time{position:absolute;bottom:calc(100% + 6px);padding:4px 9px;border-radius:999px;' +
        'font-size:12px;background:rgba(10,10,14,.78);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
      '.sp-progress--onplayer{position:absolute;top:0;z-index:3}' +
      '.sp-progress--onplayer .sp-progress-time{right:12px}' +
      '.sp-progress--screenbottom{position:fixed;bottom:env(safe-area-inset-bottom,0px);z-index:9990}' +
      '.sp-progress--screenbottom .sp-progress-time{left:10px}' +
      '.sp-progress--no-time .sp-progress-time{display:none}' +
      '@media (prefers-reduced-motion:reduce){.sp-progress-fill{transition:none}}';
    document.head.appendChild(st);
  }
  // The player's theme accent, or '' when no decoration theme is active.
  function playerThemeColor() {
    const panel = document.getElementById('of-listen-panel');
    if (!panel || !/(^|\s)of-theme-/.test(panel.className)) return '';
    try { return (getComputedStyle(panel).getPropertyValue('--of-border') || '').trim(); } catch (_) { return ''; }
  }
  function playerIsOpen() {
    const panel = document.getElementById('of-listen-panel');
    return !!(panel && panel.style.display !== 'none' && panel.style.transform !== 'translateY(100%)');
  }
  // Put the bar in the right place and color. Cheap; runs every paint tick
  // and on player open/close/theme events.
  function placeProgressBar() {
    const cfg = progressCfg;
    const bar = document.getElementById('sp-progress-fixed');
    const color = (cfg && cfg.color) || playerThemeColor();
    document.querySelectorAll('[data-showpilot-progress]').forEach(el => {
      if (color) {
        if (el.style.getPropertyValue('--sp-progress-color') !== color) el.style.setProperty('--sp-progress-color', color);
      } else if (el.style.getPropertyValue('--sp-progress-color')) {
        el.style.removeProperty('--sp-progress-color');
      }
    });
    if (!bar || !cfg) return;
    const idle = bar.classList.contains('sp-progress--idle') ? ' sp-progress--idle' : '';
    const noTime = cfg.showTime ? '' : ' sp-progress--no-time';
    let placement, parent;
    if (cfg.position === 'top') {
      placement = 'sp-progress--fixed sp-progress--top';
      parent = document.body;
    } else if (playerIsOpen()) {
      placement = 'sp-progress--edge sp-progress--onplayer';
      parent = document.getElementById('of-listen-panel');
    } else {
      placement = 'sp-progress--edge sp-progress--screenbottom';
      parent = document.body;
    }
    if (bar.parentNode !== parent) parent.appendChild(bar);
    const cls = 'sp-progress ' + placement + noTime + idle;
    if (bar.className !== cls) bar.className = cls;
  }
  window.addEventListener('showpilot:player-mode', () => placeProgressBar());
  window.addEventListener('showpilot:player-theme', () => placeProgressBar());
  function applyProgressBarConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const key = JSON.stringify(cfg);
    if (key === lastProgressCfgKey) return;
    lastProgressCfgKey = key;
    progressCfg = cfg;
    ensureProgressStyles();
    let bar = document.getElementById('sp-progress-fixed');
    if (!cfg.enabled) {
      if (bar) bar.remove();
      placeProgressBar(); // still colors inline {NOW_PLAYING_PROGRESS} bars
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sp-progress-fixed';
      bar.className = 'sp-progress sp-progress--idle';
      bar.setAttribute('data-showpilot-progress', '');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Song progress');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.innerHTML = '<div class="sp-progress-track"><div class="sp-progress-fill"></div></div>' +
        '<span class="sp-progress-time" data-showpilot-progress-time>--:--</span>';
      document.body.appendChild(bar);
    }
    placeProgressBar();
    if (timerInterval === null) timerInterval = setInterval(paintTimer, 1000);
    paintTimer();
  }

  // Update the anchor values from a /api/state response (or bootstrap).
  // We accept ISO string + duration in seconds. When the song or its anchor
  // changes, we replace state and immediately re-paint so the user doesn't
  // see a stale value for up to a second. The 1-second interval is started
  // on first call and lives for the page lifetime — cheap and ensures we
  // don't miss updates if a /api/state poll is delayed.
  function updateTimerFromState(startedAtIso, durationSeconds) {
    const newStartMs = startedAtIso ? Date.parse(startedAtIso) : null;
    const newDurSec = (typeof durationSeconds === 'number' && isFinite(durationSeconds) && durationSeconds > 0)
      ? durationSeconds : null;
    // Only re-paint when something actually changed — avoids a textContent
    // write per /api/state poll for songs that haven't changed.
    if (newStartMs !== timerStartedAtMs || newDurSec !== timerDurationSec) {
      timerStartedAtMs = newStartMs && isFinite(newStartMs) ? newStartMs : null;
      timerDurationSec = newDurSec;
      paintTimer();
    }
    // Lazy-start the interval. Once running, it stays running for the
    // page lifetime — there's no benefit to stopping it (it does nothing
    // when there's no [data-showpilot-timer] on the page anyway).
    if (timerInterval === null && document.querySelector('[data-showpilot-timer], [data-showpilot-progress]')) {
      timerInterval = setInterval(paintTimer, 1000);
    }
  }
  // Seed from bootstrap so the timer is correct before the first poll.
  // boot.nowPlayingStartedAtIso / nowPlayingDurationSeconds are set by
  // viewer-renderer.js when a song is currently playing.
  if (boot.nowPlayingStartedAtIso || boot.nowPlayingDurationSeconds) {
    updateTimerFromState(boot.nowPlayingStartedAtIso, boot.nowPlayingDurationSeconds);
  }
  // Inline {NOW_PLAYING_PROGRESS} needs the styles even with the setting off.
  if (document.querySelector('[data-showpilot-progress]')) ensureProgressStyles();
  if (boot.progressBar) {
    if (document.body) applyProgressBarConfig(boot.progressBar);
    else document.addEventListener('DOMContentLoaded', () => applyProgressBarConfig(boot.progressBar));
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

  // Force-fresh location fetch — used by the audio gate at the moment the
  // user taps the player button. Bypasses the browser's position cache
  // (maximumAge: 0) so we get the user's CURRENT physical location, not
  // a cached reading from when they were elsewhere. This is the copyright
  // safeguard: even if they granted permission earlier at home and drove
  // to the show, or vice versa, this re-evaluates from scratch.
  function getFreshLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location not supported on this device'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          cachedLocation = loc; // update cache for follow-up requests
          resolve(loc);
        },
        (err) => {
          // Translate browser error codes to friendly messages
          let msg = 'Location required to listen';
          if (err.code === 1) msg = 'Location permission denied. Audio is restricted to listeners present at the show.';
          else if (err.code === 2) msg = 'Could not determine your location.';
          else if (err.code === 3) msg = 'Location lookup timed out.';
          reject(new Error(msg));
        },
        // maximumAge: 0 forces a brand-new GPS reading every tap.
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  // Best-effort location fetch. Used by interaction endpoints (vote/jukebox)
  // that already have their own location-required logic. NOT used by the
  // audio gate — that uses getFreshLocation() above for stricter checks.
  function tryGetLocationSilently() {
    if (cachedLocation || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      },
      () => { /* silently ignore */ },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  // ============================================================
  // Haversine distance — copy of the server's calculation so the player can
  // do client-side proximity checks without a round trip. Used by the
  // continuous watchPosition watcher started in startup() to react in
  // seconds when a listener walks/drives away from the show, instead of
  // waiting for the periodic server re-check to fire.
  //
  // Server is still authoritative — every audio-stream request goes through
  // the server-side gate too, and the periodic re-check stays as a fallback
  // for tampered clients and GPS outages. This is just a fast first line.
  // ============================================================
  function haversineMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8; // Earth radius in miles
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Build query string with viewer location for endpoints that need it
  function locationQuery() {
    if (!cachedLocation) return '';
    return `?lat=${encodeURIComponent(cachedLocation.lat)}&lng=${encodeURIComponent(cachedLocation.lng)}`;
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
    // Location code (v0.33.24+): read from #locationCodeInput if present.
    // Always include when requiresLocationCode so the server can validate;
    // silently omit on installs where the feature is off.
    if (boot.requiresLocationCode) {
      const codeEl = document.getElementById('locationCodeInput');
      body.locationCode = codeEl ? codeEl.value.trim() : '';
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
  window.ShowPilotVote = async function (sequenceName) {
    // If a tiebreak is in progress, route through the tiebreak path
    // instead. Voting for a candidate goes via /api/tiebreak-vote;
    // voting for a non-candidate is rejected with a clear message.
    if (tiebreakState) {
      const candidateNames = tiebreakState.candidates.map(c => c.sequenceName);
      if (candidateNames.includes(sequenceName)) {
        return window.ShowPilotTiebreakVote(sequenceName);
      } else {
        // Non-candidate vote during tiebreak. Show a clear message.
        // Falls back to alreadyVoted message id since most templates
        // have it, with text users will recognize as "voting blocked."
        showMessage(MSG_IDS.alreadyVoted);
        return;
      }
    }
    if (hasVoted) {
      // Vote shifting: if the admin allows changing votes, let the click
      // through so the server can swap. Otherwise the existing block.
      if (!allowVoteChange) {
        showMessage(MSG_IDS.alreadyVoted);
        return;
      }
      // No-op: user clicked the same song they already voted for. Don't
      // round-trip; just acknowledge silently. (We could show "still
      // voted!" but that risks looking buggy.)
      if (votedFor === sequenceName) {
        return;
      }
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/vote', body);
    if (result.ok) {
      hasVoted = true;
      votedFor = sequenceName;
      // Vote-specific success message. showMessage falls back to the
      // generic #requestSuccessful element if #voteSuccessful isn't
      // defined in the active template (backward compat for RF imports).
      // On a successful shift, override the text so users understand
      // their vote moved rather than "you've already voted."
      if (result.data && result.data.shifted) {
        showMessage(MSG_IDS.voteSuccess, undefined, 'Vote changed! 🗳️');
      } else {
        showMessage(MSG_IDS.voteSuccess);
      }
      // (v0.32.11+) Refresh state immediately so the count cell updates
      // the moment the server acks the vote, regardless of socket health.
      // Without this, count updates rely entirely on the voteUpdate
      // socket event reaching the browser — which is fast on a healthy
      // connection but unreliable behind some proxies or when socket.io
      // can't establish (mixed-content, blocked WebSockets, etc.). The
      // 3-second poll loop catches it eventually but feels broken to a
      // user clicking and watching a counter that doesn't move. Mirrors
      // ShowPilotRequest's behavior, which has always done this.
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data), undefined, undefined, result.data?.error);
    }
  };

  window.ShowPilotRequest = async function (sequenceName) {
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/jukebox/add', body);
    if (result.ok) {
      showMessage(MSG_IDS.success);
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data), undefined, undefined, result.data?.error);
    }
  };

  // ======= Public template API aliases =======
  // ShowPilot's canonical names are ShowPilotRequest / ShowPilotVote, but
  // we expose every alias a viewer template might call so that:
  //   1. Existing templates written for the old "OpenFalcon" name keep working
  //   2. Imported Remote Falcon templates work unmodified — RF's own JS
  //      exposed `RemoteFalconRequest` / `RemoteFalconVote` plus generic
  //      `request` / `vote`. We honor all of those.
  // Removing any alias would break user-facing templates with no warning,
  // so this list is append-only.
  window.OpenFalconRequest = window.ShowPilotRequest;
  window.OpenFalconVote = window.ShowPilotVote;
  window.RemoteFalconRequest = window.ShowPilotRequest;
  window.RemoteFalconVote = window.ShowPilotVote;
  window.vote = window.ShowPilotVote;
  window.request = window.ShowPilotRequest;

  // ======= Live state refresh =======
  async function refreshState() {
    try {
      const sentAt = Date.now();
      const res = await fetch('/api/state', { credentials: 'include' });
      const receivedAt = Date.now(); // headers in; before parsing the body
      if (!res.ok) return;
      const data = await res.json();
      noteServerTime(data.serverNowMs, sentAt, receivedAt);
      applyStateUpdate(data);
    } catch {}
  }

  function applyStateUpdate(data) {
    // --- Vote counts ---
    if (data.voteCounts) {
      // Two attributes carry the count per row: [data-seq-count] on the
      // canonical-RF .cell-vote element, and [data-seq-votes] on the
      // RF Page Builder .sequence-votes span. Templates may style either
      // (or both), so live updates must hit both.
      // First clear all existing counts to 0 so a removed vote drops visibly
      const allCells = document.querySelectorAll('[data-seq-count], [data-seq-votes]');
      allCells.forEach(el => {
        el.textContent = '0';
      });
      // Build a name → cell map by reading the actual attribute values
      // back from the DOM. This avoids the CSS attribute-selector pitfall
      // where names with quotes, brackets, or other special chars don't
      // match — getAttribute returns the un-escaped value, so a direct
      // string compare always works regardless of how the attribute was
      // serialized in the HTML.

      // (array map, updates all matching elements). This is to fix a bug
      // where votes for songs are rendered on the first instance of the
      // voting div for a song only. There are 2 instances of those divs
      // (one for jukebox mode, one for voting mode) and the counts only
      // update on the first one. By building a map of all cells by name,
      // we can update all of them correctly.
      const cellsByName = {};
      allCells.forEach(el => {
          const n = el.getAttribute('data-seq-count') || el.getAttribute('data-seq-votes');
          if (n) {
              if (!cellsByName[n]) cellsByName[n] = [];
              cellsByName[n].push(el);
          }
      });
      data.voteCounts.forEach(v => {
          const els = cellsByName[v.sequence_name];
          if (els) els.forEach(el => { el.textContent = String(v.count); });
      });
    }

    // --- Reset "already voted" gate when the round id changes ---
    // Round-id check is the backup for voteReset socket events which
    // mobile devices can miss when backgrounded. If the server has
    // moved past our recorded round, our local "already voted" flag
    // is stale and must clear.
    // --- Allow-vote-change feature flag (v0.32.6+) ---
    // Refresh the local copy on every state poll so admin toggling the
    // setting mid-show propagates without a viewer reload.
    if (typeof data.allowVoteChange === 'boolean') {
      allowVoteChange = data.allowVoteChange;
    }

    // --- Location code flag (v0.33.24+) ---
    if (typeof data.requiresLocationCode === 'boolean') {
      boot.requiresLocationCode = data.requiresLocationCode;
    }

    // --- Show name → document title (v0.33.6+) ---
    // Admin renaming the show in settings updates every viewer's tab
    // title within a poll. We only overwrite document.title if it
    // currently matches the previously-seen show name — that way a
    // template that hard-coded its own <title> (which the server-side
    // renderer respects) keeps it.
    if (data.showName) {
      if (lastKnownShowName === null) {
        lastKnownShowName = data.showName;
      } else if (data.showName !== lastKnownShowName) {
        if (document.title === lastKnownShowName) {
          document.title = data.showName;
        }
        lastKnownShowName = data.showName;
      }
    }

    // --- Now-playing timer (v0.32.9+) ---
    // The server sends started_at + duration on every state poll. Pass
    // both (even if null — that's how we know to render --:--).
    updateTimerFromState(data.nowPlayingStartedAtIso || null, data.nowPlayingDurationSeconds || null);
    if (data.progressBar) applyProgressBarConfig(data.progressBar);

    if (typeof data.currentVotingRound === 'number') {
      if (lastKnownRoundId !== null && data.currentVotingRound !== lastKnownRoundId) {
        // Round advanced. Clear local vote state regardless of whether
        // the new round has zero votes yet (someone else may have
        // already voted before this client polled).
        hasVoted = false;
        hasTiebreakVoted = false;
        votedFor = null;
      }
      lastKnownRoundId = data.currentVotingRound;
    }
    // Legacy fallback: if we have no round id (older server) but vote
    // counts came back empty, the round was reset. Same effect.
    if (data.viewerControlMode === 'VOTING' && data.voteCounts && data.voteCounts.length === 0) {
      hasVoted = false;
      votedFor = null;
    }

    // --- Tiebreak state (v0.24.0+) ---
    // If the server reports a tiebreak in progress and we don't already
    // have one displayed, render the UI now. This handles page-reload
    // mid-tiebreak — the socket event already fired before we connected,
    // so we rely on /api/state to surface the active tiebreak. If the
    // server says no tiebreak but we have one displayed (race or dump),
    // clean up.
    if (data.tiebreak && data.tiebreak.candidates && data.tiebreak.candidates.length >= 2) {
      if (!tiebreakState) {
        // Compute deadline. Server sends ISO timestamp for the absolute
        // deadline (capped at song-end on the server side). Append 'Z'
        // since SQLite stores UTC without the marker.
        const deadlineMs = data.tiebreak.deadlineAtIso
          ? new Date(data.tiebreak.deadlineAtIso + 'Z').getTime()
          : Date.now() + 60000;
        // Look up display info for each candidate from the sequences list
        const seqByName = {};
        (data.sequences || []).forEach(s => { seqByName[s.name] = s; });
        const candidates = data.tiebreak.candidates.map(name => {
          const seq = seqByName[name] || {};
          return {
            sequenceName: name,
            displayName: seq.display_name || name,
            artist: seq.artist || '',
            imageUrl: seq.image_url || '',
          };
        });
        showTiebreakUI({
          candidates,
          deadlineAtMs: deadlineMs,
        });
      }
    } else if (tiebreakState) {
      // Server says no tiebreak but we have one. Clean up.
      clearTiebreakUI();
    }

    // --- NOW_PLAYING text ---
    const nowEls = document.querySelectorAll('.now-playing-text');
    if (nowEls.length) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      nowEls.forEach(el => {
        if (el.textContent !== nowDisplay) el.textContent = nowDisplay;
      });
    }

    // --- NOW_PLAYING_IMAGE (v0.32.13+) ---
    // Updates any <img data-showpilot-now-img> elements when the playing
    // song changes. Hides the image when no song is playing, or when the
    // current song has no cover art (image_url empty / null on the
    // sequence row).
    const nowImgEls = document.querySelectorAll('[data-showpilot-now-img]');
    if (nowImgEls.length) {
      const nowSeq = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)
        : null;
      const nowImgUrl = nowSeq && nowSeq.image_url ? nowSeq.image_url : '';
      nowImgEls.forEach(el => {
        if (nowImgUrl) {
          if (el.getAttribute('src') !== nowImgUrl) el.setAttribute('src', nowImgUrl);
          if (el.style.display === 'none') el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      });
    }

    // --- NEXT_PLAYLIST text (RF templates use .body_text inside the jukebox container) ---
    // We can't reliably pick "the right" .body_text element without a data attribute,
    // so we tag it during render-time. Fall back: leave it alone.
    // In templates we render server-side, we add data-showpilot-next to the NEXT_PLAYLIST spot.
    // The data-openfalcon-* selectors are kept for backward compat with templates
    // written against the old name.
    // querySelectorAll so templates that place {NEXT_PLAYLIST} both outside and
    // inside the jukebox container (e.g. as the jukebox "Up Next" display) get
    // every copy updated — querySelector would silently skip the second one.
    const nextEls = document.querySelectorAll('[data-showpilot-next], [data-openfalcon-next]');
    if (nextEls.length) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      nextEls.forEach(el => {
        if (el.textContent !== nextDisplay) el.textContent = nextDisplay;
      });
    }

    // --- Queue size & queue list ---
    const queueSizeEls = document.querySelectorAll('[data-showpilot-queue-size], [data-openfalcon-queue-size]');
    queueSizeEls.forEach(el => { el.textContent = String((data.queue || []).length); });

    const queueListEls = document.querySelectorAll('[data-showpilot-queue-list], [data-openfalcon-queue-list]');
    if (queueListEls.length) {
      const byName = Object.fromEntries((data.sequences || []).map(s => [s.name, s]));
      const queueHtml = (data.queue || []).length === 0
        // Match the server-side renderQueue empty-state shape (v0.32.13+).
        ? '<div class="queue-empty">Queue is empty.</div>'
        // Match the server-side renderQueue shape: each entry is its own
        // <div class="queue-item"> so RF Page Builder's `.queue-list > div`
        // selector matches.
        : data.queue.map(e => {
            const seq = byName[e.sequence_name];
            const name = seq ? seq.display_name : e.sequence_name;
            return `<div class="queue-item" data-seq="${escapeAttr(e.sequence_name)}">${escapeHtml(name)}</div>`;
          }).join('');
      queueListEls.forEach(el => { el.innerHTML = queueHtml; });
    }

    // --- Sequence list live rebuild (v0.33.6+) ---
    // When admin adds/removes/reorders/renames sequences (or edits
    // display_name / artist / image_url), the viewer's clickable grid is
    // stale until refresh. We mirror renderPlaylistGrid from
    // lib/viewer-renderer.js client-side and rebuild the affected
    // wrapper's innerHTML when the data signature changes.
    //
    // We find the wrapper by walking up from any [data-seq] element.
    // Templates have at most two wrappers (one in the jukebox container,
    // one in the voting container, if they support both modes). If the
    // server-rendered list was empty at page load, there are no [data-seq]
    // anchors and we can't find the wrapper — viewers in that narrow case
    // need a refresh to see newly-added sequences. Documented as known.
    rebuildPlaylistGridIfNeeded(data);

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated. After rebuildPlaylistGridIfNeeded this is
    // typically a no-op (the rebuild used the new url) — kept as a lighter-weight
    // path for the "only the cover changed" case where rebuild was skipped.
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
    // Both data-showpilot-container and data-openfalcon-container are honored
    // so templates from earlier versions keep working. We toggle via the
    // HTML5 `hidden` attribute (matching the server-side renderer in
    // v0.33.8+), AND clear any inline `display:none` left by older
    // server renders (in case the user is running a viewer page that
    // was loaded before a server upgrade). Idempotent on repeat calls.
    function setVisible(el, visible) {
      if (visible) {
        el.removeAttribute('hidden');
        // If a previous render set inline display:none, clear it. Don't
        // touch any non-display inline styles the template author may
        // have placed (margin, etc.) — only flip display.
        if (el.style && el.style.display === 'none') el.style.display = '';
      } else {
        el.setAttribute('hidden', '');
        // Belt-and-braces: also set inline display:none for older
        // viewer-side code paths that may have read it directly.
        if (el.style) el.style.display = 'none';
      }
    }
    document.querySelectorAll('[data-showpilot-container="jukebox"], [data-openfalcon-container="jukebox"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'JUKEBOX');
    });
    document.querySelectorAll('[data-showpilot-container="voting"], [data-openfalcon-container="voting"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'VOTING');
    });
    // After-hours: visible when viewer control is OFF. Mirror of the server-side
    // logic in viewer-renderer.js, so flipping the admin "Off" toggle propagates
    // to viewers within one poll without requiring a reload.
    document.querySelectorAll('[data-showpilot-container="afterhours"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'OFF');
    });
    // Race mode container visibility (v0.33.155+)
    document.querySelectorAll('[data-showpilot-container="race"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'RACE');
    });
    // In RACE mode, hide jukebox/voting containers so only race UI shows
    if (data.viewerControlMode === 'RACE') {
      document.querySelectorAll('[data-showpilot-container="jukebox"], [data-showpilot-container="voting"]').forEach(el => {
        setVisible(el, false);
      });
    }

    // --- Race state update (v0.33.155+) ---
    if (data.race) {
      applyRaceTapUpdate({
        counts: data.race.tapCounts || [],
        bars: buildRaceBars(data.race.tapCounts || []),
        leadingSequence: data.race.tapCounts?.[0]?.sequence_name || null,
      });
      if (data.race.winner) {
        // Winner arrived via state poll. Only show the overlay once per winner —
        // track which winner we've already shown so repeated polls don't re-fire it.
        // Also don't show on page load (covered by the boot-time IIFE above).
        if (data.race.winner !== _lastShownRaceWinner) {
          _lastShownRaceWinner = data.race.winner;
          const winSeq = (data.sequences || []).find(s => s.name === data.race.winner);
          showRaceWinner({
            sequenceName: data.race.winner,
            displayName: winSeq ? winSeq.display_name : data.race.winner,
            artist: winSeq ? (winSeq.artist || '') : '',
            tapCount: data.race.tapCounts?.[0]?.count || null,
          });
        }
        // Always disable tap buttons and clear timer when race is over
        document.querySelectorAll('.race-tap-btn').forEach(b => { b.disabled = true; });
        if (_raceTimerInterval) { clearInterval(_raceTimerInterval); _raceTimerInterval = null; }
        const countdownEl = document.getElementById('showpilot-race-countdown');
        if (countdownEl) countdownEl.textContent = 'Race over — next song coming up!';
      } else {
        updateRaceTimer(data.race.endsAt);
      }
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }


  // ============================================================
  // Race mode UI (v0.33.155+)
  // ============================================================
  let _raceTimerInterval = null;
  let _lastShownRaceWinner = null; // track which winner we've already shown the overlay for

  function buildRaceBars(tapCounts) {
    if (!tapCounts || !tapCounts.length) return {};
    const maxTaps = tapCounts[0].count || 1;
    const bars = {};
    tapCounts.forEach(r => { bars[r.sequence_name] = Math.round((r.count / maxTaps) * 100); });
    return bars;
  }

  function applyRaceTapUpdate(data) {
    if (!data) return;
    const { counts, bars, leadingSequence } = data;
    if (!counts) return;
    counts.forEach(r => {
      const countEl = document.querySelector('[data-race-count="' + CSS.escape(r.sequence_name) + '"]');
      if (countEl) {
        const old = parseInt(countEl.textContent, 10) || 0;
        countEl.textContent = String(r.count);
        if (r.count > old) {
          countEl.classList.remove('race-bump');
          void countEl.offsetWidth;
          countEl.classList.add('race-bump');
          setTimeout(() => countEl.classList.remove('race-bump'), 300);
        }
      }
      if (bars) {
        const barEl = document.querySelector('[data-race-bar="' + CSS.escape(r.sequence_name) + '"]');
        if (barEl) barEl.style.width = (bars[r.sequence_name] || 0) + '%';
      }
    });
    document.querySelectorAll('.race-row').forEach(row => {
      const seq = row.getAttribute('data-race-seq');
      row.classList.toggle('race-leading', seq === leadingSequence);
    });
  }

  // Track the endsAt value the timer was last started with so repeated
  // state polls don't needlessly restart a running countdown.
  let _raceTimerEndsAt = null;

  function updateRaceTimer(endsAt) {
    // Don't restart an already-running timer for the same race
    if (endsAt && endsAt === _raceTimerEndsAt && _raceTimerInterval) return;
    if (_raceTimerInterval) { clearInterval(_raceTimerInterval); _raceTimerInterval = null; }
    _raceTimerEndsAt = endsAt || null;

    // Prefer the injected race grid wrapper; fall back to the first race-row's parent
    const container = document.getElementById('showpilot-race-grid') ||
                      (document.querySelector('.race-row') && document.querySelector('.race-row').parentElement);
    if (!container) return;

    // Create timer bar and countdown once; leave them alone on subsequent calls
    let timerBar = document.getElementById('showpilot-race-timer-bar');
    let countdownEl = document.getElementById('showpilot-race-countdown');
    if (!timerBar) {
      timerBar = document.createElement('div');
      timerBar.id = 'showpilot-race-timer-bar';
      // Insert before first child so it appears above the songs
      container.insertBefore(timerBar, container.firstChild);
    }
    if (!countdownEl) {
      countdownEl = document.createElement('div');
      countdownEl.id = 'showpilot-race-countdown';
      timerBar.insertAdjacentElement('afterend', countdownEl);
    }
    if (!endsAt) {
      timerBar.style.width = '100%';
      countdownEl.textContent = 'Race ends with this song';
      return;
    }
    const endMs = new Date(endsAt).getTime();
    const boot = window.__SHOWPILOT__ || {};
    const totalMs = (boot.raceDurationSeconds || 60) * 1000;
    function tick() {
      const remaining = Math.max(0, endMs - Date.now());
      const pct = Math.min(100, Math.round((remaining / totalMs) * 100));
      timerBar.style.width = pct + '%';
      if (remaining <= 10000) timerBar.style.background = '#ff3a4f';
      const secs = Math.ceil(remaining / 1000);
      countdownEl.textContent = remaining > 0 ? secs + 's remaining' : 'Race over!';
      if (remaining <= 0 && _raceTimerInterval) {
        clearInterval(_raceTimerInterval);
        _raceTimerInterval = null;
        // Timer expired client-side — poll state immediately so we pick up
        // the winner the server resolves via its own setTimeout.
        setTimeout(refreshState, 500);
      }
    }
    tick();
    _raceTimerInterval = setInterval(tick, 1000);
  }

  function initRaceUI(data) {
    const overlay = document.getElementById('showpilot-race-winner-overlay');
    if (overlay) { overlay.classList.remove('active'); overlay.innerHTML = ''; }
    _lastShownRaceWinner = null;
    _raceTimerEndsAt = null; // force timer restart for new race
    document.querySelectorAll('.race-tap-btn').forEach(b => { b.disabled = false; });
    document.querySelectorAll('[data-race-bar]').forEach(el => { el.style.width = '0%'; });
    document.querySelectorAll('[data-race-count]').forEach(el => { el.textContent = '0'; });
    document.querySelectorAll('.race-row').forEach(r => r.classList.remove('race-leading'));
    updateRaceTimer(data && data.endsAt ? data.endsAt : null);
  }

  function showRaceWinner(data) {
    document.querySelectorAll('.race-tap-btn').forEach(b => { b.disabled = true; });
    if (_raceTimerInterval) { clearInterval(_raceTimerInterval); _raceTimerInterval = null; }
    _lastShownRaceWinner = data.sequenceName || null; // mark as shown so state poll doesn't re-fire
    const overlay = document.getElementById('showpilot-race-winner-overlay');
    if (!overlay) return;
    const name   = escapeHtml(data.displayName || data.sequenceName || 'Unknown');
    const artist = data.artist ? '<div class="race-winner-artist">' + escapeHtml(data.artist) + '</div>' : '';
    const taps   = data.tapCount != null ? '<div class="race-winner-taps">\uD83C\uDFC6 ' + data.tapCount + ' taps</div>' : '';
    overlay.innerHTML =
      '<div class="race-winner-flag">\uD83C\uDFC1</div>' +
      '<div class="race-winner-label">' + _pt('Winner!') + '</div>' +
      '<div class="race-winner-song">' + name + '</div>' +
      artist + taps +
      '<div style="color:rgba(255,255,255,0.5);font-size:0.8em">Playing next \u2013 tap to dismiss</div>';
    overlay.classList.add('active');
    launchRaceConfetti();
    overlay.addEventListener('click', () => overlay.classList.remove('active'), { once: true });
  }

  function launchRaceConfetti() {
    const colors = ['#ffd700','#ff6b35','#ff3a4f','#4fc3f7','#81c784','#ce93d8','#fff'];
    for (let i = 0; i < 80; i++) {
      const el = document.createElement('div');
      el.className = 'race-confetti-piece';
      const color    = colors[Math.floor(Math.random() * colors.length)];
      const x        = Math.random() * 100;
      const duration = 1.5 + Math.random() * 2;
      const delay    = Math.random() * 0.8;
      const size     = 6 + Math.floor(Math.random() * 10);
      el.style.cssText = 'left:' + x + 'vw;top:-20px;background:' + color +
        ';width:' + size + 'px;height:' + size + 'px' +
        ';animation-duration:' + duration + 's;animation-delay:' + delay + 's';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), (duration + delay + 0.2) * 1000);
    }
  }

  // Global tap handler called from race row buttons
  window.ShowPilotRaceTap = async function(sequenceName) {
    try {
      await fetch('/api/race/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sequenceName }),
      });
      // Server emits raceTapUpdate via socket — UI updates from there
    } catch {}
  };

  // Initialize race UI on page load if mode is already RACE.
  // Runs after DOMContentLoaded so #showpilot-race-grid is in the DOM.
  // We intentionally do NOT show the winner overlay on page load — it is a
  // real-time socket event, not persistent state to re-show on refresh.
  document.addEventListener('DOMContentLoaded', function() {
    const boot = window.__SHOWPILOT__ || {};
    if (boot.mode === 'RACE') {
      if (boot.raceActive && !boot.raceWinner) {
        updateRaceTimer(boot.raceEndsAt || null);
      } else if (boot.raceWinner) {
        document.querySelectorAll('.race-tap-btn').forEach(b => { b.disabled = true; });
        const countdownEl = document.getElementById('showpilot-race-countdown');
        if (countdownEl) countdownEl.textContent = 'Race over — next song coming up!';
      }
    }
  });

  // Heartbeat (for active viewer count)
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  }, 15000);

  // Poll state every 3s for live updates (Socket.io provides instant updates too)
  setInterval(refreshState, 3000);

  // ============================================================
  // Tiebreak UI (v0.24.0+)
  // ============================================================
  // Renders a sticky banner at the top of the page when a tiebreak is
  // active, plus visual emphasis on the tied candidates within the
  // existing voting list. The banner shows a countdown timer and
  // lists the tied songs as tap targets — tapping casts a tiebreak
  // vote via /api/tiebreak-vote (rather than the regular /api/vote).
  //
  // Design intent: the existing voting list stays intact so users can
  // see the score progression. We just overlay an urgent banner and
  // mark the candidates with a visible badge so users know which two
  // are eligible for the tiebreak vote.
  function showTiebreakUI(data) {
    if (!data || !Array.isArray(data.candidates) || data.candidates.length < 2) return;
    // The deadline is a wall-clock moment, computed server-side as
    // min(timer-cap, current-song-end). The viewer countdown is just
    // (deadline - now) capped at 0 — no need to know the configured
    // timer duration, just the absolute end moment.
    const deadlineMs = data.deadlineAtMs || (data.startedAtMs && data.durationSec
      ? data.startedAtMs + data.durationSec * 1000
      : Date.now() + 60000);
    tiebreakState = {
      candidates: data.candidates,
      deadlineMs,
    };
    hasTiebreakVoted = false;
    renderTiebreakBanner();
    markTiebreakCandidatesInList();
    startTiebreakCountdown();
  }

  function clearTiebreakUI() {
    tiebreakState = null;
    if (tiebreakCountdownTimer) {
      clearInterval(tiebreakCountdownTimer);
      tiebreakCountdownTimer = null;
    }
    const banner = document.getElementById('showpilot-tiebreak-banner');
    if (banner) banner.remove();
    document.querySelectorAll('.cell-vote-playlist').forEach(el => {
      el.classList.remove('showpilot-tiebreak-candidate');
      const badge = el.querySelector('.showpilot-tie-badge');
      if (badge) badge.remove();
    });
  }

  function renderTiebreakBanner() {
    let banner = document.getElementById('showpilot-tiebreak-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'showpilot-tiebreak-banner';
      // Inline styles — keeps the banner self-contained even if a
      // template's CSS doesn't include rules for it. Templates can
      // restyle by setting CSS variables (--showpilot-tiebreak-bg etc.)
      // or by overriding #showpilot-tiebreak-banner directly.
      banner.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'z-index: 9997',
        'padding: 14px 18px',
        'background: var(--showpilot-tiebreak-bg, linear-gradient(135deg, #d63031, #6c0e0e))',
        'color: var(--showpilot-tiebreak-text, #fff)',
        'font-family: var(--showpilot-toast-font, system-ui, -apple-system, sans-serif)',
        'box-shadow: 0 6px 18px rgba(0,0,0,0.5)',
        'animation: showpilot-tb-shake 0.7s cubic-bezier(.36,.07,.19,.97) both',
        'animation-iteration-count: 2',
      ].join(';');
      document.body.appendChild(banner);
      // Add keyframes once
      if (!document.getElementById('showpilot-tb-keyframes')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'showpilot-tb-keyframes';
        styleEl.textContent = `
          @keyframes showpilot-tb-shake {
            10%, 90% { transform: translate3d(-1px, 0, 0); }
            20%, 80% { transform: translate3d(2px, 0, 0); }
            30%, 50%, 70% { transform: translate3d(-3px, 0, 0); }
            40%, 60% { transform: translate3d(3px, 0, 0); }
          }
          @keyframes showpilot-tb-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.7); }
            50% { box-shadow: 0 0 0 10px rgba(255, 80, 80, 0); }
          }
          .showpilot-tiebreak-candidate {
            outline: 3px solid var(--showpilot-tiebreak-accent, #ff5050) !important;
            outline-offset: -3px;
            animation: showpilot-tb-pulse 1.5s infinite;
          }
          .showpilot-tie-badge {
            display: inline-block;
            background: var(--showpilot-tiebreak-bg, #d63031);
            color: var(--showpilot-tiebreak-text, #fff);
            font-size: 0.7rem;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 999px;
            margin-left: 8px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            vertical-align: middle;
          }
          #showpilot-tiebreak-banner button {
            background: rgba(255,255,255,0.18);
            border: 1px solid rgba(255,255,255,0.4);
            color: inherit;
            font-family: inherit;
            font-size: 0.95rem;
            font-weight: 600;
            padding: 8px 14px;
            margin: 4px;
            border-radius: 8px;
            cursor: pointer;
          }
          #showpilot-tiebreak-banner button:hover {
            background: rgba(255,255,255,0.3);
          }
          #showpilot-tiebreak-banner button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        `;
        document.head.appendChild(styleEl);
      }
    }
    if (!tiebreakState) return;
    const candList = tiebreakState.candidates.map(c => `
      <button data-tb-candidate="${escapeAttr(c.sequenceName)}" onclick="window.ShowPilotTiebreakVote('${escapeJsString(c.sequenceName)}')">
        ${escapeHtml(c.displayName || c.sequenceName)}
      </button>
    `).join('');
    banner.innerHTML = `
      <div style="text-align:center;">
        <div style="font-weight:800;font-size:1.05rem;letter-spacing:0.05em;text-transform:uppercase;">
          ⚡ Tiebreak — Vote Now ⚡
        </div>
        <div style="font-size:0.85rem;opacity:0.9;margin-top:4px;">
          Vote within <span id="showpilot-tb-countdown">--</span>s or all votes are dumped.
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;justify-content:center;">
          ${candList}
        </div>
      </div>
    `;
  }

  function markTiebreakCandidatesInList() {
    if (!tiebreakState) return;
    const candidateNames = tiebreakState.candidates.map(c => c.sequenceName);
    document.querySelectorAll('.cell-vote-playlist').forEach(el => {
      const seqName = el.getAttribute('data-seq');
      if (seqName && candidateNames.includes(seqName)) {
        el.classList.add('showpilot-tiebreak-candidate');
        if (!el.querySelector('.showpilot-tie-badge')) {
          const badge = document.createElement('span');
          badge.className = 'showpilot-tie-badge';
          badge.textContent = 'TIE';
          el.appendChild(badge);
        }
      }
    });
  }

  function startTiebreakCountdown() {
    if (tiebreakCountdownTimer) clearInterval(tiebreakCountdownTimer);
    const tick = () => {
      if (!tiebreakState) return;
      const remaining = Math.max(0, Math.ceil((tiebreakState.deadlineMs - Date.now()) / 1000));
      const cdEl = document.getElementById('showpilot-tb-countdown');
      if (cdEl) cdEl.textContent = String(remaining);
      if (remaining <= 0) {
        // Visual feedback that timer is up. Server will emit tiebreakFailed
        // (or we'll get a state update with no tiebreak active) shortly,
        // and that will clean us up.
        if (cdEl) cdEl.textContent = 'time up';
      }
    };
    tick();
    tiebreakCountdownTimer = setInterval(tick, 250);
  }

  function showTiebreakFailedToast(data) {
    // Use the existing winner-toast infrastructure with different content.
    // We don't have the renderer's showWinnerToast helper exposed to us,
    // so just log and rely on the "votes dumped" implication being clear
    // when the tiebreak banner disappears. Templates can listen for the
    // socket event themselves if they want a custom failure UI.
    console.info('[ShowPilot] tiebreak expired — votes dumped:', data);
  }

  // Vote click during tiebreak — routes to the tiebreak endpoint instead
  // of the main vote endpoint. Exposed globally so the banner buttons can
  // call it directly. Returns nothing; uses showMessage for feedback.
  window.ShowPilotTiebreakVote = async function(sequenceName) {
    if (hasTiebreakVoted) {
      showMessage(MSG_IDS.alreadyVoted);
      return;
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }
    const result = await postJson('/api/tiebreak-vote', body);
    if (result.ok) {
      hasTiebreakVoted = true;
      showMessage(MSG_IDS.voteSuccess);
      // (v0.32.11+) Same reasoning as ShowPilotVote — refresh immediately
      // so the user sees their tiebreak vote register without waiting on
      // the tiebreakVoteUpdate socket event.
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data), undefined, undefined, result.data?.error);
    }
  };

  function escapeAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }
  function escapeJsString(s) {
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  }

  // ============================================================
  // Playlist grid live rebuild (v0.33.6+)
  // ============================================================
  // Mirrors lib/viewer-renderer.js#renderPlaylistGrid so the viewer's
  // clickable list updates without a refresh when admin edits the
  // sequence list. Called from applyStateUpdate on every state poll.
  //
  // We find playlist wrappers by walking up from any [data-seq]
  // element. The wrapper is the parent that holds rows. Templates may
  // have one (single-mode template) or two (dual-mode template, one
  // wrapper per mode-container). We rebuild each wrapper independently
  // and only when its computed signature differs from the data — so
  // unchanged wrappers don't churn the DOM and unrelated event handlers
  // / hover state survive.
  //
  // The empty-initial-load edge case: if the page was rendered with
  // zero sequences, there are no [data-seq] anchors to find a wrapper
  // by, and a subsequent admin sequence-add won't appear until the
  // viewer refreshes. Acceptable trade-off — alternative would be
  // emitting a sentinel element on every {PLAYLISTS} substitution,
  // which risks breaking template CSS that targets direct-child
  // siblings (.voting_table grid-template-columns, etc.).

  // Stable signature of the desired grid contents — name, display_name,
  // artist, and image_url. Order matters (admin-controlled ordering is
  // meaningful). Mode is included so a JUKEBOX→VOTING flip forces a
  // rebuild. Vote counts are intentionally excluded: they're managed by
  // the direct DOM update in applyStateUpdate and don't need a full
  // innerHTML rebuild on every vote change.
  function computeGridSignature(sequences, mode, catOpts) {
    const parts = [mode, 'cat:' + (catOpts && catOpts.categoryHeaders === false ? '0' : '1') + ':' + ((catOpts && catOpts.uncategorizedLabel) || '')];
    for (const s of sequences) {
      parts.push(
        s.name + '|' +
        (s.display_name || '') + '|' +
        (s.artist || '') + '|' +
        (s.image_url || '') + '|' +
        (s.category || '')
        // vote counts excluded — managed by the direct DOM update in applyStateUpdate
      );
    }
    return parts.join('\n');
  }

  // Mirror of the server's renderPlaylistGrid — must produce IDENTICAL
  // markup so click handlers and template CSS keep working. If you
  // change one side, change the other. (Tested by comparing rendered
  // HTML in /tmp/test-playlist-rebuild.js.)
  //
  // Note: we use escapeHtml (not escapeAttr) for data-seq and
  // data-seq-name values because that's what the server-side renderer
  // does — escapeAttr doesn't escape ' or > and would produce
  // divergent markup for sequences with those chars in their names.
  // Mirror of lib/viewer-renderer.js#withCategoryHeaders — change both.
  // The list arrives pre-grouped from /api/state; emit a header row each
  // time the category changes.
  function withCategoryHeaders(sequences, opts, rowFn) {
    const on = !opts || opts.categoryHeaders !== false;
    const anyCat = on && sequences.some(s => s.category && String(s.category).trim());
    if (!anyCat) return sequences.map(rowFn);
    const other = (opts && typeof opts.uncategorizedLabel === 'string' && opts.uncategorizedLabel.trim()) || 'Other';
    const out = [];
    let prevKey = null;
    for (const seq of sequences) {
      const label = (seq.category && String(seq.category).trim()) || other;
      const key = label.toLowerCase();
      if (key !== prevKey) {
        out.push(`<div class="sequence-category-header" data-showpilot-category="${escapeHtml(label)}">${escapeHtml(label)}</div>`);
        prevKey = key;
      }
      out.push(rowFn(seq));
    }
    return out;
  }

  function renderRowsForMode(sequences, voteCountsByName, mode, catOpts) {
    return withCategoryHeaders(sequences, catOpts, seq => {
      const safeNameJs = escapeJsString(seq.name);
      const safeNameAttr = escapeHtml(seq.name);
      const safeDisplay = escapeHtml(seq.display_name || seq.name);
      const safeArtist = seq.artist ? escapeHtml(seq.artist) : '';
      const count = voteCountsByName[seq.name] || 0;
      // width/height are presentational hints — author CSS overrides them.
      // See lib/viewer-renderer.js renderPlaylistGrid for the full rationale.
      // Mirror the server-side defaults here so live rebuilds (mode flip,
      // sequence list change) don't reintroduce native-resolution images.
      const artImg = seq.image_url
        ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(seq.image_url)}" alt="" width="40" loading="lazy" />`
        : '';
      if (mode === 'VOTING') {
        return `<div class="cell-vote-playlist sequence-item" onclick="ShowPilotVote('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="cell-vote-playlist-artist sequence-artist">${safeArtist}</div><span class="sequence-votes" data-seq-votes="${safeNameAttr}">${count}</span></div></div><div class="cell-vote" onclick="ShowPilotVote('${safeNameJs}')" data-seq-count="${safeNameAttr}">${count}</div>`;
      } else {
        return `<div class="jukebox-list sequence-item" onclick="ShowPilotRequest('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="jukebox-list-artist sequence-artist">${safeArtist}</div><span class="sequence-requests" data-seq-requests="${safeNameAttr}"></span></div></div>`;
      }
    }).join('');
  }

  // Find the unique playlist wrapper(s) by walking up from existing rows.
  // Returns 0, 1, or 2 elements depending on template shape.
  function findPlaylistWrappers() {
    const wrappers = new Set();
    document.querySelectorAll('[data-seq]').forEach(el => {
      // Skip queue items and tiebreak candidate buttons — they also use
      // data-seq but live in different parents. Identify them by class.
      if (el.classList.contains('queue-item')) return;
      if (el.hasAttribute('data-tb-candidate')) return;
      if (el.parentElement) wrappers.add(el.parentElement);
    });
    return Array.from(wrappers);
  }

  // Per-wrapper signature cache so we only rebuild on actual change.
  // WeakMap so detached wrappers GC normally.
  const _gridSigCache = new WeakMap();

  function rebuildPlaylistGridIfNeeded(data) {
    const sequences = data.sequences || [];
    const mode = data.viewerControlMode || 'OFF';
    // Only meaningful in JUKEBOX or VOTING; in OFF the mode containers
    // are hidden, so rebuilding their stale contents wastes work but
    // doesn't hurt. Skip to keep churn low.
    if (mode !== 'JUKEBOX' && mode !== 'VOTING') return;

    const voteCountsByName = {};
    (data.voteCounts || []).forEach(v => { voteCountsByName[v.sequence_name] = v.count; });
    const catOpts = { categoryHeaders: data.categoryHeaders, uncategorizedLabel: data.uncategorizedLabel };
    const desiredSig = computeGridSignature(sequences, mode, catOpts);

    const wrappers = findPlaylistWrappers();
    if (wrappers.length === 0) return; // Empty-initial-load edge case.

    for (const wrapper of wrappers) {
      // Determine which mode this wrapper belongs to. Walk up to the
      // nearest [data-showpilot-container] ancestor and read its mode.
      // If no container ancestor (single-mode template with no mode
      // container), assume the active mode.
      let targetMode = mode;
      let cur = wrapper;
      while (cur && cur !== document.body) {
        const c = cur.getAttribute && cur.getAttribute('data-showpilot-container');
        if (c === 'jukebox') { targetMode = 'JUKEBOX'; break; }
        if (c === 'voting') { targetMode = 'VOTING'; break; }
        cur = cur.parentElement;
      }
      // Only rebuild a wrapper whose mode matches the active mode —
      // the inactive one is hidden anyway and won't be seen.
      if (targetMode !== mode) continue;

      const wrapperSig = _gridSigCache.get(wrapper);
      if (wrapperSig === desiredSig) continue;

      wrapper.innerHTML = renderRowsForMode(sequences, voteCountsByName, targetMode, catOpts);
      _gridSigCache.set(wrapper, desiredSig);
    }
  }

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
      socket.on('nextScheduled', () => refreshState());
      socket.on('voteReset', () => {
        hasVoted = false;
        hasTiebreakVoted = false;
        votedFor = null;
        // Clear any tiebreak banner that's still on screen — round
        // moved on (either resolution succeeded or timer expired).
        clearTiebreakUI();
        refreshState();
      });
      socket.on('sequencesReordered', () => refreshState());
      socket.on('sequencesSynced', () => refreshState());
      // Mode toggle (admin flipping JUKEBOX / VOTING / OFF) — fires
      // server-side in routes/plugin.js. Without this, viewers wait up
      // to 3s for the next poll to see the after-hours block appear or
      // the active grid swap. With it, propagation is instant.
      socket.on('viewerModeChanged', () => refreshState());
      // ---- Tiebreak events (v0.24.0+) ----
      socket.on('tiebreakStarted', (data) => {
        showTiebreakUI(data);
      });
      socket.on('tiebreakFailed', (data) => {
        showTiebreakFailedToast(data);
        clearTiebreakUI();
      });
      socket.on('tiebreakVoteUpdate', () => refreshState());
      // On reconnect (after network blip or mobile background-suspend),
      // resync state immediately. Otherwise we'd keep showing whatever
      // round we had before disconnect, including a stale "already
      // voted" gate. Socket.io fires 'connect' both on initial connect
      // and on each reconnect, so this covers both.
      socket.on('connect', () => refreshState());

      // ---- Race mode socket events (v0.33.155+) ----
      socket.on('raceStarted', (data) => {
        initRaceUI(data);
        refreshState();
      });
      socket.on('raceTapUpdate', (data) => {
        applyRaceTapUpdate(data);
      });
      socket.on('raceWinner', (data) => {
        showRaceWinner(data);
      });
      socket.on('raceEnded', () => {
        // No winner (no taps at all) — just re-render state
        refreshState();
      });
    }
  } catch {}

  // Mobile devices commonly suspend background tabs aggressively. When
  // the user comes back to the page (visibilitychange to 'visible'),
  // pull a fresh state so we don't continue working from stale data.
  // Pairs with the socket reconnect handler above — covers the case
  // where the socket reconnected silently in the background but the
  // tab missed events while suspended.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshState();
    }
  });

  // ============================================================
  // LISTEN ON PHONE — Web Audio API player with sample-precise sync
  //
  // Sync strategy (timestamp-anchored, NTP-style):
  //   1. Server provides trackStartedAtMs (epoch ms when current track began on FPP)
  //      AND serverNowMs in same response — client computes clock offset
  //   2. Client decodes full audio file into AudioBuffer (~5MB per song, fine in RAM)
  //   3. Schedules playback at exact moment via AudioContext.start(when, offset):
  //        offset = (clientNow + clockOffset - trackStartedAtMs) / 1000
  //        when   = audioCtx.currentTime + 0.05  (small lead-in to be safe)
  //   4. Pre-fetches next song's AudioBuffer while current plays — zero gap
  //   5. Re-syncs once per second with cheap REST poll (no per-second WebSocket needed)
  //
  // This matches PulseMesh-quality sync without C++ or Node.
  //
  // Player UI is sticky bottom-of-page when open. "Hide" minimizes to a small
  // status pill while audio keeps playing.
  // ============================================================
  // ============================================================
  // ============================================================
  // PAGE EFFECTS — full-screen ambient overlays (snow, leaves,
  // fireworks, hearts, stars, bats, confetti, petals, embers,
  // bubbles, rain — plus 'none').
  //
  // Three knobs from the server:
  //   pageEffect          — string id (see EFFECTS table below)
  //   pageEffectColor     — '' for the effect's default, or any CSS color
  //   pageEffectIntensity — 'subtle' | 'medium' | 'heavy'
  //
  // Engine contract: each effect declares { name, defaultColor, build }.
  // build(layer, color, count) populates `layer` with absolutely-positioned
  // children using whatever animations the effect needs. The engine
  // handles the layer container, lifecycle (start/stop/swap), and
  // prefers-reduced-motion respect. Effects don't need to clean up — when
  // we swap, we drop the whole layer and rebuild.
  //
  // Backward compat: bootstrap.pageSnowEnabled is mapped to pageEffect='snow'
  // by the server, so old templates that hardcoded that name keep working.
  //
  // pointer-events:none on the layer so it never blocks clicks. z-index
  // sits above page background but below the player bar.
  // ============================================================
  // ============================================================
  // Long-name truncation guard (v0.32.14+)
  // ============================================================
  // Some imported third-party templates (e.g. RF Page Builder)
  // style `.sequence-name` with `white-space: nowrap; overflow: hidden;
  // text-overflow: ellipsis;`. That assumes one-line song titles. Real
  // shows have titles like "Walk the Dinosaur (From Ice Age: Dawn of
  // the Dinosaurs)" which then truncate to "Walk the Din…". The
  // template author can't anticipate every show's catalog, and asking
  // every operator to learn CSS to fix it is a non-starter.
  //
  // Strategy: inject a low-specificity defensive rule that allows
  // wrapping AND caps at 2 lines. We scope it to .sequence-name inside
  // .sequence-item — that's RF Page Builder territory. Built-in
  // ShowPilot templates and canonical RF templates never style
  // .sequence-name (they target .jukebox-list / .cell-vote-playlist
  // descendants), so this override is invisible to them.
  //
  // We use !important so RFPB's existing rules don't beat us. The
  // 2-line clamp uses both the modern `line-clamp` and the legacy
  // `-webkit-line-clamp` for browser coverage; modern browsers honor
  // both. The min-width:0 guard prevents flex children from refusing
  // to shrink and overflowing their card.
  // ============================================================
  (function initSequenceNameWrap() {
    if (document.getElementById('of-seqname-wrap-style')) return; // idempotent
    const style = document.createElement('style');
    style.id = 'of-seqname-wrap-style';
    style.textContent = `
      .sequence-item .sequence-name {
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 2 !important;
        line-clamp: 2 !important;
        -webkit-box-orient: vertical !important;
        word-break: break-word;
        min-width: 0;
      }
      .sequence-item .sequence-artist {
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 1 !important;
        line-clamp: 1 !important;
        -webkit-box-orient: vertical !important;
        word-break: break-word;
        min-width: 0;
      }
    `;
    // Append to <head> so it lands before the template's late <style>
    // blocks at the end of <body>. CSS source order is what determines
    // which rule wins among tied specificity, so position matters; but
    // we also use !important to win across the board against templates
    // that put nowrap rules in the body's late <style>.
    (document.head || document.documentElement).appendChild(style);
  })();

  // ============================================================
  // Page effects engine — snow / leaves / etc.
  (function initPageEffects() {
    const prefersReduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return; // respect OS-level motion preference always

    let layer = null;
    let styleEl = null;
    // Track last-applied state to avoid pointless rebuilds. The poll runs
    // every 5s; if nothing changed we skip the DOM churn (and the visual
    // restart of the animations).
    let last = { name: null, color: null, intensity: null };

    // ============================================================
    // KEYFRAMES — emitted once, shared across all effects. We don't
    // namespace per-effect because most fall/drift effects share the
    // same fall + sway pattern; keeping it DRY makes the file shorter.
    // ============================================================
    function ensureStyle() {
      if (styleEl) return;
      styleEl = document.createElement('style');
      styleEl.textContent = `
        @keyframes ofPageFall {
          0%   { transform: translateY(-30px) rotate(0deg); }
          100% { transform: translateY(108vh) rotate(360deg); }
        }
        @keyframes ofPageDrift {
          0%   { transform: translateY(-30px) rotate(-25deg); }
          100% { transform: translateY(108vh) rotate(335deg); }
        }
        @keyframes ofPageSway {
          0%   { margin-left: 0; }
          100% { margin-left: var(--of-sway, 30px); }
        }
        @keyframes ofPageRise {
          0%   { transform: translateY(110vh) rotate(0deg); opacity: 0; }
          10%  { opacity: var(--of-peak-opacity, 0.8); }
          90%  { opacity: var(--of-peak-opacity, 0.8); }
          100% { transform: translateY(-30px) rotate(360deg); opacity: 0; }
        }
        @keyframes ofPageTwinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50%      { opacity: 1;   transform: scale(1.1); }
        }
        @keyframes ofPageBatFly {
          0%   { transform: translateX(-12vw) translateY(0); }
          100% { transform: translateX(112vw) translateY(var(--of-bat-dy, 8vh)); }
        }
        @keyframes ofPageBatFlap {
          0%, 100% { transform: scaleY(1); }
          50%      { transform: scaleY(0.55); }
        }
        @keyframes ofPageRain {
          0%   { transform: translateY(-30vh); }
          100% { transform: translateY(108vh); }
        }
        @keyframes ofPageBurst {
          0%   { transform: scale(0); opacity: 0; }
          10%  { opacity: 1; }
          70%  { opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
      `;
      document.head.appendChild(styleEl);
    }

    // ============================================================
    // INTENSITY MAPS — per-effect particle counts.
    // Heavier effects (fireworks, bats) ship fewer at "heavy" than
    // small confetti would, because each is bigger / more visually loud.
    // ============================================================
    const COUNTS = {
      // [subtle, medium, heavy]
      snow:      [25, 50, 90],
      leaves:    [15, 30, 55],
      fireworks: [3,  6,  12],
      hearts:    [20, 40, 70],
      stars:     [30, 60, 110],
      bats:      [3,  6,  10],
      confetti:  [40, 80, 140],
      petals:    [20, 40, 70],
      embers:    [25, 50, 90],
      bubbles:   [15, 30, 55],
      rain:      [60, 120, 200],
    };
    function pickCount(name, intensity) {
      const arr = COUNTS[name];
      if (!arr) return 0;
      const idx = intensity === 'subtle' ? 0 : intensity === 'heavy' ? 2 : 1;
      return arr[idx];
    }

    // ============================================================
    // EFFECT DEFINITIONS — each is { defaultColor, build(layer, color, count) }.
    // `color` is always a non-empty string here (the engine substitutes
    // defaultColor when the admin left the override blank).
    //
    // Each effect creates absolutely-positioned children inside `layer`.
    // Random number tweaks aim for "feels alive" not "looks identical".
    // ============================================================
    const EFFECTS = {
      // ---------- SNOW ----------
      snow: {
        defaultColor: '#ffffff',
        build(root, color, count) {
          const flakeSvg = (col) => `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><g stroke="${col}" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.9"><line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="2.5" y1="2.5" x2="11.5" y2="11.5"/><line x1="2.5" y1="11.5" x2="11.5" y2="2.5"/><path d="M 7,2 L 6,3 M 7,2 L 8,3"/><path d="M 7,12 L 6,11 M 7,12 L 8,11"/><path d="M 2,7 L 3,6 M 2,7 L 3,8"/><path d="M 12,7 L 11,6 M 12,7 L 11,8"/></g></svg>`;
          const svgMarkup = flakeSvg(color);
          for (let i = 0; i < count; i++) {
            const flake = document.createElement('div');
            const size = 8 + Math.random() * 14;
            const left = Math.random() * 100;
            const duration = 8 + Math.random() * 10;
            const delay = -Math.random() * duration;
            const sway = 20 + Math.random() * 40;
            const opacity = 0.4 + Math.random() * 0.5;
            flake.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size}px;opacity:${opacity};filter:drop-shadow(0 0 2px ${color}66);animation:ofPageFall ${duration}s linear infinite, ofPageSway ${duration / 2}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            flake.innerHTML = svgMarkup;
            root.appendChild(flake);
          }
        },
      },

      // ---------- LEAVES ---------- (autumn maple-like silhouettes)
      leaves: {
        defaultColor: '#d2691e',
        build(root, color, count) {
          // Random palette around the chosen color so leaves look varied.
          // We render one default svg shape and tint it via CSS filter for
          // the "varied colors" feel without bloating the markup.
          const leafSvg = (col) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 C8 4, 4 8, 4 13 C4 18, 8 22, 12 22 C16 22, 20 18, 20 13 C20 8, 16 4, 12 2 Z M12 4 L12 22" fill="${col}" stroke="${col}" stroke-width="0.5"/></svg>`;
          for (let i = 0; i < count; i++) {
            const leaf = document.createElement('div');
            const size = 16 + Math.random() * 18;
            const left = Math.random() * 100;
            const duration = 10 + Math.random() * 12;
            const delay = -Math.random() * duration;
            const sway = 60 + Math.random() * 80;
            const opacity = 0.55 + Math.random() * 0.4;
            // Vary the hue a little: ±20deg rotation gives autumnal range
            const hueShift = Math.round(-20 + Math.random() * 40);
            leaf.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size}px;opacity:${opacity};filter:hue-rotate(${hueShift}deg) drop-shadow(0 1px 2px rgba(0,0,0,0.3));animation:ofPageDrift ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            leaf.innerHTML = leafSvg(color);
            root.appendChild(leaf);
          }
        },
      },

      // ---------- FIREWORKS ---------- (radial bursts at random positions)
      fireworks: {
        defaultColor: '#ff5050',
        build(root, color, count) {
          // Each "firework" is a burst of N small dots radiating from a center.
          // We stagger their delays so the sky doesn't fire all at once.
          const sparksPerBurst = 14;
          for (let i = 0; i < count; i++) {
            const burst = document.createElement('div');
            const cx = 10 + Math.random() * 80; // vw
            const cy = 8 + Math.random() * 50;  // vh — keep above the fold mostly
            const burstDuration = 1.6 + Math.random() * 1.2;
            const cycle = 4 + Math.random() * 5;
            const cycleDelay = Math.random() * cycle;
            // Vary color slightly via hue-rotate on each spark's filter
            const baseHue = Math.round(Math.random() * 360);
            burst.style.cssText = `position:absolute;left:${cx}vw;top:${cy}vh;width:0;height:0;`;
            for (let s = 0; s < sparksPerBurst; s++) {
              const angle = (s / sparksPerBurst) * Math.PI * 2;
              const dist = 60 + Math.random() * 50;
              const dx = Math.cos(angle) * dist;
              const dy = Math.sin(angle) * dist;
              const spark = document.createElement('div');
              spark.style.cssText = `position:absolute;left:0;top:0;width:6px;height:6px;border-radius:50%;background:${color};filter:hue-rotate(${baseHue}deg) drop-shadow(0 0 6px ${color});transform-origin:0 0;animation:sparkFly_${i}_${s} ${cycle}s ease-out infinite;animation-delay:${cycleDelay}s;`;
              const styleId = `ofSpark_${i}_${s}`;
              const style = document.createElement('style');
              style.textContent = `@keyframes sparkFly_${i}_${s} { 0%,${(burstDuration/cycle*100).toFixed(0)}% { transform: translate(0,0); opacity: 1; } ${(burstDuration/cycle*100*0.6).toFixed(0)}% { opacity: 1; } ${(burstDuration/cycle*100).toFixed(0)}% { transform: translate(${dx}px,${dy}px); opacity: 0; } 100% { transform: translate(${dx}px,${dy}px); opacity: 0; } }`;
              root.appendChild(style);
              burst.appendChild(spark);
            }
            root.appendChild(burst);
          }
        },
      },

      // ---------- HEARTS ----------
      hearts: {
        defaultColor: '#ff4d8d',
        build(root, color, count) {
          const heartSvg = (col) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 21 C 12 21, 4 14, 4 8.5 C 4 5, 6.5 3, 9 3 C 10.5 3, 12 4, 12 5.5 C 12 4, 13.5 3, 15 3 C 17.5 3, 20 5, 20 8.5 C 20 14, 12 21, 12 21 Z" fill="${col}" stroke="${col}" stroke-width="0.5"/></svg>`;
          const svgMarkup = heartSvg(color);
          for (let i = 0; i < count; i++) {
            const heart = document.createElement('div');
            const size = 12 + Math.random() * 18;
            const left = Math.random() * 100;
            const duration = 10 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const sway = 30 + Math.random() * 50;
            const opacity = 0.5 + Math.random() * 0.4;
            heart.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;--of-peak-opacity:${opacity};filter:drop-shadow(0 0 4px ${color}77);animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            heart.innerHTML = svgMarkup;
            root.appendChild(heart);
          }
        },
      },

      // ---------- STARS ---------- (twinkling, fixed positions)
      stars: {
        defaultColor: '#fff5b3',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const star = document.createElement('div');
            const size = 2 + Math.random() * 3;
            const left = Math.random() * 100;
            const top = Math.random() * 95;
            const duration = 1.5 + Math.random() * 3;
            const delay = -Math.random() * duration;
            star.style.cssText = `position:absolute;left:${left}vw;top:${top}vh;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 ${size * 2}px ${color};animation:ofPageTwinkle ${duration}s ease-in-out infinite;animation-delay:${delay}s;`;
            root.appendChild(star);
          }
        },
      },

      // ---------- BATS ---------- (silhouettes flying horizontally)
      bats: {
        defaultColor: '#1a0033',
        build(root, color, count) {
          const batSvg = (col) => `<svg viewBox="0 0 32 18" xmlns="http://www.w3.org/2000/svg"><path d="M16 5 L13 2 L11 4 L8 2 L5 4 L2 5 L0 9 L4 8 L7 11 L11 9 L13 12 L16 10 L19 12 L21 9 L25 11 L28 8 L32 9 L30 5 L27 4 L24 2 L21 4 L19 2 Z" fill="${col}"/></svg>`;
          const svgMarkup = batSvg(color);
          for (let i = 0; i < count; i++) {
            const bat = document.createElement('div');
            const size = 24 + Math.random() * 18;
            const top = 5 + Math.random() * 60;
            const duration = 10 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const dy = -8 + Math.random() * 16; // ± vertical drift across screen
            const flapDuration = 0.25 + Math.random() * 0.2;
            // Outer animates the horizontal+vertical sweep; inner animates the flap.
            // We achieve "two transforms at once" by nesting: the outer translate is
            // a separate element from the inner scaleY.
            const inner = document.createElement('div');
            inner.style.cssText = `width:${size}px;height:${size * 9 / 16}px;animation:ofPageBatFlap ${flapDuration}s ease-in-out infinite;`;
            inner.innerHTML = svgMarkup;
            bat.style.cssText = `position:absolute;left:0;top:${top}vh;animation:ofPageBatFly ${duration}s linear infinite;animation-delay:${delay}s;--of-bat-dy:${dy}vh;`;
            bat.appendChild(inner);
            root.appendChild(bat);
          }
        },
      },

      // ---------- CONFETTI ---------- (rectangular bits, multi-color)
      confetti: {
        defaultColor: '#ff4d4d',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const piece = document.createElement('div');
            const w = 4 + Math.random() * 6;
            const h = 8 + Math.random() * 8;
            const left = Math.random() * 100;
            const duration = 5 + Math.random() * 6;
            const delay = -Math.random() * duration;
            const sway = 30 + Math.random() * 70;
            // Vary hue by ±60deg for confetti-rainbow look around the chosen color
            const hueShift = Math.round(-60 + Math.random() * 120);
            piece.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${w}px;height:${h}px;background:${color};filter:hue-rotate(${hueShift}deg);animation:ofPageFall ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(piece);
          }
        },
      },

      // ---------- PETALS ---------- (cherry blossom / spring)
      petals: {
        defaultColor: '#ffb3d1',
        build(root, color, count) {
          const petalSvg = (col) => `<svg viewBox="0 0 16 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 C 4 6, 2 14, 8 23 C 14 14, 12 6, 8 1 Z" fill="${col}" stroke="${col}" stroke-width="0.3" opacity="0.85"/></svg>`;
          const svgMarkup = petalSvg(color);
          for (let i = 0; i < count; i++) {
            const petal = document.createElement('div');
            const size = 12 + Math.random() * 12;
            const left = Math.random() * 100;
            const duration = 12 + Math.random() * 10;
            const delay = -Math.random() * duration;
            const sway = 80 + Math.random() * 100;
            const opacity = 0.5 + Math.random() * 0.4;
            petal.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size * 1.5}px;opacity:${opacity};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.2));animation:ofPageDrift ${duration}s linear infinite, ofPageSway ${duration / 3}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            petal.innerHTML = svgMarkup;
            root.appendChild(petal);
          }
        },
      },

      // ---------- EMBERS ---------- (rising glowing dots)
      embers: {
        defaultColor: '#ff7a1a',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const ember = document.createElement('div');
            const size = 2 + Math.random() * 4;
            const left = Math.random() * 100;
            const duration = 6 + Math.random() * 6;
            const delay = -Math.random() * duration;
            const sway = 20 + Math.random() * 40;
            const opacity = 0.6 + Math.random() * 0.4;
            ember.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 ${size * 3}px ${color}aa, 0 0 ${size * 6}px ${color}55;--of-peak-opacity:${opacity};animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(ember);
          }
        },
      },

      // ---------- BUBBLES ---------- (rising spheres)
      bubbles: {
        defaultColor: '#a0d8ef',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const bubble = document.createElement('div');
            const size = 14 + Math.random() * 26;
            const left = Math.random() * 100;
            const duration = 9 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const sway = 25 + Math.random() * 50;
            const opacity = 0.3 + Math.random() * 0.4;
            bubble.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle at 30% 30%, ${color}cc, ${color}55 70%, ${color}11 100%);border:1px solid ${color}88;--of-peak-opacity:${opacity};animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(bubble);
          }
        },
      },

      // ---------- RAIN ---------- (vertical streaks)
      rain: {
        defaultColor: '#a8c5e0',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const drop = document.createElement('div');
            const left = Math.random() * 100;
            const len = 12 + Math.random() * 20;
            const duration = 0.5 + Math.random() * 0.7;
            const delay = -Math.random() * duration;
            const opacity = 0.25 + Math.random() * 0.45;
            drop.style.cssText = `position:absolute;left:${left}vw;top:0;width:1px;height:${len}px;background:linear-gradient(to bottom, ${color}00, ${color});opacity:${opacity};animation:ofPageRain ${duration}s linear infinite;animation-delay:${delay}s;`;
            root.appendChild(drop);
          }
        },
      },
    };

    // ============================================================
    // ENGINE — applyEffect drives the whole thing.
    // ============================================================
    function buildLayer() {
      ensureStyle();
      const el = document.createElement('div');
      el.id = 'of-page-effects';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = `position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9990;overflow:hidden;`;
      return el;
    }

    function teardown() {
      if (layer) { layer.remove(); layer = null; }
    }

    // Public-ish API. The visual-config poll calls this every 5s; if the
    // tuple (name, color, intensity) hasn't changed, we no-op.
    function applyEffect(rawName, rawColor, rawIntensity) {
      const name = String(rawName || 'none').toLowerCase();
      const intensity = (rawIntensity === 'subtle' || rawIntensity === 'heavy') ? rawIntensity : 'medium';
      const color = (rawColor && String(rawColor).trim()) || '';

      // Skip rebuild if nothing changed since last apply
      if (last.name === name && last.color === color && last.intensity === intensity) return;
      last = { name, color, intensity };

      teardown();
      const def = EFFECTS[name];
      if (!def) return; // 'none' or unknown — leave the page bare

      const effectiveColor = color || def.defaultColor;
      const count = pickCount(name, intensity);
      if (count <= 0) return;

      layer = buildLayer();
      try {
        def.build(layer, effectiveColor, count);
        document.body.appendChild(layer);
      } catch (err) {
        // Effect crashed — fail silent, leave page clean
        teardown();
      }
    }

    // Apply initial state from the bootstrap blob, with backward-compat
    // for the old pageSnowEnabled boolean (an older server / older template
    // bundle might still set it but not the new keys).
    const bootstrap = window.__SHOWPILOT__ || {};
    const initialName = bootstrap.pageEffect != null
      ? bootstrap.pageEffect
      : (bootstrap.pageSnowEnabled ? 'snow' : 'none');
    applyEffect(initialName, bootstrap.pageEffectColor || '', bootstrap.pageEffectIntensity || 'medium');

    // Expose so the unified visual-config poll (below) can drive updates
    window._ofApplyEffect = applyEffect;
    // Backward-compat shim: any caller still toggling _ofApplySnowState
    // gets routed through the new engine. Older RF-style templates might
    // poke this; preserving it is cheap.
    window._ofApplySnowState = function (enabled) {
      applyEffect(enabled ? 'snow' : 'none', '', 'medium');
    };
  })();

  // ============================================================
  // VISUAL CONFIG POLL — runs unconditionally. Drives snow toggle and the
  // server-side audio gate (control mode OFF, etc.). Does NOT include
  // location; location is checked at click time, not page load. The
  // server returns blocked: true only when the show is off — so the
  // button is visible whenever the show is running, and clicking it
  // triggers a fresh location prompt that's the actual safeguard.
  // ============================================================
  (function initVisualConfigPoll() {
    async function poll() {
      try {
        // Intentionally no location passed — see comment above. Server's
        // gate decision here is purely "is the show running?".
        const r = await fetch('/api/visual-config?gateCheck=mode', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          if (typeof window._ofApplyEffect === 'function') {
            // New three-knob API. Server sends pageEffect/Color/Intensity.
            // Falls back to legacy pageSnowEnabled boolean if the server
            // is older and only sends that.
            const name = data.pageEffect != null
              ? data.pageEffect
              : (data.pageSnowEnabled ? 'snow' : 'none');
            window._ofApplyEffect(name, data.pageEffectColor || '', data.pageEffectIntensity || 'medium');
          } else if (typeof window._ofApplySnowState === 'function') {
            // Pre-engine viewer (e.g. an older rf-compat.js on a stale tab) — keep working.
            window._ofApplySnowState(!!data.pageSnowEnabled);
          }
          applyAudioGateState(!!data.audioGateBlocked, data.audioGateReason || '');
          // Show-not-playing is a SEPARATE, non-sticky signal from the audio
          // gate. The launcher button stays visible (so viewers can still
          // tap it) but the player panel content swaps to a "Show isn't
          // playing right now" message. Toggles freely as FPP starts/stops.
          if (typeof window._ofApplyShowNotPlaying === 'function') {
            window._ofApplyShowNotPlaying(!!data.showNotPlaying);
          }
        }
      } catch {}
    }
    setInterval(poll, 5000);
    poll(); // immediate initial poll
  })();

  //
  // Two distinct concerns, kept separate:
  //   (1) Server-side block — show offline, control OFF, manual disable, etc.
  //       When blocked, the launcher button is hidden via CSS class. This is
  //       polled every 5s.
  //   (2) Location verification — happens at the moment the user taps the
  //       button (and periodically while audio plays). NOT on page load.
  //       This means a stale page can't accidentally let someone who's
  //       walked away (or never been there) play audio.
  //
  // The latch: once a server-side block fires during this page session, we
  // don't auto-reveal the button. The user must refresh the page to start
  // a fresh evaluation. This prevents auto-resume when admin flips control
  // off→on while the page was open.
  // ============================================================
  let _audioGateBlocked = false;
  let _audioGateReason = '';
  // Latch state — null when not latched, otherwise the CATEGORY of block:
  //   'server'    — admin disabled the show, control mode flipped, etc.
  //                 Sticky: only a page refresh clears this. We don't
  //                 want auto-resume when an admin toggles control.
  //   'proximity' — client-side watcher saw user move out of the radius.
  //                 NOT sticky: auto-clears when the watcher reports
  //                 back in-range, so the button reappears for one-tap
  //                 resume. This is the common "user walked across the
  //                 street and came back" case.
  let _gateLatchedBlocked = null;

  // Apply gate state. `category` distinguishes the two latch behaviors:
  //   'server'    — server-side block, refresh required to recover
  //   'proximity' — client-side proximity block, auto-clears on return
  // Defaults to 'server' since that's the conservative/legacy behavior
  // and most callers (the show-state poll, /api/now-playing-audio path,
  // periodic fallback) all want the sticky latch. Only the watcher's
  // direct out-of-range path passes 'proximity'.
  function applyAudioGateState(blocked, reason, category) {
    _audioGateBlocked = blocked;
    _audioGateReason = reason;
    if (blocked) {
      // 'server' wins over 'proximity' — if the server has already said
      // "you're blocked because show is offline", a subsequent proximity
      // block shouldn't downgrade the latch. Once a server latch is set,
      // it stays until refresh.
      if (_gateLatchedBlocked !== 'server') {
        _gateLatchedBlocked = category || 'server';
      }
    }
    const effectiveBlocked = blocked || _gateLatchedBlocked !== null;
    const btn = document.getElementById('of-listen-btn');
    const pill = document.getElementById('of-listen-minimized-pill');
    const panel = document.getElementById('of-listen-panel');
    if (btn) {
      if (effectiveBlocked) {
        btn.classList.add('of-audio-gate-pending');
      } else {
        btn.classList.remove('of-audio-gate-pending');
      }
    }
    if (pill && effectiveBlocked) pill.style.display = 'none';
    if (panel && effectiveBlocked) {
      panel.style.display = 'none';
      try { window.dispatchEvent(new CustomEvent('showpilot:audio-gate-blocked')); } catch {}
    }
  }

  // Lift a proximity latch — called by the watcher when the user re-enters
  // the radius after walking out. Does NOT affect server latches: if the
  // show is genuinely offline or admin has disabled the gate, we leave
  // that block in place. Only the proximity-specific latch is cleared.
  // After this call, the button/pill is revealed again — user taps to
  // resume audio. We don't auto-restart playback for two reasons:
  //   (1) Mobile audio contexts (especially iOS) require a user gesture
  //       to start playing, so silent auto-restart would fail anyway.
  //   (2) User agency — surprise music playing when someone walks past
  //       a parked car would be jarring. They tap when they're ready.
  function liftProximityLatch() {
    if (_gateLatchedBlocked !== 'proximity') return; // not our latch to lift
    _gateLatchedBlocked = null;
    _audioGateBlocked = false;
    _audioGateReason = '';
    const btn = document.getElementById('of-listen-btn');
    if (btn) {
      btn.classList.remove('of-audio-gate-pending');
      // Also restore the inline display — it was likely 'none' from when
      // the panel was open at the moment the watcher kicked out. Without
      // this, removing the CSS class lifts the !important but the inline
      // display:none still wins, leaving the button invisible.
      btn.style.display = 'flex';
    }
    // Note: we don't reveal pill/panel here — those were closed by the
    // out-of-range event, and re-opening them automatically would feel
    // weird. The launcher button reappears; user taps to start fresh.
  }
  window._ofAudioGate = () => ({ blocked: _audioGateBlocked, latched: _gateLatchedBlocked, reason: _audioGateReason });

  // Verify location with the server BEFORE allowing audio to start. This is
  // called at click time (and during playback re-checks). Returns a Promise
  // that resolves with { allowed, reason }. Forces a fresh GPS reading every
  // call — no maximumAge cache trickery.
  async function verifyLocationForAudio() {
    let loc;
    try {
      loc = await getFreshLocation();
    } catch (err) {
      return { allowed: false, reason: err.message || 'Location required' };
    }
    try {
      const r = await fetch(
        `/api/visual-config?lat=${encodeURIComponent(loc.lat)}&lng=${encodeURIComponent(loc.lng)}`,
        { credentials: 'include' }
      );
      if (!r.ok) return { allowed: false, reason: 'Server unavailable' };
      const data = await r.json();
      if (data.audioGateBlocked) {
        return { allowed: false, reason: data.audioGateReason || 'Audio not available right now.' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'Network error verifying location' };
    }
  }
  window._ofVerifyLocationForAudio = verifyLocationForAudio;

  // ============================================================
  // GATE DENIAL MODAL
  // Replaces the browser's native alert() with a themed modal that fits the
  // viewer page. Used when the audio gate denies listening (out of range,
  // location denied, show offline, etc.). One modal per page session reused
  // for all denials.
  // ============================================================
  let _gateModalEl = null;
  function ensureGateModal() {
    if (_gateModalEl) return _gateModalEl;
    const style = document.createElement('style');
    style.textContent = `
      #of-gate-modal {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(0,0,0,0.65);
        display: none; align-items: center; justify-content: center;
        padding: 1rem;
        animation: ofGateFadeIn 0.18s ease-out;
      }
      #of-gate-modal.show { display: flex; }
      @keyframes ofGateFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      #of-gate-modal-card {
        background: linear-gradient(180deg, rgba(30,30,40,0.98), rgba(20,20,28,0.98));
        color: #fff;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 14px;
        padding: 1.5rem 1.25rem 1.25rem;
        width: 100%; max-width: 380px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        text-align: center;
        animation: ofGateSlideUp 0.22s ease-out;
      }
      @keyframes ofGateSlideUp {
        from { transform: translateY(10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      #of-gate-modal-icon {
        font-size: 2.5rem; margin-bottom: 0.5rem; line-height: 1;
      }
      #of-gate-modal-title {
        font-size: 1.15rem; font-weight: 700;
        margin: 0 0 0.5rem; color: #fff;
      }
      #of-gate-modal-msg {
        font-size: 0.95rem; line-height: 1.4;
        color: rgba(255,255,255,0.88);
        margin: 0 0 1.25rem;
      }
      #of-gate-modal-btn {
        display: block; width: 100%;
        padding: 0.75rem 1rem;
        background: rgba(220,38,38,0.95); color: #fff;
        border: 0; border-radius: 8px;
        font-size: 0.95rem; font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, transform 0.1s;
      }
      #of-gate-modal-btn:hover { background: rgba(220,38,38,1); }
      #of-gate-modal-btn:active { transform: scale(0.98); }
    `;
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.id = 'of-gate-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div id="of-gate-modal-card">
        <div id="of-gate-modal-icon">🎧</div>
        <h3 id="of-gate-modal-title">Audio unavailable</h3>
        <p id="of-gate-modal-msg"></p>
        <button id="of-gate-modal-btn">OK</button>
      </div>
    `;
    document.body.appendChild(modal);

    const closeFn = () => modal.classList.remove('show');
    modal.querySelector('#of-gate-modal-btn').onclick = closeFn;
    // Tap-outside dismiss
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeFn();
    });
    // Escape dismiss
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('show')) closeFn();
    });

    _gateModalEl = modal;
    return modal;
  }

  function showGateModal(reason) {
    const modal = ensureGateModal();
    const msgEl = modal.querySelector('#of-gate-modal-msg');
    msgEl.textContent = reason || 'Audio is not available right now.';
    modal.classList.add('show');
  }
  window._ofShowGateModal = showGateModal;

  // ---- Player bar translation table ----
  // Translates the ~15 hardcoded strings in the player bar HTML and status
  // messages into the viewer's browser language. Client-side only — these
  // strings are injected by JS after page load so the server translator
  // never sees them. Falls back to English for any missing key or language.
  const _PLAYER_STRINGS = {
    es: {
      'Listen on phone': 'Escuchar en el teléfono',
      'Preparing…': 'Preparando…',
      'Play/pause': 'Reproducir/pausar',
      'Mute': 'Silenciar',
      'Hide player (audio keeps playing)': 'Ocultar reproductor (el audio continúa)',
      'Hide (audio keeps playing)': 'Ocultar (el audio continúa)',
      'Stop and close': 'Detener y cerrar',
      'Stop & close': 'Detener y cerrar',
      'Audio playing — tap to expand': 'Audio en reproducción — toca para expandir',
      'No audio for this sequence': 'Sin audio para esta secuencia',
      'Show is not playing': 'El espectáculo no está en marcha',
      'Idle': 'Inactivo',
      'No audio source available': 'No hay fuente de audio disponible',
      "Show isn't playing right now": 'El espectáculo no está en marcha ahora',
      'Winner!': '¡Ganador!',
    },
    fr: {
      'Listen on phone': 'Écouter sur le téléphone',
      'Preparing…': 'Préparation…',
      'Play/pause': 'Lecture/pause',
      'Mute': 'Couper le son',
      'Hide player (audio keeps playing)': 'Masquer le lecteur (audio continue)',
      'Hide (audio keeps playing)': 'Masquer (audio continue)',
      'Stop and close': 'Arrêter et fermer',
      'Stop & close': 'Arrêter et fermer',
      'Audio playing — tap to expand': 'Audio en lecture — appuyez pour agrandir',
      'No audio for this sequence': 'Pas d’audio pour cette séquence',
      'Show is not playing': 'Le spectacle n’est pas en cours',
      'Idle': 'Inactif',
      'No audio source available': 'Aucune source audio disponible',
      "Show isn't playing right now": 'Le spectacle n’est pas en cours maintenant',
      'Winner!': 'Gagnant !',
    },
    de: {
      'Listen on phone': 'Auf dem Telefon anhören',
      'Preparing…': 'Vorbereitung…',
      'Play/pause': 'Abspielen/Pause',
      'Mute': 'Stummschalten',
      'Hide player (audio keeps playing)': 'Player ausblenden (Audio läuft weiter)',
      'Hide (audio keeps playing)': 'Ausblenden (Audio läuft weiter)',
      'Stop and close': 'Stoppen und schließen',
      'Stop & close': 'Stoppen und schließen',
      'Audio playing — tap to expand': 'Audio läuft — tippe zum Erweitern',
      'No audio for this sequence': 'Kein Audio für diese Sequenz',
      'Show is not playing': 'Die Show läuft nicht',
      'Idle': 'Inaktiv',
      'No audio source available': 'Keine Audioquelle verfügbar',
      "Show isn't playing right now": 'Die Show läuft gerade nicht',
      'Winner!': 'Gewinner!',
    },
    pt: {
      'Listen on phone': 'Ouvir no telefone',
      'Preparing…': 'Preparando…',
      'Play/pause': 'Reproduzir/pausar',
      'Mute': 'Silenciar',
      'Hide player (audio keeps playing)': 'Ocultar player (áudio continua)',
      'Hide (audio keeps playing)': 'Ocultar (áudio continua)',
      'Stop and close': 'Parar e fechar',
      'Stop & close': 'Parar e fechar',
      'Audio playing — tap to expand': 'Áudio tocando — toque para expandir',
      'No audio for this sequence': 'Sem áudio para esta sequência',
      'Show is not playing': 'O show não está tocando',
      'Idle': 'Inativo',
      'No audio source available': 'Nenhuma fonte de áudio disponível',
      "Show isn't playing right now": 'O show não está tocando agora',
      'Winner!': 'Vencedor!',
    },
    it: {
      'Listen on phone': 'Ascolta sul telefono',
      'Preparing…': 'Preparazione…',
      'Play/pause': 'Riproduci/pausa',
      'Mute': 'Silenzia',
      'Hide player (audio keeps playing)': 'Nascondi player (audio continua)',
      'Hide (audio keeps playing)': 'Nascondi (audio continua)',
      'Stop and close': 'Ferma e chiudi',
      'Stop & close': 'Ferma e chiudi',
      'Audio playing — tap to expand': 'Audio in riproduzione — tocca per espandere',
      'No audio for this sequence': 'Nessun audio per questa sequenza',
      'Show is not playing': 'Lo show non è in corso',
      'Idle': 'Inattivo',
      'No audio source available': 'Nessuna sorgente audio disponibile',
      "Show isn't playing right now": 'Lo show non è in corso adesso',
      'Winner!': 'Vincitore!',
    },
    pl: {
      'Listen on phone': 'Słuchaj na telefonie',
      'Preparing…': 'Przygotowanie…',
      'Play/pause': 'Odtwórz/pauza',
      'Mute': 'Wycisz',
      'Hide player (audio keeps playing)': 'Ukryj odtwarzacz (audio gra dalej)',
      'Hide (audio keeps playing)': 'Ukryj (audio gra dalej)',
      'Stop and close': 'Zatrzymaj i zamknij',
      'Stop & close': 'Zatrzymaj i zamknij',
      'Audio playing — tap to expand': 'Audio odtwarzane — dotknij, aby rozwinąć',
      'No audio for this sequence': 'Brak dźwięku dla tej sekwencji',
      'Show is not playing': 'Pokaz nie jest odtwarzany',
      'Idle': 'Bezczynny',
      'No audio source available': 'Brak dostępnego źródła dźwięku',
      "Show isn't playing right now": 'Pokóz nie jest teraz odtwarzany',
      'Winner!': 'Zwycięzca!',
    },
  };

  // Translate a player bar string using the viewer's browser language.
  // Returns the original string if no translation is found.
  function _pt(str) {
    // navigator.languages[0] is the first preference (what Accept-Language sends).
    // navigator.language is the browser UI language, which may differ.
    const preferred = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    const lang = preferred.split('-')[0].toLowerCase();
    const table = _PLAYER_STRINGS[lang];
    return (table && table[str]) || str;
  }

  (function initListenOnPhone() {
    // ---- Floating launcher button ----
    //
    // Customizable per admin Settings → Viewer Page → Listen Button:
    //   - launcherIconSource: 'default' | 'preset:<key>' | 'custom'
    //   - launcherIconData: base64 data URL when source='custom'
    //   - launcherShowChrome: round red button background visible
    //   - launcherSize: 'small' | 'medium' | 'large' (40 / 52 / 72 px)
    //
    // Presets are inline SVGs (compact, scale cleanly, no extra requests).
    // Sized to the button via 100% width/height; SVGs use currentColor so
    // they pick up the button's text color when chrome is enabled.

    const LAUNCHER_PRESETS = {
      headphones: '<svg viewBox="0 0 24 24" fill="currentColor" width="60%" height="60%" style="display:block;"><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 1 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z"/></svg>',
      tree: '<svg viewBox="0 0 24 24" fill="currentColor" width="65%" height="65%" style="display:block;"><path d="M12 2L7 9h3l-4 6h3l-5 7h16l-5-7h3l-4-6h3l-5-7zm-1 19h2v2h-2v-2z"/></svg>',
      pumpkin: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 4c-.7 0-1.3.3-1.7.8A2.5 2.5 0 0 0 8 5C5 5 3 8 3 12s2 7 5 7c.6 0 1.2-.1 1.7-.4.7.5 1.5.8 2.3.8s1.6-.3 2.3-.8c.5.3 1.1.4 1.7.4 3 0 5-3 5-7s-2-7-5-7c-.8 0-1.6.3-2.3.8C12.6 4.3 12.3 4 12 4zm-3 7l1.5 2L9 15l-1.5-2L9 11zm6 0l1.5 2L15 15l-1.5-2L15 11zm-5 4h4l-1 2h-2l-1-2z"/></svg>',
      ghost: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 2a8 8 0 0 0-8 8v12l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2v-12a8 8 0 0 0-8-8zm-3 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
      snowflake: '<svg viewBox="0 0 24 24" fill="currentColor" width="65%" height="65%" style="display:block;"><path d="M12 2v3.5l2-1.5 1 1.3-3 2.2v3l2.6-1.5.5-3.6 1.7.2-.3 2.4 3-1.7.9 1.5-3 1.7 2.2.9-.7 1.6-3-1.2L17 12l2.2 1.2 3-1.2.7 1.6-2.2.9 3 1.7-.9 1.5-3-1.7.3 2.4-1.7.2-.5-3.6-2.6-1.5v3l3 2.2-1 1.3-2-1.5V22h-2v-3.5l-2 1.5-1-1.3 3-2.2v-3l-2.6 1.5-.5 3.6-1.7-.2.3-2.4-3 1.7-.9-1.5 3-1.7L4.6 13l.7-1.6 3 1.2L7 12l-2.2-1.2-3 1.2-.7-1.6 2.2-.9-3-1.7.9-1.5 3 1.7-.3-2.4 1.7-.2.5 3.6L9 9.5v-3L6 4.3l1-1.3 2 1.5V2h3z" transform="scale(0.85) translate(2.1,2.1)"/></svg>',
      music: '<svg viewBox="0 0 24 24" fill="currentColor" width="60%" height="60%" style="display:block;"><path d="M19.952 1.651a.75.75 0 01.298.599V16.303a3 3 0 01-2.176 2.884l-1.32.377a2.553 2.553 0 11-1.403-4.909l2.311-.66a1.5 1.5 0 001.088-1.442V6.994l-9 2.572v9.737a3 3 0 01-2.176 2.884l-1.32.377a2.553 2.553 0 11-1.402-4.909l2.31-.66a1.5 1.5 0 001.088-1.442V5.25a.75.75 0 01.544-.721l10.5-3a.75.75 0 01.658.122z"/></svg>',
      heart: '<svg viewBox="0 0 24 24" fill="currentColor" width="60%" height="60%" style="display:block;"><path d="M12 21s-7-4.5-9.5-9.5C1 8 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6 4 4.5 7.5C19 16.5 12 21 12 21z"/></svg>',
      shamrock: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 11c-1.5-3-4.5-3-5.5-1.5S6 13 9 14c-2.5 1-3 4-1.5 5s4 .5 5-2c0 3 2 5 4 5s4-2 4-5c1 2.5 3.5 3 5 2s1-4-1.5-5c3-1 4-3.5 2.5-4.5S14 8 12.5 11l-.5-9-.5 9z" transform="translate(0,1)"/></svg>',
      star: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7l3-7z"/></svg>',
    };

    // Resolve config to concrete style values.
    const SIZES = { small: 40, medium: 52, large: 72 };
    const launcherPx = SIZES[boot.launcherSize] || SIZES.medium;
    const showChrome = boot.launcherShowChrome !== false;
    const iconSource = boot.launcherIconSource || 'default';

    // Build the icon HTML based on source. If a custom image fails to load,
    // we fall back to the default emoji visually (broken-image alt would
    // look bad as a launcher). Image fills more of the button when chrome
    // is off (no border to compete with) and leaves padding when chrome is
    // on so the icon doesn't crowd the red ring.
    const iconSizePct = showChrome ? 75 : 100;
    let iconHtml;
    if (iconSource === 'custom' && boot.launcherIconData) {
      iconHtml =
        '<img src="' + boot.launcherIconData + '" alt="" ' +
        'style="width:' + iconSizePct + '%;height:' + iconSizePct + '%;' +
        'object-fit:contain;display:block;" ' +
        'onerror="this.outerHTML=\'\\u{1F3A7}\';" />';
    } else if (iconSource && iconSource.indexOf('preset:') === 0) {
      const key = iconSource.slice(7);
      iconHtml = LAUNCHER_PRESETS[key] || '🎧';
    } else {
      iconHtml = '🎧';
    }

    const btn = document.createElement('button');
    btn.id = 'of-listen-btn';
    btn.setAttribute('aria-label', _pt('Listen on phone'));
    btn.title = _pt('Listen on phone');
    btn.innerHTML = iconHtml;

    // Chrome ON — original red round button with image/SVG inside.
    // Chrome OFF — bare image: no background, no border, no shadow. The
    // image itself is the affordance. We still keep cursor:pointer and a
    // subtle drop-shadow so it reads as tappable on light backgrounds.
    const chromeStyles = showChrome
      ? `background: rgba(220,38,38,0.95); color: white;
         border: 2px solid rgba(255,255,255,0.4);
         box-shadow: 0 4px 12px rgba(0,0,0,0.4);`
      : `background: transparent; color: white;
         border: 0;
         filter: drop-shadow(0 2px 6px rgba(0,0,0,0.45));`;

    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      width: ${launcherPx}px; height: ${launcherPx}px; border-radius: 50%;
      ${chromeStyles}
      font-size: ${Math.round(launcherPx * 0.46)}px; cursor: pointer;
      transition: transform 0.15s, background 0.15s, opacity 0.2s;
      padding: 0; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
    `;
    // If audio is disabled at the show level, force the button hidden.
    // Distinct from the audio-gate-pending class (which can be lifted
    // when location verifies) — this one stays hidden until admin
    // re-enables audio and the viewer reloads. We still build the rest
    // of the player so we don't have to add null-checks all through the
    // initialization code; it just stays out of view.
    if (!boot.audioEnabled) {
      btn.style.display = 'none';
    }
    // If audio gate is enabled, hide the button initially via CSS class
    // (with !important so other state changes like setMode('closed') can't
    // accidentally reveal it). The button is only revealed once the visual-config
    // poll confirms the viewer's location is within range AND the show is on.
    if (boot.audioGateEnabled) btn.classList.add('of-audio-gate-pending');
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };

    // ---- Theme palettes (player bar colors per decoration) ----
    // Each palette: bg gradient + border accent + glow color.
    // CSS variables let decoration code read the active theme color.
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `
      /* Audio gate — hides launcher button until server confirms viewer is in range.
         Uses !important so setMode('closed') and other state transitions can't
         accidentally reveal it. */
      .of-audio-gate-pending {
        display: none !important;
      }
      #of-listen-panel {
        --of-bg: rgba(20,20,30,0.97);
        --of-border: rgba(255,255,255,0.15);
        --of-glow: rgba(0,0,0,0);
        --of-text: #fff;
        --of-text-dim: #aaa;
        background: var(--of-bg) !important;
        border-top: 1px solid var(--of-border) !important;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.5), 0 -2px 12px var(--of-glow);
        color: var(--of-text);
        transition: background 0.4s, border-color 0.4s, box-shadow 0.4s;
      }
      #of-listen-panel.of-theme-christmas {
        --of-bg: linear-gradient(180deg, rgba(127,29,29,0.97), rgba(20,83,45,0.97));
        --of-border: rgba(254,202,202,0.8);
        --of-glow: rgba(239,68,68,0.5);
      }
      #of-listen-panel.of-theme-halloween {
        --of-bg: linear-gradient(180deg, rgba(88,28,135,0.97), rgba(154,52,18,0.97));
        --of-border: rgba(253,186,116,0.8);
        --of-glow: rgba(251,146,60,0.5);
      }
      #of-listen-panel.of-theme-easter {
        --of-bg: linear-gradient(180deg, rgba(168,85,247,0.95), rgba(96,165,250,0.95));
        --of-border: rgba(251,207,232,0.9);
        --of-glow: rgba(251,207,232,0.5);
      }
      #of-listen-panel.of-theme-stpatricks {
        --of-bg: linear-gradient(180deg, rgba(21,128,61,0.97), rgba(20,83,45,0.97));
        --of-border: rgba(134,239,172,0.8);
        --of-glow: rgba(34,197,94,0.5);
      }
      #of-listen-panel.of-theme-independence {
        --of-bg: linear-gradient(180deg, rgba(30,64,175,0.97), rgba(153,27,27,0.97));
        --of-border: rgba(255,255,255,0.85);
        --of-glow: rgba(96,165,250,0.5);
      }
      #of-listen-panel.of-theme-valentines {
        --of-bg: linear-gradient(180deg, rgba(190,24,93,0.97), rgba(112,26,117,0.97));
        --of-border: rgba(251,207,232,0.85);
        --of-glow: rgba(244,114,182,0.5);
      }
      #of-listen-panel.of-theme-hanukkah {
        --of-bg: linear-gradient(180deg, rgba(29,78,216,0.97), rgba(30,58,138,0.97));
        --of-border: rgba(191,219,254,0.85);
        --of-glow: rgba(96,165,250,0.5);
      }
      #of-listen-panel.of-theme-thanksgiving {
        --of-bg: linear-gradient(180deg, rgba(154,52,18,0.97), rgba(120,53,15,0.97));
        --of-border: rgba(253,186,116,0.8);
        --of-glow: rgba(234,88,12,0.5);
      }
      #of-listen-panel.of-theme-snow {
        --of-bg: linear-gradient(180deg, rgba(30,64,175,0.95), rgba(15,23,42,0.97));
        --of-border: rgba(186,230,253,0.85);
        --of-glow: rgba(186,230,253,0.5);
      }
      #of-listen-panel.of-theme-newyear {
        --of-bg: linear-gradient(180deg, rgba(15,23,42,0.97), rgba(49,46,129,0.97));
        --of-border: rgba(250,204,21,0.8);
        --of-glow: rgba(250,204,21,0.45);
      }
      #of-listen-panel.of-theme-dayofthedead {
        --of-bg: linear-gradient(180deg, rgba(157,23,77,0.97), rgba(76,29,149,0.97));
        --of-border: rgba(251,146,60,0.85);
        --of-glow: rgba(236,72,153,0.5);
      }
      #of-listen-panel.of-theme-diwali {
        --of-bg: linear-gradient(180deg, rgba(127,29,29,0.97), rgba(49,46,129,0.97));
        --of-border: rgba(251,191,36,0.85);
        --of-glow: rgba(251,191,36,0.5);
      }
      #of-listen-panel.of-theme-kwanzaa {
        --of-bg: linear-gradient(180deg, rgba(20,83,45,0.97), rgba(17,24,39,0.97));
        --of-border: rgba(220,38,38,0.8);
        --of-glow: rgba(34,197,94,0.45);
      }
      #of-listen-panel.of-theme-lunarnewyear {
        --of-bg: linear-gradient(180deg, rgba(185,28,28,0.97), rgba(127,29,29,0.97));
        --of-border: rgba(250,204,21,0.85);
        --of-glow: rgba(239,68,68,0.5);
      }
      #of-listen-panel.of-theme-mardigras {
        --of-bg: linear-gradient(180deg, rgba(88,28,135,0.97), rgba(21,128,61,0.97));
        --of-border: rgba(234,179,8,0.85);
        --of-glow: rgba(168,85,247,0.5);
      }

      /* Player button polish — hover feedback that works regardless of theme */
      #of-listen-panel button {
        outline: none;
      }
      #of-listen-panel button:focus-visible {
        outline: 2px solid rgba(255,255,255,0.6);
        outline-offset: 2px;
      }
      #of-listen-panel #of-listen-playpause:hover {
        background: rgba(255,255,255,0.25) !important;
        transform: scale(1.05);
      }
      #of-listen-panel #of-listen-playpause:active {
        transform: scale(0.95);
      }
      #of-listen-panel #of-listen-mute:hover,
      #of-listen-panel #of-listen-min:hover,
      #of-listen-panel #of-listen-close:hover {
        background: rgba(255,255,255,0.12);
        color: #fff !important;
      }
      #of-listen-panel #of-listen-close:hover {
        color: #ef4444 !important;
      }

      /* Language picker buttons */
      .of-lang-btn {
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(255,255,255,0.2);
        color: rgba(255,255,255,0.75);
        border-radius: 4px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        line-height: 1.4;
        font-family: system-ui, -apple-system, sans-serif;
      }
      .of-lang-btn:hover {
        background: rgba(255,255,255,0.18);
        color: #fff;
      }
      .of-lang-btn.of-lang-active {
        background: rgba(255,255,255,0.25);
        border-color: rgba(255,255,255,0.6);
        color: #fff;
      }

      /* Marquee scroll for long titles/artists */
      @keyframes ofMarquee {
        0%   { transform: translateX(0); }
        15%  { transform: translateX(0); }   /* hold start briefly */
        50%  { transform: translateX(var(--of-marquee-offset, 0)); }
        65%  { transform: translateX(var(--of-marquee-offset, 0)); }   /* hold end */
        100% { transform: translateX(0); }
      }
      #of-listen-title.of-marquee-on,
      #of-listen-artist.of-marquee-on {
        animation: ofMarquee var(--of-marquee-duration, 10s) ease-in-out infinite;
      }
      #of-listen-title-wrap:hover #of-listen-title,
      #of-listen-artist-wrap:hover #of-listen-artist {
        animation-play-state: paused;
      }
    `;
    document.head.appendChild(themeStyle);

    // ---- Sticky-bottom panel ----
    const panel = document.createElement('div');
    panel.id = 'of-listen-panel';
    panel.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      padding: 12px 16px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 14px; line-height: 1.4;
      display: none;
      transform: translateY(100%);
      transition: transform 0.25s ease-out, background 0.4s, border-color 0.4s;
      backdrop-filter: blur(8px);
    `;
    panel.innerHTML = `
      <div class="of-listen-row" style="max-width: 800px; margin: 0 auto; display: flex; gap: 12px; align-items: center; position: relative; z-index: 2;">
        <img id="of-listen-cover" src="" alt=""
             style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;
                    background: #333; flex-shrink: 0;" />
        <div class="of-listen-text" style="flex: 1; min-width: 0;">
          <div id="of-listen-title-wrap" style="overflow: hidden; white-space: nowrap;">
            <div id="of-listen-title" style="font-weight: 600; display: inline-block;
                 white-space: nowrap;">Loading…</div>
          </div>
          <div id="of-listen-artist-wrap" style="overflow: hidden; white-space: nowrap;">
            <div id="of-listen-artist" style="font-size: 12px; color: rgba(255,255,255,0.65);
                 display: inline-block; white-space: nowrap;"></div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 10px; color: rgba(255,255,255,0.5);">
            <span id="of-listen-status"></span>
            <span id="of-listen-drift"></span>
          </div>
        </div>
        <!-- v0.33.215: groups the controls. display:contents keeps the normal
             single-row layout identical; the optional two-row phone layout
             (.sp-player-tall) turns this into the second row. -->
        <div class="of-listen-controls" style="display: contents;">
        <button id="of-listen-playpause" aria-label="Play/pause"
                style="background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.1); color: #fff;
                       width: 40px; height: 40px; border-radius: 50%;
                       cursor: pointer; flex-shrink: 0; padding: 0;
                       display: flex; align-items: center; justify-content: center;
                       transition: background 0.15s, transform 0.1s;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        <button id="of-listen-mute" aria-label="Mute"
                style="background: transparent; border: 0; color: rgba(255,255,255,0.75);
                       cursor: pointer; flex-shrink: 0; padding: 8px; line-height: 0;
                       border-radius: 6px; transition: background 0.15s, color 0.15s;
                       display: flex; align-items: center; justify-content: center;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 10v4a1 1 0 0 0 1 1h3l4 4a1 1 0 0 0 1.7-.7V5.7A1 1 0 0 0 11 5L7 9H4a1 1 0 0 0-1 1zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>
          </svg>
        </button>
        <button id="of-listen-min" aria-label="Hide player (audio keeps playing)"
                title="Hide (audio keeps playing)"
                style="background: transparent; border: 0; color: rgba(255,255,255,0.75);
                       cursor: pointer; flex-shrink: 0; padding: 8px; line-height: 0;
                       border-radius: 6px; transition: background 0.15s, color 0.15s;
                       display: flex; align-items: center; justify-content: center;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 13H5v-2h14v2z"/>
          </svg>
        </button>
        <button id="of-listen-close" aria-label="Stop and close"
                title="Stop &amp; close"
                style="background: transparent; border: 0; color: rgba(255,255,255,0.75);
                       cursor: pointer; flex-shrink: 0; padding: 8px; line-height: 0;
                       border-radius: 6px; transition: background 0.15s, color 0.15s;
                       display: flex; align-items: center; justify-content: center;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>
          </svg>
        </button>
        </div>
      </div>
      <div id="of-lang-row" style="display:none; max-width:800px; margin:6px auto 0;
           padding-top:8px; border-top:1px solid rgba(255,255,255,0.1);
           gap:6px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:11px; color:rgba(255,255,255,0.5); flex-shrink:0;">&#x1F310; Language:</span>
        <div id="of-lang-btns" style="display:flex; gap:5px; flex-wrap:wrap;"></div>
      </div>
    `;

    // ---- Minimized "still playing" pill ----
    const minimizedPill = document.createElement('button');
    minimizedPill.id = 'of-listen-pill';
    minimizedPill.setAttribute('aria-label', _pt('Audio playing — tap to expand'));
    minimizedPill.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      background: rgba(220,38,38,0.95); color: white;
      border: 2px solid rgba(255,255,255,0.4);
      border-radius: 999px; padding: 8px 14px 8px 12px;
      font-size: 13px; font-weight: 500;
      cursor: pointer; display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      align-items: center; gap: 6px; max-width: 240px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    `;
    minimizedPill.innerHTML = `
      <span style="display: inline-block; width: 8px; height: 8px; background: #4ade80; border-radius: 50%; animation: ofPulse 1.5s infinite;"></span>
      <span id="of-listen-pill-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Playing</span>
    `;

    // Add pulse animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes ofPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.2); }
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(btn);
    document.body.appendChild(panel);
    document.body.appendChild(minimizedPill);

    // ---- DOM refs ----
    const titleEl = panel.querySelector('#of-listen-title');
    const titleWrap = panel.querySelector('#of-listen-title-wrap');
    const artistEl = panel.querySelector('#of-listen-artist');
    const artistWrap = panel.querySelector('#of-listen-artist-wrap');
    const coverEl = panel.querySelector('#of-listen-cover');
    const statusEl = panel.querySelector('#of-listen-status');
    statusEl.textContent = _pt('Preparing…');
    // Only show the drift/calibration readout when player stats are enabled in admin
    // Settings → Debug. When off, set driftEl to null so all downstream writes are no-ops.
    const playerStatsEnabled = !!(window.__SHOWPILOT__ && window.__SHOWPILOT__.playerStatsEnabled);
    const driftEl = playerStatsEnabled ? panel.querySelector('#of-listen-drift') : null;

    // ---- Microphone sync measurement (debug, v0.33.218) ----
    // Settings → Debug → "Microphone sync measurement" (boot.micMeasureEnabled;
    // sp-mic.js provides SPMicCore). Records the mic with the phone playing
    // (hears phone + show speakers) and then muted (speakers only), and finds
    // both copies of the song by GCC-PHAT against the decoded track. The
    // phone − speakers gap is independent of mic/output delays. Nothing here
    // changes sync; it only reports.
    const micEnabled = !!(window.__SHOWPILOT__ && window.__SHOWPILOT__.micMeasureEnabled);
    const micResults = [];
    let micBusy = false;
    function micPanel(text, isHtml) {
      let p = document.getElementById('sp-mic-panel');
      if (!p) {
        p = document.createElement('div');
        p.id = 'sp-mic-panel';
        p.setAttribute('role', 'status');
        p.style.cssText = 'position:fixed;left:12px;right:12px;bottom:222px;z-index:10002;max-width:460px;margin:0 auto;' +
          'padding:12px 14px;border-radius:12px;background:rgba(10,12,20,.94);color:#e8eaf2;border:1px solid rgba(255,255,255,.18);' +
          'font:14px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)';
        document.body.appendChild(p);
      }
      if (isHtml) p.innerHTML = text; else p.textContent = text;
    }
    function monoSlice(buf, startSec, len) {
      const sr = buf.sampleRate, out = new Float32Array(len), s0 = Math.round(startSec * sr);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) { const j = s0 + i; if (j >= 0 && j < d.length) out[i] += d[j] / buf.numberOfChannels; }
      }
      return out;
    }
    function micCapture(stream, secs) {
      return new Promise((resolve) => {
        const sr = audioCtx.sampleRate, need = Math.round(secs * sr);
        const src = audioCtx.createMediaStreamSource(stream);
        const proc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        src.connect(proc); proc.connect(sink); sink.connect(audioCtx.destination);
        const chunks = []; let total = 0, startCtx = null;
        proc.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0);
          // Rough start time — only used to pick the stretch of song to search
          // (±1 s window), never in the result itself.
          if (startCtx === null) startCtx = audioCtx.currentTime - d.length / sr;
          chunks.push(new Float32Array(d)); total += d.length;
          if (total >= need) {
            proc.onaudioprocess = null;
            try { src.disconnect(); proc.disconnect(); sink.disconnect(); } catch (_) {}
            const mic = new Float32Array(need); let o = 0;
            for (const c of chunks) { const n = Math.min(c.length, need - o); mic.set(c.subarray(0, n), o); o += n; if (o >= need) break; }
            resolve({ mic, startCtx });
          }
        };
      });
    }
    function micRef(cap) {
      const expected = renderedPosAt(cap.startCtx);
      if (expected === null || expected === undefined || !isFinite(expected)) return null;
      const sr = currentBuffer.sampleRate;
      const refStartSec = Math.max(0, expected - 1.0);
      return { mic: cap.mic, ref: monoSlice(currentBuffer, refStartSec, cap.mic.length + Math.round(2.2 * sr)), refStartSec, expectedPosSec: expected };
    }
    async function micMeasure() {
      if (micBusy) return;
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        micPanel('The microphone needs the normal https:// viewer page. Open it from your show\'s web address.'); return;
      }
      if (!window.SPMicCore) { micPanel('Measurement code not loaded — reload the page.'); return; }
      if (!audioCtx || !currentBuffer || !currentSource) { micPanel('Start listening first, then tap Measure sync while a song plays.'); return; }
      micBusy = true;
      const buf = currentBuffer;
      const wasMuted = isMuted;
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (gainNode) gainNode.gain.value = 1;
        micPanel('Step 1 of 2 — listening with the phone playing (3 s)… keep the phone\'s volume up and stay still.');
        const a = await micCapture(stream, 3);
        if (gainNode) gainNode.gain.value = 0;
        micPanel('Step 2 of 2 — listening to the show speakers only (3 s)…');
        const b = await micCapture(stream, 3);
        if (gainNode) gainNode.gain.value = wasMuted ? 0 : 1;
        stream.getTracks().forEach(tr => tr.stop()); stream = null;
        if (currentBuffer !== buf) { micPanel('The song changed during the measurement. Try again mid-song.'); return; }
        const A = micRef(a), B = micRef(b);
        if (!A || !B) { micPanel('Could not read the player position. Try again mid-song.'); return; }
        micPanel('Analyzing…');
        await new Promise(r => setTimeout(r, 50));
        const r = window.SPMicCore.analyze(A, B, buf.sampleRate);
        console.log('[ShowPilot] mic measurement:', JSON.stringify({ ok: r.ok, deltaMs: r.deltaMs, merged: r.merged, reason: r.reason,
          speakerPeaks: (r.pb || []).slice(0, 4).map(p => [Math.round(p.rel * 1000), Math.round(p.strength)]),
          playingPeaks: (r.pa || []).slice(0, 4).map(p => [Math.round(p.rel * 1000), Math.round(p.strength)]),
          showOffsetMs: audioSyncOffsetMs, listenerOffsetMs: Math.round((listenerOffsetSec || 0) * 1000) }));
        if (!r.ok) { micPanel('No result: ' + r.reason + '. Try again.'); return; }
        micResults.push(r.deltaMs);
        const n = micResults.length;
        const avg = Math.round(micResults.reduce((x, y) => x + y, 0) / n);
        const d = r.deltaMs;
        const verdict = r.merged ? 'In sync: the phone and the show speakers land within a few ms of each other.'
          : d > 0 ? 'The show speakers are <b>' + d + ' ms behind</b> this phone.'
          : 'The show speakers are <b>' + (-d) + ' ms ahead of</b> this phone.';
        const suggest = Math.round(audioSyncOffsetMs + avg);
        micPanel(verdict +
          '<div style="margin-top:6px;color:#aab0c0">Runs: ' + micResults.join(', ') + ' ms (average ' + (avg >= 0 ? '+' : '') + avg + ' ms)' +
          '<br>Show offset now ' + audioSyncOffsetMs + ' ms → try <b style="color:#fff">' + suggest + ' ms</b> (Settings → Audio → Offset), then reload and measure again.' +
          ((listenerOffsetSec || 0) !== 0 ? '<br>Note: this phone also has its own timing offset of ' + Math.round(listenerOffsetSec * 1000) + ' ms set.' : '') +
          '</div>', true);
      } catch (e) {
        if (gainNode) gainNode.gain.value = wasMuted ? 0 : 1;
        micPanel(e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Measurement failed: ' + (e && e.message ? e.message : e));
      } finally {
        if (stream) stream.getTracks().forEach(tr => tr.stop());
        micBusy = false;
      }
    }
    if (micEnabled) {
      const mb = document.createElement('button');
      mb.type = 'button';
      mb.id = 'sp-mic-btn';
      mb.textContent = '🎤 Measure sync';
      mb.style.cssText = 'position:fixed;left:12px;bottom:170px;z-index:10001;padding:10px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.25);' +
        'background:rgba(10,12,20,.9);color:#fff;font:600 14px system-ui,-apple-system,sans-serif;cursor:pointer';
      mb.addEventListener('click', () => micMeasure());
      document.body.appendChild(mb);
    }

    // ---- Larger two-row player on phones (v0.33.215+) ----
    // Admin setting player_tall_layout (boot.playerTallLayout), off by default.
    // On screens <= 600px wide the player becomes two rows: cover + full-width
    // title/artist, then the controls spread across a second row with a larger
    // play/pause. Pure CSS on the existing elements (same buttons, handlers and
    // ids); tablets/desktop keep the single row. Same query as isTallPlayer().
    const TALL_QUERY = '(max-width: 600px)';
    const playerTallEnabled = !!(window.__SHOWPILOT__ && window.__SHOWPILOT__.playerTallLayout);
    function isTallPlayer() {
      if (!playerTallEnabled) return false;
      try { return window.matchMedia(TALL_QUERY).matches; } catch (_) { return false; }
    }
    if (playerTallEnabled) {
      panel.classList.add('sp-player-tall');
      if (!document.getElementById('sp-player-tall-styles')) {
        const st = document.createElement('style');
        st.id = 'sp-player-tall-styles';
        st.textContent =
          '@media ' + TALL_QUERY + '{' +
            '#of-listen-panel.sp-player-tall{padding-top:14px !important;padding-bottom:calc(12px + env(safe-area-inset-bottom,0px)) !important}' +
            '#of-listen-panel.sp-player-tall .of-listen-row{display:grid !important;grid-template-columns:48px minmax(0,1fr);column-gap:12px;row-gap:10px}' +
            '#of-listen-panel.sp-player-tall #of-listen-cover{grid-column:1;grid-row:1}' +
            '#of-listen-panel.sp-player-tall .of-listen-text{grid-column:2;grid-row:1}' +
            '#of-listen-panel.sp-player-tall #of-listen-title{font-size:16px}' +
            '#of-listen-panel.sp-player-tall #of-listen-artist{font-size:13px !important}' +
            '#of-listen-panel.sp-player-tall .of-listen-controls{display:flex !important;grid-column:1 / -1;grid-row:2;align-items:center;justify-content:space-between;padding:0 4px}' +
            '#of-listen-panel.sp-player-tall .of-listen-controls > button{min-width:44px;min-height:44px}' +
            '#of-listen-panel.sp-player-tall #sp-lt-btn{order:1}' +
            '#of-listen-panel.sp-player-tall #of-listen-mute{order:2}' +
            '#of-listen-panel.sp-player-tall #of-listen-playpause{order:3;width:52px !important;height:52px !important}' +
            '#of-listen-panel.sp-player-tall #of-listen-min{order:4}' +
            '#of-listen-panel.sp-player-tall #of-listen-close{order:5}' +
            '#of-listen-panel.sp-player-tall #of-listen-not-playing{order:4;flex:1}' +
            '#of-listen-panel.sp-player-tall.sp-not-playing .of-listen-row{row-gap:0}' +
          '}';
        document.head.appendChild(st);
      }
    }

    // ---- Listener audio timing (v0.33.213+) ----
    // Phones can't report Bluetooth / car-stereo delay to a web page, but
    // the listener can hear it. A per-phone offset (localStorage only, never
    // sent anywhere) is added to getOutputLatencySec(), which every sync path
    // already uses to play audio early by the device's output delay — so the
    // start position, snap, follow-up and drift loop all honor it, and the
    // existing speed-nudge / crossfade correction applies it smoothly.
    // Positive = play earlier ("music is late"). Admin switch:
    // listener_timing_enabled (boot.listenerTimingEnabled); off = no button
    // and any saved offset ignored.
    const listenerTimingEnabled = !(window.__SHOWPILOT__ && window.__SHOWPILOT__.listenerTimingEnabled === false);
    const LT_KEY = 'sp_listener_offset_ms';
    // Slider range: admin-configurable (v0.33.218+, listener_timing_min_ms /
    // _max_ms), sanitized here so a typo can't break the player: min in
    // [-2000, 0], max in [0, 3000], min < max, else the defaults.
    const LT_RANGE = (() => {
      const b = window.__SHOWPILOT__ || {};
      // Blank / missing means "use the default" (Number(null) would be 0).
      const num = (v) => (v === null || v === undefined || v === '' ? NaN : Math.round(Number(v)));
      let lo = num(b.listenerTimingMinMs), hi = num(b.listenerTimingMaxMs);
      if (!isFinite(lo) || lo < -2000 || lo > 0) lo = -500;
      if (!isFinite(hi) || hi < 0 || hi > 3000) hi = 1000;
      if (lo >= hi) { lo = -500; hi = 1000; }
      return [lo, hi];
    })();
    const LT_MIN_MS = LT_RANGE[0];
    const LT_MAX_MS = LT_RANGE[1];
    const LT_STEP_MS = 50;
    const ltTipEnabled = !(window.__SHOWPILOT__ && window.__SHOWPILOT__.listenerTimingTip === false);
    const LT_PRESETS = [['Phone speaker', 0], ['Bluetooth headphones', 150], ['Car Bluetooth', 250]];
    let listenerOffsetSec = 0;
    const clampOffsetMs = (ms) => Math.max(LT_MIN_MS, Math.min(LT_MAX_MS, Math.round((Number(ms) || 0) / 10) * 10));
    if (listenerTimingEnabled) {
      try {
        const saved = localStorage.getItem(LT_KEY);
        if (saved !== null) listenerOffsetSec = clampOffsetMs(saved) / 1000;
      } catch (_) {}
    }
    let ltBtn = null, ltSheet = null, ltBackdrop = null;
    const ltAccent = () => {
      try { return (getComputedStyle(panel).getPropertyValue('--of-border') || '').trim() || '#60a5fa'; } catch (_) { return '#60a5fa'; }
    };
    function ltUpdateUi() {
      const ms = Math.round(listenerOffsetSec * 1000);
      if (ltBtn) {
        ltBtn.classList.toggle('sp-lt-active', ms !== 0);
        ltBtn.style.setProperty('--sp-lt-accent', ltAccent());
        ltBtn.setAttribute('aria-label', ms === 0 ? 'Audio timing' : 'Audio timing (adjusted ' + (ms > 0 ? '+' : '') + ms + ' ms)');
      }
      if (!ltSheet) return;
      ltSheet.style.setProperty('--sp-lt-accent', ltAccent());
      ltSheet.querySelector('.sp-lt-status').textContent = ms === 0 ? 'No adjustment' : ms > 0 ? 'Playing ' + ms + ' ms earlier' : 'Playing ' + (-ms) + ' ms later';
      ltSheet.querySelector('.sp-lt-ms').textContent = (ms > 0 ? '+' : '') + ms + ' ms';
      const range = ltSheet.querySelector('.sp-lt-range');
      if (document.activeElement !== range) range.value = String(ms);
      ltSheet.querySelectorAll('[data-lt-preset]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.ltPreset) === ms ? 'true' : 'false'));
      const reset = ltSheet.querySelector('.sp-lt-reset');
      reset.disabled = ms === 0;
    }
    function setListenerOffsetMs(ms) {
      ms = clampOffsetMs(ms);
      listenerOffsetSec = ms / 1000;
      try { if (ms) localStorage.setItem(LT_KEY, String(ms)); else localStorage.removeItem(LT_KEY); } catch (_) {}
      ltUpdateUi();
      console.log('[ShowPilot] listener audio timing: ' + ms + ' ms');
    }
    function ltEnsureStyles() {
      if (document.getElementById('sp-lt-styles')) return;
      const st = document.createElement('style');
      st.id = 'sp-lt-styles';
      st.textContent =
        '#sp-lt-btn{position:relative;background:transparent;border:0;color:rgba(255,255,255,.75);cursor:pointer;flex-shrink:0;padding:8px;line-height:0;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}' +
        '#sp-lt-btn:hover{background:rgba(255,255,255,.1);color:#fff}' +
        '#sp-lt-btn.sp-lt-active::after{content:"";position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--sp-lt-accent,#60a5fa);box-shadow:0 0 0 2px rgba(0,0,0,.6)}' +
        '#sp-lt-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55)}' +
        '#sp-lt-sheet{position:fixed;left:0;right:0;bottom:0;z-index:10001;box-sizing:border-box;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px;' +
          'padding:10px 18px calc(22px + env(safe-area-inset-bottom,0px));border-radius:22px 22px 0 0;background:#161c2b;color:#f3f5fa;border-top:2px solid var(--sp-lt-accent,#60a5fa);' +
          'box-shadow:0 -10px 40px rgba(0,0,0,.5);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}' +
        '#sp-lt-sheet .sp-lt-grab{align-self:center;width:40px;height:5px;border-radius:999px;background:rgba(255,255,255,.25)}' +
        '#sp-lt-sheet .sp-lt-head{display:flex;align-items:center;gap:10px}' +
        '#sp-lt-sheet h2{margin:0;font-size:20px;font-weight:700;flex:1}' +
        '#sp-lt-sheet p{margin:0;color:#b6bdcc}' +
        '#sp-lt-sheet button{font:inherit;color:#fff;cursor:pointer}' +
        '#sp-lt-sheet .sp-lt-done{min-height:40px;padding:0 14px;border:0;border-radius:10px;background:rgba(255,255,255,.1);font-weight:700}' +
        '#sp-lt-sheet .sp-lt-nudges{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}' +
        '#sp-lt-sheet .sp-lt-nudge{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:76px;border:1px solid rgba(255,255,255,.14);border-radius:16px;background:rgba(255,255,255,.07)}' +
        '#sp-lt-sheet .sp-lt-nudge b{font-size:16px}#sp-lt-sheet .sp-lt-nudge span{color:#9aa3b5;font-size:13px}' +
        '#sp-lt-sheet .sp-lt-readout{display:flex;align-items:baseline;gap:8px}#sp-lt-sheet .sp-lt-status{font-weight:600;flex:1}' +
        '#sp-lt-sheet .sp-lt-ms{font-family:ui-monospace,"SF Mono",Menlo,monospace;color:#9aa3b5;font-variant-numeric:tabular-nums}' +
        '#sp-lt-sheet .sp-lt-range{width:100%;accent-color:var(--sp-lt-accent,#60a5fa);min-height:32px;margin:0}' +
        '#sp-lt-sheet .sp-lt-scale{display:flex;justify-content:space-between;color:#7d8699;font-size:12px}' +
        '#sp-lt-sheet .sp-lt-tip{padding:10px 12px;border-radius:12px;border:1px solid var(--sp-lt-accent,#60a5fa);background:rgba(255,255,255,.06);font-size:14px;line-height:1.45;color:#dfe3ec}' +
        '#sp-lt-sheet .sp-lt-tip b{color:var(--sp-lt-accent,#60a5fa)}' +
        '#sp-lt-sheet .sp-lt-presets-label{font-weight:700;font-size:13px;color:#9aa3b5;margin-bottom:-8px}' +
        '#sp-lt-sheet .sp-lt-presets{display:flex;flex-wrap:wrap;gap:8px}' +
        '#sp-lt-sheet [data-lt-preset]{min-height:40px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:transparent;font-weight:600}' +
        '#sp-lt-sheet [data-lt-preset][aria-pressed="true"]{border-color:var(--sp-lt-accent,#60a5fa);background:rgba(255,255,255,.18)}' +
        '#sp-lt-sheet .sp-lt-foot{display:flex;align-items:center;gap:10px}#sp-lt-sheet .sp-lt-foot span{flex:1;color:#7d8699;font-size:13px}' +
        '#sp-lt-sheet .sp-lt-reset{min-height:40px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:transparent;font-weight:600}' +
        '#sp-lt-sheet .sp-lt-reset:disabled{color:#6b7385;cursor:default}' +
        '#sp-lt-sheet :focus-visible,#sp-lt-btn:focus-visible{outline:2px solid var(--sp-lt-accent,#60a5fa);outline-offset:2px}';
      document.head.appendChild(st);
    }
    function ltClose() {
      if (!ltSheet) return;
      ltSheet.remove(); ltBackdrop.remove(); ltSheet = null; ltBackdrop = null;
      document.removeEventListener('keydown', ltOnKey);
      if (ltBtn) ltBtn.focus();
    }
    function ltOnKey(e) { if (e.key === 'Escape') ltClose(); }
    function ltOpen() {
      if (ltSheet) return;
      ltEnsureStyles();
      ltBackdrop = document.createElement('div');
      ltBackdrop.id = 'sp-lt-backdrop';
      ltBackdrop.addEventListener('click', ltClose);
      ltSheet = document.createElement('div');
      ltSheet.id = 'sp-lt-sheet';
      ltSheet.setAttribute('role', 'dialog');
      ltSheet.setAttribute('aria-modal', 'true');
      ltSheet.setAttribute('aria-labelledby', 'sp-lt-title');
      ltSheet.innerHTML =
        '<span class="sp-lt-grab" aria-hidden="true"></span>' +
        '<div class="sp-lt-head"><h2 id="sp-lt-title">Audio timing</h2><button type="button" class="sp-lt-done">Done</button></div>' +
        '<p>Watch the lights. Is the music behind them or ahead of them? Tap until they line up.</p>' +
        '<div class="sp-lt-nudges">' +
          '<button type="button" class="sp-lt-nudge" data-lt-nudge="-' + LT_STEP_MS + '"><b>Music is early</b><span>play it later</span></button>' +
          '<button type="button" class="sp-lt-nudge" data-lt-nudge="' + LT_STEP_MS + '"><b>Music is late</b><span>play it earlier</span></button>' +
        '</div>' +
        '<div><div class="sp-lt-readout"><span class="sp-lt-status" aria-live="polite"></span><span class="sp-lt-ms"></span></div>' +
          '<input class="sp-lt-range" type="range" min="' + LT_MIN_MS + '" max="' + LT_MAX_MS + '" step="10" aria-label="Fine adjust audio timing">' +
          '<div class="sp-lt-scale"><span>music early</span><span>in sync</span><span>music late</span></div></div>' +
        // Second-device tip (v0.33.221+, admin switch listener_timing_tip).
        (ltTipEnabled ? '<div class="sp-lt-tip"><b>Tip:</b> play the show on another phone\u2019s speaker nearby, then adjust until the two sound together with no echo.</div>' : '') +
        '<div class="sp-lt-presets-label">Presets</div>' +
        '<div class="sp-lt-presets">' + LT_PRESETS.filter(p => p[1] >= LT_MIN_MS && p[1] <= LT_MAX_MS).map(p => '<button type="button" data-lt-preset="' + p[1] + '">' + p[0] + '</button>').join('') + '</div>' +
        '<div class="sp-lt-foot"><span>Saved on this phone only.</span><button type="button" class="sp-lt-reset">Reset</button></div>';
      ltSheet.querySelector('.sp-lt-done').addEventListener('click', ltClose);
      ltSheet.querySelectorAll('[data-lt-nudge]').forEach(b => b.addEventListener('click', () =>
        setListenerOffsetMs(Math.round(listenerOffsetSec * 1000) + Number(b.dataset.ltNudge))));
      ltSheet.querySelectorAll('[data-lt-preset]').forEach(b => b.addEventListener('click', () => setListenerOffsetMs(Number(b.dataset.ltPreset))));
      ltSheet.querySelector('.sp-lt-reset').addEventListener('click', () => setListenerOffsetMs(0));
      ltSheet.querySelector('.sp-lt-range').addEventListener('input', (e) => setListenerOffsetMs(e.target.value));
      document.body.appendChild(ltBackdrop);
      document.body.appendChild(ltSheet);
      document.addEventListener('keydown', ltOnKey);
      ltUpdateUi();
      ltSheet.querySelector('.sp-lt-done').focus();
    }
    if (listenerTimingEnabled) {
      ltEnsureStyles();
      ltBtn = document.createElement('button');
      ltBtn.type = 'button';
      ltBtn.id = 'sp-lt-btn';
      ltBtn.title = 'Audio timing';
      ltBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>';
      ltBtn.addEventListener('click', ltOpen);
      const pp = panel.querySelector('#of-listen-playpause');
      if (pp && pp.parentNode) pp.parentNode.insertBefore(ltBtn, pp);
      ltUpdateUi();
      // "Audio Sync Help" blocks (v0.33.221+) render hidden; they only make
      // sense when this timing button exists, so reveal them here, and copy
      // the live Listen on Phone button's icon (emoji, preset or custom image,
      // ringed or not) into their [listen] icon. Re-copied when the player
      // theme changes and once after load, since the icon can be set late.
      const mirrorListenIcon = () => {
        const lb = document.getElementById('of-listen-btn');
        if (!lb) return;
        let cs = null; try { cs = getComputedStyle(lb); } catch (_) {}
        const ringed = cs ? parseFloat(cs.borderTopWidth) > 0 : true;
        document.querySelectorAll('[data-sp-listen-icon]').forEach(s => {
          s.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:.9em' +
            (ringed ? '' : ';transform:scale(1.45)') + '">' + lb.innerHTML + '</span>';
          if (cs) {
            s.style.background = cs.backgroundColor;
            s.style.color = cs.color;
            s.style.border = ringed ? '1px solid ' + cs.borderTopColor : '0';
            s.style.filter = cs.filter === 'none' ? '' : cs.filter;
          }
        });
      };
      // Admin can hide the panel (sync_help_enabled -> boot.syncHelpEnabled);
      // the timing button is unaffected.
      const syncHelpEnabled = !(window.__SHOWPILOT__ && window.__SHOWPILOT__.syncHelpEnabled === false);
      document.querySelectorAll('[data-showpilot-sync-help]').forEach(el => { el.hidden = !syncHelpEnabled; });
      mirrorListenIcon();
      setTimeout(mirrorListenIcon, 1500);
      window.addEventListener('showpilot:player-theme', mirrorListenIcon);
      // The dot takes the player theme's accent; refresh it when the theme changes.
      window.addEventListener('showpilot:player-theme', () => ltUpdateUi());
    }
    const playBtn = panel.querySelector('#of-listen-playpause');
    const muteBtn = panel.querySelector('#of-listen-mute');
    const minBtn = panel.querySelector('#of-listen-min');
    minBtn.title = _pt('Hide (audio keeps playing)');
    const closeBtn = panel.querySelector('#of-listen-close');
    closeBtn.title = _pt('Stop & close');
    const pillText = minimizedPill.querySelector('#of-listen-pill-text');
    const langRow = panel.querySelector('#of-lang-row');
    const langBtns = panel.querySelector('#of-lang-btns');

    // ---- Language picker ----
    // Renders language toggle buttons when the current sequence has variants.
    // Hidden when only 'default' is available (single-language show).
    // Called after each now-playing-audio poll with the latest languages array.
    function updateLanguagePicker(languages) {
      availableLanguages = Array.isArray(languages) ? languages : [];
      // Guard: langRow/langBtns are only available after the panel is built
      if (!langRow || !langBtns) return;
      // Only show picker when there are at least 2 options (default + 1 variant)
      const hasVariants = availableLanguages.length >= 2;
      langRow.style.display = hasVariants ? 'flex' : 'none';
      if (!hasVariants) return;

      // Rebuild buttons only when the language list changed
      const rendered = langBtns.dataset.rendered || '';
      const key = availableLanguages.join(',');
      if (rendered === key) {
        // Just update active state
        langBtns.querySelectorAll('.of-lang-btn').forEach(b => {
          b.classList.toggle('of-lang-active', b.dataset.lang === selectedLang);
        });
        return;
      }
      langBtns.dataset.rendered = key;
      langBtns.innerHTML = '';

      // Label map for common codes — falls back to uppercase code
      const LABELS = {
        default: 'Default', en: 'EN', es: 'ES', fr: 'FR', de: 'DE',
        it: 'IT', pt: 'PT', zh: 'ZH', ja: 'JA', ko: 'KO',
        ru: 'RU', ar: 'AR', hi: 'HI', pl: 'PL', nl: 'NL',
      };

      availableLanguages.forEach(lang => {
        const btn = document.createElement('button');
        btn.className = 'of-lang-btn';
        btn.dataset.lang = lang;
        btn.textContent = LABELS[lang] || lang.toUpperCase();
        btn.title = lang === 'default' ? 'Default audio track' : lang.toUpperCase();
        if (lang === selectedLang) btn.classList.add('of-lang-active');
        btn.addEventListener('click', () => {
          if (lang === selectedLang) return;
          selectedLang = lang;
          try { localStorage.setItem('sp_audio_lang', lang); } catch(_) {}
          // Update active state immediately
          langBtns.querySelectorAll('.of-lang-btn').forEach(b => {
            b.classList.toggle('of-lang-active', b.dataset.lang === selectedLang);
          });
          // Force a track reload with the new language. The buffer cache is
          // keyed by stream URL, which includes ?lang=, so handleTrackChange
          // fetches the new language rather than replaying the cached one.
          currentSequence = null; // triggers handleTrackChange on next poll
        });
        langBtns.appendChild(btn);
      });
    }

    // ============================================================
    // SHOW-NOT-PLAYING STATE
    //
    // When the server reports that FPP isn't actively playing a sequence
    // (e.g. show is between songs, FPP stopped, plugin stale), we swap
    // the player into a stripped-down "Show isn't playing right now"
    // message instead of hiding the launcher. Per Will's spec: viewers
    // should NOT have to refresh to get the player back when the show
    // resumes — so the launcher stays available, and this state toggles
    // freely as FPP starts/stops.
    //
    // Stripped state hides: cover art, title/artist/status block, play,
    // mute, and minimize buttons. Shows: a centered message and the
    // close (×) button. Restoring un-hides everything.
    // ============================================================

    // Locate the inner column that holds title/artist/status — it's the
    // sibling of coverEl with no ID. Cache it so we don't re-query.
    const textCol = coverEl.nextElementSibling;

    // Inject the "not playing" message element. Hidden by default; lives
    // in the same flex row as the cover so it can take its place when
    // we hide the cover/text/buttons.
    const notPlayingMsg = document.createElement('div');
    notPlayingMsg.id = 'of-listen-not-playing';
    notPlayingMsg.style.cssText = `
      flex: 1; min-width: 0;
      text-align: center;
      font-size: 15px; font-weight: 500;
      color: rgba(255,255,255,0.92);
      padding: 4px 8px;
      display: none;
    `;
    notPlayingMsg.textContent = _pt("Show isn't playing right now");
    // Insert before the close button so the close stays at the right edge.
    closeBtn.parentElement.insertBefore(notPlayingMsg, closeBtn);

    let _showNotPlaying = false;

    function applyShowNotPlaying(notPlaying) {
      // No-op if state hasn't changed — avoids redundant DOM thrash on
      // every 5s poll.
      if (notPlaying === _showNotPlaying) return;
      _showNotPlaying = notPlaying;

      if (notPlaying) {
        // Hide the hidden minimized pill if it was visible — a "Playing"
        // indicator while nothing is playing would be confusing.
        minimizedPill.style.display = 'none';

        // Stop any in-flight audio so we're not pumping silence (or worse,
        // stale buffer tails) through the speakers while showing "not
        // playing." Don't tear down audioCtx — recreating it later requires
        // a user gesture on iOS, which would break the resume-on-restart
        // flow.
        try { stopAudio(); } catch {}

        // Hide the player content. notPlayingMsg has flex:1 so it takes
        // the textCol's place. Close (×) stays visible.
        coverEl.style.display = 'none';
        if (textCol) textCol.style.display = 'none';
        playBtn.style.display = 'none';
        muteBtn.style.display = 'none';
        minBtn.style.display = 'none';
        // v0.33.215: the timing button (v0.33.213) hides with the others, and
        // the two-row layout drops its empty first row.
        if (ltBtn) ltBtn.style.display = 'none';
        panel.classList.add('sp-not-playing');
        notPlayingMsg.style.display = 'block';
      } else {
        notPlayingMsg.style.display = 'none';
        coverEl.style.display = '';
        if (textCol) textCol.style.display = '';
        playBtn.style.display = '';
        muteBtn.style.display = '';
        minBtn.style.display = '';
        if (ltBtn) ltBtn.style.display = '';
        panel.classList.remove('sp-not-playing');
        // If the user has the panel open when the show resumes, get audio
        // going. If audioCtx already exists (panel was opened during a
        // prior playing window), a syncOnce() picks up the new track.
        // If not (panel was opened in the not-playing state), we need a
        // full startup() — but Web Audio init requires a user gesture on
        // iOS, so this will only succeed if the user interacted recently.
        // Acceptable: if startup fails silently, the panel still shows the
        // (now-empty) controls and they can tap play to retry.
        if (panelMode === 'open') {
          if (audioCtx) {
            try { syncOnce(); } catch {}
          } else {
            try { startup(); } catch {}
          }
        }
      }
    }
    window._ofApplyShowNotPlaying = applyShowNotPlaying;

    // Apply marquee scroll if text overflows the wrapper. Called after any
    // title/artist text update. Adds 24px padding on the "scrolled-to" position
    // so the user can see the full text comfortably. Speed scales with overflow:
    // ~30 pixels per second feels readable.
    function setupMarquee(textEl, wrapEl) {
      // Clear existing animation first
      textEl.classList.remove('of-marquee-on');
      textEl.style.removeProperty('--of-marquee-offset');
      textEl.style.removeProperty('--of-marquee-duration');
      // Defer measurement so layout has a chance to settle
      requestAnimationFrame(() => {
        const overflow = textEl.scrollWidth - wrapEl.clientWidth;
        if (overflow > 4) {
          // Overflow is the distance we need to scroll. Negative because we're
          // scrolling LEFT to reveal text on the right.
          const offset = -(overflow + 12); // +12px so end of text is fully visible
          const speed = 30; // px per second
          // Total animation time: scroll out (50%) + scroll back (50%)
          const duration = Math.max(6, (Math.abs(offset) * 2) / speed);
          textEl.style.setProperty('--of-marquee-offset', offset + 'px');
          textEl.style.setProperty('--of-marquee-duration', duration + 's');
          textEl.classList.add('of-marquee-on');
        }
      });
    }

    // Re-evaluate marquee on viewport resize (rotation, browser resize)
    let _marqueeResizeTimer = null;
    window.addEventListener('resize', () => {
      if (_marqueeResizeTimer) clearTimeout(_marqueeResizeTimer);
      _marqueeResizeTimer = setTimeout(() => {
        if (titleEl.textContent) setupMarquee(titleEl, titleWrap);
        if (artistEl.textContent) setupMarquee(artistEl, artistWrap);
      }, 250);
    });

    // ---- SVG icons (swapped by setPlayIcon, setMuteIcon) ----
    const SVG_PLAY  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const SVG_PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
    const SVG_VOLUME = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4a1 1 0 0 0 1 1h3l4 4a1 1 0 0 0 1.7-.7V5.7A1 1 0 0 0 11 5L7 9H4a1 1 0 0 0-1 1zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
    const SVG_MUTED  = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4a1 1 0 0 0 1 1h3l4 4a1 1 0 0 0 1.7-.7V5.7A1 1 0 0 0 11 5L7 9H4a1 1 0 0 0-1 1zm17.7 5.3l-1.4-1.4L21 12.2l-1.7-1.7 1.4-1.4 1.7 1.7 1.7-1.7 1.4 1.4-1.7 1.7 1.7 1.7-1.4 1.4-1.7-1.7-1.7 1.7z" transform="translate(-3.5 0)"/></svg>';
    function setPlayIcon(playing) { playBtn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY; }
    function setMuteIcon(muted)   { muteBtn.innerHTML = muted ? SVG_MUTED : SVG_VOLUME; }

    // ---- State ----
    let panelMode = 'closed';     // 'closed' | 'open' | 'minimized'
    let audioCtx = null;
    // iOS Safari's Web Audio API defaults to the "ambient" audio session
    // category, which respects the hardware mute switch — silencing our
    // audio even when the show is playing and the AudioContext itself is
    // "running". HTML <audio>/<video> elements default to a category that
    // ignores the switch, which is why old silent-mp3 "kick" hacks (see
    // PR #17) worked at all — they weren't fixing gesture timing, they
    // were nudging Safari into a different session category. The real,
    // standards-based fix is the AudioSession API (Safari-shipped,
    // WebKit-authored): telling it this page's audio is genuine media
    // playback makes it ignore the mute switch, no silent asset needed.
    // Feature-detected since only Safari has it; harmless no-op elsewhere.
    if ('audioSession' in navigator) {
      try { navigator.audioSession.type = 'playback'; } catch {}
    }
    // Holds an AudioContext created synchronously inside a user-gesture
    // handler (btn.onclick), before startup() actually runs. iOS Safari
    // only leaves an AudioContext unsuspended if it's constructed within
    // the gesture's call stack — the moment of construction is what
    // matters, not when we hand it to startup(). Kept separate from
    // `audioCtx` itself so the `!audioCtx` check in setMode()/
    // applyShowNotPlaying (which means "has startup() run yet") still
    // works — assigning straight to `audioCtx` here made those checks
    // think startup already happened and skip it, breaking first-open
    // audio entirely. Consumed and cleared by startup().
    let _pendingGestureAudioCtx = null;
    let gainNode = null;
    let isMuted = false;
    let currentBuffer = null;     // AudioBuffer of currently-playing track
    let currentSource = null;     // AudioBufferSourceNode of currently playing
    let currentSequence = null;
    let currentMediaName = null;
    // v0.33.226: decoded audio, keyed by stream URL (path + ?v= + ?lang=) so
    // a new file version or a different language is never mistaken for the
    // cached one. Holds only the current and next songs: a decoded song is
    // ~75 MB, and more than two got phones' tabs killed.
    const decodedBufferCache = new Map(); // stream URL → AudioBuffer
    const prefetchInFlight = new Map();   // stream URL → Promise<AudioBuffer|null>
    const prefetchRetryAt = new Map();    // stream URL → ms timestamp; backoff after a failed prefetch
    let currentStreamKey = null;  // stream URL of the song playing now
    let nextStreamKey = null;     // stream URL of the song the server says is next
    let clockOffset = 0;          // serverNow - clientNow at last sync
    let trackStartedAtMs = 0;     // when this track started on server (server epoch)
    let trackDuration = 0;        // total length in seconds
    let audioSyncOffsetMs = 0;    // per-show offset to compensate for FPP audio output latency vs cache delivery speed. Server sends this; positive = audio plays LATER (compensates for too-early arrival)
    // Incremented on every stopAudio/teardown/track-change so in-flight async
    // operations (scheduled play, clock fetch) can detect they're stale and bail.
    let playGeneration = 0;
    // v0.33.203: track-change recovery. Each handleTrackChange() call gets a
    // token so a stalled load that finishes late can't start playing over a
    // newer one; failures and silent stalls are retried instead of leaving
    // the track marked "current" with nothing playing until a page refresh.
    let trackChangeToken = 0;
    let trackChangeAt = 0;        // when the current track's load started (0 = none pending)
    let trackRetryNotBefore = 0;  // backoff after a failed load
    let resumeOnTapArmed = false;

    // Some devices (Android audio-route/focus changes, e.g. Bluetooth car
    // audio) pause the AudioContext on their own. Resuming may need a user
    // gesture, so on failure the next tap anywhere on the page resumes it.
    function armResumeOnTap() {
      if (resumeOnTapArmed) return;
      resumeOnTapArmed = true;
      const onTap = () => {
        resumeOnTapArmed = false;
        document.removeEventListener('pointerdown', onTap, true);
        if (audioCtx && audioCtx.state !== 'running') {
          audioCtx.resume().then(() => {
            console.log('[ShowPilot] audio context resumed by tap');
            trackRetryNotBefore = 0;
          }).catch(() => {});
        }
      };
      document.addEventListener('pointerdown', onTap, true);
    }

    // fetch() + arrayBuffer() with a hard timeout, so a stalled request
    // fails (and gets retried) instead of hanging the track forever.
    async function fetchAudioWithTimeout(url, ms) {
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
      try {
        const resp = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.arrayBuffer();
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('audio download timed out');
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Drop decoded songs that are neither playing nor next.
    function pruneBufferCache() {
      for (const key of decodedBufferCache.keys()) {
        if (key !== currentStreamKey && key !== nextStreamKey) decodedBufferCache.delete(key);
      }
    }

    // Download + decode a song in the background (v0.33.226). Before this,
    // the next song was only fetched when it started, so listeners heard
    // silence for the download + decode and then missed its opening. One
    // request per URL: a song change while this is still running awaits it
    // (see handleTrackChange) instead of downloading the file again.
    // Resolves to the AudioBuffer, or null on failure.
    function prefetchAudio(key) {
      if (!key || !audioCtx) return Promise.resolve(null);
      if (decodedBufferCache.has(key)) return Promise.resolve(decodedBufferCache.get(key));
      if (prefetchInFlight.has(key)) return prefetchInFlight.get(key);
      if (Date.now() < (prefetchRetryAt.get(key) || 0)) return Promise.resolve(null);
      const ctx = audioCtx;
      const p = fetchAudioWithTimeout(window.location.origin + key, 60000)
        .then(buf => new Promise((resolve, reject) => ctx.decodeAudioData(buf, resolve, reject)))
        .then(decoded => {
          if (audioCtx !== ctx) return null; // player closed meanwhile
          prefetchRetryAt.delete(key);
          decodedBufferCache.set(key, decoded);
          pruneBufferCache();
          console.info('[ShowPilot] prefetch complete:', key);
          return decoded;
        })
        .catch(e => {
          prefetchRetryAt.set(key, Date.now() + 30000);
          console.warn('[ShowPilot] prefetch failed:', key, e && e.message);
          return null;
        })
        .finally(() => { if (prefetchInFlight.get(key) === p) prefetchInFlight.delete(key); });
      prefetchInFlight.set(key, p);
      return p;
    }

    // Multi-language audio: the viewer's chosen language code, persisted to
    // localStorage as 'sp_audio_lang'. 'default' means play the primary track.
    // When the current sequence has variants, a language picker appears in the
    // player bar. Changing language triggers a full track reload.
    let selectedLang = (() => {
      try { return localStorage.getItem('sp_audio_lang') || 'default'; } catch(_) { return 'default'; }
    })();
    let availableLanguages = []; // populated from now-playing-audio response

    // The HTML5 <audio> element used for playback. We use HTML5 audio
    // (rather than Web Audio API) because it provides much better
    // multi-phone sync — see comments in handleTrackChange. Reset to
    // null after stopAudio.
    let htmlAudio = null;
    let useRelay = false;  // true when audio is coming from the live relay stream
    let fppStatus = null;  // latest FPP position from daemon WebSocket
    let smoothedDriftMs = 0; // exponentially smoothed drift for stable correction
    let calibrationSamples = []; // collect drift samples for auto-calibration
    let deviceOffset = 0; // per-device learned offset stored in localStorage

    // v0.33.202: auto-calibration removed (it fed its own correction back
    // into the next measurement and ran away song after song). Clear any
    // value an older version stored; deviceOffset stays 0.
    try { localStorage.removeItem('sp_device_offset'); } catch (_) {}
    if (false) try {
      const saved = localStorage.getItem('sp_device_offset');
      if (saved) {
        const val = parseFloat(saved) || 0;
        // Discard extreme values from old HTML5 engine calibration — Web Audio
        // has different characteristics. Values beyond ±500ms are invalid.
        if (Math.abs(val) < 200) {
          deviceOffset = val;
          console.log('[ShowPilot] device offset loaded:', deviceOffset, 'ms');
        } else {
          localStorage.removeItem('sp_device_offset');
          console.log('[ShowPilot] discarded stale device offset:', val, 'ms');
        }
      }
    } catch (_) {}

    // Hardware output latency — measured inside startup() where await is valid
    let hardwareLatencyMs = 0;

    // Apply hardware latency to deviceOffset if no calibration exists yet
    // (called after measurement inside startup())
    let audioSock = null;  // Socket.io connection for position updates
    // Expose for debugging
    window._spDebug = () => ({
      audioSock: audioSock ? { connected: audioSock.connected, transport: audioSock.io?.engine?.transport?.name } : null,
      fppStatus: fppStatus ? { positionSec: fppStatus.positionSec, filename: fppStatus.filename } : null,
      clockOffset,
      hardwareLatencyMs,
    });

    // Post-startup correction state (v0.27.0).
    // The browser's `.play()` call has non-deterministic startup latency
    // — even on the same hardware between sessions, between 0 and 200ms
    // can elapse between calling .play() and the speakers actually
    // producing sound. Predicting this latency is hopeless. Measuring it
    // after the fact is straightforward.
    //
    // pendingPostStartCorrectionAtMs is the wall-clock time at which we
    // should perform a one-shot measurement of htmlAudio.currentTime
    // against the expected position from FPP and seek-correct any error.
    // Set when we call .play() for a new track; cleared once the
    // correction fires or the track ends.
    //
    // 1.0s after play start gives the audio element time to settle into
    // steady-state playback (initial buffer/decoder warmup is over) so
    // the measurement reflects real per-device startup error rather than
    // transient warmup wobble.
    let pendingPostStartCorrectionAtMs = 0;

    // Live position from FPP. When the plugin is running >= 0.11.0, it
    // pushes "FPP is at position X.Y as of timestamp T" updates every
    // ~500ms via socket.io. We use this as the authoritative anchor for
    // playback sync — it reflects FPP's actual hardware audio output
    // position, including buffer delay, so phones aligning to it
    // naturally match what the speakers are emitting.
    //
    // This replaces extrapolating from trackStartedAtMs, which has
    // whatever bias was baked in at track-change time and stays put
    // for the whole track regardless of how FPP's actual playback
    // progresses. Live position is fresh by definition.
    //
    // Shape: { sequence, position, updatedAt } or null if no update yet.
    // The viewer subscribes to 'positionUpdate' socket events to keep
    // this fresh; initial value comes from now-playing-audio response.
    let livePosition = null;
    let lastSyncResponse = null;  // raw response for debugging
    let pollTimer = null;
    let driftTimer = null;
    let locationVerifyTimer = null;
    // navigator.geolocation.watchPosition() handle — used for continuous
    // proximity checking while audio plays. Only set when audio gate is
    // enabled. Cleared in teardown() to release the GPS subscription.
    let watchPositionId = null;
    // Timestamp (ms) of the most recent watcher callback that confirmed
    // the user is IN range. Used to skip the periodic server re-check
    // when the watcher has done its job recently — see the periodic
    // check in startup() for the rationale.
    let lastWatcherInRangeMs = 0;
    // Timestamp (ms) when audio playback started. We use this to grace-
    // period the FIRST ~30 seconds of watchPosition updates, because the
    // browser often fires the first update with a stale cached position
    // from BEFORE the user reached the show. The click-time fresh-location
    // check already proved they're in range, so we trust that for the
    // first window and only start enforcing on watcher updates after.
    let audioStartedAtMs = 0;
    // ---- Drift measurement anchors (v0.18.17+) ----
    // When we schedule a buffer to play, we capture two things:
    //   trackScheduledAtAudioCtx — the audioCtx.currentTime value at the
    //     moment of src.start(). This is the audio-clock anchor that
    //     advances at exactly the rate of the audio output hardware.
    //   trackScheduledAtPositionSec — where in the track that anchor
    //     corresponds to (i.e. startOffset). Subsequent audio-clock time
    //     past the anchor maps directly to track position.
    // Together these let updateDriftDisplay() compute "where is audio
    // ACTUALLY playing right now?" and compare to "where SHOULD it be
    // per server time?" — the difference is the real drift.
    //
    // We also capture outputLatency at schedule time because some
    // browsers update it as audio devices change. Using a snapshot from
    // schedule-time means our drift number is consistent with what we
    // told the audio system to do.
    let trackScheduledAtAudioCtx = 0;
    let trackScheduledAtPositionSec = 0;
    let trackScheduledOutputLatency = 0;
    let pendingStartTimeout = null;

    // ---- Auto-sync state ----
    // We continuously adjust playbackRate based on smoothed drift. The
    // server's audio_sync_offset_ms acts as a constant target (a "bias")
    // and continuous resync corrects against it. Earlier versions tried
    // a "converge once then lock at 1.0" approach but it failed when
    // drift fluctuated mid-track (variable FPP audio output latency,
    // network jitter affecting clock sync, etc.) — once we locked at
    // 1.0, we wouldn't catch drift that developed later. This version
    // never stops adjusting.
    //
    // Key smoothing: we keep a rolling window of recent drift samples
    // and act on the AVERAGE, not the instantaneous reading. Without
    // this, normal jitter (±50–100ms tick to tick) would cause the rate
    // to constantly oscillate, producing audible warbling. Averaging
    // 5 samples (~1.25s at 250ms tick) absorbs most jitter while still
    // reacting to real trends.
    let lastAppliedRate = 1.0;
    const driftHistory = [];          // ring of recent drift values in seconds
    const DRIFT_HISTORY_SIZE = 5;     // ~1.25 seconds of samples

    // Integrated playback position. We need to track this separately from
    // (audioCtx.currentTime - trackScheduledAtAudioCtx) because the audio
    // context's clock advances at real time regardless of playbackRate.
    // When we set rate=0.98, real time advances at 1.0 but the audio file
    // position advances at 0.98. Without integrating rate over time, the
    // drift calculation diverges from reality whenever rate isn't 1.0,
    // which is exactly when we need it to be accurate.
    //
    // Each drift tick we add (real_dt * current_rate) to this counter.
    // It represents "how many seconds INTO THE FILE we have actually
    // played back since the track was scheduled."
    let integratedPlayedSec = 0;
    let lastIntegrationTime = 0;      // audioCtx.currentTime at last integration tick

    // Crossfade correction state. We use jump-cut + crossfade rather than
    // continuous rate adjustment because rate adjustment introduces
    // accumulated math errors over time and produces audible pitch shifts.
    // PulseMesh and other multi-room audio systems use this pattern.
    //
    // The plan: when drift exceeds threshold, fade out the current source
    // over a short window while a new source starts at the corrected
    // position with a fade-in. The crossfade is brief enough (~40ms) that
    // listeners don't perceive it as a discontinuity, but the position
    // snaps to truth instantly. No oscillation, no math errors.
    //
    // We hold the per-source GainNode so we can ramp ITS volume during
    // the crossfade — the main `gainNode` at the destination handles
    // user mute/volume and stays untouched by sync operations.
    let currentSourceGain = null;
    // Throttle: don't crossfade more than once per N seconds. Without
    // this, jitter near the threshold would trigger correction on every
    // tick, which would just produce an ugly chain of crossfades.
    let lastCrossfadeAtCtx = 0;
    let snapPendingUntilMs = 0; // crossfade blocked until snap fires or times out
    let snapAnchorCtxTime = 0;  // audioCtx.currentTime when snap fired
    let snapAnchorPosSec = 0;   // audio position at snap — used for clock-free drift

    // ---- FPP position estimator (v0.33.202+) ----
    // Recent position readings from the daemon (fppPosition + fppSyncPoint),
    // for the song currently playing. Each reading's timestamp is applied by
    // the daemon when it SENDS, which is 0-100ms after FPP reported the
    // position (the daemon polls its FIFO every 100ms), and the first
    // syncPoint after a song change can re-send a position up to ~500ms old.
    // Both errors only ever make a reading look OLDER than it is, so the
    // best estimate of "where FPP is now" is the MOST ADVANCED reading
    // (upper envelope) over a short window, not the latest one.
    let fppSamples = [];              // { p, ts, file }
    let currentTrackMediaName = null; // raw FPP media filename for the current track
    const FPP_SAMPLE_WINDOW_MS = 5000;

    function recordFppSample(msg) {
      if (!msg || !msg.playing || !msg.filename || !msg.serverTimestamp) return;
      if (typeof msg.positionSec !== 'number' || msg.positionSec < 0) return;
      // New song (or a different file than we hold): start fresh.
      if (fppSamples.length && fppSamples[fppSamples.length - 1].file !== msg.filename) {
        fppSamples = [];
      }
      fppSamples.push({ p: msg.positionSec, ts: msg.serverTimestamp, file: msg.filename });
      if (fppSamples.length > 20) fppSamples.shift();
    }

    // Returns { pos, n, newestAgeMs } — FPP's estimated position right now
    // (server-clock based), from readings of the current track only — or
    // null when there aren't usable readings.
    // ---- Sync probe (debug, v0.33.218) ----
    // With the Debug setting on, the player ALSO connects straight to the FPP
    // audio daemon (like v0.11.0 did) and measures how far the relayed
    // position (estimateFppPosNow) is from the daemon's own, using an
    // NTP-style clock offset measured directly against the daemon (lowest
    // round-trip sample). Also compares FPP's status-API position with the
    // event-driven one. Display/logging only — nothing here steers playback.
    const probeUrl = (window.__SHOWPILOT__ && window.__SHOWPILOT__.syncProbeUrl) || null;
    const probe = { state: probeUrl ? 'starting' : 'off', offsetMs: null, rttMs: null, samples: [], pos: null, api: null, relay: [], apiVsDirect: [], apiField: null };
    window.__spProbe = probe;
    function probeStats(arr) {
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => a - b);
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length);
      return { mean: Math.round(mean), median: Math.round(sorted[Math.floor(sorted.length / 2)]), min: Math.round(sorted[0]), max: Math.round(sorted[sorted.length - 1]), sd: Math.round(sd), n: arr.length };
    }
    const fmtStat = (st) => st ? ((st.mean >= 0 ? '+' : '') + st.mean + 'ms (median ' + st.median + ', ' + st.min + '..' + st.max + ', sd ' + st.sd + ', n=' + st.n + ')') : 'waiting…';
    function probeLines() {
      if (probe.state === 'off') return [];
      return [
        `probe:       ${probe.state}`,
        `probe rtt:   ${probe.rttMs === null ? '…' : probe.rttMs + 'ms'}  offset ${probe.offsetMs === null ? '…' : Math.round(probe.offsetMs) + 'ms'}`,
        `relay−dir:   ${fmtStat(probeStats(probe.relay))}`,
        `api−dir:     ${fmtStat(probeStats(probe.apiVsDirect))}${probe.apiField ? ' [' + probe.apiField + ']' : ''}`,
      ];
    }
    if (probeUrl) {
      if (location.protocol === 'https:') {
        probe.state = 'blocked on https — open this page via the server\'s local http:// address';
        console.warn('[ShowPilot] sync probe: ' + probe.state);
      } else {
        const connectProbe = () => {
          let ws;
          try { ws = new WebSocket(probeUrl); } catch (e) { probe.state = 'cannot connect: ' + e.message; return; }
          let pingTimer = null, pings = 0;
          const ping = () => { if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'timeReq', t0: Date.now() })); pings++; } };
          ws.onopen = () => {
            probe.state = 'connected to ' + probeUrl;
            ws.send(JSON.stringify({ type: 'probeHello' }));
            ping();
            pingTimer = setInterval(() => ping(), 1000); // 1/s: plenty for a debug tool
          };
          ws.onmessage = (ev) => {
            const t1 = Date.now();
            let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
            if (m.type === 'timeResp' && typeof m.t0 === 'number') {
              const rtt = t1 - m.t0;
              if (rtt < 0 || rtt > 3000) return;
              probe.samples.push({ rtt, offset: m.daemonNow - (m.t0 + t1) / 2 });
              if (probe.samples.length > 30) probe.samples.shift();
              const best = probe.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
              probe.offsetMs = best.offset; probe.rttMs = best.rtt;
            } else if ((m.type === 'position' || m.type === 'syncPoint') && typeof m.positionSec === 'number') {
              probe.pos = m;
            } else if (m.type === 'apiPosition') {
              probe.api = m;
            }
          };
          ws.onclose = () => { clearInterval(pingTimer); probe.state = 'disconnected — retrying'; setTimeout(connectProbe, 3000); };
          ws.onerror = () => { probe.state = 'connection error (is the daemon reachable from this device?)'; };
        };
        connectProbe();
        // Compare once a second.
        setInterval(() => {
          if (probe.offsetMs === null || !probe.pos || !probe.pos.playing) return;
          const daemonNow = Date.now() + probe.offsetMs;
          const directPos = probe.pos.positionSec + (daemonNow - probe.pos.serverTimestamp) / 1000;
          if (daemonNow - probe.pos.serverTimestamp > 3000) return; // stale
          const est = estimateFppPosNow();
          const relayFile = fppSamples.length ? fppSamples[fppSamples.length - 1].file : null;
          if (est && relayFile === probe.pos.filename) {
            probe.relay.push((est.pos - directPos) * 1000);
            if (probe.relay.length > 120) probe.relay.shift();
          }
          const a = probe.api;
          if (a && a.playing && daemonNow - a.daemonAt < 1500) {
            const apiSec = a.millisecondsElapsed !== null && a.millisecondsElapsed > 0 ? a.millisecondsElapsed / 1000
              : a.secondsPlayed !== null ? a.secondsPlayed : a.secondsElapsed;
            probe.apiField = a.millisecondsElapsed > 0 ? 'milliseconds_elapsed' : a.secondsPlayed !== null ? 'seconds_played' : 'seconds_elapsed';
            if (apiSec !== null) {
              const apiNow = apiSec + (daemonNow - a.daemonAt) / 1000;
              probe.apiVsDirect.push((apiNow - directPos) * 1000);
              if (probe.apiVsDirect.length > 120) probe.apiVsDirect.shift();
            }
          }
        }, 1000);
        setInterval(() => {
          if (probe.relay.length || probe.apiVsDirect.length) {
            console.log('[ShowPilot] sync probe — relay minus direct: ' + fmtStat(probeStats(probe.relay)) +
              ' | FPP status (' + (probe.apiField || '?') + ') minus event position: ' + fmtStat(probeStats(probe.apiVsDirect)) +
              ' | phone↔Pi rtt ' + probe.rttMs + 'ms');
          }
        }, 5000);
      }
    }

    function estimateFppPosNow() {
      if (!fppSamples.length) return null;
      const serverNow = Date.now() + clockOffset;
      let best = -Infinity;
      let n = 0;
      let newestTs = 0;
      for (const s of fppSamples) {
        if (currentTrackMediaName && s.file !== currentTrackMediaName) continue;
        const age = serverNow - s.ts;
        if (age > FPP_SAMPLE_WINDOW_MS || age < -1000) continue;
        const implied = s.p + Math.max(0, age) / 1000;
        if (implied > best) best = implied;
        if (s.ts > newestTs) newestTs = s.ts;
        n++;
      }
      if (!n) return null;
      // FPP restarted or seeked the same file backwards: newer readings sit
      // far below older ones. Drop the stale ones and use the newest only.
      const newest = fppSamples[fppSamples.length - 1];
      const newestImplied = newest.p + Math.max(0, serverNow - newest.ts) / 1000;
      if (best - newestImplied > 1.5) {
        fppSamples = [newest];
        return { pos: newestImplied, n: 1, newestAgeMs: serverNow - newest.ts };
      }
      return { pos: best, n, newestAgeMs: serverNow - newestTs };
    }

    // OS-reported delay between scheduling a sample and hearing it. Clamped:
    // some devices have reported absurd values through latency APIs, and a
    // bad reading here would shift every phone by that amount.
    // ---- Real-time song changes (v0.33.205+) ----
    // FPP's own messages (fppPosition) reach the phone within milliseconds
    // of a song change or Stop/Next. Instead of waiting for the next 1s
    // poll, react to them: stop immediately on Stop, and on a new file ask
    // the server right away, re-asking every 200ms (up to 3s) until it
    // reports FPP's current file. The server's now-playing-audio uses the
    // same live data (audio-position-relay getLiveFpp), so it usually
    // agrees on the first ask.
    let lastLiveFpp = null;        // latest fppPosition message, stops included
    let fastSyncUntil = 0;
    let fastSyncTimer = null;
    let fastSyncInFlight = false;

    function fastSyncDone() {
      const live = lastLiveFpp;
      if (!live) return true;
      if (live.playing === false) return !currentSource;
      return !!currentTrackMediaName && live.filename === currentTrackMediaName;
    }

    function startFastSync() {
      fastSyncUntil = Date.now() + 3000;
      if (fastSyncTimer || fastSyncInFlight) return;
      const tick = async () => {
        fastSyncTimer = null;
        if (!pollTimer || Date.now() > fastSyncUntil) return;
        fastSyncInFlight = true;
        try { await syncOnce(); } catch (_) {} finally { fastSyncInFlight = false; }
        if (!pollTimer || fastSyncDone() || Date.now() > fastSyncUntil) return;
        fastSyncTimer = setTimeout(tick, 200);
      };
      tick();
    }

    function onFppLiveEvent(msg) {
      if (!msg || typeof msg.playing !== 'boolean') return;
      const prev = lastLiveFpp;
      lastLiveFpp = msg;
      if (!pollTimer) return; // player not open
      // Only a CHANGE (stop/start or a different file) triggers fast syncing.
      // Repeats — e.g. the daemon's fallback re-sending "stopped" 4x/second
      // while FPP is idle, or a file ShowPilot doesn't know — must not keep
      // re-arming it, or every phone would poll the server continuously.
      const changed = !prev || prev.playing !== msg.playing || prev.filename !== msg.filename;
      if (msg.playing === false) {
        if (currentSource) {
          console.log('[ShowPilot] FPP stopped — stopping audio');
          stopAudio();
          // Any restart, even of the same song, must count as a new track.
          currentSequence = null;
        }
        if (changed) startFastSync();
        return;
      }
      if (changed && msg.filename && msg.filename !== currentTrackMediaName) {
        console.log('[ShowPilot] FPP switched to', msg.filename, '— syncing now');
        startFastSync();
      }
    }

    function getOutputLatencySec() {
      const l = (audioCtx && (audioCtx.outputLatency || audioCtx.baseLatency)) || 0;
      // + the listener's own timing offset (v0.33.213+), which covers the
      // Bluetooth / car delay the browser can't see.
      return ((l > 0 && l < 0.4) ? l : 0) + listenerOffsetSec;
    }

    // ---- Smooth correction (v0.33.204+) ----
    // Small drift is corrected by nudging the playback speed (at most
    // ±0.5%, ~9 cents of pitch — inaudible) until back in sync; only large
    // errors jump, and jumps are equal-power crossfades, never a hard cut.
    //
    // Position tracking with a variable rate: the rendered position is
    //   trackScheduledAtPositionSec + (ctx.now − trackScheduledAtAudioCtx) × currentRate
    // Every rate change re-anchors first (setSourceRate), and every new
    // source resets currentRate to 1 (new AudioBufferSourceNodes start at 1).
    let currentRate = 1.0;
    const RATE_MAX_DEV = 0.005;      // max ±0.5% speed change
    const RATE_GAIN = 0.1;           // speed offset per second of drift (50ms → 0.5%)
    const RATE_DEADBAND_MS = 8;      // closer than this: play at normal speed
    const JUMP_THRESHOLD_MS = 150;   // farther than this: crossfade jump instead

    function renderedPosAt(ctxTime) {
      return trackScheduledAtPositionSec
        + Math.max(0, ctxTime - trackScheduledAtAudioCtx) * currentRate;
    }

    function setSourceRate(rate) {
      if (!audioCtx || !currentSource) return;
      const now = audioCtx.currentTime;
      if (now > trackScheduledAtAudioCtx) {
        trackScheduledAtPositionSec = renderedPosAt(now);
        trackScheduledAtAudioCtx = now;
      }
      currentRate = rate;
      try {
        currentSource.playbackRate.setValueAtTime(rate, now);
      } catch (_) {
        try { currentSource.playbackRate.value = rate; } catch (_) {}
      }
    }

    let _epCurves = null;
    function equalPowerCurves() {
      if (_epCurves) return _epCurves;
      const n = 64, up = new Float32Array(n), down = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        up[i] = Math.sin(x * Math.PI / 2);
        down[i] = Math.cos(x * Math.PI / 2);
      }
      _epCurves = { up, down };
      return _epCurves;
    }

    // Jump the current track to targetPos (the position that should be
    // rendering at ctx "now") with an equal-power crossfade. Returns false
    // if there is nothing to crossfade.
    function crossfadeTo(targetPos) {
      if (!audioCtx || !currentBuffer || !currentSource || !currentSourceGain) return false;
      if (targetPos < 0 || targetPos >= currentBuffer.duration - 0.1) return false;
      const FADE = 0.08;
      const now = audioCtx.currentTime;
      const t0 = now + 0.01;            // lead so the whole fade is scheduled ahead
      const startPos = targetPos + 0.01;
      const { up, down } = equalPowerCurves();
      const oldNode = currentSource;
      const oldGain = currentSourceGain;

      const newNode = audioCtx.createBufferSource();
      newNode.buffer = currentBuffer;
      const newGain = audioCtx.createGain();
      try {
        newGain.gain.setValueAtTime(0, now);
        newGain.gain.setValueCurveAtTime(up, t0, FADE);
      } catch (_) {
        newGain.gain.setValueAtTime(0, t0);
        newGain.gain.linearRampToValueAtTime(1, t0 + FADE);
      }
      try {
        oldGain.gain.cancelScheduledValues(now);
        oldGain.gain.setValueAtTime(oldGain.gain.value, now);
        oldGain.gain.setValueCurveAtTime(down, t0, FADE);
      } catch (_) {
        try {
          oldGain.gain.setValueAtTime(1, t0);
          oldGain.gain.linearRampToValueAtTime(0, t0 + FADE);
        } catch (_) {}
      }
      newNode.connect(newGain);
      newGain.connect(gainNode);
      newNode.start(t0, startPos);

      oldNode.onended = null;
      setTimeout(() => {
        try { oldNode.stop(); oldNode.disconnect(); } catch (_) {}
        try { oldGain.disconnect(); } catch (_) {}
      }, (0.01 + FADE) * 1000 + 50);

      trackScheduledAtAudioCtx = t0;
      trackScheduledAtPositionSec = startPos;
      currentRate = 1.0;
      lastCrossfadeAtCtx = now;
      currentSource = newNode;
      currentSourceGain = newGain;
      newNode.onended = () => {
        if (currentSource === newNode) {
          currentSource = null; currentSourceGain = null;
          if (htmlAudio && htmlAudio._isWebAudio) htmlAudio.paused = true;
        }
      };
      return true;
    }
    // Same idea but for HTML5 re-seek correction (in wall-clock ms).
    let lastReseekAtMs = 0;

    // ---- UI handlers ----
    // When the audio distance gate is enabled (admin opt-in), tapping the
    // launcher triggers a fresh location verification before the player
    // opens. getFreshLocation forces a brand-new GPS reading every time,
    // so users who loaded the page elsewhere (or walked away after granting
    // earlier) can't bypass the radius check via cached coordinates.
    //
    // When the gate is disabled, the click opens the player directly — no
    // permission prompts, no GPS. Showrunners playing original or licensed
    // content shouldn't have to ask viewers for location just to listen.
    btn.onclick = async () => {
      // iOS Safari only allows an AudioContext to start unsuspended when
      // it's created (or resumed) synchronously inside a user-gesture
      // callback. This handler is async and later awaits a location
      // prompt (_ofVerifyLocationForAudio) before startup() ever runs —
      // by the time startup() creates `audioCtx`, the gesture window has
      // long closed and iOS hands back a permanently suspended context,
      // so audio never plays. Fix: construct it right here, still inside
      // the synchronous part of the click handler, and stash it for
      // startup() to pick up. (Credit: iPhone audio-blocked repro via
      // PR #17 from jddocea.)
      //
      // NOTE: this must NOT assign directly to `audioCtx` — setMode()
      // and applyShowNotPlaying() use `!audioCtx` to mean "startup()
      // hasn't run yet." Assigning here made them think it already had,
      // so startup() (which fetches audio and builds gainNode) never
      // fired on first open. Use the pending slot instead.
      if (!audioCtx && !_pendingGestureAudioCtx) {
        try {
          _pendingGestureAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch {}
      }
      if (_pendingGestureAudioCtx && _pendingGestureAudioCtx.state === 'suspended') {
        _pendingGestureAudioCtx.resume().catch(() => {});
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      // Re-assert on every tap, not just at module init — WebKit can
      // reset the session type back to "ambient" after an interruption
      // (phone call, Siri, another app grabbing audio focus). Cheap and
      // idempotent, so no harm in repeating it.
      if ('audioSession' in navigator) {
        try { navigator.audioSession.type = 'playback'; } catch {}
      }
      // If the show isn't currently playing, there's no audio to gate on.
      // Skip the location prompt entirely — just open the panel so the
      // user sees the "Show isn't playing" message. We'll ask for location
      // when it actually matters (when they tap to listen to real audio).
      if (_showNotPlaying) {
        setMode('open');
        return;
      }
      if (!boot.audioGateEnabled) {
        setMode('open');
        return;
      }
      const origIcon = btn.innerHTML;
      btn.innerHTML = '⏳';
      btn.disabled = true;
      try {
        const result = await window._ofVerifyLocationForAudio();
        if (!result.allowed) {
          window._ofShowGateModal(result.reason);
          return;
        }
        setMode('open');
      } finally {
        btn.innerHTML = origIcon;
        btn.disabled = false;
      }
    };
    minBtn.onclick = () => setMode('minimized');
    closeBtn.onclick = () => setMode('closed');
    minimizedPill.onclick = () => setMode('open');
    playBtn.onclick = () => {
      // With HTML5 audio, the playBtn acts as a stop/restart toggle.
      // Stop: clear out the audio element so the user can re-sync.
      // Restart: kick a syncOnce() which triggers handleTrackChange with
      // fresh data, and that builds a new <audio> element seeked to the
      // current expected position.
      if (htmlAudio && !htmlAudio.paused) {
        stopAudio();
        statusEl.textContent = 'Resuming…';
        setPlayIcon(false);
        syncOnce();
      } else {
        // Either nothing playing yet, or audio is paused. Either way,
        // a fresh sync will rebuild and seek correctly.
        syncOnce();
      }
    };
    muteBtn.onclick = () => {
      isMuted = !isMuted;
      // Apply to HTML5 audio element (the active playback path).
      if (htmlAudio) htmlAudio.muted = isMuted;
      // Also toggle the Web Audio gain node for any legacy code paths
      // that might still produce sound through it.
      if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
      muteBtn.style.color = isMuted ? '#ef4444' : 'rgba(255,255,255,0.75)';
      setMuteIcon(isMuted);
    };

    function setMode(mode) {
      panelMode = mode;
      // Sticky panel takes ~75px height — push body content up so sticky doesn't
      // cover footer content the user scrolls to. Restored when panel closes/minimizes.
      // v0.33.215: the optional two-row phone player is taller.
      document.body.style.paddingBottom = (mode === 'open') ? (isTallPlayer() ? '150px' : '88px') : '';
      if (mode === 'closed') {
        panel.style.display = 'none';
        panel.style.transform = 'translateY(100%)';
        minimizedPill.style.display = 'none';
        btn.style.display = 'flex';
        stopAudio();
        teardown();
      } else if (mode === 'open') {
        btn.style.display = 'none';
        minimizedPill.style.display = 'none';
        panel.style.display = 'block';
        // Force reflow then transition in
        void panel.offsetHeight;
        panel.style.transform = 'translateY(0)';
        // Skip audio init when the show isn't playing — there's nothing
        // to sync to, and starting audio + running the gate check would
        // cause syncOnce() to flip the gate latch and immediately hide
        // the panel we just opened. The applyShowNotPlaying transition
        // back to false will call startup() when the show resumes.
        if (!audioCtx && !_showNotPlaying) startup();
      } else if (mode === 'minimized') {
        panel.style.transform = 'translateY(100%)';
        setTimeout(() => { panel.style.display = 'none'; }, 250);
        btn.style.display = 'none';
        minimizedPill.style.display = 'flex';
        // Audio keeps playing
      }
      // v0.33.207: lets the song progress bar move onto / off the player.
      try { window.dispatchEvent(new CustomEvent('showpilot:player-mode', { detail: { mode } })); } catch {}
    }

    // ---- Initialization (when panel first opens) ----
    // ---- Debug overlay ----
    // Add ?debug=1 to URL, or enable via admin Settings → Debug, to show sync details.
    // Shows: drift, FPP position, clockOffset, playbackRate, Socket.io latency.
    const debugMode = new URLSearchParams(window.location.search).get('debug') === '1'
      || !!(window.__SHOWPILOT__ && window.__SHOWPILOT__.debugOverlayEnabled);
    let debugEl = null;
    if (debugMode) {
      debugEl = document.createElement('div');
      debugEl.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
        background: rgba(0,0,0,0.85); color: #0f0; font: 11px monospace;
        padding: 6px 8px; line-height: 1.6; pointer-events: none;
        white-space: pre;
      `;
      document.body.appendChild(debugEl);
    }

    async function startup() {
      try {
        // Consume the AudioContext created synchronously in btn.onclick's
        // user-gesture window (iOS requires this — see comment there).
        // Falls back to constructing one here for callers that reach
        // startup() without going through that click handler (e.g. the
        // show-resumed path in applyShowNotPlaying) — those won't get
        // the iOS gesture benefit, but that's a pre-existing, documented
        // limitation, not something this fix needs to solve.
        if (_pendingGestureAudioCtx) {
          audioCtx = _pendingGestureAudioCtx;
          _pendingGestureAudioCtx = null;
        } else if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        gainNode = audioCtx.createGain();
        gainNode.gain.value = isMuted ? 0 : 1;
        gainNode.connect(audioCtx.destination);
        // v0.33.203: log device-driven state changes (e.g. Android pausing
        // audio on a Bluetooth route/focus change) and try to recover.
        try {
          const ctxForState = audioCtx;
          ctxForState.addEventListener('statechange', () => {
            if (ctxForState !== audioCtx) return;
            console.log('[ShowPilot] audio context state:', ctxForState.state);
            if (ctxForState.state !== 'running' && ctxForState.state !== 'closed' && pollTimer) {
              ctxForState.resume().catch(() => armResumeOnTap());
            }
          });
        } catch (_) {}
        statusEl.textContent = 'Loading…';

        // Hardware latency measurement removed — getOutputTimestamp() was
        // returning unreliable values (2000ms+) that destroyed sync.
        // Per-device calibration (localStorage sp_device_offset) handles
        // device latency instead.
        // v0.33.126: parallelize cold-start clock sync with audio fetch.
        // syncOnce() triggers handleTrackChange() which awaits a fetch+decode
        // — those can run while clock sync is still completing. Burst of 3
        // is enough at cold start (we re-burst with 5 once Socket.io is up).
        // Establish accurate clock offset BEFORE first sync poll. The first
        // poll's track-start timestamp uses clockOffset to compute initial
        // playback position; if clockOffset is wrong by 200ms here, every
        // viewer joining at the same time gets a different bias, and they
        // drift apart from each other. Burst sync up front prevents that.
        const coldClockSync = syncClockBurst(3);
        // Don't await — let it resolve while syncOnce() and the subsequent
        // fetch/decode run in parallel. clockOffset will be set before any
        // code path that depends on it (start position calc happens after
        // decode, which always takes >>> 200ms on real devices).
        await syncOnce();
        // Belt-and-suspenders: ensure cold sync finished before we proceed
        // past the polling setup, in case syncOnce() returned synchronously
        // (e.g. show not playing path). Cheap if it already resolved.
        await coldClockSync;
        // Re-sync periodically — once per second is enough since track-start
        // anchoring means we don't need continuous position updates.
        pollTimer = setInterval(syncOnce, 1000);
        // Drift correction loop (cheap — just compares client clock to expected)
        driftTimer = setInterval(updateDriftDisplay, 250);

        // Subscribe to live position updates from the server. The plugin
        // pushes "FPP is at position X.Y" via /api/plugin/position; the
        // server relays as a socket.io 'positionUpdate' event. We update
        // our anchor each time, giving us near-real-time speaker-accurate
        // sync without polling overhead. socket.io is shared with the
        // outer (queue/voting) scope; window.io() returns a singleton.
        try {
          if (window.io) {
            audioSock = window.io();

            // Re-sync clock via Socket.io now that connection is established.
            // Socket.io ping bypasses Cloudflare HTTP overhead for much better accuracy.
            syncClockBurst(5).then(() => {
              console.log('[ShowPilot] Socket.io timesync complete, clockOffset:', Math.round(clockOffset), 'ms');
            });

            // Re-sync every 30s continuously
            setInterval(() => syncClockBurst(3), 30000);

            // Persistent fppSyncPoint handler — resolves pending syncPoint
            // promises from handleTrackChange. Keyed by filename so concurrent
            // or rapid song changes each get their own resolver and don't
            // clobber each other.
            audioSock.on('fppSyncPoint', (msg) => {
              if (!msg || !msg.playing) return;
              recordFppSample(msg);
              // Do NOT update clockOffset here — msg.serverTimestamp is a one-way
              // timestamp with no RTT correction. Updating clockOffset from it
              // corrupts the accurate NTP burst estimate from syncClockBurst().
              // Resolve the pending promise for this specific filename
              if (msg.filename && window._pendingSyncPointResolvers &&
                  typeof window._pendingSyncPointResolvers[msg.filename] === 'function') {
                window._pendingSyncPointResolvers[msg.filename](msg);
                delete window._pendingSyncPointResolvers[msg.filename];
              }
              window._lastSyncPoint = msg;
            });
            audioSock.on('positionUpdate', (msg) => {
              if (!msg || !msg.sequence) return;
              if (currentSequence && msg.sequence !== currentSequence) return;
              livePosition = {
                sequence: msg.sequence,
                position: msg.position,
                updatedAt: msg.updatedAt,
              };
            });

            // FPP live position from daemon WebSocket — use this for
            // playbackRate drift correction so phones track FPP's speakers.
            audioSock.on('fppPosition', (msg) => {
              onFppLiveEvent(msg);
              if (!msg || !msg.playing || !msg.filename || !msg.serverTimestamp) return;

              // v0.33.202: no clockOffset update here. msg.serverTimestamp is a
              // one-way timestamp; nudging clockOffset toward it made phones
              // gradually ignore the message's travel time (steady lag).
              // Only syncClockBurst() sets clockOffset.
              recordFppSample(msg);

              // Always update fppStatus regardless of pause state —
              // needed for syncPoint seek calculation even before play()
              fppStatus = {
                positionSec: msg.positionSec,
                serverTimestamp: msg.serverTimestamp,
                arrivedAt: Date.now(),
                filename: msg.filename,
              };
            });
          }
        } catch (e) {
          console.warn('[ShowPilot] could not subscribe to position updates:', e);
        }

        // ============================================================
        // Audio gate — continuous proximity enforcement (v0.18.15+)
        // ============================================================
        // Two layers, both copyright safeguards:
        //
        //   1. CONTINUOUS — navigator.geolocation.watchPosition() fires
        //      whenever the device's GPS subscription updates (typically
        //      every few seconds when moving, less when stationary). On
        //      each update, compute distance to the show. If outside the
        //      radius, kick out immediately. This is the fast cutoff that
        //      catches users who walk/drive away mid-playback.
        //
        //   2. PERIODIC — every 5 minutes, do a full server-side re-check
        //      via verifyLocationForAudio(). This catches things the
        //      continuous watcher can't: tampered clients (DevTools-
        //      disabled watcher), GPS outages where the watcher stops
        //      firing, and server-side state changes (admin turned the
        //      gate off, control mode changed, etc).
        //
        // Both layers only run when boot.audioGateEnabled is true. Without
        // an enabled gate, the player does no location checks at all.
        // ============================================================
        if (boot.audioGateEnabled) {
          // (1) Continuous watcher — only set up if we have show coords
          // from the boot bundle. We need them to compute distance
          // client-side. If they're missing (older server, gate enabled
          // without coords configured), fall back to the periodic check
          // alone — better than nothing.
          if (
            typeof boot.audioGateLatitude === 'number' &&
            typeof boot.audioGateLongitude === 'number' &&
            typeof boot.audioGateRadiusMiles === 'number' &&
            'geolocation' in navigator
          ) {
            try {
              watchPositionId = navigator.geolocation.watchPosition(
                (pos) => {
                  // Grace period: ignore the FIRST 30 seconds of watcher
                  // updates after audio starts. The first watchPosition
                  // callback often fires with a stale cached location
                  // from BEFORE the user reached the show — but the
                  // click-time fresh-location check already proved they
                  // were in range, so honor that. After 30 seconds the
                  // watcher's positions should be fresh.
                  if (audioStartedAtMs === 0) return;  // not playing yet
                  if (Date.now() - audioStartedAtMs < 30 * 1000) {
                    // During grace period, still record liveness so the
                    // periodic server re-check can skip — the click-time
                    // check already verified, no need to re-verify so soon.
                    lastWatcherInRangeMs = Date.now();
                    return;
                  }

                  const dist = haversineMiles(
                    pos.coords.latitude,
                    pos.coords.longitude,
                    boot.audioGateLatitude,
                    boot.audioGateLongitude
                  );
                  if (dist > boot.audioGateRadiusMiles) {
                    // Out of range — tear down audio immediately. Pass
                    // 'proximity' as the latch category so the user can
                    // come back later and have the button auto-reveal
                    // (one-tap resume) without needing a refresh.
                    stopAudio();
                    applyAudioGateState(
                      true,
                      'Audio is only available to listeners present at the show.',
                      'proximity'
                    );
                    statusEl.textContent =
                      'Audio stopped — you have moved away from the show.';
                  } else {
                    // In range — record this so the periodic server check
                    // can skip itself. As long as the watcher is alive and
                    // reporting in-range, the server doesn't need to be
                    // re-asked the same question.
                    lastWatcherInRangeMs = Date.now();
                    // If we were proximity-latched (user walked away and
                    // is now back), lift the latch so the launcher button
                    // reappears. liftProximityLatch is a no-op for any
                    // other latch state, so this is safe to call on
                    // every in-range update.
                    liftProximityLatch();
                  }
                },
                (err) => {
                  // Watcher errors are non-fatal — the periodic server
                  // re-check below will still fire. Log for debugging.
                  if (window.console && console.warn) {
                    console.warn('[audio-gate] watchPosition error:', err.message || err);
                  }
                },
                {
                  // Coarse positioning is fine — we're checking "within
                  // half a mile?" not "within 5 meters?" Setting
                  // enableHighAccuracy: false saves significant battery
                  // since the device can use cell-tower / Wi-Fi positioning
                  // instead of waking the GPS chip continuously.
                  enableHighAccuracy: false,
                  // No maximumAge cap on the watcher — let the browser
                  // batch positions however it wants. If the user is
                  // stationary, fewer updates is correct.
                  // No timeout — watchPosition shouldn't error on slow
                  // fixes, it just doesn't fire until it has one.
                }
              );
            } catch (e) {
              // Browser threw on watchPosition setup — extremely rare,
              // but don't let it break audio playback.
              if (window.console && console.warn) {
                console.warn('[audio-gate] watchPosition setup failed:', e.message || e);
              }
            }
          }

          // (2) Periodic server re-check — fallback layer for cases the
          // continuous watcher can't handle. Now smart: skips itself when
          // the watcher has confirmed the user is in range within the
          // last 6 minutes. The watcher is already doing the work — re-
          // asking the server would just burn battery (waking GPS for
          // getCurrentPosition with maximumAge: 0) and bandwidth for no
          // security benefit.
          //
          // The 6-minute threshold is intentionally larger than this
          // interval (5 min) to handle small timing drift. If the
          // watcher reported "in range" at minute 4:55 and we run at
          // minute 5:00, that's only 5 seconds of staleness — still
          // fresh enough to trust.
          //
          // What does this actually catch?
          //   - Tampered client (DevTools-killed watcher). lastWatcherInRangeMs
          //     stays stale, so the periodic check fires and uses
          //     getFreshLocation to verify directly with the server.
          //   - Watcher silently dead due to GPS chip outage or browser
          //     bug. Same path: stale liveness → periodic check fires.
          //
          // What does this NOT need to catch?
          //   - Admin disabled the gate / show turned off. The 5-second
          //     /api/visual-config poll above already handles those —
          //     server returns audioGateBlocked=true, applyAudioGateState
          //     fires the showpilot:audio-gate-blocked event, audio
          //     stops within seconds. Independent mechanism.
          locationVerifyTimer = setInterval(async () => {
            const watcherFreshMs = Date.now() - lastWatcherInRangeMs;
            if (lastWatcherInRangeMs > 0 && watcherFreshMs < 6 * 60 * 1000) {
              // Watcher is alive and confirmed in-range recently. Skip
              // the server round trip.
              return;
            }
            const result = await window._ofVerifyLocationForAudio();
            if (!result.allowed) {
              stopAudio();
              // Categorize as 'proximity' — this fallback path exists
              // SPECIFICALLY to catch dead-watcher scenarios where the
              // user is likely out of range. A server-side block reason
              // (admin disabled show) gets surfaced through the 5-second
              // /api/visual-config poll independently. Keeping this as
              // 'proximity' preserves the auto-recover-on-return behavior
              // even when the fallback fires before the watcher does.
              applyAudioGateState(
                true,
                result.reason || 'Audio is no longer available.',
                'proximity'
              );
              statusEl.textContent = result.reason || 'Audio gate triggered.';
            }
          }, 5 * 60 * 1000);
        }
      } catch (err) {
        statusEl.textContent = 'Audio unavailable: ' + err.message;
      }
    }

    function teardown() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
      if (locationVerifyTimer) { clearInterval(locationVerifyTimer); locationVerifyTimer = null; }
      // Release the GPS subscription so the device can put the GPS chip
      // back to sleep. clearWatch is a no-op for null IDs but the guard
      // keeps the code symmetric with the other clearInterval calls.
      if (watchPositionId !== null) {
        try { navigator.geolocation.clearWatch(watchPositionId); } catch {}
        watchPositionId = null;
      }
      audioStartedAtMs = 0;
      lastWatcherInRangeMs = 0;

      // Clear a proximity latch on teardown — but only proximity, not
      // server. Reasoning:
      //
      // teardown() runs when the user closes the panel via the X button.
      // That's an explicit "I'm done with audio" signal. If they later
      // tap the launcher, the click-time fresh-location check is the
      // authoritative gate — they get blocked then if still out of range.
      //
      // BUT — if they were proximity-latched at the moment they closed
      // the panel, AND we keep the watcher dead (above), they have no
      // way to ever re-engage: the launcher button is hidden by the
      // latch's CSS class, so they can't even tap it. Clearing the
      // proximity latch here unblocks the launcher; if they're still
      // out of range, the click-time check still rejects them, so this
      // is safe.
      //
      // The 'server' latch (admin disabled show, etc.) is preserved
      // through teardown. Its purpose — preventing auto-resume after
      // an admin toggle — applies regardless of whether the panel was
      // closed in between.
      if (_gateLatchedBlocked === 'proximity') {
        _gateLatchedBlocked = null;
        const btn = document.getElementById('of-listen-btn');
        if (btn) btn.classList.remove('of-audio-gate-pending');
      }

      if (pendingStartTimeout) { clearTimeout(pendingStartTimeout); pendingStartTimeout = null; }
      if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; gainNode = null; }
      currentBuffer = null;
      // Buffers were decoded for the context just closed; free the memory.
      decodedBufferCache.clear();
      prefetchInFlight.clear();
      prefetchRetryAt.clear();
      currentStreamKey = null;
      nextStreamKey = null;
      currentSequence = null;
      currentMediaName = null;
      currentTrackMediaName = null;
    }

    // ---- NTP-style clock sync (burst pings) ----
    //
    // Establishes accurate clock offset between this client and the server.
    // Without accurate sync, two phones aligning to "FPP position + elapsed
    // since update" will drift apart because each computes elapsed using
    // its own (skewed) Date.now(). The single-sample offset embedded in
    // now-playing-audio polls has 50-200ms of jitter from network variance;
    // burst sync improves this to ~10-20ms by:
    //   1. Firing N parallel pings to /api/time
    //   2. Recording (t_send_local, t_recv_local, t_server) for each
    //   3. Computing offset = t_server + rtt/2 - t_recv_local
    //   4. Discarding outlier RTTs (sort by rtt, keep best half)
    //   5. Averaging the offsets from the kept samples
    //
    // The "discard outliers" step is key — a single bad ping (network
    // hiccup, GC pause, etc.) would skew an unfiltered average by tens
    // of ms. PulseMesh's implementation does similar burst+filter logic
    // on a dedicated WebSocket; we use HTTP since we're not building a
    // separate connection just for this.
    let lastClockSyncAt = 0;
    let bestRttEverMs = Infinity; // best RTT seen across all bursts — guards against high-jitter overwrites
    async function syncClockBurst(burstSize = 5) {
      // Use Socket.io timesync for accurate clock offset measurement.
      // Socket.io bypasses Cloudflare HTTP overhead giving 5-20ms accuracy
      // vs 50-200ms for HTTP. We fire parallel queries and take the best.
      if (audioSock && audioSock.connected) {
        return new Promise((resolve) => {
          const samples = [];
          let pending = burstSize;

          const handler = (msg) => {
            const t4 = Date.now();
            const rtt = t4 - msg.t1;
            const offset = ((msg.t2 - msg.t1) + (msg.t3 - t4)) / 2;
            samples.push({ rtt, offset });
            pending--;
            if (pending === 0) {
              audioSock.off('timesync', handler);
              // Pick lowest-RTT sample — most accurate
              samples.sort((a, b) => a.rtt - b.rtt);
              const bestRtt = samples[0].rtt;
              const best = samples.slice(0, Math.ceil(samples.length / 2));
              const offsets = best.map(s => s.offset).sort((a, b) => a - b);
              const mid = Math.floor(offsets.length / 2);
              const newOffset = offsets.length % 2 === 1
                ? offsets[mid]
                : (offsets[mid - 1] + offsets[mid]) / 2;

              // Only update clockOffset if this burst's RTT is within 3x of
              // the best RTT we've ever seen. High-jitter bursts (e.g. 200ms RTT
              // when we've previously seen 5ms) produce inaccurate offsets and
              // cause the drift display to jump, triggering spurious crossfades.
              if (bestRtt < bestRttEverMs) bestRttEverMs = bestRtt;
              if (bestRtt <= bestRttEverMs * 3) {
                clockOffset = newOffset;
                lastClockSyncAt = Date.now();
              }
              console.log('[ShowPilot] timesync complete, clockOffset:', Math.round(clockOffset), 'ms (best RTT:', bestRtt, 'ms' + (bestRtt > bestRttEverMs * 3 ? ' — REJECTED high jitter' : '') + ')');
              resolve();
            }
          };
          audioSock.on('timesync', handler);

          // Fire all queries in parallel
          for (let i = 0; i < burstSize; i++) {
            audioSock.emit('timesync', { t1: Date.now() });
          }

          // Fallback timeout
          setTimeout(() => {
            audioSock.off('timesync', handler);
            resolve();
          }, 3000);
        });
      }

      // Fallback: HTTP-based sync when Socket.io not ready yet
      const samples = [];
      const promises = [];
      for (let i = 0; i < burstSize; i++) {
        promises.push((async () => {
          const t0 = Date.now();
          try {
            const r = await fetch('/api/time', { credentials: 'include', cache: 'no-store' });
            const t1 = Date.now();
            const data = await r.json();
            if (typeof data.t === 'number') {
              const rtt = t1 - t0;
              const oneWay = rtt / 2;
              const offset = data.t + oneWay - t1;
              samples.push({ rtt, offset });
            }
          } catch (e) {}
        })());
      }
      await Promise.all(promises);
      if (samples.length === 0) return;
      samples.sort((a, b) => a.rtt - b.rtt);
      const keep = samples.length >= 4 ? samples.slice(0, Math.ceil(samples.length / 2)) : samples;
      const offsets = keep.map(s => s.offset).sort((a, b) => a - b);
      const mid = Math.floor(offsets.length / 2);
      clockOffset = offsets.length % 2 === 1
        ? offsets[mid]
        : (offsets[mid - 1] + offsets[mid]) / 2;
      lastClockSyncAt = Date.now();
    }

    async function syncOnce() {
      try {
        // Master audio kill-switch — admin disabled audio for this show.
        // No point polling /api/now-playing-audio: the server returns
        // {audioDisabled:true} and there's no launcher to drive anyway.
        // Bail to keep the network quiet on every viewer's tab.
        if (!boot.audioEnabled) return;

        // If the gate is latched (panel hidden, user kicked out for any
        // reason), don't keep polling for audio. The cached location may
        // be stale, audio might try to restart invisibly into a hidden
        // panel, and any way you slice it the user shouldn't hear music
        // they can't see the UI for. When the latch clears (proximity
        // latch lifts on return, server latch only clears on refresh),
        // polling resumes naturally on the next interval.
        if (_gateLatchedBlocked !== null) return;

        const reqStart = Date.now();
        const r = await fetch('/api/now-playing-audio' + locationQuery(), { credentials: 'include' });
        if (!r.ok) return;
        const data = await r.json();
        const reqEnd = Date.now();

        // Server says viewer is outside the audio gate radius — stop audio
        // and signal the launcher to hide. /api/visual-config polling will
        // also pick this up but we react immediately when player is open.
        if (data.audioGateBlocked) {
          if (currentSource) stopAudio();
          applyAudioGateState(true, data.audioGateReason || '');
          return;
        }

        // Update language picker regardless of play state — variants are
        // sequence-specific and should show as soon as the panel is open,
        // even before audio starts or between songs. Must run before the
        // early-return below so it's never skipped.
        updateLanguagePicker(data.languages || []);

        if (!data.playing || !data.hasAudio) {
          if (currentSource) stopAudio();
          titleEl.textContent = data.playing ? _pt('No audio for this sequence') : _pt('Show is not playing');
          artistEl.textContent = '';
          setupMarquee(titleEl, titleWrap);
          setupMarquee(artistEl, artistWrap);
          statusEl.textContent = '';
          pillText.textContent = _pt('Idle');
          return;
        }

        lastSyncResponse = data;

        // Update clock offset only if we haven't done a burst sync yet.
        // Burst sync (syncClockBurst) is much more accurate; once it's
        // run we leave clockOffset alone except for periodic refreshes.
        // This prevents the single-sample latency-jittered estimate from
        // overwriting our good measurement on every poll.
        if (lastClockSyncAt === 0) {
          const oneWayLatency = (reqEnd - reqStart) / 2;
          clockOffset = data.serverNowMs - reqEnd + oneWayLatency;
        }

        // Apply decoration theme (cheap — only does work if it changed)
        applyDecoration(data.playerDecoration, data.playerDecorationAnimated, data.playerCustomColor);

        // Append ?lang= to streamUrl/publicStreamUrl if a non-default language
        // is selected. This is done here (not in handleTrackChange) so every
        // fetch — including prefetches — gets the right variant.
        if (selectedLang && selectedLang !== 'default' && data.streamUrl) {
          const sep = data.streamUrl.includes('?') ? '&' : '?';
          data.streamUrl = data.streamUrl + sep + 'lang=' + encodeURIComponent(selectedLang);
          if (data.publicStreamUrl) {
            const sep2 = data.publicStreamUrl.includes('?') ? '&' : '?';
            data.publicStreamUrl = data.publicStreamUrl + sep2 + 'lang=' + encodeURIComponent(selectedLang);
          }
          if (data.nextStreamUrl) {
            const sep3 = data.nextStreamUrl.includes('?') ? '&' : '?';
            data.nextStreamUrl = data.nextStreamUrl + sep3 + 'lang=' + encodeURIComponent(selectedLang);
          }
        }

        // Track changed?
        if (data.sequenceName !== currentSequence) {
          if (Date.now() >= trackRetryNotBefore) handleTrackChange(data);
        } else if (!currentSource && trackChangeAt && audioCtx &&
                   (!htmlAudio || htmlAudio._isWebAudio) &&
                   Date.now() - trackChangeAt > 15000) {
          // v0.33.203 watchdog: the server says this song is playing, we
          // started loading it 15s+ ago, and nothing is playing (stalled
          // load, paused context, or a silent failure). Retry instead of
          // waiting for a page refresh. Only runs while the listener has
          // audio on: this poll stops when the player is closed, and the
          // location gate returns before reaching here.
          console.warn('[ShowPilot] nothing playing 15s after track start — retrying', data.sequenceName);
          trackChangeAt = 0;
          handleTrackChange(data);
        } else {
          // Prefetch the NEXT song so it's decoded and ready when the song
          // changes. Waits until the current song has loaded so the two
          // downloads don't compete. If the server's guess changes (e.g. a
          // new vote leader), the old guess is dropped from the cache.
          const newNextKey = data.nextStreamUrl || null;
          if (newNextKey !== nextStreamKey) {
            nextStreamKey = newNextKey;
            pruneBufferCache();
          }
          if (nextStreamKey && currentBuffer) prefetchAudio(nextStreamKey);
          // Same track — just update timing anchor in case server has new info
          if (data.trackStartedAtMs) trackStartedAtMs = data.trackStartedAtMs;
          if (data.durationSec) trackDuration = data.durationSec;
          if (typeof data.audioSyncOffsetMs === 'number') audioSyncOffsetMs = data.audioSyncOffsetMs;
          // Refresh live position from response — covers the case where
          // the socket connection is down or hasn't pushed an update
          // since this poll arrived. Only accept if it matches our
          // current sequence (defensive against race-condition stale data).
          if (data.livePosition && data.livePosition.sequence === currentSequence) {
            livePosition = data.livePosition;
          }
          // Refresh metadata in case admin changed it
          if (data.imageUrl && coverEl.src !== data.imageUrl) coverEl.src = data.imageUrl;
        }

        // Update minimized pill text
        pillText.textContent = data.displayName || data.sequenceName || 'Playing';
      } catch (err) {
        console.warn('sync error', err);
      }
    }

    // ---- Track switch ----
    async function handleTrackChange(data) {
      currentSequence = data.sequenceName;

      // Register syncPoint resolver keyed by mediaName so rapid song changes
      // don't clobber each other's resolvers.
      if (!window._pendingSyncPointResolvers) window._pendingSyncPointResolvers = {};
      let pendingSyncPoint = window._lastSyncPoint || null;
      const syncPointPromise = new Promise((resolve) => {
        // If we already have a recent syncPoint for this song, use it immediately
        if (pendingSyncPoint && pendingSyncPoint.filename === data.mediaName) {
          resolve(pendingSyncPoint);
          return;
        }
        if (data.mediaName) {
          window._pendingSyncPointResolvers[data.mediaName] = resolve;
        } else {
          // No mediaName — can't key the resolver, fall back to legacy global
          window._pendingSyncPointResolver = resolve;
        }
      });

      // Seed fppStatus from now-playing-audio response on EVERY track
      // change so we always have a fresh position for the new song.
      // Without this, song 2 inherits song 1's stale position and the
      // fast-start computation produces a startPositionSec past the new
      // song's duration ("Waiting for next track…" stuck state).
      // elapsedSec + serverNowMs gives us a usable anchor.
      if (data.elapsedSec >= 0 && data.serverNowMs) {
        fppStatus = {
          positionSec: data.elapsedSec,
          serverTimestamp: data.serverNowMs,
          filename: data.mediaName || null,
        };
      }
      currentMediaName = data.sequenceName;
      currentTrackMediaName = data.mediaName || null;
      trackStartedAtMs = data.trackStartedAtMs || (Date.now() + clockOffset - (data.elapsedSec * 1000));
      trackDuration = data.durationSec || 0;
      if (typeof data.audioSyncOffsetMs === 'number') audioSyncOffsetMs = data.audioSyncOffsetMs;
      livePosition = (data.livePosition && data.livePosition.sequence === data.sequenceName)
        ? data.livePosition : null;

      titleEl.textContent = data.displayName || data.sequenceName;
      artistEl.textContent = data.artist || '';
      setupMarquee(titleEl, titleWrap);
      setupMarquee(artistEl, artistWrap);
      coverEl.src = data.imageUrl || '';
      coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';
      statusEl.textContent = 'Loading audio…';
      setPlayIcon(false);

      stopAudio();
      const myTrackToken = ++trackChangeToken;
      trackChangeAt = Date.now();

      // ---- Web Audio API BufferSource playback ----
      // Fetch the full audio file as ArrayBuffer, decode to PCM, then play
      // via AudioBufferSourceNode. This matches PulseMesh's architecture:
      // - Clean crossfade seeks (no decoder restart artifacts)
      // - Sub-millisecond position tracking via audioCtx.currentTime
      // - AudioContext clock doesn't drift when phone screen locks
      // - Hardware output latency measurable via audioCtx.outputLatency
      useRelay = false;

      try {
        if (htmlAudio) {
          try { htmlAudio.pause(); htmlAudio.src = ''; htmlAudio.load(); } catch {}
          htmlAudio = null;
        }
        // Stop any existing Web Audio source
        if (currentSource) {
          try { currentSource.stop(); currentSource.disconnect(); } catch {}
          currentSource = null;
        }
        if (currentSourceGain) {
          try { currentSourceGain.disconnect(); } catch {}
          currentSourceGain = null;
        }
        currentBuffer = null;

        const chosenUrl = data.streamUrl
          ? window.location.origin + data.streamUrl
          : data.publicStreamUrl;

        if (!chosenUrl) {
          statusEl.textContent = _pt('No audio source available');
          return;
        }

        console.info('[ShowPilot] audio source: CACHE (WebAudio)', chosenUrl);
        statusEl.textContent = 'Loading audio…';

        // Use the prefetched buffer if there is one (or wait for a prefetch
        // of this song that's still running), otherwise fetch+decode now.
        // The result is kept as the current song's cache entry so polls
        // never download the song that's already playing.
        const streamKey = data.streamUrl || null;
        currentStreamKey = streamKey;
        if (streamKey === nextStreamKey) nextStreamKey = null; // the "next" song is now playing
        pruneBufferCache();
        let audioBuffer = streamKey ? (decodedBufferCache.get(streamKey) || null) : null;
        if (!audioBuffer && streamKey && prefetchInFlight.has(streamKey)) {
          console.info('[ShowPilot] waiting for in-progress prefetch of', currentSequence);
          audioBuffer = await prefetchInFlight.get(streamKey);
          if (myTrackToken !== trackChangeToken) return; // a newer track change took over
        }
        if (audioBuffer) {
          console.info('[ShowPilot] using pre-decoded buffer for', currentSequence);
        } else {
          const arrayBuf = await fetchAudioWithTimeout(chosenUrl, 20000);
          if (myTrackToken !== trackChangeToken) return; // a newer track change took over
          audioBuffer = await new Promise((resolve, reject) => {
            audioCtx.decodeAudioData(arrayBuf, resolve, reject);
          });
          if (streamKey && streamKey === currentStreamKey) decodedBufferCache.set(streamKey, audioBuffer);
        }
        if (myTrackToken !== trackChangeToken) return; // a newer track change took over

        // v0.33.203: the device may have paused the AudioContext between
        // songs (seen on Android with Bluetooth/Android Auto). Sources
        // scheduled on a paused context never make a sound.
        if (audioCtx && audioCtx.state !== 'running') {
          console.warn('[ShowPilot] audio context is ' + audioCtx.state + ' at track start — resuming');
          try { await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 1500))]); } catch (_) {}
          if (myTrackToken !== trackChangeToken) return;
          if (audioCtx.state !== 'running') {
            armResumeOnTap();
            const e = new Error('audio paused by the device (' + audioCtx.state + ')');
            e.spSuspended = true;
            throw e;
          }
          console.log('[ShowPilot] audio context resumed');
        }

        currentBuffer = audioBuffer;
        console.info('[ShowPilot] audio ready:', audioBuffer.duration.toFixed(2) + 's', audioBuffer.sampleRate + 'Hz');

        // ---- Coordinated play start (v0.33.129) ----
        // Fast-start immediately, one-time grid snap ~2s later to lock all phones
        // to the same position, then PLL handles the rest of the song.
        //
        // HOW IT WORKS:
        // 1. Audio starts immediately from current fppStatus position — no waiting,
        //    sound out right away. Phones may be slightly apart at this point.
        // 2. All phones compute the same 2s grid boundary (playAtServerMs).
        //    At that moment a setTimeout fires on every phone simultaneously,
        //    stops the current source, and restarts at the grid-correct position.
        //    One brief cut (~1ms gap), then all phones are locked together.
        // 3. syncPointPromise races against the snap timeout — if the daemon
        //    syncPoint arrives before the snap (~1.5s after song change), it gives
        //    a more accurate position for the snap. Falls back to fppStatus.
        // 4. After the snap this mechanism is done. PLL (playbackRate) takes over
        //    for any residual drift throughout the rest of the song.
        //
        // DO NOT add more snap events after the first — one cut per song change only.
        const myGeneration = playGeneration;

        // v0.33.204: start in the right place instead of starting from a
        // rough guess and jumping later. If there are no FPP readings for
        // this song yet (song just changed), wait briefly for them — they
        // arrive every ~0.5s. Listeners joining mid-song already have them.
        if (currentTrackMediaName && !estimateFppPosNow()) {
          statusEl.textContent = _pt('Syncing…');
          const waitUntil = Date.now() + 2500;
          while (!estimateFppPosNow() && Date.now() < waitUntil) {
            await new Promise(r => setTimeout(r, 50));
            if (playGeneration !== myGeneration || myTrackToken !== trackChangeToken) return;
          }
        }

        const outputLatencySec = getOutputLatencySec();
        const serverNow = Date.now() + clockOffset;

        // ---- Fast-start: play immediately from current position ----
        let fastStartPos;
        const fastStartEst = estimateFppPosNow();
        if (fastStartEst) {
          fastStartPos = fastStartEst.pos
            - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000);
        } else if (fppStatus && fppStatus.positionSec >= 0) {
          const ageMs = Math.max(0, serverNow - (fppStatus.serverTimestamp || serverNow));
          fastStartPos = fppStatus.positionSec + (ageMs / 1000)
            - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000);
        } else {
          fastStartPos = Math.max(0, (serverNow - trackStartedAtMs) / 1000)
            - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000);
        }
        if (fastStartPos < 0) fastStartPos = 0;
        if (fastStartPos >= audioBuffer.duration) {
          statusEl.textContent = 'Waiting for next track…';
          return;
        }

        // v0.33.202: start 50ms from now at the position FPP will be at when
        // this sample is actually HEARD (lead + output latency ahead). Older
        // versions delayed the start by the output latency instead of
        // advancing the position, landing 50ms + 2x latency behind.
        const fastStartCtxTime = audioCtx.currentTime + 0.05;
        fastStartPos += 0.05 + outputLatencySec;
        // A negative listener offset ("music is early") can push this below
        // the start of the song at song start; clamp (v0.33.213+).
        if (fastStartPos < 0) fastStartPos = 0;
        if (fastStartPos >= audioBuffer.duration) {
          statusEl.textContent = 'Waiting for next track…';
          return;
        }
        console.log('[ShowPilot] fast-start: pos', fastStartPos.toFixed(3) + 's');

        if (playGeneration !== myGeneration) return;

        // Schedule fast-start source
        trackScheduledAtAudioCtx = fastStartCtxTime;
        trackScheduledAtPositionSec = fastStartPos;
        currentRate = 1.0;
        trackScheduledOutputLatency = outputLatencySec;

        const srcNode = audioCtx.createBufferSource();
        srcNode.buffer = audioBuffer;
        const srcGain = audioCtx.createGain();
        srcGain.gain.value = 1;
        srcNode.connect(srcGain);
        srcGain.connect(gainNode);
        srcNode.start(fastStartCtxTime, fastStartPos);

        currentSource = srcNode;
        currentSourceGain = srcGain;

        srcNode.onended = () => {
          if (currentSource === srcNode) {
            currentSource = null;
            currentSourceGain = null;
            if (htmlAudio && htmlAudio._isWebAudio) htmlAudio.paused = true;
          }
        };

        // ---- Snap on first syncPoint + one follow-up crossfade ----
        // Goal: everything locked within ~3s of song start.
        //
        // 1. Await the first syncPoint for this song (arrives ~2s after change).
        //    Snap immediately when it arrives — no grid boundary, no waiting.
        // 2. 500ms after the snap, do one crossfade correction to catch any
        //    remaining error introduced by the hard cut's scheduling jitter.
        // 3. The periodic crossfade loop handles anything beyond that only as
        //    a safety net (threshold 50ms, cooldown 10s).
        const generationAtSchedule = myGeneration;

        (async () => {
          // Await syncPoint with 8s timeout fallback
          const snapAnchor = await Promise.race([
            syncPointPromise.then(sp => (sp && sp.filename === data.mediaName) ? sp : null),
            new Promise(resolve => setTimeout(() => resolve(null), 8000)),
          ]);

          if (playGeneration !== generationAtSchedule) return;

          if (!snapAnchor) {
            snapPendingUntilMs = 0;
            console.log('[ShowPilot] snap: no syncPoint within 8s, skipping');
            return;
          }

          // Compute position from syncPoint
          const snapServerNow = Date.now() + clockOffset;
          const ageMs = Math.max(0, snapServerNow - snapAnchor.serverTimestamp);
          // v0.33.202: best estimate of FPP's position now = the most advanced
          // of this syncPoint and recent position readings (see
          // estimateFppPosNow). Then add the output latency: snapPos is the
          // position that should be LEAVING the audio pipeline now.
          let snapFppPos = snapAnchor.positionSec + (ageMs / 1000);
          const snapEst = estimateFppPosNow();
          if (snapEst && snapEst.pos > snapFppPos) snapFppPos = snapEst.pos;
          let snapPos = snapFppPos
            - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000)
            + getOutputLatencySec();

          if (snapPos < 0) snapPos = 0;
          if (snapPos >= audioBuffer.duration) { snapPendingUntilMs = 0; return; }

          const currentPos = htmlAudio ? htmlAudio.currentTime : fastStartPos;
          const snapErrorMs = Math.round((snapPos - currentPos) * 1000);

          if (Math.abs(snapErrorMs) < JUMP_THRESHOLD_MS) {
            // v0.33.204: small error — no cut; the speed loop closes it.
            console.log('[ShowPilot] snap: ' + snapErrorMs + 'ms — smoothing by speed');
          } else {
            console.log('[ShowPilot] snap: ' + snapErrorMs + 'ms → crossfade to', snapPos.toFixed(3) + 's');
            if (crossfadeTo(snapPos)) {
              trackScheduledOutputLatency = outputLatencySec;
              if (htmlAudio) htmlAudio._seekedTo = snapPos;
              audioStartedAtMs = Date.now();
              snapAnchorCtxTime = trackScheduledAtAudioCtx;
              snapAnchorPosSec = trackScheduledAtPositionSec;
            }
          }

          snapPendingUntilMs = 0;

          // ---- Follow-up crossfade 500ms after snap ----
          await new Promise(resolve => setTimeout(resolve, 500));
          if (playGeneration !== generationAtSchedule) return;
          if (!currentBuffer || !currentSource || !currentSourceGain) return;

          const followFppStatus = fppStatus;
          if (!followFppStatus || followFppStatus.positionSec <= 0) return;

          const followClientTs = followFppStatus.serverTimestamp - clockOffset;
          const followAge = Math.min(Math.max(Date.now() - followClientTs, 0), 2000);
          const followEst = estimateFppPosNow();
          const followFppPos = followEst
            ? followEst.pos
            : followFppStatus.positionSec + (followAge / 1000);
          // Position that should be rendering now = heard target + output latency.
          const followTarget = followFppPos
            - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000)
            + getOutputLatencySec();

          if (followTarget < 0 || followTarget >= audioBuffer.duration - 0.1) return;

          const followError = Math.round((followTarget - htmlAudio.currentTime) * 1000);
          if (Math.abs(followError) < JUMP_THRESHOLD_MS) {
            // v0.33.204: small error — the speed loop closes it smoothly.
            console.log('[ShowPilot] follow-up: ' + followError + 'ms — smoothing by speed');
            return;
          }

          console.log('[ShowPilot] follow-up: ' + followError + 'ms → crossfade to', followTarget.toFixed(3) + 's');
          if (crossfadeTo(followTarget)) {
            audioStartedAtMs = Date.now();
            snapAnchorCtxTime = trackScheduledAtAudioCtx;
            snapAnchorPosSec = trackScheduledAtPositionSec;
          }
        })();

        // Use a dummy htmlAudio object for compatibility with drift display
        htmlAudio = {
          _isWebAudio: true,
          _seekedTo: fastStartPos,
          _seekFppTs: fppStatus?.serverTimestamp ? new Date(fppStatus.serverTimestamp).toISOString().slice(14,22) : 'none',
          _syncPointTs: fppStatus?.serverTimestamp || 'none',
          _startupSeeked: false,
          _microSeekCooldown: false,
          paused: false,
          muted: isMuted,
          volume: 1,
          playbackRate: 1,
          duration: audioBuffer.duration,
          get currentTime() {
            if (!audioCtx || audioCtx.state === 'suspended') return trackScheduledAtPositionSec;
            return renderedPosAt(audioCtx.currentTime);
          },
          set currentTime(v) { /* drift correction handled by PLL */ },
        };

        setPlayIcon(true);
        statusEl.textContent = '';
        audioStartedAtMs = Date.now();
        pendingPostStartCorrectionAtMs = 0;

        // Block periodic crossfade until snap+follow-up resolves (~3s)
        snapPendingUntilMs = Date.now() + 9000;
        smoothedDriftMs = 0; // v0.33.202: don't carry the last song's drift over

        console.info('[ShowPilot] WebAudio fast-start at', fastStartCtxTime.toFixed(3),
          'ctx sec, position', fastStartPos.toFixed(3) + 's');

      } catch (err) {
        const suspended = !!(err && err.spSuspended);
        statusEl.textContent = suspended
          ? _pt('Tap to resume audio')
          : 'Load failed: ' + (err.message || err);
        console.warn('[ShowPilot] WebAudio load failed:', err);
        // v0.33.203: forget the track so the next poll retries it (after a
        // short backoff) instead of staying silent until a page refresh.
        if (myTrackToken === trackChangeToken && currentSequence === data.sequenceName) {
          currentSequence = null;
          trackChangeAt = 0;
          trackRetryNotBefore = Date.now() + (suspended ? 1000 : 5000);
        }
      }
    }

    // Fetch audio sequentially from a list of URLs, return the first successful
    // arrayBuffer.
    async function tryFetchAudio(urls) {
      let lastErr = null;
      for (const url of urls) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return await r.arrayBuffer();
        } catch (err) {
          lastErr = err;
          console.warn('[ShowPilot audio] fetch failed:', url, err.message);
        }
      }
      throw lastErr || new Error('No URLs to try');
    }

    // Compute the expected current playback position. This is the
    // single source of truth for "where SHOULD audio be right now."
    //
    // Two paths:
    //
    // 1. Live position (preferred) — when the plugin has pushed a
    //    recent FPP playback position via /api/plugin/position. The
    //    update has a server timestamp; we extrapolate forward from
    //    that point at native rate. Since this position came directly
    //    from FPP's seconds_played, it reflects what FPP's hardware
    //    audio output is actually doing, including buffer delay. Phones
    //    aligning to this number naturally match the speakers.
    //
    // 2. Track-start extrapolation (fallback) — older plugin or initial
    //    bootstrap before any position update has arrived. Uses the
    //    fixed trackStartedAtMs anchor and assumes audio has been
    //    progressing at native rate ever since. Less accurate over time
    //    because trackStartedAtMs is stamped at FPP's "I'm starting
    //    playback now" event, which precedes hardware audio emission
    //    by the FPP buffer delay (~200ms typical).
    //
    // The audioSyncOffsetMs adjustment is applied in BOTH paths but
    // serves different roles:
    //  - Path 1: usually 0 — FPP's seconds_played already accounts for
    //    its hardware audio path, so listeners hearing speakers will
    //    naturally match phone playback. Offset can still be used to
    //    deliberately bias if needed.
    //  - Path 2: typically positive — compensates for the buffer delay
    //    not reflected in trackStartedAtMs.
    //
    // Returns position in seconds. Caller decides what to do if value
    // is past the buffer duration (track ended).
    function getExpectedPosition() {
      const offsetSec = audioSyncOffsetMs / 1000;
      if (livePosition && livePosition.sequence === currentSequence) {
        // livePosition.updatedAt is a SERVER timestamp (Date.now() on
        // the server when FPP reported the position). To compute "how
        // long has it been since that update?" we have to express
        // current time on the same scale — i.e. server time. The
        // client's raw Date.now() is whatever its OS thinks the time
        // is, which can be off by hundreds of ms to several seconds
        // depending on the phone's NTP/cell-tower sync state. Two
        // phones with different clock biases here would see different
        // elapsed values and seek to different positions in the track,
        // producing exactly the constant phone-to-phone offset we're
        // trying to eliminate. clockOffset is computed by burst NTP-lite
        // on connect; adding it shifts client time onto server time.
        const serverNow = Date.now() + clockOffset;
        const elapsedSinceUpdate = (serverNow - livePosition.updatedAt) / 1000;
        return livePosition.position + elapsedSinceUpdate - offsetSec;
      }
      // Fallback: extrapolate from track-start anchor
      const serverNow = Date.now() + clockOffset;
      return (serverNow - trackStartedAtMs) / 1000 - offsetSec;
    }

    // ---- Schedule playback at sample-precise position ----
    function scheduleStart() {
      if (!currentBuffer || !audioCtx) return;
      stopAudio();

      // Where should we be in the track right now? Defer to
      // getExpectedPosition, which prefers live FPP-reported position
      // (speaker-accurate) and falls back to track-start extrapolation
      // (with offset applied) when no live position is available.
      const positionSec = getExpectedPosition();

      // If already past the end, skip — next sync will pick up new track
      if (positionSec >= currentBuffer.duration) {
        statusEl.textContent = 'Waiting for next track…';
        return;
      }

      // Schedule with small lead-in so we don't underrun
      const leadInSec = 0.05;
      const startWhen = audioCtx.currentTime + leadInSec;
      const startOffset = Math.max(0, positionSec + leadInSec);

      // Each source gets its own gain node so the crossfade correction
      // can ramp THIS source's volume independently. The main `gainNode`
      // (connected to destination) handles user mute/volume; this source
      // gain only handles sync transitions.
      const srcGain = audioCtx.createGain();
      srcGain.gain.value = 1;
      srcGain.connect(gainNode);

      const src = audioCtx.createBufferSource();
      src.buffer = currentBuffer;
      src.connect(srcGain);
      src.start(startWhen, startOffset);
      src.onended = () => {
        if (currentSource === src) { currentSource = null; setPlayIcon(false); }
      };
      currentSource = src;
      currentSourceGain = srcGain;
      // Reset crossfade throttle on fresh schedule — we're a new track,
      // any previous correction is irrelevant.
      lastCrossfadeAtCtx = 0;

      // Capture the drift-measurement anchors. Together with audioCtx.
      // currentTime at any later moment, these let updateDriftDisplay()
      // compute the actual playback position based on the AUDIO CLOCK
      // (which advances at exactly the rate of the audio output) rather
      // than wall time (which can drift relative to the audio clock,
      // especially on devices with crystal oscillator differences).
      trackScheduledAtAudioCtx = startWhen;
      trackScheduledAtPositionSec = startOffset;
      currentRate = 1.0;
      // Initialize integration counter — we've "played" startOffset seconds
      // into the file as of startWhen. Subsequent ticks accumulate from here.
      integratedPlayedSec = startOffset;
      lastIntegrationTime = startWhen;
      // outputLatency is the OS-reported delay between samples being
      // scheduled and samples actually leaving the speaker. We snapshot
      // it here so the drift display accounts for "what you HEAR now
      // was scheduled outputLatency seconds ago." Browsers without this
      // property fall back to baseLatency, then to 0.
      trackScheduledOutputLatency = (
        audioCtx.outputLatency
        || audioCtx.baseLatency
        || 0
      );

      // Mark when audio playback actually started. The watchPosition
      // grace period uses this to ignore the (frequently stale) first
      // watcher callback that fires immediately after audio begins.
      // Set on every track start — a multi-track session resets the
      // grace period each time, but that's fine since the user is by
      // definition still in range if a previous track played without
      // tripping the watcher.
      if (audioStartedAtMs === 0) audioStartedAtMs = Date.now();
      setPlayIcon(true);
      statusEl.textContent = '';
    }

    function stopAudio() {
      playGeneration++; // cancel any in-flight scheduled play
      fppStatus = null;
      smoothedDriftMs = 0;
      calibrationSamples = []; // recalibrate every song
      // Decoded buffers are kept: the cache holds only the current and next
      // songs (see pruneBufferCache), and handleTrackChange updates both.
      if (currentSource) {
        try { currentSource.stop(); } catch {}
        try { currentSource.disconnect(); } catch {}
        currentSource = null;
      }
      if (currentSourceGain) {
        try { currentSourceGain.disconnect(); } catch {}
        currentSourceGain = null;
      }
      if (htmlAudio && !htmlAudio._isWebAudio) {
        try { htmlAudio.pause(); } catch {}
        try { htmlAudio.src = ''; htmlAudio.load(); } catch {}
      }
      htmlAudio = null;
      currentBuffer = null;
      trackScheduledAtAudioCtx = 0;
      trackScheduledAtPositionSec = 0;
      currentRate = 1.0;
      trackScheduledOutputLatency = 0;
      lastAppliedRate = 1.0;
      driftHistory.length = 0;
      integratedPlayedSec = 0;
      lastIntegrationTime = 0;
      lastCrossfadeAtCtx = 0;
      lastReseekAtMs = 0;
      pendingPostStartCorrectionAtMs = 0;
      snapPendingUntilMs = 0;
      snapAnchorCtxTime = 0;
      snapAnchorPosSec = 0;
      smoothedDriftMs = 0;
    }

    // If the audio gate fires during playback (e.g. user walked outside the
    // radius and the next /api/visual-config poll reports blocked), stop audio
    // immediately. The launcher button is also hidden by applyAudioGateState.
    window.addEventListener('showpilot:audio-gate-blocked', () => {
      stopAudio();
      if (statusEl) statusEl.textContent = 'Audio paused — outside show range';
    });

    // ---- Drift display (real measurement) ----
    // Compares where audio is ACTUALLY playing (per the audio clock,
    // adjusted for output latency) to where it SHOULD be playing (per
    // server time). The difference is the real drift in milliseconds.
    //
    // Sign convention: positive = audio is AHEAD of server (audio came
    // out faster than expected); negative = audio is BEHIND (delayed).
    //
    // What this catches:
    //   - Initial sync error from asymmetric request/response latency
    //   - Audio clock drift over time (different oscillators)
    //   - Output latency that wasn't accounted for at scheduling
    //
    // What this does NOT catch:
    //   - Bluetooth/AirPods latency (hidden from the browser)
    //   - Receiver/DSP processing latency (downstream of OS audio)
    //   - Speaker physical placement delay (sound takes ~3ms per meter
    //     to travel — usually negligible, but two devices on opposite
    //     sides of a room can be 30-40ms apart just from physics)
    function updateDriftDisplay() {
      // HTML5 audio path: compare element's currentTime to expected.
      if (!htmlAudio || htmlAudio.paused || !currentSequence) {
        if (driftEl) driftEl.textContent = '';
        if (htmlAudio) htmlAudio.playbackRate = 1.0;
        return;
      }

      // ---- FPP position-based playbackRate correction ----
      // If we have a live FPP position from the daemon WebSocket, use it
      // to correct drift via playbackRate. This syncs phones to FPP's
      // actual speakers rather than to each other or to a computed position.
      if (fppStatus && fppStatus.positionSec > 0 && fppStatus.serverTimestamp) {
        // Calculate how stale this fppStatus reading is.
        // msg.serverTimestamp is server clock time when daemon sent it.
        // Converting to client time: clientEquivalent = serverTimestamp - clockOffset
        // Elapsed since then: Date.now() - clientEquivalent
        // Cap at 2s — don't extrapolate beyond that on very stale readings.
        const clientTimeOfUpdate = fppStatus.serverTimestamp - clockOffset;
        const msSinceFppUpdate = Math.min(Math.max(Date.now() - clientTimeOfUpdate, 0), 2000);
        const fppStatusAgeMs = Math.max(0, Date.now() - clientTimeOfUpdate); // uncapped, for freshness checks
        const fppPositionNow = fppStatus.positionSec + (msSinceFppUpdate / 1000) - (deviceOffset / 1000);

        // ---- Drift measurement ----
        // Primary: audio-clock-relative drift from snap anchor.
        // This is device-clock-free — both phones compute the same value
        // because they both anchored to the same syncPoint position.
        // Falls back to fppPositionNow when no snap anchor is set.
        // v0.33.202: the snap-anchor comparison that used to be here was
        // always 0 (both anchors were set from the same values at the same
        // moment), so nothing ever corrected an error left by the snap.
        // Drift is now what the listener HEARS (rendered position minus
        // output latency) against FPP's estimated position, the way
        // PulseMesh-style players do it. Device clock differences are
        // handled by clockOffset (syncClockBurst), not by avoiding FPP.
        const loopEst = estimateFppPosNow();
        const loopLatencySec = getOutputLatencySec();
        let drift, driftMs;
        if (loopEst) {
          const heardPos = htmlAudio.currentTime - loopLatencySec;
          const targetHeardPos = loopEst.pos
            - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000);
          drift = heardPos - targetHeardPos;
          driftMs = Math.round(drift * 1000);
        } else {
          // v0.33.213: measured like the primary path above (heard position,
          // output latency incl. the listener's timing offset, deviceOffset
          // with the same sign). It used to compare raw currentTime against
          // fppPositionNow (which SUBTRACTS deviceOffset), so any offset read
          // as drift here. Display only; corrections need loopEst.
          const heardPos = htmlAudio.currentTime - loopLatencySec;
          const fallbackPos = fppStatus.positionSec + (msSinceFppUpdate / 1000);
          drift = heardPos - (fallbackPos - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000));
          driftMs = Math.round(drift * 1000);
        }

        // ---- Fast calibration ----
        // Measure audioPos - fppPos starting 3s after the follow-up crossfade
        // (audioStartedAtMs is reset there). Take 5 samples, use median.
        // Applied to snapPos on the NEXT song — automatically corrects the
        // fixed speaker offset without manual tuning.
        // Recalibrates every song so it adapts to changing conditions.
        const rawFppPositionNow = fppStatus.positionSec + (msSinceFppUpdate / 1000);
        const rawDriftMs = Math.round((htmlAudio.currentTime - rawFppPositionNow) * 1000);
        const playingForMs = Date.now() - audioStartedAtMs;
        const isCalibrated = calibrationSamples.length >= 5;
        // v0.33.202: disabled (see note where sp_device_offset is cleared).
        if (false && !isCalibrated && playingForMs > 3000 && fppStatusAgeMs < 300) {
          calibrationSamples.push(rawDriftMs);
          if (calibrationSamples.length === 5) {
            const sorted = [...calibrationSamples].sort((a, b) => a - b);
            const median = sorted[2]; // middle of 5
            // Sanity check — ignore wildly implausible values
            if (Math.abs(median) < 1000) {
              deviceOffset = median;
              try {
                localStorage.setItem('sp_device_offset', median.toString());
                console.log('[ShowPilot] device offset calibrated:', median, 'ms (5-sample fast cal)');
              } catch (_) {}
            }
          }
        }

        // Smooth the drift measurement to prevent oscillation from 500ms
        // FIFO update jitter. α=0.6 responds quickly while filtering noise.
        // Only estimate-based readings feed the value corrections act on
        // (v0.33.213): a fallback reading must not leak into the first
        // correction after estimates return.
        if (loopEst) smoothedDriftMs = smoothedDriftMs * 0.4 + driftMs * 0.6;
        const correctionDriftMs = Math.round(smoothedDriftMs);

        if (driftEl) {
          const absMs = Math.abs(driftMs);
          const syncPtShort = htmlAudio._syncPointTs ? String(htmlAudio._syncPointTs).slice(-6) : 'none';
          driftEl.textContent = '· ' + (driftMs >= 0 ? '+' : '') + driftMs + 'ms' +
            (htmlAudio._seekedTo ? ' [s:' + htmlAudio._seekedTo.toFixed(1) + ']' : '') +
            ' [sp:' + syncPtShort + ']';
          driftEl.style.color = absMs < 150 ? '#4ade80' : (absMs < 500 ? '#fb923c' : '#ef4444');
        }

        if (debugEl) {
          const propagationMs = Math.round(Date.now() - clientTimeOfUpdate);
          debugEl.textContent = [
            `drift:       ${driftMs >= 0 ? '+' : ''}${driftMs}ms`,
            `engine:      ${htmlAudio._isWebAudio ? 'WebAudio' : 'HTML5'}`,
            `fppPos:      ${fppPositionNow.toFixed(3)}s`,
            `audioPos:    ${htmlAudio.currentTime.toFixed(3)}s`,
            `staleness:   ${msSinceFppUpdate}ms`,
            `propagation: ${propagationMs}ms`,
            `clockOffset: ${Math.round(clockOffset)}ms`,
            `seekedTo:    ${(htmlAudio._seekedTo || 0).toFixed(3)}s`,
            `seekFppTs:   ${htmlAudio._seekFppTs || 'none'}`,
            `syncPtTs:    ${htmlAudio._syncPointTs || 'none'}`,
            `deviceOff:   ${Math.round(deviceOffset)}ms (${calibrationSamples.length}/5)`,
            `hwLatency:   ${hardwareLatencyMs}ms`,
            `speed:       ${((currentRate - 1) * 100).toFixed(2)}%`,
            ...probeLines(),
          ].join('\n');
        }

        // ---- PLL: correct drift via playbackRate ----
        // Nudge playbackRate to pull audio toward FPP's position.
        // Uses a proportional controller that tapers correction as drift
        // approaches zero — prevents overshoot.
        // Max rate: ±0.5% (5ms/s correction). Slow but inaudible.
        // Dead zone: < 20ms — reset to 1.0, not worth correcting.
        // Large drift (> 500ms): snap via re-seek.
        // Don't correct within 3s of a snap — let the new source settle first.
        // ---- Crossfade drift correction (PulseMesh-style) ----
        // Only fires when fppStatus is fresh (< 200ms stale) — stale readings
        // produce inaccurate targets and cause the correction to overshoot.
        // v0.33.204: two-tier correction.
        //  - |drift| > JUMP_THRESHOLD_MS: equal-power crossfade jump (rare —
        //    bad start, FPP seek), 10s cooldown.
        //  - otherwise: proportional speed nudge, ±0.5% max, back to 1.0
        //    inside the deadband. At the cap a 50ms error closes in ~10s,
        //    far slower than the ~0.5s measurement smoothing, so the loop
        //    can't overshoot or oscillate.
        const CROSSFADE_COOLDOWN_MS = 10000;
        const msSinceLastCrossfade = lastCrossfadeAtCtx > 0
          ? (audioCtx.currentTime - lastCrossfadeAtCtx) * 1000 : Infinity;
        const canCorrect = Date.now() > snapPendingUntilMs &&
          loopEst && loopEst.n >= 3 && loopEst.newestAgeMs < 1500 &&
          currentBuffer && currentSource && currentSourceGain;

        if (!canCorrect) {
          // No trustworthy reference right now: don't keep nudging blindly.
          if (currentRate !== 1.0 && currentSource) setSourceRate(1.0);
        } else if (Math.abs(correctionDriftMs) > JUMP_THRESHOLD_MS) {
          if (msSinceLastCrossfade > CROSSFADE_COOLDOWN_MS) {
            const targetPos = loopEst.pos
              - (audioSyncOffsetMs / 1000) + (deviceOffset / 1000)
              + loopLatencySec;
            console.log('[ShowPilot] crossfade correction: drift', correctionDriftMs + 'ms →',
              targetPos.toFixed(3) + 's (' + loopEst.n + ' readings, newest ' + Math.round(loopEst.newestAgeMs) + 'ms old)');
            if (crossfadeTo(targetPos)) {
              smoothedDriftMs = 0;
              lastAppliedRate = 1.0;
            }
          }
        } else {
          let targetRate = 1.0;
          if (Math.abs(correctionDriftMs) > RATE_DEADBAND_MS) {
            // Ahead (positive drift) → slow down; behind → speed up.
            const dev = Math.max(-RATE_MAX_DEV, Math.min(RATE_MAX_DEV,
              -(correctionDriftMs / 1000) * RATE_GAIN));
            targetRate = 1.0 + dev;
          }
          // Only touch the AudioParam when the change is meaningful.
          if (Math.abs(targetRate - currentRate) >= 0.0005 ||
              (targetRate === 1.0 && currentRate !== 1.0)) {
            setSourceRate(targetRate);
            lastAppliedRate = targetRate;
          }
        }
        return;
      }

      // Fallback: use computed expected position when no FPP position available
      const actualPosition = htmlAudio.currentTime;
      const expectedPosition = getExpectedPosition();
      const drift = actualPosition - expectedPosition;
      const ms = Math.round(drift * 1000);
      if (driftEl) {
        driftEl.textContent = '· ' + (ms >= 0 ? '+' : '') + ms + 'ms';
        const absMs = Math.abs(ms);
        driftEl.style.color = absMs < 100 ? '#4ade80' : (absMs < 500 ? '#fb923c' : '#ef4444');
      }

      // Skip all seek-based corrections when fppStatus is available.
      // playbackRate correction handles drift continuously and accurately.
      // Seek corrections fight the playbackRate loop and cause audible skipping.
      if (fppStatus) return;

      // ---- One-shot post-start correction (v0.27.0, median-of-3 in v0.28.2) ----
      // Fires once, ~1s after .play() was called for the current track.
      // This is the moment of truth for multi-phone sync: the browser's
      // .play() startup latency has had time to settle, so the drift we
      // measure now reflects per-device startup error (the dominant
      // cause of phones being out of sync with each other and with the
      // show speakers). We snap-correct it in one move — no rolling
      // average, no throttle, tighter threshold than the long-tail loop.
      //
      // Median of 3 samples taken 25ms apart (v0.28.2): a single sample
      // can be biased by event-loop lag, momentary clock-sync glitches,
      // or jitter on the position-update channel — all amplified on
      // cellular. Median of 3 is robust to one outlier sample without
      // adding meaningful latency. The whole sampling window is ~50ms,
      // imperceptible.
      if (pendingPostStartCorrectionAtMs > 0 && Date.now() >= pendingPostStartCorrectionAtMs) {
        pendingPostStartCorrectionAtMs = 0;

        // Skip post-start correction when we have live FPP position from the
        // daemon WebSocket — playbackRate correction handles drift continuously
        // and more accurately. The seek snap would fight the playbackRate loop.
        if (!useRelay && !fppStatus) {
        const POST_START_THRESHOLD_MS = 80;
        // Capture the audio element handle so a stopAudio()/track-change
        // mid-sampling doesn't snap a stale element. If htmlAudio gets
        // reassigned during the 50ms window, we abort the snap.
        const audioForCorrection = htmlAudio;
        (async () => {
          const samples = [];
          for (let i = 0; i < 3; i++) {
            if (htmlAudio !== audioForCorrection) return; // track changed mid-sample, abort
            samples.push(audioForCorrection.currentTime - getExpectedPosition());
            if (i < 2) await new Promise(r => setTimeout(r, 25));
          }
          if (htmlAudio !== audioForCorrection) return; // track changed before snap, abort
          samples.sort((a, b) => a - b);
          const medianDrift = samples[1]; // middle of 3
          const medianMs = Math.round(medianDrift * 1000);
          if (Math.abs(medianMs) >= POST_START_THRESHOLD_MS) {
            const target = audioForCorrection.currentTime - medianDrift;
            if (target >= 0 && (!audioForCorrection.duration || target < audioForCorrection.duration - 0.1)) {
              try {
                audioForCorrection.currentTime = target;
                // Reset rolling history — the snap invalidated whatever
                // samples we had, and we want clean measurements going
                // forward for the long-tail loop.
                driftHistory.length = 0;
                // Update lastReseekAtMs so the long-tail loop respects its
                // own throttle relative to this snap (no double-correcting
                // a few seconds later).
                lastReseekAtMs = Date.now();
                if (typeof console !== 'undefined' && console.info) {
                  console.info('[ShowPilot] post-start correction:',
                    'startup error', medianMs, 'ms (median of 3),',
                    'samples', samples.map(s => Math.round(s * 1000) + 'ms').join(','),
                    'snapped to', target.toFixed(3), 's');
                }
              } catch (err) {
                console.warn('[ShowPilot] post-start correction failed:', err);
              }
            }
          }
        })();
        } // end !useRelay
      }

      // ---- Auto-correction via re-seek ----
      // HTML5 audio doesn't support smooth crossfade between sources
      // the way Web Audio did. The simplest correction is to set
      // currentTime directly when drift exceeds a generous threshold.
      // This produces a tiny audible blip (browser handles a brief
      // re-buffer) but it's preferable to letting drift accumulate.
      //
      // Skipped in relay mode — the relay delivers the same live bytes
      // to all listeners, seeking would break the stream.
      //
      // Tolerance is more generous than the Web Audio version because:
      // (1) every re-seek is audibly noticeable as a small pop, and
      // (2) HTML5 audio plays at native rate without rate jitter, so
      // small drift values tend to stay small instead of growing. We
      // expect this to fire rarely — mostly on track-start before live
      // position has been received, or after device sleep.
      driftHistory.push(drift);
      if (driftHistory.length > DRIFT_HISTORY_SIZE) driftHistory.shift();
      if (useRelay) return; // relay mode — no seeking, sync is automatic
      if (driftHistory.length < DRIFT_HISTORY_SIZE) return;

      const avgDrift = driftHistory.reduce((a, b) => a + b, 0) / driftHistory.length;
      const avgDriftMs = Math.abs(avgDrift) * 1000;
      const RESEEK_THRESHOLD_MS = 500;
      if (avgDriftMs < RESEEK_THRESHOLD_MS) return;

      // Throttle: don't re-seek more than once every 8 seconds.
      const RESEEK_THROTTLE_SEC = 8;
      const nowMs = Date.now();
      if (lastReseekAtMs > 0 && (nowMs - lastReseekAtMs) < RESEEK_THROTTLE_SEC * 1000) return;

      // Don't seek past end of track.
      if (htmlAudio.duration && expectedPosition >= htmlAudio.duration - 0.1) return;
      if (expectedPosition < 0) return;

      try {
        htmlAudio.currentTime = expectedPosition;
        lastReseekAtMs = nowMs;
        driftHistory.length = 0;
        if (typeof console !== 'undefined' && console.info) {
          console.info('[ShowPilot] sync correction (re-seek):',
            'drift was', Math.round(avgDriftMs), 'ms,',
            'snapped to', expectedPosition.toFixed(3), 's');
        }
      } catch (err) {
        console.warn('[ShowPilot] re-seek failed:', err);
      }
    }

    // ---- Player decoration ----
    let currentDecoration = null;
    let currentDecorationAnimated = null;
    let currentCustomColor = null;
    let decoLayer = null;

    function applyDecoration(theme, animated, customColor) {
      theme = theme || 'none';
      animated = (animated !== false);
      const customColorKey = customColor || '';
      if (theme === currentDecoration && animated === currentDecorationAnimated && customColorKey === currentCustomColor) return;
      currentDecoration = theme;
      currentDecorationAnimated = animated;
      currentCustomColor = customColorKey;

      // Update panel theme class — strip all existing of-theme-* and add new one
      panel.className = panel.className.split(/\s+/)
        .filter(c => !c.startsWith('of-theme-'))
        .join(' ').trim();
      // Clear any prior inline background overrides
      panel.style.removeProperty('background');
      panel.style.removeProperty('background-image');
      panel.style.removeProperty('background-color');
      if (theme !== 'none') {
        panel.classList.add('of-theme-' + theme);
      } else if (customColorKey) {
        // Custom color when no theme — must use !important to beat the CSS rule's !important.
        // Value is either a hex like "#1a1a2e" OR a CSS gradient like "linear-gradient(...)".
        // background-color only takes solid colors; gradients go in background-image.
        const isGradient = customColorKey.indexOf('gradient') >= 0;
        if (isGradient) {
          panel.style.setProperty('background-color', 'transparent', 'important');
          panel.style.setProperty('background-image', customColorKey, 'important');
        } else {
          panel.style.setProperty('background-image', 'none', 'important');
          panel.style.setProperty('background-color', customColorKey, 'important');
        }
      }
      // (else: leave defaults, base CSS rule applies)
      // v0.33.207: lets the song progress bar pick up the new theme color.
      try { window.dispatchEvent(new CustomEvent('showpilot:player-theme', { detail: { theme } })); } catch {}

      // Create overlay layer if missing.
      // Lives INSIDE the player bar (top:0, left:0, full width/height) so the
      // colored player background gives decorations contrast. overflow:visible
      // so animations like falling leaves can spill below the player edge.
      if (!decoLayer) {
        decoLayer = document.createElement('div');
        decoLayer.id = 'of-deco';
        decoLayer.style.cssText = `
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none; overflow: visible;
          z-index: 0;
        `;
        panel.style.position = panel.style.position || 'fixed';
        panel.style.overflow = 'visible';
        // Insert decoration as the FIRST child so player content sits on top
        panel.insertBefore(decoLayer, panel.firstChild);
      }

      // Honor user's prefers-reduced-motion at OS level
      const prefersReduced = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animate = animated && !prefersReduced;

      decoLayer.innerHTML = renderDecoration(theme, animate);
      // Reset panel padding-top in case previous decoration needed extra room
      panel.style.paddingTop = (theme === 'none') ? '12px' : '20px';

      // ---- Toast/banner theme inheritance (v0.24.4+) ----
      // Make the winner toast match the player's color palette by mapping
      // the player's CSS variables (--of-bg, --of-border, --of-glow) onto
      // the toast's variables (--showpilot-toast-*). Templates that set
      // their own --showpilot-toast-* vars in their CSS still win because
      // we only fill values that aren't already template-set.
      //
      // requestAnimationFrame waits one frame so the panel's computed
      // styles reflect the just-applied class change. Reading them
      // synchronously here would return the OLD theme's values.
      requestAnimationFrame(applyPlayerThemeToToast);
    }

    // Read the player panel's computed theme variables and propagate them
    // to the toast/banner CSS variables on :root. Idempotent — safe to call
    // multiple times. Only sets a toast variable if (a) the player has a
    // value for it AND (b) the toast variable isn't already set by the
    // template's own stylesheet (we check inline-style only, since
    // template-set values in stylesheets have lower specificity than
    // root.style and would get overridden silently if we always wrote).
    function applyPlayerThemeToToast() {
      try {
        const root = document.documentElement;
        const panelEl = document.getElementById('of-listen-panel');
        if (!panelEl) return;
        const cs = getComputedStyle(panelEl);

        // For custom solid/gradient colors (no theme class), the panel
        // has inline background-image/background-color rather than the
        // theme's --of-bg. Use whichever is actually rendering.
        const ofBg = (cs.getPropertyValue('--of-bg') || '').trim();
        const inlineImg = (panelEl.style.backgroundImage || '').trim();
        const inlineColor = (panelEl.style.backgroundColor || '').trim();
        const effectiveBg = inlineImg && inlineImg !== 'none'
          ? inlineImg
          : (inlineColor && inlineColor !== 'transparent' ? inlineColor : ofBg);

        const ofBorder = (cs.getPropertyValue('--of-border') || '').trim();
        const ofGlow = (cs.getPropertyValue('--of-glow') || '').trim();

        // Helper — set a toast var only if we have a player value AND
        // the user hasn't already explicitly set it (via inline root style).
        // Template-set CSS rules are NOT inline — they have lower
        // specificity and root.style overrides them, which is what we want
        // unless the template explicitly opted into theme-matching by
        // leaving the var unset. (Templates wanting custom colors should
        // use !important in their CSS to win against this.)
        const setIfPlayerHasValue = (varName, value) => {
          if (!value) return;
          root.style.setProperty(varName, value);
        };
        setIfPlayerHasValue('--showpilot-toast-bg', effectiveBg);
        setIfPlayerHasValue('--showpilot-toast-border', ofBorder);
        setIfPlayerHasValue('--showpilot-toast-accent', ofGlow);
      } catch (e) {
        // Non-fatal — toast just stays default-themed
      }
    }
    // Expose for the winner toast script (injected separately) so it can
    // re-apply on each toast render in case the theme changed since the
    // last appearance.
    window.ShowPilotApplyPlayerThemeToToast = applyPlayerThemeToToast;

    // ---- Player decorations (v0.33.224 redesign) ----
    // Each theme returns HTML (with its own <style>) for the decoration layer
    // (#of-deco) inside the Listen-on-Phone player. Design rules:
    // - Things that fly or perch (bats, pumpkins, fireworks, menorah, eggs)
    //   live on/above the player's top edge, never over its controls or text.
    // - Only transform/opacity are animated (cheap on phones); no animated
    //   filters.
    // - Every element gets its own timing/size/path (seeded, so it's the same
    //   on every load), and each theme also looks deliberate when static
    //   (animations off or prefers-reduced-motion).
    function renderDecoration(theme, animate) {
      const A = animate ? ' ofd-anim' : '';
      switch (theme) {
        case 'christmas':    return decoChristmas(A);
        case 'halloween':    return decoHalloween(A);
        case 'easter':       return decoEaster(A);
        case 'stpatricks':   return decoStPatricks(A);
        case 'independence': return decoIndependence(A);
        case 'valentines':   return decoValentines(A);
        case 'hanukkah':     return decoHanukkah(A);
        case 'thanksgiving': return decoThanksgiving(A);
        case 'snow':         return decoSnow(A);
        case 'newyear':      return decoNewYear(A);
        case 'dayofthedead': return decoDayOfDead(A);
        case 'diwali':       return decoDiwali(A);
        case 'kwanzaa':      return decoKwanzaa(A);
        case 'lunarnewyear': return decoLunarNewYear(A);
        case 'mardigras':    return decoMardiGras(A);
        default:             return '';
      }
    }

    // Deterministic pseudo-random (same layout every load).
    function decoRand(seed) {
      let s = seed >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }
    const decoBase = `
      #of-deco .ofd { position:absolute; pointer-events:none; }
      #of-deco .ofd svg { display:block; overflow:visible; }
    `;

    // ---------- Christmas: C9 bulbs on a scalloped green wire ----------
    function decoChristmas(A) {
      const N = 16;
      const palette = [
        ['#ff3b3b', '#b91c1c'], ['#22c55e', '#15803d'], ['#3b82f6', '#1d4ed8'],
        ['#ff9f1a', '#c2410c'], ['#ffe14d', '#ca8a04'],
      ];
      const r = decoRand(12);
      let wire = '';
      for (let i = 0; i < N; i++) {
        const x0 = (i / N) * 1000, x1 = ((i + 1) / N) * 1000;
        wire += `${i ? '' : 'M' + x0 + ',3 '}Q${(x0 + x1) / 2},20 ${x1},3 `;
      }
      let clips = '', bulbs = '';
      for (let i = 0; i <= N; i++) clips += `<circle cx="${(i / N) * 1000}" cy="3" r="2.2"/>`;
      for (let i = 0; i < N; i++) {
        const [hi, lo] = palette[i % palette.length];
        const dur = (2.6 + r() * 3.4).toFixed(2);
        const delay = (-r() * 6).toFixed(2);
        const twinkle = (i % 5 === 2) ? ' ofd-twinkle' : '';
        const tilt = ((r() - 0.5) * 16).toFixed(1);
        bulbs += `
          <div class="ofd ofd-bulb${A}${twinkle}" style="left:${((i + 0.5) / N) * 100}%;--c:${hi};--dur:${dur}s;--delay:${delay}s;transform:translateX(-50%) rotate(${tilt}deg)">
            <div class="ofd-halo"></div>
            <svg viewBox="0 0 20 36" width="15" height="27" aria-hidden="true">
              <defs><linearGradient id="ofdB${i}" x1="0" x2="1">
                <stop offset="0" stop-color="${lo}"/><stop offset=".45" stop-color="${hi}"/><stop offset="1" stop-color="${lo}"/>
              </linearGradient></defs>
              <rect x="6.5" y="0" width="7" height="8" rx="1.2" fill="#166534"/>
              <rect x="6.5" y="1.5" width="7" height="1" fill="#14532d"/>
              <rect x="6.5" y="4" width="7" height="1" fill="#14532d"/>
              <path d="M4,11 C4,8.5 16,8.5 16,11 C18.5,18 14,27 10,35 C6,27 1.5,18 4,11 Z" fill="url(#ofdB${i})"/>
              <path d="M6.2,12 C6,17 7.2,23 8.8,28" stroke="rgba(255,255,255,.55)" stroke-width="1.3" fill="none" stroke-linecap="round"/>
              <path class="ofd-hot" d="M4,11 C4,8.5 16,8.5 16,11 C18.5,18 14,27 10,35 C6,27 1.5,18 4,11 Z" fill="#fff"/>
            </svg>
          </div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-wire { left:0; right:0; top:0; height:24px; width:100%; }
        #of-deco .ofd-bulb { top:9px; }
        #of-deco .ofd-bulb .ofd-halo { position:absolute; left:50%; top:62%; width:34px; height:34px; margin:-17px 0 0 -17px;
          border-radius:50%; background: radial-gradient(circle, var(--c) 0%, transparent 68%); opacity:.55; }
        #of-deco .ofd-bulb .ofd-hot { opacity:.18; }
        #of-deco .ofd-bulb.ofd-anim .ofd-halo { animation: ofdGlow var(--dur) ease-in-out var(--delay) infinite alternate; }
        #of-deco .ofd-bulb.ofd-anim .ofd-hot  { animation: ofdHot  var(--dur) ease-in-out var(--delay) infinite alternate; }
        #of-deco .ofd-bulb.ofd-twinkle.ofd-anim .ofd-halo, #of-deco .ofd-bulb.ofd-twinkle.ofd-anim .ofd-hot { animation-name: ofdTwinkle; animation-direction: normal; animation-duration: calc(var(--dur) * 1.6); }
        @keyframes ofdGlow { from { opacity:.38; transform:scale(.85); } to { opacity:.75; transform:scale(1.08); } }
        @keyframes ofdHot  { from { opacity:.08; } to { opacity:.28; } }
        @keyframes ofdTwinkle { 0%,55%,100% { opacity:.6; } 65% { opacity:.05; } 72% { opacity:.7; } 80% { opacity:.12; } 88% { opacity:.65; } }
      </style>
      <svg class="ofd ofd-wire" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
        <path d="${wire}" fill="none" stroke="#14532d" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
        <path d="${wire}" fill="none" stroke="rgba(134,239,172,.25)" stroke-width=".8" vector-effect="non-scaling-stroke" transform="translate(0,-.6)"/>
        <g fill="#0f3d21">${clips}</g>
      </svg>
      ${bulbs}`;
    }

    // ---------- Halloween: realistic bats + perched jack-o'-lanterns ----------
    function decoBatSvg(id) {
      // viewBox 0 0 100 60; shoulders at (46,26) and (54,26).
      const wingR = 'M54,25 L70,15 Q77,11 83,14 L99,23 Q91,27 89,37 Q82,33 75,41 Q68,36 57,38 Q55,33 54,25 Z';
      const bonesR = 'M70,15 L89,37 M70,15 L75,41 M70,15 L99,23 M63,20 L57,38';
      const mirror = (d) => d.replace(/(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g, (m, x, y) => (100 - parseFloat(x)) + ',' + y);
      const wingL = mirror(wingR), bonesL = mirror(bonesR);
      return `
        <svg viewBox="0 0 100 60" aria-hidden="true">
          <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#2a1f33"/><stop offset="1" stop-color="#0c0810"/>
          </linearGradient></defs>
          <g class="ofd-bat-body">
            <g class="ofd-wing ofd-wing-l">
              <path d="${wingL}" fill="url(#${id})"/>
              <path d="${bonesL}" stroke="#3b2d47" stroke-width=".9" fill="none" stroke-linecap="round"/>
              <path d="M30,15 l-2,-3 l3,1 Z" fill="#0c0810"/>
            </g>
            <g class="ofd-wing ofd-wing-r">
              <path d="${wingR}" fill="url(#${id})"/>
              <path d="${bonesR}" stroke="#3b2d47" stroke-width=".9" fill="none" stroke-linecap="round"/>
              <path d="M70,15 l2,-3 l-3,1 Z" fill="#0c0810"/>
            </g>
            <path d="M50,20 C55,20 56.5,26 55.5,32 C54.8,38 52,43 50,44 C48,43 45.2,38 44.5,32 C43.5,26 45,20 50,20 Z" fill="#1c1422"/>
            <path d="M46.2,21.5 L44.8,14.5 L48.6,19.6 Z M53.8,21.5 L55.2,14.5 L51.4,19.6 Z" fill="#1c1422"/>
            <circle cx="48.3" cy="23.2" r=".75" fill="#f59e0b" opacity=".85"/>
            <circle cx="51.7" cy="23.2" r=".75" fill="#f59e0b" opacity=".85"/>
            <path d="M47.5,43 L46,48 M52.5,43 L54,48" stroke="#1c1422" stroke-width="1.3" stroke-linecap="round"/>
          </g>
        </svg>`;
    }
    function decoPumpkinSvg(id) {
      return `
        <svg viewBox="0 0 60 48" aria-hidden="true">
          <defs>
            <radialGradient id="${id}" cx="45%" cy="38%" r="65%">
              <stop offset="0" stop-color="#ffb347"/><stop offset=".55" stop-color="#f06d0e"/><stop offset="1" stop-color="#9a3406"/>
            </radialGradient>
            <radialGradient id="${id}g" cx="50%" cy="55%" r="60%">
              <stop offset="0" stop-color="#fff7c2"/><stop offset=".45" stop-color="#ffd23f"/><stop offset="1" stop-color="#ff8c00"/>
            </radialGradient>
          </defs>
          <path d="M29,9 C28,4 30,1 34,0.5 C33,3 32,6 32.5,9 Z" fill="#4d5d2a"/>
          <path d="M33,4 C37,2 41,3 42,6" stroke="#5c7a2e" stroke-width="1.2" fill="none" stroke-linecap="round"/>
          <ellipse cx="14" cy="28" rx="12" ry="17" fill="url(#${id})"/>
          <ellipse cx="46" cy="28" rx="12" ry="17" fill="url(#${id})"/>
          <ellipse cx="22" cy="28" rx="11" ry="19" fill="url(#${id})"/>
          <ellipse cx="38" cy="28" rx="11" ry="19" fill="url(#${id})"/>
          <ellipse cx="30" cy="28" rx="10" ry="19.5" fill="url(#${id})"/>
          <path d="M22,11 C19,20 19,37 22,46 M38,11 C41,20 41,37 38,46 M14,12 C9,20 9,37 14,45 M46,12 C51,20 51,37 46,45" stroke="rgba(110,35,0,.45)" stroke-width="1" fill="none"/>
          <g class="ofd-carve" fill="url(#${id}g)">
            <path d="M17,22 L24,21 L21,15 Z"/>
            <path d="M43,22 L36,21 L39,15 Z"/>
            <path d="M28.2,27 L31.8,27 L30,24 Z"/>
            <path d="M14,31 C19,39 41,39 46,31 L42,32 L40,35 L37,32.5 L34,36 L31,33 L28,36.5 L25,33 L22,35.5 L19.5,32.5 Z"/>
          </g>
        </svg>`;
    }
    function decoHalloween(A) {
      const r = decoRand(31);
      const bats = [
        { top: -44, size: 58, dur: 13, dir: 'ltr', flap: .19, glide: true },
        { top: -30, size: 40, dur: 17, dir: 'rtl', flap: .16, glide: false },
        { top: -58, size: 32, dur: 21, dir: 'ltr', flap: .15, glide: true },
        { top: -22, size: 48, dur: 15, dir: 'rtl', flap: .18, glide: true },
      ];
      let html = '';
      bats.forEach((b, i) => {
        const far = b.size < 42 ? `opacity:${b.size < 36 ? .7 : .85};` : '';
        html += `
          <div class="ofd ofd-bat ${b.dir}${A}" style="top:${b.top}px;--dur:${b.dur}s;--delay:${(-r() * b.dur).toFixed(2)}s;${far}${A ? '' : `left:${14 + i * 22}%;`}">
            <div class="ofd-bat-bob" style="--bob:${(2.1 + r() * 1.4).toFixed(2)}s">
              <div class="ofd-bat-flap ${b.glide ? 'glide' : ''}" style="width:${b.size}px;height:${(b.size * .6).toFixed(0)}px;--flap:${b.flap}s;--cycle:${(b.flap * 7).toFixed(2)}s">
                ${decoBatSvg('ofdBat' + i)}
              </div>
            </div>
          </div>`;
      });
      html += `
        <div class="ofd ofd-pumpkin${A}" style="left:10px;width:46px;--fl:1.7s">${decoPumpkinSvg('ofdPk1')}</div>
        <div class="ofd ofd-pumpkin${A}" style="right:12px;width:36px;--fl:2.3s">${decoPumpkinSvg('ofdPk2')}</div>`;
      return `<style>${decoBase}
        #of-deco .ofd-bat { left:0; }
        #of-deco .ofd-bat.rtl .ofd-bat-flap { transform: scaleX(-1); }
        #of-deco .ofd-bat.ofd-anim.ltr { animation: ofdBatL var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-bat.ofd-anim.rtl { animation: ofdBatR var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-bat.ofd-anim .ofd-bat-bob { animation: ofdBatBob var(--bob) ease-in-out infinite alternate; }
        #of-deco .ofd-bat-flap svg { width:100%; height:100%; }
        #of-deco .ofd-bat .ofd-wing { transform-box: view-box; }
        #of-deco .ofd-bat .ofd-wing-l { transform-origin: 46px 25px; transform: rotate(8deg); }
        #of-deco .ofd-bat .ofd-wing-r { transform-origin: 54px 25px; transform: rotate(-8deg); }
        #of-deco .ofd-bat.ofd-anim .ofd-wing-l { animation: ofdFlapL var(--flap) cubic-bezier(.45,0,.55,1) infinite; }
        #of-deco .ofd-bat.ofd-anim .ofd-wing-r { animation: ofdFlapR var(--flap) cubic-bezier(.45,0,.55,1) infinite; }
        #of-deco .ofd-bat.ofd-anim .ofd-bat-body { transform-box: view-box; animation: ofdLift var(--flap) ease-in-out infinite; }
        #of-deco .ofd-bat.ofd-anim .glide .ofd-wing-l { animation: ofdGlideL var(--cycle) linear infinite; }
        #of-deco .ofd-bat.ofd-anim .glide .ofd-wing-r { animation: ofdGlideR var(--cycle) linear infinite; }
        #of-deco .ofd-bat.ofd-anim .glide .ofd-bat-body { animation: ofdGlideLift var(--cycle) linear infinite; }
        /* Quick downstroke (0-38%), slower upstroke. Up = wing tips raised. */
        @keyframes ofdFlapR { 0% { transform: rotate(-38deg); } 38% { transform: rotate(30deg) scaleY(.92); } 100% { transform: rotate(-38deg); } }
        @keyframes ofdFlapL { 0% { transform: rotate(38deg); }  38% { transform: rotate(-30deg) scaleY(.92); } 100% { transform: rotate(38deg); } }
        @keyframes ofdLift  { 0%,100% { transform: translateY(1.5px); } 45% { transform: translateY(-2px); } }
        /* Four flaps, then a short glide with wings held slightly raised. */
        @keyframes ofdGlideR {
          0% { transform: rotate(-38deg); } 8% { transform: rotate(30deg); } 15% { transform: rotate(-38deg); }
          23% { transform: rotate(30deg); } 30% { transform: rotate(-38deg); } 38% { transform: rotate(30deg); }
          45% { transform: rotate(-38deg); } 53% { transform: rotate(30deg); } 60% { transform: rotate(-12deg); }
          95% { transform: rotate(-10deg); } 100% { transform: rotate(-38deg); } }
        @keyframes ofdGlideL {
          0% { transform: rotate(38deg); } 8% { transform: rotate(-30deg); } 15% { transform: rotate(38deg); }
          23% { transform: rotate(-30deg); } 30% { transform: rotate(38deg); } 38% { transform: rotate(-30deg); }
          45% { transform: rotate(38deg); } 53% { transform: rotate(-30deg); } 60% { transform: rotate(12deg); }
          95% { transform: rotate(10deg); } 100% { transform: rotate(38deg); } }
        @keyframes ofdGlideLift { 0%,60% { transform: translateY(0); } 80% { transform: translateY(2.5px); } 100% { transform: translateY(0); } }
        @keyframes ofdBatL { from { transform: translateX(-90px); } to { transform: translateX(calc(100vw + 90px)); } }
        @keyframes ofdBatR { from { transform: translateX(calc(100vw + 90px)); } to { transform: translateX(-90px); } }
        @keyframes ofdBatBob {
          0% { transform: translateY(0) rotate(-3deg); } 30% { transform: translateY(-9px) rotate(4deg); }
          55% { transform: translateY(4px) rotate(-5deg); } 80% { transform: translateY(-5px) rotate(2deg); } 100% { transform: translateY(6px) rotate(-2deg); } }
        #of-deco .ofd-pumpkin { bottom:100%; margin-bottom:-6px; }
        #of-deco .ofd-pumpkin svg { width:100%; height:auto; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
        #of-deco .ofd-pumpkin.ofd-anim .ofd-carve { animation: ofdFlicker var(--fl) steps(1) infinite; }
        @keyframes ofdFlicker { 0% { opacity:1; } 12% { opacity:.78; } 19% { opacity:.96; } 41% { opacity:.84; } 47% { opacity:1; } 68% { opacity:.72; } 74% { opacity:.93; } 90% { opacity:.86; } }
      </style>${html}`;
    }

    // ---------- Snow: crystal flakes drifting down + a snow cap ----------
    function decoFlakeSvg(arms) {
      let d = '';
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3, c = Math.cos(a), s = Math.sin(a);
        const pt = (x, y) => `${(10 + x * c - y * s).toFixed(2)},${(10 + x * s + y * c).toFixed(2)}`;
        d += `M${pt(0, 0)} L${pt(9, 0)} M${pt(5, 0)} L${pt(7.2, arms)} M${pt(5, 0)} L${pt(7.2, -arms)} `;
      }
      return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${d}" stroke="#fff" stroke-width="1.1" stroke-linecap="round" fill="none"/></svg>`;
    }
    function decoSnow(A) {
      const r = decoRand(7);
      let flakes = '';
      for (let i = 0; i < 14; i++) {
        const size = 7 + Math.round(r() * 9);
        flakes += `
          <div class="ofd ofd-flake${A}" style="left:${(3 + r() * 94).toFixed(1)}%;${A ? '' : `top:${(12 + r() * 50).toFixed(0)}%;`}width:${size}px;height:${size}px;--dur:${(7 + r() * 7).toFixed(2)}s;--delay:${(-r() * 14).toFixed(2)}s;--sway:${(2.5 + r() * 2.5).toFixed(2)}s;opacity:${(.55 + r() * .45).toFixed(2)}">
            <div class="ofd-flake-sway">${decoFlakeSvg(1.6 + r() * 1.8)}</div>
          </div>`;
      }
      let cap = 'M0,0 L0,5 ';
      for (let x = 0; x <= 1000; x += 40) cap += `Q${x + 20},${10 + ((x / 40) % 3) * 2.2} ${x + 40},5 `;
      cap += 'L1000,0 Z';
      return `<style>${decoBase}
        #of-deco .ofd-cap { left:0; right:0; top:-3px; width:100%; height:14px; filter: drop-shadow(0 1px 1.5px rgba(30,64,175,.35)); }
        #of-deco .ofd-flake { top:-24px; }
        #of-deco .ofd-flake svg { width:100%; height:100%; }
        #of-deco .ofd-flake.ofd-anim { animation: ofdFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-flake.ofd-anim .ofd-flake-sway { animation: ofdSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdFall { 0% { transform: translateY(0) rotate(0); opacity:0; } 8% { opacity:1; } 85% { opacity:1; } 100% { transform: translateY(150px) rotate(200deg); opacity:0; } }
        @keyframes ofdSway { from { transform: translateX(-10px); } to { transform: translateX(10px); } }
      </style>
      <svg class="ofd ofd-cap" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><path d="${cap}" fill="#f8fbff"/></svg>
      ${flakes}`;
    }

    // ---------- Thanksgiving: maple + oak leaves tumbling down ----------
    function decoThanksgiving(A) {
      const maple = 'M10,1 L11.6,5.4 L14.6,3.6 L14,7.6 L18.4,7 L16.2,10 L19,11.4 L14.2,13.4 L14.8,15.2 L11,14.2 L10.6,19 L9.4,19 L9,14.2 L5.2,15.2 L5.8,13.4 L1,11.4 L3.8,10 L1.6,7 L6,7.6 L5.4,3.6 L8.4,5.4 Z';
      const oak = 'M10,1 C12,2 11,4 13,4.5 C15.5,5 14,7.5 15.5,8.5 C17.5,10 15,12 16,13.5 C17,15.5 13.5,15.5 12,17 C11.2,18 10.6,19 10,19 C9.4,19 8.8,18 8,17 C6.5,15.5 3,15.5 4,13.5 C5,12 2.5,10 4.5,8.5 C6,7.5 4.5,5 7,4.5 C9,4 8,2 10,1 Z';
      const colors = ['#c2410c', '#b45309', '#d97706', '#9a3412', '#a16207', '#dc2626', '#ca8a04'];
      const r = decoRand(55);
      let leaves = '';
      for (let i = 0; i < 10; i++) {
        const size = 13 + Math.round(r() * 8), c = colors[i % colors.length];
        leaves += `
          <div class="ofd ofd-leaf${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `top:${(8 + r() * 55).toFixed(0)}%;transform:rotate(${Math.round(r() * 360)}deg);`}width:${size}px;height:${size}px;--dur:${(8 + r() * 6).toFixed(2)}s;--delay:${(-r() * 14).toFixed(2)}s;--sway:${(2 + r() * 2).toFixed(2)}s">
            <div class="ofd-leaf-sway"><div class="ofd-leaf-tumble" style="--tum:${(2.4 + r() * 2).toFixed(2)}s">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="${i % 3 ? maple : oak}" fill="${c}"/><path d="M10,19 L10,6" stroke="rgba(60,20,0,.55)" stroke-width=".8"/></svg>
            </div></div>
          </div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-leaf { top:-26px; }
        #of-deco .ofd-leaf svg { width:100%; height:100%; }
        #of-deco .ofd-leaf.ofd-anim { animation: ofdLeafFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-sway { animation: ofdLeafSway var(--sway) ease-in-out infinite alternate; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-tumble { animation: ofdTumble var(--tum) linear infinite; }
        @keyframes ofdLeafFall { 0% { transform: translateY(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px); opacity:0; } }
        @keyframes ofdLeafSway { from { transform: translateX(-16px) rotate(-18deg); } to { transform: translateX(16px) rotate(18deg); } }
        @keyframes ofdTumble { from { transform: rotateX(0) rotateY(0) rotate(0); } to { transform: rotateX(360deg) rotateY(180deg) rotate(90deg); } }
      </style>${leaves}`;
    }

    // ---------- St. Patrick's: shamrocks drifting + gold glints ----------
    function decoStPatricks(A) {
      const leaf = 'M10,10 C7.5,7 4,6.5 4.2,4 C4.4,1.8 7.4,1.6 8.5,3.4 C9.2,1.4 12.4,1.6 12.6,3.8 C12.8,6.2 11.5,7.6 10,10 Z';
      const shamrock = (fill) => `<svg viewBox="0 0 20 22" aria-hidden="true"><g fill="${fill}">
          <path d="${leaf}"/><path d="${leaf}" transform="rotate(120 10 10)"/><path d="${leaf}" transform="rotate(240 10 10)"/></g>
          <path d="M10,11 C10.5,15 12,18 13.5,21" stroke="${fill}" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`;
      const greens = ['#16a34a', '#22c55e', '#15803d', '#4ade80'];
      const r = decoRand(17);
      let html = '';
      for (let i = 0; i < 9; i++) {
        const size = 13 + Math.round(r() * 8);
        html += `
          <div class="ofd ofd-leaf${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `top:${(8 + r() * 55).toFixed(0)}%;`}width:${size}px;height:${(size * 1.1).toFixed(0)}px;--dur:${(9 + r() * 6).toFixed(2)}s;--delay:${(-r() * 15).toFixed(2)}s;--sway:${(2.2 + r() * 2).toFixed(2)}s">
            <div class="ofd-leaf-sway"><div class="ofd-leaf-tumble" style="--tum:${(3 + r() * 2).toFixed(2)}s">${shamrock(greens[i % greens.length])}</div></div>
          </div>`;
      }
      for (let i = 0; i < 6; i++) {
        html += `<div class="ofd ofd-glint${A}" style="left:${(8 + i * 16 + r() * 6).toFixed(1)}%;top:${(-6 + r() * 10).toFixed(0)}px;--delay:${(-r() * 3).toFixed(2)}s">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5,0 L6,4 L10,5 L6,6 L5,10 L4,6 L0,5 L4,4 Z" fill="#fde047"/></svg></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-leaf { top:-26px; }
        #of-deco .ofd-leaf svg { width:100%; height:100%; }
        #of-deco .ofd-leaf.ofd-anim { animation: ofdCloverFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-sway { animation: ofdCloverSway var(--sway) ease-in-out infinite alternate; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-tumble { animation: ofdCloverTumble var(--tum) linear infinite; }
        @keyframes ofdCloverFall { 0% { transform: translateY(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px); opacity:0; } }
        @keyframes ofdCloverSway { from { transform: translateX(-14px) rotate(-15deg); } to { transform: translateX(14px) rotate(15deg); } }
        @keyframes ofdCloverTumble { from { transform: rotateY(0) rotate(0); } to { transform: rotateY(360deg) rotate(60deg); } }
        #of-deco .ofd-glint { opacity:.7; }
        #of-deco .ofd-glint.ofd-anim { animation: ofdGlint 3s ease-in-out var(--delay) infinite; }
        @keyframes ofdGlint { 0%,70%,100% { opacity:0; transform: scale(.4) rotate(0); } 82% { opacity:1; transform: scale(1.1) rotate(45deg); } }
      </style>${html}`;
    }

    // ---------- Valentine's: hearts rising and fading ----------
    function decoValentines(A) {
      const heart = 'M10,17.5 C10,17.5 1.5,12 1.5,6.5 C1.5,3.6 3.6,1.8 6,1.8 C7.8,1.8 9.2,2.9 10,4.4 C10.8,2.9 12.2,1.8 14,1.8 C16.4,1.8 18.5,3.6 18.5,6.5 C18.5,12 10,17.5 10,17.5 Z';
      const colors = [['#f43f5e', '#be123c'], ['#fb7185', '#e11d48'], ['#ec4899', '#be185d'], ['#fda4af', '#f43f5e']];
      const r = decoRand(14);
      let html = '';
      for (let i = 0; i < 10; i++) {
        const size = 11 + Math.round(r() * 10), [a, b] = colors[i % colors.length];
        html += `
          <div class="ofd ofd-heart${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `bottom:${(20 + r() * 60).toFixed(0)}%;`}width:${size}px;height:${size}px;--dur:${(6 + r() * 5).toFixed(2)}s;--delay:${(-r() * 11).toFixed(2)}s;--sway:${(1.8 + r() * 1.6).toFixed(2)}s">
            <div class="ofd-heart-sway"><svg viewBox="0 0 20 20" aria-hidden="true">
              <defs><linearGradient id="ofdH${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
              <path d="${heart}" fill="url(#ofdH${i})"/><ellipse cx="6.2" cy="5.6" rx="2" ry="1.3" fill="rgba(255,255,255,.55)" transform="rotate(-25 6.2 5.6)"/></svg></div>
          </div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-heart { bottom:0; }
        #of-deco .ofd-heart svg { width:100%; height:100%; }
        #of-deco .ofd-heart.ofd-anim { animation: ofdRise var(--dur) ease-out var(--delay) infinite; }
        #of-deco .ofd-heart.ofd-anim .ofd-heart-sway { animation: ofdHeartSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdRise { 0% { transform: translateY(10px) scale(.6); opacity:0; } 12% { opacity:.95; } 70% { opacity:.85; } 100% { transform: translateY(-150px) scale(1.05); opacity:0; } }
        @keyframes ofdHeartSway { from { transform: translateX(-8px) rotate(-10deg); } to { transform: translateX(8px) rotate(10deg); } }
      </style>${html}`;
    }

    // ---------- Easter: patterned eggs nestled in grass on the top edge ----------
    function decoEaster(A) {
      const eggs = [
        ['#fbcfe8', '#db2777', 'zig'], ['#bae6fd', '#0284c7', 'dots'], ['#fef08a', '#ca8a04', 'bands'],
        ['#bbf7d0', '#16a34a', 'zig'], ['#ddd6fe', '#7c3aed', 'dots'], ['#fed7aa', '#ea580c', 'bands'], ['#a5f3fc', '#0891b2', 'zig'],
      ];
      const pattern = (kind, c) => kind === 'zig'
        ? `<path d="M2,12 L4.5,9.5 L7,12 L9.5,9.5 L12,12 L14.5,9.5 L17,12" stroke="${c}" stroke-width="1.4" fill="none"/><path d="M3,16 H17" stroke="${c}" stroke-width="1.2"/>`
        : kind === 'dots'
          ? `<g fill="${c}"><circle cx="7" cy="9" r="1.3"/><circle cx="13" cy="9" r="1.3"/><circle cx="10" cy="13" r="1.3"/><circle cx="6" cy="16" r="1.1"/><circle cx="14" cy="16" r="1.1"/></g>`
          : `<path d="M3.2,9 Q10,11 16.8,9 M2.4,13 Q10,15.2 17.6,13" stroke="${c}" stroke-width="1.8" fill="none"/>`;
      const r = decoRand(3);
      let html = '';
      eggs.forEach(([base, c, kind], i) => {
        html += `
          <div class="ofd ofd-egg${A}" style="left:${(6 + i * 14.2).toFixed(1)}%;--delay:${(-r() * 7).toFixed(2)}s">
            <svg viewBox="0 0 20 24" width="16" height="20" aria-hidden="true">
              <defs><clipPath id="ofdE${i}"><path d="M10,1 C15,1 18.5,9 18.5,14.5 C18.5,20 14.8,23 10,23 C5.2,23 1.5,20 1.5,14.5 C1.5,9 5,1 10,1 Z"/></clipPath></defs>
              <path d="M10,1 C15,1 18.5,9 18.5,14.5 C18.5,20 14.8,23 10,23 C5.2,23 1.5,20 1.5,14.5 C1.5,9 5,1 10,1 Z" fill="${base}"/>
              <g clip-path="url(#ofdE${i})">${pattern(kind, c)}</g>
              <ellipse cx="6.8" cy="7" rx="1.8" ry="3" fill="rgba(255,255,255,.55)" transform="rotate(20 6.8 7)"/>
            </svg>
          </div>`;
      });
      let grass = '';
      for (let x = 0; x <= 1000; x += 9) grass += `M${x},18 Q${x + 2},${6 + (x % 27) / 3} ${x + 4},${2 + (x % 13) / 2} Q${x + 3},${10 + (x % 7)} ${x + 7},18 Z `;
      return `<style>${decoBase}
        #of-deco .ofd-grass { left:0; right:0; top:-14px; width:100%; height:18px; }
        #of-deco .ofd-egg { top:-16px; transform-origin: 50% 100%; }
        #of-deco .ofd-egg.ofd-anim { animation: ofdWobble 7s ease-in-out var(--delay) infinite; }
        @keyframes ofdWobble { 0%,78%,100% { transform: rotate(0); } 82% { transform: rotate(-12deg); } 86% { transform: rotate(10deg); } 90% { transform: rotate(-6deg); } 94% { transform: rotate(3deg); } }
      </style>
      ${html}
      <svg class="ofd ofd-grass" viewBox="0 0 1000 18" preserveAspectRatio="none" aria-hidden="true"><path d="${grass}" fill="#4ade80"/><path d="M0,16 H1000 V18 H0 Z" fill="#22c55e"/></svg>`;
    }

    // ---------- Hanukkah: menorah with flickering flames + stars ----------
    function decoHanukkah(A) {
      let candles = '', flames = '';
      for (let i = 0; i < 9; i++) {
        const x = 8 + i * 9, shamash = i === 4, top = shamash ? 4 : 10;
        candles += `<rect x="${x - 1.6}" y="${top + 6}" width="3.2" height="${shamash ? 14 : 8}" rx=".8" fill="${shamash ? '#e0f2fe' : (i % 2 ? '#93c5fd' : '#f8fafc')}"/>`;
        flames += `<g class="ofd-flame" style="transform-origin:${x}px ${top + 6}px;--fd:${(0.9 + ((i * 37) % 7) / 10).toFixed(2)}s"><path d="M${x},${top} C${x + 2.4},${top + 3} ${x + 2},${top + 6} ${x},${top + 6.4} C${x - 2},${top + 6} ${x - 2.4},${top + 3} ${x},${top} Z" fill="#fbbf24"/><path d="M${x},${top + 2.4} C${x + 1},${top + 4} ${x + .8},${top + 5.6} ${x},${top + 5.8} C${x - .8},${top + 5.6} ${x - 1},${top + 4} ${x},${top + 2.4} Z" fill="#fff7d6"/></g>`;
      }
      const menorah = `
        <svg viewBox="0 0 88 46" aria-hidden="true">
          <defs><linearGradient id="ofdGold" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#b45309"/></linearGradient></defs>
          ${candles}
          <g fill="none" stroke="url(#ofdGold)" stroke-width="2.2" stroke-linecap="round">
            <path d="M44,20 V40"/>
            ${[1, 2, 3, 4].map(k => `<path d="M${44 - k * 9},18 V${20 + k * 1.5} Q${44 - k * 9},${30 + k * 2} 44,${30 + k * 2}"/><path d="M${44 + k * 9},18 V${20 + k * 1.5} Q${44 + k * 9},${30 + k * 2} 44,${30 + k * 2}"/>`).join('')}
          </g>
          <path d="M34,44 H54 L50,40 H38 Z" fill="url(#ofdGold)"/>
          ${flames}
        </svg>`;
      const r = decoRand(8);
      let stars = '';
      for (let i = 0; i < 7; i++) {
        stars += `<div class="ofd ofd-star${A}" style="left:${(26 + i * 11 + r() * 4).toFixed(1)}%;top:${(-20 + r() * 16).toFixed(0)}px;--delay:${(-r() * 4).toFixed(2)}s;--sz:${(9 + r() * 6).toFixed(0)}px">
          <svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="${i % 2 ? '#bfdbfe' : '#e5e7eb'}" stroke-width="1.4" stroke-linejoin="round"><path d="M10,2 L17,14 H3 Z"/><path d="M10,18 L3,6 H17 Z"/></g></svg></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-menorah { left:12px; bottom:100%; margin-bottom:-4px; width:78px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #of-deco .ofd-menorah svg { width:100%; height:auto; }
        #of-deco .ofd-flame { transform-box: view-box; }
        #of-deco .ofd-menorah.ofd-anim .ofd-flame { animation: ofdFlame var(--fd) ease-in-out infinite alternate; }
        @keyframes ofdFlame { 0% { transform: scale(1,1) skewX(0); } 40% { transform: scale(.92,1.12) skewX(4deg); } 70% { transform: scale(1.05,.94) skewX(-3deg); } 100% { transform: scale(.97,1.06) skewX(2deg); } }
        #of-deco .ofd-star { width:var(--sz); height:var(--sz); opacity:.75; }
        #of-deco .ofd-star svg { width:100%; height:100%; }
        #of-deco .ofd-star.ofd-anim { animation: ofdStar 4s ease-in-out var(--delay) infinite; }
        @keyframes ofdStar { 0%,100% { opacity:.25; transform: scale(.85); } 50% { opacity:.95; transform: scale(1.05); } }
      </style>
      <div class="ofd ofd-menorah${A}">${menorah}</div>${stars}`;
    }

    // ---------- Independence Day: rockets bursting above the player ----------
    function decoIndependence(A) {
      const bursts = [
        { x: 12, y: -52, c: '#ef4444', c2: '#fecaca' }, { x: 34, y: -64, c: '#f8fafc', c2: '#bfdbfe' },
        { x: 57, y: -48, c: '#3b82f6', c2: '#dbeafe' }, { x: 78, y: -60, c: '#ef4444', c2: '#fde68a' },
        { x: 92, y: -46, c: '#f8fafc', c2: '#fecaca' },
      ];
      const r = decoRand(4);
      let html = '';
      bursts.forEach((b, i) => {
        let rays = '';
        const n = 14;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + r() * .15, len = 18 + r() * 6;
          const x2 = (30 + Math.cos(a) * len).toFixed(1), y2 = (30 + Math.sin(a) * len).toFixed(1);
          const x1 = (30 + Math.cos(a) * len * .45).toFixed(1), y1 = (30 + Math.sin(a) * len * .45).toFixed(1);
          rays += `<path d="M${x1},${y1} L${x2},${y2}" stroke="${k % 2 ? b.c : b.c2}"/><circle cx="${x2}" cy="${y2}" r="1.5" fill="${b.c2}"/>`;
        }
        const d = (-r() * 4.5).toFixed(2), dur = (3.8 + r() * 1.6).toFixed(2);
        html += `
          <div class="ofd ofd-rocket${A}" style="left:${b.x}%;--d:${d}s;--dur:${dur}s"></div>
          <div class="ofd ofd-burst${A}" style="left:${b.x}%;top:${b.y}px;--d:${d}s;--dur:${dur}s">
            <svg viewBox="0 0 60 60" width="60" height="60" aria-hidden="true"><g stroke-width="1.6" stroke-linecap="round">${rays}</g></svg></div>`;
      });
      return `<style>${decoBase}
        #of-deco .ofd-burst { margin-left:-30px; opacity:.9; transform: scale(.9); }
        #of-deco .ofd-rocket { bottom:100%; width:2px; height:16px; margin-left:-1px; border-radius:1px; opacity:0;
          background: linear-gradient(to top, rgba(253,230,138,0), #fde68a); }
        #of-deco .ofd-burst.ofd-anim  { opacity:0; animation: ofdBurst  var(--dur) ease-out var(--d) infinite; }
        #of-deco .ofd-rocket.ofd-anim { animation: ofdRocket var(--dur) ease-in var(--d) infinite; }
        @keyframes ofdRocket { 0% { transform: translateY(20px); opacity:0; } 5% { opacity:1; } 30% { transform: translateY(-34px); opacity:.9; } 34%,100% { transform: translateY(-40px); opacity:0; } }
        @keyframes ofdBurst  { 0%,32% { transform: scale(.1); opacity:0; } 36% { opacity:1; } 60% { transform: scale(1); opacity:.9; } 78% { transform: scale(1.12) translateY(4px); opacity:0; } 100% { opacity:0; } }
      </style>${html}`;
    }

    // ---------- shared helpers for the newer themes ----------
    // A candle/lamp flame (outer + inner) centred at (x, y = flame tip).
    function decoFlame(x, y, h, cls) {
      return `<g class="${cls}" style="transform-origin:${x}px ${y + h}px;--fd:${(0.8 + ((x * 13) % 7) / 10).toFixed(2)}s">
        <path d="M${x},${y} C${x + h * .38},${y + h * .45} ${x + h * .32},${y + h * .95} ${x},${y + h} C${x - h * .32},${y + h * .95} ${x - h * .38},${y + h * .45} ${x},${y} Z" fill="#fbbf24"/>
        <path d="M${x},${y + h * .38} C${x + h * .16},${y + h * .62} ${x + h * .13},${y + h * .9} ${x},${y + h * .93} C${x - h * .13},${y + h * .9} ${x - h * .16},${y + h * .62} ${x},${y + h * .38} Z" fill="#fff7d6"/>
      </g>`;
    }
    // Falling confetti pieces (rectangles and curls) in the given colours.
    function decoConfetti(A, colors, count, seed, prefix) {
      const r = decoRand(seed);
      let html = '';
      for (let i = 0; i < count; i++) {
        const c = colors[i % colors.length], curl = i % 4 === 3;
        const w = curl ? 10 : 5 + Math.round(r() * 3), h = curl ? 10 : 8 + Math.round(r() * 4);
        const shape = curl
          ? `<svg viewBox="0 0 10 10" width="${w}" height="${h}" aria-hidden="true"><path d="M1,8 C3,1 6,9 9,2" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`
          : `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect width="${w}" height="${h}" rx="1" fill="${c}"/></svg>`;
        html += `<div class="ofd ${prefix}-bit${A}" style="left:${(2 + r() * 96).toFixed(1)}%;${A ? '' : `top:${(10 + r() * 60).toFixed(0)}%;transform:rotate(${Math.round(r() * 180)}deg);`}--dur:${(5 + r() * 5).toFixed(2)}s;--delay:${(-r() * 10).toFixed(2)}s;--sway:${(1.2 + r() * 1.6).toFixed(2)}s;--spin:${(0.9 + r() * 1.4).toFixed(2)}s">
          <div class="${prefix}-sway"><div class="${prefix}-spin">${shape}</div></div></div>`;
      }
      return html;
    }
    function decoConfettiCss(prefix) {
      return `
        #of-deco .${prefix}-bit { top:-18px; }
        #of-deco .${prefix}-bit.ofd-anim { animation: ${prefix}Fall var(--dur) linear var(--delay) infinite; }
        #of-deco .${prefix}-bit.ofd-anim .${prefix}-sway { animation: ${prefix}Sway var(--sway) ease-in-out infinite alternate; }
        #of-deco .${prefix}-bit.ofd-anim .${prefix}-spin { animation: ${prefix}Spin var(--spin) linear infinite; }
        @keyframes ${prefix}Fall { 0% { transform: translateY(0); opacity:0; } 6% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px); opacity:0; } }
        @keyframes ${prefix}Sway { from { transform: translateX(-9px); } to { transform: translateX(9px); } }
        @keyframes ${prefix}Spin { from { transform: rotateX(0) rotateY(0) rotate(0); } to { transform: rotateX(360deg) rotateY(180deg) rotate(180deg); } }`;
    }

    // ---------- New Year's: confetti, a glittering ball, sparkle bursts ----------
    function decoNewYear(A) {
      const confetti = decoConfetti(A, ['#facc15', '#e5e7eb', '#fde68a', '#f59e0b', '#cbd5e1', '#fef3c7'], 18, 101, 'ofdny');
      let facets = '';
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 8; col++) {
          const x = 6 + col * 5.2 - (row % 2) * 2.6, y = 6 + row * 4.6;
          if ((x - 24) ** 2 + (y - 22) ** 2 > 16.5 ** 2) continue;
          facets += `<rect class="ofd-facet" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="4.4" height="3.8" rx=".5" style="--fa:${((row * 3 + col * 5) % 9) * 0.22}s" fill="${(row + col) % 3 ? '#e2e8f0' : '#fef3c7'}"/>`;
        }
      }
      const ball = `
        <svg viewBox="0 0 48 46" aria-hidden="true">
          <defs><radialGradient id="ofdNyBall" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#94a3b8"/><stop offset="1" stop-color="#1e293b"/></radialGradient>
            <clipPath id="ofdNyClip"><circle cx="24" cy="22" r="17"/></clipPath></defs>
          <path d="M24,0 V5" stroke="#cbd5e1" stroke-width="1.2"/>
          <circle cx="24" cy="22" r="17" fill="url(#ofdNyBall)"/>
          <g clip-path="url(#ofdNyClip)" opacity=".85">${facets}</g>
          <circle cx="18" cy="15" r="3.4" fill="#fff" opacity=".8"/>
        </svg>`;
      const r = decoRand(66);
      let sparks = '';
      for (let i = 0; i < 5; i++) {
        sparks += `<div class="ofd ofd-nyspark${A}" style="left:${(10 + i * 19 + r() * 6).toFixed(1)}%;top:${(-30 + r() * 20).toFixed(0)}px;--delay:${(-r() * 3.5).toFixed(2)}s">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g stroke="${i % 2 ? '#fde68a' : '#f8fafc'}" stroke-width="1.4" stroke-linecap="round">
            <path d="M12,2 V7 M12,17 V22 M2,12 H7 M17,12 H22 M5,5 L8.5,8.5 M15.5,15.5 L19,19 M19,5 L15.5,8.5 M8.5,15.5 L5,19"/></g></svg></div>`;
      }
      return `<style>${decoBase}${decoConfettiCss('ofdny')}
        #of-deco .ofd-nyball { right:18%; bottom:100%; margin-bottom:6px; width:40px; filter: drop-shadow(0 0 8px rgba(250,204,21,.45)); }
        #of-deco .ofd-nyball svg { width:100%; height:auto; }
        #of-deco .ofd-nyball.ofd-anim { transform-origin: 50% 0; animation: ofdNySwing 5s ease-in-out infinite alternate; }
        #of-deco .ofd-nyball.ofd-anim .ofd-facet { animation: ofdNyFacet 2s ease-in-out var(--fa) infinite; }
        @keyframes ofdNySwing { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
        @keyframes ofdNyFacet { 0%,100% { opacity:.55; } 50% { opacity:1; fill:#fff; } }
        #of-deco .ofd-nyspark { opacity:.8; }
        #of-deco .ofd-nyspark.ofd-anim { animation: ofdNySpark 3.5s ease-out var(--delay) infinite; }
        @keyframes ofdNySpark { 0%,60% { opacity:0; transform: scale(.2) rotate(0); } 70% { opacity:1; } 90% { opacity:0; transform: scale(1.2) rotate(30deg); } 100% { opacity:0; } }
      </style>
      <div class="ofd ofd-nyball${A}">${ball}</div>${sparks}${confetti}`;
    }

    // ---------- Día de los Muertos: papel picado banner + marigold petals ----------
    function decoDayOfDead(A) {
      const flagColors = ['#ec4899', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#a855f7', '#ef4444'];
      const N = 12;
      let cord = 'M0,3 ';
      for (let i = 0; i < N; i++) cord += `Q${((i + 0.5) / N) * 1000},9 ${((i + 1) / N) * 1000},3 `;
      const patterns = [
        'M6,7 h8 v2 h-8 Z M10,11 m-2.4,0 a2.4,2.4 0 1,0 4.8,0 a2.4,2.4 0 1,0 -4.8,0 Z M5,15 l2,-1.5 l2,1.5 l2,-1.5 l2,1.5 l2,-1.5 v1.4 l-2,1.5 l-2,-1.5 l-2,1.5 l-2,-1.5 l-2,1.5 Z',
        'M10,5 l1.6,3.4 l3.6,.4 l-2.7,2.5 l.8,3.6 l-3.3,-1.9 l-3.3,1.9 l.8,-3.6 l-2.7,-2.5 l3.6,-.4 Z M5,17 h10 v1.4 h-10 Z',
        'M7,8 m-1.6,0 a1.6,1.6 0 1,0 3.2,0 a1.6,1.6 0 1,0 -3.2,0 M13,8 m-1.6,0 a1.6,1.6 0 1,0 3.2,0 a1.6,1.6 0 1,0 -3.2,0 M10,12 l-1.2,2 h2.4 Z M6,16 q4,2.6 8,0 v1.2 q-4,2.6 -8,0 Z',
      ];
      let flags = '';
      for (let i = 0; i < N; i++) {
        const c = flagColors[i % flagColors.length];
        flags += `<div class="ofd ofd-picado${A}" style="left:${((i + 0.5) / N) * 100}%;--delay:${(-(i * 0.37) % 3).toFixed(2)}s;--dur:${(2.6 + (i % 4) * 0.35).toFixed(2)}s">
          <svg viewBox="0 0 20 24" width="20" height="24" aria-hidden="true">
            <path fill-rule="evenodd" fill="${c}" d="M0,0 H20 V20 L17.5,22.5 L15,20 L12.5,22.5 L10,20 L7.5,22.5 L5,20 L2.5,22.5 L0,20 Z ${patterns[i % patterns.length]}"/>
          </svg></div>`;
      }
      const r = decoRand(91);
      let petals = '';
      for (let i = 0; i < 12; i++) {
        const c = i % 3 ? '#f97316' : '#facc15', s = 7 + Math.round(r() * 5);
        petals += `<div class="ofd ofd-petal${A}" style="left:${(3 + r() * 94).toFixed(1)}%;${A ? '' : `top:${(20 + r() * 50).toFixed(0)}%;`}--dur:${(7 + r() * 5).toFixed(2)}s;--delay:${(-r() * 12).toFixed(2)}s;--sway:${(1.8 + r() * 1.6).toFixed(2)}s">
          <div class="ofd-petal-sway"><svg viewBox="0 0 10 12" width="${s}" height="${(s * 1.2).toFixed(0)}" aria-hidden="true"><path d="M5,0 C8.5,2 9.5,7 5,12 C0.5,7 1.5,2 5,0 Z" fill="${c}"/><path d="M5,2 V10" stroke="rgba(154,52,18,.5)" stroke-width=".6"/></svg></div></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-cord { left:0; right:0; top:0; width:100%; height:12px; }
        #of-deco .ofd-picado { top:5px; margin-left:-10px; transform-origin: 50% 0; opacity:.95; }
        #of-deco .ofd-picado.ofd-anim { animation: ofdPicado var(--dur) ease-in-out var(--delay) infinite alternate; }
        @keyframes ofdPicado { from { transform: rotate(-5deg) skewX(-3deg); } to { transform: rotate(5deg) skewX(3deg); } }
        #of-deco .ofd-petal { top:-20px; }
        #of-deco .ofd-petal.ofd-anim { animation: ofdPetalFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-petal.ofd-anim .ofd-petal-sway { animation: ofdPetalSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdPetalFall { 0% { transform: translateY(0) rotate(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px) rotate(240deg); opacity:0; } }
        @keyframes ofdPetalSway { from { transform: translateX(-12px); } to { transform: translateX(12px); } }
      </style>
      <svg class="ofd ofd-cord" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true"><path d="${cord}" fill="none" stroke="#fde68a" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
      ${flags}${petals}`;
    }

    // ---------- Diwali: diya lamps on the edge + rising embers ----------
    function decoDiwali(A) {
      const diya = (i) => `
        <svg viewBox="0 0 40 30" aria-hidden="true">
          <defs><linearGradient id="ofdDiya${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#d9772b"/><stop offset="1" stop-color="#7c2d12"/></linearGradient>
            <radialGradient id="ofdDiyaG${i}"><stop offset="0" stop-color="rgba(255,200,80,.85)"/><stop offset="1" stop-color="rgba(255,160,40,0)"/></radialGradient></defs>
          <circle class="ofd-diya-glow" cx="30" cy="8" r="13" fill="url(#ofdDiyaG${i})"/>
          <path d="M3,15 C8,27 30,29 37,15 C37,13 33,12.5 30,13 L6,13 C4,13 3,13.5 3,15 Z" fill="url(#ofdDiya${i})"/>
          <path d="M3.5,14.5 C10,17 30,17 36.5,14.5" stroke="#fbbf24" stroke-width="1.1" fill="none"/>
          <g fill="#fcd34d"><circle cx="12" cy="20" r="1"/><circle cx="20" cy="21.5" r="1"/><circle cx="28" cy="20" r="1"/></g>
          <path d="M29,13 C30,11 32,11 33,13" stroke="#3f2a12" stroke-width="1" fill="none"/>
          ${decoFlame(31, 1, 11, 'ofd-flame')}
        </svg>`;
      const spots = [8, 30, 52, 74, 92];
      let html = '';
      spots.forEach((x, i) => { html += `<div class="ofd ofd-diya${A}" style="left:${x}%">${diya(i)}</div>`; });
      const r = decoRand(23);
      const ember = ['#fde047', '#fb923c', '#f472b6', '#a78bfa', '#34d399'];
      for (let i = 0; i < 12; i++) {
        html += `<div class="ofd ofd-ember${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `top:${(-40 + r() * 30).toFixed(0)}px;`}--dur:${(4 + r() * 4).toFixed(2)}s;--delay:${(-r() * 8).toFixed(2)}s;--c:${ember[i % ember.length]}"></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-diya { bottom:100%; margin-bottom:-5px; width:38px; margin-left:-19px; filter: drop-shadow(0 2px 2px rgba(0,0,0,.5)); }
        #of-deco .ofd-diya svg { width:100%; height:auto; }
        #of-deco .ofd-flame { transform-box: view-box; }
        #of-deco .ofd-diya.ofd-anim .ofd-flame { animation: ofdFlame var(--fd) ease-in-out infinite alternate; }
        #of-deco .ofd-diya.ofd-anim .ofd-diya-glow { animation: ofdDiyaGlow 1.9s ease-in-out infinite alternate; }
        @keyframes ofdFlame { 0% { transform: scale(1,1) skewX(0); } 40% { transform: scale(.92,1.12) skewX(4deg); } 70% { transform: scale(1.05,.94) skewX(-3deg); } 100% { transform: scale(.97,1.06) skewX(2deg); } }
        @keyframes ofdDiyaGlow { from { opacity:.65; } to { opacity:1; } }
        #of-deco .ofd-ember { bottom:100%; width:3px; height:3px; border-radius:50%; background: var(--c); box-shadow: 0 0 4px var(--c); opacity:.8; }
        #of-deco .ofd-ember.ofd-anim { animation: ofdEmber var(--dur) ease-out var(--delay) infinite; }
        @keyframes ofdEmber { 0% { transform: translate(0,0); opacity:0; } 15% { opacity:1; } 100% { transform: translate(10px,-70px); opacity:0; } }
      </style>${html}`;
    }

    // ---------- Kwanzaa: kinara with seven candles + kente-inspired band ----------
    function decoKwanzaa(A) {
      const colors = ['#dc2626', '#dc2626', '#dc2626', '#111827', '#16a34a', '#16a34a', '#16a34a'];
      let candles = '', flames = '';
      colors.forEach((c, i) => {
        const x = 9 + i * 10, h = i === 3 ? 16 : 13 - Math.abs(3 - i) * 0.6, top = 26 - h;
        candles += `<rect x="${x - 2.2}" y="${top}" width="4.4" height="${h}" rx="1" fill="${c}" stroke="${c === '#111827' ? '#4b5563' : 'none'}" stroke-width=".6"/>`;
        flames += decoFlame(x, top - 7.5, 7, 'ofd-flame');
      });
      const kinara = `
        <svg viewBox="0 0 88 40" aria-hidden="true">
          <defs><linearGradient id="ofdWood" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#a16207"/><stop offset="1" stop-color="#57300d"/></linearGradient></defs>
          ${candles}
          <path d="M4,26 H84 L80,31 H8 Z" fill="url(#ofdWood)"/>
          <path d="M20,31 L16,39 H72 L68,31 Z" fill="url(#ofdWood)" opacity=".92"/>
          <path d="M8,28.5 H80" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>
          ${flames}
        </svg>`;
      let band = '';
      const bc = ['#dc2626', '#111827', '#16a34a', '#eab308'];
      for (let x = 0, k = 0; x < 1000; x += 25, k++) {
        band += `<rect x="${x}" y="0" width="25" height="5" fill="${bc[k % 4]}"/><rect x="${x + 7}" y="1.5" width="11" height="2" fill="${bc[(k + 2) % 4]}"/>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-kente { left:0; right:0; top:0; width:100%; height:5px; opacity:.9; }
        #of-deco .ofd-kinara { left:12px; bottom:100%; margin-bottom:-4px; width:82px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #of-deco .ofd-kinara svg { width:100%; height:auto; }
        #of-deco .ofd-flame { transform-box: view-box; }
        #of-deco .ofd-kinara.ofd-anim .ofd-flame { animation: ofdFlame var(--fd) ease-in-out infinite alternate; }
        @keyframes ofdFlame { 0% { transform: scale(1,1) skewX(0); } 40% { transform: scale(.92,1.12) skewX(4deg); } 70% { transform: scale(1.05,.94) skewX(-3deg); } 100% { transform: scale(.97,1.06) skewX(2deg); } }
      </style>
      <svg class="ofd ofd-kente" viewBox="0 0 1000 5" preserveAspectRatio="none" aria-hidden="true">${band}</svg>
      <div class="ofd ofd-kinara${A}">${kinara}</div>`;
    }

    // ---------- Lunar New Year: red lanterns on a gold cord + blossom petals ----------
    function decoLunarNewYear(A) {
      const N = 7;
      let cord = 'M0,2 ';
      for (let i = 0; i < N; i++) cord += `Q${((i + 0.5) / N) * 1000},12 ${((i + 1) / N) * 1000},2 `;
      const r = decoRand(88);
      let lanterns = '';
      for (let i = 0; i < N; i++) {
        lanterns += `<div class="ofd ofd-lantern${A}" style="left:${((i + 0.5) / N) * 100}%;--dur:${(2.8 + r() * 1.6).toFixed(2)}s;--delay:${(-r() * 3).toFixed(2)}s">
          <svg viewBox="0 0 24 40" width="17" height="28" aria-hidden="true">
            <defs><radialGradient id="ofdLan${i}" cx="40%" cy="45%" r="65%"><stop offset="0" stop-color="#ff6b5b"/><stop offset=".6" stop-color="#dc2626"/><stop offset="1" stop-color="#7f1d1d"/></radialGradient></defs>
            <path d="M12,0 V5" stroke="#eab308" stroke-width="1"/>
            <rect x="7" y="4" width="10" height="3" rx="1" fill="#eab308"/>
            <ellipse cx="12" cy="17" rx="10" ry="10.5" fill="url(#ofdLan${i})"/>
            <path d="M12,6.5 C7,10 7,24 12,27.5 M12,6.5 C17,10 17,24 12,27.5 M4,12 C8,15 16,15 20,12 M4,22 C8,19 16,19 20,22" stroke="rgba(120,20,20,.55)" stroke-width=".8" fill="none"/>
            <rect x="7" y="26.5" width="10" height="3" rx="1" fill="#eab308"/>
            <path d="M10,29.5 V39 M12,29.5 V40 M14,29.5 V39" stroke="#eab308" stroke-width="1" stroke-linecap="round"/>
          </svg></div>`;
      }
      let petals = '';
      for (let i = 0; i < 10; i++) {
        const s = 7 + Math.round(r() * 4);
        petals += `<div class="ofd ofd-bloom${A}" style="left:${(3 + r() * 94).toFixed(1)}%;${A ? '' : `top:${(20 + r() * 50).toFixed(0)}%;`}--dur:${(8 + r() * 5).toFixed(2)}s;--delay:${(-r() * 13).toFixed(2)}s;--sway:${(2 + r() * 1.5).toFixed(2)}s">
          <div class="ofd-bloom-sway"><svg viewBox="0 0 10 10" width="${s}" height="${s}" aria-hidden="true"><path d="M5,0.5 C8,1.5 9.5,5 5,9.5 C0.5,5 2,1.5 5,0.5 Z" fill="${i % 2 ? '#fbcfe8' : '#f9a8d4'}"/></svg></div></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-lcord { left:0; right:0; top:0; width:100%; height:14px; }
        #of-deco .ofd-lantern { top:4px; margin-left:-8.5px; transform-origin: 50% 0; filter: drop-shadow(0 0 5px rgba(239,68,68,.55)); }
        #of-deco .ofd-lantern.ofd-anim { animation: ofdLantern var(--dur) ease-in-out var(--delay) infinite alternate; }
        @keyframes ofdLantern { from { transform: rotate(-6deg); } to { transform: rotate(6deg); } }
        #of-deco .ofd-bloom { top:-18px; }
        #of-deco .ofd-bloom.ofd-anim { animation: ofdBloomFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-bloom.ofd-anim .ofd-bloom-sway { animation: ofdBloomSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdBloomFall { 0% { transform: translateY(0) rotate(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px) rotate(220deg); opacity:0; } }
        @keyframes ofdBloomSway { from { transform: translateX(-11px); } to { transform: translateX(11px); } }
      </style>
      <svg class="ofd ofd-lcord" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><path d="${cord}" fill="none" stroke="#eab308" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
      ${lanterns}${petals}`;
    }

    // ---------- Mardi Gras: draped beads, a feathered mask, confetti ----------
    function decoMardiGras(A) {
      const beadColors = ['#7e22ce', '#16a34a', '#eab308'];
      let beads = '';
      const strands = 4;
      for (let s = 0; s < strands; s++) {
        const x0 = (s / strands) * 1000, x1 = ((s + 1) / strands) * 1000, sag = 16 + (s % 2) * 4;
        for (let k = 0; k <= 26; k++) {
          const t = k / 26, x = x0 + (x1 - x0) * t, y = 3 + sag * 4 * t * (1 - t);
          beads += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="4.2" ry="3.2" fill="${beadColors[(s + k) % 3]}"/><ellipse cx="${(x - 1.2).toFixed(1)}" cy="${(y - 1).toFixed(1)}" rx="1.2" ry=".9" fill="rgba(255,255,255,.6)"/>`;
        }
      }
      const mask = `
        <svg viewBox="0 0 56 40" aria-hidden="true">
          <defs><linearGradient id="ofdMask" x1="0" x2="1"><stop offset="0" stop-color="#7e22ce"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#7e22ce"/></linearGradient></defs>
          <path class="ofd-plume" d="M40,18 C44,6 50,1 54,0 C52,6 49,12 43,19 Z" fill="#16a34a"/>
          <path class="ofd-plume" d="M38,18 C39,7 43,2 47,-1 C46,6 45,12 41,19 Z" fill="#eab308"/>
          <path d="M4,22 C8,14 20,14 28,19 C36,14 48,14 52,22 C50,32 38,34 28,27 C18,34 6,32 4,22 Z" fill="url(#ofdMask)" stroke="#eab308" stroke-width="1.2"/>
          <path fill="#1f0f2e" d="M11,22 C14,18.5 20,18.5 22.5,22.5 C19,25.5 14,25.5 11,22 Z M45,22 C42,18.5 36,18.5 33.5,22.5 C37,25.5 42,25.5 45,22 Z"/>
          <g fill="#fde68a"><circle cx="28" cy="23" r="1.2"/><circle cx="8" cy="20" r=".9"/><circle cx="48" cy="20" r=".9"/></g>
        </svg>`;
      const confetti = decoConfetti(A, ['#7e22ce', '#16a34a', '#eab308', '#a855f7', '#22c55e', '#facc15'], 14, 202, 'ofdmg');
      return `<style>${decoBase}${decoConfettiCss('ofdmg')}
        #of-deco .ofd-beads { left:0; right:0; top:0; width:100%; height:26px; }
        #of-deco .ofd-mask { right:16px; bottom:100%; margin-bottom:-4px; width:54px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #of-deco .ofd-mask svg { width:100%; height:auto; }
        #of-deco .ofd-mask .ofd-plume { transform-box: view-box; transform-origin: 42px 19px; }
        #of-deco .ofd-mask.ofd-anim .ofd-plume { animation: ofdPlume 3s ease-in-out infinite alternate; }
        @keyframes ofdPlume { from { transform: rotate(-4deg); } to { transform: rotate(5deg); } }
      </style>
      <svg class="ofd ofd-beads" viewBox="0 0 1000 26" preserveAspectRatio="none" aria-hidden="true">${beads}</svg>
      <div class="ofd ofd-mask${A}">${mask}</div>${confetti}`;
    }
  })();
})();
