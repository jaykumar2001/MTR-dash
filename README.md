# MTR Dashboard

A self-hosted network path monitoring dashboard. It runs [mtr](https://github.com/traviscross/mtr)
(My Traceroute — combined ping + traceroute) against destinations you configure, visualizes the
path as a live, draggable network map, and records both the full metric history and every route
change ("deviation") over time — not just the current snapshot.

![status](https://img.shields.io/badge/status-self--hosted-informational)

## Features

### Live network path map
- Each hop renders as a soft-cornered node ("keystone jack") showing its host/IP, TTL, and
  (once resolved) its **NETNAME** and a **country flag** — all laid out left-to-right along
  bezier "cable run" edges from your host to the destination.
- **Nodes never overlap.** A minimum-translation-vector collision-separation pass pushes any
  colliding pair apart the minimum distance needed, on top of a fixed node footprint — holds up
  whether the overlap came from the backend's layout or from freely dragging nodes around.
- **Drag nodes anywhere** — positions are persisted per target, so your layout survives a reload.
- **Fit-to-screen** automatically frames every node on load and whenever new hops appear, so a
  long path never spills off-screen; you can still pan/zoom manually at any time.
- **Live updates over Server-Sent Events** — the map, deviation timeline, and metrics update the
  moment a new `mtr` run completes, with no page refresh required.

### Full MTR metrics, on demand
- Every hop's **Loss%, Snt, Last, Avg, Best, Wrst, StDev** is recorded on every run.
- Click a cable-run edge to reveal its metrics as a small table anchored right at your cursor.
- Edges are color-coded (green/yellow/red) by a **rolling 5-run average loss%**, so a transient
  blip doesn't repaint the whole path — the label always shows the exact latest reading regardless.

### Deviation tracking over time
- When a hop's responding host changes at a given position in the path, the old and new hosts
  both stay on the map — the superseded node is dimmed with a dashed edge, never deleted.
- A **deviation timeline** lists every route change with a scrubber: pick a point in time and the
  map redraws to show exactly which path was active at that moment.

### Raw IP mode with reverse-DNS display
- `mtr` always runs with `-n`, so every hop's identity is a stable raw IP regardless of `mtr`'s
  own resolver settings.
- The app does its own best-effort reverse-DNS lookup for each hop and shows the resolved
  hostname as an extra line on the node (IP → hostname → NETNAME) when one resolves — cached for
  24 hours, and it never blocks the map from rendering while lookups are in flight.
- A raw-values panel at the bottom of the screen shows the most recent poll's numbers exactly as
  `mtr` reported them, next to the deviation timeline.

### Stale hops stay connected to their real history
- When a hop's host changes, the superseded host doesn't just float disconnected — it's wired
  into the map with dashed grey edges to the neighbors it actually had *at the time it was last
  active*, reconstructed from that run's own hop data (not today's active path). Two hops
  changing in the same poll no longer produces phantom connections between nodes that were never
  actually adjacent.
- A per-target **max stale hops** setting (0–5, default 1) caps how many superseded hosts show per
  position, so a flaky hop doesn't clutter the map.
- Hops that never reply (`mtr`'s `"???"`) get the same careful treatment — deduplicated when it's
  provably the same unknown, and sometimes even resolved to a specific real host when history
  supports it. See [Path history and unresolved-hop resolution](#path-history-and-unresolved-hop-resolution).

### Theme switcher
- Four preset color themes (two dark, two light) selectable from a swatch switcher in the top
  bar; the choice persists across reloads. Loss-status colors (red/amber/green) keep their meaning
  in every theme — only chassis/text/accent colors change.

### Whois + GeoIP, lazily loaded and cached
- Click any hop node for a **whois lookup** (via a native WHOIS-protocol client — no OS package or
  external CLI needed), shown as a scrollable table anchored to your cursor.
- **NETNAME** and a **country flag** are loaded lazily and shown right on the node for every hop
  on the map — no click required, and nothing blocks the initial render.
- Whois results are **cached in SQLite** (30-day TTL) — repeat views of the same host are instant.
- Country lookup is **fully offline at runtime**: IPv4/IPv6 CIDR-to-country data from
  [ipdeny.com](https://www.ipdeny.com/) is downloaded and baked into the Docker image at *build*
  time, so there's no dependency on any third-party IP-geolocation API in production.
- Hops that only report a reverse-DNS hostname (not a raw IP) are forward-resolved before the
  GeoIP lookup, so flags/countries show up for the common case, not just raw-IP hops.
- Any IP-looking value (a hop's host, or a whois field like `NetRange`) is **click-to-copy**, with
  brief visual feedback.

### Web-based configuration
- Add, edit, and remove destinations (IP or hostname) entirely from the browser — no config files.
- Each target has its own independent polling **interval** and `mtr` **report-cycles** count,
  editable at any time and applied on the next scheduled run.

### Built to actually work, not just demo
- `mtr` is **compiled from source** (the latest tagged release) inside the Docker build, not
  installed from a possibly-stale distro package.
- All data — targets, every run's raw metrics, path history, deviations, node positions, and the
  whois/GeoIP caches — persists in a single SQLite file on a Docker volume.

## Architecture

```
┌─────────────┐        REST + SSE        ┌──────────────┐
│  Frontend   │ ───────────────────────▶ │   Backend    │
│ React + Vite│ ◀─────────────────────── │  Hono + Node │
│ React Flow  │                          └──────┬───────┘
└─────────────┘                                 │
                                    ┌────────────┼────────────┐
                                    ▼            ▼            ▼
                               SQLite DB    mtr (native   whois (native
                               (targets,     binary,        npm lib) +
                              runs, hops,   built from    GeoIP CIDR
                              deviations,     source)      tables
                             whois/geoip/dns)
```

- **Backend** — [Hono](https://hono.dev/) on Node.js. An in-process scheduler runs `mtr --report
  --report-cycles=N -j -n <host>` per target on its own interval (`-n` keeps every hop identified
  by raw IP), parses the JSON report, and feeds it through a deviation-detection state machine
  before persisting to SQLite. REST endpoints expose targets/map/deviations/positions/runs/
  whois/dns; a Server-Sent Events endpoint pushes each completed run to connected clients.
- **Frontend** — Vite + React + TypeScript, with [React Flow](https://reactflow.dev/) rendering
  the path as an interactive node/edge graph.
- **Database** — SQLite (`better-sqlite3`), a single file on a named Docker volume — no separate
  DB container to run.
- **mtr** — built from source at Docker build time from the latest tag of
  [traviscross/mtr](https://github.com/traviscross/mtr).
- **whois** — the [`whois`](https://www.npmjs.com/package/whois) npm package, a direct
  WHOIS-protocol socket client (no OS binary, no shelling out).
- **Reverse DNS** — Node's built-in `dns.promises.reverse`, cached in SQLite (24h TTL), used only
  for the display-only resolved-hostname line — never affects a hop's canonical raw-IP identity.
- **GeoIP** — [ipdeny.com](https://www.ipdeny.com/)'s country CIDR-block lists, downloaded and
  converted into SQLite range tables at Docker build time; looked up via an indexed
  "closest start ≤ ip" query for both IPv4 (32-bit int) and IPv6 (128-bit value, stored as a
  fixed-width hex string for correct ordering).

## Path history and unresolved-hop resolution

This is the part of the app with the most subtle behavior — how it decides what's the "same" hop
over time, and what it deliberately refuses to guess. Full design rationale for each piece lives in
`docs/superpowers/specs/`; this section is the practical summary.

### Deviations and stale nodes

Every poll's hops are compared against the last known host at each position (TTL) in the path. When
the responding host at a given TTL changes, that's a **deviation**: the old host's node is
deactivated ("goes stale") rather than deleted, the new host becomes active, and the change is
logged with a timestamp. A per-target **max stale hops** setting (0–5, default 1) caps how many
superseded hosts are kept and shown per position — the rest age out, oldest-deactivated first.

A poll that dies mid-path — short of the path's known depth — is an outage artifact, not route
evidence: its raw metrics are still recorded (and the run flagged `truncated`), but it never
deactivates nodes, creates unknown-hop entries, or logs deviations. Two fingerprints are
recognized: the poll ends unresolved (`"???"`), or it ends on a real host that already sits
*earlier* in the active path — the path collapsing onto itself, e.g. the local gateway echoing as
the last live hop during an outage. A full-depth poll ending in `"???"` is different — that's the
normal steady state for a destination that never answers probes — and a shorter poll ending on a
genuinely new host is a real route change; both are processed like any other poll.

### True historical neighbors, not today's neighbors

A stale node's dashed connector edges are reconstructed from **the same poll's hop data it was last
seen in**, not from whatever's active on the map right now. This matters when two or more adjacent
hops change in the same poll: connecting each stale node to today's current neighbors would draw
edges between hosts that were never actually adjacent on the wire. Reading each stale node's true
neighbors from its own last-active snapshot instead renders the whole superseded segment as the
single coherent path it actually was.

### Unresolved hops (`"???"`) are not a real identity

When a hop doesn't reply, `mtr` reports its host as the literal string `"???"` — a sentinel meaning
"no information," not a stable identity. Two separate `"???"` readings are never assumed to be the
same physical router just because they're both `"???"` — that would risk silently linking unrelated
unknown hops together.

Instead, a `"???"` gap is only ever treated as *possibly the same* as another `"???"` gap when
**both** of its bounding real hosts, and the number of unresolved hops between them, match exactly.
When they do match, every occurrence — however many times it recurs, across however many separate
route changes — shares one rendered "unknown" placeholder instead of spawning a visual duplicate
each time. When either bounding host differs (a real deviation happened right at the edge of the
unknown stretch), the two gaps are kept strictly separate — the system never implies they're the
same just because both happen to read `"???"`. This holds even when the hop *resolving* the gap is
itself an unresolved hop that briefly replied and went stale again — the identity check walks past
it to the real host that truly bounds that side, rather than giving up.

### Known-bridge identity inference

Sometimes a `"???"` gap can be resolved to a **specific** identity, not just a shared placeholder.
If this target's own recent history shows **exactly one** distinct real host sequence has ever
connected the same two bounding hosts, that sequence is substituted in place of the unknown — shown
as its real hostname/IP, with a distinct dashed warn-colored border and a tooltip marking it as
*inferred* (not directly observed in this specific poll), so it's never mistaken for a live
observation.

This is deliberately conservative: if recent history shows **two or more different** real sequences
ever bridging the same two hosts — evidence the path load-balances across multiple real routes
(ECMP) — nothing is substituted, ever. A specific wrong guess would be worse than an honest
"unknown," so any disagreement between historical observations falls straight back to the plain
shared-placeholder behavior above. "Recent" means each candidate host's most recent 20 sightings for
that target, not its full history — bounded so this stays fast regardless of how long a target has
been monitored.

A known bridge can also resolve just a **prefix or suffix** of a longer unresolved run, when the
full run isn't itself a known match — the resolved part is substituted and whatever's left is
re-attempted the same way, repeating until nothing more matches. Any true remainder still falls back
to an ordinary shared "unknown" placeholder, exactly as if no bridge existed at all.

### A stale node's own identity can be inferred too

Everything above resolves a gap **between** two kept nodes. The same bridge-inference machinery is
also applied to a stale node's **own** host: if a deactivated node's last-seen host was itself
`"???"`, and that poll's neighboring hosts on both sides were real (walking past any further
consecutive `"???"` hops on either side, exactly like the neighbor-resolution case above), the same
"exactly one known sequence" check runs against those two bounding hosts. On a match, this specific
stale node is given that resolved identity instead of staying a bare `"???"` box.

What happens next depends on whether that identity is already shown elsewhere on the map, since
showing it twice would just be visual duplication of the same physical hop:

- If the resolved identity is **the current live node** at that position, the live path already
  tells this exact story — the stale node is dropped entirely rather than drawing a redundant second
  copy alongside the active one.
- If the resolved identity has **no existing representation** on the map, the stale node is
  relabeled in place: same node, same edges, just no longer a bare `"???"`.
- If the resolved identity **coincides with a different stale (not active) node** already kept at
  that position — both within `max stale hops` at once — the two are deliberately left as separate
  boxes rather than merged, to avoid ambiguously splicing two independently-resolved stale
  histories together; but the newly-resolved one still shows its known identity rather than a plain
  `"???"`, since that identity is genuinely known.

This relabeling only ever changes what's *displayed* for the node. The host actually recorded in
that poll — `"???"` — is preserved separately and is what deviation history and the timeline
scrubber match against, so scrubbing back to the moment this hop was genuinely unresolved still
shows it correctly, even though the live map now shows its inferred identity.

### Long-horizon fallback and live "???" hops

Both inference forms above consult a bounded recent window (each anchor host's last 20
sightings). Some routers answer probes so rarely that their identity evidence is always older
than any recent window — seen for a couple of minutes a few times a day, silent otherwise. For
those, a stricter long-horizon fallback kicks in when the window finds nothing: if this target's
**entire history** shows exactly one real identity ever recorded at that hop position, and the
positions on both sides are likewise unanimous, that identity is used. (At the very first hop
there is no recorded position on the left — the left bound is the monitoring host itself, known
by definition, so only the first hop's own history and its right neighbor need to agree.) The
unbounded look-back is
safe precisely because it demands unanimity — more history only makes the bar harder to pass, and
any route change or ECMP disagreement ever recorded vetoes the substitution permanently.

This fallback also lets the **live** path benefit: an active hop currently showing `"???"` (the
steady state for a rate-limited router) is relabeled in place with its inferred identity — marked
inferred, exactly like substituted historical hops — and a superseded stale copy of the same
identity at the same position is dropped rather than drawn as a duplicate box. The relabeling is
display-only: deviation history and the timeline scrubber keep matching the raw `"???"` that was
actually recorded.

## Quick start

```bash
docker compose up -d --build
```

Then open `http://localhost:3000`, add a target (IP or hostname), and the first `mtr` run
completes within one polling interval (60s by default).

The compose file grants `NET_RAW`/`NET_ADMIN` (required for `mtr`'s raw sockets) and persists all
data in a named volume (`mtr-data`), so `docker compose down` (without `-v`) keeps everything on
the next `up`.

## Configuration

Set as environment variables on the container (already configured by the Dockerfile/compose file
for the common case — override via `docker-compose.yml` if needed):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port the backend listens on |
| `DB_PATH` | `/data/mtr-dash.sqlite3` | SQLite database file location |
| `MTR_BIN` | `/usr/local/bin/mtr` | Path to the compiled `mtr` binary |
| `STATIC_DIR` | `/app/public` | Where the built frontend is served from |
| `GEOIP_DATA_DIR` | `/app/geoip` | Where the baked GeoIP JSON data lives |

Per-target polling interval, `mtr` report-cycles, and max stale hops (0–5, default 1 — how many
superseded hosts to keep showing per path position) are configured from the web UI, not env vars.

## API reference

All endpoints are under `/api`. Targets are identified by their numeric `id`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/targets` | List configured targets |
| `POST` | `/targets` | Create a target (`host`, optional `intervalSeconds`, `reportCycles`) |
| `PATCH` | `/targets/:id` | Update a target's config or enabled state |
| `DELETE` | `/targets/:id` | Remove a target |
| `GET` | `/targets/:id/map` | Current path as nodes + edges, with rolling loss-color |
| `GET` | `/targets/:id/deviations` | Deviation log (newest first) |
| `GET` | `/targets/:id/history?at=<ISO>` | Which host was active per-hop at a point in time |
| `GET` | `/targets/:id/runs?limit=N` | Most recent raw `mtr` polls, newest first (N capped at 50) |
| `PUT` | `/targets/:id/nodes/:nodeId/position` | Persist a dragged node's `x`/`y` |
| `GET` | `/targets/:id/stream` | Server-Sent Events — pushes each completed run live |
| `GET` | `/whois/:host` | Full whois record for one host (cached) |
| `POST` | `/whois/bulk` | `{hosts: string[]}` → `{[host]: {netname, country}}` (cached, batched) |
| `POST` | `/dns/bulk` | `{hosts: string[]}` → `{[ip]: hostname \| null}` (reverse DNS, cached, batched) |
| `GET` | `/health` | Health check |

## Development

Backend and frontend are independent npm packages.

```bash
cd backend && npm install && npm run dev    # Hono API on :3000 (tsx watch)
cd frontend && npm install && npm run dev   # Vite dev server, proxies /api to :3000
```

Run tests:

```bash
cd backend && npm test     # 153 tests — services, routes, geoip, whois, dns, scheduler
cd frontend && npm test    # 96 tests — components, hooks, API client
```

## Scope

This is built for a self-hosted, LAN-trusted environment: there's no authentication and no
per-user access control. It's meant to sit behind your own network boundary, not be exposed
directly to the internet.
