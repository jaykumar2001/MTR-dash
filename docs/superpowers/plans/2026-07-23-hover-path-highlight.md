# Hover-to-Highlight Full Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering any hop node or cable-run edge on the network map dims
everything except the complete connected route through it — origin to
wherever the chain ends — working identically for active and stale/
historical elements.

**Architecture:** A bidirectional BFS over the currently-rendered edge graph
(computed in `NetworkMap.tsx`, from whichever node/edge is hovered)
produces a `{nodeIds, edgeIds}` highlight set. A render-time-only derived
layer (`renderedNodes`/`renderedEdges`, analogous to the existing
`displayNodes` layer) adds a `dimmed` boolean into each element's `data`
without touching the position/selection-carrying `nodes`/`edges` state
itself. `HopNode` and `MetricEdge` render that `dimmed` flag as reduced
opacity.

**Tech Stack:** React + `@xyflow/react` (React Flow), Vitest + Testing
Library — no new dependencies, no backend changes.

## Global Constraints

- Frontend-only change. No backend/API modifications.
- The highlight computation must not feed into the `nodes`/`edges` state
  tracked by `useNodesState`/`useEdgesState` — it's a derived,
  render-time-only overlay (same reasoning as the existing `displayNodes`
  layer: avoids retriggering the fitView/popup-dismiss effect chain, which
  keys off that state's identity, on every hover).
- Must work identically for active and stale (`stale: true`) elements — no
  branching logic keyed on `active`/`stale` in the highlight computation
  itself.
- The host machine has no Node/npm installed — every npm/npx command runs
  inside a `node:20-bookworm-slim` container with the repo bind-mounted:
  ```bash
  docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c '<command>'
  ```
  `node_modules` is already populated — no `npm install` needed (no new
  dependency in this plan).
- Strict TypeScript (`strict: true`); Vitest is the only test runner; no
  ESLint/Prettier in this repo.

---

### Task 1: `HopNode` dimmed state

**Files:**
- Modify: `frontend/src/components/HopNode.tsx`
- Modify: `frontend/src/components/HopNode.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `HopNodeData` gains `dimmed?: boolean`. Task 3 (`NetworkMap.tsx`)
  sets this field when building `renderedNodes`.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `frontend/src/components/HopNode.test.tsx`, inside
the existing `describe('HopNode', ...)` block (anywhere after the existing
tests is fine):

```tsx
  it('applies the dimmed class when dimmed is true', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true, dimmed: true });
    expect(container.querySelector('.hop-node.dimmed')).not.toBeNull();
  });

  it('does not apply the dimmed class when dimmed is false or absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node.dimmed')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/HopNode.test.tsx'`
