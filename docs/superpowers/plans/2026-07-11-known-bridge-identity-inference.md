# Known-Bridge Identity Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `"???"` gap is bounded by two known real hosts that have exactly one distinct real intermediate sequence ever observed connecting them (within recent history), substitute that specific real identity — marked as inferred — instead of an anonymous shared placeholder. Chain this across a longer unresolved run via known prefix/suffix bridges, repeating until nothing more matches; any true remainder still falls back to today's anonymous-placeholder behavior unchanged.

**Architecture:** A new, independently-testable `BridgeInferenceService` (backend/src/services/bridgeInference.ts) does the historical matching (bounded to each candidate host's most recent 20 occurrences, backed by a new index). `MapService.getMap`'s existing gap-resolution loop (backend/src/services/map.ts) calls it before falling back to the existing anonymous-synthetic-node mechanism, via a new recursive `resolveGapSpan` that tries an exact bridge, then a prefix, then a suffix, recursing on whatever's left. A resolved real host that's already a kept, independently-tracked node is reused as-is (not duplicated); otherwise a new node is synthesized with a `inferred: true` flag. The frontend renders `inferred` nodes with a distinct dashed border and tooltip.

**Tech Stack:** TypeScript, `better-sqlite3`, Vitest, React Flow.

## Global Constraints

- No change to the existing "both bounds match ⇒ share one anonymous placeholder" behavior for gaps with no known bridge — this is strictly additive.
- No change to `maxStaleHops` selection or stale-connector edge topology (which nodes connect to which) beyond what a bridge match introduces in place of an anonymous placeholder.
- Substitution requires **exactly one** distinct historical real sequence between the two bounds within the lookback window — any disagreement (2+ distinct sequences) or absence of data means no substitution, ever.
- Lookback is capped to each candidate host's most recent 20 occurrences for the target (not full history, not a time window).
- Design doc: `docs/superpowers/specs/2026-07-11-known-bridge-identity-inference-design.md`

---

### Task 1: Backend — `BridgeInferenceService`

**Files:**
- Modify: `backend/src/db/schema.sql`
- Create: `backend/src/services/bridgeInference.ts`
- Test: `backend/src/services/bridgeInference.test.ts`

**Interfaces:**
- Produces: `class BridgeInferenceService { constructor(db: Database.Database); findExactBridge(targetId: number, nearHost: string, farHost: string, exactLen: number, direction: 1 | -1): string[] | null; findKnownContinuation(targetId: number, nearHost: string, maxLen: number, direction: 1 | -1): string[] | null; }`. Both methods return the matched hosts in `direction` order (i.e. near-to-far relative to the search direction — the caller reverses if it needs ascending-TTL order for a backward search). Consumed by Task 2.
- This service only needs a `Database.Database` handle — no dependency on `MapService`'s internals.

- [ ] **Step 1: Add the index**

In `backend/src/db/schema.sql`, add this block immediately after the `hops` table definition (right after its closing `);`, before the `path_nodes` table):

```sql
-- Speeds up BridgeInferenceService's "find this target's recent occurrences
-- of a given host" lookup (services/bridgeInference.ts) — otherwise a full
-- table scan on every gap resolution for a long-lived target.
CREATE INDEX IF NOT EXISTS idx_hops_host ON hops(host);
```

- [ ] **Step 2: Write the failing tests**

Create `backend/src/services/bridgeInference.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { BridgeInferenceService } from './bridgeInference.js';

interface HopSpec {
  ttl: number;
  host: string;
}

function insertRun(db: Database.Database, targetId: number, hops: HopSpec[]): number {
  const runId = db
    .prepare(
      `INSERT INTO runs (target_id, started_at, finished_at, status) VALUES (?, datetime('now'), datetime('now'), 'ok')`,
    )
    .run(targetId).lastInsertRowid as number;
  const insertHop = db.prepare(
    `INSERT INTO hops (run_id, ttl, host, loss_pct, snt, last, avg, best, wrst, stdev)
     VALUES (?, ?, ?, 0, 10, 1, 1, 1, 1, 0)`,
  );
  for (const h of hops) insertHop.run(runId, h.ttl, h.host);
  return runId;
}

describe('BridgeInferenceService', () => {
  let db: Database.Database;
  let service: BridgeInferenceService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new BridgeInferenceService(db);
    targetId = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1')
      .lastInsertRowid as number;
  });

  describe('findExactBridge', () => {
    it('finds the sole known real bridge between two hosts', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toEqual(['X']);
    });

    it('finds a multi-hop bridge', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'Y' },
        { ttl: 4, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 2, 1)).toEqual(['X', 'Y']);
    });

    it('returns null when no occurrence connects the two hosts', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toBeNull();
    });

    it('returns null when two different real sequences have been observed (ECMP-like ambiguity)', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'D' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'Y' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toBeNull();
    });

    it('works in the backward direction', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'D', 'A', 1, -1)).toEqual(['X']);
    });

    it("only considers the near host's most recent 20 occurrences, ignoring older disagreeing data", () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'OLD' },
        { ttl: 3, host: 'D' },
      ]);
      for (let i = 0; i < 20; i++) {
        insertRun(db, targetId, [
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'X' },
          { ttl: 3, host: 'D' },
        ]);
      }

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toEqual(['X']);
    });
  });

  describe('findKnownContinuation', () => {
    it('finds the sole known continuation that runs into another unknown hop', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'Y' },
        { ttl: 4, host: '???' },
      ]);

      expect(service.findKnownContinuation(targetId, 'A', 2, 1)).toEqual(['X', 'Y']);
    });

    it('returns null when occurrences disagree on the continuation', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: '???' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'Z' },
        { ttl: 3, host: '???' },
      ]);

      expect(service.findKnownContinuation(targetId, 'A', 1, 1)).toBeNull();
    });

    it('returns null when no occurrence of the near host exists at all', () => {
      expect(service.findKnownContinuation(targetId, 'NOPE', 2, 1)).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/services/bridgeInference.test.ts`
Expected: FAIL — `src/services/bridgeInference.ts` doesn't exist yet (module not found).

- [ ] **Step 4: Implement `BridgeInferenceService`**

Create `backend/src/services/bridgeInference.ts`:

```ts
import type Database from 'better-sqlite3';

const NO_REPLY_HOST = '???';
const RECENT_OCCURRENCE_LIMIT = 20;

interface Occurrence {
  runId: number;
  ttl: number;
}

/**
 * Finds a specific, real identity for a "???" gap when exactly one distinct
 * real intermediate sequence has ever connected the gap's two bounding hosts
 * in this target's recent history — never a best-effort/most-recent guess,
 * since a wrong specific guess is worse than an honest "unknown" (e.g. under
 * ECMP/load-balanced routing, different times can genuinely take different
 * real paths between the same two endpoints).
 *
 * Lookback is capped to each host's most recent RECENT_OCCURRENCE_LIMIT
 * appearances for the target (not full history, not a time window) — see
 * docs/superpowers/specs/2026-07-11-known-bridge-identity-inference-design.md.
 */
export class BridgeInferenceService {
  private recentOccurrencesStmt: Database.Statement;
  private hopAtTtlStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.recentOccurrencesStmt = this.db.prepare(
      `SELECT h.run_id as runId, h.ttl as ttl FROM hops h
       JOIN runs r ON h.run_id = r.id
       WHERE r.target_id = ? AND h.host = ?
       ORDER BY h.run_id DESC LIMIT ?`,
    );
    this.hopAtTtlStmt = this.db.prepare('SELECT host FROM hops WHERE run_id = ? AND ttl = ?');
  }

  private recentOccurrences(targetId: number, host: string): Occurrence[] {
    return this.recentOccurrencesStmt.all(
      targetId,
      host,
      RECENT_OCCURRENCE_LIMIT,
    ) as Occurrence[];
  }

  private hopAt(runId: number, ttl: number): string | undefined {
    const row = this.hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
    return row?.host;
  }

  /**
   * Sole distinct real sequence of exactly `exactLen` hosts connecting
   * `nearHost` to `farHost` (in `direction`), if this target's recent
   * history shows exactly one such sequence; null if zero or if occurrences
   * disagree.
   */
  findExactBridge(
    targetId: number,
    nearHost: string,
    farHost: string,
    exactLen: number,
    direction: 1 | -1,
  ): string[] | null {
    const occurrences = this.recentOccurrences(targetId, nearHost);
    const distinct = new Map<string, string[]>();

    for (const occ of occurrences) {
      const hosts: string[] = [];
      let ttl = occ.ttl;
      let ok = true;
      for (let i = 0; i < exactLen; i++) {
        ttl += direction;
        const host = this.hopAt(occ.runId, ttl);
        if (host === undefined || host === NO_REPLY_HOST) {
          ok = false;
          break;
        }
        hosts.push(host);
      }
      if (!ok) continue;
      const finalHost = this.hopAt(occ.runId, ttl + direction);
      if (finalHost !== farHost) continue;
      distinct.set(JSON.stringify(hosts), hosts);
    }

    if (distinct.size !== 1) return null;
    return distinct.values().next().value as string[];
  }

  /**
   * Sole distinct real sequence starting at `nearHost` (in `direction`), up
   * to `maxLen` hosts — stopping early if it hits another "???" (a
   * confirmed boundary), or using the full `maxLen` if it doesn't. Null if
   * no occurrence has any real data, or if occurrences disagree.
   */
  findKnownContinuation(
    targetId: number,
    nearHost: string,
    maxLen: number,
    direction: 1 | -1,
  ): string[] | null {
    const occurrences = this.recentOccurrences(targetId, nearHost);
    let matched: string[] | null = null;
    let matchedKey: string | null = null;

    for (const occ of occurrences) {
      const hosts: string[] = [];
      let ttl = occ.ttl;
      let deadEnd = false;
      for (let i = 0; i < maxLen; i++) {
        ttl += direction;
        const host = this.hopAt(occ.runId, ttl);
        if (host === undefined) {
          deadEnd = true;
          break;
        }
        if (host === NO_REPLY_HOST) break;
        hosts.push(host);
      }
      if (deadEnd || hosts.length === 0) continue;
      const key = JSON.stringify(hosts);
      if (matchedKey === null) {
        matchedKey = key;
        matched = hosts;
      } else if (key !== matchedKey) {
        return null;
      }
    }

    return matched;
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd backend && npx vitest run src/services/bridgeInference.test.ts`
Expected: all tests PASS.

Run: `cd backend && npm test`
Expected: all tests PASS.

Run: `cd backend && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/schema.sql backend/src/services/bridgeInference.ts backend/src/services/bridgeInference.test.ts
git commit -m "$(cat <<'EOF'
Add BridgeInferenceService for known-bridge identity matching

Standalone, independently-tested service: given two bounding hosts,
finds whether this target's recent history shows exactly one distinct
real sequence connecting them (an exact bridge), or exactly one real
continuation before running into another unknown hop (a prefix/suffix
match) - never a best-effort guess when occurrences disagree. Not
wired into MapService yet.
EOF
)"
```

---

### Task 2: Backend — wire bridge inference into `MapService`'s gap resolution

**Files:**
- Modify: `backend/src/services/map.ts`
- Test: `backend/src/services/map.test.ts`

**Interfaces:**
- Consumes: `BridgeInferenceService` from Task 1.
- Produces: `MapNode.inferred: boolean` (required) — `true` only for a bridge-substituted node; `false` everywhere else (real active/stale nodes, anonymous synthetic nodes).

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/services/map.test.ts`, inside the existing `describe('MapService', ...)` block, anywhere after the `beforeEach`:

```ts
  it('reuses an existing kept real node instead of creating a duplicate when the resolved host is already tracked', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'X', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const staleX = result.nodes.find((n) => n.host === 'X')!;

    expect(staleX.inferred).toBe(false);
    expect(typeof staleX.id).toBe('number');
    expect(
      result.edges.some((e) => e.stale && e.source === staleB.id && e.target === staleX.id),
    ).toBe(true);
  });

  it('substitutes a specific real identity for a ??? gap when exactly one known bridge connects its bounds', () => {
    // Bridge evidence at an unrelated ttl range, so it never becomes a kept
    // node in its own right — BridgeInferenceService matches purely on host
    // string, not ttl, so it's still found via recent-history lookup.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'B', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const nodeD = result.nodes.find((n) => n.host === 'D' && n.ttl === 4)!;
    const inferredNode = result.nodes.find((n) => n.host === 'X' && n.ttl === 3)!;

    expect(inferredNode).toBeDefined();
    expect(inferredNode.inferred).toBe(true);
    expect(inferredNode.active).toBe(false);
    expect(
      result.edges.some((e) => e.stale && e.source === staleB.id && e.target === inferredNode.id),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.stale && e.source === inferredNode.id && e.target === nodeD.id),
    ).toBe(true);
  });

  it('does not substitute when recent history shows two different real bridges (ECMP-like ambiguity)', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'B', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 31, host: 'B', lossPct: 0 },
        { ttl: 32, host: 'Y', lossPct: 0 },
        { ttl: 33, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const edgeFromB = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    const target = result.nodes.find((n) => n.id === edgeFromB.target)!;

    expect(target.host).toBe('???');
    expect(target.inferred).toBe(false);
  });

  it('resolves a known prefix of a longer unresolved run, leaving the true remainder as an anonymous placeholder', () => {
    // Bridge evidence: B is followed by X, Y, then another unknown hop.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'B', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'Y', lossPct: 0 },
        { ttl: 24, host: '???', lossPct: 100 },
      ]),
    );
    // The live path: a 3-hop unresolved run bounded by B and D.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: '???', lossPct: 100 },
        { ttl: 6, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: '???', lossPct: 100 },
        { ttl: 6, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const nodeD = result.nodes.find((n) => n.host === 'D' && n.ttl === 6)!;
    const inferredX = result.nodes.find((n) => n.host === 'X' && n.ttl === 3)!;
    const inferredY = result.nodes.find((n) => n.host === 'Y' && n.ttl === 4)!;
    const remainder = result.nodes.find((n) => n.host === '???' && n.ttl === 5 && !n.active)!;

    expect(inferredX.inferred).toBe(true);
    expect(inferredY.inferred).toBe(true);
    expect(remainder.inferred).toBe(false);

    const staleEdges = result.edges.filter((e) => e.stale);
    expect(staleEdges.some((e) => e.source === staleB.id && e.target === inferredX.id)).toBe(true);
    expect(staleEdges.some((e) => e.source === inferredX.id && e.target === inferredY.id)).toBe(
      true,
    );
    expect(staleEdges.some((e) => e.source === inferredY.id && e.target === remainder.id)).toBe(
      true,
    );
    expect(staleEdges.some((e) => e.source === remainder.id && e.target === nodeD.id)).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/services/map.test.ts -t "known bridge"`
Run: `cd backend && npx vitest run src/services/map.test.ts -t "resolved host is already tracked"`
Run: `cd backend && npx vitest run src/services/map.test.ts -t "ECMP-like ambiguity"`
Run: `cd backend && npx vitest run src/services/map.test.ts -t "known prefix"`
Expected: all FAIL — `n.inferred` is `undefined` (not `false`/`true` as asserted), since `MapNode` has no `inferred` field yet and no bridge-matching logic exists.

- [ ] **Step 3: Add `inferred` to `MapNode` and wire in `BridgeInferenceService`**

In `backend/src/services/map.ts`, add the import at the top:

```ts
import { BridgeInferenceService } from './bridgeInference.js';
```

Add `inferred: boolean;` to the `MapNode` interface:

```ts
export interface MapNode {
  id: number | string;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
  hasCustomPosition: boolean;
  inferred: boolean;
}
```

Change the constructor and add a field:

```ts
export class MapService {
  private bridgeInference: BridgeInferenceService;

  constructor(private db: Database.Database) {
    this.bridgeInference = new BridgeInferenceService(db);
  }
```

In the main node-construction block, add `inferred: false,`:

```ts
    const nodes: MapNode[] = keptRows.map((n, idx) => {
      const custom = positions.get(n.id);
      const pos = custom ?? { x: idx * 220, y: n.active ? 0 : 140 };
      return {
        id: n.id,
        ttl: n.ttl,
        host: n.host,
        active: n.active === 1,
        x: pos.x,
        y: pos.y,
        hasCustomPosition: custom !== undefined,
        inferred: false,
      };
    });
```

- [ ] **Step 4: Replace the stale-connector section**

Find the block starting at `const NO_REPLY_HOST = '???';` and ending at the `nodes.push(...syntheticNodesById.values());` line (just before `return { nodes, edges };`). Replace that whole block with:

```ts
    const NO_REPLY_HOST = '???';
    const SOURCE_HOST = ' source';

    const nodeByTtlHost = new Map<string, number>();
    for (const n of keptRows) {
      nodeByTtlHost.set(`${n.ttl}:${n.host}`, n.id);
    }

    const lastActiveRunStmt = this.db.prepare(
      `SELECT MAX(h.run_id) as runId FROM hops h
       JOIN runs r ON h.run_id = r.id
       WHERE r.target_id = ? AND h.ttl = ? AND h.host = ?`,
    );
    const hopAtTtlStmt = this.db.prepare('SELECT host FROM hops WHERE run_id = ? AND ttl = ?');

    const addedStaleEdgeIds = new Set<string>();
    const syntheticNodesById = new Map<string, MapNode>();
    const inferredNodesById = new Map<string, MapNode>();
    const gapChainCache = new Map<string, (number | string)[]>();

    const connectStale = (source: number | string, target: number | string) => {
      const id = `${source}-${target}`;
      if (addedStaleEdgeIds.has(id)) return;
      addedStaleEdgeIds.add(id);
      edges.push({ id, source, target, color: 'grey', stale: true });
    };

    interface GapWalk {
      ttls: number[]; // ascending ttl order
      boundBeforeHost: string | null; // real host (or SOURCE_HOST) just before ttls[0]; null if unresolved
      boundAfterHost: string | null; // real host just after ttls[last]; null if unresolved
    }

    // A gap's anchor is always a real path_node, but its own host can itself
    // be NO_REPLY_HOST (a "???" hop can go stale just like any other, e.g.
    // once a real host starts responding at that TTL). When that happens,
    // the anchor's own identity alone isn't a safe merge-key bound — walk
    // further, past the anchor, in `direction` to find the real host (or
    // SOURCE_HOST) that truly bounds this side of the gap. This is what lets
    // the same recurring gap (bounded by the same real hosts on both true
    // ends) be recognized as identical across separate occurrences even when
    // the specific node resolving it is itself an unresolved hop, instead of
    // falling back to a run-scoped token that can never match anything else.
    const findBound = (
      runId: number,
      fromTtl: number,
      fromHost: string,
      direction: 1 | -1,
    ): string | null => {
      if (fromHost !== NO_REPLY_HOST) return fromHost;
      let ttl = fromTtl + direction;
      for (;;) {
        if (direction === -1 && ttl === 0) return SOURCE_HOST;
        const hop = hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
        if (!hop) return null;
        if (hop.host !== NO_REPLY_HOST) return hop.host;
        ttl += direction;
      }
    };

    const walkGap = (
      runId: number,
      nodeTtl: number,
      nodeHost: string,
      direction: 1 | -1,
    ): GapWalk | null => {
      const ttls: number[] = [];
      let ttl = nodeTtl + direction;
      let farHost: string | null = null;
      for (;;) {
        if (direction === -1 && ttl === 0) {
          farHost = SOURCE_HOST;
          break;
        }
        const hop = hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
        if (!hop) {
          farHost = null;
          break;
        }
        if (hop.host !== NO_REPLY_HOST) {
          farHost = hop.host;
          break;
        }
        ttls.push(ttl);
        ttl += direction;
      }
      if (ttls.length === 0) return null;
      ttls.sort((a, b) => a - b);
      const anchorHost = findBound(runId, nodeTtl, nodeHost, direction === 1 ? -1 : 1);
      return direction === 1
        ? { ttls, boundBeforeHost: anchorHost, boundAfterHost: farHost }
        : { ttls, boundBeforeHost: farHost, boundAfterHost: anchorHost };
    };

    const gapKey = (span: GapWalk, runId: number): string => {
      const ttlStart = span.ttls[0];
      const ttlEnd = span.ttls[span.ttls.length - 1];
      const before = span.boundBeforeHost ?? `run:${runId}`;
      const after = span.boundAfterHost ?? `run:${runId}`;
      return `${ttlStart}-${ttlEnd}|${before}|${after}`;
    };

    const resolveGapChain = (span: GapWalk, runId: number): (number | string)[] => {
      const key = gapKey(span, runId);
      const cached = gapChainCache.get(key);
      if (cached) return cached;
      const chainIds = span.ttls.map((ttl) => `synthetic:${key}:${ttl}`);
      span.ttls.forEach((ttl, i) => {
        syntheticNodesById.set(chainIds[i], {
          id: chainIds[i],
          ttl,
          host: NO_REPLY_HOST,
          active: false,
          x: ttl * 220,
          y: 140,
          hasCustomPosition: false,
          inferred: false,
        });
      });
      gapChainCache.set(key, chainIds);
      return chainIds;
    };

    // A gap bounded by two real, known hosts can sometimes be resolved to a
    // *specific* identity — not just an anonymous shared placeholder — when
    // this target's recent history shows exactly one distinct real sequence
    // ever connecting those same two hosts. Disagreement between historical
    // occurrences (e.g. ECMP/load-balanced routing) means no substitution,
    // ever — an anonymous "unknown" is always safer than a specific wrong
    // guess. See
    // docs/superpowers/specs/2026-07-11-known-bridge-identity-inference-design.md.
    const isRealHost = (host: string | null): host is string =>
      host !== null && host !== SOURCE_HOST;

    // A resolved real host that's already independently tracked as a kept
    // node at that exact ttl (nodeByTtlHost already has it) is reused as-is
    // — it's a genuinely observed entity, not an inference, and creating a
    // second node for the same host/ttl would just be a visual duplicate.
    // Only hosts with no existing kept representation get a new, `inferred:
    // true` node.
    const createInferredChain = (hosts: string[], ttls: number[]): (number | string)[] =>
      ttls.map((ttl, i) => {
        const host = hosts[i];
        const existing = nodeByTtlHost.get(`${ttl}:${host}`);
        if (existing !== undefined) return existing;
        const id = `inferred:${ttl}:${host}`;
        if (!inferredNodesById.has(id)) {
          inferredNodesById.set(id, {
            id,
            ttl,
            host,
            active: false,
            x: ttl * 220,
            y: 140,
            hasCustomPosition: false,
            inferred: true,
          });
        }
        return id;
      });

    // Recursively resolves a span of "???" ttls bounded by
    // (span.boundBeforeHost, span.boundAfterHost): tries a bridge covering
    // the whole span, then a known prefix or suffix (recursing on whatever's
    // left), and only falls back to one shared anonymous placeholder chain
    // (resolveGapChain, unchanged) for however much of the span no known
    // bridge can explain.
    const resolveGapSpan = (span: GapWalk, runId: number): (number | string)[] => {
      if (span.ttls.length === 0) return [];
      const left = span.boundBeforeHost;
      const right = span.boundAfterHost;
      const len = span.ttls.length;

      if (isRealHost(left) && isRealHost(right)) {
        const exact = this.bridgeInference.findExactBridge(targetId, left, right, len, 1);
        if (exact) return createInferredChain(exact, span.ttls);
      }

      if (len >= 2 && isRealHost(left)) {
        const prefix = this.bridgeInference.findKnownContinuation(targetId, left, len - 1, 1);
        if (prefix) {
          const prefixTtls = span.ttls.slice(0, prefix.length);
          const restTtls = span.ttls.slice(prefix.length);
          const prefixIds = createInferredChain(prefix, prefixTtls);
          const restIds = resolveGapSpan(
            { ttls: restTtls, boundBeforeHost: prefix[prefix.length - 1], boundAfterHost: right },
            runId,
          );
          return [...prefixIds, ...restIds];
        }
      }

      if (len >= 2 && isRealHost(right)) {
        const suffix = this.bridgeInference.findKnownContinuation(targetId, right, len - 1, -1);
        if (suffix) {
          const suffixAscending = suffix.slice().reverse();
          const suffixTtls = span.ttls.slice(len - suffix.length);
          const restTtls = span.ttls.slice(0, len - suffix.length);
          const suffixIds = createInferredChain(suffixAscending, suffixTtls);
          const restIds = resolveGapSpan(
            { ttls: restTtls, boundBeforeHost: left, boundAfterHost: suffixAscending[0] },
            runId,
          );
          return [...restIds, ...suffixIds];
        }
      }

      return resolveGapChain(span, runId);
    };

    const resolveThroughGap = (
      runId: number,
      ttl: number,
      host: string,
      direction: 1 | -1,
    ): number | string | undefined => {
      const walk = walkGap(runId, ttl, host, direction);
      if (!walk) return undefined;
      const chainIds = resolveGapSpan(walk, runId);
      for (let i = 0; i < chainIds.length - 1; i++) connectStale(chainIds[i], chainIds[i + 1]);

      if (direction === 1) {
        if (walk.boundAfterHost !== null) {
          const farTtl = walk.ttls[walk.ttls.length - 1] + 1;
          const resolved = nodeByTtlHost.get(`${farTtl}:${walk.boundAfterHost}`);
          if (resolved !== undefined) connectStale(chainIds[chainIds.length - 1], resolved);
        }
        return chainIds[0];
      }
      if (walk.boundBeforeHost === SOURCE_HOST) {
        connectStale(0, chainIds[0]);
      } else if (walk.boundBeforeHost !== null) {
        const farTtl = walk.ttls[0] - 1;
        const resolved = nodeByTtlHost.get(`${farTtl}:${walk.boundBeforeHost}`);
        if (resolved !== undefined) connectStale(resolved, chainIds[0]);
      }
      return chainIds[chainIds.length - 1];
    };

    for (const [ttl, rows] of staleByTtl) {
      const kept = rows.filter((r) => keptStaleIds.has(r.id));
      for (const staleNode of kept) {
        const lastActiveRunId = (
          lastActiveRunStmt.get(targetId, ttl, staleNode.host) as { runId: number | null }
        ).runId;

        let prevSourceId: number | string | undefined;
        if (ttl === 1) {
          prevSourceId = 0;
        } else if (lastActiveRunId !== null) {
          const prevHop = hopAtTtlStmt.get(lastActiveRunId, ttl - 1) as
            | { host: string }
            | undefined;
          if (prevHop?.host === NO_REPLY_HOST) {
            prevSourceId = resolveThroughGap(lastActiveRunId, ttl, staleNode.host, -1);
          } else if (prevHop) {
            prevSourceId = nodeByTtlHost.get(`${ttl - 1}:${prevHop.host}`);
          }
        }
        if (prevSourceId !== undefined) connectStale(prevSourceId, staleNode.id);

        let nextTargetId: number | string | undefined;
        if (lastActiveRunId !== null) {
          const nextHop = hopAtTtlStmt.get(lastActiveRunId, ttl + 1) as
            | { host: string }
            | undefined;
          if (nextHop?.host === NO_REPLY_HOST) {
            nextTargetId = resolveThroughGap(lastActiveRunId, ttl, staleNode.host, 1);
          } else if (nextHop) {
            nextTargetId = nodeByTtlHost.get(`${ttl + 1}:${nextHop.host}`);
          }
        }
        if (nextTargetId !== undefined) connectStale(staleNode.id, nextTargetId);
      }
    }

    nodes.push(...syntheticNodesById.values());
    nodes.push(...inferredNodesById.values());
```

(The pre-existing final line of the method, `return { nodes, edges };`, stays where it is, right after this block.)

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: all tests PASS, including the four new ones.

Run: `cd backend && npm test`
Expected: all tests PASS (confirms no regression in any pre-existing scenario — every existing test uses made-up hosts with no historical bridge data, so `resolveGapSpan` always falls through to the unchanged `resolveGapChain` for them).

Run: `cd backend && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/map.ts backend/src/services/map.test.ts
git commit -m "$(cat <<'EOF'
Substitute a known-bridge identity for ??? gaps when unambiguous

MapService.getMap's gap resolution now tries BridgeInferenceService
before falling back to an anonymous shared placeholder: an exact
match fills the whole gap; a known prefix or suffix fills part of it
and recurses on whatever's left, repeating until nothing more matches.
A resolved host that's already an independently-tracked kept node is
reused rather than duplicated. Every substituted node is flagged
inferred: true so the frontend can mark it as not directly observed
in this poll.
EOF
)"
```

---

### Task 3: Frontend — render `inferred` nodes distinctly

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/NetworkMap.tsx`
- Modify: `frontend/src/components/HopNode.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `MapNode.inferred` (backend response shape, from Task 2).
- `MapNode.inferred` on the frontend is `boolean | undefined` (optional, following the same precedent as `hasCustomPosition` — real API responses always include it; test fixtures may omit it, defaulting to falsy/no marker, so existing node literals in `NetworkMap.test.tsx` don't need editing).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/NetworkMap.test.tsx`, inside the main `describe('NetworkMap', ...)` block, anywhere after an existing test:

```ts
  it('renders an inferred node with a distinct marker and tooltip, and a non-inferred node without either', () => {
    const inferredMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        {
          id: 'inferred:2:10.0.0.5',
          ttl: 2,
          host: '10.0.0.5',
          active: false,
          x: 220,
          y: 140,
          inferred: true,
        },
      ],
      edges: [],
    };
    render(<NetworkMap targetId={1} mapData={inferredMapData} />);

    const inferredEl = screen.getByText('10.0.0.5').closest('.hop-node') as HTMLElement;
    expect(inferredEl).toHaveClass('inferred');
    expect(inferredEl.title).not.toBe('');

    const normalEl = screen.getByText('192.168.1.1').closest('.hop-node') as HTMLElement;
    expect(normalEl).not.toHaveClass('inferred');
    expect(normalEl.title).toBe('');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx -t "distinct marker"`
Expected: FAIL — `inferred` isn't threaded through to `HopNode` yet, so the `.hop-node` element never gets the `inferred` class or a `title`.

- [ ] **Step 3: Widen `MapNode` and `HopNodeData`**

In `frontend/src/types.ts`, change:

```ts
export interface MapNode {
  id: number | string;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
  hasCustomPosition?: boolean;
}
```

to:

```ts
export interface MapNode {
  id: number | string;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
  hasCustomPosition?: boolean;
  inferred?: boolean;
}
```

In `frontend/src/components/HopNode.tsx`, change:

```ts
export interface HopNodeData extends Record<string, unknown> {
  host: string;
  ttl: number;
  active: boolean;
  netname?: string | null;
  country?: string | null;
  resolvedHost?: string | null;
}
```

to:

```ts
export interface HopNodeData extends Record<string, unknown> {
  host: string;
  ttl: number;
  active: boolean;
  netname?: string | null;
  country?: string | null;
  resolvedHost?: string | null;
  inferred?: boolean;
}
```

- [ ] **Step 4: Render the marker in `HopNode`**

In `frontend/src/components/HopNode.tsx`, change:

```tsx
export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, resolvedHost } = data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}`}>
```

to:

```tsx
export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, resolvedHost, inferred } = data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div
      className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}${inferred ? ' inferred' : ''}`}
      title={inferred ? 'Inferred from an earlier resolved path — not observed responding in this poll' : ''}
    >
```

