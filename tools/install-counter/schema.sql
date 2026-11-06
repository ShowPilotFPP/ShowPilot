-- One row per install. The install ID is stored only as a SHA-256 hash.
-- No IP address, show name, URL or anything else is ever stored.
-- Location columns are filled ONLY when the owner opted in, and only to
-- the level they chose (country / state / town). Cloudflare works out
-- the location; the install never sends it.
CREATE TABLE IF NOT EXISTS installs (
  id_hash    TEXT PRIMARY KEY,
  product    TEXT NOT NULL,          -- 'showpilot' | 'showpilot-lite'
  version    TEXT,                   -- e.g. '0.33.266'
  country    TEXT,                   -- 2-letter code  (level: country, region, city)
  region     TEXT,                   -- state/province (level: region, city)
  city       TEXT,                   -- town           (level: city)
  lat        REAL,                   -- town position, rounded to ~10 km (level: city)
  lon        REAL,
  first_seen INTEGER NOT NULL,       -- unix seconds
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs(last_seen);

-- Daily totals for the trend chart (filled by the cron job).
CREATE TABLE IF NOT EXISTS daily (
  day     TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  product TEXT NOT NULL,
  active  INTEGER NOT NULL,          -- installs seen in the 30 days up to that day
  PRIMARY KEY (day, product)
);
