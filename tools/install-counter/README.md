# ShowPilot install counter

A tiny Cloudflare Worker that counts how many ShowPilot and ShowPilot-Lite
installs are running, by product and version, plus an opt-in map of where
shows are. It is **not** part of the ShowPilot app; installs only send a
once-a-day check-in to it.

## What an install sends

```json
{ "id": "random-uuid", "product": "showpilot", "version": "0.33.266", "location": "off" }
```

- `id` is random and made on the install the first time; it identifies nothing.
- `location` is the owner's choice in **Settings → General → Install count**:
  `off` (default), `country`, `region` (state/province) or `city` (town).
- The install never sends a location. When the owner opted in, the Worker
  reads Cloudflare's own approximate lookup of the connection and keeps only
  the level they picked. Town positions are rounded to about 10 km.
- The Worker stores a SHA-256 hash of the ID, never the IP address, and
  replies with an empty `204`. Nothing is sent back to the install.
- Installs that stop checking in are deleted after about 13 months.

## Setup (once)

```bash
cd tools/install-counter
npx wrangler login
npx wrangler d1 create showpilot-installs      # copy the database_id into wrangler.toml
npx wrangler d1 execute showpilot-installs --remote --file=schema.sql
npx wrangler deploy
```

Then in the Cloudflare dashboard, open the Worker → **Settings → Domains & Routes**
and add the custom domain the app points at (see `DEFAULT_URL` in
`lib/install-count.js`). The stats page is the root of that domain.

Optional: make the stats page private with `npx wrangler secret put STATS_KEY`
and open it as `/?key=YOUR_KEY`.

## Endpoints

| Path | What |
|---|---|
| `POST /ping` | Check-in from an install (204, no body) |
| `GET /` | Stats page: totals, ShowPilot vs Lite, versions, map, countries, states, towns, trend |
| `GET /api/stats` | The same numbers as JSON |

"Running" means checked in within the last 30 days. A daily cron saves the
totals for the trend line.

## Updating the map library

`src/vendor/*.txt` are jsvectormap 1.7.0 (MIT, see `LICENSE-jsvectormap`),
kept as `.txt` so Wrangler bundles them as text and the Worker serves them
itself.
