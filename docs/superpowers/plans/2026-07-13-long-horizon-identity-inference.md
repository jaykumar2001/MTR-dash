# Long-Horizon Identity Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `"???"` hops (including *active* ones, for the first time) to a specific real identity via a full-history unanimity fallback when the existing 20-sighting window finds nothing, collapsing duplicate active-`???`/stale-real twin boxes into one.

**Architecture:** A new `findSoleIdentityAtTtl` lookup on `BridgeInferenceService` (three DISTINCT queries over the target's full hop history, unanimity required at the TTL and both neighbors). `MapService.getMap` memoizes it per request and consults it as a fallback in the existing stale-`???` self-resolution loop, plus a brand-new pass over active `???` nodes that relabels in place and drops redundant stale twins via the existing `resolvedAwayNodeIds` mechanism.

**Tech Stack:** TypeScript (strict), better-sqlite3 (synchronous), vitest. Backend in `backend/`, frontend in `frontend/` — independent npm packages, always `cd` into the right one.

**Spec:** `docs/superpowers/specs/2026-07-13-long-horizon-identity-inference-design.md`

## Global Constraints

- Both packages use `strict: true` TypeScript; `npm run build` (tsc) and `npx vitest run` are the only checks — no lint/format tooling exists.
- Schema changes are additive only: `CREATE TABLE/INDEX IF NOT EXISTS` in `backend/src/db/schema.sql`; no migration framework.
- The `"???"` sentinel constant is `NO_REPLY_HOST` in both `map.ts` and `bridgeInference.ts` (each file has its own copy — keep it that way).
- Never mutate `rawHost` on a `MapNode` — relabeling changes `host` (display) only. History matching depends on `rawHost` staying the literal recorded value.
- Commit messages: imperative mood, no conventional-commit prefixes (match `git log`: "Add...", "Fix...", "Resolve..."), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All backend test commands run from `backend/`; frontend from `frontend/`.

---

### Task 1: `findSoleIdentityAtTtl` on BridgeInferenceService + supporting indexes

**Files:**
- Modify: `backend/src/db/schema.sql` (after line 36, `idx_hops_host`)
- Modify: `backend/src/services/bridgeInference.ts`
- Test: `backend/src/services/bridgeInference.test.ts`

**Interfaces:**
- Consumes: existing `hops`/`runs` tables; `NO_REPLY_HOST` constant already in `bridgeInference.ts`.
- Produces: `findSoleIdentityAtTtl(targetId: number, ttl: number): string | null` — public method on `BridgeInferenceService`. Task 2 and Task 3 call exactly this signature.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block inside the existing top-level `describe('BridgeInferenceService', ...)` in `backend/src/services/bridgeInference.test.ts` (the file already provides `db`, `service`, `targetId`, and the `insertRun` helper — reuse them):

```ts
  describe('findSoleIdentityAtTtl', () => {
    it('returns the sole identity when the ttl and both neighbors are unanimous', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBe('B');
    });

    it('returns null when two identities were ever recorded at the ttl, however recent the agreement', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'C' },
      ]);
      for (let i = 0; i < 30; i++) {
        insertRun(db, targetId, [
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'C' },
        ]);
      }

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('returns null when the ttl has zero real sightings ever', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('returns null when a neighboring ttl is not unanimous', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'Z' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('returns null past the end of the path (no right-bound evidence ever)', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('ignores ??? sightings at the neighbor ttls — they neither help nor veto', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: '???' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: '???' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBe('B');
    });

    it('scopes evidence to the given target', () => {
      const otherTarget = db.prepare('INSERT INTO targets (host) VALUES (?)').run('2.2.2.2')
        .lastInsertRowid as number;
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, otherTarget, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBe('B');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/bridgeInference.test.ts`
Expected: FAIL — `service.findSoleIdentityAtTtl is not a function` (7 new tests fail, all pre-existing tests pass).

- [ ] **Step 3: Implement the lookup and the indexes**

In `backend/src/db/schema.sql`, directly after the existing `idx_hops_host` line (line 36):

```sql
-- Speeds up the per-run "host at this ttl" lookup (hopAtTtlStmt in
-- services/map.ts and services/bridgeInference.ts) and the long-horizon
-- sole-identity scan (services/bridgeInference.ts).
CREATE INDEX IF NOT EXISTS idx_hops_run_ttl ON hops(run_id, ttl);

-- Speeds up per-target scans over runs (map queries, sole-identity lookup).
CREATE INDEX IF NOT EXISTS idx_runs_target_id ON runs(target_id);
```

In `backend/src/services/bridgeInference.ts`, add a prepared statement field and initialize it in the constructor (alongside the existing two):

```ts
  private distinctRealHostsAtTtlStmt: Database.Statement;
```

```ts
    // LIMIT 2: callers only distinguish zero / exactly-one / more-than-one.
    this.distinctRealHostsAtTtlStmt = this.db.prepare(
      `SELECT DISTINCT h.host as host FROM hops h
       JOIN runs r ON h.run_id = r.id
       WHERE r.target_id = ? AND h.ttl = ? AND h.host != ?
       LIMIT 2`,
    );
```

Add the public method and private helper after `findKnownContinuation`:

```ts
  /**
   * Sole real identity ever recorded at this exact ttl for the target, with
   * both neighboring ttls likewise unanimous — the long-horizon fallback
   * for hops whose identity evidence is older than the recent-occurrence
   * window (e.g. a router that answers probes a few minutes per day). Null
   * on zero real sightings (no evidence is not evidence) or two-plus
   * distinct identities at any of the three ttls — any historical
   * disagreement vetoes, permanently. The unbounded horizon is safe
   * because more history only makes unanimity harder to pass, never
   * easier. See
   * docs/superpowers/specs/2026-07-13-long-horizon-identity-inference-design.md.
   */
  findSoleIdentityAtTtl(targetId: number, ttl: number): string | null {
    const at = this.distinctRealHostsAtTtl(targetId, ttl);
    if (at.length !== 1) return null;
    if (this.distinctRealHostsAtTtl(targetId, ttl - 1).length !== 1) return null;
    if (this.distinctRealHostsAtTtl(targetId, ttl + 1).length !== 1) return null;
    return at[0];
  }

  private distinctRealHostsAtTtl(targetId: number, ttl: number): string[] {
    return (
      this.distinctRealHostsAtTtlStmt.all(targetId, ttl, NO_REPLY_HOST) as { host: string }[]
    ).map((r) => r.host);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/bridgeInference.test.ts`
Expected: PASS — all tests including the 7 new ones.

- [ ] **Step 5: Run the full backend suite + typecheck**

Run: `cd backend && npx vitest run && npm run build`
Expected: all tests pass (schema change must not break `db/client.test.ts`), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/schema.sql backend/src/services/bridgeInference.ts backend/src/services/bridgeInference.test.ts
git commit -m "Add long-horizon sole-identity lookup to BridgeInferenceService

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Sole-identity fallback in the stale-`???` self-resolution loop

**Files:**
- Modify: `backend/src/services/map.ts` (the self-resolution loop, currently lines ~495–552, and a new memoized helper just above it)
- Test: `backend/src/services/map.test.ts`

**Interfaces:**
- Consumes: `BridgeInferenceService.findSoleIdentityAtTtl(targetId: number, ttl: number): string | null` from Task 1.
- Produces: `soleIdentityAtTtl(ttl: number): string | null` — a request-scoped memoized closure inside `getMap`, declared immediately after `findRealBoundTtl`. Task 3 calls exactly this closure.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/services/map.test.ts` (inside the existing `describe('MapService', ...)`; `reportWithLoss`, `db`, `runs`, `map`, `targetId` all exist):

```ts
  it('resolves a stale ??? node via the long-horizon fallback when its evidence is older than the recent window', () => {
    // Identity evidence: one early run where ttl2=B and ttl3=C both answered
    // — the only real identities ever recorded at those ttls.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    // 21 runs with ttl2 AND ttl3 both silent: pushes the evidence run beyond
    // the 20-occurrence window anchored on A, and gives the (future) stale
    // ttl2 "???" node a "???" right-neighbor in its own snapshot, so the
    // windowed walked-bounds bridge needs a 2-hop proof it can't find.
    for (let i = 0; i < 21; i++) {
      runs.ingest(
        targetId,
        reportWithLoss([
          { ttl: 1, host: 'A', lossPct: 0 },
          { ttl: 2, host: '???', lossPct: 100 },
          { ttl: 3, host: '???', lossPct: 100 },
          { ttl: 4, host: 'D', lossPct: 0 },
        ]),
      );
    }
    // ttl2 recovers to B — the old ttl2 "???" goes stale; ttl3 stays "???".
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    // The stale ttl2 "???" resolves to B via full-history unanimity — and B
    // is the live active node there, so the stale box is dropped as
    // redundant rather than lingering as a bare "???" forever.
    const ttl2Nodes = result.nodes.filter((n) => n.ttl === 2);
    expect(ttl2Nodes).toHaveLength(1);
    expect(ttl2Nodes[0].host).toBe('B');
    expect(ttl2Nodes[0].active).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/map.test.ts -t 'long-horizon fallback when its evidence is older'`
Expected: FAIL — `expect(ttl2Nodes).toHaveLength(1)` receives length 2 (the stale `???` box survives unresolved).

- [ ] **Step 3: Add the memoized helper and restructure the loop**

In `backend/src/services/map.ts`, immediately after the `findRealBoundTtl` function (currently ends ~line 493), add:

```ts
    // Request-scoped memo for the full-history sole-identity fallback — the
    // lookup is deterministic within one getMap() call and multiple "???"
    // nodes can share a ttl. Steady-state maps with no "???" nodes never
    // execute it at all.
    const soleIdentityCache = new Map<number, string | null>();
    const soleIdentityAtTtl = (ttl: number): string | null => {
      if (!soleIdentityCache.has(ttl)) {
        soleIdentityCache.set(ttl, this.bridgeInference.findSoleIdentityAtTtl(targetId, ttl));
      }
      return soleIdentityCache.get(ttl)!;
    };
```

Then restructure the self-resolution loop body (currently lines ~495–552) so the windowed attempt produces a nullable `resolvedHost`, the fallback fills it, and the existing outcome logic is otherwise unchanged. The loop becomes:

```ts
    for (const [ttl, rows] of staleByTtl) {
      const kept = rows.filter((r) => keptStaleIds.has(r.id));
      for (const staleNode of kept) {
        if (staleNode.host !== NO_REPLY_HOST || ttl <= 1) continue;

        // Primary: the recent-window walked-bounds bridge, exactly as before.
        let resolvedHost: string | null = null;
        const ownLastActiveRunId = (
          lastActiveRunStmt.get(targetId, ttl, staleNode.host) as { runId: number | null }
        ).runId;
        if (ownLastActiveRunId !== null) {
          const left = findRealBoundTtl(ownLastActiveRunId, ttl, -1);
          const right = findRealBoundTtl(ownLastActiveRunId, ttl, 1);
          if (left && right && isRealHost(left.host) && isRealHost(right.host)) {
            const bridge = this.bridgeInference.findExactBridge(
              targetId,
              left.host,
              right.host,
              right.ttl - left.ttl - 1,
              1,
            );
            if (bridge) resolvedHost = bridge[ttl - left.ttl - 1];
          }
        }
        // Fallback: full-history sole-identity. Strictly stricter on
        // identity count than any window, so falling back unconditionally
        // on null is safe — recent ECMP disagreement implies >=2 identities
        // in full history, which refuses on its own.
        if (resolvedHost === null) resolvedHost = soleIdentityAtTtl(ttl);
        if (resolvedHost === null) continue;

        const existingId = nodeByTtlHost.get(`${ttl}:${resolvedHost}`);
        const existingNode = existingId !== undefined ? nodeById.get(existingId) : undefined;
        if (existingId !== undefined && existingId !== staleNode.id && existingNode) {
          if (existingNode.active) {
            resolvedAwayNodeIds.add(staleNode.id);
          } else {
            // Coincides with another kept STALE node rather than the
            // live active one, so the live edges don't already cover
            // it — keep this as its own box (merging it into the
            // other node's edges risks ambiguous duplication), but
            // still label it with the resolved identity instead of a
            // bare "???" now that it's known. Leave nodeByTtlHost's
            // `${ttl}:${resolvedHost}` entry pointed at the other,
            // already-registered node — that key already has an
            // owner.
            const nodeEntry = nodeById.get(staleNode.id);
            if (nodeEntry) {
              nodeEntry.host = resolvedHost;
              nodeEntry.inferred = true;
            }
          }
        } else if (existingId === undefined) {
          const nodeEntry = nodeById.get(staleNode.id);
          if (nodeEntry) {
            nodeEntry.host = resolvedHost;
            nodeEntry.inferred = true;
          }
          nodeByTtlHost.set(`${ttl}:${resolvedHost}`, staleNode.id);
        }
      }
    }
```

Note the guard flips from a wrapping `if (staleNode.host === NO_REPLY_HOST && ttl > 1) { ... }` to an early `continue` — the outcome logic (everything from `const existingId =` down) is byte-for-byte the code that already exists; only the evidence-gathering above it changes. The big explanatory comment block above `resolvedAwayNodeIds` (lines ~459–473) stays where it is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: PASS — the new test and all pre-existing map tests (the restructure must not change any existing outcome).

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/map.ts backend/src/services/map.test.ts
git commit -m "Fall back to sole-identity evidence for stale ??? self-resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Active-`???` resolution pass with twin collapse

**Files:**
- Modify: `backend/src/services/map.ts` (new pass between the stale self-resolution loop and the stale-edge loop)
- Test: `backend/src/services/map.test.ts`

**Interfaces:**
- Consumes: `soleIdentityAtTtl(ttl)` closure from Task 2; `findRealBoundTtl`, `lastActiveRunStmt`, `isRealHost`, `nodeByTtlHost`, `nodeById`, `resolvedAwayNodeIds`, `activeByTtl` — all already in `getMap` scope.
- Produces: active `MapNode`s may now carry `inferred: true` with `host` ≠ `rawHost`. The stale-edge loop's existing `!resolvedAwayNodeIds.has(r.id)` filter and the final `nodes.filter(...)` handle dropped twins with no further changes.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/services/map.test.ts`:

```ts
  it('relabels an active ??? node with its sole historical identity and drops the redundant stale twin', () => {
    // Evidence: one early run where ttl2 identified as B.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 goes silent and stays silent for 22 runs — far beyond the
    // 20-occurrence window anchored on its ever-responsive neighbors. The
    // live path now shows "???" at ttl2, with stale twin B kept alongside.
    for (let i = 0; i < 22; i++) {
      runs.ingest(
        targetId,
        reportWithLoss([
          { ttl: 1, host: 'A', lossPct: 0 },
          { ttl: 2, host: '???', lossPct: 100 },
          { ttl: 3, host: 'C', lossPct: 0 },
        ]),
      );
    }

    const result = map.getMap(targetId);
    const ttl2Nodes = result.nodes.filter((n) => n.ttl === 2);
    expect(ttl2Nodes).toHaveLength(1);
    const merged = ttl2Nodes[0];
    expect(merged.host).toBe('B');
    expect(merged.active).toBe(true);
    expect(merged.inferred).toBe(true);
    expect(merged.rawHost).toBe('???');

    // No dangling edges to the dropped twin; live edges route through the
    // relabeled node with their metrics intact.
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    for (const e of result.edges) {
      if (e.source !== 0) expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeC = result.nodes.find((n) => n.host === 'C')!;
    expect(
      result.edges.some((e) => !e.stale && e.source === nodeA.id && e.target === merged.id),
    ).toBe(true);
    expect(
      result.edges.some((e) => !e.stale && e.source === merged.id && e.target === nodeC.id),
    ).toBe(true);
  });

  it('does not relabel an active ??? node when a second identity exists anywhere in history', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'X', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const activeTtl2 = result.nodes.find((n) => n.ttl === 2 && n.active)!;
    expect(activeTtl2.host).toBe('???');
    expect(activeTtl2.inferred).toBe(false);
  });

  it('relabels an active ??? node in place when no stale twin exists (maxStaleHops=0)', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 0 WHERE id = ?').run(targetId);
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const ttl2Nodes = result.nodes.filter((n) => n.ttl === 2);
    expect(ttl2Nodes).toHaveLength(1);
    expect(ttl2Nodes[0].host).toBe('B');
    expect(ttl2Nodes[0].active).toBe(true);
    expect(ttl2Nodes[0].inferred).toBe(true);
  });
```

(The first test exercises the long-horizon fallback path for active nodes — the motivating TTL 13 regression. The third exercises the recent-window path for active nodes: with only two runs, `findExactBridge(A, C, 1, 1)` succeeds from the window, proving both evidence sources feed the same relabel logic.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/map.test.ts -t 'active ???'`
Expected: FAIL — first test: `ttl2Nodes` has length 2 and the active node's host is `'???'`; third test: host is `'???'`. Second test may already pass (nothing resolves) — that's fine, it's the guard-rail.

- [ ] **Step 3: Implement the active pass**

In `backend/src/services/map.ts`, insert between the stale self-resolution loop and the stale-edge loop (i.e. immediately before the second `for (const [ttl, rows] of staleByTtl) {` whose filter includes `!resolvedAwayNodeIds.has(r.id)`):

```ts
    // The live path itself can be showing "???" at a ttl — the steady state
    // for a router that rarely answers probes. When identity inference
    // (recent window first, then the full-history sole-identity fallback)
    // can name it, the active node is relabeled in place. Display-only:
    // rawHost keeps the literal "???" so deviation history and the timeline
    // scrubber still match what was actually recorded. A kept stale twin
    // already carrying that identity at this ttl becomes redundant — its
    // dashed edges would connect the exact neighbors the live edges already
    // connect — so it is dropped, and ${ttl}:${host} lookups repoint to the
    // surviving active node so later stale-edge resolution never references
    // the dropped twin.
    for (const [ttl, activeRow] of activeByTtl) {
      if (activeRow.host !== NO_REPLY_HOST || ttl <= 1) continue;

      let resolvedHost: string | null = null;
      const latestSightingRunId = (
        lastActiveRunStmt.get(targetId, ttl, activeRow.host) as { runId: number | null }
      ).runId;
      if (latestSightingRunId !== null) {
        const left = findRealBoundTtl(latestSightingRunId, ttl, -1);
        const right = findRealBoundTtl(latestSightingRunId, ttl, 1);
        if (left && right && isRealHost(left.host) && isRealHost(right.host)) {
          const bridge = this.bridgeInference.findExactBridge(
            targetId,
            left.host,
            right.host,
            right.ttl - left.ttl - 1,
            1,
          );
          if (bridge) resolvedHost = bridge[ttl - left.ttl - 1];
        }
      }
      if (resolvedHost === null) resolvedHost = soleIdentityAtTtl(ttl);
      if (resolvedHost === null) continue;

      const twinId = nodeByTtlHost.get(`${ttl}:${resolvedHost}`);
      if (twinId !== undefined && twinId !== activeRow.id) {
        resolvedAwayNodeIds.add(twinId);
      }
      const nodeEntry = nodeById.get(activeRow.id);
      if (nodeEntry) {
        nodeEntry.host = resolvedHost;
        nodeEntry.inferred = true;
      }
      nodeByTtlHost.set(`${ttl}:${resolvedHost}`, activeRow.id);
    }
```

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && npx vitest run`
Expected: PASS — all three new tests and every pre-existing test. Pay particular attention to the existing "resolves a standalone stale ??? node…" and "labels a resolved stale ??? node…" tests: the active pass must not change their outcomes.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/map.ts backend/src/services/map.test.ts
git commit -m "Resolve active ??? nodes and collapse duplicate stale twins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend active+inferred rendering test and README documentation

**Files:**
- Test: `frontend/src/components/NetworkMap.test.tsx`
- Modify: `README.md` (the "Path history and unresolved-hop resolution" section)

**Interfaces:**
- Consumes: `MapNode.inferred?: boolean` and `MapNode.rawHost?: string` from `frontend/src/types.ts` (both already exist). `HopNode` already composes `active`/`inferred` CSS classes — this task proves it and documents the feature; no component change is expected.

- [ ] **Step 1: Write the rendering test**

Append to `frontend/src/components/NetworkMap.test.tsx`, next to the existing rawHost/historyActive tests (reuse the existing `mapData` fixture and imports):

```tsx
  it('renders both active styling and the inferred marker on an active inferred node', () => {
    const inferredActiveMapData: MapResult = {
      ...mapData,
      nodes: [
        { id: 1, ttl: 1, host: '10.0.0.1', rawHost: '???', active: true, inferred: true, x: 0, y: 0 },
      ],
    };
    render(<NetworkMap targetId={1} mapData={inferredActiveMapData} />);
    const hostEl = screen.getByText('10.0.0.1');
    const nodeEl = hostEl.closest('.hop-node');
    expect(nodeEl).toHaveClass('active');
    expect(nodeEl).toHaveClass('inferred');
    expect(nodeEl).not.toHaveClass('inactive');
  });
```

- [ ] **Step 2: Run the test**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: PASS — `HopNode` already renders `hop-node active inferred` (class composition is unconditional) and `.hop-node.inferred` in `styles.css` is not gated on `.inactive`. If it FAILS, fix `HopNode.tsx`'s className template so `inferred` appends independently of the `active`/`inactive` choice — do not gate one on the other.

- [ ] **Step 3: Add the README paragraphs**

In `README.md`, after the "A stale node's own identity can be inferred too" subsection (before "## Quick start"), add:

```markdown
### Long-horizon fallback and live "???" hops

Both inference forms above consult a bounded recent window (each anchor host's last 20
sightings). Some routers answer probes so rarely that their identity evidence is always older
than any recent window — seen for a couple of minutes a few times a day, silent otherwise. For
those, a stricter long-horizon fallback kicks in when the window finds nothing: if this target's
**entire history** shows exactly one real identity ever recorded at that hop position, and the
positions on both sides are likewise unanimous, that identity is used. The unbounded look-back is
safe precisely because it demands unanimity — more history only makes the bar harder to pass, and
any route change or ECMP disagreement ever recorded vetoes the substitution permanently.

This fallback also lets the **live** path benefit: an active hop currently showing `"???"` (the
steady state for a rate-limited router) is relabeled in place with its inferred identity — marked
inferred, exactly like substituted historical hops — and a superseded stale copy of the same
identity at the same position is dropped rather than drawn as a duplicate box. The relabeling is
display-only: deviation history and the timeline scrubber keep matching the raw `"???"` that was
actually recorded.
```

- [ ] **Step 4: Run both full suites + builds**

Run: `cd frontend && npx vitest run && npm run build`
Expected: all frontend tests pass, tsc + vite clean.
Run: `cd backend && npx vitest run && npm run build`
Expected: unchanged, all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/NetworkMap.test.tsx README.md
git commit -m "Test active inferred hop rendering and document long-horizon fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
