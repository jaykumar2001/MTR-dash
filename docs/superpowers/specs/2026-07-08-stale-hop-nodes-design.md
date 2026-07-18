# Stale Hop Nodes Connected to the Path — Design

## Problem

When a hop at a given TTL changes host (a "deviation"), the previous host's `path_nodes`
row is soft-deactivated (`active = 0`) rather than deleted — this is intentional, per
`RunsService.updatePathNodes`. `MapService.getMap` already returns *every* `path_nodes` row,
active and inactive, with no limit, and the frontend already renders every one of them as a
box on the map (inactive nodes default to `y = 140`, active to `y = 0`).

But edge-building only connects consecutive **active** nodes. Inactive/stale nodes therefore
render as disconnected floating boxes, disconnected from the main path, with no visual
indication of *why* they're there or how they relate to the current path shape. There's also
no cap on how many stale hosts can accumulate at a single TTL — a flaky hop that round-robins
through many hosts over time would render all of them, unbounded.

## Goals

- Stale nodes at TTL=k render connected into the map at that TTL position, instead of floating
  disconnected.
- A clear visual distinction between the live path and stale/historical branches.
- A per-target cap on how many stale hosts are shown per TTL, configurable from the dashboard.

## Non-goals

- Reconstructing the exact historical path shape (i.e., what was active at TTL=k-1 and k+1 at
  the moment a given stale node was itself active). Stale nodes connect to *today's* active
  neighbors, not a historically accurate snapshot — the existing history-scrubber feature
  (`GET /targets/:id/history?at=`) already covers point-in-time reconstruction; this feature is
  about the live map view.
- Metrics (loss%/latency) on stale edges — they're not carrying live traffic, so there's nothing
  current to report.

## Design

### Backend: `targets` config

New column on `targets`:

```sql
max_stale_hops INTEGER NOT NULL DEFAULT 1
```

Surfaced through the existing config plumbing pattern (mirrors `interval_seconds` /
`intervalSeconds`, `report_cycles` / `reportCycles`):

- `backend/src/services/targets.ts` — `TargetConfig`/`CreateTargetInput`/`UpdateTargetInput` gain
  `maxStaleHops: number`, mapped to/from the `max_stale_hops` column.
- `backend/src/routes/targets.ts` — accepts `maxStaleHops` in create/update request bodies.
- `frontend/src/types.ts` — `Target` gains `maxStaleHops: number`.
- `frontend/src/components/ConfigPanel.tsx` — new numeric input, range 0–5, alongside the
  existing interval/cycles fields.

Default `1`: shows the single most-recently-deactivated host per TTL. `0` disables stale nodes
entirely (equivalent to today's pre-fix behavior, minus the orphan clutter bug). Capped at 5 to
keep the map readable.

### Backend: `MapService.getMap`

Per TTL, currently:
1. All `path_nodes` rows for the target are returned as `MapNode[]` (unfiltered, unlimited).
2. `activeByTtl` map is built from `active === 1` rows.
3. Edges connect consecutive entries in `activeByTtl` only.

Changes:

1. **Limit stale nodes per TTL.** Group inactive rows by TTL, order each group by
   `last_seen_at DESC`, keep only the first `target.maxStaleHops`. Drop the rest from the
   response entirely — this both fixes the unbounded-clutter issue and bounds the new edge
   generation below.
2. **Generate stale edges.** For each retained stale node at TTL=k, emit up to two edges:
   - `activeByTtl.get(k-1) → staleNode`
   - `staleNode → activeByTtl.get(k+1)`

   Omit either side if no active node exists at that neighboring TTL (same skip-missing-TTL
   behavior already used for the active chain). If neither neighbor exists, the stale node is
   returned with zero edges — it renders as an isolated box, no worse than today.
3. **Mark stale edges.** `MapEdge` gains a `stale: boolean` field (default `false` for the
   existing active-active edges). Stale edges carry no `avgLossPct`/`latest` metrics — those
   fields become optional on `MapEdge`, omitted when `stale: true`.

Edge `id` stays `"${source}-${target}"`; since stale edges always have a stale node as one
endpoint, they can't collide with an active-active edge id.

### Frontend

- `types.ts` — `MapEdge.stale: boolean`, `avgLossPct`/`latest` become optional.
- `NetworkMap.tsx` — edges with `stale: true` render dashed and grey, bypassing the normal
  green/yellow/red loss-based coloring, and don't show a metrics label.
- No changes needed to node rendering or `lib/separation.ts` — inactive nodes already render and
  get de-collided by the existing bounding-box separation pass; they simply gain connecting
  edges now. Multiple stale nodes at the same TTL each get their own edge pair to the same
  active neighbors; separation handles spacing them apart visually.
- Stale connector edges stay visible even while a historical snapshot is being viewed via the
  deviation-timeline scrubber (`historyActive` set). An earlier iteration hid them during
  scrubbing on the theory that they represent today's path rather than the viewed moment, but in
  practice that made a stale node appear to "lose its connection" every time a deviation was
  clicked — confusing, since it looked like a regression rather than a deliberate view change.
  Always showing them is simpler and avoids that surprise.

### Data flow

`ConfigPanel` save → `PUT /targets/:id` → `targets.ts` service persists `max_stale_hops` →
`MapService.getMap` reads it per-request to bound stale node/edge selection →
`GET /targets/:id/map` → `NetworkMap.tsx` renders dashed grey branches alongside the live path.

## Edge cases

- `maxStaleHops = 0`: no stale nodes or edges returned.
- Stale node's neighboring TTLs both lack an active node: node renders isolated, no stale edges.
- Multiple stale nodes at one TTL: each independently edges to the same current active
  neighbors; no attempt to chain stale nodes to each other.
- Reactivation (a stale host becomes active again): handled already by existing
  `updatePathNodes` logic — no change needed; the reactivated row simply moves back into
  `activeByTtl` and drops out of the stale set.

## Testing

- Backend (`map.test.ts`): stale edge generation (both-neighbors, one-neighbor, no-neighbor
  cases), `maxStaleHops` limiting and `last_seen_at DESC` ordering, `maxStaleHops = 0` disables
  the feature, no metrics on stale edges.
- Frontend (`NetworkMap.test.tsx`): `stale: true` edges render dashed/grey without a metrics
  label; normal active edges unaffected.
