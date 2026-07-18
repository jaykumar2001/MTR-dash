# Unresolved (`???`) Hop Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `MapService.getMap`'s stale-connector edges from asserting that two unrelated `"???"` (no-reply) hops are the same physical router, and stop the frontend from attempting/surfacing whois failures for hop hosts that were never real, lookupable values in the first place.

**Architecture:** Backend-only rendering change in `MapService.getMap` — when a stale node's true historical neighbor (at the neighboring TTL, in its `lastActiveRunId` snapshot) reads `"???"`, walk the contiguous run of `"???"` TTLs in that same snapshot to find the real host bounding the far end (if any), and render the gap as one or more synthetic (non-database) nodes keyed by `(ttlStart, ttlEnd, hostBeforeGap, hostAfterGap)` — so two gaps only ever share synthetic nodes when both their bounding real hosts match. `path_nodes`, `deviations`, and `RunsService.updatePathNodes` are untouched. On the frontend, `MapNode`/`MapEdge` id types widen to allow these synthetic string ids, and a small host-validity guard in `NetworkMap.tsx` stops whois lookups (and position-persistence) from ever being attempted against them.

**Tech Stack:** TypeScript, `better-sqlite3`, Vitest, React Flow (`@xyflow/react`).

## Global Constraints

- No changes to `backend/src/services/runs.ts`, `path_nodes`, or `deviations` (see design doc's Non-goals).
- No changes to `maxStaleHops` node selection — only to what a kept stale node connects to.
- No backend changes to whois validation (`routes/whois.ts`'s `VALID_HOST` already rejects `"???"` correctly) — the whois fix is frontend-only.
- Design doc: `docs/superpowers/specs/2026-07-10-unresolved-hop-identity-design.md`

---

### Task 1: Backend — synthetic nodes for unresolved-hop gaps in `MapService.getMap`

**Files:**
- Modify: `backend/src/services/map.ts`
- Test: `backend/src/services/map.test.ts`

**Interfaces:**
- Produces: `MapNode.id: number | string`, `MapEdge.source: number | string`, `MapEdge.target: number | string` (both types exported from `map.ts`, consumed by `routes/map.ts` — no change needed there, it just serializes whatever `getMap` returns — and mirrored in the frontend in Task 2).
- A synthetic node has `host: '???'`, `active: false`, and a `string` id of the form `` `synthetic:${key}:${ttl}` ``, where `key` is `` `${ttlStart}-${ttlEnd}|${beforeHost}|${afterHost}` ``.

- [ ] **Step 1: Write three failing tests describing the required behavior**

Add to `backend/src/services/map.test.ts`, inside the existing `describe('MapService', ...)` block (after the `"omits a stale node's edge to a neighbor that has since been bumped out of the kept set"` test):

```ts
  it('connects a stale node to a distinct synthetic node when its historical neighbor is unresolved (???), not to the live active ??? node', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const liveUnknown = result.nodes.find((n) => n.host === '???' && n.active === true)!;

    const staleOutEdge = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    expect(staleOutEdge.target).not.toBe(liveUnknown.id);

    const syntheticNode = result.nodes.find((n) => n.id === staleOutEdge.target)!;
    expect(syntheticNode.host).toBe('???');
    expect(syntheticNode.active).toBe(false);
    expect(typeof syntheticNode.id).toBe('string');
  });

  it('reuses the same synthetic ??? chain when two stale segments resolve into an identically-bounded gap', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: 'D2', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const staleD = result.nodes.find((n) => n.host === 'D' && n.active === false)!;

    const syntheticNodes = result.nodes.filter((n) => typeof n.id === 'string');
    expect(syntheticNodes).toHaveLength(2);

    const synth3 = syntheticNodes.find((n) => n.ttl === 3)!;
    const synth4 = syntheticNodes.find((n) => n.ttl === 4)!;

    const edgeFromB = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    const edgeIntoD = result.edges.find((e) => e.stale && e.target === staleD.id)!;
    expect(edgeFromB.target).toBe(synth3.id);
    expect(edgeIntoD.source).toBe(synth4.id);
    expect(
      result.edges.some((e) => e.stale && e.source === synth3.id && e.target === synth4.id),
    ).toBe(true);
  });

  it('does not share a synthetic node across resolutions whose near-bound host differs, even when the far bound matches', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 2 WHERE id = ?').run(targetId);

    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Bolder', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
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
    const staleBolder = result.nodes.find((n) => n.host === 'Bolder')!;
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const nodeD = result.nodes.find((n) => n.host === 'D')!;

    const edgeFromBolder = result.edges.find((e) => e.stale && e.source === staleBolder.id)!;
    const edgeFromB = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    expect(edgeFromBolder.target).not.toBe(edgeFromB.target);

    expect(
      result.edges.some(
        (e) => e.stale && e.source === edgeFromBolder.target && e.target === nodeD.id,
      ),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.stale && e.source === edgeFromB.target && e.target === nodeD.id),
    ).toBe(true);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: the three new tests FAIL (the first two on `staleOutEdge.target`/`edgeFromB.target` equality assertions — today's code resolves the `"???"` neighbor to the live active `"???"` node instead of a synthetic one; the third fails because today's code has no synthetic-node concept at all, so `edgeFromBolder`/`edgeFromB` are both `undefined` or resolve incorrectly). Existing tests in the file still PASS.

- [ ] **Step 3: Widen `MapNode`/`MapEdge` id types**

In `backend/src/services/map.ts`, change:

```ts
export interface MapNode {
  id: number;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
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
}
```

and change:

```ts
export interface MapEdge {
  id: string;
  source: number;
  target: number;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}
```

to:

```ts
export interface MapEdge {
  id: string;
  source: number | string;
  target: number | string;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}
```

- [ ] **Step 4: Replace the stale-connector section with the gap-walking implementation**

In `backend/src/services/map.ts`, find the block starting at:

```ts
    // Stale nodes connect to their TRUE historical neighbors — resolved from the
```

and ending at the closing of the `getMap` method (just before `return { nodes, edges };`). Replace that entire block (from the `// Stale nodes connect to their TRUE historical neighbors` comment through the final `for (const [ttl, rows] of staleByTtl) { ... }` loop, but keep the final `return { nodes, edges };` line as-is) with:

```ts
    // Stale nodes connect to their TRUE historical neighbors — resolved from the
    // same run's hop snapshot the stale node was itself last active in — not to
    // whatever's active today. This is what correctly renders two adjacent hops
    // that changed together (e.g. b and c in a-b-c-d -> a-b'-c'-d) as a single
    // coherent stale segment (a-b-c-d), instead of splicing stale nodes onto
    // unrelated live ones.
    //
    // A historical neighbor host of "???" (mtr's no-reply sentinel) is never
    // resolved by string match — "???" isn't a real host identity, so two
    // separate "???" observations aren't provably the same physical hop. See
    // docs/superpowers/specs/2026-07-10-unresolved-hop-identity-design.md.
    const NO_REPLY_HOST = '???';
    const SOURCE_HOST = ' source';

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
      return direction === 1
        ? { ttls, boundBeforeHost: nodeHost, boundAfterHost: farHost }
        : { ttls, boundBeforeHost: farHost, boundAfterHost: nodeHost };
    };

    const gapKey = (walk: GapWalk, runId: number): string => {
      const ttlStart = walk.ttls[0];
      const ttlEnd = walk.ttls[walk.ttls.length - 1];
      const before = walk.boundBeforeHost ?? `run:${runId}`;
      const after = walk.boundAfterHost ?? `run:${runId}`;
      return `${ttlStart}-${ttlEnd}|${before}|${after}`;
    };

    const resolveGapChain = (walk: GapWalk, runId: number): (number | string)[] => {
      const key = gapKey(walk, runId);
      const cached = gapChainCache.get(key);
      if (cached) return cached;
      const chainIds = walk.ttls.map((ttl) => `synthetic:${key}:${ttl}`);
      walk.ttls.forEach((ttl, i) => {
        syntheticNodesById.set(chainIds[i], {
          id: chainIds[i],
          ttl,
          host: NO_REPLY_HOST,
          active: false,
          x: ttl * 220,
          y: 140,
        });
      });
      gapChainCache.set(key, chainIds);
      return chainIds;
    };

    const resolveThroughGap = (
      runId: number,
      ttl: number,
      host: string,
      direction: 1 | -1,
    ): number | string | undefined => {
      const walk = walkGap(runId, ttl, host, direction);
      if (!walk) return undefined;
      const chainIds = resolveGapChain(walk, runId);
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
```

(The pre-existing final line of the method, `return { nodes, edges };`, stays where it is, right after this block.)

- [ ] **Step 5: Run the full backend test suite**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: all tests in the file PASS, including the three new ones.

Run: `cd backend && npm test`
Expected: all 132+ tests PASS (confirms nothing else in the backend assumed `MapNode.id`/`MapEdge.source`/`target` were always `number`).

Run: `cd backend && npm run build`
Expected: exits 0 — confirms the widened types don't break `tsc -p tsconfig.json` anywhere else in the backend.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/map.ts backend/src/services/map.test.ts
git commit -m "$(cat <<'EOF'
Render unresolved-hop stale gaps as distinct synthetic nodes

Two separate "???" observations are never provably the same physical
hop, so MapService.getMap no longer resolves a stale node's
historical neighbor to the live active "???" node by string match.
Instead it walks the contiguous run of "???" TTLs in that neighbor's
own historical snapshot and renders it as synthetic nodes keyed by
their bounding real hosts, so two gaps only ever share nodes when
both bounds genuinely match.
EOF
)"
```

---

### Task 2: Frontend — widen map types and skip position-persistence for synthetic nodes

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/NetworkMap.tsx`
- Test: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `MapNode.id: number | string`, `MapEdge.source/target: number | string` from Task 1 (backend response shape).
- Produces: `isPersistableNodeId(id: string): boolean`, exported from `NetworkMap.tsx` for direct unit testing.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/NetworkMap.test.tsx`, in a new `describe` block at the end of the file:

```ts
describe('isPersistableNodeId', () => {
  it('is true for a real numeric node id', () => {
    expect(isPersistableNodeId('42')).toBe(true);
  });

  it('is false for the synthetic source node id', () => {
    expect(isPersistableNodeId('source')).toBe(false);
  });

  it('is false for a synthetic ??? gap node id', () => {
    expect(isPersistableNodeId('synthetic:3-3|B|run:5:3')).toBe(false);
  });
});
```

Add `isPersistableNodeId` to the existing import at the top of the test file:

```ts
import { NetworkMap, isPersistableNodeId } from './NetworkMap.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx -t "isPersistableNodeId"`
Expected: FAIL — `isPersistableNodeId` is not exported from `NetworkMap.tsx` yet (TypeScript/module error).

- [ ] **Step 3: Widen the frontend `MapNode`/`MapEdge` types**

In `frontend/src/types.ts`, change:

```ts
export interface MapNode {
  id: number;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
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
}
```

and change:

```ts
export interface MapEdge {
  id: string;
  source: number;
  target: number;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}
```

to:

```ts
export interface MapEdge {
  id: string;
  source: number | string;
  target: number | string;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}
```

- [ ] **Step 4: Export `isPersistableNodeId` and use it in `handleNodeDragStop`**

In `frontend/src/components/NetworkMap.tsx`, add this exported function near the top of the file, right after the `SOURCE_NODE_ID` constant definition (`const SOURCE_NODE_ID = 'source';`):

```ts
export function isPersistableNodeId(id: string): boolean {
  return id !== SOURCE_NODE_ID && Number.isFinite(Number(id));
}
```

Then change `handleNodeDragStop` from:

```ts
  const handleNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      if (node.id === SOURCE_NODE_ID) return;
      void api.setNodePosition(targetId, Number(node.id), node.position.x, node.position.y);
    },
    [targetId],
  );
```

to:

```ts
  const handleNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      if (!isPersistableNodeId(node.id)) return;
      void api.setNodePosition(targetId, Number(node.id), node.position.x, node.position.y);
    },
    [targetId],
  );
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: all tests PASS, including the three new `isPersistableNodeId` tests.

Run: `cd frontend && npm test`
Expected: all 78+ tests PASS.

Run: `cd frontend && npm run build`
Expected: exits 0 — confirms `tsc -b` accepts the widened `MapNode`/`MapEdge` types everywhere they're consumed.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "$(cat <<'EOF'
Widen map node/edge ids to support synthetic string ids

MapService.getMap can now return synthetic (non-database) nodes for
unresolved-hop gaps. Position-drag persistence must skip them (they
have no node_positions row to write), matching the existing
SOURCE_NODE_ID guard via one shared isPersistableNodeId check.
EOF
)"
```

---

### Task 3: Frontend — never attempt (or show an error for) a whois lookup on an unresolved host

**Files:**
- Modify: `frontend/src/components/NetworkMap.tsx`
- Test: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: nothing new from Tasks 1–2.
- Produces: nothing consumed elsewhere — this is a leaf-level UI guard.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/NetworkMap.test.tsx`, in the main `describe('NetworkMap', ...)` block, right after the existing `"does not trigger a whois lookup when clicking the synthetic source node"` test:

```ts
  it('does not attempt a whois lookup for an unresolved (???) hop, showing "No whois data available" immediately', () => {
    const dataWithUnknownHop: MapResult = {
      nodes: [...mapData.nodes, { id: 2, ttl: 2, host: '???', active: true, x: 220, y: 0 }],
      edges: [
        ...mapData.edges,
        { id: '1-2', source: 1, target: 2, color: 'grey', stale: false },
      ],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={dataWithUnknownHop} />);
    const nodeEl = screen.getByText('???').closest('.react-flow__node') as HTMLElement;

    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });

    expect(api.getWhois).not.toHaveBeenCalled();
    expect(container.querySelector('.node-whois-status.error')).toBeNull();
    expect(screen.getByText('No whois data available')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx -t "unresolved"`
Expected: FAIL — today's `handleNodeClick` calls `api.getWhois('???')` unconditionally, so `expect(api.getWhois).not.toHaveBeenCalled()` fails.

- [ ] **Step 3: Add the host-validity guard**

In `frontend/src/components/NetworkMap.tsx`, add this constant near the top of the file, alongside the other module-level constants (e.g. right after `SOURCE_NODE_ID`/`isPersistableNodeId`):

```ts
// Mirrors backend/src/routes/whois.ts's VALID_HOST — hosts that fail this
// were never a real IP/hostname to begin with (mtr's "???" no-reply
// sentinel, or a synthetic gap node sharing that same host string), so
// there's nothing to look up and no error to report.
const LOOKUPABLE_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
```

Then change `handleNodeClick` from:

```ts
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.stopPropagation();
      if (node.id === SOURCE_NODE_ID) {
        setPopup(null);
        return;
      }
      const { host } = node.data as HopNodeData;
      if (popup?.kind === 'node' && popup.host === host) {
        setPopup(null);
        return;
      }
      setPopup({ kind: 'node', host, clientX: event.clientX, clientY: event.clientY });
      setWhois({ status: 'loading' });
      api
        .getWhois(host)
        .then((result) => setWhois({ status: 'success', result }))
        .catch((err) =>
          setWhois({
            status: 'error',
            message: err instanceof Error ? err.message : 'Lookup failed',
          }),
        );
    },
    [popup],
  );
