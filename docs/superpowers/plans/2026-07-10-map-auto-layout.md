# Map Auto-Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the map's crude default node position (`x: idx * 220, y: active ? 0 : 140`, indexed by array order rather than TTL) with a real layout: hops in TTL sequence, hop distance driven by that hop's incremental avg latency, stale/synthetic nodes stacked directly under their TTL's active node with a gap, and consecutive active hops staggered vertically (staircase) when latency-driven spacing would otherwise force an overlap — keeping the whole diagram narrower than a fixed grid would.

**Architecture:** A new pure, framework-free module (`frontend/src/lib/layout.ts`) computes default positions from node TTL/active-state and a latency-per-TTL map; `NetworkMap.tsx` only calls it for nodes that don't have a user-saved position (a new `hasCustomPosition` flag on `MapNode`, computed backend-side from whether a `node_positions` row exists), and continues to run the existing `resolveOverlaps` pass over the merged result exactly as today.

**Tech Stack:** TypeScript, React Flow (`@xyflow/react`), Vitest.

## Global Constraints

- `frontend/src/lib/separation.ts` (`resolveOverlaps`/`separateBoxes`) is unchanged — it remains the final safety-net pass, called exactly as it is today, just now over auto-laid-out positions instead of raw backend fallback positions.
- No change to which nodes are kept (`maxStaleHops` selection) or to stale-connector edge topology (`services/map.ts`'s gap-walk logic from the unresolved-hop-identity work) — positions only.
- Design doc: `docs/superpowers/specs/2026-07-10-map-auto-layout-design.md`
- Backend `MapNode.hasCustomPosition` is a required `boolean` (the backend always computes it). The frontend's mirrored `MapNode.hasCustomPosition` is `boolean | undefined` (optional) specifically so existing test fixtures that omit it keep compiling — they didn't assert exact position values before and don't need to now; `undefined` behaves as "not custom" (auto-layout applies), which is a safe default. Do not make the frontend field required and do not edit the ~10 existing node literals in `NetworkMap.test.tsx` to add it — that's deliberately out of scope for this plan.

---

### Task 1: Backend — `hasCustomPosition` on `MapNode`

**Files:**
- Modify: `backend/src/services/map.ts`
- Test: `backend/src/services/map.test.ts`

**Interfaces:**
- Produces: `MapNode.hasCustomPosition: boolean` — `true` when the node has a row in `node_positions` (a user-dragged, persisted position); `false` for the fallback-position case and always for synthetic nodes.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/services/map.test.ts`. First add the import at the top of the file, alongside the existing imports:

```ts
import { PositionsService } from './positions.js';
```

Then add these two tests inside the existing `describe('MapService', ...)` block, anywhere after the `beforeEach`:

```ts
  it('flags a node with a saved position as hasCustomPosition, and one without as not', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );

    const before = map.getMap(targetId);
    const nodeABefore = before.nodes.find((n) => n.host === 'A')!;
    const nodeBBefore = before.nodes.find((n) => n.host === 'B')!;
    expect(nodeABefore.hasCustomPosition).toBe(false);
    expect(nodeBBefore.hasCustomPosition).toBe(false);

    new PositionsService(db).setPosition(targetId, nodeABefore.id as number, 555, 666);

    const after = map.getMap(targetId);
    const nodeAAfter = after.nodes.find((n) => n.host === 'A')!;
    const nodeBAfter = after.nodes.find((n) => n.host === 'B')!;
    expect(nodeAAfter.hasCustomPosition).toBe(true);
    expect(nodeAAfter.x).toBe(555);
    expect(nodeAAfter.y).toBe(666);
    expect(nodeBAfter.hasCustomPosition).toBe(false);
  });

  it('always flags a synthetic gap node as hasCustomPosition: false', () => {
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
    const synthNode = result.nodes.find((n) => typeof n.id === 'string')!;
    expect(synthNode.hasCustomPosition).toBe(false);
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd backend && npx vitest run src/services/map.test.ts -t "hasCustomPosition"`
Expected: FAIL — `hasCustomPosition` doesn't exist yet on the returned nodes (`undefined`, not `false`/`true`), so `toBe(false)`/`toBe(true)` assertions fail.

- [ ] **Step 3: Add the field**

In `backend/src/services/map.ts`, change the `MapNode` interface:

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

to:

```ts
export interface MapNode {
  id: number | string;
  ttl: number;
  host: string;
  active: boolean;
  x: number;
  y: number;
  hasCustomPosition: boolean;
}
```

Change the node-building block:

```ts
    const nodes: MapNode[] = keptRows.map((n, idx) => {
      const pos = positions.get(n.id) ?? { x: idx * 220, y: n.active ? 0 : 140 };
      return { id: n.id, ttl: n.ttl, host: n.host, active: n.active === 1, x: pos.x, y: pos.y };
    });
```

to:

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
      };
    });
```

And in the synthetic-node creation inside `resolveGapChain`, change:

```ts
        syntheticNodesById.set(chainIds[i], {
          id: chainIds[i],
          ttl,
          host: NO_REPLY_HOST,
          active: false,
          x: ttl * 220,
          y: 140,
        });
```

to:

```ts
        syntheticNodesById.set(chainIds[i], {
          id: chainIds[i],
          ttl,
          host: NO_REPLY_HOST,
          active: false,
          x: ttl * 220,
          y: 140,
          hasCustomPosition: false,
        });
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: all tests PASS, including the two new ones.

Run: `cd backend && npm test`
Expected: all tests PASS (confirms no other backend code assumed `MapNode` had exactly these fields).

Run: `cd backend && npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/map.ts backend/src/services/map.test.ts
git commit -m "$(cat <<'EOF'
Flag MapNode with whether it has a saved (dragged) position

The frontend is about to gain a real default-layout algorithm and
needs to know which nodes it's actually allowed to reposition versus
which ones carry a user's saved drag — the backend already builds a
node_positions lookup map per request, so exposing whether a given
node hit it is a one-line addition.
EOF
)"
```

---

### Task 2: Frontend — `lib/layout.ts` auto-layout module

**Files:**
- Create: `frontend/src/lib/layout.ts`
- Test: `frontend/src/lib/layout.test.ts`

**Interfaces:**
- Produces: `computeAutoLayout(nodes: LayoutHopNode[], avgLatencyMsByTtl: Map<number, number>, options?: LayoutOptions): Map<string, { x: number; y: number }>`, plus the exported `LayoutHopNode`/`LayoutOptions` types. Consumed by Task 3.
- This module has no dependency on React, React Flow, or the `MapNode`/`MapEdge` API types — it's pure and independently testable.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeAutoLayout, type LayoutHopNode } from './layout.js';

describe('computeAutoLayout', () => {
  it('places hops at strictly increasing x in ttl order when there is no latency data', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    const positions = computeAutoLayout(nodes, new Map());
    const x1 = positions.get('1')!.x;
    const x2 = positions.get('2')!.x;
    const x3 = positions.get('3')!.x;
    expect(x1).toBeLessThan(x2);
    expect(x2).toBeLessThan(x3);
  });

  it('gives a hop with a larger incremental latency a strictly larger x gap than one with ~0ms incremental latency', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    // ttl1->ttl2: 0ms incremental (both at 5ms cumulative avg).
    // ttl2->ttl3: 50ms incremental (5ms -> 55ms cumulative avg).
    const avgLatencyMsByTtl = new Map([
      [1, 5],
      [2, 5],
      [3, 55],
    ]);
    const positions = computeAutoLayout(nodes, avgLatencyMsByTtl);
    const gap12 = positions.get('2')!.x - positions.get('1')!.x;
    const gap23 = positions.get('3')!.x - positions.get('2')!.x;
    expect(gap23).toBeGreaterThan(gap12);
  });

  it('clamps an extreme latency delta to maxHopGap', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
    ];
    const avgLatencyMsByTtl = new Map([
      [1, 0],
      [2, 100000],
    ]);
    const positions = computeAutoLayout(nodes, avgLatencyMsByTtl, { maxHopGap: 420 });
    const gap = positions.get('2')!.x - positions.get('1')!.x;
    expect(gap).toBe(420);
  });

  it('stacks two stale nodes at the same ttl under that ttl\'s active node, same x, different y', () => {
    const nodes: LayoutHopNode[] = [
      { id: 'active', ttl: 2, active: true },
      { id: 'stale-a', ttl: 2, active: false },
      { id: 'stale-b', ttl: 2, active: false },
    ];
    const positions = computeAutoLayout(nodes, new Map());
    const activePos = positions.get('active')!;
    const staleA = positions.get('stale-a')!;
    const staleB = positions.get('stale-b')!;
    expect(staleA.x).toBe(activePos.x);
    expect(staleB.x).toBe(activePos.x);
    expect(staleA.y).toBeGreaterThan(activePos.y);
    expect(staleB.y).toBeGreaterThan(activePos.y);
    expect(staleA.y).not.toBe(staleB.y);
  });

  it('staggers consecutive active hops up/down instead of overlapping when the computed gap is forced tight', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    const options = {
      baseHopGap: 50,
      minHopGap: 50,
      maxHopGap: 50,
      nodeWidth: 170,
      nodeGap: 20,
      staggerY: 36,
    };
    const positions = computeAutoLayout(nodes, new Map(), options);
    const y1 = positions.get('1')!.y;
    const y2 = positions.get('2')!.y;
    const y3 = positions.get('3')!.y;
    expect(y1).toBe(0);
    expect(y2).not.toBe(0);
    expect(y3).not.toBe(0);
    expect(y3).not.toBe(y2);
  });

  it('gives a stale node a sensible position when its ttl has no active node at all', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: 'stale', ttl: 2, active: false },
    ];
    const positions = computeAutoLayout(nodes, new Map());
    const stalePos = positions.get('stale')!;
    expect(stalePos.x).toBeGreaterThan(positions.get('1')!.x);
    expect(stalePos.y).toBeGreaterThan(0);
  });

  it('returns an empty map for an empty node list', () => {
    expect(computeAutoLayout([], new Map()).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/layout.test.ts`
Expected: FAIL — `src/lib/layout.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Implement `layout.ts`**

Create `frontend/src/lib/layout.ts`:

```ts
// Pure default-layout computation for the network map. No React/React Flow
// dependency by design — this is a plain function over node TTL/active-state
// and a latency-per-TTL map, independently testable and independently
// reasoned about. NetworkMap.tsx is the only caller; it merges this output
// with any user-saved (dragged) positions before handing everything to the
// existing resolveOverlaps collision pass (lib/separation.ts), which is
// unchanged and remains the final safety net.
//
// See docs/superpowers/specs/2026-07-10-map-auto-layout-design.md for the
// full rationale behind each constant and the staggering/stacking rules.

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
  staggerY?: number;
  staleRowGap?: number;
  staleStackGap?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  nodeWidth: 170,
  nodeHeight: 64,
  nodeGap: 20,
  baseHopGap: 140,
  minHopGap: 90,
  maxHopGap: 420,
  latencyScalePxPerMs: 4,
  staggerY: 36,
  staleRowGap: 32,
  staleStackGap: 16,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeAutoLayout(
  nodes: LayoutHopNode[],
  avgLatencyMsByTtl: Map<number, number>,
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const opts = { ...DEFAULTS, ...options };
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const maxTtl = nodes.reduce((max, n) => Math.max(max, n.ttl), 0);

  // Step 1: x per ttl column, driven by incremental latency between consecutive ttls.
  const ttlX = new Map<number, number>();
  let prevAvg = 0;
  let x = 0;
  for (let ttl = 1; ttl <= maxTtl; ttl++) {
    const currAvg = avgLatencyMsByTtl.get(ttl) ?? prevAvg;
    if (ttl > 1) {
      const incremental = Math.max(0, currAvg - prevAvg);
      const gap = clamp(
        opts.baseHopGap + incremental * opts.latencyScalePxPerMs,
        opts.minHopGap,
        opts.maxHopGap,
      );
      x += gap;
    }
    ttlX.set(ttl, x);
    prevAvg = currAvg;
  }

  // Step 2: active row, staggered like stairs when adjacent hops sit closer
  // than a full node footprint apart — trades vertical space for horizontal
  // so the diagram stays narrow even when latency-driven spacing is tight.
  const activeByTtl = new Map<number, LayoutHopNode>();
  const staleByTtl = new Map<number, LayoutHopNode[]>();
  for (const n of nodes) {
    if (n.active) {
      activeByTtl.set(n.ttl, n);
    } else {
      const list = staleByTtl.get(n.ttl) ?? [];
      list.push(n);
      staleByTtl.set(n.ttl, list);
    }
  }

  const activeY = new Map<number, number>();
  let staggerParity = 0; // 0 = baseline; alternates +1/-1 while triggered
  let lastPlacedX: number | null = null;
  for (let ttl = 1; ttl <= maxTtl; ttl++) {
    const node = activeByTtl.get(ttl);
    if (!node) continue;
    const nodeX = ttlX.get(ttl) ?? 0;
    let y = 0;
    if (lastPlacedX !== null && nodeX - lastPlacedX < opts.nodeWidth + opts.nodeGap) {
      staggerParity = staggerParity <= 0 ? 1 : -1;
      y = staggerParity * opts.staggerY;
    } else {
      staggerParity = 0;
    }
    activeY.set(ttl, y);
    positions.set(node.id, { x: nodeX, y });
    lastPlacedX = nodeX;
  }

  // Step 3: stale/synthetic nodes stack under their ttl's active node (or the
  // ttl's computed column if nothing is active there), same x, gap below.
  for (const [ttl, staleNodes] of staleByTtl) {
    const nodeX = ttlX.get(ttl) ?? 0;
    const baseY = activeY.get(ttl) ?? 0;
    const sorted = staleNodes.slice().sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach((n, i) => {
      const y = baseY + opts.staleRowGap + i * (opts.nodeHeight + opts.staleStackGap);
      positions.set(n.id, { x: nodeX, y });
    });
  }

  return positions;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd frontend && npx vitest run src/lib/layout.test.ts`
Expected: all 7 tests PASS.

Run: `cd frontend && npm test`
Expected: all existing tests still PASS (this module isn't wired into anything yet, so nothing else can regress).

Run: `cd frontend && npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/layout.ts frontend/src/lib/layout.test.ts
git commit -m "$(cat <<'EOF'
Add pure auto-layout module for default map node positions

Computes hop x from incremental latency between ttls (clamped),
staggers the active row like stairs when that spacing would otherwise
force an overlap, and stacks stale/synthetic nodes under their ttl's
active node instead of spreading them sideways. Not wired into
NetworkMap yet — framework-free and independently tested first.
EOF
)"
```

---

### Task 3: Frontend — wire auto-layout into `NetworkMap.tsx`

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/NetworkMap.tsx`
- Test: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `computeAutoLayout` from Task 2, `MapNode.hasCustomPosition` from Task 1 (backend response shape).
- `MapNode.hasCustomPosition` on the frontend is `boolean | undefined` — see Global Constraints for why this is optional here even though it's required on the backend. Do not change any of the ~10 existing node literals in `NetworkMap.test.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/NetworkMap.test.tsx`, inside the main `describe('NetworkMap', ...)` block, right after the `"requests only the newly-seen host when a new hop is added"` test (before that describe block's closing `});`):

