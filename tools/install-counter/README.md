# ShowPilot install counter (+ app show directory)

A small Node app that counts how many ShowPilot and ShowPilot-Lite installs
are running, by product and version, plus an opt-in map of where shows are.
It also hosts the ShowPilot phone app's **nearby-shows directory** (see
below), which is separate and opt-in.
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
| `GET /api/live` | Live updates for the stats page (Server-Sent Events; pushes new numbers whenever an install checks in) |
| `POST /api/shows/checkin` | Listed show's once-a-minute check-in (directory) |
| `POST /api/shows/remove` | Show whose owner turned listing off (directory) |
| `GET /api/shows/nearby?lat=&lng=&radius_mi=` | Phone app: listed shows near a point (directory) |

"Running" means checked in within the last 30 days. Daily totals are saved
for the trend line.

## Map library

`public/jsvectormap.min.*` and `public/world.js` are jsvectormap 1.7.0
(MIT, see `public/LICENSE-jsvectormap`).

## ShowPilot app directory

Only shows whose owner turns on **Settings → Interaction Safeguards → List
my show in the ShowPilot app** check in here (once a minute). Code:
`directory.js`.

**What a listed show sends:** its install ID (we keep a hash), product,
version, name, town, public `viewerUrl` / `apiBaseUrl`, location, listing
radius, `live`, `hasAudio`, `nowPlaying`. The location is rounded to about a
mile **on the show** unless its owner turned rounding off, so the exact spot
never reaches the directory.

**Ownership check:** before listing (and again daily, or when the address
changes) the directory fetches `<apiBaseUrl>/api/public/show-info` and
requires its `listingId` to match the one derived from the install ID. That
stops anyone listing a site that isn't theirs, and proves phones can reach
it. Only public `https://` addresses are fetched (private and local
addresses are refused after DNS lookup).

**`GET /api/shows/nearby`** answers:

```json
{ "shows": [ { "id": "…", "name": "…", "viewerUrl": "https://…/", "apiBaseUrl": "https://…",
  "lat": 36.1, "lng": -94.1, "distanceMi": 0.4, "town": "…",
  "live": true, "hasAudio": true, "nowPlaying": "…" } ] }
```

- `radius_mi` defaults to 25 (1 to 100). A show is returned only when the
  phone is inside both that radius and the show's own listing radius.
- Live shows first, then nearest. At most 50.
- `live` is false once a show hasn't checked in for 2.5 minutes; a show that
  hasn't checked in for a day drops out; after 30 days it is deleted.
- The phone's `lat`/`lng` are used to answer the request and never stored.

**Routing:** the app calls `https://<site domain>/api/shows/nearby` and
shows check in to `https://<site domain>/api/shows/…` (see `DEFAULT_URL` in
`lib/app-listing.js`). In the Cloudflare Tunnel, add a public hostname for
the site domain with path `^/api/shows/` → `http://localhost:3040`, placed
**above** the site's own rule so it wins.

Testing only: `VERIFY_REWRITE_TO=http://127.0.0.1:3100` sends the ownership
check to a local server instead of the show's real address.
