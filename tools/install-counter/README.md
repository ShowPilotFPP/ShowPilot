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

Directory admin page (`/admin`): add a user on the server, in this folder:
`node admin-user.js add <username>` (asks for a password, at least 10
characters). `node admin-user.js list` and `node admin-user.js remove <name>`
manage users. The page and its API stay off (404) until a user exists.

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
| `GET /api/shows/directory?lat=&lng=&radius_mi=` | Phone app: Directory of Shows map (directory) |
| `GET /admin` | Directory admin page (sign in with a user from `admin-user.js`) |
| `POST /api/admin/login` `logout` `password`, `GET /api/admin/me` | Admin sign-in |
| `GET /api/admin/directory` | Admin: every show, refused check-ins, blocked shows |
| `POST /api/admin/directory/check` `remove` `block` `unblock` `dismiss` | Admin actions, body `{ "idHash": "…" }` (`block` also takes `reason`) |

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
version, name, town, public `viewerUrl` / `apiBaseUrl`, location, whether
it's rounded (`fuzzed`), `live`, `hasAudio`, `nowPlaying`. (Older installs
also send a `radiusMi`; it's ignored.) The location is rounded to about a
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

- **Listing distance is fixed, the same for every show** (not a setting):
  a phone sees a show within 1 mile of it (`LISTING_RADIUS_MI`). For a
  rounded location the directory adds 0.75 mile (`FUZZ_SLACK_MI`, the
  farthest the rounded point can be from the real spot), so a phone at the
  show always sees it. `radius_mi` from the app can only narrow that.
- Live shows first, then nearest. At most 50.
- `live` is false once a show hasn't checked in for 2.5 minutes; a show that
  hasn't checked in for a day drops out; after 30 days it is deleted.
- The phone's `lat`/`lng` are used to answer the request and never stored.

`GET /api/shows/directory?lat=&lng=&radius_mi=` — the app's **Directory of
Shows** (map + list). Every listed show within the distance the user picked:
1–100 miles, default 25 (the app converts km). Nearest first, at most 200.
Each show adds `address` (owner-entered, may be empty) and `fuzzed` (true =
the pin is rounded to about a mile because there's no address). The app shows
a Navigate button only when `address` is set. `/nearby` results carry
`address` and `fuzzed` too.

Check-ins: the 20-second rate limit only applies to the unchanged heartbeat;
a check-in that changes a listed detail (name, town, address, location,
address of the show, phone audio) goes through at once, so an owner's edit
shows up straight away.

**Routing:** nothing extra. The directory is served on the counter's own
public hostname (the one in `DEFAULT_URL` of `lib/install-count.js`), so the
app calls `https://<counter host>/api/shows/nearby` and listed shows check in
to `https://<counter host>/api/shows/…` (`DEFAULT_URL` in
`lib/app-listing.js`; override with `appDirectoryUrl` in config.js or
`SHOWPILOT_APP_DIRECTORY_URL`).

Testing only: `VERIFY_REWRITE_TO=http://127.0.0.1:3100` sends the ownership
check to a local server instead of the show's real address.

## Directory admin

`/admin`, signed in with a username and password (`admin-user.js`). The
session is an HttpOnly cookie for 14 days; 5 wrong passwords for a username
in 15 minutes lock that username for a while.

- **Shows:** every show on record with its state — *Live*, *Online* (checking
  in, not playing), *Not checking in* (quiet 2.5 min – 1 day: still in the
  app, shown as not live), *Dropped* (quiet over a day: out of the app,
  deleted after 30 days) — plus version, pin, listing ID and a flag when the
  daily ownership check is failing but the 2-day grace keeps it listed.
- **Check:** runs live against the show: its `show-info` and listing ID, the
  viewer page, and `/api/now-playing-audio` at its pin. Passing re-verifies the
  listing.
- **Remove:** takes it out now. If the owner still has listing on, it comes
  back on its next check-in (about a minute).
- **Block:** hides it from the app. Its check-ins get `403` and the owner's
  ShowPilot shows "Not listed: this show was removed from the ShowPilot app
  directory…". **Unblock** puts it straight back.
- **Refused check-ins:** the latest refusal per install and why (bad web
  address, ownership mismatch, show-info unreachable…), so "my show isn't in
  the app" can be answered. Cleared when that install's check-in works.
- **What a phone sees here:** runs `/nearby` and `/directory` for any point
  (or a show's own pin with *Test here*).
