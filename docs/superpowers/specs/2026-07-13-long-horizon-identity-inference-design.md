# Long-Horizon Identity Inference for `"???"` Hops — Design

## Problem

The known-bridge inference system
(`docs/superpowers/specs/2026-07-11-known-bridge-identity-inference-design.md`) resolves a `"???"`
hop to a specific real identity when exactly one real sequence connects its bounding hosts in the
target's recent history. Two limitations surfaced together on a real monitored path
(`news.easynews.com`, TTL 13):

1. **The evidence window can be too short for chronically silent routers.** The lookup is anchored
   on a *neighbor* host's most recent 20 occurrences. TTL 13's router (`213.46.183.66`) responds to
   probes only a few minutes per day — 10 sightings out of 2,863 runs — while its TTL 12 neighbor
   responds every poll. Twenty sightings of the neighbor reaches back only a couple of hours;
   the last time TTL 13 identified itself was 18+ hours earlier. The identity evidence exists,
   is unanimous over the target's entire history, and is permanently out of reach of the window.

2. **Active `"???"` nodes are never inference candidates at all.** Every existing resolution path
   (gap-span substitution, stale-node own-identity resolution) operates on stale or synthetic
   nodes. When the *live* path itself shows `"???"` at a TTL — the common steady state for a
   rate-limited router — that active node stays a bare `"???"` box forever, even when a stale twin
   node at the same TTL carries the known identity. The user-visible symptom: two boxes at TTL 13,
   one labeled `???` (active) and one labeled `213.46.183.66` (stale), that are almost certainly
   the same physical router.

## Goals

- A `"???"` hop whose TTL has exactly **one real identity ever recorded** in this target's full
  history — with the neighboring TTLs likewise unanimous ("bounded by known hop nodes") — resolves
  to that identity even when the sighting is arbitrarily old.
- **Active** `"???"` nodes participate in identity inference, not just stale/synthetic ones. An
  active node that resolves is relabeled in place (marked inferred); a kept stale twin carrying the
  same identity at the same TTL is dropped as redundant, collapsing the duplicate pair into one box.
- The existing recent-window inference remains the primary mechanism; the long-horizon lookup is
  strictly a fallback when the window produces nothing.
- All raw-history semantics survive relabeling: deviation records, the timeline scrubber, and any
  (ttl, host) matching against recorded history keep working via `rawHost`.

## Non-goals

- **No widening of the existing 20-occurrence window** (rejected alternative). It scales cost with
  window size, keeps an arbitrary cliff (fails again the moment a router stays silent longer than
  the window), and doesn't address active nodes by itself.
- **No persisted "learned identity" state** (rejected alternative). A table of learned bridges
  written at ingest would survive any silence but introduces mutable state with invalidation
  semantics — a new staleness bug class this design deliberately avoids. The full-history query is
  cheap enough (see Design) that persistence isn't warranted.
- **No resolution of synthetic multi-hop gap chains** via the new lookup. Anonymous placeholder
  chains for multi-TTL unknown spans keep today's behavior; per-TTL attribution inside a multi-hop
  unknown run is weaker evidence and is left as a possible future extension.
- **No backfill of the `maxStaleHops` kept set** when a stale twin is dropped. Kept-set selection
  runs before inference, and a dropped node does not promote the next-oldest stale row —
  consistent with the already-accepted behavior of the existing drop path.
- No cross-target inference, no confidence scores, no fuzzy matching — the bar stays binary,
  exactly as in the prior design.

## Design

### New lookup: `findSoleIdentityAtTtl(targetId, ttl)`

Added to `BridgeInferenceService` alongside the existing window-based methods. Three aggregate
queries over the target's **full history**:

```sql
SELECT DISTINCT h.host FROM hops h
JOIN runs r ON h.run_id = r.id
WHERE r.target_id = ? AND h.ttl = ? AND h.host != '???'
```

— evaluated at `ttl`, `ttl - 1`, and `ttl + 1`. The lookup returns the identity at `ttl` only when
**all three TTLs are unanimous**: exactly one distinct real host ever recorded at the target TTL,
and exactly one at each neighboring TTL. Otherwise `null`:

- Zero real sightings ever at `ttl` (e.g. this path's TTL 15, which has never once identified
  itself) → `null`. Zero evidence is not evidence.
- Two or more identities ever at `ttl` or either neighbor (any historical route change or ECMP at
  this segment) → `null`, permanently. An honest "unknown" beats a specific guess that was ever
  contradicted. This unanimity requirement is what makes the unbounded horizon safe: the further
  back the scan reaches, the *harder* it is to pass, never easier.
- `ttl + 1` past the end of the path has zero real sightings → `null`; a `"???"` at the final
  recorded TTL never resolves this way (nothing bounds it on the right).

The neighbor check is evaluated against history itself, not against a passed-in snapshot of current
neighbors — so one signature serves both active-node and stale-node callers, and a node whose
neighbors are themselves currently flapping to `"???"` still resolves (flaps don't count against
real-host unanimity).

Callers only ever invoke this for nodes whose host is `"???"` with `ttl > 1` (TTL 1's left bound is
the monitoring source, which never appears in `hops` — same guard the existing stale-resolution
loop uses).

**Memoization**: results are cached per `getMap()` call keyed by `ttl` (the queries are
deterministic within one request). Steady-state maps with no `"???"` nodes never execute the
lookup at all.

