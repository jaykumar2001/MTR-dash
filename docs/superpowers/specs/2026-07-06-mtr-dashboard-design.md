# MTR Network Path Dashboard — Design Spec

Date: 2026-07-06

## Purpose

A self-hosted dashboard that continuously runs `mtr` (My TraceRoute) against
one or more configured destinations, visualizes the network path as a
draggable node graph, and records both the path (including route deviations
over time) and the full set of MTR metrics for historical analysis.

## Architecture

- **Backend**: Hono running on Node.js. Serves a REST API, an SSE endpoint
  for live updates, and the static built frontend.
- **Database**: SQLite via `better-sqlite3`. Single file, persisted to a
  Docker volume. No separate DB container.
- **MTR engine**: `mtr` built from source from the latest release tag of
  https://github.com/traviscross/mtr, compiled in a Docker build stage.
  Invoked via `child_process` as:
  `mtr --report --report-cycles=<N> -j <target>`
  (JSON report output), parsed into structured per-hop metrics.
- **Scheduler**: One in-process interval timer per configured target. Each
  target has its own interval (default 60s) and report-cycles count
  (default 10), both configurable from the frontend and changeable without
  restarting the app (new config takes effect on the next scheduled tick).
- **Frontend**: Vite + React + TypeScript. Network map rendered with React
  Flow (draggable nodes/edges), styled with soft-corner rectangular nodes
  similar to the switch-dashboard reference
  (https://github.com/byte4geek/switch-dashboard/blob/2026.6.2-network-map/templates/map.html).
- **Live updates**: Backend pushes new run results to subscribed clients via
  Server-Sent Events, scoped per target.
- **Deployment**: Single multi-stage `Dockerfile` (mtr build stage + frontend
  build stage + Node runtime stage) plus a `docker-compose.yml`. Deployed
  with `docker-compose up -d --build`.

## Data model (SQLite)

- **targets** — `id, host, interval_seconds, report_cycles, enabled, created_at`
  Configured destinations (IP or hostname), each with independent polling
  interval and cycle count.

- **runs** — `id, target_id, started_at, finished_at, status`
  One row per completed `mtr` invocation (one run = `report_cycles` mtr
  probe cycles bundled into a single report).

- **hops** — `id, run_id, ttl, host, loss_pct, snt, last, avg, best, wrst, stdev`
  One row per hop per run — the full MTR metric set for that hop, verbatim
  from the report.

- **path_nodes** — `id, target_id, ttl, host, first_seen_at, last_seen_at, active`
  A distinct node per (target, ttl, host) combination ever observed. This is
  what allows deviations to appear as parallel nodes rather than overwriting
  history. `active` marks whether this is the currently-active node for that
  ttl; only one node per (target, ttl) is active at a time.

- **node_positions** — `target_id, node_id, x, y`
  Persisted drag positions per node. Absent until the user drags a node; a
  default layout (left-to-right by ttl) is computed on the fly when no
  stored position exists.

- **deviations** — `id, target_id, ttl, old_host, new_host, detected_at`
  Log of path changes — written whenever the active node at a given ttl
  changes to a different host. Drives the deviation timeline UI.

### Run processing

After each `mtr` run completes:

1. Insert the `runs` row and one `hops` row per reported hop.
2. For each ttl in the report, compare the reported host to the current
   `active` `path_nodes` row for that (target, ttl):
   - If it matches, update `last_seen_at`.
   - If it differs (or no active node exists yet), look up or create a
     `path_nodes` row for (target, ttl, host); mark it `active`, mark the
     previously active node (if any) `active = false`, and insert a
     `deviations` row recording the change.
3. Superseded (`active = false`) nodes are never deleted — they remain
   visible on the map (dimmed) and selectable via the deviation timeline.

## API surface

- `GET /api/targets` / `POST /api/targets` / `DELETE /api/targets/:id`
  `PATCH /api/targets/:id` — manage destinations, interval, cycle count,
  enabled state.
- `GET /api/targets/:id/map` — cumulative nodes (active + inactive) and
  edges for the current active path, with each edge's latest metrics and
  rolling-average loss color (see below).
- `GET /api/targets/:id/deviations` — deviation log, newest first.
- `GET /api/targets/:id/history?at=<ISO timestamp>` — reconstructs which
  node was active at each ttl at the given time, for the timeline scrubber.
- `PUT /api/targets/:id/nodes/:nodeId/position` — persist a dragged node's
  x/y.
- `GET /api/targets/:id/stream` — SSE stream; emits an event each time a new
  run for this target completes, with the new run's hop data.

## Edge visualization

- Each edge (connecting ttl-adjacent active nodes) is colored using the
  **rolling average Loss% over the last 5 runs** for the destination node's
  active `path_nodes` entry:
  - Green: 0% average loss
  - Yellow: >0–5% average loss
  - Red: >5% average loss
  - Computed on read from `hops`, joined to the currently-active
    `path_nodes.id`, ordered by run time descending, limited to 5.
  - A new/deviated edge colors itself from however many runs it has
    accumulated so far (fewer than 5 until it catches up).
- Edge labels always show the latest single run's full metrics: Loss%, Snt,
  Last, Avg, Best, Wrst, StDev — color is a trend indicator, the label is
  the exact reading.
- A small legend (green/yellow/red loss thresholds) is shown near the map.

## Frontend

- **Sidebar**: list of configured targets + "add target" form (host,
  interval, report-cycles). Selecting a target loads its dedicated map.
- **Main canvas** (React Flow): one node per `path_nodes` row for the
  selected target — soft-corner rectangle, host/IP label. Active-path nodes
  are full opacity and connected by solid, color-coded edges; superseded
  nodes are dimmed, connected by dashed edges to show prior path membership.
  Nodes are draggable; drag position is persisted via the position API.
- **Deviation timeline**: below/beside the canvas — a chronological list of
  deviations (ttl, old host → new host, timestamp) plus a scrubber; moving
  the scrubber re-renders the map to show which nodes/edges were active at
  that point in time.
- **Config panel**: per-target interval and report-cycles editor.

## Sanity check (post-build)

After `docker-compose up -d --build`:

1. Add a target (e.g. `1.1.1.1`) via the frontend.
2. Confirm a real `mtr` run executes and populates `runs`/`hops`/`path_nodes`.
3. Confirm the map renders nodes and color-coded edges with correct labels.
4. Drag a node, reload the page, confirm the position persisted.
5. Confirm the SSE stream updates the canvas without a manual refresh once
   the next scheduled run completes.
6. Force a path change (if feasible) or manually insert a differing hop to
   confirm a deviation is logged and a new parallel node appears.

## Out of scope (for this iteration)

- Authentication/access control (assumed self-hosted, trusted network).
- Data retention/pruning policy (no automatic cleanup of old runs/hops).
- Multi-target simultaneous canvas view (one target at a time via selector).
