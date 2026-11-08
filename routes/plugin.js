// ============================================================
// ShowPilot — Plugin API
// Endpoints that the ShowPilot FPP plugin calls.
// Auth: Authorization: Bearer <showToken>
//
// Endpoints:
//   GET  /api/plugin/state            — one call, returns everything FPP needs to act
//   POST /api/plugin/playing          — FPP reports what's playing now (track-change edge)
//   POST /api/plugin/position         — FPP reports live playback position (every ~500ms)
//   POST /api/plugin/next             — FPP reports what's scheduled next
//   POST /api/plugin/heartbeat        — keepalive + plugin version sync
//   POST /api/plugin/sync-sequences   — plugin pushes the full sequence list
//   GET  /api/plugin/health           — plugin status visibility
// ============================================================

const express = require('express');
const router = express.Router();
const config = require('../lib/config-loader');
const {
  getConfig,
  updateConfig,
  setNowPlaying,
  setNextScheduled,
  setBaselineNext,
  getHighestVotedSequence,
  detectVoteTie,
  getTiebreakLeader,
  clearVotesForRound,
  clearTiebreakState,
  popNextQueuedRequest,
  advanceVotingRound,
  db,
} = require('../lib/db');

// Live playback position from FPP. Updated by POST /api/plugin/position
// roughly twice per second. In-memory only — no need to persist; if the
// server restarts, the next plugin tick refreshes it.
//
// Shape: { sequence: 'Ghostbusters', position: 14.27, updatedAt: 1234567890123 }
// updatedAt is server-side Date.now() at receipt — used by viewers to
// extrapolate "where IS the track now" by adding (now - updatedAt) to
// position. Network latency between plugin and server gets baked into
// updatedAt; this is fine because both ends of the calculation use
// server-side timestamps so they cancel.
let livePosition = null;

// Exported so other modules (routes/viewer.js) can read latest position.
function getLivePosition() {
  return livePosition;
}

// Seconds left in the playing song, or null if unknown. Uses the live
// position the plugin reports (~2x/sec) when it's fresh and for the same
// song, else the song's start time; both need the synced song length.
const RACE_SONG_END_WINDOW_S = 5;
function secondsLeftInSong() {
  try {
    const np = db.prepare(`SELECT sequence_name, started_at FROM now_playing WHERE id = 1`).get();
    if (!np || !np.sequence_name) return null;
    const seq = db.prepare(`SELECT duration_seconds FROM sequences WHERE name = ? COLLATE NOCASE`).get(np.sequence_name);
    if (!seq || !(seq.duration_seconds > 0)) return null;
    const now = Date.now();
    const lp = livePosition;
    if (lp && lp.sequence.toLowerCase() === np.sequence_name.toLowerCase() && now - lp.updatedAt < 10000) {
      return seq.duration_seconds - (lp.position + (now - lp.updatedAt) / 1000);
    }
    if (np.started_at) {
      const startedMs = new Date(np.started_at + 'Z').getTime();
      if (isFinite(startedMs)) return seq.duration_seconds - (now - startedMs) / 1000;
    }
  } catch (e) {
    console.warn('[race] could not work out time left in the song:', e.message);
  }
  return null;
}

