# Known-Bridge Identity Inference for Unresolved Hops — Design

## Problem

The existing unresolved-hop-identity system (`docs/superpowers/specs/2026-07-10-unresolved-hop-identity-design.md`)
treats a `"???"` gap bounded by the same two known real hosts, with the same TTL span, as *the same
anonymous unknown* across separate occurrences — it shares one synthetic placeholder instead of
drawing a false link between unrelated unknowns. That's still correct and stays unchanged.

Two gaps in that system, reported directly by the user:

1. **Bug**: `walkGap`'s anchor-identity fallback (`backend/src/services/map.ts`) gave up and used a
   per-run-unique token whenever the node *resolving* a gap was itself `"???"`-hosted (an interior
   unknown hop that briefly replied and went stale again) — meaning the exact same recurring gap
   would never be recognized as the same occurrence twice. **Already fixed** (commit `65b07cf`,
   landed ahead of this design doc): `walkGap` now walks past a `"???"`-hosted anchor to find the
   real host that truly bounds that side, instead of falling back to a token that can never match
   anything else.

2. **New capability, this doc's scope**: a `"???"` gap bounded by two known hosts should be
   resolved to a *specific* real identity — not just an anonymous shared placeholder — when exactly
   one real intermediate sequence has ever been observed connecting those same two hosts in this
   target's recent history. Real example given: `84.116.138.18 → ??? → 84.116.136.177` observed
   alongside `84.116.138.18 → 84.116.130.54 → 84.116.136.177` at another time — since only one real
   bridge (`84.116.130.54`) has ever been seen between those two endpoints, it's safe to infer the
   `"???"` *is* `84.116.130.54`, rather than an anonymous unknown. A second example shows this
   should chain: once `84.116.138.18 → 84.116.130.54 → 84.116.136.177` is established, a longer
   unresolved run starting with the same two hosts (`84.116.138.18 → ??? → ??? → ??? →
   185.90.199.107`) can have that known 2-hop prefix substituted in, leaving a shorter remaining gap
   (`84.116.136.177 → ??? → 185.90.199.107`) to be resolved the same way.

## Goals

- When a `"???"` gap's two bounding real hosts have exactly one distinct real intermediate sequence
  ever observed between them (within a bounded recent history — see Non-goals), substitute that
  real sequence in place of the anonymous placeholder.
- The substituted nodes render as their real, specific hostnames/IPs, visually marked as inferred
  (not observed responding in this specific poll) rather than indistinguishable from a normally
  live/stale node.
- If more than one distinct sequence has ever been observed between the same two bounds (evidence
  of load-balanced/ECMP routing), never substitute — fall back to the existing anonymous
  shared-placeholder behavior. A specific wrong guess is worse than an honest "unknown."
- A known shorter bridge may resolve a *prefix or suffix* of a longer unresolved run, repeatedly,
  until either the whole run is resolved or no further known bridge fits what remains — the
  remainder (if any) falls back to today's anonymous-placeholder behavior, unchanged.
- Whois/DNS lookups work normally against inferred nodes (they carry real host strings, unlike
  `"???"`) — no special-casing needed there.

## Non-goals

- No unbounded historical scan. The lookup is capped to each candidate host's most recent N
  occurrences for the target (not full history, not a time window) — see Design for the exact
  mechanism and why.
- No change to the existing "both bounds match ⇒ safe to assume same anonymous unknown" behavior,
  the `maxStaleHops` kept-node selection, or the stale-connector edge *topology* (which nodes
  connect to which). This is strictly additive: a `"???"` gap that has no sole known bridge behaves
  exactly as it does today.
- No attempt to infer identity across *different* targets, even if they happen to share
  infrastructure — this stays entirely scoped to one target's own history, matching how the rest of
  `MapService.getMap` operates.
- No confidence score, no partial/fuzzy matching, no user-configurable confidence threshold. The bar
  is binary and fixed: exactly one distinct historical sequence, or no substitution.

## Design

### Bounded "known bridge" lookup

New backend index (schema is additive `CREATE TABLE/INDEX IF NOT EXISTS`, per this codebase's
migration-free convention):

```sql
CREATE INDEX IF NOT EXISTS idx_hops_host ON hops(host);
```

`hops` has no `target_id` column (only `run_id`, joined through `runs`), and no existing index
beyond the primary key — a per-request scan across a long-lived target's full history would be the
wrong cost model for a synchronous `/map` request. Capping to *the host's own most recent N
occurrences* (rather than a time window or a scan of `runs`) is both the cheapest query shape (an
indexed lookup on `hops.host`, `ORDER BY run_id DESC LIMIT N`, no separate "find the cutoff" query
needed) and the most semantically apt bound: it's "the last N times we've actually seen this host
anywhere," which self-adjusts to how often a given hop is even relevant, rather than an arbitrary
calendar window. `N = 20`, matching the order of magnitude of this codebase's existing
`MAX_RUN_HISTORY = 50` (`services/runs.ts`) convention for "recent enough to matter, capped so it
never grows unbounded."

```ts
const recentOccurrencesStmt = db.prepare(
  `SELECT h.run_id as runId, h.ttl FROM hops h
   JOIN runs r ON h.run_id = r.id
   WHERE r.target_id = ? AND h.host = ?
   ORDER BY h.run_id DESC LIMIT 20`,
);
```

### Matching a candidate continuation

For a near-bound host and a direction (forward from the left bound, or backward from the right
bound), and a maximum length (the remaining unresolved span), classify each of the host's recent
occurrences by walking `hopAtTtlStmt` (already exists in `map.ts`) step by step in that direction:

- **Exact**: reaches the *other* bound host within the max length → a full-gap match.
- **Prefix/suffix**: runs into another `"???"` before reaching the max length or the other bound →
  a partial match, usable to shrink the gap.
