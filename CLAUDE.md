# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted network path monitoring dashboard. It runs `mtr` (combined ping + traceroute)
against user-configured destinations, renders the path as a live draggable network map, and
records full metric history plus every route change ("deviation") over time — not just the
current snapshot. See README.md for the full feature list and API reference; this file focuses on
what you need to work in the code.

## Repo layout

`backend/` and `frontend/` are **independent npm packages** — there is no root `package.json` or
workspace config. Always `cd` into the relevant package before running npm commands.

## Commands

```bash
# Backend — Hono API on :3000
cd backend && npm install
npm run dev          # tsx watch src/index.ts
npm run build         # tsc -p tsconfig.json, then copies db/schema.sql into dist/
npm start             # node dist/index.js (run build first)
npm test              # vitest run — 132 tests
npx vitest run src/services/runs.test.ts   # single file
npx vitest run -t "test name substring"    # single test by name

# Frontend — Vite + React on :5173, proxies /api to :3000
cd frontend && npm install
npm run dev
npm run build          # tsc -b && vite build
npm test               # vitest run (jsdom) — 78 tests
npx vitest run src/components/NetworkMap.test.tsx   # single file

# Full container build/run (compiles mtr from source, bakes GeoIP data)
docker compose up -d --build
```

There is no lint/format tooling configured (no ESLint/Prettier config in either package) — `tsc`
(via `npm run build`) and `vitest` are the only checks. Both tsconfigs use `strict: true`.

## Architecture

### Backend wiring (`backend/src/app.ts`)

`createApp()` is the single composition root: it opens the SQLite db, loads GeoIP range data into
it, constructs one service per domain concern, and registers routes against them. Services take a
`better-sqlite3` `Database` handle directly in their constructor — there's no ORM or repository
layer. `createApp(options)` accepts `db`/`runMtrFn`/`startScheduler` overrides, which is how tests
inject an in-memory db and a fake `mtr` runner without touching the real binary.

### Poll → ingest → deviation → SSE pipeline

This is the core loop and spans several files:

1. `scheduler/scheduler.ts` — one `setInterval` per enabled target (per-target interval, not a
   single global tick). On each tick it runs `mtr/runner.ts` (`runMtr`, shells out to the `mtr`
   binary with `--report --report-cycles=N -j -n`) and parses JSON into an `MtrReport`. `-n` means
   every hop is always identified by raw IP, never a hostname `mtr` resolved itself — reverse-DNS
   display (see Frontend section below) is done separately, on top of that raw IP.
2. `services/runs.ts` (`RunsService.ingest`) — a single `db.transaction()` that (a) inserts the
   raw `hops` rows for this run, then (b) runs `updatePathNodes`, a per-TTL state machine against
   `path_nodes`: if the currently-`active` node at that TTL still matches the reported host, it's
   just touched (`last_seen_at`); otherwise the active node is deactivated (not deleted), the new
   host is inserted-or-reactivated as `path_nodes`, and a row is written to `deviations`. This is
   what makes "old and new hosts both stay on the map" possible — nodes are soft-toggled via the
   `active` flag, never dropped.
3. `scheduler.ts` then publishes the run + any deviations to `sse/hub.ts`, which fans out to every
   client subscribed to that target via `routes/stream.ts` (`GET /targets/:id/stream`).

`services/map.ts` (`MapService.getMap`) is the read side: it walks `path_nodes` by TTL to build
the node chain, and for edges computes a **rolling 5-run average loss%** (via a `JOIN runs` query
ordered by `r.id DESC LIMIT 5`) to decide green/yellow/red, while still reporting the single most
recent run's exact metrics for the label. `services/deviations.ts`'s history-at-a-point-in-time
endpoint reconstructs which host was active per TTL as of a given timestamp by scanning
`deviations` rows, since `path_nodes` only tracks current state.

`MapService.getMap` also draws dashed "stale connector" edges for inactive nodes, capped per-TTL
by the target's `maxStaleHops` setting (0–5, default 1). Each stale node connects to its **true
historical neighbors**, not today's active nodes: for a kept stale node, the service finds the
`MAX(run_id)` at which that node's host was still active at its TTL, then reads that same run's
neighboring-TTL hosts from `hops` and resolves each to either the current active node or another
kept stale node. This matters when two or more adjacent TTLs changed host in the same poll —
connecting to today's neighbors instead would draw edges between hops that were never actually
adjacent on the wire. See `services/map.test.ts` for the two-adjacent-deviation case this guards
against.

### Whois and DNS — parallel lazily-loaded, cached lookups

`services/whois.ts` (`WhoisService`) and `services/dns.ts` (`DnsService`) are structural mirrors
of each other: both check a SQLite cache table first (`whois_cache`, 30-day TTL; `dns_cache`, 24h
TTL — PTR records change more often than whois registrant data), only do the real lookup (a raw
WHOIS-protocol socket / `dns.promises.reverse`) on a cache miss, and write through afterward. The
frontend calls both in bulk (`POST /whois/bulk`, `POST /dns/bulk`) once per newly-seen hop host,
tracked via a `useRef` Set (not React state) in `NetworkMap.tsx` specifically so a lazy resolution
landing never re-triggers the render-affecting node/edge-construction effect chain — see the
Frontend section below for why that coupling is a recurring bug class in this codebase.

