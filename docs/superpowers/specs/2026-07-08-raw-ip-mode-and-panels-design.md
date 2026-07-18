# Raw IP Mode, Reverse-DNS Hostnames, and Live Layout Panels — Design

## Problem

`mtr` is currently invoked without `-n`, so it performs its own reverse-DNS resolution and
reports whatever it finds (a hostname, or the raw IP if resolution fails/times out) directly in
each hop's `host` field. This is inconsistent (sometimes a hostname, sometimes an IP, depending
on `mtr`'s own resolver behavior at poll time) and can stall a poll cycle waiting on a slow DNS
server.

Separately, the live map page currently shows only the processed/aggregated view (rolling-average
loss-colored edges) and the deviation timeline (stacked below the map). There's no way to see the
raw, per-poll `mtr` numbers as they arrive, and the deviation timeline's current position (directly
below the map) competes for the same vertical space as the map itself.

## Goals

- `mtr` always runs with `-n`, so every hop's `host` field is consistently a raw IP.
- Each hop optionally shows a reverse-DNS-resolved hostname alongside its IP, resolved by the app
  itself (not by `mtr`), only when the reverse lookup actually succeeds.
- A new panel shows raw per-poll `mtr` output (every hop's raw numbers, exactly as reported) as
  new polls arrive, without digging into the database.
- The page layout gives the map more room: the new raw-values panel goes on the left, the
  existing deviation timeline moves to the right.

## Non-goals

- Changing what `host` means anywhere else in the app (whois lookups, geoip lookups, node
  identity/copy-to-clipboard, `path_nodes` deduplication) — `host` stays the raw IP everywhere;
  the resolved hostname is purely additive display, following the same "don't disturb the
  canonical identifier" principle the existing whois/netname display already uses.
- Streaming individual `mtr` ping cycles within a single scheduler poll. `mtr --report-cycles=N`
  already runs N pings internally and returns one aggregated JSON report per poll; the raw-values
  panel shows one entry per *poll* (per scheduler tick), not per individual ping inside a poll.
- Unbounded raw-value history in the UI — the panel shows the newest 50 polls only. Full history
  remains queryable from the database as it always has been; this panel is a live-monitoring view,
  not a historical browser.

## Design

### 1. `mtr -n` and reverse-DNS hostname resolution

**Backend — `mtr` invocation:**

`backend/src/mtr/runner.ts`'s `runMtr` adds `-n` to the `execFile` args unconditionally, alongside
the existing `--report`, `--report-cycles=N`, `-j`. From this point on, every hop's `host` field
in every `MtrReport` is a raw IP literal, not a hostname — `mtr` never attempts its own DNS
resolution.

**Backend — resolution service:**

New `dns_cache` table (`backend/src/db/schema.sql`), matching the shape and spirit of the existing
`whois_cache` table:

```sql
CREATE TABLE IF NOT EXISTS dns_cache (
  host TEXT PRIMARY KEY,
  hostname TEXT,
  fetched_at TEXT NOT NULL
);
```

`hostname` is nullable — a cache row can represent "we tried and got nothing" so a failed PTR
lookup doesn't get retried on every request within the TTL window. TTL is 24 hours (PTR records
change more readily than the WHOIS ownership data `whois_cache` stores, so a shorter window than
that table's 30 days).

New `backend/src/services/dns.ts` (`DnsService`), structured like `WhoisService`:
- `resolve(ip: string): Promise<{ hostname: string | null }>` — cache lookup first; on miss/expiry,
  calls `dns.promises.reverse(ip)` (Node's built-in reverse-DNS), catches failure (no PTR record,
  timeout, malformed input) and caches a `null` hostname in that case too, so a persistently
  unresolvable IP doesn't hammer the DNS resolver on repeat requests.
- Constructor accepts an optional `resolveFn` override (mirroring `WhoisService`'s
  `resolveHostFn`/`runWhoisFn` pattern), so tests can inject a fake resolver instead of hitting
  real DNS.

**Backend — route:**

New `POST /api/dns/bulk` (`backend/src/routes/dns.ts`), structurally identical to
`POST /api/whois/bulk`: body `{ hosts: string[] }` (IP literals), validates/dedupes/caps the list
the same way (existing `VALID_HOST` regex and `MAX_BULK_HOSTS` constant, reused or duplicated
identically), returns `{ [ip]: string | null }`. A single failed lookup returns `null` for that IP
rather than failing the whole batch — matching the existing whois-bulk error-isolation behavior.

**Frontend:**

`frontend/src/components/NetworkMap.tsx` gains a `dnsHostnames` bulk-fetch effect, structurally
identical to the existing `whoisSummaries` effect: tracks already-requested IPs in a ref, fetches
`POST /api/dns/bulk` for newly-seen IPs on the currently-visible node set, stores results in state,
layers `resolvedHost` onto `displayNodes` the same way `netname`/`country` are layered on today
(additive, not part of `initialNodes`/`initialEdges`, so it never retriggers the `fitView`/popup-
clearing effects that are deliberately scoped to structural map data only).

`frontend/src/components/HopNode.tsx`'s `HopNodeData` gains `resolvedHost?: string | null`.
Rendered as a new `.hop-node-hostname` line, visually consistent with the existing
`.hop-node-netname` line (same treatment: small, muted, only rendered when the value is present).
It renders directly below the IP (`.hop-node-host`) and above the netname line, so the visual
order top-to-bottom is: TTL/flag → IP → resolved hostname → netname.

### 2. Raw MTR values panel (left side)

**Backend:**

New route `GET /api/targets/:id/runs?limit=50` (`limit` optional, capped server-side at 50
regardless of what's requested). Queries the `runs` table for the target ordered by `id DESC`
limited to `limit`, joins each run's `hops` rows (ordered by `ttl ASC` within each run), returns:

```ts
interface RunHistoryEntry {
  id: number;
  startedAt: string;
  hops: { ttl: number; host: string; lossPct: number; snt: number; last: number; avg: number; best: number; wrst: number; stdev: number }[];
}
```

as `RunHistoryEntry[]`, newest run first. Backed by a new method on the existing `RunsService`
(`getRecentRuns(targetId, limit)`) — this is a straightforward read query alongside the service's
existing `ingest` method, not a new architectural layer.

**Frontend:**

New `frontend/src/components/RawMtrPanel.tsx`, taking `runs: RunHistoryEntry[]` as a prop. Renders
one block per run (poll timestamp as the block's header, formatted the same way
`DeviationTimeline` already formats `detectedAt`), each block containing a compact table of that
run's hops — ttl, host (raw IP), loss%, snt, last, avg, best, wrst, stdev, exactly as `mtr`
reported them, no rounding/reformatting beyond what the JSON already contains. Newest run renders
at the top of the panel; the panel itself scrolls independently once its content overflows its
column height.

`frontend/src/App.tsx` fetches `/api/targets/:id/runs?limit=50` the same way it already fetches
`/map` and `/deviations`: once on target selection, and again on every SSE signal (full refetch,
replacing state — not incremental client-side accumulation). This matches the app's existing
"SSE is a signal, REST is the source of truth" pattern (`hooks/useSSE.ts` triggers a re-fetch;
it never carries data itself). Because the endpoint always returns the newest 50 runs, each
refetch naturally drops the oldest entry as a new one arrives — no extra client-side bookkeeping
needed to achieve the "cumulative, bounded" behavior.

### 3. Layout: raw panel left, deviations right

`frontend/src/styles.css` — `main`'s direct children stay as they are for `ConfigPanel` and the
conditional history banner (full-width, top, unchanged). Below those, a new wrapper
(`.main-columns`, `display: flex`) holds three columns in a single row:
`RawMtrPanel` (left, fixed `320px`, `overflow-y: auto`) → `NetworkMap` (center, `flex: 1`,
unchanged internally) → `DeviationTimeline` (right, fixed `320px`, `overflow-y: auto`). This
mirrors the existing fixed-width `Sidebar` (`260px`) pattern already used for the page's outer
grid.

`frontend/src/App.tsx` reorders JSX accordingly: `ConfigPanel` and the history banner render
first as today; then a `<div className="main-columns">` wraps `RawMtrPanel`, `NetworkMap`,
`DeviationTimeline` in that left-to-right order. `DeviationTimeline`'s own props and behavior
(`deviations`, `onScrub`) are unchanged — this is purely a layout move, not a behavior change to
that component.

## Edge cases

- An IP with no PTR record: `DnsService.resolve` caches `hostname: null`; `HopNode` simply omits
  the hostname line (falls back to today's IP-only display).
- `dns.promises.reverse` returning multiple hostnames for one IP (PTR records can have more than
  one): use the first entry, matching how most reverse-DNS UIs handle multi-PTR results.
- A poll that produces zero hops (a fully-failed `mtr` run): `RawMtrPanel` still renders a block
  for that run with an empty hop table, rather than silently dropping the entry — keeps the panel
  an honest one-block-per-poll log.
- Bulk DNS/whois requests for the same IP set: independent caches, independent bulk endpoints — a
  slow/failing DNS resolver never blocks or degrades whois lookups or vice versa.

## Testing

- Backend: `mtr/runner.test.ts` — `-n` present in `execFile` args. `services/dns.test.ts` (new,
  mirrors `whois.test.ts`) — cache hit/miss, TTL expiry, failed lookup caches `null` and doesn't
  retry within TTL, injected `resolveFn` override. `routes/dns.test.ts` (new, mirrors
  `routes/whois.test.ts`) — bulk validation/dedup/cap, per-host failure isolation. New test
  coverage on `RunsService.getRecentRuns` (or a `routes/runs.test.ts`) — `limit` respected and
  capped at 50, newest-first ordering, hops correctly nested and ordered by ttl per run, a
  zero-hop run still returns an entry.
- Frontend: `HopNode.test.tsx` — `resolvedHost` line renders only when present, positioned between
  IP and netname. `NetworkMap.test.tsx` — new test for the DNS bulk-fetch-and-display effect
  (structurally identical to the existing whois-summary test). `RawMtrPanel.test.tsx` (new) — one
  block per run, correct hop rows and column values, newest-first order, empty-hops run still
  renders a block. `App.test.tsx` — new `.main-columns` wrapper present, `RawMtrPanel` and
  `DeviationTimeline` both render inside it in the correct left/right order.