```ts
  it('renders a node with hasCustomPosition at exactly its given x/y, not an auto-computed one', () => {
    const customMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 150, y: 250, hasCustomPosition: true },
      ],
      edges: [],
    };
    render(<NetworkMap targetId={1} mapData={customMapData} />);
    const nodeEl = screen.getByText('192.168.1.1').closest('.react-flow__node') as HTMLElement;
    expect(nodeEl.style.transform).toBe('translate(150px,250px)');
  });

  it('renders a node without hasCustomPosition at an auto-computed position, not its raw backend x/y', () => {
    const autoMapData: MapResult = {
      nodes: [
        // x/y here mimic the backend's old idx*220 fallback deliberately, to
        // prove they're ignored once hasCustomPosition is false.
        { id: 1, ttl: 1, host: 'hop-a', active: true, x: 999, y: 999, hasCustomPosition: false },
      ],
      edges: [],
    };
    render(<NetworkMap targetId={1} mapData={autoMapData} />);
    const nodeEl = screen.getByText('hop-a').closest('.react-flow__node') as HTMLElement;
    expect(nodeEl.style.transform).not.toBe('translate(999px,999px)');
  });

  it('places a stale node directly under its active counterpart at the same ttl (auto layout)', () => {
    const staleUnderMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: 'active-hop', active: true, x: 0, y: 0, hasCustomPosition: false },
        { id: 2, ttl: 1, host: 'stale-hop', active: false, x: 0, y: 0, hasCustomPosition: false },
      ],
      edges: [{ id: '0-1', source: 0, target: 1, color: 'green', stale: false }],
    };
    render(<NetworkMap targetId={1} mapData={staleUnderMapData} />);
    const activeEl = screen.getByText('active-hop').closest('.react-flow__node') as HTMLElement;
    const staleEl = screen.getByText('stale-hop').closest('.react-flow__node') as HTMLElement;

    const parseTranslate = (t: string) => {
      const m = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t);
      return { x: Number(m![1]), y: Number(m![2]) };
    };
    const activePos = parseTranslate(activeEl.style.transform);
    const stalePos = parseTranslate(staleEl.style.transform);

    expect(stalePos.x).toBe(activePos.x);
    expect(stalePos.y).toBeGreaterThan(activePos.y);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx -t "hasCustomPosition"`