```

to:

```ts
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.stopPropagation();
      if (node.id === SOURCE_NODE_ID) {
        setPopup(null);
        return;
      }
      const { host } = node.data as HopNodeData;
      if (popup?.kind === 'node' && popup.host === host) {
        setPopup(null);
        return;
      }
      setPopup({ kind: 'node', host, clientX: event.clientX, clientY: event.clientY });
      if (!LOOKUPABLE_HOST.test(host)) {
        setWhois({ status: 'success', result: { host, fields: [] } });
        return;
      }
      setWhois({ status: 'loading' });
      api
        .getWhois(host)
        .then((result) => setWhois({ status: 'success', result }))
        .catch((err) =>
          setWhois({
            status: 'error',
            message: err instanceof Error ? err.message : 'Lookup failed',
          }),
        );
    },
    [popup],
  );
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: all tests PASS, including the new one.

Run: `cd frontend && npm test`
Expected: all 78+ tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "$(cat <<'EOF'
Skip whois lookups for hop hosts that were never real, lookupable values

The backend already rejects "???" with a 400 (routes/whois.ts's
VALID_HOST), but the frontend called api.getWhois unconditionally on
node click and surfaced that rejection as "Whois lookup failed" - a
misleading message for what's actually a normal no-reply hop or a
synthetic gap node. Mirror the backend's validity check client-side
and short-circuit straight to the existing "No whois data available"
state instead of ever making the request.
EOF
)"
```
