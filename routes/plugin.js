// ============================================================
// OpenFalcon — Plugin API
// Endpoints that the OpenFalcon FPP plugin calls.
// Auth: Authorization: Bearer <showToken>
//
// Endpoints:
//   GET  /api/plugin/state            — one call, returns everything FPP needs to act
//   POST /api/plugin/playing          — FPP reports what's playing now
//   POST /api/plugin/next             — FPP reports what's scheduled next
//   POST /api/plugin/heartbeat        — keepalive + plugin version sync
//   POST /api/plugin/sync-sequences   — plugin pushes the full sequence list
//   GET  /api/plugin/health           — plugin status visibility
// ============================================================

const express = require('express');
const router = express.Router();
const config = require('../config');
const {
  getConfig,
  setNowPlaying,
  setNextScheduled,
  getHighestVotedSequence,
  popNextQueuedRequest,
  advanceVotingRound,
  db,
} = require('../lib/db');

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

// Track plugin heartbeats and sync in memory
const pluginStatus = {
  lastSeen: null,
  version: null,
  lastSyncAt: null,
  lastSyncPlaylist: null,
  lastSyncCount: 0,
};

// ============================================================
// GET /api/plugin/state
// ============================================================
router.get('/state', (req, res) => {
  const cfg = getConfig();

  const response = {
    mode: cfg.viewer_control_mode,
    interruptSchedule: cfg.interrupt_schedule === 1,
    managedPsa: cfg.managed_psa_enabled === 1,
    winningVote: null,
    nextRequest: null,
    psa: null,
  };

  // PSA check — if enabled and threshold met, play a PSA instead
  if (cfg.play_psa_enabled &&
      cfg.psa_frequency > 0 &&
      cfg.interactions_since_last_psa >= cfg.psa_frequency) {

    const psa = db.prepare(`
      SELECT name, sort_order FROM sequences
      WHERE is_psa = 1 AND visible = 1
      ORDER BY COALESCE(last_played_at, '1970-01-01') ASC
      LIMIT 1
    `).get();

    if (psa) {
      const psaEntry = { sequence: psa.name, playlistIndex: psa.sort_order };
      response.psa = psaEntry;
      db.prepare(`UPDATE config SET interactions_since_last_psa = 0 WHERE id = 1`).run();

      // Deliver PSA via the mode-appropriate slot so plugin acts on it
      if (cfg.viewer_control_mode === 'VOTING') response.winningVote = psaEntry;
      else if (cfg.viewer_control_mode === 'JUKEBOX') response.nextRequest = psaEntry;

      return res.json(response);
    }
  }

  if (cfg.viewer_control_mode === 'VOTING') {
    const top = getHighestVotedSequence();
    if (top) {
      response.winningVote = {
        sequence: top.sequence_name,
        playlistIndex: top.sort_order,
        votes: top.vote_count,
      };
      if (cfg.reset_votes_after_round) {
        db.prepare(`DELETE FROM votes WHERE round_id = ?`).run(cfg.current_voting_round);
        advanceVotingRound();
        const io = req.app.get('io');
        if (io) io.emit('voteReset');
      }
    }
  } else if (cfg.viewer_control_mode === 'JUKEBOX') {
    const next = popNextQueuedRequest();
    if (next) {
      response.nextRequest = {
        sequence: next.sequence_name,
        playlistIndex: next.sort_order,
        queuedAt: next.requested_at,
      };
      const io = req.app.get('io');
      if (io) io.emit('queueUpdated');
    }
  }

  res.json(response);
});