Expected: FAIL — no element with class `.hop-node.dimmed` is rendered (the
first new test fails; the second already passes trivially since nothing
sets `dimmed` yet — that's fine, TDD-of-an-addition only requires the new
*behavior*'s test to fail first).

- [ ] **Step 3: Implement**

Replace `frontend/src/components/HopNode.tsx` in full:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';
import * as Flags from 'country-flag-icons/react/3x2';
import { Copyable } from './Copyable.js';

export interface HopNodeData extends Record<string, unknown> {
  host: string;
  ttl: number;
  active: boolean;
  netname?: string | null;
  country?: string | null;
  city?: string | null;
  resolvedHost?: string | null;
  inferred?: boolean;
  dimmed?: boolean;
}

// `Flags` exports one component per ISO 3166-1 alpha-2 code (e.g. `Flags.US`);
// country codes come from the geoip lookup (a data source, not a fixed enum
// at compile time), so this is always a dynamic, string-keyed lookup.
const FlagComponents = Flags as unknown as Record<string, React.ComponentType>;

export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, city, resolvedHost, inferred, dimmed } =
    data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div
      className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}${inferred ? ' inferred' : ''}${dimmed ? ' dimmed' : ''}`}
      title={inferred ? 'Inferred from an earlier resolved path — not observed responding in this poll' : ''}
    >
      <Handle type="target" position={Position.Left} />
      <div className="hop-node-ttl">
        {isOrigin ? 'origin' : `ttl ${ttl}`}
        {FlagIcon && (
          <span className="hop-node-flag" title={country ?? undefined}>
            <FlagIcon />
          </span>
        )}
      </div>
      <div className="hop-node-host">
        <Copyable text={host} />
      </div>
      {resolvedHost && <div className="hop-node-hostname">{resolvedHost}</div>}
      {city && <div className="hop-node-geo">{country ? `${city}, ${country}` : city}</div>}
      {netname && <div className="hop-node-netname">{netname}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

In `frontend/src/styles.css`, in the base `.hop-node` rule (currently at
line 551), add an `opacity` transition alongside the existing `animation`
line:

```css
.hop-node {
  position: relative;
  width: 170px;
  padding: 0.6rem 0.75rem 0.55rem;
  background: linear-gradient(180deg, var(--surface-raised), var(--surface));
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  text-align: left;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.03) inset,
    var(--shadow-panel);
  animation: jack-power-on var(--motion-med) ease both;
  transition: opacity var(--motion-med) ease;
  cursor: pointer;
}
```

Then, immediately after the existing `.hop-node.inactive { ... }` rule
(currently ending at line 589), insert a new rule — placed *after*
`.inactive` so it wins the cascade when a node is both inactive (stale) and
dimmed at the same time (same specificity, later source order wins):

```css
.hop-node.dimmed {
  opacity: 0.2;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/HopNode.test.tsx'`
Expected: PASS — all tests, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HopNode.tsx frontend/src/components/HopNode.test.tsx frontend/src/styles.css
git commit -m "Add dimmed state to HopNode for path-hover highlighting"
```

---

### Task 2: `MetricEdge` dimmed state

**Files:**
- Modify: `frontend/src/components/MetricEdge.tsx`
- Modify: `frontend/src/components/MetricEdge.test.tsx`

**Interfaces:**
- Produces: `MetricEdgeData` gains `dimmed: boolean` (required — this
  interface already requires `active`/`stale`/`color` unconditionally,
  matching that convention; Task 3 always sets this field when building
  `renderedEdges`, so it's never actually missing at render time).

- [ ] **Step 1: Write the failing test**

Add this test to `frontend/src/components/MetricEdge.test.tsx`, inside the
existing `describe('MetricEdge', ...)` block:

```tsx
  it('reduces opacity when dimmed', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: true }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ opacity: '0.15' });
  });

  it('renders full opacity when not dimmed', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ opacity: '1' });
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/MetricEdge.test.tsx'`
Expected: FAIL — the rendered path has no `opacity` style set at all yet.

- [ ] **Step 3: Implement**

Replace `frontend/src/components/MetricEdge.tsx` in full:

```tsx
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EdgeMetrics } from '../types.js';

export interface MetricEdgeData extends Record<string, unknown> {
  color: 'green' | 'yellow' | 'red' | 'grey';
  latest?: EdgeMetrics;
  active: boolean;
  stale: boolean;
  dimmed: boolean;
}

/**
 * Renders only the cable-run path. The metrics table shown on click is owned
 * by NetworkMap (a single cursor-anchored overlay), not this component — see
 * NetworkMap.tsx's onEdgeClick handler.
 */
export function MetricEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeData = data as MetricEdgeData;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      interactionWidth={20}
      style={{
        stroke: edgeData.color,
        // Lets the hover/selected glow (styles.css) pick up this edge's own
        // color via `currentColor`, so the halo always matches the link.
        color: edgeData.color,
        strokeWidth: selected ? 4 : 3,
        strokeDasharray: edgeData.stale || !edgeData.active ? '6 4' : undefined,
        opacity: edgeData.dimmed ? 0.15 : 1,
      }}
    />
  );
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/MetricEdge.test.tsx'`
Expected: PASS — all tests, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MetricEdge.tsx frontend/src/components/MetricEdge.test.tsx
git commit -m "Add dimmed state to MetricEdge for path-hover highlighting"
```

---

### Task 3: Wire hover-triggered path highlighting into `NetworkMap`

**Files:**
- Modify: `frontend/src/components/NetworkMap.tsx`
- Modify: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `HopNodeData.dimmed` (Task 1), `MetricEdgeData.dimmed` (Task 2).

- [ ] **Step 1: Write the failing tests**

Add this fixture near the top of `frontend/src/components/NetworkMap.test.tsx`,
after the existing `mapData` constant (it models a branch point: the origin
connects to both an active two-hop chain and a separate stale hop, so a
hover on one branch must NOT highlight the other):

```tsx
const branchedMapData: MapResult = {
  nodes: [
    { id: 1, ttl: 1, host: 'active-1', active: true, x: 0, y: 0 },
    { id: 2, ttl: 2, host: 'active-2', active: true, x: 220, y: 0 },
    { id: 3, ttl: 1, host: 'stale-1', active: false, x: 0, y: 140 },
  ],
  edges: [
    {
      id: '0-1',
      source: 0,
      target: 1,
      color: 'green',
      stale: false,
      avgLossPct: 0,
      latest: { lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
    },
    {
      id: '1-2',
      source: 1,
      target: 2,
      color: 'green',
      stale: false,
      avgLossPct: 0,
      latest: { lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
    },
    { id: '0-3', source: 0, target: 3, color: 'grey', stale: true },
  ],
};
```

Add this new `describe('path hover highlighting', ...)` block at the end of
the file, inside the outer `describe('NetworkMap', ...)` block (i.e. before
its closing `});`):

```tsx
  describe('path hover highlighting', () => {
    it('hovering an active node dims only the unrelated branch, leaving its own route (including forward continuation) undimmed', () => {
      const { container } = render(<NetworkMap targetId={1} mapData={branchedMapData} />);
      const hoveredEl = screen.getByText('active-1').closest('.react-flow__node') as HTMLElement;

      fireEvent.mouseEnter(hoveredEl);

      const sourceEl = screen.getByText('this host').closest('.hop-node');
      const active1El = screen.getByText('active-1').closest('.hop-node');
      const active2El = screen.getByText('active-2').closest('.hop-node');
      const stale1El = screen.getByText('stale-1').closest('.hop-node');
      expect(sourceEl).not.toHaveClass('dimmed');
      expect(active1El).not.toHaveClass('dimmed');
      expect(active2El).not.toHaveClass('dimmed');
      expect(stale1El).toHaveClass('dimmed');

      const paths = container.querySelectorAll('path.react-flow__edge-path');
      expect(paths[0]).not.toHaveStyle({ opacity: '0.15' }); // 0-1
      expect(paths[1]).not.toHaveStyle({ opacity: '0.15' }); // 1-2
      expect(paths[2]).toHaveStyle({ opacity: '0.15' }); // 0-3 (stale branch)
    });

    it('hovering a stale node highlights its own historical branch, not the active chain', () => {
      render(<NetworkMap targetId={1} mapData={branchedMapData} />);
      const hoveredEl = screen.getByText('stale-1').closest('.react-flow__node') as HTMLElement;

      fireEvent.mouseEnter(hoveredEl);

      expect(screen.getByText('this host').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('stale-1').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('active-1').closest('.hop-node')).toHaveClass('dimmed');
      expect(screen.getByText('active-2').closest('.hop-node')).toHaveClass('dimmed');
    });

    it('hovering an edge highlights the full route through both its endpoints', () => {
      const { container } = render(<NetworkMap targetId={1} mapData={branchedMapData} />);
      const paths = container.querySelectorAll('path.react-flow__edge-path');
      // paths[1] is the 1-2 edge (active-1 -> active-2); hovering it should
      // pull in the source and active-1 too, via the endpoint traversal.
      fireEvent.mouseEnter(paths[1]);

      expect(screen.getByText('this host').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('active-1').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('active-2').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('stale-1').closest('.hop-node')).toHaveClass('dimmed');
    });

    it('clears all dimming on mouse leave', () => {
      render(<NetworkMap targetId={1} mapData={branchedMapData} />);
      const hoveredEl = screen.getByText('active-1').closest('.react-flow__node') as HTMLElement;

      fireEvent.mouseEnter(hoveredEl);
      expect(screen.getByText('stale-1').closest('.hop-node')).toHaveClass('dimmed');

      fireEvent.mouseLeave(hoveredEl);
      expect(screen.getByText('stale-1').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('active-1').closest('.hop-node')).not.toHaveClass('dimmed');
    });

    it('hovering the origin node highlights the entire map', () => {
      render(<NetworkMap targetId={1} mapData={branchedMapData} />);
      const sourceEl = screen.getByText('this host').closest('.react-flow__node') as HTMLElement;

      fireEvent.mouseEnter(sourceEl);

      expect(screen.getByText('active-1').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('active-2').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('stale-1').closest('.hop-node')).not.toHaveClass('dimmed');
    });

    it('does not dim anything when nothing is hovered', () => {
      render(<NetworkMap targetId={1} mapData={branchedMapData} />);
      expect(screen.getByText('active-1').closest('.hop-node')).not.toHaveClass('dimmed');
      expect(screen.getByText('stale-1').closest('.hop-node')).not.toHaveClass('dimmed');
    });
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/NetworkMap.test.tsx'`
Expected: FAIL — the new `describe('path hover highlighting', ...)` tests
fail (no `dimmed` class is ever applied yet); all pre-existing tests in this
file still pass.

- [ ] **Step 3: Implement**

In `frontend/src/components/NetworkMap.tsx`, add the hover state and the
four React Flow event handlers. Insert this block immediately after the
existing `handleNodeClick` callback (which ends with `[popup],\n  );` — the
line before `const dismissPopup = useCallback(...)`):

```tsx
  // Hover state driving path-wide highlighting (see pathHighlight below).
  // Deliberately a single `{kind, id} | null` rather than separate
  // node/edge fields — only one element can be hovered at a time, and this
  // shape makes "nothing is hovered" a single, unambiguous `null` check.
  const [hoveredElement, setHoveredElement] = useState<
    { kind: 'node' | 'edge'; id: string } | null
  >(null);

  const handleNodeMouseEnter = useCallback((_event: React.MouseEvent, node: Node) => {
    setHoveredElement({ kind: 'node', id: node.id });
  }, []);

  // Guarded the same way handleNodeClick/handleEdgeClick already guard
  // against stale state: only clear if the element being left is still the
  // one currently tracked as hovered, so a fast pointer move from node A
  // straight onto node B can never have A's leave event clear B's just-set
  // hover.
  const handleNodeMouseLeave = useCallback((_event: React.MouseEvent, node: Node) => {
    setHoveredElement((current) =>
      current?.kind === 'node' && current.id === node.id ? null : current,
    );
  }, []);

  const handleEdgeMouseEnter = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setHoveredElement({ kind: 'edge', id: edge.id });
  }, []);

  const handleEdgeMouseLeave = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setHoveredElement((current) =>
      current?.kind === 'edge' && current.id === edge.id ? null : current,
    );
  }, []);

  // Two DIRECTIONAL walks over the currently-rendered edge graph, not one
  // undirected BFS: the graph is fully connected (every hop traces back to
  // the same origin), so a plain "visit any neighbor, either direction"
  // flood-fill from any starting point always reaches every node on the
  // map, regardless of which element was hovered — it can never dim
  // anything. Walking ancestors and descendants as two separate passes,
  // each following only its own direction, is what actually confines the
  // highlight to the hovered element's own route instead of leaking into
  // unrelated sibling branches (e.g. a stale connector hanging off the
  // same ancestor as the active chain).
  //
  // - Ancestors: from the start point, repeatedly take the edge(s) whose
  //   TARGET is the current node, moving to their SOURCE. Never explores
  //   an ancestor's other children — only the single path upward.
  // - Descendants: from the start point, repeatedly take the edge(s) whose
  //   SOURCE is the current node, moving to their TARGET. A node can have
  //   more than one outgoing edge (a shared historical neighbor for
  //   multiple since-diverged stale segments) — every branch downward from
  //   the hovered element is included, which is intentional.
  //
  // For a hovered NODE, both walks start at that node. For a hovered EDGE,
  // the ancestor walk starts at its `source` endpoint and the descendant
  // walk starts at its `target` endpoint — never both directions from both
  // endpoints, which would (again) leak into the source endpoint's other
  // children.
  const pathHighlight = useMemo(() => {
    if (!hoveredElement) return null;

    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    let ancestorStart: string;
    let descendantStart: string;

    if (hoveredElement.kind === 'node') {
      ancestorStart = hoveredElement.id;
      descendantStart = hoveredElement.id;
      nodeIds.add(hoveredElement.id);
    } else {
      const edge = edges.find((e) => e.id === hoveredElement.id);
      if (!edge) return null;
      ancestorStart = edge.source;
      descendantStart = edge.target;
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      edgeIds.add(edge.id);
    }

    const ancestorQueue = [ancestorStart];
    while (ancestorQueue.length > 0) {
      const current = ancestorQueue.shift() as string;
      for (const edge of edges) {
        if (edge.target !== current) continue;
        edgeIds.add(edge.id);
        if (!nodeIds.has(edge.source)) {
          nodeIds.add(edge.source);
          ancestorQueue.push(edge.source);
        }
      }
    }

    const descendantQueue = [descendantStart];
    while (descendantQueue.length > 0) {
      const current = descendantQueue.shift() as string;
      for (const edge of edges) {
        if (edge.source !== current) continue;
        edgeIds.add(edge.id);
        if (!nodeIds.has(edge.target)) {
          nodeIds.add(edge.target);
          descendantQueue.push(edge.target);
        }
      }
    }

    return { nodeIds, edgeIds };
  }, [hoveredElement, edges]);

  // Render-time-only layer, same reasoning as displayNodes above: adding
  // `dimmed` here (rather than into the `nodes`/`edges` state itself) means
  // a hover — which fires far more often than a click — never touches the
  // position/selection-carrying state or retriggers the effects keyed on
  // it. `renderedNodes`/`renderedEdges`, not `nodes`/`edges`, are what
  // actually get passed to <ReactFlow>.
  const renderedNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          dimmed: pathHighlight !== null && !pathHighlight.nodeIds.has(node.id),
        },
      })),
    [nodes, pathHighlight],
  );

  const renderedEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          dimmed: pathHighlight !== null && !pathHighlight.edgeIds.has(edge.id),
        },
      })),
    [edges, pathHighlight],
  );

```

Then update the `<ReactFlow>` element's props (currently starting at
`nodes={nodes}` / `edges={edges}` and including `onNodeClick`/
`onEdgeClick`) to pass the new derived arrays and wire the four handlers:

```tsx
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onEdgeMouseEnter={handleEdgeMouseEnter}
        onEdgeMouseLeave={handleEdgeMouseLeave}
        onPaneClick={dismissPopup}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        minZoom={0.1}
        fitView={initialViewport === null}
        fitViewOptions={{ padding: 0.15 }}
        defaultViewport={initialViewport ?? undefined}
      >
```

Everything else in the file (the `<ViewportController targetId={targetId}
nodes={initialNodes} />` line, `onNodesChange`/`onEdgesChange` still coming
from `useNodesState`/`useEdgesState`'s own setters, `clickedEdgeMetrics`
still reading from `edges`) stays exactly as it is — `onNodesChange`/
`onEdgesChange` continue to apply React Flow's change events to the real
`nodes`/`edges` state regardless of `renderedNodes`/`renderedEdges` being a
derived render-time view of it.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/NetworkMap.test.tsx'`
Expected: PASS — all tests, including the 6 new ones, and every
pre-existing test in this file (click popups, drag persistence, stale-edge
rendering, viewport, etc.) still green.

If `fireEvent.mouseEnter`/`mouseLeave` on the `.react-flow__node`/`path`
elements don't trigger React Flow's `onNodeMouseEnter`/`onEdgeMouseEnter`
props in this jsdom test environment (React Flow's internal event wiring
turns out to need something `fireEvent`'s synthetic dispatch doesn't
supply), that's a NEEDS_CONTEXT-worthy surprise, not something to route
around by testing the internal state/handlers directly instead of through
the DOM — stop and report it rather than guessing.

- [ ] **Step 5: Run the full frontend suite**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npm test'`
Expected: PASS — every frontend test, old and new (111 pre-existing + 2
from Task 1 + 2 from Task 2 + 6 from this task = 121).

Also run `tsc` to confirm the new `dimmed` field usage type-checks cleanly:

`docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx tsc -b --force'`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "Highlight the full hop path on hover, dimming the rest of the map"
```

---

### Task 4: Manual verification

**Files:** None (verification only).

- [ ] **Step 1: Start the frontend dev server against a running backend**

If a backend isn't already running for manual testing, start one (e.g.
`cd backend && npm run dev`, or use an existing running instance). Then:

`docker run --rm -p 5173:5173 -v /home/jkumar/Github/MTR-dash/frontend:/repo -w /repo node:20-bookworm-slim sh -c 'npm run dev -- --host'`

(or run directly if a local dev workflow is already set up outside Docker
for this verification step).

- [ ] **Step 2: Visually confirm in a browser**

Open the dashboard, select a target with a live multi-hop path (ideally one
with at least one stale/dashed segment — trigger a route change or use
`maxStaleHops` ≥ 1 on an existing target if needed). Hover several
different hop nodes and cable-run edges in turn and confirm:
- The full route through the hovered element stays bright; everything else
  dims.
- This works the same way whether the hovered element is on the active
  chain or a dashed stale segment.
- Moving the mouse off the map (or onto empty canvas) clears all dimming.
- Existing click behavior (edge metrics popup, node whois popup) still
  works exactly as before, and can coexist with a hover elsewhere on the
  map.

- [ ] **Step 3: Report status to the user**

No commit for this task — it's a verification checkpoint. Report the
outcome of Step 2 back to the user.
