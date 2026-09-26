// ============================================================
// ShowPilot — Audio Position Relay
// ============================================================
// Connects to the ShowPilot audio daemon's WebSocket on the FPP Pi
// and relays FPP's live playback position to all viewer phones via
// Socket.io. This is how phones stay in sync with the show speakers
// without each phone needing its own connection to the Pi.
//
// Architecture:
//   FPP Pi daemon → ONE WebSocket → ShowPilot → Socket.io → all phones
//
// Phones receive position updates every ~250ms and use playbackRate
// (±2% max) to nudge their audio into sync with FPP's actual position.
//
// This module is started by server.js after Socket.io is initialized.
// ============================================================

'use strict';

let ws = null;
let reconnectTimer = null;
let io = null;
let getConfigFn = null;
let isRunning = false;

// ---- FPP clock → server clock (v0.33.202+) ----
// The daemon stamps messages with the FPP host's clock, but viewers convert
// timestamps using their offset to THIS server's clock. Any difference
// between the two clocks (common on show networks without internet time
// sync) used to go straight into every phone's audio position.
//
// For each message, (serverRecvTime - fppTimestamp) = clockDiff + transit.
// The smallest value over a recent window is clockDiff + minimum one-way
// transit; subtracting half the minimum ping round trip leaves clockDiff.
// Timestamps are rewritten into server time before relaying.
let recvDiffs = [];          // serverRecvMs - fppTs, recent window
let pingRtts = [];           // recent ping round trips (ms)
let pingSentAt = 0;
let pingTimer = null;
let fppClockOffsetMs = 0;    // add to FPP timestamps to get server time
let lastLoggedOffsetMs = null;

function resetClockMapping() {
  recvDiffs = [];
  pingRtts = [];
  pingSentAt = 0;
  fppClockOffsetMs = 0;
  lastLoggedOffsetMs = null;
}

function noteFppTimestamp(fppTs) {
  if (typeof fppTs !== 'number' || !isFinite(fppTs)) return;
  recvDiffs.push(Date.now() - fppTs);
  if (recvDiffs.length > 40) recvDiffs.shift();       // ~20s of messages
  const minDiff = Math.min(...recvDiffs);
  const halfRtt = pingRtts.length ? Math.min(...pingRtts) / 2 : 0;
  fppClockOffsetMs = Math.round(minDiff - halfRtt);
  if (lastLoggedOffsetMs === null || Math.abs(fppClockOffsetMs - lastLoggedOffsetMs) > 25) {
    console.log(`[position-relay] FPP clock is ${-fppClockOffsetMs}ms vs server clock (min RTT ${Math.round(halfRtt * 2)}ms) — correcting relayed timestamps`);
    lastLoggedOffsetMs = fppClockOffsetMs;
  }
}

function toServerTime(fppTs) {
  return (typeof fppTs === 'number') ? fppTs + fppClockOffsetMs : fppTs;
}

function start(socketIo, getConfig) {
  io = socketIo;
  getConfigFn = getConfig;
  isRunning = true;
  connect();
}

function stop() {
  isRunning = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

function connect() {
  if (!isRunning) return;
  reconnectTimer = null; // clear so close/error handlers can schedule next reconnect

  // Close any existing connection before creating a new one.
  // Only close if the socket is open/closing — not if still CONNECTING,
  // which would trigger an immediate close event and re-enter connect().
  if (ws) {
    try {
      ws.removeAllListeners();
      if (ws.readyState !== 0) ws.close(); // 0 = CONNECTING — skip
    } catch (_) {}
    ws = null;
  }

  const cfg = getConfigFn();
  if (!cfg.plugin_fpp_host || cfg.audio_enabled === 0) {
    reconnectTimer = setTimeout(connect, 10000);
    return;
  }

  const daemonPort = cfg.audio_daemon_port || 8090;
  const wsUrl = `ws://${cfg.plugin_fpp_host}:${daemonPort}`;

  let WebSocket;
  for (const p of ['ws', '/opt/showpilot/node_modules/ws', __dirname + '/../node_modules/ws']) {
    try { WebSocket = require(p); break; } catch (_) {}
  }
  if (!WebSocket) {
    console.warn('[position-relay] ws not found — run npm install in ShowPilot dir, retrying in 60s');
    reconnectTimer = setTimeout(connect, 60000);
    return;
  }

  console.log(`[position-relay] connecting to daemon at ${wsUrl}`);
  const sock = new WebSocket(wsUrl);
  ws = sock;
  // New connection: the FPP host's clock may have changed while we were away.
  resetClockMapping();
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

  sock.on('open', () => {
    console.log('[position-relay] connected to daemon WebSocket');
    // Measure round trip to the daemon (ws answers pings automatically).
    pingTimer = setInterval(() => {
      if (ws !== sock || sock.readyState !== 1) return;
      try { pingSentAt = Date.now(); sock.ping(); } catch (_) {}
    }, 5000);
  });

  sock.on('pong', () => {
    if (!pingSentAt) return;
    const rtt = Date.now() - pingSentAt;
    pingSentAt = 0;
    if (rtt >= 0 && rtt < 5000) {
      pingRtts.push(rtt);
      if (pingRtts.length > 12) pingRtts.shift();
    }
  });

  sock.on('ping', () => {
    try { sock.pong(); } catch (_) {}
  });

  sock.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'position' || msg.type === 'syncPoint') noteFppTimestamp(msg.serverTimestamp);
      if (msg.type === 'position' && io) {
        io.emit('fppPosition', {
          playing: msg.playing,
          filename: msg.filename,
          positionSec: msg.positionSec,
          serverTimestamp: toServerTime(msg.serverTimestamp),
        });
      } else if (msg.type === 'syncPoint' && io) {
        console.log(`[position-relay] emitting fppSyncPoint at ${msg.positionSec?.toFixed(3)}s for "${msg.filename}"`);
        io.emit('fppSyncPoint', {
          playing: msg.playing,
          filename: msg.filename,
          positionSec: msg.positionSec,
          serverTimestamp: toServerTime(msg.serverTimestamp),
        });
      }
    } catch (e) { console.error('[position-relay] message error:', e.message); }
  });

  sock.on('close', () => {
    if (pingTimer && ws === sock) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
    if (isRunning && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, 500); // fast reconnect
    }
  });

  sock.on('error', (err) => {
    // Suppress common connection errors — daemon may not be running yet
    ws = null;
    if (isRunning && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, 10000); // 10s backoff on error
    }
  });
}

module.exports = { start, stop };
