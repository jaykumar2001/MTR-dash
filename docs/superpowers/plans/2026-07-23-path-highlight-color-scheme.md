# Path-Highlight Color Scheme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hop nodes and cable-run edges on the hovered path get an explicit,
contrasting accent-colored highlight treatment, instead of just being left
unstyled while everything else dims.

**Architecture:** A third per-element boolean, `highlighted`, computed
alongside the existing `dimmed` in `NetworkMap.tsx`'s `renderedNodes`/
`renderedEdges` memos (from the same `pathHighlight` set — mutually
exclusive with `dimmed` by construction). `HopNode` renders it as a new
`.path-highlighted` CSS class (accent border + glow, forced full opacity).
`MetricEdge` renders it as a thicker stroke plus an accent `drop-shadow`
filter, applied via inline style so it wins over the existing subtle
per-edge hover glow — without touching the edge's `stroke` (the
green/yellow/red/grey loss-status color, a fixed signal never overridden
by highlighting).

**Tech Stack:** React + `@xyflow/react`, Vitest + Testing Library — no new
dependencies, no backend changes. Pure follow-up to the already-shipped
hover-path-highlight feature; no changes to path-computation logic.

## Global Constraints

- Frontend-only change. No backend/API modifications.
- The edge's `stroke`/`color` (loss-status signal) must never change based
  on `highlighted` — only `strokeWidth` and `filter` may.
- The highlight color comes from the theme's existing `--accent`/
  `--accent-strong` custom properties — never a new fixed color.
- `dimmed` and `highlighted` are mutually exclusive (an element is either
  on the hovered path or it isn't) — this plan does not change the
  `pathHighlight` computation itself, only what gets read from it.
- Strict TypeScript (`strict: true`); Vitest is the only test runner; no
  ESLint/Prettier in this repo.
- The host machine has no Node/npm installed — every npm/npx command runs
  inside a `node:20-bookworm-slim` container with the repo bind-mounted:
  ```bash
  docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c '<command>'
  ```
  `node_modules` is already populated — no `npm install` needed.

---

### Task 1: `HopNode` path-highlighted state

**Files:**
- Modify: `frontend/src/components/HopNode.tsx`
- Modify: `frontend/src/components/HopNode.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `HopNodeData` gains `highlighted?: boolean`. Task 3
  (`NetworkMap.tsx`) sets this field when building `renderedNodes`.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `frontend/src/components/HopNode.test.tsx`, inside
the existing `describe('HopNode', ...)` block (anywhere after the existing
tests is fine):

```tsx
  it('applies the path-highlighted class when highlighted is true', () => {
    const { container } = renderNode({
      host: '192.168.1.1',
      ttl: 3,
      active: true,
      highlighted: true,
    });
    expect(container.querySelector('.hop-node.path-highlighted')).not.toBeNull();
  });

  it('does not apply the path-highlighted class when highlighted is false or absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node.path-highlighted')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/HopNode.test.tsx'`
Expected: FAIL — no element with class `.hop-node.path-highlighted` is
rendered yet.

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
  highlighted?: boolean;
}

// `Flags` exports one component per ISO 3166-1 alpha-2 code (e.g. `Flags.US`);
// country codes come from the geoip lookup (a data source, not a fixed enum
// at compile time), so this is always a dynamic, string-keyed lookup.
const FlagComponents = Flags as unknown as Record<string, React.ComponentType>;

