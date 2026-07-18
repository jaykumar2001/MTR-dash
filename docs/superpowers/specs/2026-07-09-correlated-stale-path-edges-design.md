# Historically-Correct Stale Path Edges — Design

## Problem

`MapService.getMap`'s stale-edge logic (added in the earlier stale-hop-nodes feature) connects
each stale node to whatever is *currently* active at its neighboring TTLs. This is correct when
exactly one hop changes in isolation, but wrong when two or more **adjacent** hops change in the
same poll.

Example: path `a - b - c - d` (TTL 1-4). A single poll reports `a - b' - c' - d` — TTL 2 and TTL 3
changed together, TTL 1 and TTL 4 didn't. Today's logic produces:

- stale `b` connects to `a` (correct) and to `c'` (**wrong** — `b` and `c'` were never adjacent on
  the wire, that pairing never existed)
- stale `c` connects to `b'` (**wrong**, same problem) and to `d` (correct)

The result draws phantom connections that never occurred, and loses the fact that `b — c` was a
real, coherent path segment that existed together and moved together as a unit.

## Goals

- When multiple adjacent hops change in the same poll, the stale path renders as the single
  coherent historical segment it actually was (`a — b — c — d`, fully dashed), not as fragments
  spliced onto today's live nodes.
- No new phantom edges: a stale edge is only ever drawn between two hosts that were actually
  observed adjacent to each other in some real poll.
- The live (solid) path is unaffected — it already only ever connects today's current active
  chain, which is correct by construction.

## Non-goals

- No schema changes. The `hops` table already stores a complete path snapshot per `run_id`; that
  existing data is the source of truth for "who was adjacent to whom, and when."
- Not reconstructing an arbitrary point-in-time view of the whole path (that's the existing
  deviation-timeline scrubber's job, via `DeviationsService.activeAt`) — this only concerns how
  the *live* map's stale connector edges are computed.
- `maxStaleHops` limiting (which stale nodes are kept/shown at all, per TTL) is unchanged. This
  design only changes what a kept stale node connects *to*, not which nodes get kept.

## Supersedes

The original stale-hop-nodes design explicitly declared "reconstructing the exact historical path
shape... not a historically accurate snapshot" a non-goal, on the reasoning that connecting to
today's current neighbors was simpler and correct for the common single-hop-change case. This
design reverses that call: the correlated-multi-hop-change case it didn't account for produces
visibly wrong edges, and the historically-correct approach turns out to be no more complex to
build.

## Design

### Algorithm

For each **kept** stale node `S` at `TTL=k` (the existing `maxStaleHops`-limited node set is
unchanged — this only changes how `S` gets connected):

1. Find `S`'s last-active run: `lastActiveRunId = MAX(h.run_id) FROM hops h JOIN runs r ON
   h.run_id = r.id WHERE r.target_id = ? AND h.ttl = k AND h.host = S.host` — the most recent poll
   where `S` was genuinely the live hop at that position, i.e. the poll immediately before the
   deviation that deactivated it.
2. In that *same* `run_id`, look up the host reported at `ttl = k - 1` and `ttl = k + 1` — these
   are `S`'s true historical neighbors (the "path as a function of time" read at that one instant),
   not whatever's active today.
3. For each side, resolve that neighbor host to a node to connect to:
   - the *current* active node at that TTL, if its host matches; else
   - another *kept* stale node at that TTL, if its host matches; else
   - omit that side entirely (its true neighbor isn't currently visible on the map — same
     graceful omission the existing "no active neighbor" case already does).
4. Draw the dashed/grey edge to whichever node that resolves to, deduped by edge id (two stale
   nodes that were each other's true neighbor will both resolve to the same edge; only draw it
   once).

`TTL = 1` keeps its existing hardcoded special case on the "previous" side: it always connects to
the synthetic source node (id `0`, representing the probing host itself), since there's no
historical variation for that endpoint — it's not a real `path_nodes`/`hops` entry.

### Worked example

Continuing `a - b - c - d → a - b' - c' - d`:

- Stale `b`'s last-active run has `ttl1=a, ttl3=c`. `a` matches the current active node at TTL 1
  → edge `a — b`. `c` doesn't match current (`c'` is active), but it matches the kept stale node
  at TTL 3 → edge `b — c`.
- Stale `c`'s last-active run is the same run, with `ttl2=b, ttl4=d`. `b` matches the kept stale
  node at TTL 2 → edge `b — c` (same edge as above, deduped). `d` matches current active → edge
  `c — d`.

Result: `a — b — c — d`, one continuous dashed path. The live chain `a — b' — c' — d` is built
exactly as it is today, unaffected by this change.

### Cost

Two small, indexed-by-nothing-new-but-bounded queries per *kept* stale node (bounded by
`maxStaleHops × TTL count`, not by total history size) — not a scan across all historical runs.
No new database indexes are being added as part of this change; if this ever becomes a measurable
cost at scale, that's a follow-up, not blocking here.

## Edge cases

- A stale node's true historical neighbor isn't currently visible (replaced by a newer deviation
  that bumped it out of the `maxStaleHops`-limited kept set, or was never re-observed): that side
  is simply omitted, same as today's existing "no active neighbor" behavior.
- A stale node's last-active run has no hop reported at the neighboring TTL at all (e.g. the
  destination was reached before that TTL, or that hop timed out in that specific poll): omit
  that side.
- Reactivation (a host goes active → stale → active again): `MAX(run_id)` naturally picks the most
  recent occurrence, consistent with how `maxStaleHops` already orders kept nodes by
  most-recently-deactivated.
- Single, isolated hop changes (today's already-working case) are unaffected: the stale node's
  last-active-run neighbors are, by definition, the same hosts as today's current active
  neighbors when nothing else changed — so existing single-hop-change tests are expected to keep
  passing unchanged.

## Testing

- New backend test: two adjacent TTLs deviate in the same run → both stale nodes end up connected
  to each other by a single stale edge, and each also connects correctly to its unchanged outer
  neighbor (the `a-b-c-d → a-b'-c'-d` scenario, asserting the edge set is exactly
  `{a--b, b--c, c--d}` dashed, plus the live `{a--b', b'--c', c'--d}` solid chain).
- New backend test: a stale node's true historical neighbor has since been bumped out of the kept
  set by `maxStaleHops` limiting — that side of its edge is omitted, not incorrectly pointed at
  today's current neighbor.
- Existing single-hop-change stale-edge tests are expected to keep passing without modification —
  confirming this change doesn't alter today's already-correct simple case.
