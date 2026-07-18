# Map Auto-Layout — Design

> Built without an interactive review cycle, per explicit instruction ("don't ask for
> confirmation, build with most sane values, use subagent-driven development"). The judgment
> calls below are documented so they're inspectable and revisable later, not because they were
> approved in advance.
>
> **Revision history:** the active row was originally staggered vertically to let hop distance
> shrink below a full node footprint without overlapping — first alternating (`+staggerY,
> -staggerY, ...`), then, after that was reported as confusing, a one-directional "waterfall"
> cascade. That was *also* reported as confusing ("layout is still unintuitive"). This doc now
> describes the current, third iteration: no vertical staggering at all — every active hop sits on
> a single straight row, and the x-gap floor is raised to guarantee that row never needs a vertical
> nudge to avoid overlapping. The staggering/cascading sections below have been rewritten in place
> rather than left as dead history, since they no longer describe the shipped behavior.

## Problem

`MapService.getMap`'s current default node position is `{ x: idx * 220, y: n.active ? 0 : 140 }`,
where `idx` is the node's index in the overall (active + kept-stale, mixed) array — not grouped by
TTL, not ordered meaningfully once stale/synthetic nodes are interleaved, and completely blind to
hop latency. It's a placeholder that happens to look reasonable for the simplest case (a short,
all-active path) and increasingly falls apart as stale/synthetic nodes accumulate: multiple stale
entries at the same TTL all land at the *same* `y = 140` with unrelated `x` values (since `idx` is
a global counter, not per-TTL), so they don't visually group under their TTL at all today.

`frontend/src/lib/separation.ts`'s `resolveOverlaps` (MTV collision separation) already guarantees
nodes never *overlap*, but it only nudges existing positions apart — it has no notion of hop order,
latency, or "this stale node belongs under that active one." It's the right tool for its job
(a safety net, including for freely-dragged layouts) and stays exactly as-is; this design adds a
smarter *default* layout upstream of it, not a replacement for it.

## Goals (from the request)

- Hops render in TTL sequence (left to right).
- Stale (and synthetic — see the unresolved-hop-identity design) nodes render *under* their TTL's
  active node, with a gap, not off to the side.
- Multiple stale/synthetic nodes at the same TTL stack under each other (same column, gap between
  them) instead of spreading horizontally — so path width doesn't grow with stale-node count.
- No node/node or link/link overlap; no node sitting on top of a link that isn't its own.
- The active path renders as a single straight, predictable row — no vertical staggering. (Two
  earlier iterations staggered/cascaded the row vertically to allow tighter horizontal spacing;
  both were reported as confusing to read, so this is now an explicit goal in the *other*
  direction: prioritize a straight line over a narrower diagram.)
- Horizontal hop distance is a function of that hop's average latency, not a fixed grid.
- This only concerns *default* positions. A node the user has dragged (persisted via `PUT
  .../nodes/:nodeId/position`) keeps that position untouched, exactly as today.

## Non-goals

