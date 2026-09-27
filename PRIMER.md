# ShowPilot Project Primer

This document gives you (Claude, in a future conversation) the context you need to help the maintainer work on ShowPilot effectively. Read this first before any other project files.

---

## What ShowPilot is

ShowPilot is a self-hosted companion app for Falcon Player (FPP) — the open-source software that runs Christmas and Halloween light shows. It adds a public-facing viewer page where show visitors can vote on songs, make jukebox requests, and listen to the show audio on their phones in sync with the physical speakers.

Key things it does:
- Serve a themed viewer page (HTML/CSS template the operator can customize)
- Run a jukebox/voting system for visitor interaction
- Stream audio to phones in sync with FPP playback
- Manage sequences (the songs/effects that play)
- Edit the viewer page template (HTML/CSS)
- Monitor plugin connectivity, queue activity, vote tallies
- Export/restore full instance backups

ShowPilot talks to FPP via a companion plugin (`ShowPilot-plugin`) that runs inside FPP. The plugin syncs sequence metadata, reports playback state, and pushes interaction events.

**Branding/domain context:** The maintainer runs the show as "the show" at <show-domain>. ShowPilot is the underlying software (formerly "OpenFalcon" — references to that name still appear in some config defaults).

---

## Architecture

**Stack:**
- Node.js / Express server (`server.js` is the entry point)
- SQLite database via `better-sqlite3` (data lives at `data/showpilot.db`)
- Vanilla JS frontend (no React, no build step) — admin UI is one big HTML file at `public/admin/index.html`
- JWT-based admin auth in httpOnly cookies
- bcrypt for password hashing

**Key directories:**
```
/opt/showpilot/                  (prod LXC) or /app/ (Docker)
├── server.js                    — main entry, route mounting
├── package.json                 — version source of truth
├── config.js                    — host-specific config (jwtSecret, port, dbPath, showToken)
├── config.example.js            — template for fresh installs
├── deploy.sh                    — install script (npm install + ffmpeg via apt-get)
├── lib/
│   ├── db.js                    — SQLite schema, migrations, getters/setters
│   ├── config-loader.js         — loads config.js
│   ├── backup.js                — export/inspect/restore logic
│   ├── process-supervisor.js    — detects PM2/systemd/NSSM/Docker for restarts
│   ├── cover-art.js             — Spotify cover art fetcher (covers stored in data/covers/)
│   ├── viewer-renderer.js       — server-renders viewer page from active template
│   ├── categories.js            — sequence categories: list CRUD, enable/disable, viewer grouping (v0.33.200+)
│   ├── audio-cache.js           — audio file cache, ffmpeg M4A transcoding
│   ├── audio-position-relay.js  — WebSocket relay from FPP daemon to Socket.io viewers
│   └── ...
├── routes/
│   ├── admin.js                 — auth + admin CRUD endpoints (requireAdmin middleware lives here)
│   ├── viewer.js                — public viewer endpoints (vote, queue, audio stream)
│   ├── plugin.js                — endpoints the FPP plugin calls
│   └── backup.js                — backup/restore HTTP routes
├── public/
│   ├── admin/index.html         — entire admin SPA (one file, no build)
│   ├── rf-compat.js             — viewer-side JS (audio engine, sync, voting, jukebox)
│   └── ...
└── data/
    ├── showpilot.db             — SQLite DB
    ├── covers/                  — sequence cover art (jpg files named by sequence ID)
    └── audio-cache/             — cached audio files (.bin, transcoded to AAC/M4A by ffmpeg)
```

---

## Admin layouts: new (default) and classic, plus Cockpit (main v0.33.209+ / Lite v0.5.57+)

**The new layout is the classic admin page itself, restyled and reorganized** — not a separate page. `public/admin/ui-new.css` (everything scoped to `body.ui-new`) and `public/admin/ui-new.js` (`window.SPNew`) are loaded by `admin/index.html`; after sign-in, `checkAuth()` and the login form call `SPNew.apply(me)`, which does nothing for users whose preference is 'classic'. So every section, setting and button is the classic markup and code, and "classic" is the same page without the class. (v0.33.208 briefly shipped the new layout as a separate `admin/new.html` that only covered the dashboard and redirected between pages; that was replaced, and the server now 301s `/admin/new.html` to `/admin/`.)

What `SPNew.apply()` does, all additively:
- **Sidebar rail** built from the page's real sections (`.tab-nav .tab-btn`) and sub-pages (each pane's `.sub-tabs .sub-tab`), so new sections and settings pages appear automatically (Lite shows its own, smaller set of Settings pages). Collapsed to 72px icons; expands on hover/focus-within as an overlay; "Keep menu open" pin stored per browser (`localStorage.sp_rail_pinned`); sub-pages expand under the active section. Footer: FPP status, "Classic layout", pin.
- Wraps `window.switchMainTab()` / `window.switchTab()` to keep the rail highlight and the page title/breadcrumb in sync. Rail items call those same functions.
- Hides the classic `.app-header`, `.status-strip`, `.tab-nav` and `.sub-tabs` (kept in the DOM) and **moves** the existing header controls (`#themeSelect`, `#headerUserSlot`, `#headerViewerCount`, the viewer page link, `#headerPluginDot`/`#headerPluginText`) into the top bar/rail — same elements and ids, so classic code keeps updating them.
- **New dashboard** `#spnDash` inserted into the dashboard pane (the classic dashboard content is hidden, not removed — e.g. `#modeSelect` still backs `toggleViewerControl()`). All actions use the classic functions (`updateMode`, `toggleViewerControl`, `resetVotes`, `purgeQueue`, `resetRace`, `removeQueueEntry`). Data: `/api/admin/config`, `/stats`, `/queue`, plus `/api/state` (vote counts, song timing with server-clock offset, race taps); names from the classic `sequencesCache`. Refreshes when the classic `loadStats()` runs (wrapped) and every 5s.
- **One-time notice** explaining how to switch back; dismissing it sets `users.layout_notice_seen`.

**Preference:** `users.admin_layout` (NULL/'new' = new, the default; 'classic'), `users.layout_notice_seen`; `GET /me` returns `adminLayout` / `layoutNoticeSeen`; `PUT /me/layout {layout}`, `PUT /me/layout-notice-seen`. Switching reloads the page. Classic shows a "New layout" header button.

**No redirect code on the admin page.** v0.33.208's client-side redirects plus runtime `<script>` injection were followed by a Windows Defender cloud-ML detection (`Trojan:Win32/MalUri.A!cl`) on a release tarball — almost certainly a false positive, but avoid page-level `location.replace` redirects and injected script tags in new admin code; prefer server redirects and static `<script>` tags.

**Cockpit** `public/admin/cockpit.html`: tablet show remote (viewer control, modes, reset/purge, countdown ring, Live / Queue (remove) / Songs (show/hide via `PUT /sequences/:id {visible}`) tabs, quick switches for `check_viewer_present` and each category via `POST /categories/enabled`). Uses `public/admin/shared.js` (window.SP) and `public/admin/themes.css`, and loads `/socket.io/socket.io.js` with a static tag. Skip / play next / stop show / announcements / alerts from the design mockups are NOT built — they need new server features.

**Themes live in two places:** the classic page's inline CSS (used by the admin in both layouts) and `themes.css` (Cockpit). Change both, plus `ALLOWED_THEMES` in `routes/admin.js`.

Tested with the real admin page running its scripts in jsdom against a live server (both repos): new layout by default, rail built from real sections and all Settings sub-pages, Settings > Voting opens with the right title, Dashboard always shows the new dashboard, header controls moved, notice shown, classic preference renders the untouched classic page.

## Deployment topology

The maintainer runs **three** ShowPilot environments. Don't conflate them.

### 1. Production LXC (Proxmox)
- Host: `<prod-lxc-ip>`, hostname still says `OpenFalcon` (cosmetic, not renamed yet)
- Path: `/opt/showpilot/`
- Process manager: **PM2** (process name: `showpilot`)
- Public URL: `<show-domain>` / `lights.<show-domain>` (via Cloudflare DNS-only mode + Nginx Proxy Manager)
- Restart: `pm2 restart showpilot`
- Logs: `pm2 logs showpilot`
- Show token: `<show-token>`

### 2. Docker test container (maintainer's Windows PC)
- Image: `ghcr.io/showpilotfpp/showpilot:latest`
- Container name: `sp-beta`
- Port: host `3101` → container `3100`
- Bind mount: `C:\Users\<user>\sp-beta-data` → `/app/data`
- Auto-update: Watchtower watches and pulls new `:latest` images
- Restart policy: `unless-stopped`
- Used for: testing fresh installs, restore round-trips, anything risky before prod

### 3. FPP-Main plugin (the Falcon Player itself)
- Host: `<fpp-host-ip>`
- Software: FPP v10.x-master-219-g2d311770
- Plugin path: `/home/fpp/media/plugins/showpilot/`
- Logs: `/home/fpp/media/logs/showpilot-listener.log`
- Repo: `github.com/ShowPilotFPP/ShowPilot-plugin` (separate from the main repo)

### FPP Audio Daemon
- The ShowPilot plugin also runs a separate audio daemon (`showpilot_audio.js`) on port 8090
- Daemon log: `/home/fpp/media/logs/showpilot-audio.log`
- Receives playback events from FPP via a FIFO at `/tmp/SHOWPILOT_FIFO`
- Broadcasts position updates and syncPoints to ShowPilot LXC via WebSocket
- ShowPilot relays these to viewers via Socket.io (`lib/audio-position-relay.js`)
- Daemon writes PID to `/tmp/showpilot-audio.pid` on startup for clean restarts

