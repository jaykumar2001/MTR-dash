# Unresolved (`???`) Hop Identity — Design

## Problem

`mtr` reports a hop as literal host string `"???"` when a probe at that TTL gets no reply. Nothing
in the pipeline treats this as special — `RunsService.updatePathNodes` and
`MapService.getMap`'s historical-neighbor resolution (from the
[correlated-stale-path-edges](2026-07-09-correlated-stale-path-edges-design.md) design) both
compare hosts by plain string equality. That's correct for real IPs, but wrong for `"???"`: it's a
sentinel meaning "no information," not a stable identity. Two separate `"???"` observations are
not provably the same physical hop.

Concretely: run N reports `a - b - ??? - ???`; run N+1 reports `a - b' - ??? - ???` (TTL 2
deviates, TTL 3/4 keep reading `"???"`). Because `active.host === hop.host` matches `"???" ===
"???"`, the TTL 3/4 `path_nodes` rows never deactivate — they stay active across the deviation.
The stale-connector logic then draws a dashed edge from stale `b` to that same still-active `"???"`
node, while the live chain also connects `b'` to it. The map ends up asserting the unknown
downstream hop reached via the old path (`b`) and the new path (`b'`) are the *same* hop — a claim
we have no evidence for.

Separately, `NetworkMap.tsx` calls `api.getWhois(host)` for whatever hop node is clicked, with no
check that `host` is even a lookupable value. The backend's `VALID_HOST` regex in
`routes/whois.ts` already (correctly) rejects `"???"` with a 400, but the frontend surfaces that
rejection as "Whois lookup failed" — a scary, misleading message for what's actually just a normal
no-reply hop.

## Goals

- The map never draws an edge that asserts two `"???"` hops (observed under different bounding
  real hosts) are the same physical, unidentified router.
- When the exact same bounded gap — same TTL span, same known host immediately before it, same
  known host immediately after it — recurs (from a different run, a different stale chain,
  anywhere in the same `/map` response), it's safe to treat it as the same gap and render one
  shared pair of nodes for it, instead of spawning a visually-duplicate pair each time.
- Clicking a hop node that isn't a real, lookupable host never attempts a whois call and never
  shows an error message.

## Non-goals

- No changes to `RunsService.updatePathNodes`, `path_nodes`, or `deviations`. Ingest-time
  continuity semantics for `"???"` are left exactly as they are today — this is a rendering-layer
  fix only. (Rejected alternative: make every `"???"` reading always deactivate/reinsert at ingest
  time. Correct in isolation, but on a target with a permanently-unresponsive hop behind a
  firewall, that's a fresh `deviations` row and a fresh `path_nodes` row on literally every poll,
  forever — unbounded table growth for a hop that never changes in any way that matters.)
- No change to `maxStaleHops` selection (which stale nodes are kept at all per TTL) — only to what
  a kept stale node connects to when that connection would otherwise pass through a `"???"` hop.
- No change to DNS reverse-lookup bulk behavior — only whois, per the reported issue. (The bulk
  whois/DNS endpoints already silently drop invalid hosts server-side; only the single-node click
  path was missing a guard.)

## Design

### Part 1 — Synthetic nodes for unresolved gaps, keyed by their bounds

When `MapService.getMap`'s neighbor-resolution walk (added in the correlated-stale-path-edges
design) looks up a stale node `S`'s neighbor at the adjacent TTL and finds the reported host is
`"???"`, it no longer resolves that neighbor via the existing `nodeByTtlHost` string-match (which
would silently reuse whatever `"???"` node happens to be currently active/kept — the bug above).
Instead:

1. **Find the gap's extent.** Starting from the TTL adjacent to `S`, walk further in the same
   direction through `S`'s `lastActiveRunId` hop snapshot while the host keeps reading `"???"`.
   Stop at the first TTL that reports a real host (the gap's **far bound**), or at the end of the
   recorded path (**far bound = none**).
2. **Identify the gap's near bound.** This is simply `S.host` (real, by construction — `S` is
   itself a resolved node) — or, if the gap starts at TTL 1, the synthetic source node.
