# Hover-to-highlight full path — design

Date: 2026-07-23
Status: approved

## Problem

`NetworkMap.tsx` renders every hop and cable-run edge for a target at once —
the current active chain plus, per TTL, up to `maxStaleHops` dashed
"historical" connector edges. On a map with several stale segments it's hard
to visually trace which specific nodes/edges belong to the same route just
by looking: the per-element `:hover` glow that already exists in
`styles.css` only lights up the one thing under the cursor, not its
neighbors.

## Decision

Hovering any hop node or cable-run edge highlights the complete connected
route it belongs to — origin through to wherever that chain ends — by
dimming everything else on the map. This works identically for active and
stale/historical elements: no special-casing by `active`/`stale`, because
the highlight is computed by walking the edge graph itself, not by any
node/edge flag.

Rejected alternative: only highlighting from the origin up to the hovered
element (not past it). Rejected because a user hovering a mid-path hop
naturally wants to see where that route goes, not just how it got there —
and the full-route walk is no more complex to implement than a
one-directional one.

## Path computation

Given the hovered element (a node id, or an edge's `source`+`target` node
ids as two starting points), run a bidirectional BFS over the *currently
rendered* `edges` array (both `stale: true` and `stale: false` edges,
undirected — walk both into a node via its incoming edge and out via any
outgoing edges): collect every node id and edge id reached. This is the
highlighted set.

- Hovering the synthetic origin node (id `'source'`, labeled "this host")
  highlights the entire map, since every edge traces back to it. This is
  correct, not a bug to guard against.
- A node that is the shared historical neighbor for more than one
  since-diverged stale segment (rare — bounded by `maxStaleHops`, 0–5) has
  more than one outgoing edge; hovering it highlights all of them. Also
  correct — it genuinely is common history for multiple observed routes.
- No graph-shape assumptions (e.g. "each node has exactly one parent") are
  required or relied upon; the BFS handles whatever shape `MapService`
  produced.

## Changes by layer

Frontend-only — no backend/API changes. `MapNode`/`MapEdge`'s existing
`id`/`source`/`target`/`stale` fields are already everything the traversal
needs.

### `frontend/src/components/NetworkMap.tsx`

- New state: `hoveredElement: { kind: 'node' | 'edge'; id: string } | null`.
- New handlers wired onto `<ReactFlow>` (alongside the existing
  `onNodeClick`/`onEdgeClick` at line ~450): `onNodeMouseEnter`,
  `onNodeMouseLeave`, `onEdgeMouseEnter`, `onEdgeMouseLeave`. Enter sets
  `hoveredElement`; leave clears it (guarded to only clear if it still
  matches the element being left, same defensive pattern already used
  elsewhere in this file for stale-closure guards).
- New memo `pathHighlight: { nodeIds: Set<string>; edgeIds: Set<string> } |
  null`, derived from `hoveredElement` and the current `edges` state via the
  BFS above. `null` when nothing is hovered (the common case) — this is the
  signal "don't dim anything."
- New memo `renderedNodes`/`renderedEdges`: maps over the existing `nodes`/
  `edges` state (the ones already passed to `<ReactFlow>`), adding a
  `dimmed: boolean` field to each element's `data` — `true` when
  `pathHighlight` is non-null and that element's id is absent from the
  relevant Set. Deliberately built as a derived, render-time-only layer —
  the same reason `displayNodes` (netname/geoip fields) is kept separate
  from `initialNodes` today: folding hover state into the `nodes`/`edges`
  state itself would retrigger the fitView/popup-dismiss effect chain that
  key off state identity, and hover fires far more often than a click.
  `renderedNodes`/`renderedEdges`, not `nodes`/`edges`, are what get passed
  to `<ReactFlow>`.
- `pathHighlight`'s BFS reads from `edges` (the live React Flow edge state,
  already available), not `mapData.edges` — cheap for map sizes in this
  app (tens of nodes, not thousands), no memoization concerns beyond the
  existing `useMemo`.

### `frontend/src/components/HopNode.tsx`

- `HopNodeData` gains `dimmed?: boolean`.
- Root `<div>`'s className gains `' dimmed'` when `dimmed` is true (same
  conditional-class pattern already used for `active`/`inactive`/
  `inferred`).

### `frontend/src/components/MetricEdge.tsx`

- `MetricEdgeData` gains `dimmed: boolean` (not optional — this component
  already requires `active`/`stale`/`color` unconditionally, matching that
  convention).
- `<BaseEdge>`'s inline `style` gains `opacity: edgeData.dimmed ? 0.15 :
  1` alongside the existing `stroke`/`strokeWidth`/`strokeDasharray`
  fields.

### `frontend/src/styles.css`

- `.hop-node.dimmed { opacity: 0.25; }` — placed near the existing
  `active`/`inactive` hop-node rules. A CSS `transition` on `opacity`
  (matching the existing `transition: stroke var(--motion-med) ease` on
  edge paths) so the dim/undim isn't an abrupt cut.
- No new edge CSS needed beyond `MetricEdge.tsx`'s inline `opacity` —
  the existing `:hover`/`.selected` glow rule (`filter: drop-shadow(...)`)
  keeps working unchanged on top of it, since opacity and filter are
  independent CSS properties.

## Behavior notes

- Hover highlight is purely additive/visual — it does not interact with
  the existing click-driven popups (edge metrics table, node whois panel)
  or node dragging. A user can hover one element while a popup from a
  click elsewhere is still open; both render simultaneously.
- No debounce/delay on mouseenter — React Flow's own pointer events are
  already granular enough that this doesn't fire on every pixel of
  movement, only on genuine element boundary crossings.
- Not implemented for touch/mobile (no `:hover` equivalent) — consistent
  with this being a LAN-trusted, primarily-desktop dashboard; out of scope
  per the existing app's scope constraints.

## Testing

Vitest + Testing Library, colocated per repo convention:

- `NetworkMap.test.tsx`: firing `mouseEnter` on one hop node dims every
  *other* rendered node/edge (asserted via the `dimmed` class/opacity) and
  leaves the hovered node's own path elements undimmed; firing an edge
  hover highlights both its endpoint nodes; `mouseLeave` clears all
  dimming; hovering the origin node dims nothing (whole map highighted).
  A stale-edge case: hovering a stale (dashed) node/edge highlights its
  historical neighbors the same way an active hop's hover does.
- `HopNode.test.tsx`: renders `.dimmed` class when `dimmed: true`, omits it
  otherwise (mirrors the existing `active`/`inactive` test pattern).
- `MetricEdge.test.tsx`: renders reduced opacity when `dimmed: true`, full
  opacity otherwise.

## Out of scope

- Any keyboard-driven / focus-based equivalent (tab-to-highlight) — hover
  only, matching how the rest of this map's interactivity works today.
- Persisting or click-locking a highlight (e.g. click a node to "pin" its
  path highlighted without hovering) — not requested; hover-only for now.
