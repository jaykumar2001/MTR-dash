# Project Handoff — MTR Dashboard

**Last updated:** 2026-07-09
**Purpose of this document:** everything needed to resume development in a fresh session — where
the code actually lives, what's shipped vs. in-progress, what was decided and why, and what's
still open.

---

## 1. Repository / branch state — read this first

Everything lives on a single branch now: **`main`** (renamed from `master`, no remote configured
so this was a local-only rename), at `/home/jkumar/MTR-dash`. The `mtr-dash-design` branch and
its worktree (described throughout this document) have been merged into `main` and deleted —
there is nothing left to merge. Every feature described in §4 below (2026-07-08 onward) was built
and committed directly on `main`, one `superpowers:subagent-driven-development` plan at a time —
no feature branches were used for that work, unlike the `mtr-dash-design` history in §3. If you're
resuming work, this is the only branch and location that matters:

```bash
cd /home/jkumar/MTR-dash
git status         # should be clean
git log --oneline -5
```

To bring the running container up to date:

```bash
docker compose up -d --build
curl -s http://localhost:3000/api/health   # {"status":"ok"}
```

Sections 3–7 below narrate how the codebase got to its current state (originally built on
`master` across 20 plan tasks, extended and redesigned on a since-merged `mtr-dash-design`
branch, then extended again directly on `main` — see §4) — that history is kept here because the
*why* behind several non-obvious decisions (and two recurring bugs, see §3d) is still directly
relevant, even though the `mtr-dash-design` branch itself no longer exists. Read it as "how this
code came to look the way it does," not as a description of something still pending.

---

## 2. What was originally built (20-task plan, fully implemented and reviewed)

Built via `superpowers:subagent-driven-development` across 20 plan tasks (see
`docs/superpowers/plans/2026-07-06-mtr-dashboard-plan.md` and the design spec at
`docs/superpowers/specs/2026-07-06-mtr-dashboard-design.md`), then one round of final-review
fixes. This is the baseline the work described in §3 built on top of (via the since-merged
`mtr-dash-design` branch).

- **Backend** (Hono + Node + SQLite): target CRUD, an in-process scheduler that runs `mtr
  --report --report-cycles=N -j <host>` per target on its own interval, a deviation-detection
  state machine (tracks route changes as parallel `path_nodes` rows instead of overwriting
  history), map/deviations/positions/history REST endpoints, and a Server-Sent Events stream per
  target.
- **Frontend** (Vite + React + React Flow): a draggable node/edge network map, loss-color-coded
  edges, a deviation timeline with a time-scrub feature, and a target configuration UI.
- **Docker**: a 4-stage `Dockerfile` that builds `mtr` from source (latest git tag of
  `traviscross/mtr`) and both npm packages into one runtime image; `docker-compose.yml` for
  `docker-compose up -d --build`.
- Verified end-to-end in the plan's Task 20 against real internet traffic (1.1.1.1, a real
  8-hop path).

