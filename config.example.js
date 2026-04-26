// ============================================================
// ShowPilot — Configuration
// All config values live at the top for easy editing.
// ============================================================

module.exports = {
  // Server
  port: 3100,
  host: '0.0.0.0',

  // Database
  dbPath: './data/showpilot.db',

  // Auth
  jwtSecret: 'CHANGE_ME_BEFORE_RUNNING_IN_PROD',
  sessionCookieName: 'showpilot_session',
  sessionDurationHours: 24 * 30, // 30 days

  // Show token — what the FPP plugin uses in its `remotetoken` header.
  // You paste this value into the plugin config on FPP.
  // Generate a random one on first run if not set.
  showToken: 'CHANGE_ME_TO_A_RANDOM_STRING',

  // Viewer behavior
  viewer: {
    // How long a viewer heartbeat is considered "active" (seconds)
    activeWindowSeconds: 30,
    // How often viewer page polls for state updates (ms) as a fallback if socket fails
    pollIntervalMs: 5000,
    // Max jukebox requests per viewer token per night
    maxJukeboxRequestsPerViewer: 1,
    // Max votes per viewer per voting round
    maxVotesPerRound: 1,
  },

  // Voting round behavior
  voting: {
    // Auto-reset votes after the winner plays? (typical setup)
    resetAfterWinnerPlays: true,
  },

  // Logging
  logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
};