export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, city, resolvedHost, inferred, dimmed, highlighted } =
    data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div
      className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}${inferred ? ' inferred' : ''}${dimmed ? ' dimmed' : ''}${highlighted ? ' path-highlighted' : ''}`}
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

In `frontend/src/styles.css`, immediately after the existing
`.hop-node.origin { ... }` rule (currently ending at line 605, right
before `.hop-node.origin .hop-node-ttl`), insert a new rule — placed
*after* `.inactive`/`.dimmed`/`.origin` so it wins the cascade whenever it
applies alongside any of them (equal specificity, later source order
wins), including a highlighted origin node:

```css
.hop-node.path-highlighted {
  opacity: 1;
  border-color: var(--accent-strong);
  box-shadow:
    0 0 0 2px var(--accent) inset,
    0 0 16px 2px var(--accent);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/HopNode.test.tsx'`
Expected: PASS — all tests, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HopNode.tsx frontend/src/components/HopNode.test.tsx frontend/src/styles.css
git commit -m "Add path-highlighted accent state to HopNode"
```

---

### Task 2: `MetricEdge` highlighted state

**Files:**
- Modify: `frontend/src/components/MetricEdge.tsx`
- Modify: `frontend/src/components/MetricEdge.test.tsx`

**Interfaces:**
- Produces: `MetricEdgeData` gains `highlighted: boolean` (required,
  matching `dimmed`'s convention). Task 3 (`NetworkMap.tsx`) sets this
  field when building `renderedEdges`.

- [ ] **Step 1: Write the failing tests**

Add these three tests to `frontend/src/components/MetricEdge.test.tsx`,
inside the existing `describe('MetricEdge', ...)` block:

```tsx
  it('increases stroke width and adds an accent glow when highlighted', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false, highlighted: true }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ strokeWidth: '5' });
    expect(path?.getAttribute('style')).toMatch(/drop-shadow/);
  });

  it('keeps the loss-status stroke color unchanged when highlighted', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false, highlighted: true }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ stroke: 'yellow' });
  });

  it('applies no glow filter when not highlighted', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false, highlighted: false }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path?.getAttribute('style')).not.toMatch(/drop-shadow/);
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/MetricEdge.test.tsx'`
Expected: FAIL — `highlighted` doesn't exist on `MetricEdgeData` yet (a
TypeScript error surfaced as a test failure) and no `strokeWidth`/`filter`
change occurs.

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
  highlighted: boolean;
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
        // stroke/color (the loss-status signal) are never affected by
        // `highlighted` — see this plan's Global Constraints.
        stroke: edgeData.color,
        // Lets the hover/selected glow (styles.css) pick up this edge's own
        // color via `currentColor`, so the halo always matches the link.
        color: edgeData.color,
        strokeWidth: edgeData.highlighted ? 5 : selected ? 4 : 3,
        strokeDasharray: edgeData.stale || !edgeData.active ? '6 4' : undefined,
        opacity: edgeData.dimmed ? 0.15 : 1,
        // Inline `filter` takes precedence over styles.css's `:hover`/
        // `.selected` currentColor glow rule for the specific edge under
        // the cursor — intentional: it ends up with the same prominent
        // accent glow as the rest of its highlighted route, not a dimmer
        // self-only one.
        filter: edgeData.highlighted
          ? 'drop-shadow(0 0 3px var(--accent-strong)) drop-shadow(0 0 8px var(--accent))'
          : undefined,
      }}
    />
  );
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/MetricEdge.test.tsx'`
Expected: PASS — all tests, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MetricEdge.tsx frontend/src/components/MetricEdge.test.tsx
git commit -m "Add highlighted accent glow to MetricEdge"
```

---

### Task 3: Wire `highlighted` into `NetworkMap`'s render-time overlay

**Files:**
- Modify: `frontend/src/components/NetworkMap.tsx`
- Modify: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `HopNodeData.highlighted` (Task 1), `MetricEdgeData.highlighted`
  (Task 2).

- [ ] **Step 1: Update the two existing tests that exercise dimming to also assert highlighting**

In `frontend/src/components/NetworkMap.test.tsx`, inside the existing
`describe('path hover highlighting', ...)` block, replace this test:

```tsx
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
```

with:

```tsx
    it('hovering an active node dims only the unrelated branch, leaving its own route (including forward continuation) undimmed and highlighted', () => {
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
      expect(sourceEl).toHaveClass('path-highlighted');
      expect(active1El).toHaveClass('path-highlighted');
      expect(active2El).toHaveClass('path-highlighted');
      expect(stale1El).not.toHaveClass('path-highlighted');

      const paths = container.querySelectorAll('path.react-flow__edge-path');
      expect(paths[0]).not.toHaveStyle({ opacity: '0.15' }); // 0-1
      expect(paths[1]).not.toHaveStyle({ opacity: '0.15' }); // 1-2
      expect(paths[2]).toHaveStyle({ opacity: '0.15' }); // 0-3 (stale branch)
      expect(paths[0]).toHaveStyle({ strokeWidth: '5' }); // 0-1, highlighted
      expect(paths[1]).toHaveStyle({ strokeWidth: '5' }); // 1-2, highlighted
      expect(paths[2]).not.toHaveStyle({ strokeWidth: '5' }); // 0-3, not highlighted
    });
```

Then replace this test:

```tsx
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
```

with:

```tsx
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
      expect(screen.getByText('this host').closest('.hop-node')).toHaveClass('path-highlighted');
      expect(screen.getByText('active-1').closest('.hop-node')).toHaveClass('path-highlighted');
      expect(screen.getByText('active-2').closest('.hop-node')).toHaveClass('path-highlighted');
      expect(screen.getByText('stale-1').closest('.hop-node')).not.toHaveClass('path-highlighted');
    });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/NetworkMap.test.tsx'`
Expected: FAIL — the new `.path-highlighted`/`strokeWidth: '5'` assertions
fail (nothing sets `highlighted` yet); all other pre-existing tests in this
file still pass.

- [ ] **Step 3: Implement**

In `frontend/src/components/NetworkMap.tsx`, replace the `renderedNodes`
and `renderedEdges` memos:

```tsx
  const renderedNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          dimmed: pathHighlight !== null && !pathHighlight.nodeIds.has(node.id),
          highlighted: pathHighlight !== null && pathHighlight.nodeIds.has(node.id),
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
          highlighted: pathHighlight !== null && pathHighlight.edgeIds.has(edge.id),
        },
      })),
    [edges, pathHighlight],
  );
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/NetworkMap.test.tsx'`
Expected: PASS — all tests, including the two updated ones, and every
other pre-existing test in this file unchanged.

- [ ] **Step 5: Run the full frontend suite and `tsc`**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npm test'`
Expected: PASS — every frontend test, old and new (121 pre-existing + 2
from Task 1 + 3 from Task 2 = 126; the 2 tests changed in this task
replace, not add to, existing ones, so the net count stays 126).

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx tsc -b --force'`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "Wire highlighted accent state into NetworkMap's render overlay"
```

---

### Task 4: Manual verification

**Files:** None (verification only).

- [ ] **Step 1: Start the frontend dev server against a running backend**

`docker run --rm -p 5173:5173 -v /home/jkumar/Github/MTR-dash/frontend:/repo -w /repo node:20-bookworm-slim sh -c 'npm run dev -- --host'`

(or point at an already-running backend instance's proxy target, per
`vite.config.ts`).

- [ ] **Step 2: Visually confirm in a browser**

Hover several hop nodes and cable-run edges on a real multi-hop path
(ideally with at least one stale/dashed segment). Confirm:
- Path nodes get a visible accent-colored border/glow; the box is fully
  opaque even if it's a stale (normally translucent) node.
- Path edges get thicker, glowing lines — but still their original
  green/yellow/red/grey color, not recolored.
- The highlight color matches the app's current theme accent (switch
  themes via the theme switcher and confirm the highlight color changes
  with it).
- Everything off the path still dims as before (unchanged from the prior
  feature).

- [ ] **Step 3: Report status to the user**

No commit for this task — it's a verification checkpoint.
