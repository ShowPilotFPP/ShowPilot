# OpenFalcon

**Self-hosted light show viewer control server.** A drop-in alternative to Remote Falcon for hobbyists who want to run their own infrastructure without relying on a cloud service.

OpenFalcon pairs with a Falcon Player (FPP) plugin to let your visitors:
- 🎵 Vote for sequences (Voting mode) or queue them up (Jukebox mode)
- 📱 Listen to your show audio on their phone via a built-in web player — no app required
- 🎄 See what's playing now and what's coming up next on a customizable viewer page

You get an admin dashboard with stats, queue management, sequence configuration, viewer-page editor, theming, and multi-user authentication.

> **Migrating from Remote Falcon?** OpenFalcon's viewer page renderer is **fully compatible with Remote Falcon templates**. All the standard placeholders (`{PLAYLISTS}`, `{NOW_PLAYING}`, `{JUKEBOX_QUEUE}`, `{NEXT_PLAYLIST}`, `{QUEUE_DEPTH}`, `{LOCATION_CODE}`, etc.) and mode containers (`{playlist-voting-dynamic-container}`, `{jukebox-dynamic-container}`, `{after-hours-message}`, `{location-code-dynamic-container}`) work identically. Paste your existing Remote Falcon viewer HTML into OpenFalcon's editor and it just works — no template rewrite needed.

---

## Features

### Visitor experience

- **Voting & Jukebox modes** — switch between letting viewers vote for the next sequence or queue songs to play in order
- **Listen-on-Phone audio player** — built-in web audio streaming directly from FPP. Visitors hear synchronized show audio on their phones with no native app, no extra service, no Icecast setup. Works on iOS Safari, Android Chrome, and desktop browsers
- **Mobile-first viewer page** — designed for cold winter hands tapping with gloves. Large hit targets, high-contrast cards, marquee-scrolling long titles, optional snow effects, optional themed player decorations (Christmas, Halloween, Easter, St. Patrick's, Independence Day, Valentine's, Hanukkah, Thanksgiving, generic snow)
- **Cover art support** — automatic MusicBrainz/iTunes cover lookup per sequence with admin override, displayed inline on song cards
- **Now Playing + Up Next** — real-time updates pushed via Socket.io, plus polled fallback for slower connections

### Visual page designer

- **Three editing modes** — pick what fits your comfort level:
  - **Settings mode**: form-based editor for show name, colors, fonts, hours, social links, FM frequency. No HTML knowledge required
  - **Blocks mode**: drag-and-drop sections (Hero, Now Playing, Queue, Vote/Jukebox instructions, Song List, Location Code, Social Links, Custom HTML) onto a canvas. Reorder by dragging or with arrow buttons
  - **Code mode**: full Monaco editor for hand-written HTML. Standard Remote Falcon placeholders supported
- **Live preview iframe** — see your changes update next to the editor as you type, before committing
- **Drafts** — edits save as drafts automatically (debounced 500ms). Visitors keep seeing the live page until you click Save Changes
- **Multiple templates** — keep separate templates for Christmas vs Halloween, switch with one click
- **Built-in starter templates** — Christmas/Halloween mobile-first templates included

### Audio & copyright safeguards