### CI/CD
- GitHub: `github.com/ShowPilotFPP/ShowPilot` (main repo) and `ShowPilotFPP/ShowPilot-plugin`
- GitHub Actions builds Docker images on tag push and publishes to ghcr.io (`.github/workflows/docker-publish.yml`). Since v0.33.206 (issue #19) each architecture builds on its own **native** runner — amd64 on `ubuntu-latest`, arm64 on GitHub's free `ubuntu-24.04-arm` (public repos) — pushed by digest, then a `merge` job publishes one multi-arch manifest with the tags (`X.Y.Z`, `X.Y`, `latest` on tags; `beta` on the beta branch). Don't reintroduce QEMU emulation: building arm64 under QEMU compiled better-sqlite3 in emulation and failed intermittently. If the arm runner label ever becomes unavailable, the arm64 job queues instead of failing — that's the first thing to check.
- Watchtower on the Docker host auto-pulls new `:latest`
- Prod LXC is updated manually via `git pull + pm2 restart`

---

## Deployment workflow

Standard release process:

```powershell
# On the dev machine (Windows, PowerShell)
cd C:\dev\ShowPilot
git pull origin main
tar -xzf "$env:USERPROFILE\Downloads\showpilot-vX.Y.Z.tar.gz" --strip-components=1
git add -A
git commit -m "vX.Y.Z — description"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

```bash
# Deploy to prod LXC
ssh root@<prod-lxc-ip>
cd /opt/showpilot && git pull origin main
pm2 restart showpilot
pm2 logs showpilot
```

For Docker test, watchtower auto-pulls. To force a fresh test:

```powershell
docker stop sp-beta
Remove-Item -Recurse -Force C:\Users\<user>\sp-beta-data
docker pull ghcr.io/showpilotfpp/showpilot:latest
New-Item -ItemType Directory -Path C:\Users\<user>\sp-beta-data | Out-Null
docker run -d --name sp-beta -p 3101:3100 -v C:\Users\<user>\sp-beta-data:/app/data --restart unless-stopped ghcr.io/showpilotfpp/showpilot:latest
```

When you ship code, package it as a tarball at `/mnt/user-data/outputs/showpilot-vX.Y.Z.tar.gz`. The maintainer downloads, extracts over the dev clone, commits, pushes.

### Standard tarball packaging commands (CRITICAL — never exclude .github)

```bash
# ShowPilot main
tar --exclude='showpilot/.git' \
    --exclude='showpilot/node_modules' \
    --exclude='showpilot/config.js' \
    --exclude='showpilot/data' \
    --exclude='showpilot/*.tar.gz' \
    -czf /mnt/user-data/outputs/showpilot-vX.Y.Z.tar.gz showpilot/

# ShowPilot plugin
tar --exclude='showpilot-plugin/.git' \
    -czf /mnt/user-data/outputs/showpilot-plugin-vX.Y.Z.tar.gz showpilot-plugin/
```

Always syntax-check before packaging:
```bash
cd /home/claude/showpilot && node --check server.js && echo "OK"
node --check /home/claude/showpilot-plugin/showpilot_audio.js && echo "Daemon OK"
```

### ShipPilot

The maintainer uses ShipPilot (an in-house tool, separate LXC) to push releases to GitHub. Each release needs a `.release.json` in the repo root:

```json
{
  "repo": "showpilot",
  "version": "0.33.148",
  "commit_message": "v0.33.148 — description",
  "tag": "v0.33.148"
}
```

**Important:** `.release.json` is in `.gitignore` and is NOT committed to the repo. A fresh `git clone` won't have one. Claude must create it with `create_file` each session before packaging the tarball.

### Testing on LXC only (no GitHub)

When testing locally without pushing to GitHub, use a test tarball:
```powershell
scp "$env:USERPROFILE\Downloads\showpilot-test.tar.gz" root@<prod-lxc-ip>:/tmp/
```
```bash
ssh root@<prod-lxc-ip>
cd /opt/showpilot && tar -xzf /tmp/showpilot-test.tar.gz --strip-components=1 && pm2 restart showpilot
```
Only bump the rf-compat.js cache buster (`v=NN` in `lib/viewer-renderer.js`) for test builds — don't bump the package.json version until ready to ship.

---

## Audio sync architecture (v0.33.129+)

This is the most complex part of ShowPilot. Read carefully before touching anything audio-related.

### Overview

Viewers open the ShowPilot viewer page and tap "Listen on Phone." Audio plays from ShowPilot's cache in sync with FPP's physical speakers. The goal: all phones play the same position in the song at the same wall-clock moment, matching the speakers.

### Signal chain

```
FPP hardware speakers
    ↑
FPP plays audio file → FIFO → showpilot_audio.js daemon (port 8090)
                                    ↓ WebSocket (ws://<fpp-host-ip>:8090)
                            audio-position-relay.js (on ShowPilot LXC)
                                    ↓ Socket.io (fppPosition, fppSyncPoint events)
                            rf-compat.js (viewer browser)
                                    ↓
                            AudioBufferSourceNode (Web Audio API)
                                    ↓
                            Phone speaker
```

### Key components

**`showpilot_audio.js`** (FPP plugin daemon):
- Listens to FIFO for `MediaSyncStart`, `MediaSyncStop`, `MediaSyncPacket` events from FPP
- Broadcasts `position` events every ~500ms via WebSocket
- Broadcasts `syncPoint` events every ~1s (suppressed for ~1s after song change)
- `MediaSyncStart` suppression: 1000ms. `MediaSyncPacket` song-change suppression: 800ms. setTimeout before forcing first syncPoint: 1000ms. Broadcast interval gate: 1000ms. (All reduced from original 2000ms/3100ms values in v0.13.38 to get first syncPoint at ~2s instead of ~4s.)
- Writes PID to `/tmp/showpilot-audio.pid` on startup (v0.13.39). `postStart.sh` uses it for clean kills.
- `scripts/restart-daemon.sh` — run after plugin updates to restart daemon without full fppd restart
- The HTTP poll must NOT set `lastSyncPointAt` — only the FIFO handler controls syncPoint suppression

**`audio-position-relay.js`** (ShowPilot LXC):
- Connects to daemon WebSocket at `ws://<fpp-host-ip>:8090`
- Translates `position` → `io.emit('fppPosition', ...)` and `syncPoint` → `io.emit('fppSyncPoint', ...)`
- 500ms reconnect on disconnect
- Ping handler responds to server pings for keepalive

**`rf-compat.js`** (viewer browser) — Web Audio Engine:
- `startup()` creates `AudioContext`, fires initial HTTP clock sync, establishes Socket.io, re-syncs clock via Socket.io timesync burst
- `handleTrackChange()` — full startup sync sequence (see below)
- `fetch()` + `decodeAudioData()` decodes audio to PCM in memory
- `AudioBufferSourceNode.start(ctxTime, positionSec)` schedules playback
- Position tracked via `trackScheduledAtAudioCtx` / `trackScheduledAtPositionSec` anchor pair

### Startup sync sequence (per song change, v0.33.129+)

This is the core of multi-phone sync. Every song change goes through these steps in order:

1. **Start in the right place** (v0.33.204+) — if there are no FPP readings for the new song yet, wait up to 2.5s for them (they arrive every ~0.5s; status shows "Syncing…"), then start from `estimateFppPosNow()`. Mid-song joiners already have readings and start immediately. Falls back to the old rough position if no readings arrive.

2. **SyncPoint check** (~2s after song change) — `handleTrackChange` awaits the first `fppSyncPoint` for this song and compares the best estimate to where the audio is. Under `JUMP_THRESHOLD_MS` (150ms): no cut, the speed loop closes it. Over: equal-power crossfade (`crossfadeTo`). v0.33.203 and earlier did a hard stop/restart here, which caused the audible pause/skip.

3. **Follow-up check** (500ms later) — same rule: speed loop under 150ms, crossfade over.

4. **Continuous correction** — every 250ms tick, drift = what the listener hears (`htmlAudio.currentTime − outputLatency`) minus FPP's estimated position (show offset applied), EMA-smoothed (α=0.6). Two tiers (v0.33.204+): |drift| > 150ms → crossfade jump (10s cooldown); otherwise a proportional **speed nudge**: rate = 1 − drift_s × 0.1, capped ±0.5% (~9 cents, inaudible), back to exactly 1.0 inside an 8ms deadband. Needs ≥3 readings of the current track, newest < 1.5s; without them the rate returns to 1.0. Simulated with realistic measurement noise: 140ms closes in ~30s with no overshoot; steady state within ~8ms.

5. **No auto-calibration** (removed v0.33.202). The old 5-sample `sp_device_offset` calibration stored each measurement as the new offset, but each measurement already included the previous offset, so any constant error was added again every song (runaway, capped only by a ±1s sanity check). `deviceOffset` is now always 0 and the old localStorage key is cleared on load. Fixed per-show speaker delay is the admin's `audioSyncOffsetMs`.

### Drift reference and FPP position estimate (v0.33.202+)

**History — do not reintroduce:** v0.33.134–0.33.201 measured drift after the snap as `htmlAudio.currentTime − (snapAnchorPosSec + (ctx.now − snapAnchorCtxTime))`. The snap and follow-up set `snapAnchor*` from exactly the same values as `trackScheduledAt*`, so that expression was always 0 and nothing ever corrected an error left by the snap. The motivation (device OS clocks differ) is real, but it is handled by `clockOffset` from `syncClockBurst()`, not by ignoring FPP. `snapAnchor*` are still set but are no longer the drift reference.

**Estimator (`estimateFppPosNow()`):** `recordFppSample()` keeps recent `fppPosition` and `fppSyncPoint` readings (`{p, ts, file}`, reset on file change). The estimate is the **upper envelope**: the maximum of `p + (serverNow − ts)` over the last 5s, current track only (`currentTrackMediaName` = the track's raw `mediaName`). Why maximum, not latest: before plugin v0.14.6 the daemon stamped each reading when it *sent* it, 0–100ms after FPP reported it (it polled the FIFO every 100ms), and the first syncPoint after a song change re-sent a position up to ~500ms old with a fresh stamp. Both errors only make readings look older, never newer. Plugin v0.14.6 reads the FIFO event-driven and advances positions to the send moment (measured delivery delay median 0ms, max 4ms), so readings are now accurate; the upper envelope stays as protection for FPP hosts still on older plugin versions. Simulated with those delays: mean −3ms, worst −23ms at the 5s window (a 2.5s window reached −70ms, too close to the 50ms threshold). If readings for the same file jump backwards by >1.5s (FPP restart/seek), older ones are dropped.

**Output latency (`getOutputLatencySec()`):** `outputLatency || baseLatency`, clamped to 0–0.4s (a latency API once reported 2000ms+). Sources start a short lead from now at FPP position + lead + output latency, so the sample is *heard* when FPP is at that position. Before v0.33.202 the start time was delayed by the latency without advancing the position, landing lead + 2× latency behind.

**Variable-rate position tracking (v0.33.204+):** rendered position = `trackScheduledAtPositionSec + (ctx.now − trackScheduledAtAudioCtx) × currentRate` (`renderedPosAt()`, used by the `htmlAudio.currentTime` shim). `setSourceRate()` re-anchors before every rate change; every new source (fast-start, `crossfadeTo`, legacy `scheduleStart`, `stopAudio`) resets `currentRate` to 1. Verified against a real Web Audio implementation (`node-web-audio-api`, OfflineAudioContext with a position-encoding test signal): max position error 0.08ms across two rate changes, a 300ms crossfade and a return to 1.0.

**Crossfades** go through `crossfadeTo(targetPos)` only: 80ms equal-power curves (`setValueCurveAtTime`, linear-ramp fallback), new source scheduled 10ms ahead so the whole fade is pre-scheduled. The old per-site crossfade copies were removed.

### Clock sync (Socket.io NTP-style)

`syncClockBurst(n)` fires n parallel Socket.io `timesync` events. Server responds immediately. Viewer computes: `offset = ((t2-t1) + (t3-t4)) / 2`. Takes median of lowest-RTT half. Re-syncs every 30 seconds.

**Critical:** Do NOT update `clockOffset` from `fppSyncPoint` or `fppPosition` message timestamps — they are one-way. Only `syncClockBurst` sets `clockOffset`. (Until v0.33.202 the `fppPosition` handler still nudged `clockOffset` 5% toward each message, which made phones gradually ignore the message's travel time — a steady lag between 30s re-syncs.)

**FPP clock → server clock (relay, v0.33.202+):** the daemon stamps with the FPP host's clock; viewers convert with their offset to the ShowPilot server's clock. `lib/audio-position-relay.js` estimates the difference as `min(serverRecv − fppTs)` over ~40 messages minus half the minimum WebSocket ping RTT (pinged every 5s; `ws` answers pings automatically), and rewrites `serverTimestamp` into server time before emitting. Reset on every reconnect. Logs `FPP clock is Nms vs server clock` when it changes by >25ms. A backward step of the FPP clock takes up to ~20s to be reflected (window minimum).

**High-jitter rejection (v0.33.133+):** `bestRttEverMs` tracks the best RTT seen across all bursts. A new burst's result is rejected if its best RTT exceeds `bestRttEverMs * 3`. This prevents a high-jitter burst (e.g. 200ms RTT when previous was 5ms) from corrupting a good clock estimate.

### Next-song prefetch (v0.33.130+)

While the current song plays, `rf-compat.js` prefetches and decodes the next scheduled song in the background. When the song change fires, `handleTrackChange` finds the buffer already in `decodedBufferCache` — decode time is near-zero, so the snap fires as soon as the syncPoint arrives (~2s) rather than waiting for fetch+decode.

### mediaName field (v0.33.129+)

`/api/now-playing-audio` response now includes `mediaName: seq.media_name` — the raw FPP filename (e.g. `"08 - Bloody Mary.mp3"`). This is what `fppSyncPoint` events carry as `filename`. Without this field, the syncPoint filename match in `handleTrackChange` always failed and snaps never fired.

### Per-filename syncPoint resolver map (v0.33.130+)

`window._pendingSyncPointResolvers` is a map keyed by `mediaName`, replacing the single `window._pendingSyncPointResolver`. Rapid song changes no longer clobber each other's resolvers — each song change registers its own slot.

### Critical invariants — do not break

1. **`window._pendingSyncPointResolvers[mediaName]`** — keyed resolver map. Don't collapse back to a single global — rapid song changes will clobber each other.

2. **`trackScheduledAtAudioCtx` / `trackScheduledAtPositionSec`** must be updated atomically whenever a new `AudioBufferSourceNode` starts. `htmlAudio.currentTime` reads from these.

3. **Drift is measured against FPP's estimated position** (`estimateFppPosNow()`), never against `snapAnchor*`. See "Drift reference and FPP position estimate".

4. **The HTTP poll in `showpilot_audio.js` must NOT set `lastSyncPointAt`**. Only the FIFO handler controls syncPoint suppression.

5. **`htmlAudio` is a compatibility shim**, not a real `HTMLAudioElement`. All playback goes through `AudioBufferSourceNode`.

6. **Do not revert to HTML5 `<audio>`**. PCM-decoded Web Audio is the correct architecture.

7. **Timing math: a source that starts at ctx time `now + lead` must start at FPP position + lead + output latency.** Never delay the start by the output latency instead.

8. **Corrections need ≥3 fresh readings of the current track** (`loopEst.n >= 3`, newest < 1.5s). Don't go back to acting on a single reading.

9. **Bump the `rf-compat.js?v=N` cache-buster in `lib/viewer-renderer.js`** whenever `rf-compat.js` changes, or browsers keep the old file.

10. **Never create or restart a source without resetting `currentRate` to 1, and never change `playbackRate` except through `setSourceRate()`** — otherwise the position shim is wrong by (rate − 1) × elapsed.

11. **No hard cuts.** Position corrections are speed nudges or `crossfadeTo`, never stop-then-start.

### Real-time song changes and Stop/Next (v0.33.205+)

Before v0.33.205 a song change reached phones 1–3s late — the listener reports it to the server on a ~1s poll, and the phone polled the server every 1s — so the start of every song was clipped, and Stop/Next took just as long. Now both ends use FPP's own messages, which arrive within milliseconds:

- **Server:** `audio-position-relay.js` keeps `liveFpp` (playing, filename, position, server-time stamp) from every `position`/`syncPoint` message (`getLiveFpp()`, cleared on disconnect). `GET /api/now-playing-audio` uses it while fresh (< 3s): if FPP reports stopped it answers `{ playing: false, liveStopped: true }`; if FPP's file differs from the listener's `now_playing`, it resolves the sequence by `media_name` and answers for that song with elapsed time from the live position. **Read-only override** — `now_playing`, voting, queue and scheduling logic are untouched. Unknown files fall back to the listener's state.
- **Phone:** `onFppLiveEvent()` runs on every `fppPosition` (including `playing:false`, which the handler used to discard). On Stop it stops audio at once and clears `currentSequence` (so a restart of the same song counts as new). On a new file it calls `startFastSync()`: `syncOnce()` immediately, then every 200ms for up to 3s until the player is on FPP's current file. **Only a change** (stop/start or different file vs the previous message) arms it — the daemon's fallback repeats "stopped" 4×/s while FPP is idle, and re-arming on repeats would make every phone poll continuously. Simulated: song change and Next switch in ~65ms plus network; 5s of idle repeats → 1 request; an unknown file → one bounded 3s burst.

### Song progress bar and {NOW_PLAYING_PROGRESS} (v0.33.206+ / Lite v0.5.55+)

Admin setting (Settings → viewer page visuals, after "Page-wide effects"): **Show song progress bar** — a slim bar with time left, pinned to the top or bottom of every viewer page regardless of template. Options: position (`top` default, since the Listen-on-Phone button and player sit at the bottom), show time left, bar color (`''` = built-in light default). Config columns `viewer_progress_bar` (default 0 = off), `viewer_progress_bar_position`, `viewer_progress_bar_show_time`, `viewer_progress_bar_color`; normalized for the client by `lib/progress-bar.js` → `progressBarConfig(cfg)`, sent in the viewer bootstrap and in every `/api/state` response, so changes reach open pages within one poll (~3s) without a reload. The color is applied via `element.style.setProperty('--sp-progress-color', …)`, never string-built CSS.

Template authors can place **`{NOW_PLAYING_PROGRESS}`** instead (ShowPilot extension, not an RF placeholder): `viewer-renderer.js` emits `.sp-progress.sp-progress--inline[data-showpilot-progress]` with a server-computed first-paint width. rf-compat injects `#sp-progress-styles` once (classes `.sp-progress`, `-track`, `-fill`, `-time`, `--idle`, `--fixed`, `--top`, `--bottom`, `--no-time`; color via `--sp-progress-color`) — templates can override any of it. Both the fixed bar and inline bars are painted by `paintTimer()` alongside `{NOW_PLAYING_TIMER}`, and hide (`--idle`) when nothing is playing or the sequence has no `duration_seconds`.

**Placement and color (v0.33.207+ / Lite v0.5.56+):** position `'player'` (default; stored `player`, and 0.33.206/0.5.55's `top`/`bottom` values also read as `player`) puts the bar on the **top edge of the player** (`#of-listen-panel`: main's Listen-on-Phone player, Lite's now-playing player bar) while it's showing, as an absolutely positioned child (`.sp-progress--edge.sp-progress--onplayer`), and on the **bottom edge of the screen** while it's closed/minimized/hidden (`.sp-progress--screenbottom`, time label on the left to stay clear of the launcher button). `'screen-top'` keeps the original top strip. `placeProgressBar()` runs every paint tick and on `showpilot:player-mode` (dispatched by main's `setMode`, Lite's `showBar`/`hideBar`) and `showpilot:player-theme` (dispatched by `applyDecoration`). Color = admin override, else the player theme's accent (`--of-border` when an `of-theme-*` class is on the panel), else light default; custom player colors only set the background, so they fall through to the default. Tested in jsdom: open/minimize/theme change/override/top all place and color correctly.

**Viewer clock offset:** `/api/state` now includes `serverNowMs`, and the bootstrap includes it as a rough seed. `refreshState()` times each request (headers-received, not after JSON parse) and keeps the lowest-round-trip of the last 8 samples as `viewerClockOffsetMs`; `serverNowMs()` is used by the timer and the bar. Before this, `{NOW_PLAYING_TIMER}` compared the server's start time to the phone's own clock, so a phone with a wrong clock showed the wrong time left. Tested in jsdom with a phone clock 45s behind: correct from the first frame.

### Beta channel in the in-app updater (v0.33.219+)

Beta builds are published by ShipPilot to the `beta` branch with **no tag** (repo entry `showpilot-beta`), so they never become a GitHub release or the Docker `:latest` image; the Docker pipeline builds `:beta` from that branch. Settings → Updates has a separate **"Beta channel — for debugging and testing only"** section below the normal update controls.

- **Lookup:** `checkBeta()` in `lib/updater.js` reads `GET /repos/ShowPilotFPP/ShowPilot/commits/beta` (sha, date, first line of the message) and the branch's `package.json` via raw.githubusercontent.com (version). Cached 1h like the stable check.
- **Install:** `POST /api/admin/updates/apply-beta { sha, acknowledged: true, force? }`. It requires the explicit `acknowledged` flag (the UI's "I understand" box) and a 40-hex sha equal to the current beta tip (409 otherwise). `applyBetaUpdate()` runs the same pre-flight checks and data snapshot as a stable update, then `git reset --hard` / `clean -fd`, `git fetch --tags origin beta`, verifies `FETCH_HEAD` equals the expected sha, `git checkout --detach <sha>`, `npm install`, records update state (`last_update_target: beta@<sha7>`) so **Roll back** works, and restarts.
- **Getting back:** a beta can be numerically newer than the latest stable, so status adds `onBeta` (current version is a prerelease) and `returnToStable` (the latest stable tag). The UI shows a "running a beta build" notice with **Return to stable** (the normal `/apply` path with the stable tag). `compareVersions()` now ranks a stable release above its own prereleases (`0.33.219` > `0.33.219-beta.1`), so beta testers are offered the matching stable release.
- **Only offered when there is a newer beta** (v0.33.222+): status sends `betaAvailable` = beta version > installed version; with none, the whole section is hidden (an install running a beta still sees its notice + Return to stable). `apply-beta` refuses a beta that isn't newer (409). Betas are published only when there's something to test; debug tools now ship in main, so the beta branch is normally behind the latest release.
- **Not available:** Docker (the section says to run the `:beta` image instead), demo mode (hidden), and Lite (no in-app updater).
- **Warning copy** (keep it prominent): beta builds are for debugging and testing only, are not stable, may break the viewer page, audio or show control, are not supported, and should not be installed unless you know what you're doing. The install button stays disabled until the acknowledgement box is ticked, then a confirmation repeats the warning.
- Tested: version comparison incl. prereleases; `checkBeta()` against GitHub-shaped responses; the route's guards (no ack / malformed sha → 400, non-tip sha → 409); UI in stable / on-beta / Docker / demo states; and the git sequence (beta install then return to stable) on a shallow clone pinned to a tag with a locally modified file.

### Sync debug tools (main v0.33.222+; first shipped in betas from v0.33.220-beta.1)

Two debug-only tools for diagnosing phone-vs-show audio sync, both off by default under **Settings → Debug**. They only report; nothing steers playback.

- **Sync probe** (`debug_sync_probe`, boot `syncProbeUrl` = `ws://<plugin_fpp_host>:<audio_daemon_port>`): the player also opens a WebSocket straight to the FPP audio daemon, measures its clock offset to the Pi NTP-style (lowest round-trip of `timeReq`/`timeResp`), and every second compares the relayed position (`estimateFppPosNow()`) with the daemon's own (`relay−dir`), plus FPP's status-API position vs the event-driven one (`api−dir`, via `apiPosition` messages to clients that send `probeHello`). Debug overlay + console. Needs an `http://` LAN page and plugin v0.14.10+. First field result: relay within ~+4–9ms of direct (sd 8ms) — the relay is not a meaningful error source.
- **Microphone sync measurement** (`debug_mic_measure`, boot `micMeasureEnabled`; `public/sp-mic.js` only included when on): "🎤 Measure sync" records 3s with the phone playing (mic hears phone + speakers) and 3s muted via `gainNode` (speakers only); GCC-PHAT (`SPMicCore`, 150–6000 Hz) against the decoded track finds each copy. B identifies the speakers' peak and echoes; the phone is the strongest A-only peak within ±0.5s and ≥25% of the strongest; none = in sync. Result = phone − speakers (ms), positive = speakers behind → raise the show offset. Mic input and phone output delays cancel. Needs a secure context. Synthetic tests with echoes/noise: +47/+150/−60/0 exact; clean failure when speakers are inaudible.
- **Hidden output delay (v0.33.223-beta):** Chrome on Android can report `outputLatency` 0 yet buffer audio (and grow the buffer mid-play), so the phone lags the lights like an echo while `drift` reads ~0. `sampleOutputDelay()` (5×/s) computes `(currentTime − ts.contextTime) − (performance.now() − ts.performanceTime)/1000` from `getOutputTimestamp()`; `outDelayMs` = median of the last 25. Overlay line `outDelay:`. Debug switch **"Compensate hidden output delay (experimental)"** (`debug_output_delay_comp`, boot `outputDelayComp`): `getOutputLatencySec()` uses the measured value when larger than the reported one (≥10 samples, max 800 ms). Tested with a fake context reporting 0 but buffering 300 ms (off → sync uses 0; on → 300). Needs real-device confirmation (field report: ~300 ms echo on an Android phone with `hwLatency: 0`).
- **Mic tool v2 (v0.33.223-beta):** 5 s captures; thresholds 12/10; failure shows the speakers' match strength; B's weaker peaks count as the speakers' signature; and an **ambiguity check** — if the best match (in B, or among phone candidates) has a rival >50 ms away and ≥70% as strong, it returns "no clear match … try during a part with vocals" instead of a number. Field bug it fixes: a strongly repetitive song produced a confident "speakers 323 ms ahead" (one beat) while in sync; in tests, repetitive in-sync music now gives no result instead of ~315 ms, and real offsets (incl. 47 ms on the repetitive song) still measure exactly.
- FPP-side finding: FPP master's GStreamer output subtracts a live ALSA sink-latency reading from its reported position (lights servo to it); on a USB audio card it logged 62–83ms per play while the live queue read ~95ms → position/lights lead the sound by ~12–33ms, varying per play. `mediaOffset` was 0.

### Customizable Cockpit (main v0.33.214+ / Lite v0.5.61+)

`public/admin/cockpit.html` is a tile grid built from the user's saved layout. **Catalog:** `public/admin/cockpit-tiles.js` (`window.SPTiles`) defines every tile once: kinds `switch`, `seg`, `select`, `step`, `action` (tap, then "Tap again to confirm" within 4s), `status`, `now` (current song + ring), `board` (`live` standings, `queue` with remove, `songs` show/hide). Groups: Show control, Safeguards, Songs & categories, Viewer page, Status. Song categories become tiles automatically (`cat:<name>`). Every setting a tile changes is already on the admin `PUT /config` allow-list — tiles never reach anything the admin can't.

- **Layout** per user: `users.cockpit_layout` (JSON `[{id,size}]`, size 1/2/4 = small/wide/full row; NULL = `SPTiles.DEFAULT_LAYOUT`), on `GET /me` as `cockpitLayout`, saved by `PUT /me/cockpit-layout {layout}` (debounced 400ms on every edit; `layout: null` = reset). The server checks shape only (max 40, unique, id pattern, size) so the catalog lives in one place; unknown ids are skipped (shown only in edit mode as "No longer available", removable).
- **Edit mode** ("Edit layout", or `cockpit.html?edit=1` from Settings → Cockpit): a catalog drawer (+ Add, drag onto the grid) and a per-tile edit strip (‹ › move, S/W/L size, × remove) on its own row above the label. HTML5 drag-and-drop for mouse; the buttons cover touch. Tile controls are inert while editing.
- **No overflow:** rows are `grid-auto-rows: minmax(132px, auto)` and labels wrap (`overflow-wrap: anywhere`), so long labels grow the tile instead of pushing controls out (the mockup's fixed rows broke on the bottom row). 2 columns below 700px; catalog moves under the grid below 1100px.
- **Settings → Cockpit** sub-page explains it with Customize / Open buttons.
- Tested end to end against a live server (both repos): default layout, a switch tile changing the real setting, add/resize/move/remove, save to account, reload restores, server rejects bad size/id/41 tiles, reset clears.

### Larger two-row player on phones (v0.33.215+)

Admin setting **"Larger two-row player on phones"** on **Viewer Page → Template Editor**, with the player decoration options (`player_tall_layout`, default 0, boot `playerTallLayout`). On screens <= 600px (`TALL_QUERY`, `isTallPlayer()`), the Listen-on-Phone player becomes two rows: cover + full-width title/artist (16px / 13px), then the controls spread across the width (44px targets, 52px play/pause) in the order timing, mute, play/pause, minimize, close. On one row the title had ~60px on a 390px phone; two rows give it ~300px. Tablets/desktop keep the single row.

- **Pure CSS on the existing elements** (same buttons, handlers and ids): the controls are wrapped in `.of-listen-controls` with inline `display: contents` (so the normal single row is unchanged), the row/text get `.of-listen-row` / `.of-listen-text`; `.sp-player-tall` (on `#of-listen-panel` when the setting is on) plus the media query turn the row into a grid and the wrapper into the second row, reordering with CSS `order`. Styles injected once as `#sp-player-tall-styles`.
- `setMode('open')` reserves 150px of page bottom space when `isTallPlayer()`, else 88px.
- **Not-playing state:** `applyShowNotPlaying()` now also hides the timing button (it didn't in v0.33.213) and toggles `.sp-not-playing` so the two-row layout drops its empty first row; the message takes the controls row with close.
- Tested in jsdom: class on/off with the setting, all five controls (incl. the later-inserted timing button) inside the wrapper, bottom space 150px phone / 88px desktop / 88px with the setting off, not-playing hides everything but the message and close and restores them. Real-device look not verified here.
- Audio player only: ShowPilot main only.

### Listener audio timing (v0.33.213+)

Phones can't report Bluetooth / car-stereo delay to a web page (Chrome on Android Auto reported `outputLatency` 0.008s against a real ~150-300ms), so the listener sets it. A sliders button (`#sp-lt-btn`) sits in the player bar before play/pause and opens a bottom sheet (`#sp-lt-sheet`, appended to `body`, z-index above the player): "Music is late" / "Music is early" nudge +/-50ms, a fine slider (-500..+1000ms, 10ms steps), presets (Phone speaker 0, Bluetooth headphones +150, Car Bluetooth +250), Reset. Positive = play earlier. The button shows a dot (player theme accent `--of-border`, refreshed on `showpilot:player-theme`) while an offset is set.

- Stored per phone in `localStorage.sp_listener_offset_ms` only — never sent to the server. Distinct from the removed `sp_device_offset` auto-calibration (v0.33.202): nothing adjusts it automatically.
- Applied in exactly one place: `getOutputLatencySec()` returns the clamped OS latency **plus** `listenerOffsetSec`. Every sync path (fast start, snap, follow-up, drift loop) already adds output latency, so all honor it, and changes are applied by the existing smooth correction (speed nudge < 150ms, crossfade above). `fastStartPos` is clamped to >= 0 after adding latency (a negative offset at song start); `crossfadeTo()` already refuses negative targets.
- **Help for listeners (v0.33.221+, idea and text from a community contributor):**
  - Visual Designer block **Audio Sync Help** (`audioSyncHelp` in `lib/visual-designer.js`): a native `<details>` (collapsed unless `startExpanded`), props `title`, `body` (plain text, escaped; `[listen]` / `[timing]` become the two buttons' icons, `**bold**` → `<b>`), `accentColor` (6-hex, else `#00a8a8`), `startExpanded`. It renders with `hidden`; rf-compat reveals every `[data-showpilot-sync-help]` only right after creating the timing button (so it never shows when audio or the timing button is off) and copies the live `#of-listen-btn` icon/colours into `[data-sp-listen-icon]` (re-copied after 1.5s and on `showpilot:player-theme`). No script in the block itself.
  - Timing sheet tip `.sp-lt-tip` (the second-phone trick) under the slider; admin switch `listener_timing_tip` (default 1, boot `listenerTimingTip`) on Settings → Audio → Listen-on-Phone player.
  - Tested: block defaults/tokens/bold/escaping/start-expanded/colour fallback; CSS braces survive `renderTemplate`; reveal + icon copy with timing on, stays hidden with timing off; tip follows its switch.
- Slider range is admin-configurable (v0.33.218+, community request): `listener_timing_min_ms` (default -500) / `listener_timing_max_ms` (default 1000), boot `listenerTimingMinMs` / `listenerTimingMaxMs`. The player sanitizes them (`LT_RANGE`): blank/missing = default (not 0 — `Number(null)` is 0), min must be in [-2000, 0], max in [0, 3000], else that end's default. Saved offsets clamp into the range; presets outside it are hidden.
- Admin: **Settings → Audio → Listen-on-Phone player**, "Let listeners adjust audio timing" (`listener_timing_enabled`, default 1, boot `listenerTimingEnabled`). Off = no button and any saved offset ignored (latency offset 0). Takes effect on viewer page reload.
- Tested in jsdom: button placement, sheet open/close (Done, backdrop, Escape), nudges, presets, slider clamp at -500, Reset clears storage, dot on/off, saved value survives reload, switch off hides it; `getOutputLatencySec()` returns 0 / 0.250 / -0.150 / 0 for none / +250 / -150 / +250-with-switch-off.
- Sheet layout (after community review): "Music is early" on the left, "Music is late" on the right, matching the slider ends (*music early · in sync · music late*; positive = right = play earlier); a "Presets" heading above the preset chips.
- The legacy `deviceOffset` (auto-calibration, disabled since v0.33.202 via `if (false && ...)`) is still in the position math at 0; the listener offset deliberately uses `getOutputLatencySec()` instead, and a new storage key, because load clears `sp_device_offset`.
- Drift fixes shipped with it: the fallback drift (no fresh estimate) is measured like the primary path (heard position incl. output latency/listener offset; `deviceOffset` with the same sign — it used to subtract it via `fppPositionNow`), and only estimate-based readings feed `smoothedDriftMs` (which corrections use), so a fallback reading can't leak into the first correction after estimates return.
- Audio-only: ShowPilot main only (Lite has no audio player).

### Track-change recovery (v0.33.203+)

`handleTrackChange()` sets `currentSequence` before the audio is loaded, so any failure used to leave the new song marked "current" with nothing playing — `syncOnce()` then saw no change and never retried until a page refresh. Now: each call takes a `trackChangeToken` (a stale load that finishes late returns instead of playing over a newer one); the audio download has a 20s timeout (`fetchAudioWithTimeout`); on failure `currentSequence` is cleared with a short backoff (`trackRetryNotBefore`) so the next poll retries; and a watchdog in `syncOnce()` retries if nothing has played 15s after a track started loading. The watchdog is safe because `syncOnce` only runs while the player is open, the location gate returns before it, and there is no user pause that stops sources (mute is gain-only).

If the `AudioContext` isn't `running` when a track is about to start (Android pauses it on some Bluetooth / Android Auto route or focus changes), the player resumes it; if that needs a user gesture, it shows "Tap to resume audio" and the next tap anywhere on the page resumes it. `statechange` events are logged as `[ShowPilot] audio context state: …`. ShowPilot never calls `audioCtx.suspend()` itself — keep it that way, or the state handler will fight it.

### Bluetooth / car audio latency (investigated, not solvable in a browser)

Measured on a current Android flagship playing through Android Auto over Bluetooth: Chrome reported `outputLatency` 0.008s and `getOutputTimestamp()` ≈ 0s — the browser only sees the phone's own buffer, not the Bluetooth hop (real delay typically 150–300ms, more on some head units). iOS Safari doesn't expose it either. So automatic Bluetooth compensation is impossible from a web page. PulseMesh's "automatic Bluetooth delay compensation" relies on its native apps, which can query the OS. Options considered: a manual per-device offset slider (rejected by the maintainer — must be automatic), a tap-along calibration (same objection), and microphone chirp loopback (automatic, but needs mic permission and may flip Android car Bluetooth into call-audio mode — not pursued mid-season). The realistic path is a native Android app (Android reports Bluetooth latency to apps), ideally cross-platform (e.g. Flutter) so an iOS build stays possible later.

### Daemon restart after plugin update

The daemon is a long-running Node process started by FPP's `postStart.sh`. It does NOT restart automatically when the plugin is updated via git pull. After any plugin update that touches `showpilot_audio.js`:

```bash
sudo /home/fpp/media/plugins/showpilot/scripts/restart-daemon.sh
```

This uses the PID file (`/tmp/showpilot-audio.pid`) for a clean kill and respawn.

### Audio cache and ffmpeg

Audio files uploaded by the FPP plugin are stored as `data/audio-cache/<sha256>.bin`. On startup, ShowPilot runs a background job to transcode all MP3 `.bin` files to AAC/M4A using:

```bash
ffmpeg -y -f <probed_format> -i input.bin -vn -c:a aac -b:a 192k -movflags +faststart output.m4a
```

The `-vn` flag is critical. `ffprobe` is used to detect the actual format. ffmpeg is installed via `apt-get install -y ffmpeg` in `deploy.sh`.

---

## Debug overlay

Add `?debug=1` to the viewer URL to show the sync debug overlay. Key fields:

- `drift` — audio-clock-relative drift from snap anchor (ms). After snap this should be near 0 on all devices regardless of OS clock differences.
- `engine` — `WebAudio` (always)
- `fppPos` — FPP's current position (extrapolated from last fppStatus via clockOffset)
- `audioPos` — `htmlAudio.currentTime` (from Web Audio tracking)
- `staleness` — how old the last fppStatus reading is
- `clockOffset` — server clock minus client clock in ms (used for fast-start position and display only, NOT for drift correction after snap)
- `seekedTo` — where audio was positioned at last snap/crossfade
- `deviceOff` — per-device calibration offset (N/5 = calibration progress, recalibrates every song)

If `fppPos` and `audioPos` differ significantly but `drift` shows ~0ms, that's expected — it means the audio-clock-relative measurement is working. The gap between `fppPos` and `audioPos` reflects the speaker offset, which `deviceOffset` corrects automatically on the next song.

---

## Version history (recent)

| Version | Change |
|---------|--------|
| 0.33.117 | Disable crossfade correction — devices in sync with each other at song start. |
| 0.33.128 | Grid-quantized startup sync: `playAtServerMs = ceil((serverNow+2000)/2000)*2000`. All phones start at same 2s boundary. Fixed `syncPoint` variable undefined in htmlAudio shim. |
| 0.33.129 | Fast-start + syncPoint snap + follow-up crossfade. `mediaName` added to `/api/now-playing-audio` response (was undefined, causing syncPoint filename match to always fail). Remove grid wait — snap fires immediately when syncPoint arrives. |
| 0.33.130 | Per-filename syncPoint resolver map (`window._pendingSyncPointResolvers`) replaces single global. Next-song prefetch while current song plays. |
| 0.33.131 | Re-enable PLL playbackRate correction (±0.5% max). |
| 0.33.132 | Reduce PLL rate further to prevent overshoot. |
| 0.33.133 | Remove noisy one-way clockOffset update from fppSyncPoint handler. High-jitter burst rejection: new burst rejected if best RTT > `bestRttEverMs * 3`. |
| 0.33.134 | Replace PLL with PulseMesh-style crossfade correction (50ms fade, 50ms threshold, 10s cooldown). Device-clock-free drift measurement using `snapAnchorCtxTime`/`snapAnchorPosSec` — eliminates inter-device OS clock differences from sync calculation. `snapPendingUntilMs` blocks periodic crossfade during snap+follow-up window. Crossfade only fires with fresh fppStatus (< 200ms stale). |
| 0.33.135 | Fast 5-sample calibration: measures `audioPos - fppPos` 3s after follow-up crossfade, stores median as `sp_device_offset`. Recalibrates every song. Automatically corrects speaker offset without manual `audioSyncOffsetMs` tuning. |
| 0.33.146 | Baseline next-song tracking. Adds `baseline_next_sequence_name` to `now_playing`. At vote/jukebox handoff, saves FPP's current "next" as the baseline. `getNextUp` returns the baseline (tier 3) while the interrupting song plays instead of FPP's live report (which points into the voting playlist). Cleared when FPP starts the song matching the baseline. Fixes "Up Next" showing the wrong title during interruptions. |
| 0.33.147 | Expire stale un-handed jukebox queue entries. `popNextQueuedRequest` now skips entries older than 2 hours. `cleanupStaleRequests(120)` runs every 60s alongside existing handoff cleanup. Fixes requests from earlier sessions (or made during a plugin restart) silently jumping the queue. |
| 0.33.148 | Descriptive helper text on jukebox and voting setting checkboxes. Muted explanation lines added under each checkbox. "Hide sequence from list after played" renamed to "Hide song from the request list after it plays." "Block votes for the song that's already winning" renamed to "Block votes for the song that's already leading." Also: PRIMER.md added to repo. |
| 0.33.149 | Emit `nextScheduled` socket event immediately after a successful jukebox request so "Up Next" updates instantly for all connected viewers instead of waiting for the next poll cycle. (`routes/viewer.js` jukebox/add handler.) |
| 0.33.151 | Viewer QR code generator on the Dashboard. `GET /api/admin/qr-code` returns a server-generated PNG (via `qrcode` npm package) of the viewer URL. Card shows URL text, Copy URL button, and Download PNG button. Hidden with a prompt card when `public_base_url` isn't configured. New dependency: `qrcode ^1.5.4` — run `npm install` after pulling. |
| 0.33.154 | Fix audio relay reconnect loop. `audio-position-relay.js` was calling `ws.close()` on a CONNECTING socket, triggering an immediate close event that rescheduled `connect()` every 500ms forever. Fix: skip `ws.close()` when `readyState === 0`, clear `reconnectTimer` at connect entry, guard close/error handlers against scheduling a second reconnect when one is already pending. |
| 0.33.152 | FPP playlist cooldown suppression. When a sequence with `cooldown_minutes > 0` plays, `/api/plugin/state` now includes a `playlistPatches` array telling the plugin to set `"enabled": 0` on that entry in FPP's playlist JSON. FPP skips disabled entries in normal rotation. The plugin (v0.13.40) applies patches on each state fetch and persists re-enable timestamps to `/home/fpp/media/config/showpilot-cooldowns.json` so they survive plugin restarts. Re-enables fire promptly on each loop iteration and on startup. |
| 0.33.155 | Race mode — tap-to-win competitive viewer mode. Viewers tap their chosen sequence as fast as possible; the sequence with the most taps at round end (or first to a target count) wins and plays next. New DB columns: `race_duration_seconds`, `race_end_on_sequence_end`, `race_target_taps`, `race_interrupt_winner`, `race_active`, `race_started_at`, `race_ends_at`, `race_winner`. New `race_taps` table. Admin UI: Race settings card, race progress bar visible during active race, winner animation. FPP plugin handoff via `raceWinner` field on `/api/plugin/state`. |
| 0.33.156 | Race mode polish and FPP plugin handoff refinements. `viewer_control_mode = 'RACE'` recognized in `getNextUp()` and plugin state handler. |
| 0.33.157 | Race mode FPP scheduler command. `POST /api/plugin/viewer-mode` now accepts `RACE` as a valid mode (alongside VOTING, JUKEBOX, OFF, ON), allowing FPP scheduler events to trigger race mode at specific playlist positions. Race mode pill added to admin header (amber/gold background). Plugin v0.13.64 ships the companion `set_mode_race.php` command. |
| 0.33.162 | Multi-language audio variants. `audio_cache_files` gains a `language` column. Admin can upload alternate-language audio files per sequence via a new 🌐 Languages modal on the Sequences tab. Three new endpoints: `GET/POST/DELETE /api/admin/audio-cache/languages/:sequence`. `/api/audio-stream/:sequence` accepts `?lang=XX` and falls back to `default` if variant is missing. `/api/now-playing-audio` response includes `languages` array. Language picker row appears in the player bar when a sequence has 2+ language variants; choice persists to localStorage as `sp_audio_lang`. rf-compat cache buster bumped to v=73. |
| 0.33.163–0.33.168 | Bug fixes for language feature: fix nested-backtick onclick in sequence row (use addEventListener + data attrs); widen actions column; fix modal CSS vars for light theme; fix Remove button using createElement instead of innerHTML; move updateLanguagePicker before early-return so it always runs; remove audioCtx gate. |
| 0.33.169 | Bump rf-compat cache buster to v=73 — all language picker changes were invisible to browsers still serving v=72. |
| 0.33.170 | Fix storeLanguageFile: key upsert on (media_name, language) not hash, preventing same-file upload from overwriting the default row's language tag. |
| 0.33.171 | QR code switched from PNG to SVG. `GET /api/admin/qr-code` now returns `image/svg+xml` with fixed width/height stripped so it scales freely via CSS. Admin displays via `<object>` tag; Download button saves `.svg`. Prints and displays crisply at any size. |
| 0.33.173 | Fix sequence delete 500: detachCacheForMediaName used SET media_name=NULL which violates UNIQUE(media_name,language); now DELETEs rows instead. |
| 0.33.174 | Fix sequence delete FK constraint: delete jukebox_queue and votes rows before deleting sequence. |
| 0.33.175 | Automatic viewer page translation: LibreTranslate/DeepL/MyMemory backend, SQLite cache, Accept-Language detection, admin settings + cache management. |
| 0.33.176–0.33.184 | Translation engine iterative fixes: swap to MyMemory backend (LibreTranslate public API requires paid key); fix token alignment between extractStrings/spliceStrings; fix CSS `>` chars breaking token split; fix HTML entity mismatch between extraction and splice; fix translation_backend DB value stuck on libretranslate; fix cache always missing (lookup by template_id+lang only). |
| 0.33.185 | Gate demo banner injection on config.demoMode — production installs no longer have demo CSS/HTML/JS in view-source. |
| 0.33.186 | Player bar translation via `_pt()` lookup table (ES/FR/DE/PT/IT/PL); stable translation cache key using template hash instead of rendered HTML hash; rf-compat v=74. |
| 0.33.187 | Fix translation cache always missing (lookup by template_id+lang, use hash for staleness only); fix test endpoint calling LibreTranslate; page loads no longer slow. |
| 0.33.188 | Fix player bar translation: use navigator.languages[0] instead of navigator.language; rf-compat v=75. |
| 0.33.189 | Translate "Show isn't playing right now" and "Winner!" via _pt(); rf-compat v=76. |
| 0.33.190 | Move Translation settings to Viewer Page tab as a sub-tab (Template Editor + Translation). |
| 0.33.191 | Fix viewer page sub-tabs layout: use sub-tabs class in card wrapper so tabs render horizontally. querySelectorAll live updates: `.now-playing-text`, `[data-showpilot-next]`, `[data-showpilot-queue-size]`, `[data-showpilot-queue-list]` now update all matching DOM copies (fixes templates with duplicate `{PLAYLISTS}` / `{NEXT_PLAYLIST}` blocks). Jukebox handoff re-return: when no fresh entry to hand off, re-returns the already-handed-off-but-not-confirmed-played entry so FPP keeps it queued in non-interrupt mode. Baseline snapshot on jukebox add: captures return point at first add. Interrupt-mode auto-detection in `/next`. `nextScheduled` socket listener added to rf-compat. rf-compat v=77. |
| 0.33.172 | Fix audio_cache_files schema: `hash TEXT PRIMARY KEY` prevented storing multiple language variants (SQLite only allows one row per hash). Migration rebuilds the table with `id INTEGER PRIMARY KEY AUTOINCREMENT` and `UNIQUE(media_name, language)` — one row per file+language combination, hash is a plain column. All upserts in `storeUploadedFile`, `storeLanguageFile`, `linkMediaNameToHash` updated to use `ON CONFLICT(media_name, language)`. |
| 0.33.194 | Audio debug UI off by default. Sync debug overlay (`?debug=1` equivalent) and player bar drift/calibration stats are now hidden unless enabled. New admin Settings → Debug sub-tab with two checkboxes: "Show sync debug overlay on viewer page" and "Show audio stats in player bar". Both default off. Bootstrap passes `debugOverlayEnabled` and `playerStatsEnabled`; rf-compat gates the overlay and `driftEl` on those flags. |
| 0.33.195 | Vendored the last three CDN-loaded frontend libraries: Chart.js 4.4.1, Monaco 0.45.0, and jsPDF 2.5.1 + jspdf-autotable 3.8.0 now load from `public/vendor/` instead of `cdnjs.cloudflare.com` / `unpkg.com`. Motivation is NOT the FPP plugin guidelines that drove the equivalent Lite change (main is self-hosted and answers to no plugin review) — it is that the admin panel degrades without internet. Monaco backs the viewer-page template editor, so on a LAN-only or firewalled show box that editor silently failed to load. Also fixes a latent trap: `public/vendor/jspdf.umd.min.js` and `jspdf.plugin.autotable.min.js` had been sitting in the repo since an early vendoring pass as 21-byte files containing the literal text `Host not in allowlist` (a sandbox egress-proxy error body saved to disk as the library). Harmless while main still loaded jsPDF from the CDN, but it would have broken Export Stats PDF the moment the loader was pointed at them — which is exactly what happened in Lite v0.5.51 (fixed in Lite v0.5.53). Both replaced with genuine npm-registry bundles and verified functionally: loaded in a VM context, `window.jspdf` defined, `doc.autoTable` attaches, real `%PDF-` output generated. All five loader references in `public/admin/index.html` rewritten to absolute `/vendor/...` paths, which resolve through the existing root static mount in `server.js`; every URL was fetched against a static server over `public/` to confirm it returns 200 before shipping. Adds ~13 MB to the repo and to the Docker image. |
| 0.33.196 | Two pre-existing bugs found and fixed while investigating a reported update-button crash (neither was introduced by v0.33.195's vendoring, both predate it back to at least v0.33.194). (1) The `#updateActionStatus` div in the Settings → Updates panel had literal backslash-escaped quotes baked into its markup (`id=\"updateActionStatus\"` instead of `id="updateActionStatus"`), so the browser never parsed a real `id` attribute and `document.getElementById('updateActionStatus')` in `applyUpdate()` returned null — the actual cause of the `Cannot set properties of null (setting 'textContent')` crash on clicking "Update now." One isolated occurrence in the file; fixed. (2) `initMonacoIfNeeded()` guarded against re-initializing with `if (monacoEditor) return`, but `monacoEditor` is only assigned inside the async `require(['vs/editor/editor.main'])` callback — so the three call sites that invoke it (tab switch, PDF export, the third at line ~8040) can each fire before that callback resolves, and each would pass the guard and re-issue the AMD require, producing "Duplicate definition of module 'vs/editor/editor.main'" in the console. Fixed by caching the in-flight promise in `_monacoInitPromise` so every caller awaits the same single load. Reproduced in isolation with a fake AMD loader before and after: old code triggered the duplicate-definition path twice under three concurrent callers, fixed code triggered it zero times. |
| 0.33.200 | Sequence categories. Operators group sequences into named categories; the viewer page shows a heading above each group, and each category can be enabled/disabled individually (disabled = its sequences vanish from the viewer list and votes / jukebox requests / race taps for them are rejected server-side). New `lib/categories.js`; three new config columns (`sequence_categories` JSON, `viewer_show_categories`, `uncategorized_label`); new admin endpoints under `/api/admin/categories` plus `POST /api/admin/sequences/bulk-category`; Category column + Categories card + bulk "Set category" on the Sequences tab; `/api/state` gains `categoryHeaders` + `uncategorizedLabel` and returns sequences pre-grouped. rf-compat v=78, default-template `viewer.js` v=0.5.2. Non-audio — mirrored to Lite. See "Sequence categories" under Architecture decisions. |
| 0.33.201 | Removed a stale nested copy of the whole repo at `showpilot/` (committed by accident in v0.33.191, pinned at that version). Nothing referenced it, but it shipped inside every Docker image (`COPY . .`) and confused searches. Repo housekeeping only; no app behavior change, so no ShowPilot-Lite or Demo change. |
| 0.33.202 | **Audio sync fixes (phones were steadily late; "refresh doesn't help").** (1) The post-snap drift check compared the audio position to anchors set from the same values, so it was always 0 and nothing ever corrected a bad snap — replaced with real continuous correction against FPP's position (50ms threshold, 10s cooldown, ≥3 fresh readings). (2) New `estimateFppPosNow()` upper-envelope estimator absorbs the daemon's 0–100ms send-time stamping and stale first syncPoints. (3) Relay now corrects FPP-host clock differences into server time (min receive gap minus half min ping RTT). (4) `fppPosition` handler no longer drags `clockOffset`. (5) Output latency now advances the start position instead of delaying the start (was lead + 2× latency late); clamped 0–0.4s. (6) Runaway `sp_device_offset` auto-calibration removed and the stored value cleared. (7) Periodic crossfade no longer lands 50ms ahead. Cache-buster `rf-compat.js?v=79`. Operators who tuned `audioSyncOffsetMs` to compensate for the old lag may need to reduce it. Audio-only: ShowPilot main only. |
| 0.33.203 | **Next song not starting until page refresh (seen on Android over Bluetooth / Android Auto).** `handleTrackChange()` marked the new song current before loading it, so a failed or stalled load (or a device-paused `AudioContext`) left it silent forever. Added a per-call token (late loads can't play over newer ones), a 20s download timeout, retry-with-backoff on failure, a 15s "nothing playing" watchdog in `syncOnce()`, resume of a non-running `AudioContext` before starting a track (with "Tap to resume audio" + resume-on-next-tap fallback), and logging of context `statechange` events. Primer: new "Track-change recovery" and "Bluetooth / car audio latency" sections. Cache-buster `rf-compat.js?v=80`. Audio-only: ShowPilot main only. |
| 0.33.204 | **Smooth sync corrections (no more audible pause/skip).** The syncPoint snap was a hard stop/restart and every correction was a jump. Now: start waits briefly for FPP's first readings of a new song so it starts in the right place; errors under 150ms are closed by a proportional playback-speed nudge (±0.5% max, inaudible) with variable-rate position tracking (`currentRate`, `renderedPosAt`, `setSourceRate`); errors over 150ms use a single `crossfadeTo()` with 80ms equal-power curves. Loop simulated (no overshoot) and position math verified against a real Web Audio engine (0.08ms max error). Debug overlay shows current speed. Cache-buster `rf-compat.js?v=81`. Audio-only: ShowPilot main only. |
| 0.33.205 | **Real-time song changes and Stop/Next (no more clipped song starts).** The position relay keeps FPP's live state (`getLiveFpp`); `now-playing-audio` answers from it while fresh (read-only override: live stop → not playing; live file ≠ listener's → that song, resolved by `media_name`). The phone reacts to `fppPosition` changes (`onFppLiveEvent`): stops immediately on Stop, and on a new file syncs at once and re-checks every 200ms (≤3s) instead of waiting for the 1s poll — armed only by changes, never by repeats. Primer: new "Real-time song changes" section; estimator note updated for plugin v0.14.6's accurate timestamps. Cache-buster `rf-compat.js?v=82`. Audio-only: ShowPilot main only. |
| 0.33.206 | **Song progress bar on the viewer page (opt-in setting) + `{NOW_PLAYING_PROGRESS}` placeholder.** New Settings option shows a slim progress bar with time left on every viewer page (top or bottom, time on/off, color); live-updates open pages via `/api/state`. Template authors can place `{NOW_PLAYING_PROGRESS}` instead. Viewer page now corrects for the phone's clock (`serverNowMs` in `/api/state` + bootstrap), which also fixes `{NOW_PLAYING_TIMER}` on phones with a wrong clock. Off by default. Mirrored to Lite v0.5.55 (not audio). Cache-buster `rf-compat.js?v=83`. **Also: "Up Next" no longer sticks on one song (community PR #18).** The return point (`now_playing.baseline_next_sequence_name`, tier 3 of `getNextUp`) was only cleared when FPP started exactly that song (plus a Jukebox-only fallback), so in Voting/Race one missed return (manual jump/restart, cooldown skip, schedule change, playlist end) pinned "Up Next" to it for good. `/api/plugin/playing` now clears it when a `schedule` song starts in any mode (Jukebox still waits for its queue to drain) and when the plugin reports an empty sequence (FPP idle); `getNextUp` returns null when nothing is playing (viewer shows "—"), and its sort-order fallback skips disabled categories. Mirrored to Lite v0.5.55. **Also: Docker pipeline (issue #19)** — arm64 now builds on a native `ubuntu-24.04-arm` runner instead of QEMU emulation (which compiled better-sqlite3 under emulation and failed intermittently); per-arch builds push by digest and a merge job publishes the multi-arch manifest with the unchanged tag rules. See the workflow header. |
| 0.33.207 | **Song progress bar sits on the player, themed.** Default position is now "On the player": on the top edge of the Listen-on-Phone player while it's open, in the player theme's color (e.g. Halloween orange); on the screen's bottom edge while the player is closed. "Top of the screen" remains as an option. Existing 0.33.206 settings move to the new default. The color setting is now an override ("Match player theme" resets it). New `showpilot:player-mode` / `showpilot:player-theme` events. Mirrored to Lite v0.5.56 (its now-playing player bar). Cache-buster `rf-compat.js?v=84`. |
| 0.33.208 | **New admin layout (default) + Cockpit tablet mode, classic kept.** New `admin/new.html` (Direction A: collapsible hover-expand rail with pin, control strip, On Air panel with progress, live vote/queue/race panel, top sequences, QR) becomes each user's default; a one-time notice explains switching back; per-user `admin_layout` / `layout_notice_seen` with `PUT /me/layout` and `PUT /me/layout-notice-seen`. Classic `index.html` unchanged apart from a preference redirect, `?section=` deep links and a "New layout" button. New `admin/cockpit.html` tablet remote. Shared `shared.js` + `themes.css`. Mirrored to Lite v0.5.57. |
| 0.33.209 | **Full admin redesign: the new layout is now the whole admin, not a separate dashboard page.** v0.33.208's `new.html` only covered the dashboard and every other link fell back into the old layout. Now `ui-new.css` + `ui-new.js` restyle and reorganize the one admin page: every section and every Settings sub-page lives in the collapsible sidebar, header controls move into the rail/top bar, and the new dashboard replaces the old one in place. Classic = same page without `body.ui-new`. Removed all client-side redirects (possible trigger of a Defender cloud false positive); `/admin/new.html` now 301s to `/admin/`. Cockpit loads socket.io with a static tag. Mirrored to Lite v0.5.57. |
| 0.33.210 | **Old "Powered by OpenFalcon" footer on the default viewer page.** The default template is copied from `public/viewer.html` into `viewer_page_templates` once, at first boot, and never refreshed, so installs from before the OpenFalcon -> ShowPilot rename kept the old footer and the name "Default (OpenFalcon)". A startup cleanup in `lib/db.js` (right after the default-template seed) replaces the exact phrase in built-in rows' `html` and `draft_html` and renames the template (unless "Default (ShowPilot)" already exists). User-created templates are never touched; no-op once applied. Tested on a simulated pre-rename DB. The remaining `OpenFalcon` references in `rf-compat.js` (`window.OpenFalconVote/Request`, `data-openfalcon-*`) are intentional backward compatibility for old templates. Mirrored to Lite v0.5.58. Also: `LICENSE` copyright holder renamed from "OpenFalcon Contributors" to "ShowPilot Contributors" (MIT terms unchanged). Also: **bcrypt 5 -> 6** (npm audit issue: bcrypt 5 pulled in `@mapbox/node-pre-gyp` with a vulnerable `tar`). bcrypt 6 ships Node-API prebuilds in the package (linux x64/arm64/arm, glibc + musl, macOS, Windows) via `node-gyp-build`, so nothing downloads at install; API used here (`hash`, `hashSync`, `compare`) is unchanged and hashes stay `$2b$`. Lockfile also refreshed within existing ranges (express 4.22.3 -> qs 6.16.0; body-parser, engine.io, socket.io-adapter/parser, ws patch updates): `npm audit` 10 -> 0. Tested: DB created by bcrypt 5 signs in under bcrypt 6, password change + re-login work, and bcrypt 5 verifies the new hash (rollback safe). |
| 0.33.211 | **New-layout fixes.** Wide tables (e.g. Sequences) were cut off on the right with no way to scroll: `ui-new.css` gave tables `overflow: hidden` and kept the classic 1600px content cap. Now cards scroll horizontally (`overflow-x: auto`), tables no longer clip, and content uses the full width beside the rail. The page title in the top bar is styled explicitly (color/display/visibility) after a report that it was missing in a real browser (not reproducible in jsdom). The address bar now follows navigation (`?section=<tab>`, via `history.replaceState`) so a refresh stays on the same section; syncing starts only after setup so an incoming `?section=` link isn't erased (caught in testing). Mirrored to Lite v0.5.59. The menu rail also collapses as soon as the mouse leaves it: it used to stay expanded after a click (the clicked button kept focus under `:focus-within`). Expansion on focus is now keyboard-only (`:has(:focus-visible)`, in separate rules so browsers without `:has()` keep hover), and mouse clicks release focus. |
| 0.33.212 | **New layout on phones and tablets.** On phones and touch-only devices (`(max-width: 760px), (hover: none)` — same query in `ui-new.css` and `isDrawerMode()` in `ui-new.js`) the hover-expand rail couldn't work and its Settings sub-pages were unreachable. There the rail is now a slide-out menu: a menu button (`#spnMenuBtn`) at the start of the top bar opens it over a backdrop; tapping a section with sub-pages expands/collapses it instead of navigating; tapping a page navigates and closes the menu; backdrop tap and Escape close it. The page uses the full width (no 72px rail), the top bar wraps, and the dashboard's control strip stacks with full-width mode buttons. Desktop with a mouse is unchanged. Tested in jsdom as a touch device and as desktop, both repos. Mirrored to Lite v0.5.60. Also: **README.md audited against the code.** Fixed: FPP requirement (7.0 -> 10.0+, required by the plugin); the install/update download URL (`releases/latest/download/showpilot.tar.gz` never existed — ShipPilot creates GitHub Releases without uploading an asset — now the main-branch archive, 5 places); Race mode, tiebreak, audio sync, alternate-language audio, page effects, progress bar, categories, translation, cooldowns, new admin layout, Cockpit, QR code, backup/restore and in-app updates added; 13 block types (not 12, Up Next was missing); GPS gate re-check every 5 minutes (not 15); rewritten "Install the FPP plugin" (pluginInfo.json URL, Content Setup → ShowPilot, current field names, log `plugin-showpilot-plugin.log`); config table (`jwtSecret`/`showToken` default `null` = auto-generated, plus `trustProxy`, viewer/voting/demo keys); troubleshooting and project structure. |
| 0.33.213 | **Listener audio timing.** A small timing button in the Listen-on-Phone player opens a sheet where listeners shift the sound earlier/later (+/-50ms nudges, slider -500..+1000ms, presets) until it lines up with the lights — for Bluetooth/car delay the browser can't see. Stored per phone in `localStorage` only; added to `getOutputLatencySec()` so every sync path honors it via the existing smooth correction. Admin switch `listener_timing_enabled` (default on). README audio features updated. Cache-buster `rf-compat.js?v=85`. Audio-only: ShowPilot main only. |
| 0.33.214 | **Customizable Cockpit.** Cockpit is now a tile grid built from each user's saved layout: 29 tiles (show control, safeguards, songs + automatic category switches, viewer page, status, live panels), added/moved/resized/removed in "Edit layout" with drag-and-drop or buttons; saved per user (`users.cockpit_layout`, `PUT /me/cockpit-layout`). Settings → Cockpit page. Rows grow with content, so long labels no longer overflow tiles. Mirrored to Lite v0.5.61. |
| 0.33.215 | **Optional larger two-row player on phones.** New setting (`player_tall_layout`, off by default): on screens <= 600px the Listen-on-Phone player shows the full title and artist on the first row and bigger, spread-out controls on the second. Pure CSS on the existing elements (`display: contents` wrapper), page bottom space follows the layout. Also hides the timing button in the "show isn't playing" state. Cache-buster `rf-compat.js?v=86`. Audio player: main only. |
| 0.33.216 | **Player settings moved to Settings → Audio.** "Larger two-row player on phones" (v0.33.215) and "Let listeners adjust audio timing" (v0.33.213) had been placed on Settings → Debug (anchored next to the audio-stats option). They now sit under a "Listen-on-Phone player" heading on Settings → Audio, after the audio master switch. Same ids and keys, so saved values carry over. Admin page only. |
| 0.33.217 | **"Larger two-row player on phones" moved to Viewer Page → Template Editor**, after the player decoration options — it's a look/layout choice. "Let listeners adjust audio timing" stays on Settings → Audio (audio behavior). Same ids and keys, so saved values carry over. Admin page only. |
| 0.33.218 | **Configurable listener timing slider range** (community request). Settings → Audio → Listen-on-Phone player: "Slider range: from … to … ms" (`listener_timing_min_ms` / `listener_timing_max_ms`, default -500 / +1000; allowed -2000..0 and 0..+3000). Sanitized in the player (blank = default); saved offsets clamp into the range and out-of-range presets are hidden. Cache-buster `rf-compat.js?v=89` (skips 87/88, used by unreleased test builds on the maintainer's server). Also: **Admin "Up next" matches the viewer page; its label shows the real source** (community PR #21). `/api/admin/stats` kept its own copy of only the queue/vote/plugin-next tiers, so the dashboards and Cockpit showed "—" whenever the plugin reports no next (the Remote Playlist itself playing, a vote winner playing) while the viewer page showed the right song. New `getNextUpInfo(cfg, nowPlayingName)` in `lib/db.js` returns `{ name, source }` (`'queue'` / `'vote'` / `'schedule'`); `getNextUp()` is now a wrapper around it, and stats uses it and sends `nextUpSource`. The new dashboard (`ui-new.js`) and Cockpit label Up Next from `nextUpSource` instead of the mode (which said "Vote leader" for scheduled songs and "Race leader", which `getNextUp` never picks). Tested: all five tiers return the right name and source and match `getNextUp`; live `/stats` and `/api/state` agree when the plugin reports no next. Mirrored to Lite v0.5.62. |
| 0.33.219 | **Beta channel in the in-app updater.** Settings → Updates gets a separate "Beta channel — for debugging and testing only" section: clear not-stable warning, latest beta details from GitHub, an "I understand" acknowledgement before the install button enables, and a confirmation. Installs the exact tip commit of the untagged `beta` branch (`POST /updates/apply-beta`, same snapshot/pre-flight/rollback as stable). When running a beta, a notice offers **Return to stable**. `compareVersions()` ranks a stable release above its prereleases. Not in Docker (use `:beta`), demo or Lite. |
| 0.33.220 | **Show Hours block can show all the time** (community PR #22). The block was always wrapped in `{after-hours-message}`, so it only appeared while Viewer Control was Off; shows that leave Viewer Control on never displayed their hours. New per-block "Show When" (`showWhen`): `viewerControlOff` (default, old behavior) or `always` (no gate). Blocks saved before the option have no `showWhen` and keep the old behavior via `defaultProps` (render merges `{ ...def.defaultProps, ...b.props }`). The block editor now also lists a block type's `defaultProps` keys a saved block lacks, so options added to a block type later are editable on existing blocks. Also: README Docker section documents testing a beta (the `:beta` image; backup first; back to `:latest` to return). Tested: existing / always / viewerControlOff blocks render gated / ungated / gated in both repos. Mirrored to Lite v0.5.63. Released stable v0.33.220 outranks beta v0.33.220-beta.1, so the beta is rebuilt on top as v0.33.221-beta.1 (rule: each stable release gets a fresh beta on top). |
| 0.33.221 | **Audio Sync Help block + timing sheet tip** (community idea). New Visual Designer block "Audio Sync Help": collapsible (one line until tapped; "Start expanded" option), editable title/body/accent colour, real button icons via `[listen]` / `[timing]`; only shown when the timing button exists. The timing sheet gets a one-line second-phone tip (switch: Settings → Audio → "Show a tip in the timing sheet"). Cache-buster `rf-compat.js?v=91`. Audio player: main only. |
| 0.33.222 | **A refresh lands on the same admin page, including sub-pages, in both layouts.** The address now carries the section and sub-page (`?section=settings&sub=audio`). `index.html`'s `restoreSectionFromUrl()` runs after sign-in on both login paths: it opens what the address names (only if that section / sub-page exists, else ignored), then wraps `switchMainTab()` / `switchTab()` so every move rewrites the address via `history.replaceState` (`writeAdminUrl()`; Dashboard clears both parameters). Replaces the new layout's own section-only address code in `ui-new.js` (removed), and adds it to the classic layout, which previously never updated the address. Tested with the real admin against a live server in both layouts: open by address, Settings → Voting, Sequences, Dashboard, and refresh on the Voting address. Mirrored to Lite v0.5.64. Also: **the sync debug tools move into main** (Sync probe + Microphone sync measurement, off by default under Settings → Debug; see "Sync debug tools"; cache-buster `rf-compat.js?v=93`), and **the Updates page only offers the beta channel when a beta newer than the installed version exists** (`betaAvailable`; `apply-beta` refuses older betas). The beta branch (v0.33.222-beta.1) is older than this release, so the section disappears once it ships. Tested: gating via a live server with GitHub-shaped responses (older → hidden + 409, newer → offered) and the page in stable / newer-beta / running-beta / Docker states; full regression (mic, probe, timing, ranges, sync help). |
| 0.33.223-beta.1 | **Beta (showpilot-beta, no tag): hidden output delay diagnostic + opt-in compensation, mic tool v2** (see "Sync debug tools"). Cache-busters `rf-compat.js?v=94`, `sp-mic.js?v=2`. |

**Plugin version history (this session):**
| Version | Change |
|---------|--------|
| 0.13.37 | Reduce syncPoint suppression: MediaSyncStart 2000→1000ms, MediaSyncPacket song-change 1500→800ms, setTimeout 3100→1500ms. First syncPoint now arrives at ~3s instead of ~4s. |
| 0.13.38 | Further reduce: broadcast interval gate 2000→1000ms, setTimeout 1500→1000ms. First syncPoint at ~2s. |
| 0.13.39 | PID file (`/tmp/showpilot-audio.pid`) written on startup, cleaned on exit. `postStart.sh` kills via PID file first. `scripts/restart-daemon.sh` helper for post-update restarts without full fppd cycle. |
| 0.13.40 | FPP playlist cooldown suppression. Handles `playlistPatches` from `/state`: patches playlist JSON on disk to disable cooled-down sequences, persists re-enable timestamps to `showpilot-cooldowns.json`. |
| 0.13.41 | Fix fatal PHP crash in `applyPlaylistPatches`: patches from `ofHttp` are stdClass objects, not arrays — `$patch['key']` throws `Error` in PHP 8. Fixed to use `$patch->key` object syntax throughout. |
| 0.13.63 | Race mode support: `raceWinner` field handling in state response, interrupt-aware `effectiveInterrupt` for race winner playback. |
| 0.13.64 | `set_mode_race.php` scheduler command. Calls `POST /api/plugin/viewer-mode` with `{ mode: "RACE" }` so FPP scheduler events can activate race mode at a specific playlist position. |

**Current versions (as of September 2026):**
- ShowPilot: v0.33.200
- FPP Plugin / Audio Daemon: v0.13.64
- rf-compat.js cache buster: v=78

---

## Architecture decisions worth knowing

**Surgical secrets restore (v0.25.2):** `lib/backup.js` extracts only `jwtSecret` and `showToken` from the backup's config.js via regex. Whole-file replacement was wrong — baked in source's port and dbPath.

**Body-size routing (v0.25.4):** Backup router mounted BEFORE global `express.json()` so backup requests hit the route-level 100MB parser first. Don't move that mount.

**Middleware ordering invariant (v0.25.5):** `cookieParser()` MUST run before any router that calls `requireAdmin`. Don't reorder.

**In-app updater (v0.33.0):** Git-in-place, no symlink reshape. Single snapshot at `data/.snapshots/previous/`. audio-cache excluded from snapshots. Docker gated to status-only.

**Web Audio over HTML5 `<audio>` (v0.33.112):** Permanent. MP3 seeking on `<audio>` causes decoder restarts with audible artifacts. PCM-decoded Web Audio is the correct architecture. Do not propose reverting.

**No playbackRate for sync (v0.33.134):** playbackRate correction was tried and abandoned. It oscillates because the drift measurement has lag, and ±0.5% causes audible pitch changes on some devices. Crossfade is the correct correction mechanism — inaudible 50ms fade between sources at the correct position.

**Device-clock-free drift (v0.33.134):** OS clocks on different devices (phone vs PC) can differ by 100-300ms even on the same LAN. Using `clockOffset`-based `fppPositionNow` as the drift reference caused each device to correct to a different position. The fix: measure drift as `htmlAudio.currentTime - (snapAnchorPosSec + audioCtxElapsed)` — purely audio-clock-relative, device-clock-independent.

**Multi-language audio variants (v0.33.162+):** `audio_cache_files` stores one row per `(media_name, language)` pair. `language = 'default'` is the primary track uploaded by the FPP plugin. Variants (e.g. `es`, `fr`) are uploaded manually via the admin Languages modal and served via `?lang=XX` on `/api/audio-stream`. The `audio_cache_files` table was rebuilt in v0.33.172 — original schema had `hash TEXT PRIMARY KEY` which prevented multiple rows per hash. New schema: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `UNIQUE(media_name, language)`. All upserts key on `(media_name, language)`. The viewer-side language picker lives inside the player bar and only shows when `languages.length >= 2` in the `/api/now-playing-audio` response. Language choice persists to localStorage as `sp_audio_lang`. Files must be the same duration as the default track for sync to work correctly — the sync engine treats a language switch as a file swap and applies the same syncPoint snap logic.

**Automatic speaker calibration (v0.33.135):** Do not add a manual `audioSyncOffsetMs` setting UI or suggest users tune it manually. The 5-sample fast calibration handles the speaker offset automatically every song. The `audioSyncOffsetMs` config value still exists for edge cases but should not need to be touched in normal operation.

**iOS AudioContext must be created inside the click gesture (v0.33.197, corrected v0.33.198):** The RF-compat viewer launcher's `btn.onclick` is `async` and awaits a location-gate check (`_ofVerifyLocationForAudio`) before `startup()` runs and creates `audioCtx`. On iOS Safari, an `AudioContext` only starts unsuspended if it's created/resumed synchronously within the user-gesture call stack; awaiting anything first breaks that window, so `startup()` ends up creating a permanently suspended context and audio silently never plays on iPhone. A community PR (#17, jddocea) surfaced this bug and proposed playing a silent looping mp3 through a second, disconnected `AudioContext` — that workaround masked the symptom without fixing the real (unconnected, never-reused) context, and left a permanent silent-audio loop running. Credit to jddocea for catching and reproducing the iPhone bug.

v0.33.197 fixed this by assigning straight to `audioCtx` synchronously in `btn.onclick`, before any `await` — but `audioCtx`'s truthiness is also how `setMode('open')` and `applyShowNotPlaying()` decide whether `startup()` has already run (`if (!audioCtx && !_showNotPlaying) startup();`). Assigning eagerly made that check think startup already happened, so `startup()` — which fetches audio and builds `gainNode` — never fired on first open. Broke audio for everyone, not just iPhone.

v0.33.198 fix: the gesture-created context is stashed in a separate `_pendingGestureAudioCtx` variable instead, and `startup()` consumes it (`audioCtx = _pendingGestureAudioCtx; _pendingGestureAudioCtx = null;`) — falling back to constructing its own if the pending slot is empty (e.g. the show-resumed path in `applyShowNotPlaying`, which calls `startup()` outside a gesture; that path not getting the iOS benefit is a pre-existing, accepted limitation, not something this fix needs to solve). What matters for iOS is the *moment the AudioContext object is constructed*, not which variable holds the reference or when — so this preserves the iOS fix while keeping `audioCtx`'s "has startup run" semantics intact elsewhere in the file. Lesson: when repurposing a state variable's truthiness as a signal, grep every place that checks it before changing when it gets set.

**iOS hardware mute switch silences Web Audio API by default (v0.33.199):** Fixing the suspended-context bug (above) wasn't enough — jddocea confirmed audio was still silent on iPhone with the physical ring/silent switch set to silent. This is a *separate* iOS behavior: Safari's Web Audio API defaults to the `"ambient"` audio session category, which respects the hardware mute switch, while `<audio>`/`<video>` elements default to a category that doesn't. This is exactly why old silent-mp3 "kick" hacks (including PR #17's) appeared to work historically — they weren't fixing AudioContext suspension, they were nudging Safari into a different session category via a real media element. Fix: use the standards-track `AudioSession` API instead (`navigator.audioSession.type = 'playback'`), set once at module init and re-asserted on every launcher tap (WebKit can reset session type back to `"ambient"` after an interruption like a phone call). Feature-detected via `'audioSession' in navigator` — no-op on non-Safari browsers. No silent asset, no permanent phantom audio loop. Confirm with jddocea that this resolves silent-mode playback before considering the iPhone audio saga closed.

**Sequence categories (v0.33.200):** Design choices worth preserving:

- *Storage is config JSON + the existing text column, not a new table.* `sequences.category` (TEXT — it predates this feature and already round-trips through backups and sequence snapshots) holds the category NAME. `config.sequence_categories` holds the ordered list as JSON: `[{"name":"Kids","enabled":1}, ...]`. Because it lives in `config`, backup/restore carries it with zero changes to `lib/backup.js` and no new backup section/UI. Names match case-insensitively (trimmed); `ensureCategory()` canonicalizes spelling whenever admin assigns a category, and `seedFromSequences()` (called once at startup from `server.js`, idempotent) registers any category text already sitting on sequences. A sequence whose category text isn't registered is treated as enabled and sorted after the known categories.
- *One function decides the viewer list:* `applyCategoryView(sequences, cfg)` drops sequences in disabled categories and, when headings are on, stable-sorts into category order (admin order → unregistered names A–Z → uncategorized last; admin `display_order` preserved within a group). It is applied in exactly two places: the server-side page render in `server.js` and `/api/state` in `routes/viewer.js`. The renderers do NOT sort — they just emit a header each time `category` changes between consecutive rows.
- *Three renderers must stay in sync:* `withCategoryHeaders()` in `lib/viewer-renderer.js` (used by both `renderPlaylistGrid` and `renderRaceGrid`), its mirror of the same name in `public/rf-compat.js` (used by `renderRowsForMode`; `category` and the header options are part of `computeGridSignature` so a category edit triggers a live rebuild), and `categoryHeaderEmitter()` in `public/viewer.js` for the built-in "Default (ShowPilot)" template, which renders its own `<ul>` lists client-side. The first two must produce byte-identical markup — verified with a parity harness that renders the same input through both for JUKEBOX/VOTING × headings on/off.
- *Header markup:* `<div class="sequence-category-header" data-showpilot-category="NAME">NAME</div>` (an `<li>` with the same class in the default template). Default CSS is injected in the `showpilot-rf-compat-reset` style block at the TOP of `<head>`, so any template rule for `.sequence-category-header` wins. The default uses `flex: 0 0 100%` + `grid-column: 1 / -1` so the header spans the full row in both flex and grid list wrappers (needed for `.voting_table`, where rows are 85%/15% sibling pairs). Headers carry no `data-seq`, so `findPlaylistWrappers()` and vote-count updates ignore them.
- *Zero-impact until used:* if no listed sequence has a category (or `viewer_show_categories = 0`), output is byte-identical to pre-category markup. Existing templates — including Remote Falcon imports — are untouched until an operator actually assigns categories. The "uncategorized" heading (`uncategorized_label`, default "Other") only appears when at least one categorized sequence is also listed.
- *Disabling is viewer-interaction only.* It does not touch FPP's playlist, scheduled rotation, `getNextUp`, or PSA logic, and it does not purge votes/queue entries already cast. Uncategorized sequences can never be disabled via this feature (use the per-sequence Visible toggle).
- *Admin API addresses categories by name in the JSON body* (`POST /categories/enabled|rename|delete|reorder`) rather than `/:name` paths — names may contain characters that are awkward in URLs. Every mutation emits the existing `sequencesReordered` socket event: admin tabs reload, and viewers call `refreshState()` so the change shows up immediately. Rename rewrites `sequences.category` in the same transaction; delete un-categorizes (never deletes) sequences.
- *Admin UI:* the per-row Category `<select>` and the Categories card are built with DOM APIs + `addEventListener`, not inline `onclick` strings — category names can contain quotes (same lesson as the v0.33.163 Languages button bug).

**`window._pendingSyncPointResolver` → map (v0.33.130):** The original single global was fine for one song at a time, but rapid song changes caused the new song's setup to overwrite the previous song's resolver, leaving it permanently unresolved (8s timeout, then no snap). The per-filename map fixes this. Do not collapse back to a single global.

---

## Open items / tech debt

These are known but deferred. Don't fix unprompted unless they're blocking the current task.

- **Cooldown suppression in voting mode** — `cooldown_minutes` currently hides sequences from the jukebox request UI during cooldown, but cooled-down sequences still appear on the voting ballot. The FPP playlist patch (v0.33.152) suppresses them in rotation regardless of mode, but the viewer-side voting UI needs the same treatment. Deferred — needs thought on UX (hide entirely vs show grayed-out with timer).
- **`selectTemplate` draft-state bug** — `selectTemplate` in the admin UI unconditionally sets `hasDraft = false` when loading a template that has an uncommitted `draft_html`. Fix: set `hasDraft = !!tpl.draft_html` on load.
- **Drive-In flex layout regression (v0.32.13)** — the inner wrapper `<div>` added for RFPB compatibility breaks direct-child flex assumptions in built-in canonical templates like Drive-In.
- **Audio cache backup** — not included in backups. Decision: out of scope, audio resync is one click in the FPP plugin.
- **LXC hostname** — still `OpenFalcon`, not renamed.
- **GitHub Actions Node 20 deprecation** — will hit June 2 2026.

---

## Maintainer context

- Non-coder. Runs commands rather than writing code. Provide paste-able scripts.
- Self-hosted synchronized light show (Halloween season).
- Show season: October. Off-season testing with FPP running playlists in test mode.
- Runs several unrelated self-hosted side projects; occasionally referenced for context but not part of this codebase.
- Prefers iterative testing — risky changes on Docker first, then prod.
- Uses ShipPilot for all GitHub releases.

---

## Starting a new conversation

1. Read this primer (it ships with the repo at `PRIMER.md`).
2. Don't assume workspace has latest code. Clone fresh: `git clone https://github.com/ShowPilotFPP/ShowPilot.git /home/claude/showpilot`
3. Check `package.json` version to confirm starting point.
4. For continuity on a specific issue, search conversation history.
5. Don't reinvent documented decisions. If you think one is wrong, raise it explicitly.