If you need the full history of *how* this was built (task-by-task implementer/reviewer
transcripts, fix rounds, etc.), it isn't in this repo — that lives in the conversation history
that produced it. This document is the durable summary; treat it as authoritative over any
memory of "what the plan said" since a few things were corrected during implementation (see the
plan file's own text, which was kept in sync with those corrections).

---

## 3. What was added afterward (originally on `mtr-dash-design`, now merged into `main`)

Commits, oldest to newest (these are now part of `main`'s history, in this order):

```
3a1a399  Redesign frontend with a patch-panel/network-rack visual identity
e41f5ce  Show link metrics as a table on click instead of always-visible label
b77788c  Fix metrics table position, node overlap, and switch edges to bezier
b0f6be9  Port MTV collision separation and hover-glow patterns for reference
e7c9c8c  Add whois lookup on hop-node click, copy-on-click for IPs, fit-to-screen
6242783  Add offline GeoIP country lookup, whois caching, and lazy loading for all hops
85904eb  Fix ConfigPanel not reflecting target config changes without a remount
4e20b27  Add README documenting product features, architecture, and API
```

### 3a. Visual redesign ("Patch Panel")

The frontend was reskinned around the actual physical thing mtr traces (rack equipment, patch
panels, cable runs) instead of a generic dashboard look:

- Warm charcoal chassis palette, IBM Plex type family (Sans Condensed for headers, Mono for all
  data/hostname readouts), one reserved accent color (patch-cable orange) used only for
  selection/focus — never for data.
- Hop nodes styled as keystone-jack modules; edges as cable runs (originally straight, later
  switched to bezier curves — see 3b).
- Loss-color convention (green/yellow/red) is treated as real port-LED colors, not arbitrary UI
  color.
- All of this lives in `frontend/src/styles.css` (one file, CSS custom properties at the top) and
  `frontend/index.html` (Google Fonts link for IBM Plex).
- **Known limitation:** no headless browser was available in this environment at any point, so
  none of the visual design was verified by actually looking at it — only by passing tests, clean
  builds, and manual WCAG contrast-ratio checks on the palette. **If you have a browser, look at
  it before assuming the visual design is correct.**

### 3b. Network map interaction fixes

Iterated based on user feedback across several rounds:

1. Metrics label was always visible and crowded the map → changed to click-to-reveal.
2. The click-to-reveal table appeared at a fixed point regardless of which edge was clicked, and
   nodes could overlap, and edges were straight lines → fixed all three:
   - The metrics table is now a single overlay owned by `NetworkMap` (not per-edge), positioned at
     the actual click/cursor coordinates and clamped to stay inside the viewport.
   - Node overlap: `frontend/src/lib/separation.ts` — a minimum-translation-vector (MTV)
     collision-separation algorithm (ported, as explicit implementation *reference* only, from a
     sibling project `/home/jkumar/Librenms-dash`; no object in this project was renamed to match
     that project's naming). Pushes any two overlapping node boxes apart along the axis of least
     penetration, the minimum distance needed.
   - Edges switched from `getStraightPath` to `getBezierPath` (`frontend/src/components/
     MetricEdge.tsx`).
3. **A real bug was found and fixed along the way:** `fitView()` (used both on mount and whenever
   new nodes appear, via `FitViewOnChange` inside `NetworkMap.tsx`) moves the viewport through the
   same d3-zoom transform API a genuine user pan/zoom does, so it fires the *same* `onMoveStart`
   event — but with `event: null` (no real pointer behind it). The popup-dismiss handler
   (`handleMoveStart` in `NetworkMap.tsx`) was silently clearing whatever popup a click had just
   opened, because it didn't originally distinguish "real user gesture" from "our own programmatic
   refit." Fixed by only dismissing on a non-null event. **If you ever see a click-triggered popup
   vanish immediately after opening, this is the mechanism to suspect first** — it's subtle enough
   that it recurred multiple times in different forms while this branch was built (see the
   `whoisSummaries`/`initialNodes` coupling bug in 3d below, which is the same root cause wearing
   a different hat).

### 3c. Whois lookup, copy-to-clipboard, GeoIP country lookup

The largest addition on this branch. In order of dependency:

- **`Copyable` component** (`frontend/src/components/Copyable.tsx`) — click-to-copy with brief
  "copied" visual feedback, `stopPropagation` so it doesn't also trigger a parent node/edge click.
  Ported as implementation reference from the same sibling project's `Copyable.tsx`. Used for
  hop-node hostnames and any IP-looking whois field value.
- **Whois backend** — `backend/src/whois/` (runner.ts wraps the `whois` npm package, a direct
  WHOIS-protocol socket client — deliberately *not* an OS `whois` binary/apt package, per explicit
  user instruction mid-session; `parser.ts` parses raw text into key/value fields and extracts a
  "netname" checking several registries' different key spellings).
- **Whois caching** — new `whois_cache` SQLite table (30-day TTL). `backend/src/services/
  whois.ts`'s `WhoisService` checks this cache before ever re-running a whois lookup for the same
  host, and writes through to it after every real lookup. This covers both the single-host detail
  endpoint (`GET /api/whois/:host`) and the bulk summary endpoint (`POST /api/whois/bulk`).
- **GeoIP country lookup** — fully offline at runtime:
  - `backend/src/geoip/ipMath.ts` — pure CIDR↔range conversion, IPv4 as a 32-bit int, IPv6 as a
    128-bit BigInt rendered as a fixed-width 32-char hex string (so plain lexicographic string
    comparison in SQLite preserves numeric ordering — no need for SQLite to support 128-bit ints).
  - `backend/src/geoip/lookupCountry.ts` — looks up a country for an IP via an indexed
    "largest start ≤ ip, then check ip ≤ end" query against `geoip_v4_ranges`/`geoip_v6_ranges`.
  - `backend/src/geoip/loader.ts` — idempotently seeds those tables from prebuilt JSON at backend
    startup (skips if already populated).
  - `backend/scripts/build-geoip-data.mjs` — downloads ipdeny.com's country CIDR-block zone files
    (IPv4: `https://www.ipdeny.com/ipblocks/data/countries/all-zones.tar.gz`, IPv6:
    `https://www.ipdeny.com/ipv6/ipaddresses/blocks/ipv6-all-zones.tar.gz`) and converts them to
    JSON, **reusing the compiled `dist/geoip/ipMath.js`** so the build script and the runtime
    lookup share the exact same tested conversion logic (no duplicated math to drift out of sync).
  - Wired into the Dockerfile's `backend-builder` stage (runs once, right after `npm run build`),
    with the output copied into the runtime image at `/app/geoip` (`GEOIP_DATA_DIR` env var) — no
    network dependency on ipdeny.com at container runtime. **This means the geoip data is a
    build-time snapshot; it will not pick up ipdeny.com updates without rebuilding the image.**
  - Since many mtr hops report a reverse-DNS *hostname*, not a raw IP, `WhoisService` forward-
    resolves the host to an IP via `dns.lookup` before the GeoIP lookup (best-effort; failures just
    mean no country/flag for that hop, not an error).
- **Lazy bulk loading on the frontend** — `NetworkMap.tsx` calls `POST /api/whois/bulk` once for
  every newly-seen hop host (tracked via a `useRef` Set, not React state, specifically so it never
  re-triggers the render-affecting effect chain described in 3d), merges the result into a
  `whoisSummaries` state map, and displays NETNAME + a country flag
  (`country-flag-icons/react/3x2`, looked up dynamically by code) right on the hop node.

### 3d. A second instance of the popup-dismissal bug (important to understand)

When netname/country support was added, `initialNodes` in `NetworkMap.tsx` was extended to
include them — which meant `initialNodes` now depended on `whoisSummaries`. But `initialNodes`
also feeds `nodeActiveById` → `initialEdges` → an effect that calls `setPopup(null)` whenever
`initialEdges` changes. Result: every time a lazy whois summary resolved (even to an empty `{}`),
the whole chain recomputed and silently closed whatever popup a click had just opened — the exact
same *symptom* as the fitView bug in 3b, but a different root cause.

**The fix, and the pattern to preserve:** `initialNodes` (used for position/active/edge logic)
must stay independent of whois data. A separate `displayNodes` memo layers netname/country onto
`initialNodes` *for rendering only* (`useNodesState(displayNodes)` instead of
`useNodesState(initialNodes)`), and `FitViewOnChange` is keyed on the whois-independent
`initialNodes`, not `displayNodes`. **If you add more per-node display-only data in the future,
extend `displayNodes`, not `initialNodes`** — coupling anything into `initialNodes` risks
reintroducing this class of bug.

### 3e. ConfigPanel staleness fix

Audited the whole frontend for the React foot-gun of seeding local state from a prop via
`useState(prop)` with no re-sync effect. Found exactly one instance:
`frontend/src/components/ConfigPanel.tsx` initialized its interval/report-cycles fields once at
mount and never updated them if the target's config changed by any other means (switching
targets, or an external update) without the component remounting. Fixed with a `useEffect` keyed
on `[target.id, target.intervalSeconds, target.reportCycles]`. No other component had this
pattern — `TargetForm`'s `useState` defaults are one-time initial values for a blank draft, not
derived from a mutable prop, so they're fine as-is.

### 3f. README

`README.md` at the repo root documents the product from a user's perspective (features,
architecture diagram, quick start, config, API table, dev setup). This `HANDOFF.md` is the
complement — developer/continuation-facing, not user-facing.

---

## 4. What was added after that (directly on `main`, 2026-07-08 to 2026-07-09)

No branch was cut for this work — each feature below was built as its own design doc + plan under
`docs/superpowers/`, executed via `superpowers:subagent-driven-development`, and committed
straight to `main`. Commits, oldest to newest:

```
532c975  Add design doc for raw IP mode, DNS resolution, and layout panels
cae3279  Add implementation plan for raw IP mode, DNS resolution, and layout panels
9f648c3  Run mtr with -n and add reverse-DNS resolution via DnsService
6c15b30  Add DNS bulk-resolution route and wire it into the app
2e26292  Add RunsService.getRecentRuns for raw per-poll history
2e0661f  Fix getRecentRuns to floor a negative limit instead of relying on SQLite's unbounded-LIMIT semantics
473f216  Add run-history route and wire it into the app
f363e82  Render a resolved hostname line on HopNode when present
60c21c4  Bulk-resolve and display reverse-DNS hostnames on the map
ddfa213  Add RawMtrPanel showing live per-poll raw mtr values
956dd86  Move raw-values panel and deviation timeline to flank the map
21a61ce  Log flaky App.test.tsx test in HANDOFF known issues
459cf52  Add design doc for connecting stale hop nodes to the path
12fcaac  Add implementation plan for connecting stale hop nodes to the path
0d032fe  Add per-target maxStaleHops config
aca0ba6  Connect stale hop nodes to their active neighbors in MapService
b6ce058  Add maxStaleHops setting to ConfigPanel
5abf769  Style stale connector edges dashed and grey in MetricEdge
acc88f4  Render stale connector edges in NetworkMap, hidden during history playback
7351911  Fix Target test fixtures missing maxStaleHops
b400bf7  Address final review: remove dead field, add stale-edge test coverage
e04bdf6  Keep stale connector edges visible during history playback
9a003c6  Add design doc for simplifying the raw MTR panel to bottom layout
4d422b0  Add implementation plan for simplifying raw MTR panel and bottom layout
9c741d8  Show only the latest poll in RawMtrPanel instead of a scrolling history
6b090b5  Move raw-values table and deviations to a bottom row, giving the map full width
a00849c  Add design doc for preset color themes
f9acd38  Add implementation plan for preset color themes
1e840f6  Add theme presets data and useTheme hook
27a17db  Add ThemeSwitcher swatch component
06c23cf  Wire theme switcher into the top bar and add preset theme CSS
1114e16  Add design doc for historically-correct stale path edges
ed7098b  Add implementation plan for historically-correct stale path edges
6f1d96a  Connect stale nodes to their true historical neighbors instead of today's active ones
```

### 4a. Raw IP mode, reverse-DNS hostnames, layout panels

`mtr` now always runs with `-n` (`mtr/runner.ts`), so every hop's identity is a stable raw IP
regardless of `mtr`'s own resolver — no more inconsistent hostname-vs-IP depending on what `mtr`
felt like reporting. The app does its own best-effort reverse-DNS lookup on top of that raw IP
and shows the resolved hostname as an extra display line on the hop node (IP → hostname →
NETNAME), via a new `DnsService` (`backend/src/services/dns.ts`) that's structurally a mirror of
`WhoisService` — same cache-first pattern, new `dns_cache` table (24h TTL, shorter than whois's
30-day TTL since PTR records change more often), `POST /api/dns/bulk` route
(`backend/src/routes/dns.ts`), and a `NetworkMap.tsx` bulk-fetch effect identical in shape to the
existing whois one.

**Pattern to preserve:** `resolvedHost` is purely additive display data, following the exact same
rule §3d already establishes for whois — `host` stays the one canonical raw-IP identifier for
whois/geoip/node-dedup/copy-to-clipboard everywhere; never let a display-only DNS field leak into
`initialNodes` or any identity/dedup logic.

Also added in the same design doc: `RunsService.getRecentRuns(targetId, limit)` and
`GET /targets/:id/runs?limit=N` (limit capped at 50 server-side) for a raw-values panel
(`RawMtrPanel.tsx`, later simplified in §4c) showing `mtr`'s numbers exactly as reported, and the
deviation timeline moved to flank the map (later moved again to a bottom row in §4c).

### 4b. Stale connector edges (superseded by §4e — read that section too)

Previously, a superseded (inactive) host just floated on the map with no edges. This added dashed
grey connector edges from each stale node to its neighbors, plus a per-target `maxStaleHops`
setting (0–5, default 1, `targets.max_stale_hops` column) capping how many stale hosts show per
TTL position so a flaky hop doesn't clutter the map. Touched `MapService.getMap`
(`backend/src/services/map.ts`), `MetricEdge.tsx` (dashed/grey styling, no metrics label on stale
edges), `ConfigPanel.tsx` (the numeric input), and `Target`/`MapEdge` types.

One iteration detail worth knowing if you're touching this area: an early version hid stale edges
during history-timeline playback, which made a stale node look like it lost its connection every
time you clicked a deviation — reverted so stale edges stay visible during playback too
(`e04bdf6`). Also had one independent-review pass (`b400bf7` — the only one of these five features
that did; see §4's intro and §8 item 3).

**This feature's core algorithm was explicitly a simplification:** the original design doc for
this called connecting stale nodes to *today's* active neighbors (not their real historical
neighbors) an acceptable simplification. §4e revisited that call and reversed it — read §4e before
touching `MapService`'s stale-edge logic.

### 4c. Simplify raw panel + bottom layout

Frontend-only, no backend/API/schema changes. `RawMtrPanel` now shows only the single most recent
poll in place (prop changed from `{runs: RunHistoryEntry[]}` to `{run: RunHistoryEntry | null}`,
fetched via `getRunHistory(id, 1)`) instead of a scrolling history nobody was reading. The map got
its full width back — `RawMtrPanel` and the deviation timeline both moved from flanking the map
(§4a) into a shared bottom row (`App.tsx`'s `.bottom-panels` flex row replaced `.main-columns`;
`styles.css` updated to match, `border-left` from §4a reverted back to `border-top`).

### 4d. Preset color themes

Frontend-only, no backend/DB/API involvement. Four preset color themes (`dark-patch-panel`
default, `dark-slate`, `light-paper`, `light-slate`) selectable via a swatch switcher
(`ThemeSwitcher.tsx`, mounted in `App.tsx`'s `.app-header`). `hooks/useTheme.ts` reads/writes
`localStorage['mtr-dash-theme']` (fails soft if `localStorage` is unavailable) and sets
`document.documentElement.dataset.theme`; `styles.css` adds `:root[data-theme='x']` override
blocks that work with zero component-level changes because every component already consumed
`var(--bg)`-style custom properties from §3a's original design-token setup. Red/amber/green
loss-status colors are deliberately excluded from the per-theme overrides — they keep their
meaning in every theme.

### 4e. Historically-correct stale path edges (most recent — HEAD)

Fixes a real correctness bug in §4b's stale-edge algorithm: when **two or more adjacent hops**
changed host in the same poll, the old logic (connect every stale node to whatever's active
*today*) drew phantom edges between nodes that were never actually adjacent on the wire, and lost
the fact that the old segment had moved together as one coherent unit. Single-hop-change cases
(the common case) were never affected — same edges before and after this change.

The fix, entirely in `MapService.getMap` (`backend/src/services/map.ts`, no schema or frontend
changes — the `hops` table already had everything needed): for each kept stale node, find
`MAX(run_id)` where that node's host was active at its TTL, read that same run's neighboring-TTL
hosts, and resolve each neighbor to either the current active node or another kept stale node
(deduping by edge id). New coverage in `services/map.test.ts` for the two-adjacent-TTL-deviation
case and a "true neighbor got bumped out of the kept-stale set" omission case.

**Worth remembering:** §4b's design doc explicitly called "connect to today's neighbors, not
historically accurate" a deliberate, sufficient simplification. This feature reversed that
judgment call after the multi-hop-change case turned out to produce visibly wrong edges in
practice — correctness cost the same complexity as the simplification did. If similar
"good enough" calls get made elsewhere in `MapService`, this is the precedent for revisiting them
once a concrete case exposes the gap, not before.

---

## 5. Current test/build state (verified at time of writing)

```
backend:  132 tests passing (26 test files) — tsc clean
frontend:  78 tests passing (16 test files) — tsc clean
```

Frontend build succeeds but emits a Rollup chunk-size warning (~574KB / 163KB gzipped, up from
~338KB before `country-flag-icons` was added — see §7). Not currently addressed; judged an
acceptable trade-off for a self-hosted internal tool rather than adding dynamic-import complexity
for ~55KB gzipped savings.

Full Docker build (`docker compose up -d --build`) was run and verified end-to-end multiple times
during the `mtr-dash-design` work (§3), including a real whois/geoip round trip against live data
(1.1.1.1 → `APNIC-LABS`/`AU`, 8.8.8.8 → `GOGL`/`US`) — that verification predates §4's five
features and has **not** been re-run against them (no fresh `docker compose up -d --build` +
live-target smoke test since 2026-07-08). No headless browser was ever available in this
environment, in any session to date — visual/interactive correctness (does dragging actually feel
right, does the DNS hostname line render as expected, do the theme swatches actually change the
page, etc.) has **not** been confirmed by a human or automated browser test at any point. Do both
before considering the current state of `main` verified.

---

## 6. Key files, by area (current branch)

**Backend** (`backend/src/`):
```
app.ts                      — composition root; wires every service + route
db/client.ts, db/schema.sql — SQLite connection + full schema (targets, runs, hops,
                               path_nodes, node_positions, deviations, whois_cache,
                               dns_cache, geoip_v4_ranges, geoip_v6_ranges)
mtr/{runner,parser,types}.ts — invokes mtr (now always with `-n`, see §4a), parses
                               its JSON report
whois/{runner,parser}.ts,
whois/whois-module.d.ts     — invokes the `whois` npm lib, parses raw text, ambient
                               type shim (package ships no types)
geoip/{ipMath,loader,
        lookupCountry}.ts   — CIDR math, DB seeding, country lookup
services/dns.ts              — reverse-DNS lookup + cache (mirrors whois.ts, see §4a)
services/*.ts                — one per domain (targets, runs, map, deviations,
                               positions, whois, dns) — all business logic, no HTTP
                               here; map.ts also builds stale-node connector edges
                               using true historical neighbors (see §4e)
routes/*.ts                  — one per domain — HTTP layer only, delegates to
                               services (includes runs.ts and dns.ts, added in §4a)
scheduler/scheduler.ts       — per-target interval timers, runs mtr, ingests, publishes SSE
sse/hub.ts                   — target-scoped pub/sub for the SSE stream
scripts/build-geoip-data.mjs — Docker-build-time-only script (see 3c)
```

**Frontend** (`frontend/src/`):
```
App.tsx                      — top-level state: selected target, mapData, deviations,
                               historyActive (time-scrub), SSE wiring, run history for
                               RawMtrPanel, bottom-panels layout (see §4c)
components/NetworkMap.tsx    — the whole React Flow canvas: node/edge construction,
                               collision separation, fit-to-screen, click popups
                               (edge metrics + node whois), lazy whois + DNS
                               bulk-loading
components/HopNode.tsx       — one hop's rendered box: host (copyable), ttl,
                               resolved DNS hostname (see §4a), netname, country flag
components/MetricEdge.tsx    — one cable-run edge: bezier path, color, hover glow,
                               dashed/grey styling for stale connector edges (§4b)
components/Copyable.tsx      — click-to-copy primitive
components/RawMtrPanel.tsx   — most recent raw mtr poll, bottom row (see §4a, §4c)
components/ThemeSwitcher.tsx — swatch theme picker in the top bar (see §4d)
components/{Sidebar,
  TargetForm,ConfigPanel,
  DeviationTimeline,
  Legend}.tsx                — target list/CRUD, per-target settings (incl.
                               maxStaleHops, §4b), deviation timeline+scrubber,
                               loss-color legend
lib/separation.ts             — MTV collision-separation (pure, no React)
lib/themes.ts                 — THEMES preset array + DEFAULT_THEME (see §4d)
hooks/useSSE.ts               — subscribes to a target's SSE stream
hooks/useTheme.ts             — reads/writes localStorage theme choice (see §4d)
api/client.ts, types.ts       — typed fetch wrapper + all shared TS interfaces
```

**Docker/deploy** (repo root):
```
Dockerfile          — 4 build stages: mtr-builder (from source), frontend-builder,
                       backend-builder (also runs build-geoip-data.mjs), runtime
docker-compose.yml   — single service, NET_RAW/NET_ADMIN caps, named volume `mtr-data`
```

---

## 7. Known issues / accepted trade-offs (carry these forward, don't rediscover them)

- **npm audit**: `better-sqlite3`'s install-time `prebuild-install` toolchain reports 3
  moderate/1 high/1 critical advisories. Judged non-blocking during the final whole-branch review
  that originally shipped `master` — the flagged chain only runs during `npm install` to fetch a
  prebuilt native binary, it's not on the running server's runtime attack surface, and the
  actually-runtime-exposed packages (`hono`, `@hono/node-server`, `better-sqlite3` itself) were
  all current at review time. Still worth a `npm audit` pass with real network access
  periodically. `country-flag-icons` was added later and does not itself introduce new advisories.
- **Frontend bundle size**: `country-flag-icons/react/3x2` is imported via a namespace import
  (`import * as Flags from ...`), which bundles all ~240 flag SVGs (~55KB gzipped) even though a
  given map will only ever show a handful of countries. Not fixed — the complexity of per-flag
  dynamic imports (async loading state, Suspense) wasn't judged worth it for this app's scope.
  Revisit if bundle size becomes an actual problem.
- **GeoIP data staleness**: baked in at Docker build time from whatever ipdeny.com serves that
  day. Rebuilding the image is the only way to refresh it; there's no scheduled/runtime refresh.
- **No visual/browser verification**: repeated throughout this codebase's development (see §3a,
  §5) — this environment never had a headless browser. Everything was verified via passing
  tests, clean typechecks/builds, and (for the Docker/API layer) real curl/DB inspection against
  the running container. **Open it in an actual browser before trusting the visual design or drag
  interaction feel** — this still hasn't been done.
- **SSE-vs-drag resync risk** (pre-existing, from the original 20-task implementation, never
  fixed): `NetworkMap` does a full-replace resync of React Flow's node/edge state on every
  `mapData` prop change. If an SSE tick lands mid-drag (between drag-start and `onNodeDragStop`
  persisting the new position), the dragged node could theoretically snap back to its
  last-persisted position. Accepted as low-risk given the default 60s+ polling interval vs. a
  multi-second drag window.
- **Failed mtr runs aren't persisted as a `runs` row** (pre-existing): the `status` column
  defaults to `'ok'` and is never set to `'error'`; a scheduler-tick failure only produces a
  transient SSE `{type:'error'}` event with no lasting DB trace.
- **No retention/pruning policy** (pre-existing, explicitly out of scope in the original design
  spec): `runs`/`hops` grow unbounded. Fine for a personal/small-team deployment; would need
  addressing for long-running high-frequency polling at scale.
- **Flaky test**: `frontend/src/App.test.tsx`, `'loads targets and shows the selected target host
  in the config panel'` fails intermittently (~1 in 10 runs) due to a timing race — confirmed via
  `git stash` during the raw-ip-mode-and-panels branch's review to predate that branch entirely,
  so it isn't something those changes introduced or worsened. Not yet root-caused or fixed; likely
  needs a `findBy*`/`waitFor` tightened around the initial render before asserting on the config
  panel's display value. Re-run the test a few times if you see it fail before assuming a real
  regression. (Did not reproduce in the full 78-test run done for this update on 2026-07-09 — still
  intermittent, not fixed, just didn't come up that time.)
- **DNS/whois forward-resolve is now mostly a no-op**: `WhoisService`'s `dns.lookup(host)` forward
  resolution step (added when hops could report bare hostnames) still runs on every whois/geoip
  lookup, but since §4a made `mtr` always run with `-n`, hops now always report raw IPs already —
  `dns.lookup` on an IP just returns that same IP. Harmless, not worth removing (still correct if a
  future change ever reintroduces hostname-reporting hops), but don't be surprised it's there.

---

## 8. Next steps

1. **Open it in a real browser** and confirm the redesign actually looks/feels right — drag a
   node, click an edge, click a hop node's whois popup, watch a live SSE update land, resize the
   window, switch themes, watch the resolved-DNS line and the bottom-row raw panel update live.
   Nothing here has been visually confirmed, in any session to date.
2. **Run a fresh `docker compose up -d --build` and smoke-test §4's features specifically**
   (DNS bulk-resolve, `maxStaleHops`, the historically-correct stale edges in §4e, theme
   persistence) — the last full Docker verification (§5) predates all of §4.
3. Decide whether to act on any item in §7 now or explicitly defer them (they're written down
   precisely so a future session doesn't have to rediscover them).
4. Everything described in §3 and §4 was built and self-verified turn-by-turn (mostly in direct
   response to user feedback for §3; via `superpowers:subagent-driven-development` plan tasks for
   §4), without an independent code review the way the original 20-task plan (§2) had — the one
   exception is §4b (stale connector edges), which did get one review-and-fix pass (`b400bf7`). If
   you want that level of scrutiny applied to everything else retroactively, a `/code-review` pass
   over `main`'s history (or just the commits listed in §3 and §4) would be the way to get it.

---

## 9. How to verify everything still works, from scratch

```bash
cd /home/jkumar/MTR-dash

# Backend
cd backend && npm install && npx vitest run && npx tsc -b && npm run build
cd ..

# Frontend
cd frontend && npm install && npx vitest run && npx tsc -b && npm run build
cd ..

# Full stack via Docker
docker compose up -d --build
curl -s http://localhost:3000/api/health
curl -s -X POST http://localhost:3000/api/targets \
  -H 'Content-Type: application/json' \
  -d '{"host":"1.1.1.1","intervalSeconds":60,"reportCycles":5}'
# wait ~65s for the first scheduled run, then:
curl -s http://localhost:3000/api/targets/1/map
docker compose down   # stops the container; add -v to also drop the data volume
```