- [ ] **Step 5: Add the CSS**

In `frontend/src/styles.css`, add this rule immediately after the existing `.hop-node.inactive` block:

```css
.hop-node.inferred {
  border-color: var(--status-warn);
}
```

- [ ] **Step 6: Thread `inferred` through `NetworkMap.tsx`**

In `frontend/src/components/NetworkMap.tsx`, find the `hopNodes` construction inside the `initialNodes` memo:

```ts
    const hopNodes: Node[] = mapData.nodes.map((n) => {
      const id = String(n.id);
      const position = n.hasCustomPosition
        ? { x: n.x, y: n.y }
        : (autoPositions.get(id) ?? { x: n.x, y: n.y });
      return {
        id,
        type: 'hopNode',
        position,
        measured,
        handles,
        data: {
          host: n.host,
          ttl: n.ttl,
          active: historyActive != null ? isHistoricallyActive(n.ttl, n.host) : n.active,
        },
      };
    });
```

Change the `data` object to include `inferred`:

```ts
    const hopNodes: Node[] = mapData.nodes.map((n) => {
      const id = String(n.id);
      const position = n.hasCustomPosition
        ? { x: n.x, y: n.y }
        : (autoPositions.get(id) ?? { x: n.x, y: n.y });
      return {
        id,
        type: 'hopNode',
        position,
        measured,
        handles,
        data: {
          host: n.host,
          ttl: n.ttl,
          active: historyActive != null ? isHistoricallyActive(n.ttl, n.host) : n.active,
          inferred: n.inferred,
        },
      };
    });
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: all tests PASS, including the new one.

Run: `cd frontend && npm test`
Expected: all tests PASS.

Run: `cd frontend && npm run build`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/types.ts frontend/src/components/NetworkMap.tsx frontend/src/components/HopNode.tsx frontend/src/styles.css frontend/src/components/NetworkMap.test.tsx
git commit -m "$(cat <<'EOF'
Render inferred hop nodes with a distinct marker

A node the backend resolved via known-bridge inference (MapNode.inferred)
now gets a warn-colored border and a tooltip explaining it wasn't
directly observed in this poll — otherwise indistinguishable from any
other stale node, which would misrepresent a guess as an observation.
Whois/DNS lookups already work unchanged for these nodes since they
carry real host strings, not "???".
EOF
)"
```