### Database

Single SQLite file (`better-sqlite3`, synchronous), schema in `backend/src/db/schema.sql`, applied
by `db/client.ts` on startup (no migration framework — schema changes are additive `CREATE TABLE
IF NOT EXISTS` statements). Key tables: `targets` (includes `max_stale_hops`), `runs`/`hops`
(append-only metric history), `path_nodes` (current + historical path shape, soft-deactivated via
`active`), `deviations` (append-only change log), `node_positions` (per-node dragged x/y),
`whois_cache` (30-day TTL), `dns_cache` (24h TTL), `geoip_v4_ranges`/`geoip_v6_ranges` (offline
CIDR-to-country lookup).

GeoIP lookup uses a "closest start ≤ ip, ordered by start DESC, limit 1" query pattern for both
tables. IPv6 addresses (128-bit) don't fit SQLite's 64-bit INTEGER, so `geoip_v6_ranges` stores
bounds as 32-char zero-padded hex strings — fixed-width hex sorts lexicographically in the same
order as the numeric value, so the same query pattern works unchanged for both families.

### GeoIP data is baked at build time, not fetched at runtime

`backend/scripts/build-geoip-data.mjs` downloads ipdeny.com's country CIDR zone files and converts
them into JSON range arrays using the project's own `geoip/ipMath.ts` conversion logic. This runs
during the Docker build (`backend-builder` stage in `Dockerfile`), so the production image has
**no runtime dependency on any third-party geolocation API**. `geoip/loader.ts` loads that JSON
into `geoip_v4_ranges`/`geoip_v6_ranges` on every app startup (`GEOIP_DATA_DIR` env var).

### Docker build (`Dockerfile`)

Four-stage multi-stage build: (1) clones and compiles `mtr` from the latest source tag — not a
distro package, (2) builds the frontend, (3) builds the backend and runs the GeoIP data script,
(4) assembles a slim runtime image from the outputs of the other three. `mtr`'s `make install`
puts binaries under `/usr/local/sbin`; the runtime stage symlinks them into `/usr/local/bin` to
match `MTR_BIN`.

### Frontend

`App.tsx` is the top-level state owner — it holds `targets`/`mapData`/`deviations`/
`historyActive` and passes them down; there's no external state library. Live updates flow through
`hooks/useSSE.ts`, which subscribes to a target's SSE stream and just triggers a re-fetch of
`/map` and `/deviations` on each event (the SSE payload is a signal, not the source of truth —
`App.tsx` always re-pulls REST state). `historyActive` (set via the deviation timeline scrubber
calling `GET /targets/:id/history?at=`) overlays a past path state on top of the live map without
mutating `mapData`.

`components/NetworkMap.tsx` renders nodes/edges with React Flow (`@xyflow/react`). Node overlap is
resolved by `lib/separation.ts`, a minimum-translation-vector collision-separation pass applied on
top of a fixed node footprint — used both for backend-provided layout and free dragging.
Positions are persisted per-node via `PUT /targets/:id/nodes/:nodeId/position`.

**Recurring bug class to watch for:** more than once, a piece of node-construction state
(`initialNodes`) has ended up depending on lazily-resolved display data (whois/DNS summaries),
which cascades into `initialEdges` → an effect that dismisses the click popup → the popup closing
the instant it opens, every time a lazy lookup resolves. The fix pattern is always the same: keep
`initialNodes` (position/active/edge logic) independent of any display-only data, and layer
display fields onto it via a separate `displayNodes`-style memo used only for rendering. If you add
more per-node display-only data, extend that display layer, not `initialNodes`.

`components/RawMtrPanel.tsx` shows the single most recent poll's raw `mtr` numbers (via
`GET /targets/:id/runs?limit=1`), and sits with `DeviationTimeline` in a bottom row below the
full-width map (`App.tsx`'s `.bottom-panels`).

`hooks/useTheme.ts` + `lib/themes.ts` + `components/ThemeSwitcher.tsx` implement a preset color
theme system: the chosen theme name is written to `localStorage` and applied as
`document.documentElement.dataset.theme`, which `styles.css`'s `:root[data-theme='x']` blocks
override — no per-component styling changes needed, since every component already reads color
custom properties (`var(--bg)`, etc.) rather than hardcoded values. Loss-status colors
(green/yellow/red) are deliberately excluded from theme overrides — they're a fixed signal, not a
palette choice.

### Scope constraint

This is built for a self-hosted, LAN-trusted environment: there is intentionally no
authentication or per-user access control anywhere in the stack. Don't add auth scaffolding unless
explicitly asked — it's out of scope by design, not an oversight.