- No change to `resolveOverlaps`/`separation.ts` — it stays the final safety-net pass over
  whatever the new default-layout step (or the user's drags) produces.
- No custom edge-routing (e.g. orthogonal/manhattan paths, waypoints). Edge/node overlap is
  avoided by *layout* (keeping the stale lane's vertical band clear of the active lane, so a
  multi-hop stale connector's bezier curve never needs to cross an active node) rather than by
  making `MetricEdge` path-aware of other nodes.
- No change to which nodes are *kept* (`maxStaleHops` selection) or to the stale-connector
  *topology* (which nodes connect to which) — this only changes where nodes are drawn, not what's
  drawn.
- No vertical staggering/cascading of the active row. Superseded goal, not attempted: minimizing
  diagram width by trading horizontal space for vertical was explicitly tried twice and rejected
  both times as harder to read than a wider, straight diagram.

## Design

### New field: `MapNode.hasCustomPosition`

The backend can't currently tell the frontend "this x/y is a real saved position" apart from "this
is just today's placeholder fallback." `MapService.getMap` already builds a `positions` map from
`node_positions` before computing each node's `x`/`y` — expose whether a given node hit that map:

```ts
const nodes: MapNode[] = keptRows.map((n, idx) => {
  const custom = positions.get(n.id);
  const pos = custom ?? { x: idx * 220, y: n.active ? 0 : 140 }; // fallback only used pre-auto-layout
  return { id: n.id, ttl: n.ttl, host: n.host, active: n.active === 1, x: pos.x, y: pos.y, hasCustomPosition: custom !== undefined };
});
```

Synthetic nodes (unresolved-hop gap placeholders) never have a `node_positions` row —
`hasCustomPosition: false` always. The backend's fallback `x`/`y` values become dead weight once
the frontend stops trusting them for non-custom nodes, but they're harmless to leave computed (no
behavior depends on their exact value once `hasCustomPosition` is false) — not worth a second PR to
strip out.

### New module: `frontend/src/lib/layout.ts`

A pure function, no React/React Flow imports, so it's unit-testable without rendering anything:

```ts
export interface LayoutHopNode {
  id: string;
  ttl: number;
  active: boolean;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  nodeGap?: number;
  baseHopGap?: number;
  minHopGap?: number;
  maxHopGap?: number;
  latencyScalePxPerMs?: number;
}

export function computeAutoLayout(
  nodes: LayoutHopNode[],
  avgLatencyMsByTtl: Map<number, number>,
  options?: LayoutOptions,
): Map<string, { x: number; y: number }>;
```

`avgLatencyMsByTtl` is built by the caller (`NetworkMap.tsx`) from the *live* (non-stale) edges'
`latest.avg` — each live edge's target TTL maps to that hop's cumulative avg RTT. `layout.ts` never
touches `MapEdge`/`MapNode` shapes directly, keeping it decoupled and easy to hold in context.

**Defaults** (the "sane values" called for — all pixels, tuned around the existing
`NODE_WIDTH=170`/`NODE_HEIGHT=64`/`NODE_GAP=20` constants from `NetworkMap.tsx`, which callers pass
through explicitly so there's one source of truth for those three):

| Option | Default | Why |
|---|---|---|
| `baseHopGap` | 140 | X distance for a ~0ms-incremental-latency hop — close to today's flat 220 default minus room for the latency term to add on top. In practice the *effective* floor is `max(minHopGap, nodeWidth + nodeGap)` (see `minHopGap` below), so this value only matters once incremental latency pushes the gap past that floor. |
| `minHopGap` | 90 | Caller-configurable floor. The gap actually used is `max(minHopGap, nodeWidth + nodeGap)` — the active row is always at `y = 0` (see Algorithm step 2), so the real, load-bearing floor is `nodeWidth + nodeGap` (190 by default); `minHopGap` only raises it further if a caller explicitly wants more breathing room than that. |
| `maxHopGap` | 420 | Ceiling so one unusually slow hop (e.g. a satellite leg) doesn't blow the whole diagram out to one huge gap. |
| `latencyScalePxPerMs` | 4 | 1ms of incremental latency = 4px of extra hop distance. At this scale a typical 20-40ms transit hop adds ~80-160px — noticeable but not dominant next to `baseHopGap`. |

There is no separate stale-stacking gap option: the vertical gap between every stacked box (active-to-first-stale, and stale-to-stale alike) is always exactly `nodeHeight`, not an independently configurable value — see Algorithm step 3.

### Algorithm

1. **X per TTL column.** Walk TTL 1..maxTTL in order. For TTL 1, `x = 0` (the fixed source node
   sits at `x = -220` in `NetworkMap.tsx`, unchanged, so TTL 1 already starts with clear room after
   it). For TTL *n* > 1: `incrementalLatency = max(0, avgLatencyMsByTtl.get(n) - avgLatencyMsByTtl.get(n-1))`
   (missing data on either side falls back to 0 — no assumed latency, not a wrong one),
   `gapFloor = max(minHopGap, nodeWidth + nodeGap)`, `gap = clamp(baseHopGap + incrementalLatency *
   latencyScalePxPerMs, gapFloor, maxHopGap)`, `x[n] = x[n-1] + gap`. Flooring the gap at
   `nodeWidth + nodeGap` — not just `minHopGap` — is what makes step 2 possible: it guarantees two
   adjacent active hops can never be close enough to overlap, so the active row never needs any
   vertical adjustment. This satisfies "render hops in sequence" and "distance as a function of
   latency," while guaranteeing no overlap purely through X spacing.

2. **Y for the active row: a single straight line.** Every active hop is placed at `y = 0`. Step
   1's gap floor already rules out any horizontal overlap between adjacent active hops, so there is
   nothing left to resolve vertically — no staggering, no cascading. (Two earlier iterations
   staggered this row — first alternating `+staggerY`/`-staggerY`, then a one-directional
   "waterfall" cascade — to let hop distance shrink below a full node footprint and trade
   horizontal space for vertical, keeping the diagram narrower. Both were reported as confusing to
   read ("staggering layout is confusing", then "layout is still unintuitive" for the cascade). A
   straight, predictable row was requested instead, even at the cost of a wider diagram for tightly
   spaced hops.)

3. **Stale/synthetic stacking, with a consistent gap equal to the node's own height.** For each TTL
   with stale and/or synthetic nodes (sorted by `id` for a deterministic, stable order across
   renders), place them at the *same X* as that TTL's active node (or the TTL's computed column X,
   if no active node currently occupies that TTL). Boxes are positioned by their top-left corner
   and are `nodeHeight` tall, so a "slot" (one box plus its trailing blank gap) is `2 * nodeHeight`
   tall; the active row's own box (always `y = 0`, see step 2) occupies the first slot implicitly,
   so the *i*-th stacked node (0-indexed) goes at `y = (i + 1) * (nodeHeight * 2)`. This keeps the
   blank gap between *every* pair of stacked boxes — active-to-first-stale and stale-to-stale
   alike — identically equal to `nodeHeight`, rather than the two different, independently
   configurable gaps an earlier version used (`staleRowGap` for the first gap, `staleStackGap` for
   the rest) — that version's default values (32px and 16px, both smaller than `nodeHeight`) meant
   the *requested* gap was actually smaller than the boxes themselves, so the boxes started out
   overlapping and only ended up separated because `resolveOverlaps` (step 5) corrected it
   afterward — an implementation detail leaking into the visible spacing, not an intentional
   design. This directly satisfies "stale nodes under the new hopnodes with a gap" and "identical
   hops [at the same TTL] stack on top of each other with a gap" rather than spreading sideways.

4. **Why this avoids links running under nodes, without custom edge routing.** Live edges only ever
   connect *adjacent* TTL columns (never skip a hop) and both endpoints sit on the same flat active
   row — the bezier curve between them stays local and can't cross a third node. Stale-connector
   edges can skip multiple TTLs (a stale node's true historical neighbor may not be TTL-adjacent
   once intervening nodes are gone from the kept set), but every stale/synthetic node's Y starts at
   least `nodeHeight` below the (always-`0`) active row, so the stale lane stays strictly below the
   active row everywhere — a stale-to-stale curve, however far it spans horizontally, stays under
   the active row's node band the whole way and never passes behind an active node.

5. **Final pass: unchanged.** Feed the merged position set (custom-positioned nodes as-is,
   everyone else from `computeAutoLayout`) through the existing `resolveOverlaps` exactly as
   today — it's a no-op when nothing overlaps (the common case, by construction of the above) and
   remains the correctness backstop for the cases the heuristics above don't fully anticipate
   (e.g. an unusual mix of drag-pinned and auto-placed nodes landing close together).

### `NetworkMap.tsx` wiring

`initialNodes`'s per-node position becomes:

```ts
const autoPositions = computeAutoLayout(
  mapData.nodes.map((n) => ({ id: String(n.id), ttl: n.ttl, active: n.active })),
  avgLatencyMsByTtl,
  { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, nodeGap: NODE_GAP },
);
// ...
position: n.hasCustomPosition ? { x: n.x, y: n.y } : (autoPositions.get(String(n.id)) ?? { x: n.x, y: n.y }),
```

(The `?? {x:n.x,y:n.y}` fallback only matters if `computeAutoLayout` somehow didn't cover a node —
defensive, not expected to trigger given every node in `mapData.nodes` is passed in.)

`avgLatencyMsByTtl` is built once per `mapData` change, alongside `initialNodes`, from
`mapData.edges` (`!stale && latest != null`) keyed by the target node's TTL.

The source node (`SOURCE_NODE_ID`, not part of `mapData.nodes`) keeps its fixed `{x: -220, y: 0}` —
unchanged.

## Testing

- `layout.test.ts` (new, pure unit tests, no rendering):
  - Sequential X: hops with no latency data land at strictly increasing X in TTL order.
  - Latency-driven spacing: a hop with a larger incremental latency gets a strictly larger X gap
    than one with ~0ms incremental latency, both within `[minHopGap, maxHopGap]` bounds.
  - Clamping: an extreme latency delta doesn't exceed `maxHopGap`.
  - Stacking: two stale nodes at the same TTL get the same X, different Y, both below that TTL's
    active node's Y.
  - Consistent stack gap: the blank gap between the active box and the first stale box equals
    `nodeHeight`, and the gap between two stacked stale boxes equals the same value.
  - Flat row: every active node lands at Y = 0, even with a deliberately tiny `baseHopGap`/
    `minHopGap` that would have triggered staggering under either earlier iteration.
  - Overlap-safe floor: the X gap between consecutive active hops never drops below `nodeWidth +
    nodeGap`, regardless of how small `baseHopGap`/`minHopGap` are set.
  - No active node at a TTL: stale nodes still get a sensible X/Y (falls back to the TTL's computed
    column, baseline Y).
- `map.test.ts` (backend, extend existing position tests): a node with a `node_positions` row gets
  `hasCustomPosition: true` and its exact saved `x`/`y`; a node without one gets
  `hasCustomPosition: false`; a synthetic node always gets `hasCustomPosition: false`.
- `NetworkMap.test.tsx`: a node flagged `hasCustomPosition: true` in `mapData` renders at exactly
  its given `x`/`y` (auto-layout never overrides it); one without renders at the auto-computed
  position instead (not at whatever raw `x`/`y` the backend fallback happened to send).
