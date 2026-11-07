// ============================================================
// ShowPilot — Plugin link (hosted mode only, v0.33.278-master.8+)
// ============================================================
// On a self-hosted install, ShowPilot dials INTO the FPP's audio daemon on
// the show's local network for live song position (audio-position-relay.js).
// A hosted install isn't on that network, so the plugin's daemon dials OUT
// to us instead: a WebSocket to /api/plugin/link, authenticated with the
// show token. The socket is handed to the position relay, which treats it
// exactly like its own dial-out connection (same messages, clock mapping
// and ping round trips).
//
// Not used at all unless config.hosted is set.
// ============================================================
'use strict';

const crypto = require('crypto');
const config = require('./config-loader');

const PATH = '/api/plugin/link';

function tokenMatches(given) {
  const want = Buffer.from(String(config.showToken || ''));
  const got = Buffer.from(String(given || ''));
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

function reject(socket, code, text) {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_) {}
  socket.destroy();
}

function attach(server, getConfig) {
  if (!config.hosted) return;
  let WebSocketServer;
  try { ({ WebSocketServer } = require('ws')); } catch (_) {
    console.warn('[plugin-link] ws not installed — plugin link disabled');
    return;
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const relay = require('./audio-position-relay');

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname.replace(/\/+$/, ''); } catch (_) { return; }
    if (pathname.toLowerCase() !== PATH) return; // not ours (Socket.io etc.)
    socket.on('error', () => {});
    const auth = String(req.headers.authorization || '');
    if (!tokenMatches(auth.startsWith('Bearer ') ? auth.slice(7) : '')) return reject(socket, 401, 'Unauthorized');
    const cfg = getConfig();
    if (cfg && cfg.audio_enabled === 0) return reject(socket, 403, 'Forbidden'); // audio off: nothing to relay
    wss.handleUpgrade(req, socket, head, (ws) => relay.attachIncoming(ws));
  });
  console.log(`[plugin-link] accepting the plugin's link at ${PATH}`);
}

module.exports = { attach, PATH };
