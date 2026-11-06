# ShowPilot install counter

A small Node app that counts how many ShowPilot and ShowPilot-Lite installs
are running, by product and version, plus an opt-in map of where shows are.
It is **not** part of the ShowPilot app; installs only send a once-a-day
check-in to it. It's meant to run on any small Linux box behind a
Cloudflare Tunnel.

## What an install sends

```json
{ "id": "random-uuid", "product": "showpilot", "version": "0.33.266", "location": "off" }
```

- `id` is random and made on the install the first time; it identifies nothing.
- `location` is the owner's choice in **Settings → General → Install count**:
  `off` (default), `country`, `region` (state/province) or `city` (town).
- The install never sends a location. When the owner opted in, the counter
  reads Cloudflare's visitor-location headers and keeps only the level they
  picked. Town positions are rounded to about 10 km.
- The counter stores a SHA-256 hash of the ID, never the IP address, and
  replies with an empty `204`. Nothing is sent back to the install.
- Installs that stop checking in are deleted after about 13 months.

## Setup

```bash
git clone --depth 1 https://github.com/ShowPilotFPP/ShowPilot.git /opt/showpilot-src
cp -r /opt/showpilot-src/tools/install-counter /opt/showpilot-install-counter
cd /opt/showpilot-install-counter
npm install --omit=dev
pm2 start server.js --name showpilot-install-counter
pm2 save
```

It listens on `127.0.0.1:3040` (change with `PORT` / `HOST`). Data lives in
`./data/installs.db` (change with `DATA_DIR`).

Then in Cloudflare:

1. **Tunnel:** add a public hostname for the domain the app points at (see
   `DEFAULT_URL` in `lib/install-count.js`) → `http://localhost:3040`.
2. **Town and state for the map:** on that domain's zone, turn on
   **Rules → Settings → Managed Transforms → Add visitor location headers**.
   Without it only countries show on the map.

Optional: make the stats page private by starting it with `STATS_KEY=yourkey`
and opening `/?key=yourkey`.

## Endpoints

| Path | What |
|---|---|
| `POST /ping` | Check-in from an install (204, no body) |
| `GET /` | Stats page: totals, ShowPilot vs Lite, versions, map, countries, states, towns, trend |
| `GET /api/stats` | The same numbers as JSON |

"Running" means checked in within the last 30 days. Daily totals are saved
for the trend line.

## Map library

`public/jsvectormap.min.*` and `public/world.js` are jsvectormap 1.7.0
(MIT, see `public/LICENSE-jsvectormap`).
