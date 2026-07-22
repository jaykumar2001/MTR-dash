CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  report_cycles INTEGER NOT NULL DEFAULT 10,
  max_stale_hops INTEGER NOT NULL DEFAULT 1,
  address_family TEXT NOT NULL DEFAULT 'auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS hops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  host TEXT NOT NULL,
  loss_pct REAL NOT NULL,
  snt INTEGER NOT NULL,
  last REAL,
  avg REAL,
  best REAL,
  wrst REAL,
  stdev REAL
);

-- Speeds up BridgeInferenceService's "find this target's recent occurrences
-- of a given host" lookup (services/bridgeInference.ts) — otherwise a full
-- table scan on every gap resolution for a long-lived target.
CREATE INDEX IF NOT EXISTS idx_hops_host ON hops(host);

-- Speeds up the per-run "host at this ttl" lookup (hopAtTtlStmt in
-- services/map.ts and services/bridgeInference.ts) and the long-horizon
-- sole-identity scan (services/bridgeInference.ts).
CREATE INDEX IF NOT EXISTS idx_hops_run_ttl ON hops(run_id, ttl);

-- Speeds up per-target scans over runs (map queries, sole-identity lookup).
CREATE INDEX IF NOT EXISTS idx_runs_target_id ON runs(target_id);

CREATE TABLE IF NOT EXISTS path_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  host TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  UNIQUE(target_id, ttl, host)
);

CREATE TABLE IF NOT EXISTS node_positions (
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES path_nodes(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (target_id, node_id)
);

CREATE TABLE IF NOT EXISTS deviations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  old_host TEXT,
  new_host TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

-- Cached whois lookups, keyed by the exact host string (IP or hostname) as it
-- appears in path_nodes/hops. Avoids repeating a slow WHOIS-protocol round
-- trip for every render of a hop that's already been looked up.
CREATE TABLE IF NOT EXISTS whois_cache (
  host TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL,
  netname TEXT,
  country TEXT,
  fetched_at TEXT NOT NULL
);

-- Cached reverse-DNS (PTR) lookups, keyed by IP. mtr runs with -n (see
-- mtr/runner.ts), so every hop's `host` is a raw IP; this cache lets the
-- app resolve a display hostname for it without re-querying DNS on every
-- request. TTL is shorter than whois_cache's since PTR records change more
-- readily than WHOIS ownership data.
CREATE TABLE IF NOT EXISTS dns_cache (
  host TEXT PRIMARY KEY,
  hostname TEXT,
  fetched_at TEXT NOT NULL
);

-- Cached GeoIP (country + city) summaries, keyed by host. A separate data
-- source and cache from whois_cache: GeoIP is IP location, WHOIS is IP
-- ownership — deliberately not merged. 30-day TTL, same reasoning as
-- whois_cache (location/allocation data changes about as rarely as WHOIS
-- registrant data).
CREATE TABLE IF NOT EXISTS geoip_cache (
  host TEXT PRIMARY KEY,
  country TEXT,
  city TEXT,
  source TEXT,
  fetched_at TEXT NOT NULL
);

-- Offline IPv4 CIDR-block-to-country data (baked into the image at build
-- time from ipdeny.com's country zone files; see Dockerfile's geoip-builder
-- stage). start_int/end_int are the block's first/last address as a 32-bit
-- unsigned integer, enabling a `start_int <= ip ORDER BY start_int DESC
-- LIMIT 1` lookup pattern via the index below.
CREATE TABLE IF NOT EXISTS geoip_v4_ranges (
  start_int INTEGER NOT NULL,
  end_int INTEGER NOT NULL,
  country TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geoip_v4_start ON geoip_v4_ranges(start_int);

-- Same as geoip_v4_ranges, for IPv6. Addresses are 128 bits (too wide for
-- SQLite's 64-bit INTEGER), so each bound is stored as a 32-character
-- zero-padded hex string — fixed-width hex strings sort lexicographically
-- in the same order as the numeric value they represent, so the same
-- start/ORDER BY/LIMIT lookup pattern works unchanged.
CREATE TABLE IF NOT EXISTS geoip_v6_ranges (
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  country TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geoip_v6_start ON geoip_v6_ranges(start_hex);