Expected: two failures — the "exactly its given x/y" test currently passes already (today everything renders at its raw x/y, so this one is coincidentally green — that's fine, it stays green through this change and isn't a meaningful RED signal on its own); the "auto-computed position, not its raw backend x/y" test FAILS because today the node renders at exactly `translate(999px,999px)`.

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx -t "directly under its active counterpart"`
Expected: FAIL — today both nodes render at their given `(0, 0)`, identical positions (before `resolveOverlaps` separates them along whichever axis has less overlap, which is not guaranteed to be a "same x, greater y" relationship) — the test's `stalePos.x === activePos.x` and `stalePos.y > activePos.y` assertions are not reliably satisfied by today's fallback + generic MTV separation.

- [ ] **Step 3: Widen the frontend `MapNode` type**

In `frontend/src/types.ts`, change:

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
}
```

- [ ] **Step 4: Wire `computeAutoLayout` into `initialNodes`**

In `frontend/src/components/NetworkMap.tsx`, add the import alongside the existing `separateBoxes` import:

```ts
import { separateBoxes } from '../lib/separation.js';
import { computeAutoLayout } from '../lib/layout.js';
```

Add a new memo for the per-ttl latency map, placed right before the `initialNodes` memo:

```ts
  // Built from the live (non-stale) edges only — a stale connector edge's
  // `latest` metrics describe a historical poll, not "how far this ttl
  // currently is," so it's not a meaningful input to today's default layout.
  const avgLatencyMsByTtl = useMemo(() => {
    const ttlById = new Map<string, number>();
    for (const n of mapData.nodes) ttlById.set(String(n.id), n.ttl);
    const byTtl = new Map<number, number>();
    for (const e of mapData.edges) {
      if (e.stale || e.latest == null) continue;
      const ttl = ttlById.get(String(e.target));
      if (ttl != null) byTtl.set(ttl, e.latest.avg);
    }
    return byTtl;
  }, [mapData.nodes, mapData.edges]);
```

