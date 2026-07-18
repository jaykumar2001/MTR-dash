# Simplify Raw MTR Panel and Bottom Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only the latest poll's raw mtr values (no scrolling history), and move both the
raw-values table and the deviation timeline to a bottom row so the map gets full width.

**Architecture:** `RawMtrPanel`'s prop shape changes from a list of runs to a single run;
`App.tsx` fetches with `limit=1` instead of the default 50 and restructures its layout from a
three-column row (raw panel | map | deviations) to a full-width map with a bottom two-column row
(raw panel | deviations). No backend changes — `GET /api/targets/:id/runs?limit=N` already
supports `limit=1`.

**Tech Stack:** React + Vite (frontend), Vitest + Testing Library.

## Global Constraints

- No backend changes in this plan.
- Raw-values panel shows exactly one run (the latest), replaced in place on every refetch — never
  a list/history.
- Layout: map is full-width, taking the primary vertical space. Below it, a fixed-height bottom
  row holds the raw-values table (left half) and deviation timeline (right half), each
  independently scrollable if their content overflows.
- Both `tsconfig.json`s use `strict: true`; there is no ESLint/Prettier. `npm run build` (`tsc`)
  is the only type-check gate.

---

### Task 1: `RawMtrPanel` — single-run prop

**Files:**
- Modify: `frontend/src/components/RawMtrPanel.tsx`
- Modify: `frontend/src/components/RawMtrPanel.test.tsx`

**Interfaces:**
- Produces: `RawMtrPanelProps { run: RunHistoryEntry | null }` (replaces the prior
  `{ runs: RunHistoryEntry[] }`) — consumed by Task 2 (`App.tsx`).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/src/components/RawMtrPanel.test.tsx` with:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RawMtrPanel } from './RawMtrPanel.js';
import type { RunHistoryEntry } from '../types.js';

const run: RunHistoryEntry = {
  id: 2,
  startedAt: '2026-07-08T10:01:00.000Z',
  hops: [
    { ttl: 1, host: '10.0.0.1', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
  ],
};

describe('RawMtrPanel', () => {
  it("renders the given run's hop rows", () => {
    render(<RawMtrPanel run={run} />);
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
  });

  it('renders the run header timestamp', () => {
    const { container } = render(<RawMtrPanel run={run} />);
    const header = container.querySelector('.raw-mtr-run-header');
    expect(header?.textContent).toContain(new Date('2026-07-08T10:01:00.000Z').toLocaleString());
  });

  it('still renders a table for a run with no hops', () => {
    const emptyRun: RunHistoryEntry = { id: 1, startedAt: '2026-07-08T10:00:00.000Z', hops: [] };
    const { container } = render(<RawMtrPanel run={emptyRun} />);
    expect(container.querySelector('.raw-mtr-table')).not.toBeNull();
  });

  it('renders nothing extra when run is null', () => {
    const { container } = render(<RawMtrPanel run={null} />);
    expect(container.querySelector('.raw-mtr-run')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/RawMtrPanel.test.tsx`
Expected: FAIL — the current component destructures `runs` (an array) from props, so `run={run}`
leaves `runs` undefined and `runs.map` throws.

- [ ] **Step 3: Implement the single-run component**

Replace the full contents of `frontend/src/components/RawMtrPanel.tsx` with:

```tsx
import type { RunHistoryEntry } from '../types.js';

interface RawMtrPanelProps {
  run: RunHistoryEntry | null;
}

export function RawMtrPanel({ run }: RawMtrPanelProps) {
  return (
    <div className="raw-mtr-panel">
      <h3>Raw MTR Values</h3>
      {run && (
        <div className="raw-mtr-run">
          <div className="raw-mtr-run-header">{new Date(run.startedAt).toLocaleString()}</div>
          <table className="raw-mtr-table">
            <thead>
              <tr>
                <th>ttl</th>
                <th>host</th>
                <th>loss%</th>
                <th>snt</th>
                <th>last</th>
                <th>avg</th>
                <th>best</th>
                <th>wrst</th>
                <th>stdev</th>
              </tr>
            </thead>
            <tbody>
              {run.hops.map((hop) => (
                <tr key={hop.ttl}>
                  <td>{hop.ttl}</td>
                  <td>{hop.host}</td>
                  <td>{hop.lossPct}</td>
                  <td>{hop.snt}</td>
                  <td>{hop.last}</td>
                  <td>{hop.avg}</td>
                  <td>{hop.best}</td>
                  <td>{hop.wrst}</td>
                  <td>{hop.stdev}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/RawMtrPanel.test.tsx`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/components/RawMtrPanel.tsx src/components/RawMtrPanel.test.tsx
git commit -m "Show only the latest poll in RawMtrPanel instead of a scrolling history"
```

---

### Task 2: Layout — full-width map, bottom row for both tables

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `RawMtrPanelProps { run: RunHistoryEntry | null }` (Task 1).

- [ ] **Step 1: Write the failing test**

In `frontend/src/App.test.tsx`, replace the existing test
`'renders the raw-values panel, map, and deviation timeline in that left-to-right order'` with:

```tsx
  it('renders the map full-width above a bottom row containing the raw-values table and deviation timeline', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));
    expect(api.getRunHistory).toHaveBeenCalledWith(1, 1);

    const mainEl = document.querySelector('main') as HTMLElement;
    const mainChildClasses = Array.from(mainEl.children).map((el) => el.className);
    const mapIndex = mainChildClasses.findIndex((c) => c.includes('network-map'));
    const bottomIndex = mainChildClasses.findIndex((c) => c.includes('bottom-panels'));
    expect(mapIndex).toBeGreaterThan(-1);
    expect(bottomIndex).toBeGreaterThan(mapIndex);

    const bottomPanels = mainEl.children[bottomIndex] as HTMLElement;
    const children = Array.from(bottomPanels.children).map((el) => el.className);
    expect(children[0]).toContain('raw-mtr-panel');
    expect(children[1]).toContain('deviation-timeline');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL — `.bottom-panels` doesn't exist yet (`bottomIndex` is `-1`), and