3. **Key the gap.**
   - If a far bound was found: key = `(ttlStart, ttlEnd, nearBoundHost, farBoundHost)`.
   - If no far bound was found: key = `(ttlStart, ttlEnd, nearBoundHost, "run:" + lastActiveRunId)`
     — deliberately unique per source run, so it can never accidentally merge with an unrelated
     occurrence we have no way to confirm is the same.
4. **Reuse or create.** All gap resolutions performed during the same `getMap` call share one
   `key → synthetic node chain` table. First time a key is seen, create one synthetic node per TTL
   in the gap (`id: "synthetic:" + key + ":" + ttl`, `host: "???"`, `active: false`,
   `synthetic: true`), chained in sequence, with the chain's far end connected to the resolved real
   node if `farBoundHost` was found. Every later resolution producing the *same* key reuses that
   same chain instead of creating a new one.

This single keying rule produces exactly the desired behavior in both directions:

- `a-b-???-???-d` recurring with the same `b` and `d` on both sides of an unrelated deviation
  elsewhere → same key both times → same two synthetic nodes reused → rendered once, shared.
- `a-b-???-???-d` vs. `a-b'-???-???-d` (the near bound itself changed) → `nearBoundHost` differs
  (`b` vs `b'`) → different key → independent synthetic chains → no false claim of sameness.
- `a-b-???-???` with no downstream resolution at all (the original reported example) → no far
  bound → key includes the run id → always its own distinct chain, never merged with anything.

Synthetic node ids are deterministic strings (not database ids), stable across repeated `/map`
polls for the same underlying data, so React Flow on the frontend doesn't lose node identity
(position, popup state) between fetches.

### Part 2 — Frontend fallout from synthetic nodes

- `MapNode.id` (backend) and the mirrored frontend `MapResult` type widen from `number` to `number
  | string`; `MapEdge.source`/`target` likewise. `NetworkMap.tsx` already stringifies node ids for
  React Flow (`String(n.id)`), so this is a narrow, mostly type-level change.
- `node_positions` has no row for synthetic nodes (nothing to persist) — they get the same
  computed-default position as any other unpositioned node.
- `handleNodeDragStop` must skip `PUT /targets/:id/nodes/:nodeId/position` for a synthetic node id
  (non-numeric) instead of calling `Number(...)` and sending `NaN`.

### Part 3 — Don't attempt whois for unresolved hosts

`backend/src/routes/whois.ts`'s `VALID_HOST` regex already rejects `"???"` correctly; no backend
change. Add a frontend-only guard in `NetworkMap.tsx`, mirroring that same pattern, e.g.:

```ts
const LOOKUPABLE_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
```

In `handleNodeClick`, if `!LOOKUPABLE_HOST.test(host)` (true for `"???"` and for any synthetic
node, since its `host` is also `"???"`), skip `api.getWhois` entirely and set whois state directly
to the existing `{ status: 'success', result: { host, fields: [] } }` shape — which already renders
as "No whois data available", the correct message for "there's nothing to look up here," as
opposed to `status: 'error'` which implies something went wrong.

## Testing

- Backend (`services/map.test.ts`): a stale node whose historical neighbor is `"???"` gets a
  distinct synthetic node, not an edge to the currently-active `"???"` node.
- Backend: two resolutions (e.g. two different stale chains, or a stale chain and a live-path
  segment) that produce the same `(ttlStart, ttlEnd, nearBound, farBound)` key end up pointing at
  the identical synthetic node ids (shared, not duplicated).
- Backend: same scenario but with the near bound changed between the two resolutions → distinct
  synthetic node ids (not shared).
- Backend: a gap with no resolvable far bound (trace ends in `"???"`) never shares its synthetic
  chain with another such gap, even if the near bound matches.
- Frontend (`NetworkMap.test.tsx`): clicking a `"???"` or synthetic node never calls
  `api.getWhois` and renders "No whois data available" immediately, not a loading state followed
  by an error.
- Frontend: dragging a synthetic node does not call `api.setNodePosition`.
