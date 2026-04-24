# OpenFalcon

Self-hosted replacement for [Remote Falcon](https://remotefalcon.com), the viewer-control system for [Falcon Player (FPP)](https://falconchristmas.github.io/) Christmas/holiday light shows. Lets viewers vote for or request sequences from a web page; the server tells FPP what to play.

Built because Remote Falcon's hosted service [is being sunset on May 1, 2026](https://github.com/Remote-Falcon).

## Features

- **Viewer control modes**: Voting, Jukebox, or Off
- **FPP plugin**: Polls FPP status, reports playback state, queues viewer-requested sequences via FPP's `Insert Playlist` API
- **Interrupt-and-resume**: Configurable to either queue requests after the current song or interrupt immediately
- **Interaction safeguards**: PSA injection, GPS proximity check, IP blocking, hide-after-played, per-viewer vote/request limits, queue depth limits
- **Viewer page templating**: Multi-template support, Monaco-based in-browser HTML editor, Remote Falcon placeholder compatibility (`{PLAYLISTS}`, `{NOW_PLAYING}`, etc.)
- **FPP scheduler commands**: Turn viewer control on/off, switch modes, restart listener — all schedulable via FPP's command system
- **Live updates**: Vote counts, queue, now-playing all update in real-time on the viewer page without reload

## Requirements

- Node.js 18 or newer
- ~50MB disk
- 256MB RAM minimum
- A Falcon Player instance to control (FPP 7+ recommended)
- Network connectivity between OpenFalcon and FPP

OpenFalcon does not require AVX2/AVX-capable CPUs. It runs fine on basic ARM/Atom-class hardware. Tested on a Proxmox LXC with an i5-7500T mini PC.

## Quick start

```bash
git clone https://github.com/frankietest6/openfalcon.git
cd openfalcon
npm install
cp config.example.js config.js
# Edit config.js — at minimum, change `jwtSecret` and `showToken`
npm start
```

OpenFalcon listens on `http://0.0.0.0:3100` by default.

- **Admin page**: `http://your-host:3100/admin/`
  - First load: pick any password — it gets saved as the admin password
- **Viewer page**: `http://your-host:3100/`
- **Plugin endpoint**: `http://your-host:3100/api/plugin/...` (used by the FPP plugin)

## FPP plugin

You also need the companion FPP plugin: [openfalcon-plugin](https://github.com/frankietest6/openfalcon-plugin).

Install it on your FPP, paste the OpenFalcon Server URL and Show Token (visible in the OpenFalcon admin page) into the plugin config, pick a "remote playlist" (the pool of sequences viewers can pick from), and click **Sync Playlist**.

## Configuration

All settings live in `config.js` (copy from `config.example.js`). The file is ignored by git so your local secrets stay local. Most user-visible behavior is controlled from the admin page, not this file.

`config.js` covers:
- Server port and bind address
- Database file path
- `jwtSecret` — keep this private; rotating it invalidates all admin sessions
- `showToken` — shared secret with the FPP plugin; rotating it requires updating the plugin
- Logging level

## Production deployment

Recommended: run under [PM2](https://pm2.keymetrics.io/).

```bash
npm install -g pm2
pm2 start server.js --name openfalcon
pm2 save
pm2 startup           # run the command it prints — survives reboots
```

To deploy a new version:
```bash
cd /opt/openfalcon
git pull
npm install --omit=dev
pm2 reload openfalcon
```

Or use the included `deploy.sh` (see DEPLOY.md).

## Architecture

```
[Browser viewer]  ──HTTP──▶  [OpenFalcon Node server]  ◀──HTTP──  [FPP plugin (PHP)]
                                       │                                  │
                                       ├── SQLite DB                      └── FPP REST API
                                       └── Socket.io for live updates
```

- **Server**: Node.js + Express + better-sqlite3 + Socket.io
- **Database**: SQLite (single file, easy backup)
- **FPP plugin**: PHP listener that polls FPP's `/api/system/status` and queues sequences via `Insert Playlist Immediate`
- **Authentication**: Bearer token (plugin), JWT cookie (admin), anonymous viewer cookie (viewers)

## Status

OpenFalcon is in active development. The core protocol works end-to-end; missing features compared to Remote Falcon are tracked in GitHub issues. PRs welcome.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

- [Remote Falcon](https://remotefalcon.com) by James Vance and contributors — the original, and the design we're paying tribute to here
- [Falcon Player](https://falconchristmas.github.io/) — the open-source player this controls