### Fallback ordering

The existing window-based inference (`findExactBridge` over the neighbor's last 20 occurrences)
stays primary; `findSoleIdentityAtTtl` runs only when it returns `null`. There is deliberately no
distinction between the window returning "no evidence" and "conflicting evidence": full-history
unanimity is strictly stricter on identity count than any window, so recent ECMP disagreement
necessarily implies ≥ 2 identities in full history — the fallback refuses on its own. Falling back
unconditionally on `null` is therefore safe and keeps the call sites simple.

### Call site 1: stale `"???"` own-identity resolution (existing loop, extended)

In `MapService.getMap`'s self-resolution loop, when the walked-bounds `findExactBridge` attempt
yields nothing, try `findSoleIdentityAtTtl(targetId, ttl)`. On success, the resolved identity feeds
the **exact same** outcome logic that already exists — drop when it coincides with the active node,
relabel in place when unrepresented, label-but-keep when it coincides with another kept stale node.
No outcome behavior changes; only the evidence source gains a fallback.

### Call site 2: active `"???"` nodes (new pass)

A new pass over **active** nodes with `host === '???'` and `ttl > 1`, running after the stale
self-resolution loop:

1. Try the window-based lookup first (the active node's own previous/next hops in the latest run
   bound it), then `findSoleIdentityAtTtl` as fallback.
2. On success, relabel the active node in place: `host` becomes the resolved identity,
   `inferred: true`, `active` stays `true`, and `rawHost` keeps the literal `'???'`.
3. If a kept stale node at the same TTL carries that same identity (the duplicate-twin case), add
   it to the existing `resolvedAwayNodeIds` set — it is dropped from the response and skipped by
   the stale-edge loop, exactly like the existing drop path. Its dashed edges would connect the
   same two neighbors the live edges already connect; dropping it loses no information.
4. No match → the active node renders as a bare `"???"` exactly as today.

### Preserved semantics

- **`rawHost`** (introduced alongside the stale-relabel fix) is what the deviation timeline
  scrubber and all history matching compare against. An active node relabeled to an inferred
  identity still matches its recorded `'???'` history; the deviations panel continues to show the
  raw flaps. Nothing in the deviations pipeline changes.
- **Live edge metrics are untouched.** Relabeling changes the node's display label only; edge
  colors, loss percentages, and latency labels all key off runs/hops data, not the node's display
  host.
- **Whois/DNS** treat the inferred identity as any real IP (it passes the same lookupable-host
  check); no special-casing.
- **`active: true` + `inferred: true` is a new combination for the frontend.** `HopNode` must
  render the dashed inferred border and tooltip on active nodes too — until now `inferred` only
  ever appeared on inactive nodes. The active styling (fill/opacity) and the inferred marker
  compose; neither suppresses the other.

### Indexes

`schema.sql` currently has no index on `runs(target_id)` or `hops(run_id, ttl)`; the new
full-history query joins through both, and `hopAtTtlStmt` (`run_id, ttl`) is already the hottest
query shape in `map.ts` and `bridgeInference.ts`. Two additive statements, per this codebase's
migration-free convention:

```sql
CREATE INDEX IF NOT EXISTS idx_runs_target_id ON runs(target_id);
CREATE INDEX IF NOT EXISTS idx_hops_run_ttl ON hops(run_id, ttl);
```

With these, the full-history DISTINCT query is an indexed walk of the target's runs with an
indexed per-run hop lookup — a few milliseconds for tens of thousands of hop rows, acceptable for
a synchronous `/map` request that only pays it when `"???"` nodes are present, memoized per
request.

## Testing

- `BridgeInferenceService` (`services/bridgeInference.test.ts`):
  - Sole identity with unanimous neighbors → returns the identity.
  - Two identities ever at the target TTL → `null`, even when the most recent 100 sightings agree
    (ancient disagreement still vetoes).
  - Zero real sightings ever at the target TTL (perpetual `"???"`) → `null`.
  - Neighbor TTL non-unanimous (two identities ever at `ttl - 1` or `ttl + 1`) → `null`.
  - `"???"` sightings at any of the three TTLs are ignored (don't count for or against unanimity).
- `MapService` (`services/map.test.ts`):
  - **The motivating regression**: identity evidence exists only in runs *older* than the
    neighbor's last-20-occurrence window (neighbor responds every run; the target TTL answered
    only in early runs) → the active `"???"` still resolves via the fallback.
  - Duplicate-twin collapse end-to-end (the TTL 13 scenario): active `"???"` + stale real twin at
    the same TTL → one box, labeled with the identity, `active: true`, `inferred: true`,
    `rawHost === '???'`; the twin is absent; live edges intact with their metrics.
  - Active `"???"` does **not** resolve when a second identity exists anywhere in history.
  - Stale `"???"` own-identity resolution succeeds through the fallback when the window fails
    (existing outcome logic reused).
  - No stale-twin present: active node relabels in place, nothing dropped.
- Frontend (`components/NetworkMap.test.tsx` / `HopNode`):
  - A node with `active: true, inferred: true` renders both the active styling and the dashed
    inferred marker + tooltip.
  - History-scrubber matching for a relabeled active node uses `rawHost` (already covered by the
    existing rawHost test; extend to the active case).
- README: extend the "Path history and unresolved-hop resolution" section with a short paragraph
  on long-horizon sole-identity resolution and active-node relabeling.
