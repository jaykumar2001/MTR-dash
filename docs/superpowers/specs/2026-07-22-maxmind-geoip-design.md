# MaxMind GeoLite2 city/country lookup, ipdeny fallback — design

Date: 2026-07-22
Status: approved

## Problem

The only IP-location data today is `geoip/lookupCountry.ts`: an offline CIDR-range lookup
built from ipdeny.com's country zone files at Docker build time. It gives a country code
only, no city, and can only ever be as fresh as the image it was baked into.

MaxMind account credentials exist locally (`.GeoIP.conf`, the config format for MaxMind's
official `geoipupdate` tool, `EditionIDs GeoLite2-ASN GeoLite2-City GeoLite2-Country`) but
the file has never been wired to anything, is untracked by git, and must stay that way.

Separately, country data is currently sourced through `WhoisService` (`whois.ts` calls
`lookupCountry` and stores the result in `whois_cache`), conflating an IP-ownership data
source (WHOIS) with an IP-location one (geoip). These are different concerns and should
not share a cache or a code path.

## Decision

1. Add a MaxMind GeoLite2-City lookup as the primary location source, with the existing
   ipdeny CIDR-range lookup kept as a fallback (country only — ipdeny has no city data).
2. Pull city/country location entirely out of `WhoisService` into its own `GeoipService`,
   mirroring the existing `WhoisService`/`DnsService` structural pattern (own cache table,
   own TTL, own bulk route).
3. `geoipupdate` is invoked by the backend itself at runtime (not at Docker build time),
   gated by an age check: skip the network call entirely if `GeoLite2-City.mmdb` already
   exists and is under 24h old. The feature is fully opt-in — if `GEOIP_CONF_PATH` isn't
   set or the file isn't found, MaxMind is skipped and behavior is identical to today
   (ipdeny country-only).
4. `.GeoIP.conf` is added to `.gitignore` (it is currently untracked, so this requires no
   history scrub).

Rejected alternatives: baking MaxMind data at Docker build time like ipdeny (rejected —
would require the credentialed `.GeoIP.conf` to enter the build context/image layers,
which conflicts with keeping it out of git and out of anything distributable); a
continuous background refresh interval unconditionally re-running `geoipupdate` (rejected
per explicit instruction — only pull when missing or stale, checked at startup and on a
24h interval, not a distribution mechanism running on its own clock regardless of file
age).

## Changes by layer

### GeoIP resolution (new + changed backend/src/geoip/)

- `geoip/maxmind.ts` (new): opens `GeoLite2-City.mmdb` via the `maxmind` npm package
  (new dependency) as a lazy singleton reader, reopened if the file's mtime advances since
  last load. Exposes `lookupCity(ip): { country: string | null; city: string | null } |
  null` (null = file absent/unopenable — caller falls back).