Then change the `initialNodes` memo's node-building body. Find:

```ts
    const hopNodes: Node[] = mapData.nodes.map((n) => ({
      id: String(n.id),
      type: 'hopNode',
      position: { x: n.x, y: n.y },
      measured,
      handles,
      data: {
        host: n.host,
        ttl: n.ttl,
        active: historyActive != null ? isHistoricallyActive(n.ttl, n.host) : n.active,
      },
    }));
    return resolveOverlaps([sourceNode, ...hopNodes]);
    // Deliberately NOT keyed on whoisSummaries: this feeds nodeActiveById ->
    // initialEdges -> the effect that clears any open popup when edges
    // change. Coupling whois data into this memo would re-trigger that whole
    // chain (and FitViewOnChange's refit) every time a lazy whois summary
    // resolves, wiping out a just-opened popup — see displayNodes below,
    // which layers netname/country on afterward without touching this.
  }, [mapData.nodes, historyActive, isHistoricallyActive]);
```

Replace with:

```ts
    const autoPositions = computeAutoLayout(
      mapData.nodes.map((n) => ({ id: String(n.id), ttl: n.ttl, active: n.active })),
      avgLatencyMsByTtl,
      { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, nodeGap: NODE_GAP },
    );
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
    return resolveOverlaps([sourceNode, ...hopNodes]);
    // Deliberately NOT keyed on whoisSummaries: this feeds nodeActiveById ->
    // initialEdges -> the effect that clears any open popup when edges
    // change. Coupling whois data into this memo would re-trigger that whole
    // chain (and FitViewOnChange's refit) every time a lazy whois summary
    // resolves, wiping out a just-opened popup — see displayNodes below,
    // which layers netname/country on afterward without touching this.
  }, [mapData.nodes, avgLatencyMsByTtl, historyActive, isHistoricallyActive]);
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: all tests PASS, including the three new ones. Pay particular attention to any pre-existing test that might assert an exact position/transform value — per this plan's Global Constraints, none currently do (only `'never renders two nodes at the same position...'` inspects `style.transform`, and only for *uniqueness*, not exact values), so none should need modification. If one unexpectedly does depend on an exact value, treat that as a real finding to report, not something to silently patch around.

Run: `cd frontend && npm test`
Expected: all tests PASS.

Run: `cd frontend && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "$(cat <<'EOF'
Wire auto-layout into the map's default node positions

Nodes without a saved (dragged) position now get their default
x/y from computeAutoLayout (ttl-sequenced, latency-driven spacing,
stale nodes stacked under their active counterpart) instead of the
old array-index-based idx*220 fallback. A node with a saved position
is untouched, exactly as before. resolveOverlaps still runs as the
final collision safety net over the merged result.
EOF
)"
```