// ============================================================
// POST /api/plugin/playing
// ============================================================
router.post('/playing', (req, res) => {
  const { sequence } = req.body || {};
  const name = (sequence || '').trim();

  setNowPlaying(name || null);

  if (name) {
    db.prepare(`
      INSERT INTO play_history (sequence_name, played_at, source)
      VALUES (?, CURRENT_TIMESTAMP, 'unknown')
    `).run(name);

    // Mark this sequence as played; reset its hidden counter
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
  }

  const io = req.app.get('io');
  if (io) io.emit('nowPlaying', { sequenceName: name || null });

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/next
// ============================================================
router.post('/next', (req, res) => {
  const { sequence } = req.body || {};
  const name = (sequence || '').trim();

  setNextScheduled(name || null);

  const io = req.app.get('io');
  if (io) io.emit('nextScheduled', { sequenceName: name || null });

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/heartbeat
// ============================================================
router.post('/heartbeat', (req, res) => {
  pluginStatus.lastSeen = new Date().toISOString();
  pluginStatus.version = req.body?.pluginVersion || null;
  res.json({ ok: true });
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
// Behavior: upsert sequences by name. We DON'T delete sequences that aren't in
// the new list — that way admin can keep custom display_name/artist/category
// edits on sequences that get temporarily removed from the playlist.
// ============================================================
router.post('/sync-sequences', (req, res) => {
  const { playlistName, sequences } = req.body || {};

  if (!Array.isArray(sequences)) {
    return res.status(400).json({ error: 'sequences must be an array' });
  }

  // For inserts: display_order defaults to sort_order so new sequences sort naturally.
  // For updates: only touch sort_order (FPP index) + display_name. display_order is admin-owned.
  const upsert = db.prepare(`
    INSERT INTO sequences (name, display_name, duration_seconds, visible, votable, jukeboxable, sort_order, display_order)
    VALUES (@name, @display_name, @duration_seconds, 1, 1, 1, @sort_order, @sort_order)
    ON CONFLICT(name) DO UPDATE SET
      duration_seconds = excluded.duration_seconds,
      sort_order = excluded.sort_order,
      -- display_name is preserved if it was customized — only set if currently empty or equals name
      display_name = CASE
        WHEN sequences.display_name IS NULL
             OR sequences.display_name = ''
             OR sequences.display_name = sequences.name
        THEN excluded.display_name
        ELSE sequences.display_name
      END
  `);

  const toDisplayName = (fppName) =>
    String(fppName || '')
      .replace(/[_\-]+/g, ' ')          // underscores and dashes → spaces
      .replace(/\s+/g, ' ')             // collapse whitespace
      .trim();

  let inserted = 0;
  const tx = db.transaction((items) => {
    items.forEach((seq, index) => {
      const name = String(seq.name || '').trim();
      if (!name) return;
      upsert.run({
        name,
        display_name: String(seq.displayName || toDisplayName(name)).trim(),
        duration_seconds: Number.isFinite(seq.durationSeconds) ? seq.durationSeconds : null,
        sort_order: Number.isFinite(seq.playlistIndex) ? seq.playlistIndex : (index + 1),
      });
      inserted++;
    });
  });
  tx(sequences);

  // Track sync metadata
  pluginStatus.lastSyncAt = new Date().toISOString();
  pluginStatus.lastSyncPlaylist = playlistName || null;
  pluginStatus.lastSyncCount = inserted;

  const io = req.app.get('io');
  if (io) io.emit('sequencesSynced', { count: inserted, playlistName });

  res.json({ ok: true, synced: inserted });
});

// ============================================================
// POST /api/plugin/viewer-mode
// Body: { mode: "VOTING" | "JUKEBOX" | "OFF" | "ON" }
//
// Special cases:
//   mode = "ON"  — restore viewer control to the last non-OFF mode
//                  (useful for "Turn On" FPP commands that shouldn't
//                  hardcode a voting vs jukebox choice)
//   mode = "OFF" — also stashes the current mode so ON can restore it
//
// Used by FPP scheduler commands to toggle viewer control at showtime.
// Auth: same Bearer token as other plugin endpoints.
// ============================================================
router.post('/viewer-mode', (req, res) => {
  const { mode: requested } = req.body || {};
  const allowed = ['VOTING', 'JUKEBOX', 'OFF', 'ON'];

  if (!requested || !allowed.includes(requested)) {
    return res.status(400).json({
      error: 'mode must be VOTING, JUKEBOX, OFF, or ON',
    });
  }

  const { updateConfig } = require('../lib/db');
  const cfg = getConfig();
  let newMode;

  if (requested === 'ON') {
    // Restore the last active mode (defaults to VOTING)
    newMode = cfg.last_active_mode || 'VOTING';
    updateConfig({ viewer_control_mode: newMode });
  } else if (requested === 'OFF') {
    // Stash the current mode (if it's active) before turning off
    const updates = { viewer_control_mode: 'OFF' };
    if (cfg.viewer_control_mode && cfg.viewer_control_mode !== 'OFF') {
      updates.last_active_mode = cfg.viewer_control_mode;
    }
    updateConfig(updates);
    newMode = 'OFF';
  } else {
    // Explicit VOTING or JUKEBOX — also update last_active_mode
    updateConfig({ viewer_control_mode: requested, last_active_mode: requested });
    newMode = requested;
  }

  const io = req.app.get('io');
  if (io) io.emit('viewerModeChanged', { mode: newMode });

  res.json({ ok: true, mode: newMode, requested });
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

module.exports = router;
module.exports.pluginStatus = pluginStatus;