`api.getRunHistory` is currently called with just `(1)`, not `(1, 1)`.

- [ ] **Step 3: Update `App.tsx`'s fetch and layout**

In `frontend/src/App.tsx`, change the `refreshMap` callback's run-history fetch from:

```tsx
    api.getRunHistory(targetId).then(setRunHistory);
```

to:

```tsx
    api.getRunHistory(targetId, 1).then(setRunHistory);
```

Then replace the `<div className="main-columns">...</div>` block (currently wrapping
`RawMtrPanel`, `NetworkMap`, and `DeviationTimeline`) with:

```tsx
            <NetworkMap
              targetId={selectedTarget.id}
              mapData={mapData}
              historyActive={historyActive}
            />
            <div className="bottom-panels">
              <RawMtrPanel run={runHistory[0] ?? null} />
              <DeviationTimeline
                deviations={deviations}
                onScrub={(at) => {
                  api
                    .getHistory(selectedTarget.id, at)
                    .then((result) => setHistoryActive(result.active));
                }}
              />
            </div>
```

(`NetworkMap` is now a direct sibling of `ConfigPanel`/the history banner inside `<main>`, not
nested inside a three-column wrapper; `RawMtrPanel` and `DeviationTimeline` move into the new
`.bottom-panels` row below it.)

- [ ] **Step 4: Update layout CSS**

In `frontend/src/styles.css`, replace the `.main-columns` block (currently right after `main {
... }`, around line 299):

```css
.main-columns {
  display: flex;
  flex: 1;
  min-height: 0;
}
```

with:

```css
.bottom-panels {
  display: flex;
  flex-shrink: 0;
  height: 220px;
}
```

(`NetworkMap`'s own `.network-map { flex: 1; ... }` rule, unchanged, now sizes it directly as a
column-flex child of `main` again — the same way it sized before the three-column layout existed.)

Replace the `.raw-mtr-panel` block (around line 801):

```css
.raw-mtr-panel {
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 0.5rem 1rem 0.7rem;
  overflow-y: auto;
  min-width: 0;
  width: 320px;
  flex-shrink: 0;
}
```

with:

```css
.raw-mtr-panel {
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-right: 1px solid var(--border);
  padding: 0.5rem 1rem 0.7rem;
  overflow-y: auto;
  min-width: 0;
  flex: 1;
}
```

Replace the `.deviation-timeline` block (around line 858):

```css
.deviation-timeline {
  background: var(--surface);
  border-left: 1px solid var(--border);
  padding: 0.5rem 1rem 0.7rem;
  overflow-y: auto;
  min-width: 0;
  width: 320px;
  flex-shrink: 0;
}
```

with:

```css
.deviation-timeline {
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding: 0.5rem 1rem 0.7rem;
  overflow-y: auto;
  min-width: 0;
  flex: 1;
}
```

(`raw-mtr-panel`'s own `border-right` already divides the two halves, so `deviation-timeline`
doesn't need its own left border too.)

In the `@media (max-width: 760px) { ... }` block near the bottom of the file, replace:

```css
  .main-columns {
    flex-direction: column;
  }

  .raw-mtr-panel,
  .deviation-timeline {
    width: auto;
    max-height: 200px;
    flex-shrink: 1;
  }
```

with:

```css
  .bottom-panels {
    flex-direction: column;
    height: auto;
  }

  .raw-mtr-panel,
  .deviation-timeline {
    max-height: 200px;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: PASS (all tests, including the rewritten one)

- [ ] **Step 6: Run the full frontend suite and typecheck to check for regressions**

Run: `cd frontend && npm test && npm run build`
Expected: PASS — all tests green, zero type errors. (Note: `App.test.tsx`'s
`'loads targets and shows the selected target host in the config panel'` test has a known
pre-existing intermittent flake unrelated to this change, documented in `HANDOFF.md`'s known
issues — if only that specific test fails, re-run once before treating it as a real regression.)

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/App.tsx src/App.test.tsx src/styles.css
git commit -m "Move raw-values table and deviations to a bottom row, giving the map full width"
```

---

### Task 3: Full-stack regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: PASS, no failures beyond the known pre-existing flaky test noted in Task 2 Step 6.

- [ ] **Step 2: Run the full frontend build**

Run: `cd frontend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 3: Run the full backend suite (unaffected by this plan, confirm no accidental breakage)**

Run: `cd backend && npm test`
Expected: PASS, no failures — this plan makes no backend changes.

- [ ] **Step 4: Run the full backend build**

Run: `cd backend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 5: Manually verify in the browser**

Start both dev servers (`cd backend && npm run dev`, `cd frontend && npm run dev`), select a
target with at least one completed poll, and confirm: the map spans the full width of the main
content area; below it, a bottom row shows the raw mtr values table (left) and the deviation
timeline (right) side by side; the raw values table shows only the most recent poll and updates
in place (no growing list) as new polls arrive.
