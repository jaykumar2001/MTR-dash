# Historically-Correct Stale Path Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix stale-node edge generation so that when multiple adjacent hops change in the same
poll, the stale nodes connect to each other (their true historical neighbors) instead of to
today's current active nodes, eliminating phantom edges that never existed on the wire.

**Architecture:** `MapService.getMap`'s stale-edge loop changes from "connect each stale node to
whatever's currently active at its neighboring TTLs" to "resolve each stale node's neighbors from
its own last-active run's hop snapshot, then connect to whichever node (active or stale) currently
represents that historical host." No schema changes — the `hops` table already stores a full path
snapshot per `run_id`, which is the source of truth for "who was truly adjacent to whom."

**Tech Stack:** Hono + better-sqlite3 (backend only — no frontend changes needed, `MapEdge`'s
shape is unchanged).

## Global Constraints

- No schema changes. No new tables, no new columns.
- `maxStaleHops` limiting (which stale nodes are kept per TTL) is unchanged — this plan only
  changes what a kept stale node connects *to*.
- A stale edge is only ever drawn between two hosts that were actually observed adjacent to each
  other in some real `hops` row-set for a single `run_id`.
- `TTL = 1`'s "previous" side stays hardcoded to the synthetic source node id `0`, unconditionally
  — unaffected by this change.
- All existing `map.test.ts` tests are expected to keep passing **without modification** — the
  single-hop-change case produces identical output under the new algorithm, since a stale node's
  true historical neighbor is, by definition, the same as today's current neighbor when nothing
  else changed at the same time.

---

### Task 1: Historically-correct stale edge resolution

**Files:**
- Modify: `backend/src/services/map.ts`
- Modify: `backend/src/services/map.test.ts`

**Interfaces:**
- No public interface changes — `MapService.getMap(targetId: number): MapResult` keeps its exact
  existing signature and `MapEdge`/`MapNode` shapes. This task only changes internal logic.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `backend/src/services/map.test.ts`, inside the existing
`describe('MapService', ...)` block, after the last existing test (`'connects two
simultaneously-retained stale nodes at the same ttl, each to the active neighbors'`):

```ts
  it('connects two correlated stale nodes to each other, not to unrelated live nodes, when adjacent hops change together', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: 'C2', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeB = result.nodes.find((n) => n.host === 'B')!;
    const nodeC = result.nodes.find((n) => n.host === 'C')!;
    const nodeD = result.nodes.find((n) => n.host === 'D')!;
    const nodeB2 = result.nodes.find((n) => n.host === 'B2')!;
    const nodeC2 = result.nodes.find((n) => n.host === 'C2')!;

    const staleEdges = result.edges.filter((e) => e.stale);
    const staleEdgeIds = staleEdges.map((e) => e.id).sort();
    expect(staleEdgeIds).toEqual(
      [`${nodeA.id}-${nodeB.id}`, `${nodeB.id}-${nodeC.id}`, `${nodeC.id}-${nodeD.id}`].sort(),
    );

    // The stale segment never touches the new live nodes.
    expect(
      staleEdges.some(
        (e) =>
          e.source === nodeB2.id ||
          e.target === nodeB2.id ||
          e.source === nodeC2.id ||
          e.target === nodeC2.id,
      ),
    ).toBe(false);

    const liveEdgeIds = result.edges
      .filter((e) => !e.stale)
      .map((e) => e.id)
      .sort();
    expect(liveEdgeIds).toEqual(
      [
        `0-${nodeA.id}`,
        `${nodeA.id}-${nodeB2.id}`,
        `${nodeB2.id}-${nodeC2.id}`,
        `${nodeC2.id}-${nodeD.id}`,
      ].sort(),
    );
  });

  it("omits a stale node's edge to a neighbor that has since been bumped out of the kept set", () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'P', lossPct: 0 },
        { ttl: 3, host: 'X', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Q', lossPct: 0 },
        { ttl: 3, host: 'Y', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'R', lossPct: 0 },
        { ttl: 3, host: 'Y', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeX = result.nodes.find((n) => n.host === 'X')!;
    const nodeD = result.nodes.find((n) => n.host === 'D')!;
    const hosts = result.nodes.map((n) => n.host);
    expect(hosts).not.toContain('P'); // bumped out by maxStaleHops=1 (default) at ttl 2

    const staleEdges = result.edges.filter((e) => e.stale);
    expect(staleEdges.some((e) => e.target === nodeX.id)).toBe(false);
    expect(staleEdges.some((e) => e.source === nodeX.id && e.target === nodeD.id)).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: FAIL — the first new test fails because today's logic connects stale `B` to `C2` (the
current active node at TTL 3) instead of stale `C`, so `staleEdgeIds` won't match. The second new
test fails because today's logic connects stale `X` to whatever's currently active at TTL 2 (`R`)
instead of correctly omitting that side.

- [ ] **Step 3: Rewrite the stale-edge generation loop**

Replace the full contents of `backend/src/services/map.ts` with:

```ts
import type Database from 'better-sqlite3';