- **GPS audio gate (optional)** — restrict audio playback to listeners physically present at your show. Tapping the 🎧 button forces a fresh GPS check (cached location won't bypass it). Re-verifies every 15 minutes during playback to catch listeners who walked away
- **Refresh-to-recover latch** — once the gate trips, audio stays blocked until the page is refreshed. Prevents auto-resume when admin toggles control modes
- **External audio access** — set your public domain so listeners on cellular can stream the audio without VPN. Local listeners still use the direct path for best performance
- **Watermarking ready** — direct stream URL exposed for use with external watermarking tools if your jurisdiction requires it

### Location tools

- **Address-to-coordinates lookup** — type any address ("1234 Main St, Branson MO"), click Find Coordinates, lat/lng auto-fill. Powered by OpenStreetMap Nominatim
- **Detect-my-location button** — uses browser GPS to set show coordinates if you're at the venue
- **Visual map preview** — embedded OpenStreetMap shows exactly where your coordinates point, scales to your radius. Verify your config without leaving admin

### FPP integration

- **Plugin auto-discovery** — install the OpenFalcon plugin from the FPP plugin manager. Plugin handshakes with the server, syncs sequences, reports playing status
- **Sequence playlist sync** — playlists pulled from FPP, displayed and reorderable in admin
- **Sequence control** — start/stop/skip from admin. Test triggers. Stats per sequence
- **Mid-track resume** — when a viewer-requested song interrupts the original, resuming the original picks up at the correct elapsed position (not the start)
- **PSA injection** — auto-inject PSAs (sponsor messages, holiday greetings) every N interactions

### Admin & operations

- **Multi-user authentication** — username + password, bcrypt hashed, JWT session cookies. Per-user "remember me" (30-day cookie or session-only). Force-password-change flag for new accounts
- **User management** — add/edit/disable/delete users. Self-protection: can't disable yourself, can't delete the last user
- **Themes** — Stage·Dark, Stage·Light, plus seasonal themes (Easter, St. Patrick's, Independence Day, Valentine's, Hanukkah, Thanksgiving) for the admin UI
- **Sequence snapshots** — save your current playlist configuration (display names, artists, sort order, visibility) as a named snapshot. Restore later when switching seasons. Non-destructive: preserves play history, vote stats, queue state
- **Live stats dashboard** — votes per round, jukebox queue depth, plays per sequence, last-played times, viewer count
- **IP blocking** — block individual IPs or CIDR ranges. Useful when one user gets too enthusiastic with the request button
- **Per-sequence visibility/votability/jukeboxability** — fine-grained control over what shows up where
- **Auto-fill song info** — looks up sequence titles online to populate display name + artist automatically (no more "JinglePopXmas2019_v3.fseq" shown to viewers)
- **GPS proximity check** — separate from the audio gate; restricts who can vote/queue based on their physical location
- **PSA frequency control** — drop in promotional or sponsor announcements every N interactions
- **Configurable request limits** — per-viewer cap on jukebox requests per session (1-20)
- **Real-time plugin status** — admin header shows whether FPP plugin is connected and last sync time

### Self-hosted, owned, free

- **No cloud dependency** — runs on a Pi, a NAS, a VM, anywhere with Node.js
- **SQLite database** — single file, easy backup, no separate database server
- **Open source** — MIT-licensed, hackable, no vendor lock-in
- **No telemetry** — your data stays on your hardware

---

## ⚠️ Important: HTTPS is required for geolocation features

The viewer page uses browser geolocation APIs for the **GPS audio gate** and **GPS proximity check**. **Browsers refuse to expose location data on insecure (`http://`) origins** — this is a hardcoded security restriction, not something OpenFalcon controls.

If you plan to use any location-based feature, you **must** serve OpenFalcon over HTTPS. Options:

- **Nginx Proxy Manager** (easiest) with a Let's Encrypt cert — point it at OpenFalcon on port 3100
- **Caddy** with automatic HTTPS — single-line reverse proxy config
- **Cloudflare Tunnel** — free TLS without opening ports
- **Standalone reverse proxy** (Nginx/Apache) with your own cert

Localhost (`http://localhost:3100` or `http://127.0.0.1:3100`) is also exempt from this restriction, so local development works without HTTPS. But anything visitors hit needs a cert.

If you don't use any location features, plain HTTP is fine.

---

## Quick links

- [Features](#features)
- [Requirements](#requirements)
- [Install on Linux (Debian/Ubuntu/Raspberry Pi OS)](#install--linux-debian--ubuntu--raspberry-pi-os)
- [Install on Linux (RHEL/Fedora/Rocky/Alma)](#install--linux-rhel--fedora--rocky--alma)
- [Install on macOS](#install--macos)
- [Install on Windows](#install--windows)
- [First-run setup](#first-run-setup)
- [Install the FPP plugin](#install-the-fpp-plugin)
- [Configuration reference](#configuration-reference)
- [Running as a service](#running-as-a-service)
- [Updating](#updating)
- [Backups](#backups)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Node.js   | 18.x    | 20.x or 22.x LTS |
| RAM       | 256 MB  | 512 MB+ |
| Disk      | 100 MB for app + your data | 1 GB+ if storing many cover art images |
| OS        | any modern Linux, macOS 11+, Windows 10+ | Linux for production |
| FPP       | 7.0+ on a separate device (Pi, BeagleBone, etc.) | latest stable |

**Network:** OpenFalcon listens on TCP port 3100 by default. The FPP plugin needs to reach this port. Visitors hit the same port (or whatever you front it with).

---

## Install — Linux (Debian / Ubuntu / Raspberry Pi OS)

These instructions cover Debian 11+, Ubuntu 22.04+, Raspberry Pi OS Bookworm+. The exact same commands work on a Raspberry Pi 4/5 if you want to colocate OpenFalcon with FPP on a single Pi (4GB+ RAM recommended).

### 1. Install Node.js 20 LTS

The Node.js version in your distro repos is usually too old. Use the official NodeSource installer:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
```

Verify:

```bash
node --version    # should print v20.x.x or higher
npm --version
```

### 2. Install OpenFalcon

```bash
# Pick a location. /opt is conventional for self-hosted apps.
sudo mkdir -p /opt/openfalcon
sudo chown $USER:$USER /opt/openfalcon
cd /opt/openfalcon

# Download the latest release tarball
wget https://github.com/OFPlugin/openfalcon/releases/latest/download/openfalcon.tar.gz
tar -xzf openfalcon.tar.gz --strip-components=1
rm openfalcon.tar.gz

# Or clone via git if you prefer:
# git clone https://github.com/OFPlugin/openfalcon.git .

# Install Node dependencies
npm install --omit=dev
```

### 3. Create your config

```bash
cp config.example.js config.js
nano config.js
```

At minimum, change these two values:

```js
jwtSecret: 'PUT_A_LONG_RANDOM_STRING_HERE',
showToken: 'PUT_ANOTHER_RANDOM_STRING_HERE',
```

Generate random strings with:

```bash
openssl rand -hex 32
```

### 4. Start it up

```bash
npm start
```

You should see `OpenFalcon listening on http://0.0.0.0:3100`. Open `http://<your-server-ip>:3100/admin` in a browser.

Default login: **`admin` / `admin`** — you'll be forced to change the password on first login.

For production, see [Running as a service](#running-as-a-service) below to keep OpenFalcon running on boot.

---

## Install — Linux (RHEL / Fedora / Rocky / Alma)

### 1. Install Node.js 20 LTS

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs gcc-c++ make
```

Verify:

```bash
node --version
npm --version
```

### 2. Install OpenFalcon

```bash
sudo mkdir -p /opt/openfalcon
sudo chown $USER:$USER /opt/openfalcon
cd /opt/openfalcon

curl -L https://github.com/OFPlugin/openfalcon/releases/latest/download/openfalcon.tar.gz \
     -o openfalcon.tar.gz
tar -xzf openfalcon.tar.gz --strip-components=1
rm openfalcon.tar.gz

npm install --omit=dev
```

### 3. Configure & run

Same as Debian/Ubuntu (sections 3 and 4 above).

If firewalld is enabled, you'll need to open port 3100:

```bash
sudo firewall-cmd --permanent --add-port=3100/tcp
sudo firewall-cmd --reload
```

---

## Install — macOS

Useful for development and testing on a Mac mini or laptop. Production typically runs on a Pi or VPS, but macOS works fine.

### 1. Install Node.js

The easiest path is [Homebrew](https://brew.sh):

```bash
brew install node@20
```

Or download the official installer from [nodejs.org](https://nodejs.org/en/download).

### 2. Install OpenFalcon

```bash
mkdir -p ~/openfalcon
cd ~/openfalcon

curl -L https://github.com/OFPlugin/openfalcon/releases/latest/download/openfalcon.tar.gz \
     -o openfalcon.tar.gz
tar -xzf openfalcon.tar.gz --strip-components=1
rm openfalcon.tar.gz

npm install --omit=dev
```

### 3. Configure & run

```bash
cp config.example.js config.js
# Edit config.js and set jwtSecret + showToken (use `openssl rand -hex 32` for random values)
npm start
```

Open `http://localhost:3100/admin`. Default login `admin` / `admin`.

To run as a background service, use `launchd` — see [Running as a service](#running-as-a-service) below.

---

## Install — Windows

Tested on Windows 10 and 11.

### 1. Install Node.js

Download the **LTS** installer from [nodejs.org](https://nodejs.org/en/download) and run it. Accept defaults — make sure "Automatically install the necessary tools" is checked (it installs build tools needed by `better-sqlite3`).

Open PowerShell and verify:

```powershell
node --version
npm --version
```

### 2. Install OpenFalcon

Pick a folder (e.g. `C:\OpenFalcon`):

```powershell
New-Item -ItemType Directory -Force -Path C:\OpenFalcon
Set-Location C:\OpenFalcon

# Download the latest release
Invoke-WebRequest -Uri https://github.com/OFPlugin/openfalcon/releases/latest/download/openfalcon.tar.gz -OutFile openfalcon.tar.gz

# Extract (Windows 10 1803+ has tar built in)
tar -xzf openfalcon.tar.gz --strip-components=1
Remove-Item openfalcon.tar.gz

npm install --omit=dev
```

### 3. Configure

```powershell
Copy-Item config.example.js config.js
notepad config.js
```

Set `jwtSecret` and `showToken` to random strings. Generate them in PowerShell with:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

### 4. Start

```powershell
npm start
```

Open `http://localhost:3100/admin`. Default login `admin` / `admin`.

If Windows Firewall prompts you, allow the Node.js process to communicate. To run as a Windows service, use [NSSM](https://nssm.cc/) — see [Running as a service](#running-as-a-service).

---

## First-run setup

1. Open `http://<your-server-ip>:3100/admin`
2. Log in with `admin` / `admin`
3. **Change the default password** (you'll be prompted)
4. Go to **Plugin** tab → copy the **Show Token** (you'll paste this into FPP)
5. Optionally go to **Users** tab and add accounts for anyone else who needs admin access
6. Go to **Settings** tab → review jukebox/voting safeguards and configure **External Audio Access** if you want listeners outside your network to be able to hear the show
7. Configure your viewer page on the **Viewer Page** tab (use the default OpenFalcon template or import the example template provided)

---

## Install the FPP plugin

The FPP plugin is what reports playback to OpenFalcon, hands off requested sequences, and serves audio to viewers.

1. SSH into your FPP device (or open the FPP web UI's shell)
2. In FPP web UI, go to **Content Setup → Plugin Manager**
3. Click **Manual Install** (or follow the github URL flow)
4. Use the OpenFalcon plugin URL: `https://github.com/OFPlugin/openfalcon-plugin`
5. After install, click **Configure** on the plugin in the plugin list
6. Fill in:
   - **OpenFalcon URL**: `http://<your-openfalcon-server-ip>:3100`
   - **Show token**: paste the token you copied from OpenFalcon's Plugin tab
   - **Remote playlist**: the FPP playlist that contains your show sequences
   - **Interrupt schedule**: enable if you want viewer requests to interrupt the schedule
7. Click **Save**, then **Restart Listener**
8. Back in OpenFalcon → **Plugin** tab, you should see the plugin go online (green dot in header) within ~30 seconds

If it doesn't connect, check the plugin log via FPP UI → Status → Logs → `openfalcon_listener`.

---

## Configuration reference

`config.js` (created from `config.example.js`):

| Key | Default | Notes |
|-----|---------|-------|
| `port` | `3100` | TCP port to listen on |
| `host` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost only |
| `dbPath` | `./data/openfalcon.db` | SQLite DB path. Created automatically. |
| `jwtSecret` | _CHANGE_ME_ | Used to sign session cookies. **Must be set to a random value.** |
| `sessionCookieName` | `openfalcon_session` | Browser cookie name |
| `sessionDurationHours` | `720` (30 days) | Default session length when "remember me" is off; remember-me always extends to 30d |
| `showToken` | _CHANGE_ME_ | Shared secret between OpenFalcon and FPP plugin |
| `viewer.activeWindowSeconds` | `30` | How recently a viewer must have heartbeat'd to count as "active" |
| `viewer.pollIntervalMs` | `5000` | Viewer page state poll fallback (when socket disconnects) |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

Most operational settings (jukebox depth, vote rules, viewer-page HTML, theme, snow effect, etc.) live in the **admin panel UI**, not in `config.js`.

---

## Running as a service

### Linux — systemd (recommended)

Create `/etc/systemd/system/openfalcon.service`:

```ini
[Unit]
Description=OpenFalcon
After=network.target

[Service]
Type=simple
User=openfalcon
WorkingDirectory=/opt/openfalcon
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:

```bash
# Create the service user
sudo useradd -r -s /bin/false -d /opt/openfalcon openfalcon
sudo chown -R openfalcon:openfalcon /opt/openfalcon

sudo systemctl daemon-reload
sudo systemctl enable --now openfalcon
sudo systemctl status openfalcon

# View logs
sudo journalctl -u openfalcon -f
```

### Linux — pm2 (alternative)

```bash
sudo npm install -g pm2
cd /opt/openfalcon
pm2 start server.js --name openfalcon
pm2 startup    # follow the printed instructions
pm2 save
```

### macOS — launchd

Create `~/Library/LaunchAgents/com.openfalcon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openfalcon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOURNAME/openfalcon/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOURNAME/openfalcon</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOURNAME/openfalcon/openfalcon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOURNAME/openfalcon/openfalcon.log</string>
</dict>
</plist>
```

Replace `YOURNAME` and the `node` path (find with `which node`). Then:

```bash
launchctl load ~/Library/LaunchAgents/com.openfalcon.plist
```

### Windows — NSSM

[NSSM](https://nssm.cc/download) wraps any program as a Windows service.

```powershell
# Download and extract NSSM, then:
.\nssm.exe install OpenFalcon
```

In the GUI that opens:
- **Path:** `C:\Program Files\nodejs\node.exe`
- **Startup directory:** `C:\OpenFalcon`
- **Arguments:** `server.js`

Click **Install service**, then start it:

```powershell
nssm start OpenFalcon
# Or in services.msc, find "OpenFalcon" and start it
```

---

## Updating

### From a release tarball

```bash
cd /opt/openfalcon
sudo systemctl stop openfalcon    # or pm2 stop openfalcon

# Backup first
cp -r data data.backup-$(date +%F)

# Get the new version
wget -O openfalcon.tar.gz https://github.com/OFPlugin/openfalcon/releases/latest/download/openfalcon.tar.gz
tar -xzf openfalcon.tar.gz --strip-components=1
rm openfalcon.tar.gz
npm install --omit=dev

sudo systemctl start openfalcon
```

Database migrations run automatically on startup. Your config and data are preserved.

### From git

```bash
cd /opt/openfalcon
git pull
npm install --omit=dev
sudo systemctl restart openfalcon
```

---

## Backups

The whole application state lives in two places:
- `config.js` — your secrets and bind config
- `data/` directory — SQLite database, cover art images, viewer page templates

Back both up:

```bash
# Full backup
tar -czf openfalcon-backup-$(date +%F).tar.gz config.js data/
```

Restore is just extracting the backup back into the install directory.

To dump just the SQLite DB for inspection or migration:

```bash
sqlite3 data/openfalcon.db .dump > openfalcon.sql
```

---

## Troubleshooting

### "Cannot connect to FPP plugin" / plugin shows offline

- Verify the `showToken` in `config.js` exactly matches what you entered in the FPP plugin config
- Check FPP can reach OpenFalcon: `curl http://<openfalcon-ip>:3100/api/plugin/state -H "remotetoken: YOUR_TOKEN"`
- Check the plugin log on FPP: web UI → **Status → Logs → openfalcon_listener**
- Restart the plugin listener via the FPP web UI

### "Audio doesn't play for cellular listeners"

OpenFalcon needs to be reachable from the public internet for off-network audio. Either:
- Set up a reverse proxy with a public domain, then enter that domain in **Settings → External Audio Access**
- Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for a domain without exposing your home IP

### "I forgot my admin password"

Reset directly in the database:

```bash
cd /opt/openfalcon
sqlite3 data/openfalcon.db "DELETE FROM users WHERE username='admin';"
# Then restart OpenFalcon — it'll re-seed the default admin/admin user.
```

If you have a working admin account, just use the **Users** tab → **Reset PW** for any other user.

### "Port 3100 already in use"

Edit `config.js`, change `port` to something free (e.g. `3101`), restart.

### "permission denied" on `/opt/openfalcon`

The service user (`openfalcon` if following systemd setup) needs write access to `data/` for SQLite:

```bash
sudo chown -R openfalcon:openfalcon /opt/openfalcon/data
```

### "Cover art doesn't show" / "wrong covers"

In admin → **Sequences**, click **Fetch Covers** to re-pull all sequence covers from iTunes. If a specific cover is wrong, click on it directly to upload or replace.

### Logs

```bash
# systemd
sudo journalctl -u openfalcon -f --since "10 minutes ago"

# pm2
pm2 logs openfalcon
```

---

## Project structure (for the curious)

```
openfalcon/
├── server.js                # Express app + Socket.io server
├── config.js                # Your config (gitignored)
├── config.example.js        # Template config
├── package.json
├── lib/
│   ├── db.js                # SQLite schema, migrations, helpers
│   ├── viewer-renderer.js   # Server-side template rendering for the viewer page
│   ├── cover-art.js         # iTunes cover lookup, cache-busting
│   └── ...
├── routes/
│   ├── admin.js             # /api/admin/* endpoints
│   ├── viewer.js            # /api/viewer/* + audio streaming
│   └── plugin.js            # /api/plugin/* (FPP plugin talks here)
├── public/
│   ├── admin/               # Admin SPA
│   ├── viewer.html          # Default viewer page template
│   └── rf-compat.js         # Viewer-side audio player + visual effects
└── data/                    # SQLite + cover art (gitignored)
```

---

## License

MIT. Use it however you like — just don't blame me if your show breaks on Halloween night.

## Contributing

Issues and PRs welcome at https://github.com/OFPlugin/openfalcon

If you have ideas, find bugs, or want to share what your show looks like running on OpenFalcon — please post in the xLights forum or open a GitHub issue.

---

**Have fun, and Merry Christmas / Happy Halloween / etc!** 🎄🎃🎆