- `geoip/ensureMaxmindData.ts` (new): given `confPath` and `dbDir`, checks
  `GeoLite2-City.mmdb`'s mtime; if missing or ≥24h old, shells out to `geoipupdate -f
  <confPath> -d <dbDir>` (`node:child_process` `execFile`, mirroring how `mtr/runner.ts`
  already shells out to a binary). Catches and logs all failures (missing conf file,
  missing `geoipupdate` binary, network failure, bad credentials) — never throws, so a
  broken or absent MaxMind setup never breaks app startup.
- `geoip/resolveGeo.ts` (new): `resolveGeo(db, ip)` — tries `lookupCity` first; if it
  returns null, falls back to the existing `lookupCountry(db, ip)` (ipdeny) for country,
  with `city` staying `null` in that path. This is the single fallback chain both the
  new service and (indirectly, via that service) the frontend rely on.
- `geoip/lookupCountry.ts` / `geoip/loader.ts`: unchanged — remain the fallback layer
  exactly as they are today.

### Backend service layer

- `services/geoip.ts` (new) — `GeoipService`, structural mirror of `WhoisService`/
  `DnsService`:
  - New `geoip_cache` table: `host TEXT PRIMARY KEY, country TEXT, city TEXT, fetched_at
    TEXT NOT NULL` (added to `schema.sql`, `CREATE TABLE IF NOT EXISTS`, additive per
    existing convention).
  - 30-day TTL (matches `whois_cache`'s reasoning: IP-to-location ownership/allocation
    changes about as rarely as WHOIS registrant data does).
  - `getSummary(host): Promise<{ country: string | null; city: string | null }>` —
    cache-first, resolves `host` to an IP the same way `WhoisService` does today, then
    calls `resolveGeo`, then writes through.
- `net/resolveHost.ts` (new, extracted) — the hostname→IP resolution helper currently
  private to `whois.ts` (`defaultResolveHost`) moves here so both `WhoisService` and
  `GeoipService` share one implementation instead of duplicating it.
- `services/whois.ts` — `WhoisSummary` shrinks to `{ netname: string | null }`. Stops
  importing/calling `lookupCountry` entirely. `whois_cache.country` column stays in the
  schema (no destructive migration, per this codebase's additive-only convention) but is
  no longer written or read by application code.
- `routes/geoip.ts` (new) — `POST /api/geoip/bulk`, line-for-line mirror of
  `routes/whois.ts`'s bulk endpoint (same host validation regex, same 200-host cap, same
  per-host-failure-yields-null-not-batch-failure behavior), backed by `GeoipService`.
- `routes/whois.ts` — bulk response shrinks to `{ netname }` per host.
- `app.ts` — wires `GeoipService` + `registerGeoipRoutes`. Calls
  `ensureMaxmindData(process.env.GEOIP_CONF_PATH, process.env.MAXMIND_DB_DIR ??
  <dir of DB_PATH>/maxmind)` fire-and-forget (not awaited — must never block or fail
  `createApp()`) once at startup, then on a 24h `setInterval` gated by
  `options.startMaxmindRefresh !== false` (mirrors `options.startScheduler`, defaults on,
  disabled in tests).

### Docker / compose

- `Dockerfile`, runtime stage: add `geoipupdate` to the `apt-get install` list (available
  in Debian bookworm). No new build stage — the tool runs at container runtime, not build
  time.
- `docker-compose.yml`: add `./.GeoIP.conf:/app/GeoIP.conf:ro` bind mount and
  `GEOIP_CONF_PATH=/app/GeoIP.conf` env var. `MAXMIND_DB_DIR` left unset (defaults to
  `/data/maxmind`, already on the existing persisted `mtr-data` volume).

### Frontend

- `lib/api.ts` (or wherever `WhoisSummary`/bulk-call types live): `WhoisSummary` shrinks
  to `{ netname }`; new `GeoipSummary = { country: string | null; city: string | null }`
  type and `getGeoipBulk(hosts)` call against `/api/geoip/bulk`.
- `components/NetworkMap.tsx`: third parallel lazy-load effect (`geoipSummaries` state +
  its own `requestedHostsRef`), same fetch-once-per-host pattern as the existing
  `whoisSummaries`/`dnsHostnames` effects. `displayNodes` pulls `netname` from
  `whoisSummaries` and `country`/`city` from `geoipSummaries` independently — no data
  crosses between the two.
- `components/HopNode.tsx`: `HopNodeData` gains `city?: string | null`. New line rendered
  under the existing ttl/flag row and above `netname`, e.g. `Frankfurt, DE` (skipped
  entirely when `city` is null, same conditional-render pattern as `netname`/
  `resolvedHost`).
- `styles.css`: new `.hop-node-geo` rule, same treatment as the existing
  `.hop-node-netname` block (small muted text, ellipsis overflow).

### `.gitignore`

- Add `.GeoIP.conf`.

## Testing

Vitest, colocated per repo convention:

- `geoip/maxmind.test.ts`: opens a fixture `.mmdb`, returns country+city for a known IP,
  null for an unresolvable one, null (not throw) when the file doesn't exist.
- `geoip/ensureMaxmindData.test.ts`: skips `geoipupdate` when the file is fresh (<24h),
  runs it when missing/stale, swallows a failing `geoipupdate` invocation without
  throwing.
- `geoip/resolveGeo.test.ts`: MaxMind hit short-circuits ipdeny; MaxMind miss falls back
  to ipdeny country with null city; both misses → all null.
- `services/geoip.test.ts`: cache-first behavior, TTL expiry, write-through — same shape
  as existing `whois.test.ts`.
- `services/whois.test.ts`: updated — no more `country` field, no more `lookupCountry`
  dependency.
- `routes/geoip.test.ts` (new) / `routes/whois.test.ts` (updated): bulk endpoint
  contracts.
- `HopNode.test.tsx`: renders the city line when present, omits it when null.
- `NetworkMap.test.tsx`: geoip bulk fetch wired independently of whois fetch.

## Out of scope

- GeoLite2-ASN (also listed in `.GeoIP.conf`'s `EditionIDs`) — not used; WHOIS remains the
  sole netname/ownership source. Available for a future feature if wanted.
- Any UI for manually triggering a MaxMind refresh — the 24h age check is the only
  trigger besides container restart.
- Removing the now-unused `whois_cache.country` column — left in place per this
  codebase's additive-only schema convention.