export interface MapNode {
  id: number;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
}

export interface EdgeMetrics {
  lossPct: number;
  snt: number;
  last: number;
  avg: number;
  best: number;
  wrst: number;
  stdev: number;
}

export interface MapEdge {
  id: string;
  source: number;
  target: number;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}

export interface MapResult {
  nodes: MapNode[];
  edges: MapEdge[];
}

interface PathNodeRow {
  id: number;
  ttl: number;
  host: string;
  active: number;
}

const ROLLING_WINDOW = 5;

export class MapService {
  constructor(private db: Database.Database) {}

  getMap(targetId: number): MapResult {
    const targetRow = this.db
      .prepare('SELECT max_stale_hops FROM targets WHERE id = ?')
      .get(targetId) as { max_stale_hops: number } | undefined;
    const maxStaleHops = targetRow?.max_stale_hops ?? 0;

    const nodeRows = this.db
      .prepare('SELECT * FROM path_nodes WHERE target_id = ? ORDER BY ttl ASC')
      .all(targetId) as PathNodeRow[];

    const activeByTtl = new Map<number, PathNodeRow>();
    for (const n of nodeRows) if (n.active === 1) activeByTtl.set(n.ttl, n);

    const staleByTtl = new Map<number, PathNodeRow[]>();
    for (const n of nodeRows) {
      if (n.active === 1) continue;
      const list = staleByTtl.get(n.ttl) ?? [];
      list.push(n);
      staleByTtl.set(n.ttl, list);
    }

    // Get deactivation times for stale nodes from the deviations table.
    // We use the deviation id (auto-increment) rather than detected_at to handle cases
    // where multiple deviations occur in the same millisecond.
    const deactivatedId = new Map<number, number>();
    for (const rows of staleByTtl.values()) {
      for (const row of rows) {
        const deviation = this.db
          .prepare(
            `SELECT id FROM deviations
             WHERE target_id = ? AND ttl = ? AND old_host = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(targetId, row.ttl, row.host) as { id: number } | undefined;
        if (deviation) {
          deactivatedId.set(row.id, deviation.id);
        }
      }
    }

    const keptStaleIds = new Set<number>();
    for (const rows of staleByTtl.values()) {
      rows
        .slice()
        .sort((a, b) => {
          const aId = deactivatedId.get(a.id) ?? 0;
          const bId = deactivatedId.get(b.id) ?? 0;
          return bId - aId;
        })
        .slice(0, maxStaleHops)
        .forEach((r) => keptStaleIds.add(r.id));
    }

    const keptRows = nodeRows.filter((n) => n.active === 1 || keptStaleIds.has(n.id));

    const positions = new Map<number, { x: number; y: number }>();
    for (const p of this.db
      .prepare('SELECT node_id, x, y FROM node_positions WHERE target_id = ?')
      .all(targetId) as { node_id: number; x: number; y: number }[]) {
      positions.set(p.node_id, { x: p.x, y: p.y });
    }

    const nodes: MapNode[] = keptRows.map((n, idx) => {
      const pos = positions.get(n.id) ?? { x: idx * 220, y: n.active ? 0 : 140 };
      return { id: n.id, ttl: n.ttl, host: n.host, active: n.active === 1, x: pos.x, y: pos.y };
    });

    const maxTtl = nodeRows.reduce((max, n) => Math.max(max, n.ttl), 0);
    const edges: MapEdge[] = [];

    for (let ttl = 1; ttl <= maxTtl; ttl++) {
      const curr = activeByTtl.get(ttl);
      if (!curr) continue;
      const prev = activeByTtl.get(ttl - 1);
      const sourceId = ttl === 1 ? 0 : prev?.id;
      if (sourceId === undefined) continue;

      const latestRow = this.db
        .prepare(
          `SELECT h.* FROM hops h
           JOIN runs r ON h.run_id = r.id
           WHERE r.target_id = ? AND h.ttl = ?
           ORDER BY r.id DESC LIMIT 1`,
        )
        .get(targetId, ttl) as
        | {
            loss_pct: number;
            snt: number;
            last: number;
            avg: number;
            best: number;
            wrst: number;
            stdev: number;
          }
        | undefined;

      const recentLoss = this.db
        .prepare(
          `SELECT h.loss_pct as lossPct FROM hops h
           JOIN runs r ON h.run_id = r.id
           WHERE r.target_id = ? AND h.ttl = ? AND h.host = ?
           ORDER BY r.id DESC LIMIT ?`,
        )
        .all(targetId, ttl, curr.host, ROLLING_WINDOW) as { lossPct: number }[];

      const avgLossPct = recentLoss.length
        ? recentLoss.reduce((sum, r) => sum + r.lossPct, 0) / recentLoss.length
        : 0;
      const color = avgLossPct > 5 ? 'red' : avgLossPct > 0 ? 'yellow' : 'green';

      edges.push({
        id: `${sourceId}-${curr.id}`,
        source: sourceId,
        target: curr.id,
        color,
        stale: false,
        avgLossPct,
        latest: latestRow
          ? {
              lossPct: latestRow.loss_pct,
              snt: latestRow.snt,
              last: latestRow.last,
              avg: latestRow.avg,
              best: latestRow.best,
              wrst: latestRow.wrst,
              stdev: latestRow.stdev,
            }
          : { lossPct: 0, snt: 0, last: 0, avg: 0, best: 0, wrst: 0, stdev: 0 },
      });
    }

    // Stale nodes connect to their TRUE historical neighbors — resolved from the
    // same run's hop snapshot the stale node was itself last active in — not to
    // whatever's active today. This is what correctly renders two adjacent hops
    // that changed together (e.g. b and c in a-b-c-d -> a-b'-c'-d) as a single
    // coherent stale segment (a-b-c-d), instead of splicing stale nodes onto
    // unrelated live ones.
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

    for (const [ttl, rows] of staleByTtl) {
      const kept = rows.filter((r) => keptStaleIds.has(r.id));
      for (const staleNode of kept) {
        const lastActiveRunId = (
          lastActiveRunStmt.get(targetId, ttl, staleNode.host) as { runId: number | null }
        ).runId;

        let prevSourceId: number | undefined;
        if (ttl === 1) {
          prevSourceId = 0;
        } else if (lastActiveRunId !== null) {
          const prevHop = hopAtTtlStmt.get(lastActiveRunId, ttl - 1) as
            | { host: string }
            | undefined;
          if (prevHop) prevSourceId = nodeByTtlHost.get(`${ttl - 1}:${prevHop.host}`);
        }
        if (prevSourceId !== undefined) {
          const id = `${prevSourceId}-${staleNode.id}`;
          if (!addedStaleEdgeIds.has(id)) {
            addedStaleEdgeIds.add(id);
            edges.push({
              id,
              source: prevSourceId,
              target: staleNode.id,
              color: 'grey',
              stale: true,
            });
          }
        }

        let nextTargetId: number | undefined;
        if (lastActiveRunId !== null) {
          const nextHop = hopAtTtlStmt.get(lastActiveRunId, ttl + 1) as
            | { host: string }
            | undefined;
          if (nextHop) nextTargetId = nodeByTtlHost.get(`${ttl + 1}:${nextHop.host}`);
        }
        if (nextTargetId !== undefined) {
          const id = `${staleNode.id}-${nextTargetId}`;
          if (!addedStaleEdgeIds.has(id)) {
            addedStaleEdgeIds.add(id);
            edges.push({
              id,
              source: staleNode.id,
              target: nextTargetId,
              color: 'grey',
              stale: true,
            });
          }
        }
      }
    }

    return { nodes, edges };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: PASS (all tests — the 10 pre-existing tests plus the 2 new ones). The pre-existing
tests are expected to pass without any modification to their own code, confirming the new
algorithm reproduces identical behavior for every already-covered single-hop-change scenario.

- [ ] **Step 5: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS, no failures.

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/services/map.ts src/services/map.test.ts
git commit -m "Connect stale nodes to their true historical neighbors instead of today's active ones"
```

---

### Task 2: Full-stack regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, no failures.

- [ ] **Step 2: Run the full backend build**

Run: `cd backend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 3: Run the full frontend suite (unaffected by this plan, confirm no accidental breakage)**

Run: `cd frontend && npm test`
Expected: PASS, no failures beyond the known pre-existing flaky test documented in `HANDOFF.md`
(`'loads targets and shows the selected target host in the config panel'` in `App.test.tsx`) — if
only that specific test fails, re-run once before treating it as a real regression.

- [ ] **Step 4: Run the full frontend build**

Run: `cd frontend && npm run build`
Expected: PASS, no type errors — `MapEdge`'s shape didn't change, so no frontend code should need
updating.

- [ ] **Step 5: Manually verify in the browser**

Start both dev servers (`cd backend && npm run dev`, `cd frontend && npm run dev`), seed a
scenario where two adjacent hops change in the same poll (directly via the database, mirroring the
seeding approach used to verify the original stale-hop-nodes feature: insert two `path_nodes` rows
at adjacent TTLs with `active=0` plus a matching pair of `hops` rows sharing one `run_id` and a
`deviations` row for each), and confirm the map renders the two stale nodes connected to each
other by a single dashed grey edge, not each reaching for today's unrelated live nodes.