// Bearer token auth
function requireBearerToken(req, res, next) {
  const auth = req.header('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;

  if (!token || token !== config.showToken) {
    return res.status(401).json({ error: 'Invalid or missing bearer token' });
  }
  next();
}

router.use(requireBearerToken);

// ============================================================
// Private IP validation for fppHost
// ============================================================
// We capture FPP's source IP from the heartbeat and use it as the upstream
// for our audio proxy. To prevent that proxy from being weaponized into an
// SSRF (e.g. if someone compromises the showToken AND can spoof X-
// Forwarded-For), we validate the source IP looks like a private LAN
// address. Public IPs are rejected outright — there is no legitimate
// scenario where FPP and ShowPilot are running on different sides of the
// public internet.
//
// We accept:
//   - RFC1918 ranges: 10.x, 172.16-31.x, 192.168.x
//   - Link-local: 169.254.x (rare but legitimate auto-config)
//   - Loopback: handled separately as null (means same-host install)
//
// We REJECT:
//   - Public IPv4 ranges
//   - 169.254.169.254 specifically (cloud metadata service — common SSRF target)
//   - IPv6 except loopback (no LAN IPv6 use case for FPP today)
function isPrivateLanIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  // Cloud metadata endpoint — explicitly blocked even though it falls in 169.254.0.0/16
  if (ip === '169.254.169.254') return false;
  // Match RFC1918 + link-local
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  const m172 = ip.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172) {
    const n = Number(m172[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

// ---- PSA counter handling (patched) ----
// The PSA counter is zeroed when a PSA actually STARTS playing (see /playing),
// not when /state hands it to the plugin. If the plugin never plays it, we
// give up after PSA_GIVE_UP_MS so a stuck PSA can't block voting forever.
const PSA_GIVE_UP_MS = 5 * 60 * 1000;
let psaHandout = null; // { name, since } — PSA given to the plugin, not yet confirmed playing

function resetPsaCounter(mode) {
  const col = mode === 'sequences' ? 'sequences_since_last_psa' : 'interactions_since_last_psa';
  db.prepare(`UPDATE config SET ${col} = 0 WHERE id = 1`).run();
}

// Track plugin heartbeats and sync — hydrated from config on startup,
// re-saved to config whenever values change so restarts don't lose state.
const pluginStatus = (() => {
  const cfg = getConfig();
  return {
    lastSeen: cfg.plugin_last_seen_at || null,
    version: cfg.plugin_version || null,
    lastSyncAt: cfg.plugin_last_sync_at || null,
    lastSyncPlaylist: cfg.plugin_last_sync_playlist || null,
    lastSyncCount: cfg.plugin_last_sync_count || 0,
    lastSyncDuplicates: (() => { try { return JSON.parse(cfg.plugin_last_sync_duplicates || '[]'); } catch (e) { return []; } })(),
    fppHost: cfg.plugin_fpp_host || null,
  };
})();

// ============================================================
// GET /api/plugin/state
// ============================================================
router.get('/state', (req, res) => {
  const cfg = getConfig();

  // ?peek=1 (v0.33.249+): just the mode, nothing handed out. For a show
  // player that only wants to know the mode (the FPP plugin checks it once a
  // minute); answering those calls with a request used to hand that request
  // out to a caller that never queued it (GitHub #37).
  if (req.query.peek === '1' || req.query.peek === 'true') {
    return res.json({
      mode: cfg.viewer_control_mode === 'LISTEN' ? 'JUKEBOX' : cfg.viewer_control_mode,
      ...(cfg.viewer_control_mode === 'LISTEN' ? { viewerMode: 'LISTEN' } : {}),
      interruptSchedule: cfg.interrupt_schedule === 1,
      managedPsa: cfg.managed_psa_enabled === 1,
      winningVote: null, nextRequest: null, psa: null, peek: true,
    });
  }

  const response = {
    mode: cfg.viewer_control_mode,
    interruptSchedule: cfg.interrupt_schedule === 1,
    managedPsa: cfg.managed_psa_enabled === 1,
    winningVote: null,
    nextRequest: null,
    psa: null,
  };

  // PSA check — if enabled and threshold met, play a PSA instead.
  // Two counting modes (psa_trigger_mode):
  //   'interactions' — count viewer interactions (votes / jukebox requests).
  //                    Counter is interactions_since_last_psa, incremented
  //                    in /vote and /jukebox/add. Only meaningful when
  //                    viewers are actually engaging.
  //   'sequences' —    count FPP sequence transitions (excluding PSAs
  //                    themselves). Counter is sequences_since_last_psa,
  //                    incremented in /playing below. Fires regardless of
  //                    viewer activity — best for schedule-driven shows.
  //
  // OFF-mode rule (v0.30.1+): when viewer_control_mode is OFF, ShowPilot
  // is hands-off — it observes FPP via /playing for the now-playing
  // display but never directs FPP. PSAs are a form of direction (we tell
  // the plugin to play a specific sequence), so they don't fire in OFF
  // mode regardless of trigger mode or threshold. The counters keep
  // incrementing in the background so when viewer mode is re-enabled,
  // PSAs can fire normally without a hard reset.
  // Listen Only (LISTEN) is hands-off for PSAs too: nobody can vote or
  // request, so there is nothing to prompt.
  if (cfg.viewer_control_mode !== 'OFF' && cfg.viewer_control_mode !== 'LISTEN' && cfg.play_psa_enabled && cfg.psa_frequency > 0) {
    const mode = cfg.psa_trigger_mode === 'sequences' ? 'sequences' : 'interactions';
    const counter = mode === 'sequences'
      ? (cfg.sequences_since_last_psa || 0)
      : (cfg.interactions_since_last_psa || 0);

    if (counter >= cfg.psa_frequency) {
      const psa = db.prepare(`
        SELECT name, sort_order FROM sequences
        WHERE is_psa = 1 AND visible = 1 AND active = 1
        ORDER BY COALESCE(last_played_at, '1970-01-01') ASC
        LIMIT 1
      `).get();

      const psaStuck = !!(psa && psaHandout && psaHandout.name === psa.name &&
        (Date.now() - psaHandout.since) > PSA_GIVE_UP_MS);
      if (psaStuck) {
        console.log(`[psa] "${psa.name}" was handed to the plugin ${Math.round((Date.now() - psaHandout.since) / 1000)}s ago but never started; resetting counter and carrying on`);
        resetPsaCounter(mode);
        psaHandout = null;
      } else if (psa) {
        const psaEntry = { sequence: psa.name, playlistIndex: psa.sort_order };
        response.psa = psaEntry;
        // The counter is NOT reset here any more. It is reset in /playing
        // when the PSA really starts, so a PSA the plugin drops or delays
        // doesn't silently lose its place. The plugin already ignores
        // repeats while the PSA is in its pending queue.
        if (!psaHandout || psaHandout.name !== psa.name) {
          psaHandout = { name: psa.name, since: Date.now() };
        }

        // Deliver PSA via the mode-appropriate slot so plugin acts on it
        if (cfg.viewer_control_mode === 'VOTING') response.winningVote = psaEntry;
        else if (cfg.viewer_control_mode === 'JUKEBOX') response.nextRequest = psaEntry;

        // Remember we handed this out as a viewer-driven play (PSA still counts as one)
        rememberHandoff(psa.name, 'psa');

        return res.json(response);
      }
    }
  }

  if (cfg.viewer_control_mode === 'VOTING') {
    // ---- Tiebreak resolution (v0.24.0+) ----
    //
    // Three tiebreak code paths possible here:
    //   (1) Tiebreak ALREADY active and resolves now (clear leader emerged
    //       from tiebreak votes) → return that as the winner.
    //   (2) Tiebreak ALREADY active and timer expired → dump all votes for
    //       the round, clear tiebreak state, return no winner. FPP plays
    //       its scheduled next song.
    //   (3) No tiebreak active and we'd normally pick a winner, but votes
    //       are tied at the top → start tiebreak, return no winner this
    //       poll, and emit a socket event so viewers can show the
    //       tiebreak banner + cast tiebreak votes.
    // If tiebreak feature is disabled (cfg.tiebreak_enabled === 0), we
    // skip all this and use the original first-vote-wins behavior.
    const tiebreakEnabled = cfg.tiebreak_enabled === 1;
    let returnedWinner = false;

    if (tiebreakEnabled && cfg.tiebreak_active === 1 && cfg.tiebreak_deadline_at) {
      const candidates = (cfg.tiebreak_candidates || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      // Use the stored deadline (set when tiebreak started, capped at
      // min(timer-expiry, current-song-end)) rather than re-computing
      // from started_at + duration. This ensures the deadline shown to
      // viewers and the deadline we enforce are the same value, even
      // across server restarts or clock weirdness.
      const deadlineMs = new Date(cfg.tiebreak_deadline_at + 'Z').getTime();
      const nowMs = Date.now();

      if (nowMs >= deadlineMs) {
        // Timer expired. Dump everything.
        clearVotesForRound(cfg.current_voting_round);
        clearTiebreakState();
        // Advance the round — votes are gone, we're moving on. Next
        // round starts fresh.
        require('../lib/db').advanceVotingRound();
        const io = req.app.get('io');
        if (io) {
          io.emit('voteReset');
          io.emit('tiebreakFailed', {
            candidates,
            reason: 'deadline reached without clear winner',
          });
        }
        // Fall through — no winner. Plugin handles this by letting FPP
        // play its scheduled next song.
      } else {
        // Tiebreak still active. Check for resolution.
        const leader = getTiebreakLeader(cfg.current_voting_round, candidates);
        if (leader) {
          response.winningVote = {
            sequence: leader.sequence_name,
            playlistIndex: leader.sort_order,
            votes: leader.vote_count,
          };
          rememberHandoff(leader.sequence_name, 'vote');
          // Resolution will be finalized in /playing when this winner
          // starts playing. Don't clear state yet — viewer banner still
          // shows tiebreak in progress until song actually changes.
          // (Same model as normal voting: round advances on song change.)
          returnedWinner = true;
        }
        // else: still tied within candidates, no winner this poll
      }
    } else if (tiebreakEnabled) {
      // Path 3: no tiebreak active. Check if we'd normally pick a winner
      // but there's a tie at the top.
      const tied = detectVoteTie(cfg.current_voting_round);
      if (tied) {
        // Compute the tiebreak deadline. The configured timer is the
        // worst-case max, but the tie window can never extend PAST the
        // current song's end — otherwise the banner stays up into the
        // next song's playback, which is wrong (next song was either
        // a tiebreak winner or a schedule fill, either way the round
        // moves on at song change).
        //
        // We need: the wall-clock moment the current song will end.
        //   currentSongEndMs = trackStartedAtMs + duration_seconds * 1000
        // If we don't know the duration (plugin hasn't synced sequences,
        // or the sequence row is missing), fall back to the configured
        // timer alone — better to over-extend than to expire instantly.
        const nowMs = Date.now();
        const durationCapMs = (cfg.tiebreak_duration_sec || 60) * 1000;
        const timerDeadlineMs = nowMs + durationCapMs;

        let songEndMs = null;
        try {
          const np = db.prepare(`SELECT sequence_name, started_at FROM now_playing WHERE id = 1`).get();
          if (np && np.sequence_name && np.started_at) {
            const seq = db.prepare(
              `SELECT duration_seconds FROM sequences WHERE name = ? COLLATE NOCASE`
            ).get(np.sequence_name);
            if (seq && seq.duration_seconds && seq.duration_seconds > 0) {
              // started_at is stored as UTC text in SQLite — append 'Z'
              // so JS treats it as UTC, not local.
              const startedMs = new Date(np.started_at + 'Z').getTime();
              if (isFinite(startedMs)) {
                songEndMs = startedMs + (seq.duration_seconds * 1000);
              }
            }
          }
        } catch (e) {
          console.warn('[tiebreak] could not compute song end:', e.message);
        }

        // Take the EARLIER of the two caps. If we have no song end,
        // use the timer alone.
        const deadlineMs = (songEndMs && songEndMs > nowMs)
          ? Math.min(timerDeadlineMs, songEndMs)
          : timerDeadlineMs;
        const deadlineIso = new Date(deadlineMs).toISOString().slice(0, 19).replace('T', ' ');
        const startedAtIso = new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
          UPDATE config
          SET tiebreak_active = 1,
              tiebreak_started_at = ?,
              tiebreak_deadline_at = ?,
              tiebreak_candidates = ?
          WHERE id = 1
        `).run(startedAtIso, deadlineIso, tied.join(','));

        const io = req.app.get('io');
        if (io) {
          // Look up display info for each candidate so viewers can render
          // a rich tiebreak banner with names + images.
          const placeholders = tied.map(() => '?').join(',');
          const rows = db.prepare(`
            SELECT name, display_name, artist, image_url
            FROM sequences
            WHERE name IN (${placeholders}) COLLATE NOCASE
          `).all(...tied);
          const candidateInfo = rows.map(r => ({
            sequenceName: r.name,
            displayName: r.display_name || r.name,
            artist: r.artist || '',
            imageUrl: r.image_url || '',
          }));
          // Send absolute deadline (server wall-clock ms) instead of a
          // relative duration. Viewers compute remaining = deadline - now,
          // which is correct regardless of when they receive the event
          // and accounts for any clock skew using the same burst-sync
          // offset they already have.
          io.emit('tiebreakStarted', {
            candidates: candidateInfo,
            deadlineAtMs: deadlineMs,
            startedAtMs: nowMs,
          });
        }
        // No winner returned this poll. Plugin lets FPP play schedule.
      } else {
        // No tie. Fall back to normal winner selection.
        const top = getHighestVotedSequence();
        if (top) {
          response.winningVote = {
            sequence: top.sequence_name,
            playlistIndex: top.sort_order,
            votes: top.vote_count,
          };
          rememberHandoff(top.sequence_name, 'vote');
          returnedWinner = true;
        }
      }
    } else {
      // Tiebreak feature disabled → original behavior (first-vote-wins).
      const top = getHighestVotedSequence();
      if (top) {
        response.winningVote = {
          sequence: top.sequence_name,
          playlistIndex: top.sort_order,
          votes: top.vote_count,
        };
        rememberHandoff(top.sequence_name, 'vote');
        returnedWinner = true;
      }
    }
    // Round advances when the new song starts playing — handled in /playing.
  } else if (cfg.viewer_control_mode === 'JUKEBOX' || cfg.viewer_control_mode === 'LISTEN') {
    // Listen Only (v0.33.249+): no new requests come in, but the ones already
    // queued still play, so nobody loses a song they asked for. The plugin
    // only acts on nextRequest in JUKEBOX mode, so report that while a
    // queued request is being handed over.
    if (cfg.viewer_control_mode === 'LISTEN') response.viewerMode = 'LISTEN';
    // Every request already handed over is still waiting in the show
    // player's own queue, so keep them all fresh. Before, only the oldest
    // was refreshed: with three or more songs handed over, the later ones
    // passed the 5-minute stale cleanup while still waiting their turn and
    // vanished from the queue lists (GitHub #37). If the show player stops
    // asking, they still expire after 5 minutes.
    db.prepare(`UPDATE jukebox_queue SET handed_off_at = CURRENT_TIMESTAMP
                WHERE played = 0 AND handed_off_at IS NOT NULL`).run();
    // One request in flight at a time (v0.33.249+, GitHub #37): while a
    // handed-over request hasn't started, every ask gets that same request
    // again (the plugin ignores repeats), and the next one is handed out only
    // once it plays. Before, each ask handed out the next request, so a call
    // that didn't queue the answer (the plugin's once-a-minute mode check)
    // silently used up a request: it was marked handed over, the plugin never
    // had it, and FPP skipped it.
    const inFlight = db.prepare(`
      SELECT q.sequence_name, q.requested_at, s.sort_order
      FROM jukebox_queue q
      LEFT JOIN sequences s ON s.name = q.sequence_name COLLATE NOCASE
      WHERE q.played = 0 AND q.handed_off_at IS NOT NULL
      ORDER BY q.handoff_order ASC, q.requested_at ASC, q.id ASC LIMIT 1
    `).get();
    const next = inFlight ? null : popNextQueuedRequest();
    if (inFlight) {
      rememberHandoff(inFlight.sequence_name, 'request');
      if (response.viewerMode === 'LISTEN') response.mode = 'JUKEBOX';
      response.nextRequest = {
        sequence: inFlight.sequence_name,
        playlistIndex: inFlight.sort_order,
        queuedAt: inFlight.requested_at,
      };
    } else if (next) {
      response.nextRequest = {
        sequence: next.sequence_name,
        playlistIndex: next.sort_order,
        queuedAt: next.requested_at,
      };
      rememberHandoff(next.sequence_name, 'request');
      console.log(`[queue] handed "${next.sequence_name}" to the show player (requested ${next.requested_at} UTC${next.skip_count ? ', again after it was passed over' : ''})`);
      if (response.viewerMode === 'LISTEN') response.mode = 'JUKEBOX';
      const io = req.app.get('io');
      if (io) io.emit('queueUpdated');
    }
  } else if (cfg.viewer_control_mode === 'RACE') {
    // Race mode: plugin v0.13.58+ handles RACE natively via the raceWinner
    // field. Returns the winner with an interrupt flag when decided; plugin
    // follows FPP schedule while race is running (no raceWinner field).
    //
    // A race that ends with the song ("End race when the current song ends",
    // or a race timer of 0) has no timer to pick a winner. Before
    // v0.33.278-master.10 nothing picked one: the next song change just
    // cleared the taps, so the leader never played. Now, in the song's last
    // few seconds, the leader wins here (same as the timer would), and plays
    // right after the current song — never cutting it off.
    let rc = cfg;
    const raceEndsWithSong = !!cfg.race_end_on_sequence_end || !(cfg.race_duration_seconds > 0);
    if (raceEndsWithSong && cfg.race_active && !cfg.race_winner) {
      const left = secondsLeftInSong();
      if (left !== null && left <= RACE_SONG_END_WINDOW_S) {
        const { getRaceLeader } = require('../lib/db');
        const leader = getRaceLeader();
        if (leader) {
          const seqRow = db.prepare(`SELECT display_name, artist FROM sequences WHERE name = ? LIMIT 1`).get(leader.sequence_name);
          require('./viewer').resolveRace(req.app.get('io'), leader.sequence_name, seqRow?.display_name || leader.sequence_name, seqRow?.artist || '', leader.count);
          console.log(`[race] song ending — "${leader.sequence_name}" wins with ${leader.count} tap${leader.count === 1 ? '' : 's'}`);
          rc = getConfig();
        }
      }
    }
    if (rc.race_winner && !rc.race_active) {
      const winSeq = db.prepare(`SELECT sort_order FROM sequences WHERE name = ? LIMIT 1`).get(rc.race_winner);
      response.raceWinner = {
        sequence:     rc.race_winner,
        playlistIndex: winSeq ? winSeq.sort_order : 0,
        // A race that ends with the song plays its winner next, never mid-song.
        interrupt:    !raceEndsWithSong && cfg.race_interrupt_winner === 1,
      };
      rememberHandoff(rc.race_winner, 'vote');
    }
  }

  // Snapshot the main-playlist "next" at handoff time so the viewer shows the
  // correct return point while the interrupting song plays. Only save on the
  // first handoff — if a second vote/request wins before the main playlist
  // resumes, the original baseline is still where FPP will return to.
  if (response.winningVote || response.nextRequest || response.raceWinner) {
    const npState = db.prepare('SELECT next_sequence_name, baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
    if (npState && !npState.baseline_next_sequence_name && npState.next_sequence_name) {
      setBaselineNext(npState.next_sequence_name);
    }
  }

  // Playlist patches (v0.33.152+): when cooldown_suppress_fpp_playlist is
  // enabled, sequences in cooldown are disabled in FPP's playlist JSON so
  // FPP skips them in normal rotation. Off by default -- opt-in only, since
  // not all operators want ShowPilot reaching into their FPP playlist.
  // Requires plugin v0.13.40+.
  if (cfg.cooldown_suppress_fpp_playlist === 1) {
    // v0.33.258: tiered cooldowns in songs or minutes (lib/cooldown.js).
    // A songs-based cooldown has no end time, so reenableAt is a generous
    // estimate (10 minutes per song still to play); the patch is resent on
    // every poll and turns into enabled:true as soon as the cooldown ends.
    const cdLib = require('../lib/cooldown');
    const cooldownCandidates = db.prepare(`
      SELECT name, category, last_played_at, plays_since_hidden, cooldown_minutes, cooldown
      FROM sequences
      WHERE last_played_at IS NOT NULL
    `).all();
    const catMap = cdLib.categoryMap(cfg);
    const now = Date.now();
    const patches = [];
    for (const s of cooldownCandidates) {
      if (!(cdLib.effective(s, cfg, catMap) > 0)) continue;
      const st = cdLib.status(s, cfg, catMap, now);
      patches.push({
        sequenceName: s.name,
        enabled: !st,
        reenableAt: st ? (st.until || new Date(now + st.left * 10 * 60_000).toISOString()) : null,
      });
    }
    if (patches.length > 0) response.playlistPatches = patches;
  }

  res.json(response);
});

// ============================================================
// Handoff tracking — short-lived in-memory map of "we just handed
// this sequence to FPP, so when it starts playing it counts as a
// viewer-driven play, not a schedule fill."
// ============================================================
const pendingHandoffs = new Map(); // sequence_name -> { source, expiresAt }
const HANDOFF_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function rememberHandoff(sequenceName, source) {
  if (!sequenceName) return;
  pendingHandoffs.set(sequenceName, {
    source,
    expiresAt: Date.now() + HANDOFF_WINDOW_MS,
  });
}

function consumeHandoff(sequenceName) {
  const entry = pendingHandoffs.get(sequenceName);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingHandoffs.delete(sequenceName);
    return null;
  }
  pendingHandoffs.delete(sequenceName);
  return entry.source;
}

// Periodic cleanup of expired handoffs
setInterval(() => {
  const now = Date.now();
  for (const [name, entry] of pendingHandoffs.entries()) {
    if (now > entry.expiresAt) pendingHandoffs.delete(name);
  }
}, 60 * 1000);

// Periodic cleanup of stale queue entries — handed off but never confirmed.
// Anything older than 5 minutes (handed-off) or 2 hours (un-handed) is
// marked played to keep the queue clean across plugin restarts.
setInterval(() => {
  const { cleanupStaleHandoffs, cleanupStaleRequests } = require('../lib/db');
  cleanupStaleHandoffs(300);
  cleanupStaleRequests(120);
}, 60 * 1000);

// ============================================================
// POST /api/plugin/playing
// ============================================================
router.post('/playing', (req, res) => {
  const { sequence, seconds_played } = req.body || {};
  const name = (sequence || '').trim();

  // Detect if this is a fresh sequence change (different from what was playing)
  // BEFORE setNowPlaying overwrites it. We use this to advance the voting
  // round on ANY song change in voting mode, not just when the winner plays.
  // (See round-close logic below.)
  const previouslyPlaying = db.prepare(`SELECT sequence_name FROM now_playing WHERE id = 1`).get();
  const isSequenceChange = !!name && (!previouslyPlaying || previouslyPlaying.sequence_name !== name);

  // When the main playlist resumes at the expected return point, clear the
  // baseline so subsequent "Up Next" display switches back to FPP's live report.
  if (isSequenceChange && name) {
    const npBaseline = db.prepare('SELECT baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
    if (npBaseline && npBaseline.baseline_next_sequence_name === name) {
      setBaselineNext(null);
    }
  }

  // FPP stopped (the plugin reports an empty sequence when idle). Nothing is
  // going to resume, so the return point is meaningless; left in place it
  // pins "Up Next" to that song indefinitely.
  if (!name) {
    setBaselineNext(null);
  }

  // If the plugin reported a playback position, backdate started_at so the
  // audio player knows the song has been playing for that long. This handles
  // the "interrupt-then-resume" case: when FPP plays a request and then comes
  // back to the original song mid-track, seconds_played > 0 and we shouldn't
  // pretend the song just started.
  const playedSec = (typeof seconds_played === 'number' && isFinite(seconds_played) && seconds_played > 0)
    ? seconds_played
    : 0;
  setNowPlaying(name || null, playedSec);

  if (name) {
    // Determine source: was this sequence just handed out to the plugin (viewer-driven),
    // or is FPP playing it from the schedule on its own?
    // A request waiting in the show player's queue can start more than 5
    // minutes after it was handed over (the in-memory handoff note expires),
    // so a handed-over queue entry with this name also counts as a request.
    const handoffSource = consumeHandoff(name) || (db.prepare(
      `SELECT 1 FROM jukebox_queue WHERE sequence_name = ? AND played = 0 AND handed_off_at IS NOT NULL LIMIT 1`
    ).get(name) ? 'request' : null);
    const source = handoffSource || 'schedule';

    db.prepare(`
      INSERT INTO play_history (sequence_name, played_at, source)
      VALUES (?, CURRENT_TIMESTAMP, ?)
    `).run(name, source);

    // If this is a viewer-requested song, mark its queue entry as played now
    // (transitions from handed-off → confirmed-played)
    if (source === 'request') {
      const { markQueueEntryPlayed } = require('../lib/db');
      markQueueEntryPlayed(name);
      const io = req.app.get('io');
      if (io) io.emit('queueUpdated');
    } else if (isSequenceChange && source !== 'psa') {
      // Another song started while a request was handed over and waiting
      // (one at a time, so it should have been next). Allow one such pass
      // (the request can land one song late), then drop it so a song the
      // show player can't play doesn't hold up everyone else's requests.
      const waiting = db.prepare(`SELECT id, sequence_name, skip_count FROM jukebox_queue
        WHERE played = 0 AND handed_off_at IS NOT NULL`).all();
      for (const w of waiting) {
        if ((w.skip_count || 0) + 1 >= 2) {
          db.prepare(`UPDATE jukebox_queue SET played = 1, played_at = CURRENT_TIMESTAMP, skip_count = skip_count + 1 WHERE id = ?`).run(w.id);
          console.warn(`[queue] "${w.sequence_name}" was handed to the show player but other songs played instead; dropping it from the queue. Check that the show player can play "${w.sequence_name}".`);
        } else {
          db.prepare(`UPDATE jukebox_queue SET skip_count = skip_count + 1 WHERE id = ?`).run(w.id);
          console.warn(`[queue] "${name}" started while "${w.sequence_name}" was handed to the show player and waiting; it gets one more song to start`);
        }
      }
      if (waiting.length) { const io = req.app.get('io'); if (io) io.emit('queueUpdated'); }
    }

    // ---- Voting round close (v0.23.10+) ----
    // The round advances whenever the playing sequence changes while in
    // VOTING mode, regardless of whether the new song was the vote winner
    // or a schedule fill. Earlier (v0.23.7) we only advanced when the
    // winner ACTUALLY played, but that broke when the plugin couldn't
    // queue the winner in time — the round never closed and viewers got
    // "already voted" forever. The cleaner model: each song = one round.
    //
    // If the winner did play, the toast still fires. If not, votes still
    // reset so the next round starts fresh.
    //
    // Diagnostic logging: log every /playing report with mode + change
    // detection + handoff source. Helps debug "round stuck" issues.
    const cfgForRound = getConfig();
    console.log(`[playing] seq="${name}" source=${source} mode=${cfgForRound.viewer_control_mode} isChange=${isSequenceChange}`);

    // A schedule song starting means the interruption is over, so the
    // baseline has served its purpose even if FPP didn't resume exactly on it
    // (manual jump/restart, cooldown skip, schedule change, playlist end).
    // Without this, Voting/Race modes only cleared the baseline when that
    // exact song started, so one missed return pinned "Up Next" to it for
    // good. Jukebox additionally waits for its queue to drain.
    if (isSequenceChange && source === 'schedule') {
      const queueEmpty = !['JUKEBOX', 'LISTEN'].includes(cfgForRound.viewer_control_mode) || db.prepare(
        `SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0`
      ).get().n === 0;
      if (queueEmpty) {
        const npBaseline = db.prepare(
          `SELECT baseline_next_sequence_name FROM now_playing WHERE id = 1`
        ).get();
        if (npBaseline && npBaseline.baseline_next_sequence_name &&
            npBaseline.baseline_next_sequence_name !== name) {
          setBaselineNext(null);
        }
      }
    }

    const isVoting = cfgForRound.viewer_control_mode === 'VOTING';
    // A PSA starting doesn't end the voting round: the votes cast so far
    // carry over and the winner plays after the PSA. Before, the PSA counted
    // as the round's song, so the votes were cleared and the winner never
    // played.
    const psaStarting = source === 'psa' ||
      !!(db.prepare(`SELECT is_psa FROM sequences WHERE name = ?`).get(name) || {}).is_psa;
    if (isVoting && isSequenceChange && psaStarting) {
      console.log(`[playing] PSA "${name}" started; voting round ${cfgForRound.current_voting_round} stays open`);
    }
    if (isVoting && isSequenceChange && !psaStarting && cfgForRound.reset_votes_after_round) {
      // Determine if this song change is a tiebreak resolution.
      // Tiebreak rules:
      //   - If the winning sequence (by handoff) is a tiebreak candidate
      //     AND tiebreak was active → tiebreak resolved successfully.
      //   - If tiebreak was active but song change happened to something
      //     else (FPP played schedule because winner couldn't queue in
      //     time) → tiebreak failed; emit tiebreakFailed.
      //   - If no tiebreak was active → normal round-end behavior.
      // Either way, the round advances now — song change always ends
      // the round. This makes the tiebreak window naturally cap at
      // current-song-end even if the configured timer is longer.
      let winnerInfo = null;
      const wasTiebreak = cfgForRound.tiebreak_active === 1;
      const tiebreakCandidates = (cfgForRound.tiebreak_candidates || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      if (source === 'vote') {
        const seqRow = db.prepare(`
          SELECT display_name, name, image_url, artist
          FROM sequences WHERE name = ? COLLATE NOCASE
        `).get(name);
        winnerInfo = {
          sequenceName: name,
          displayName: (seqRow && seqRow.display_name) || name,
          artist: (seqRow && seqRow.artist) || '',
          imageUrl: (seqRow && seqRow.image_url) || '',
        };
      }

      // Clear BOTH main-round and tiebreak votes for the closing round.
      clearVotesForRound(cfgForRound.current_voting_round);
      // If a tiebreak was active, clear that state too.
      if (wasTiebreak) clearTiebreakState();
      advanceVotingRound();
      const io = req.app.get('io');
      if (io) {
        io.emit('voteReset');
        if (winnerInfo) {
          // Vote-winning song actually played. Fire the celebratory toast.
          io.emit('votingRoundEnded', winnerInfo);
        } else if (wasTiebreak) {
          // Tiebreak was open but song change happened without a vote
          // winner playing. Either the timer expired (handled in /state)
          // or FPP played its scheduled song before tiebreak could
          // resolve. Tell viewers the tiebreak failed so they can
          // dismiss the banner.
          io.emit('tiebreakFailed', {
            candidates: tiebreakCandidates,
            reason: 'song changed before tiebreak resolved',
          });
        }
      }
    }

    // ---- Race mode: reset taps on every song change (v0.33.155+) ----
    // When the winning song starts (or any song change while in RACE mode),
    // clear all taps and start a fresh race for the new song.
    // This also naturally handles the "prevent taps after race ends" case:
    // resolveRace() sets race_winner and race_active=0; the tap endpoint
    // rejects taps when race_winner is set; on the next song change we
    // re-arm and clear the winner so tapping is allowed again.
    const isRace = cfgForRound.viewer_control_mode === 'RACE';
    if (isRace && isSequenceChange) {
      const { resetRaceTaps } = require('../lib/db');
      const viewerModule = require('./viewer');
      const io = req.app.get('io');
      // Re-arm: start a fresh race for this song
      const freshEndsAt = viewerModule.startRace(cfgForRound);
      if (io) {
        io.emit('raceStarted', { endsAt: freshEndsAt });
        io.emit('raceTapUpdate', { counts: [], bars: {}, leadingSequence: null });
      }
      // Schedule server-side timer for the new race
      if (freshEndsAt) {
        const ms = new Date(freshEndsAt).getTime() - Date.now();
        if (ms > 0) {
          const { getRaceLeader } = require('../lib/db');
          viewerModule._raceTimerHandle = setTimeout(() => {
            viewerModule._raceTimerHandle = null;
            const latestCfg = getConfig();
            if (latestCfg.race_active && !latestCfg.race_winner) {
              const leader = getRaceLeader();
              if (leader) {
                const seqRow = db.prepare(`SELECT display_name, artist FROM sequences WHERE name = ? LIMIT 1`).get(leader.sequence_name);
                viewerModule.resolveRace(io, leader.sequence_name, seqRow?.display_name || leader.sequence_name, seqRow?.artist || '', leader.count);
              } else {
                db.prepare(`UPDATE config SET race_active = 0 WHERE id = 1`).run();
                if (io) io.emit('raceEnded', { noWinner: true });
              }
            }
          }, Math.max(ms, 0));
        }
      }
    }

    // Mark this sequence as played; reset its hidden counter
    // (only update sequences we actually know about — schedule fillers
    // may not be in our pool)
    db.prepare(`
      UPDATE sequences
      SET last_played_at = CURRENT_TIMESTAMP, plays_since_hidden = 0
      WHERE name = ?
    `).run(name);

    // Increment plays_since_hidden on all OTHER sequences (unhides them over time)
    db.prepare(`
      UPDATE sequences
      SET plays_since_hidden = plays_since_hidden + 1
      WHERE name != ? AND last_played_at IS NOT NULL
    `).run(name);

    // Per-sequence cooldown (v0.29.2+): if the sequence that just started
    // has cooldown_minutes > 0, purge any OTHER pending requests for the
    // same sequence so it can't immediately repeat. We delete only entries
    // that haven't been handed off to FPP yet (handed_off_at IS NULL) —
    // an in-flight entry is the one currently playing or about to start
    // and shouldn't be removed. The cooldown timer itself is implicit:
    // last_played_at + cooldown_minutes is checked at request/voting time.
    // v0.33.258: the song's cooldown may come from itself, its category or
    // the show-wide setting (lib/cooldown.js).
    const seq = db.prepare(`SELECT id, category, cooldown_minutes, cooldown, is_psa FROM sequences WHERE name = ?`).get(name);
    const seqCooldown = seq ? require('../lib/cooldown').effective(seq, getConfig()) : 0;
    if (seq && seqCooldown > 0) {
      const purged = db.prepare(`
        DELETE FROM jukebox_queue
        WHERE sequence_id = ? AND played = 0 AND handed_off_at IS NULL
      `).run(seq.id);
      if (purged.changes > 0) {
        console.log(`[cooldown] Purged ${purged.changes} queued copies of "${name}" (cooldown ${seqCooldown})`);
      }
    }

    // Sequence-based PSA counter (v0.30.0+). Increment on every NON-PSA
    // sequence transition. PSAs themselves don't count toward the next
    // PSA — otherwise frequency=1 would loop PSA→PSA forever. We also
    // only increment for sequences ShowPilot knows about (seq is non-null);
    // schedule fillers FPP plays that aren't in our DB don't count. The
    // counter increments regardless of psa_trigger_mode so switching
    // modes doesn't lose history. The threshold check in /state decides
    // whether to consult it.
    if (seq && !seq.is_psa) {
      db.prepare(`UPDATE config SET sequences_since_last_psa = sequences_since_last_psa + 1 WHERE id = 1`).run();
    } else if (seq && seq.is_psa) {
      // A PSA has actually started: reset the counter we count with.
      resetPsaCounter(cfgForRound.psa_trigger_mode === 'sequences' ? 'sequences' : 'interactions');
      psaHandout = null;
    }
  }

  const io = req.app.get('io');
  if (io) io.emit('nowPlaying', { sequenceName: name || null });

  // Relay disabled — audio sync now uses cache delivery + WebSocket position
  // correction via fppPosition events from the daemon. The relay was opening
  // one connection to FPP per song change and streaming bytes that nobody
  // was connecting to, wasting CPU and bandwidth.

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/position
// Plugin reports FPP's live playback position. Called every ~500ms
// while audio is playing. Updates in-memory livePosition and pushes
// to all viewer clients via socket.io for near-real-time sync.
//
// This is the new high-cadence position channel. The /playing
// endpoint stays for track-change events (which establish the
// initial anchor for new sequences); /position keeps the position
// fresh during a track. Both can fire — they don't conflict.
//
// Body: { sequence: string, position: number }
// ============================================================
router.post('/position', (req, res) => {
  const { sequence, position } = req.body || {};
  const name = (sequence || '').trim();
  const pos = (typeof position === 'number' && isFinite(position) && position >= 0)
    ? position : null;

  if (!name || pos === null) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  // Stamp arrival time using server clock. Viewers will use this to
  // extrapolate forward: actualPosition = position + (now - updatedAt) / 1000
  livePosition = {
    sequence: name,
    position: pos,
    updatedAt: Date.now(),
  };

  // Bump now_playing.last_updated so the viewer's showNotPlaying gate
  // (in routes/viewer.js#visual-config) sees a fresh heartbeat. Without
  // this, last_updated only advances on sequence CHANGE (via setNowPlaying),
  // which means it goes stale within seconds of a song starting and the
  // viewer flaps to "Show isn't playing." Plugin reports /position every
  // ~1s while a sequence is playing, so this naturally keeps the row
  // fresh and goes stale within seconds when the plugin stops reporting
  // (FPP idle / plugin hung / network partition).
  //
  // Guard with sequence_name match: if the server has already advanced
  // to a new sequence (via /playing) when a stale /position for the old
  // sequence races in, don't overwrite. The mismatched UPDATE is a no-op.
  db.prepare(`
    UPDATE now_playing
    SET last_updated = CURRENT_TIMESTAMP
    WHERE id = 1 AND sequence_name = ?
  `).run(name);

  // The same sequence started over (a sequence on repeat, or FPP restarted
  // it): the plugin only reports /playing when the NAME changes, so
  // started_at still points at the first run and the progress bar sat full
  // (GitHub #37). A jump back of more than 3 s re-anchors it; normal jitter
  // is far smaller, so the stable anchor rule in setNowPlaying still holds.
  const np = db.prepare(`SELECT started_at FROM now_playing WHERE id = 1 AND sequence_name = ?`).get(name);
  if (np && np.started_at) {
    const startedMs = new Date(np.started_at.replace(' ', 'T') + 'Z').getTime();
    const elapsed = (Date.now() - startedMs) / 1000;
    if (isFinite(elapsed) && pos + 3 < elapsed) {
      const startedAt = new Date(Date.now() - Math.round(pos * 1000)).toISOString().replace('T', ' ').replace('Z', '');
      db.prepare(`UPDATE now_playing SET started_at = ? WHERE id = 1 AND sequence_name = ?`).run(startedAt, name);
      const io0 = req.app.get('io');
      if (io0) io0.emit('nowPlaying', { sequenceName: name });
    }
  }

  // Emit to all connected viewers. They'll use this as the freshest
  // anchor for sync — replaces extrapolating from a stale started_at.
  const io = req.app.get('io');
  if (io) {
    io.emit('positionUpdate', {
      sequence: name,
      position: pos,
      updatedAt: livePosition.updatedAt,
    });
  }

  // Plugin doesn't care about response body — just status.
  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/next
// ============================================================
router.post('/next', (req, res) => {
  const { sequence, exact } = req.body || {};
  const name = (sequence || '').trim();

  // exact: the plugin/Player read this from the live play order (shuffle
  // included), so an empty value is the truth, not "unknown".
  setNextScheduled(name || null, exact === true);

  // Interrupt-mode detection: cfg.interrupt_schedule may not be set when the
  // FPP plugin manages its own interrupt flag independently. Instead, detect
  // interrupt mode by observing FPP's behavior: when a jukebox song is playing
  // and FPP reports the last scheduled song as "next," FPP is in interrupt mode
  // and that song is the return point after the queue drains. Update the
  // baseline now so Tier 3 immediately shows the correct song.
  //
  // In non-interrupt mode FPP reports null (end of request playlist) or the
  // main-playlist continuation (Song B), which won't match the last scheduled
  // song (Song A), so the existing baseline is left untouched.
  if (name) {
    const npNow = db.prepare('SELECT sequence_name FROM now_playing WHERE id = 1').get();
    const nowPlayingName = npNow && npNow.sequence_name;
    if (nowPlayingName) {
      const isJukeboxPlaying = db.prepare(`
        SELECT COUNT(*) AS n FROM jukebox_queue
        WHERE sequence_name = ? COLLATE NOCASE
          AND (played = 1 OR handed_off_at IS NOT NULL)
      `).get(nowPlayingName).n > 0;
      if (isJukeboxPlaying) {
        const lastScheduled = db.prepare(`
          SELECT sequence_name FROM play_history
          WHERE source = 'schedule'
          ORDER BY played_at DESC LIMIT 1
        `).get();
        if (lastScheduled && lastScheduled.sequence_name === name) {
          const npBaseline = db.prepare('SELECT baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
          if (!npBaseline || npBaseline.baseline_next_sequence_name !== name) {
            setBaselineNext(name);
          }
        }
      }
    }
  }

  const io = req.app.get('io');
  if (io) {
    // Emit the baseline if set (main-playlist return point), otherwise FPP's
    // live report. The baseline update above runs first so interrupt mode
    // immediately emits the correct return song.
    const npBaseline = db.prepare('SELECT baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
    const emitName = (npBaseline && npBaseline.baseline_next_sequence_name) || name || null;
    io.emit('nextScheduled', { sequenceName: emitName });
  }

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/heartbeat
// ============================================================
router.post('/heartbeat', (req, res) => {
  pluginStatus.lastSeen = new Date().toISOString();
  pluginStatus.version = req.body?.pluginVersion || null;
  // Capture the plugin's source IP — this is FPP's address, used as the
  // upstream for audio proxy streams. We strip ::ffff: prefix from IPv4-mapped
  // IPv6 addresses, and ignore localhost (means ShowPilot is on FPP itself).
  let fppHost = req.ip || req.connection?.remoteAddress || null;
  if (fppHost && fppHost.startsWith('::ffff:')) fppHost = fppHost.slice(7);
  if (fppHost === '::1' || fppHost === '127.0.0.1') fppHost = null;

  // Reject public IPs as fppHost. The audio proxy uses this value as the
  // upstream — if an attacker had a compromised showToken AND could spoof
  // their source IP, an unvalidated value here would allow them to redirect
  // every audio-stream request to any internet host (SSRF). FPP only ever
  // runs on a LAN, so a private-IP-only check is correct.
  if (fppHost && !isPrivateLanIp(fppHost)) {
    console.warn(`[plugin] Rejecting non-private fppHost: ${fppHost} (heartbeat ignored for IP storage)`);
    fppHost = null;
  }

  // Persist so server restarts don't lose state. We only update plugin_fpp_host
  // when we have a valid value — otherwise we'd clobber a known-good value
  // every time a malformed heartbeat arrived.
  const updates = {
    plugin_last_seen_at: pluginStatus.lastSeen,
    plugin_version: pluginStatus.version,
    // A show player that checks for its own updates says which version is
    // newest (beta.18+); the Dashboard banner uses it.
    plugin_latest_reported: (typeof req.body?.latestVersion === 'string' && /^\d+\.\d+\.\d+/.test(req.body.latestVersion))
      ? req.body.latestVersion.slice(0, 32) : null,
  };
  if (fppHost) updates.plugin_fpp_host = fppHost;
  updateConfig(updates);
  pluginStatus.fppHost = fppHost || pluginStatus.fppHost;
  // The FPP plugin (0.14.22+) shows a warning in FPP when a newer version is
  // out; tell it which. Other show players check for their own updates.
  const isFppPlugin = pluginStatus.version && !/^player-/i.test(String(pluginStatus.version));
  // Show buttons (v0.33.278-master.12+): tells the plugin whether to ask for
  // button presses (GET /show-buttons) about twice a second. Older plugins
  // ignore it.
  const showButtons = require('../lib/show-buttons').pluginWanted(getConfig());
  // FPP monitor (v0.33.278-master.13+): ask for status snapshots
  // (POST /fpp-status). Older plugins ignore it.
  const fppMonitor = true;
  res.json(isFppPlugin ? { ok: true, showButtons, fppMonitor, ...require('../lib/show-player-update').forPlugin() } : { ok: true, showButtons, fppMonitor });
});

// ============================================================
// POST /api/plugin/fpp-status (v0.33.278-master.13+, lib/fpp-monitor.js)
// The show player's status snapshot for the FPP page:
//   { status: <FPP /api/system/status>, multisync: <FPP /api/fppd/multiSyncSystems>,
//     disk: {freeBytes, totalBytes}, now: <epoch s>, playlists?: [..], presets?: [..],
//     results?: [{id, ok, message}], source?: 'fpp'|'player',
//     remoteStatus?: { '<remote address>': <that remote's /api/system/status> } }  (plugin 0.14.27+)
// Answer: { ok, commands: [{id, action, name?}], nextInSec }.
// ============================================================
router.post('/fpp-status', (req, res) => {
  res.json(require('../lib/fpp-monitor').report(req.body || {}, { pluginVersion: pluginStatus.version }));
});

// ============================================================
// GET /api/plugin/show-buttons (v0.33.278-master.12+, lib/show-buttons.js)
// The plugin takes the button presses waiting for it, oldest first, and runs
// each with FPP's POST /api/command:
//   { presses: [ { id, command: 'Effect Start', args: ['Fog.eseq', '0', ...] } ],
//     showButtons: true|false }
// showButtons false = turned off since the last heartbeat; stop asking.
// Presses not taken within 15 s are dropped, so nothing fires late.
// ============================================================
router.get('/show-buttons', (req, res) => {
  const sb = require('../lib/show-buttons');
  res.json({ presses: sb.take(), showButtons: sb.pluginWanted(getConfig()) });
});

// ============================================================
// POST /api/plugin/sync-sequences
// Plugin pushes the current FPP playlist contents.
// Body: {
//   playlistName: "Remote Falcon Christmas",
//   sequences: [
//     { name: "Wizards_in_Winter", displayName: "Wizards in Winter", durationSeconds: 240 },
//     ...
//   ]
// }
//
// Behavior: upsert sequences by name (marking them active), then mark every
// sequence that isn't in the new list INACTIVE (v0.33.247+). Inactive
// sequences keep their display name, artist, cover, category and toggles but
// never reach viewers, voting, the jukebox or the schedule fallback; when a
// later sync lists the name again (e.g. next season's playlist) it comes back
// active with everything intact. v0.33.236–246 deleted them instead, and
// before that they stayed on the viewer page. An empty list never changes
// anything (a playlist FPP couldn't read is far more likely than an empty show).
// ============================================================
router.post('/sync-sequences', (req, res) => {
  const { playlistName, sequences } = req.body || {};

  if (!Array.isArray(sequences)) {
    return res.status(400).json({ error: 'sequences must be an array' });
  }

  // For inserts: display_order defaults to sort_order so new sequences sort naturally.
  // For updates: only touch sort_order (FPP index) + display_name. display_order is admin-owned.
  const upsert = db.prepare(`
    INSERT INTO sequences (name, display_name, artist, image_url, media_name, duration_seconds, visible, votable, jukeboxable, sort_order, display_order)
    VALUES (@name, @display_name, @artist, @image_url, @media_name, @duration_seconds, 1, 1, 1, @sort_order, @sort_order)
    ON CONFLICT(name) DO UPDATE SET
      active = 1,
      duration_seconds = excluded.duration_seconds,
      sort_order = excluded.sort_order,
      -- media_name comes straight from FPP — always trust the plugin's value
      media_name = excluded.media_name,
      -- display_name is preserved if it was customized — only update if it's still
      -- the default (NULL, empty, or equal to the raw filename name).
      display_name = CASE
        WHEN sequences.display_name IS NULL
             OR sequences.display_name = ''
             OR sequences.display_name = sequences.name
        THEN excluded.display_name
        ELSE sequences.display_name
      END,
      -- artist is the same idea: only fill if not already set
      artist = CASE
        WHEN (sequences.artist IS NULL OR sequences.artist = '')
             AND excluded.artist IS NOT NULL AND excluded.artist != ''
        THEN excluded.artist
        ELSE sequences.artist
      END,
      -- image_url: only set from sync if no image already exists. This protects
      -- manually-uploaded album art from being overwritten by a tag-derived URL.
      image_url = CASE
        WHEN (sequences.image_url IS NULL OR sequences.image_url = '')
             AND excluded.image_url IS NOT NULL AND excluded.image_url != ''
        THEN excluded.image_url
        ELSE sequences.image_url
      END
  `);

  const toDisplayName = (fppName) =>
    String(fppName || '')
      .replace(/[_\-]+/g, ' ')          // underscores and dashes → spaces
      .replace(/\s+/g, ' ')             // collapse whitespace
      .trim();

  // A song listed more than once in the playlist (v0.33.249+) is still one
  // sequence (votes, cooldowns, categories and the viewer list are per name).
  // Its FIRST position is kept, which is also the copy the plugin falls back
  // to when it looks the song up by name; later copies used to overwrite it.
  // The duplicates are reported on the Sequences page.
  let inserted = 0;
  const firstAt = new Map();      // name -> index into duplicates or -1
  const duplicates = [];          // [{ name, positions: [first, ...later] }]
  let renamed = [];
  const tx = db.transaction((items) => {
    // v0.33.256: a song stored under a garbled name ("Idina Menzel â€“ …")
    // that the show player now sends correctly keeps its row (display name,
    // artist, cover, category, history) instead of becoming a new song.
    renamed = require('../lib/mojibake').adoptRenamed(db, items.map((s) => s && s.name));
    items.forEach((seq, index) => {
      const name = String(seq.name || '').trim();
      if (!name) return;
      const position = Number.isFinite(seq.playlistIndex) ? seq.playlistIndex : (index + 1);
      if (firstAt.has(name)) {
        const d = firstAt.get(name);
        if (d.dup === null) { d.dup = duplicates.length; duplicates.push({ name, positions: [d.position] }); }
        duplicates[d.dup].positions.push(position);
        return;
      }
      firstAt.set(name, { position, dup: null });
      upsert.run({
        name,
        display_name: String(seq.displayName || toDisplayName(name)).trim(),
        artist: String(seq.artist || '').trim() || null,
        image_url: String(seq.imageUrl || '').trim() || null,
        media_name: String(seq.mediaName || '').trim() || null,
        duration_seconds: Number.isFinite(seq.durationSeconds) ? seq.durationSeconds : null,
        sort_order: position,
      });
      inserted++;
    });
  });
  tx(sequences);
  if (renamed.length) console.log(`[sync] fixed garbled sequence name${renamed.length === 1 ? '' : 's'}: ${renamed.map((r) => `"${r.from}" -> "${r.to}"`).join(', ')}`);

  // Mark sequences no longer in the playlist inactive (v0.33.247+) — kept
  // with all their customizations, but out of the viewer page, voting and
  // the jukebox. Their pending requests and votes are cleared (the show
  // player can't play them anyway).
  const keep = new Set(sequences.map((s) => String((s && s.name) || '').trim()).filter(Boolean));
  let removed = 0;
  if (keep.size) {
    const stale = db.prepare(`SELECT id, name, media_name FROM sequences WHERE active = 1`).all().filter((r) => !keep.has(r.name));
    if (stale.length) {
      const delQueue = db.prepare(`DELETE FROM jukebox_queue WHERE sequence_id = ?`);
      const delVotes = db.prepare(`DELETE FROM votes WHERE sequence_id = ?`);
      const deactivate = db.prepare(`UPDATE sequences SET active = 0 WHERE id = ?`);
      db.transaction(() => {
        for (const r of stale) { delQueue.run(r.id); delVotes.run(r.id); removed += deactivate.run(r.id).changes; }
      })();
      console.log(`[sync] marked ${removed} sequence(s) inactive (no longer in the playlist): ${stale.map((r) => r.name).join(', ')}`);
    // Cached audio for a media file no ACTIVE sequence uses is dropped; it
    // is fetched again if the sequence returns to the playlist.
    const dropCache = db.prepare(`DELETE FROM audio_cache_files WHERE media_name = ?
      AND NOT EXISTS (SELECT 1 FROM sequences WHERE media_name = ? AND active = 1)`);
    for (const r of stale) {
      if (r.media_name) { try { dropCache.run(r.media_name, r.media_name); } catch (e) { console.warn('[sync] cache cleanup:', e.message); } }
    }
    }
  }

  // Track sync metadata + persist so it survives server restarts
  pluginStatus.lastSyncAt = new Date().toISOString();
  pluginStatus.lastSyncPlaylist = playlistName || null;
  pluginStatus.lastSyncCount = inserted;
  pluginStatus.lastSyncDuplicates = duplicates;
  if (duplicates.length) {
    console.log(`[sync] listed more than once (first position kept): ${duplicates.map((d) => `${d.name} @ ${d.positions.join(', ')}`).join('; ')}`);
  }
  updateConfig({
    plugin_last_sync_duplicates: JSON.stringify(duplicates),
    plugin_last_sync_at: pluginStatus.lastSyncAt,
    plugin_last_sync_playlist: pluginStatus.lastSyncPlaylist,
    plugin_last_sync_count: pluginStatus.lastSyncCount,
  });

  const io = req.app.get('io');
  if (io) io.emit('sequencesSynced', { count: inserted, removed, playlistName });

  res.json({ ok: true, synced: inserted, removed });

  // After responding, kick off auto-cover-fetch for any sequences without art.
  // Runs detached — sync response is already sent. Rate-limited internally.
  setImmediate(async () => {
    try {
      const missing = db.prepare(`
        SELECT id, name, display_name, artist FROM sequences
        WHERE (image_url IS NULL OR image_url = '') AND visible = 1
      `).all();
      if (missing.length === 0) return;

      const { autoFetchCover } = require('../lib/cover-art');
      const update = db.prepare(`UPDATE sequences SET image_url = ? WHERE id = ?`);
      console.log(`[cover-art] Auto-fetching covers for ${missing.length} sequences`);

      for (const seq of missing) {
        try {
          const localPath = await autoFetchCover(seq);
          if (localPath) {
            update.run(localPath, seq.id);
            console.log(`[cover-art] Got cover for ${seq.display_name || seq.name}`);
          }
        } catch (e) {
          console.warn(`[cover-art] Failed for ${seq.name}:`, e.message);
        }
        // Rate limit — MusicBrainz is 1 req/s per UA
        await new Promise(r => setTimeout(r, 1100));
      }
      console.log(`[cover-art] Auto-fetch complete`);
    } catch (e) {
      console.error('[cover-art] Auto-fetch crashed:', e.message);
    }
  });
});

// ============================================================
// POST /api/plugin/viewer-mode
// Body: { mode: "VOTING" | "JUKEBOX" | "RACE" | "OFF" | "ON" }
//
// Special cases:
//   mode = "ON"  — restore viewer control to the last non-OFF mode
//                  (useful for "Turn On" FPP commands that shouldn't
//                  hardcode a voting vs jukebox choice)
//   mode = "OFF" — also stashes the current mode so ON can restore it
//
// RACE mode activates tap-as-fast-as-you-can competitive voting.
// The race timer and settings are configured in the ShowPilot admin UI;
// this command simply switches the viewer_control_mode to RACE so the
// scheduler can trigger a race at a specific playlist position.
//
// Used by FPP scheduler commands to toggle viewer control at showtime.
// Auth: same Bearer token as other plugin endpoints.
// ============================================================
router.post('/viewer-mode', (req, res) => {
  const { mode: requested } = req.body || {};
  const allowed = ['VOTING', 'JUKEBOX', 'RACE', 'LISTEN', 'OFF', 'ON'];

  if (!requested || !allowed.includes(requested)) {
    return res.status(400).json({
      error: 'mode must be VOTING, JUKEBOX, RACE, LISTEN, OFF, or ON',
    });
  }

  const { updateConfig, RESTORABLE_MODES } = require('../lib/db');
  const cfg = getConfig();
  let newMode;

  if (requested === 'ON') {
    // Restore the last active mode (defaults to VOTING)
    newMode = RESTORABLE_MODES.includes(cfg.last_active_mode) ? cfg.last_active_mode : 'VOTING';
    updateConfig({ viewer_control_mode: newMode });
  } else if (requested === 'OFF' || requested === 'LISTEN') {
    // Stash the current mode (if it's an active one) before switching.
    // LISTEN (Listen Only, v0.33.249+): the page stays up and phone audio
    // works, but votes and requests are closed.
    const updates = { viewer_control_mode: requested };
    if (RESTORABLE_MODES.includes(cfg.viewer_control_mode)) {
      updates.last_active_mode = cfg.viewer_control_mode;
    }
    updateConfig(updates);
    newMode = requested;
  } else {
    // Explicit VOTING, JUKEBOX, or RACE — also update last_active_mode
    updateConfig({ viewer_control_mode: requested, last_active_mode: requested });
    newMode = requested;
  }

  const io = req.app.get('io');
  if (io) io.emit('viewerModeChanged', { mode: newMode });

  res.json({ ok: true, mode: newMode, requested });
});

// ============================================================
// POST /api/plugin/queue/clear   (v0.33.249+)
// Empties the request queue, exactly like Clear Queue on the admin's Queue
// page (the recently played list is kept). Used by the "ShowPilot - Clear
// Queue" FPP command, e.g. right before turning viewer control on or off.
// Auth: same Bearer token as other plugin endpoints.
// ============================================================
router.post('/queue/clear', (req, res) => {
  const r = db.prepare(`DELETE FROM jukebox_queue WHERE played = 0`).run();
  console.log(`[queue] cleared by FPP command (${r.changes} request${r.changes === 1 ? '' : 's'})`);
  const io = req.app.get('io');
  if (io) io.emit('queueUpdated');
  res.json({ ok: true, cleared: r.changes });
});

// ============================================================
// POST /api/plugin/category   (v0.33.249+)
// Body: { name: "Kids Songs", enabled: true | false }
// Switches a category on or off, exactly like the toggle in the admin's
// Categories list (a schedule, if set, still applies while it's on). Used by
// the "ShowPilot - Enable Category" / "Disable Category" FPP commands so a
// show schedule can open or close a category. Name match ignores case.
// GET /api/plugin/categories lists the names (for the plugin's command help).
// Auth: same Bearer token as other plugin endpoints.
// ============================================================
router.post('/category', (req, res) => {
  const { name, enabled } = req.body || {};
  const clean = String(name || '').trim();
  if (!clean) return res.status(400).json({ error: 'name is required' });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  const cats = require('../lib/categories');
  const result = cats.setCategoryEnabled(clean, enabled);
  if (result.error) {
    const known = cats.listCategories(getConfig()).map((c) => c.name);
    return res.status(404).json({ error: `No category named "${clean}"`, categories: known });
  }
  const hit = cats.listCategories(getConfig()).find((c) => c.name.toLowerCase() === clean.toLowerCase());
  const canonical = hit ? hit.name : clean;
  console.log(`[category] "${canonical}" switched ${enabled ? 'on' : 'off'} by the show player`);
  const io = req.app.get('io');
  if (io) io.emit('sequencesReordered');
  res.json({ ok: true, name: canonical, enabled });
});

router.get('/categories', (req, res) => {
  const cats = require('../lib/categories');
  res.json({ categories: cats.listCategories(getConfig()).map((c) => ({ name: c.name, enabled: c.enabled ? 1 : 0 })) });
});

// ============================================================
// Viewer page switch by command (v0.33.249+, GitHub #36)
// GET  /api/plugin/viewer-pages        -> { pages: [{ name, active }] }
// POST /api/plugin/viewer-page {name}  -> makes that page live
// Used by the "ShowPilot - Set Viewer Page" command in the FPP plugin and
// other show players. Same effect as Activate in the admin: open viewer
// pages switch live. Names match without regard to capitals.
// ============================================================
router.get('/viewer-pages', (req, res) => {
  const rows = db.prepare('SELECT name, is_active FROM viewer_page_templates ORDER BY name COLLATE NOCASE').all();
  res.json({ pages: rows.map((r) => ({ name: r.name, active: r.is_active ? 1 : 0 })) });
});

router.post('/viewer-page', (req, res) => {
  const clean = String((req.body && req.body.name) || '').trim();
  if (!clean) return res.status(400).json({ error: 'name is required' });
  const rows = db.prepare('SELECT id, name, is_active FROM viewer_page_templates').all();
  const hit = rows.find((r) => r.name === clean) || rows.find((r) => r.name.toLowerCase() === clean.toLowerCase());
  if (!hit) return res.status(404).json({ error: `No viewer page named "${clean}"`, pages: rows.map((r) => r.name) });
  if (!hit.is_active) {
    db.transaction(() => {
      db.prepare('UPDATE viewer_page_templates SET is_active = 0').run();
      db.prepare('UPDATE viewer_page_templates SET is_active = 1 WHERE id = ?').run(hit.id);
    })();
    const io = req.app.get('io');
    if (io) io.emit('viewerTemplateChanged', { templateId: hit.id });
    console.log(`[viewer-page] switched to "${hit.name}" by the show player`);
  }
  res.json({ ok: true, name: hit.name, changed: !hit.is_active });
});

// ============================================================
// GET /api/plugin/health
// ============================================================
router.get('/health', (req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    plugin: pluginStatus,
  });
});

// ============================================================
// AUDIO CACHE — see lib/audio-cache.js for full architecture notes.
// ============================================================
// Plugin pushes audio files to ShowPilot during sync so viewer requests
// can be served from local disk instead of proxying through FPP. This
// scales to many concurrent viewers and dramatically improves audio
// start latency by eliminating the cross-network hop.
//
// Three endpoints:
//   GET  /audio-cache/manifest  — list of hashes ShowPilot already has
//   POST /audio-cache/upload    — upload one file, body is raw bytes
//   POST /audio-cache/link      — associate (mediaName → hash) when
//                                 server already had the file from a
//                                 previous sync
// ============================================================

const audioCache = require('../lib/audio-cache');

// Plugin asks: "what hashes do you already have?" so it can upload only
// what's missing. Returns a flat array — the plugin computes the diff
// against its local file list. Cheap to call, idempotent.
//
// audioEnabled is the master server-side switch that tells the plugin
// whether to bother syncing audio at all. When false, the plugin should
// skip the upload phase entirely (don't even compute hashes — saves
// CPU and disk reads on FPP). The plugin's own "Enable audio sync"
// toggle is a local opt-out; the server's "audio_enabled" is global
// and authoritative. If the server says no, the plugin says no.
router.get('/audio-cache/manifest', (req, res) => {
  const cfg = getConfig();
  const audioEnabled = cfg.audio_enabled !== 0;
  if (!audioEnabled) {
    return res.json({
      audioEnabled: false,
      haveHashes: [],
      fileCount: 0,
      totalBytes: 0,
    });
  }
  const haveHashes = audioCache.getCachedHashes();
  const stats = audioCache.getCacheStats();
  res.json({
    audioEnabled: true,
    haveHashes,
    fileCount: stats.fileCount,
    totalBytes: stats.totalBytes,
  });
});

// Plugin uploads a single file. Query string carries the hash and
// mediaName; body is the raw bytes. We use raw body parsing (not JSON,
// not multipart) to keep the plugin side simple — file bytes go in the
// HTTP body verbatim, no encoding overhead.
//
// Why query string for hash/mediaName? Because the audio body can be
// 5+ MB and we don't want to base64 it into JSON (33% size penalty)
// or wrap it in multipart (more code on both sides for marginal benefit).
//
// Size limit is generous (50MB) — typical 4-min MP3 is 4-5MB but FLAC
// or longer mixes could be larger. Headlining limit is express.json's
// 1mb cap which doesn't apply here because we use express.raw().
router.post(
  '/audio-cache/upload',
  // express.raw with high limit, accepts any content-type. We don't
  // require a specific MIME because FPP could be serving MP3, OGG, FLAC,
  // WAV — whatever the user uploaded to FPP's music dir.
  express.raw({ type: '*/*', limit: '50mb' }),
  (req, res) => {
    // Defense in depth — even if an old plugin hasn't been updated to
    // honor the audioEnabled flag from /manifest, refuse the upload.
    // Admin chose to disable audio for a reason; we don't write 5MB
    // files to disk against their wishes.
    const cfg = getConfig();
    if (cfg.audio_enabled === 0) {
      return res.status(403).json({ error: 'Audio is disabled for this show', audioEnabled: false });
    }
    const claimedHash = String(req.query.hash || '').toLowerCase();
    const mediaName = String(req.query.mediaName || '');
    const mimeType = req.query.mimeType ? String(req.query.mimeType) : (req.headers['content-type'] || 'audio/mpeg');

    if (!audioCache.isValidHash(claimedHash)) {
      return res.status(400).json({ error: 'Invalid hash format' });
    }
    if (!mediaName) {
      return res.status(400).json({ error: 'mediaName required' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty body — expected raw audio bytes' });
    }

    try {
      audioCache.storeUploadedFile(req.body, claimedHash, mediaName, mimeType);
      // Also stamp the hash onto every sequence row whose media_name
      // matches. This is the v0.24.3+ many-to-one fix: cache lookup
      // now goes sequence → audio_hash → cache row, so a sequence
      // without audio_hash won't find its file even if the cache row
      // exists. Multiple sequences with the same media_name (e.g.
      // "indoor+outdoor" and "outdoor only" variants of the same song)
      // all get the same hash here and share the cache row cleanly.
      try {
        db.prepare(
          `UPDATE sequences SET audio_hash = ? WHERE media_name = ?`
        ).run(claimedHash, mediaName);
      } catch (e) {
        console.warn('[audio-cache/upload] could not stamp audio_hash on sequences:', e.message);
      }
      res.json({ ok: true, hash: claimedHash, sizeBytes: req.body.length });
    } catch (err) {
      // Hash mismatch is the most likely cause — return a structured error
      // so the plugin can decide whether to retry or skip.
      res.status(400).json({ error: err.message });
    }
  }
);

// Plugin says: "I have this mediaName mapped to this hash, and you
// already told me you have the hash, so just link them." Avoids
// re-uploading bytes we already have. Common case: same audio file
// appears in multiple sequences, or sync runs after a no-op restart.
router.post('/audio-cache/link', (req, res) => {
  const cfg = getConfig();
  if (cfg.audio_enabled === 0) {
    return res.status(403).json({ error: 'Audio is disabled for this show', audioEnabled: false });
  }
  const { mediaName, hash } = req.body || {};
  if (!hash || !audioCache.isValidHash(String(hash).toLowerCase())) {
    return res.status(400).json({ error: 'Invalid hash format' });
  }
  if (!mediaName) {
    return res.status(400).json({ error: 'mediaName required' });
  }
  try {
    const lowerHash = String(hash).toLowerCase();
    audioCache.linkMediaNameToHash(String(mediaName), lowerHash);
    // Stamp this hash onto every sequence row matching the media_name —
    // see /audio-cache/upload for the rationale. Defensive update
    // covers the case where two FPP sequences share the same audio
    // filename, AND the case where a sequence's media_name was just
    // renamed (the new name maps to the same bytes as before).
    try {
      db.prepare(
        `UPDATE sequences SET audio_hash = ? WHERE media_name = ?`
      ).run(lowerHash, String(mediaName));
    } catch (e) {
      console.warn('[audio-cache/link] could not stamp audio_hash on sequences:', e.message);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Plugin can ask us to clean up cache entries for media files that no
// longer correspond to any sequence. Useful at end of sync to keep
// the cache from growing forever.
router.post('/audio-cache/prune', (req, res) => {
  const removed = audioCache.pruneOrphanedHashes();
  res.json({ ok: true, removed });
});

module.exports = router;
module.exports.pluginStatus = pluginStatus;
module.exports.getLivePosition = getLivePosition;