- **Dead end**: reaches the end of that run's recorded hops, or exceeds the max length, before
  either of the above → not usable from this occurrence.

Group the *usable* (exact or prefix/suffix) results by their exact sequence. A length is trustworthy
only if **all** usable occurrences at that length agree on the identical sequence — one dissenting
occurrence (a different real host in the same position) means "no known bridge," not "pick the most
recent one." This directly implements the confidence bar from the brainstorming discussion: sole
distinct match only, never best-effort/most-recent.

Prefer the longest trustworthy exact match; if none, the longest trustworthy prefix/suffix match.

### Resolution loop, replacing today's single fallback-to-anonymous step

Where `resolveThroughGap` currently only ever produces one anonymous synthetic chain per gap, it
now first tries substitution, repeatedly, before falling back:

```
remaining = the full gap (leftBound, rightBound, ttlSpan)
substituted = []
while remaining.span > 0:
  exact = findKnownBridge(remaining.leftBound, remaining.rightBound, remaining.span, forward)
  if exact found: substituted += exact; remaining = empty; break
  prefix = findKnownContinuation(remaining.leftBound, remaining.span, forward)
  if prefix found: substituted += prefix; remaining = shrink from the left by prefix.length; continue
  suffix = findKnownContinuation(remaining.rightBound, remaining.span, backward)
  if suffix found: substituted += suffix (prepended); remaining = shrink from the right by suffix.length; continue
  break  # nothing more matches
if remaining.span > 0:
  substituted += one shared anonymous placeholder chain for `remaining`, via the EXISTING
  gapKey/resolveGapChain mechanism, completely unchanged.
connect substituted (and/or the anonymous remainder) in TTL order between leftBound and rightBound.
```

This loop terminates because `remaining.span` strictly shrinks on every substitution and the loop
exits the moment nothing more matches — bounded by the gap's own (already small, TTL-limited) span,
not by history size.

### Node representation: `inferred` nodes

Substituted real hosts render through the same "ephemeral, not a real `path_nodes` row, positioned
by the layout engine's existing stale-stacking rule" pattern already used for anonymous synthetic
`"???"` nodes (`docs/superpowers/specs/2026-07-10-map-auto-layout-design.md`), with two differences:

- `host` is the real resolved hostname/IP, not `"???"`.
- A new `inferred: boolean` field on `MapNode` (default `false`; `true` only for these substituted
  nodes) — this is the signal the frontend uses to render the "not observed in this specific poll"
  marker, and is otherwise inert (doesn't affect layout, whois/DNS, or edge logic, all of which
  already key off `host`/`active`/`hasCustomPosition`, none of which change for this case).

Deterministic id scheme mirrors the existing synthetic-node ids (`synthetic:${key}:${ttl}`): use
`inferred:${sequenceKey}:${ttl}` so repeated resolutions of the same substituted bridge — across
separate `/map` requests, or multiple stale segments resolving into the same bridge in one request —
share the same node identity, exactly like today's anonymous-placeholder sharing.

### Frontend: visual marker

`HopNode.tsx` gets an `inferred` prop (from `HopNodeData`), rendering a dashed border on the node
box — reusing the same "dashed = not directly observed right now" visual language `MetricEdge`
already uses for stale connector edges (`strokeDasharray: '6 4'`), so the convention stays
consistent rather than introducing a new visual language. A short title/tooltip
("inferred from an earlier resolved path") documents what the dashing means on this specific node,
since the existing dashed-edge convention doesn't currently need one (edges are self-explanatory as
"historical connector"; a dashed *node* is a new enough pattern to warrant one line of
explanation).

### File structure

The matching logic (recent-occurrence lookup, continuation classification, sole-distinct-match
check) is a self-contained unit — it only needs a `Database` handle and the gap's bounds/span, no
access to `MapService`'s broader state (`keptRows`, `nodeByTtlHost`, etc.). It becomes a new class,
`BridgeInferenceService` in `backend/src/services/bridgeInference.ts`, mirroring this codebase's
existing pattern of one focused service per concern (e.g. `WhoisService`/`DnsService`) rather than
growing `map.ts` further. `MapService` constructs its own internally (`new
BridgeInferenceService(db)` in its constructor, same `db` handle it already holds) rather than
taking it as an external constructor parameter — none of `MapService`'s other internal query logic
is externally injected either, and `app.ts`'s wiring doesn't need to change.

## Testing

- `BridgeInferenceService` (new, `services/bridgeInference.test.ts`):
  - Exact match: two occurrences of `A → X → D` and `A → ??? → D` (bounded by the same A/D) →
    the `"???"` resolves to `X`, `inferred: true`.
  - No match (never seen): a `"???"` gap whose bounds have no historical real occurrence at all →
    unchanged, falls back to the existing anonymous placeholder.
  - Ambiguous, no match: two *different* real sequences observed between the same bounds at
    different times (simulating ECMP) → never substitutes, falls back to anonymous, even though
    each individual sequence was only seen once.
  - Prefix chaining: a known 2-hop bridge resolves the first two positions of a longer 3-position
    unknown run, leaving a 1-position remainder that itself falls back to an anonymous placeholder
    (no further match available) — reproducing the user's second example exactly.
  - Full chain resolution: a longer unknown run fully resolves through two consecutive known
    bridges with no anonymous remainder at all.
  - Recent-history bound: a matching sequence exists only *beyond* the 20-occurrence cap → not
    used (falls back to anonymous) — proving the bound is actually enforced, not just documented.
- Frontend:
  - `MapNode.inferred: true` renders the dashed-border marker on `HopNode`; `false`/absent does
    not.
  - Whois lookup is attempted normally (not short-circuited) for an inferred node, since its host
    passes `LOOKUPABLE_HOST` like any real IP.
