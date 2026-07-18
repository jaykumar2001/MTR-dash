# Stale Hop Nodes Connected to the Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect stale (deactivated) hop nodes into the live network map at their TTL position instead of leaving them as disconnected floating boxes, styled dashed/grey to distinguish them from the active path, with a per-target cap on how many stale hosts show per TTL.

**Architecture:** Backend `MapService.getMap` gains a per-target `maxStaleHops` limit (new `targets.max_stale_hops` column) that bounds which inactive `path_nodes` rows are returned, and generates additional `stale: true` edges connecting each retained stale node to the *current* active nodes at the neighboring TTLs (no metrics, since a stale node carries no live traffic). Frontend renders `stale` edges dashed/grey via `MetricEdge`, suppresses the click-to-see-metrics popup for them, and hides them while a historical snapshot is being viewed (the scrubber reconstructs a specific point in time; today's stale connectors don't belong in that view).

**Tech Stack:** Hono + better-sqlite3 (backend), React + `@xyflow/react` + Vite (frontend), Vitest for both.

## Global Constraints

- `maxStaleHops` range: 0–5. Default: 1. (From spec.)
- Stale edges carry no `avgLossPct`/`latest` metrics — purely structural. (From spec.)
- Stale nodes connect to *today's* active neighbors, not a historically-accurate reconstruction. (From spec, non-goals.)
- No migration framework exists (`backend/src/db/schema.sql` is additive `CREATE TABLE IF NOT EXISTS`) — the new `targets` column needs its own idempotent `ALTER TABLE` guard in `db/client.ts` for pre-existing database files, in addition to the column appearing in `schema.sql` for fresh ones.
- Both `tsconfig.json`s use `strict: true`; there is no ESLint/Prettier. `npm run build` (`tsc`) is the only type-check gate.

---

### Task 1: Backend — `max_stale_hops` per-target config

**Files:**
- Modify: `backend/src/db/schema.sql` (targets table, ~line 1-8)
- Modify: `backend/src/db/client.ts`
- Modify: `backend/src/services/targets.ts`
- Modify: `backend/src/routes/targets.ts:22-26`
- Test: `backend/src/services/targets.test.ts`
- Test: `backend/src/routes/targets.test.ts`

**Interfaces:**
- Produces: `Target.maxStaleHops: number`, `CreateTargetInput.maxStaleHops?: number`, `UpdateTargetInput.maxStaleHops?: number` on `backend/src/services/targets.ts` — consumed by Task 2 (`MapService` reads the `max_stale_hops` column directly via SQL, not through this service, but the column must exist).

- [ ] **Step 1: Write the failing service tests**

Add to `backend/src/services/targets.test.ts` (inside the existing `describe('TargetsService', ...)` block, after the `'creates a target with custom interval and cycles'` test):

```ts
  it('creates a target with a default maxStaleHops of 1', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(target.maxStaleHops).toBe(1);
  });

  it('creates a target with a custom maxStaleHops', () => {
    const target = service.create({ host: '8.8.8.8', maxStaleHops: 3 });
    expect(target.maxStaleHops).toBe(3);
  });

  it('updates maxStaleHops', () => {
    const target = service.create({ host: '1.1.1.1' });
    const updated = service.update(target.id, { maxStaleHops: 0 });
    expect(updated?.maxStaleHops).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/targets.test.ts`
Expected: FAIL — `expect(target.maxStaleHops).toBe(1)` gets `undefined`.

- [ ] **Step 3: Add the column to the schema**

In `backend/src/db/schema.sql`, the `targets` table currently reads:

```sql
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  report_cycles INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Change it to:

```sql
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  report_cycles INTEGER NOT NULL DEFAULT 10,
  max_stale_hops INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Add an idempotent migration for pre-existing database files**

`CREATE TABLE IF NOT EXISTS` is a no-op against a database file that already has a `targets` table from before this change, so it won't gain the new column on its own. In `backend/src/db/client.ts`, replace:

```ts
export function createDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}
```

with:

```ts
function migrateTargetsMaxStaleHops(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(targets)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'max_stale_hops')) {
    db.exec('ALTER TABLE targets ADD COLUMN max_stale_hops INTEGER NOT NULL DEFAULT 1');
  }
}

export function createDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  migrateTargetsMaxStaleHops(db);
  return db;
}
```

- [ ] **Step 5: Wire `maxStaleHops` through `TargetsService`**

In `backend/src/services/targets.ts`, update each piece:

```ts
export interface Target {
  id: number;
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  maxStaleHops: number;
  enabled: boolean;
  createdAt: string;
}

export interface CreateTargetInput {
  host: string;
  intervalSeconds?: number;
  reportCycles?: number;
  maxStaleHops?: number;
}

export interface UpdateTargetInput {
  host?: string;
  intervalSeconds?: number;
  reportCycles?: number;
  maxStaleHops?: number;
  enabled?: boolean;
}

interface TargetRow {
  id: number;
  host: string;
  interval_seconds: number;
  report_cycles: number;
  max_stale_hops: number;
  enabled: number;
  created_at: string;
}

function toTarget(row: TargetRow): Target {
  return {
    id: row.id,
    host: row.host,
    intervalSeconds: row.interval_seconds,
    reportCycles: row.report_cycles,
    maxStaleHops: row.max_stale_hops,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}
```

And in the `create`/`update` methods:

```ts
  create(input: CreateTargetInput): Target {
    const intervalSeconds = input.intervalSeconds ?? 60;
    const reportCycles = input.reportCycles ?? 10;
    const maxStaleHops = input.maxStaleHops ?? 1;
    const result = this.db
      .prepare(
        'INSERT INTO targets (host, interval_seconds, report_cycles, max_stale_hops) VALUES (?, ?, ?, ?)',
      )
      .run(input.host, intervalSeconds, reportCycles, maxStaleHops);
    return this.get(result.lastInsertRowid as number)!;
  }

  update(id: number, input: UpdateTargetInput): Target | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...input };
    this.db
      .prepare(
        'UPDATE targets SET host = ?, interval_seconds = ?, report_cycles = ?, max_stale_hops = ?, enabled = ? WHERE id = ?',
      )
      .run(
        merged.host,
        merged.intervalSeconds,
        merged.reportCycles,
        merged.maxStaleHops,
        merged.enabled ? 1 : 0,
        id,
      );
    return this.get(id);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/targets.test.ts`
Expected: PASS (all tests including the 3 new ones).

- [ ] **Step 7: Write the failing route test**

Add to `backend/src/routes/targets.test.ts`, after `'rejects POST without a host'`:

```ts
  it('creates a target with a custom maxStaleHops via POST', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1', maxStaleHops: 2 }),
    });
    const body = await res.json();
    expect(body.maxStaleHops).toBe(2);
  });
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/targets.test.ts`
Expected: FAIL — `body.maxStaleHops` is `undefined`, not `2`.

- [ ] **Step 9: Pass `maxStaleHops` through the POST route**

In `backend/src/routes/targets.ts`, the POST handler currently reads:

```ts
    const target = targets.create({
      host: body.host,
      intervalSeconds: body.intervalSeconds,
      reportCycles: body.reportCycles,
    });
```

Change to:

```ts
    const target = targets.create({
      host: body.host,
      intervalSeconds: body.intervalSeconds,
      reportCycles: body.reportCycles,
      maxStaleHops: body.maxStaleHops,
    });
```

(The PATCH handler already forwards the entire request body to `targets.update(id, body)`, so `maxStaleHops` passes through it automatically — no change needed there.)

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/targets.test.ts src/services/targets.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
cd backend && git add src/db/schema.sql src/db/client.ts src/services/targets.ts src/services/targets.test.ts src/routes/targets.ts src/routes/targets.test.ts
git commit -m "Add per-target maxStaleHops config"
```

---

### Task 2: Backend — `MapService` stale node limiting and edge generation

**Files:**
- Modify: `backend/src/services/map.ts`
- Test: `backend/src/services/map.test.ts`

**Interfaces:**
- Consumes: `targets.max_stale_hops` column (Task 1).
- Produces: `MapEdge.stale: boolean`, `MapEdge.color` gains `'grey'`, `MapEdge.avgLossPct`/`MapEdge.latest` become optional — consumed by Task 5 (frontend `types.ts` mirrors this shape).

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/services/map.test.ts`, inside the existing `describe('MapService', ...)` block, after `'includes inactive nodes after a deviation'`:

```ts
  it('connects a stale node to the current active neighbors at ttl-1 and ttl+1', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'X', lossPct: 0 },
        { ttl: 3, host: 'Z', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Y', lossPct: 0 },
        { ttl: 3, host: 'Z', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeX = result.nodes.find((n) => n.host === 'X')!;
    const nodeZ = result.nodes.find((n) => n.host === 'Z')!;
    expect(nodeX.active).toBe(false);

    const inEdge = result.edges.find((e) => e.target === nodeX.id && e.stale);
    const outEdge = result.edges.find((e) => e.source === nodeX.id && e.stale);
    expect(inEdge?.source).toBe(nodeA.id);
    expect(outEdge?.target).toBe(nodeZ.id);
    expect(inEdge?.color).toBe('grey');
    expect(inEdge?.avgLossPct).toBeUndefined();
    expect(inEdge?.latest).toBeUndefined();
  });

  it('connects a stale ttl=1 node to the synthetic source', () => {
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const staleEdge = result.edges.find((e) => e.target === nodeA.id && e.stale);
    expect(staleEdge?.source).toBe(0);
  });

  it('limits stale nodes per ttl to maxStaleHops, keeping the most recently deactivated', () => {
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'C', lossPct: 0 }]));

    const result = map.getMap(targetId);
    const hosts = result.nodes.map((n) => n.host);
    expect(hosts).toContain('C');
    expect(hosts).toContain('B');
    expect(hosts).not.toContain('A');
  });

  it('omits stale nodes and edges entirely when maxStaleHops is 0', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 0 WHERE id = ?').run(targetId);
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));

    const result = map.getMap(targetId);
    expect(result.nodes.map((n) => n.host)).toEqual(['B']);
    expect(result.edges.every((e) => !e.stale)).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: FAIL — no stale edges exist yet (`inEdge`/`outEdge`/`staleEdge` are `undefined`), and the "limits stale nodes" test finds `'A'` still present since nothing is filtered out yet.

- [ ] **Step 3: Implement stale node limiting and edge generation**

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
  last_seen_at: string;
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
    const keptStaleIds = new Set<number>();
    for (const rows of staleByTtl.values()) {
      rows
        .slice()
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
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

    for (const [ttl, rows] of staleByTtl) {
      const kept = rows.filter((r) => keptStaleIds.has(r.id));
      for (const staleNode of kept) {
        const prevActive = activeByTtl.get(ttl - 1);
        const prevSourceId = ttl === 1 ? 0 : prevActive?.id;
        if (prevSourceId !== undefined) {
          edges.push({
            id: `${prevSourceId}-${staleNode.id}`,
            source: prevSourceId,
            target: staleNode.id,
            color: 'grey',
            stale: true,
          });
        }
        const nextActive = activeByTtl.get(ttl + 1);
        if (nextActive) {
          edges.push({
            id: `${staleNode.id}-${nextActive.id}`,
            source: staleNode.id,
            target: nextActive.id,
            color: 'grey',
            stale: true,
          });
        }
      }
    }

    return { nodes, edges };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: PASS (all tests, including the 4 new ones).

- [ ] **Step 5: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS — 102+ tests (existing count plus the 7 new tests from Tasks 1–2).

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/services/map.ts src/services/map.test.ts
git commit -m "Connect stale hop nodes to their active neighbors in MapService"
```

---

### Task 3: Frontend — `ConfigPanel` maxStaleHops setting

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/components/ConfigPanel.tsx`
- Test: `frontend/src/components/ConfigPanel.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (frontend types are a hand-maintained mirror of the backend shapes from Task 1, not shared code).
- Produces: `Target.maxStaleHops: number` on `frontend/src/types.ts`, `CreateTargetInput.maxStaleHops?`/`UpdateTargetInput.maxStaleHops?` on `frontend/src/api/client.ts` — no other task depends on these directly, but they must exist for `ConfigPanel` to compile.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/ConfigPanel.test.tsx`, replacing the `target` fixture and adding a new test. First, update the fixture at the top of the file:

```ts
const target: Target = {
  id: 1,
  host: '1.1.1.1',
  intervalSeconds: 60,
  reportCycles: 10,
  maxStaleHops: 1,
  enabled: true,
  createdAt: '2026-07-06T00:00:00.000Z',
};
```

Then add, after `'submits the edited interval and report cycles'`:

```ts
  it('submits the edited maxStaleHops', () => {
    const onSave = vi.fn();
    render(<ConfigPanel target={target} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/max stale hops/i), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledWith({
      intervalSeconds: 60,
      reportCycles: 10,
      maxStaleHops: 3,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ConfigPanel.test.tsx`
Expected: FAIL — `getByLabelText(/max stale hops/i)` finds no matching element yet.

- [ ] **Step 3: Add `maxStaleHops` to the shared types and API client**

In `frontend/src/types.ts`, update the `Target` interface:

```ts
export interface Target {
  id: number;
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  maxStaleHops: number;
  enabled: boolean;
  createdAt: string;
}
```

In `frontend/src/api/client.ts`, update both input interfaces:

```ts
export interface CreateTargetInput {
  host: string;
  intervalSeconds?: number;
  reportCycles?: number;
  maxStaleHops?: number;
}

export interface UpdateTargetInput {
  host?: string;
  intervalSeconds?: number;
  reportCycles?: number;
  maxStaleHops?: number;
  enabled?: boolean;
}
```

- [ ] **Step 4: Add the field to `ConfigPanel`**

Replace the full contents of `frontend/src/components/ConfigPanel.tsx` with:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import type { Target } from '../types.js';

interface ConfigPanelProps {
  target: Target;
  onSave: (values: { intervalSeconds: number; reportCycles: number; maxStaleHops: number }) => void;
}

export function ConfigPanel({ target, onSave }: ConfigPanelProps) {
  const [intervalSeconds, setIntervalSeconds] = useState(target.intervalSeconds);
  const [reportCycles, setReportCycles] = useState(target.reportCycles);
  const [maxStaleHops, setMaxStaleHops] = useState(target.maxStaleHops);

  // `target` is looked up fresh from App's `targets` list on every render,
  // not a value this component owns — if the target's config changes by any
  // means other than this form's own Save button (e.g. re-fetched after some
  // other update), the fields must follow it rather than silently keep
  // showing whatever was true when this component first mounted.
  useEffect(() => {
    setIntervalSeconds(target.intervalSeconds);
    setReportCycles(target.reportCycles);
    setMaxStaleHops(target.maxStaleHops);
  }, [target.id, target.intervalSeconds, target.reportCycles, target.maxStaleHops]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave({ intervalSeconds, reportCycles, maxStaleHops });
  }

  return (
    <form className="config-panel" onSubmit={handleSubmit}>
      <label>
        Interval (s)
        <input
          type="number"
          min={10}
          value={intervalSeconds}
          onChange={(e) => setIntervalSeconds(Number(e.target.value))}
        />
      </label>
      <label>
        Report cycles
        <input
          type="number"
          min={1}
          value={reportCycles}
          onChange={(e) => setReportCycles(Number(e.target.value))}
        />
      </label>
      <label>
        Max stale hops
        <input
          type="number"
          min={0}
          max={5}
          value={maxStaleHops}
          onChange={(e) => setMaxStaleHops(Number(e.target.value))}
        />
      </label>
      <button type="submit">Save</button>
    </form>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/ConfigPanel.test.tsx`
Expected: PASS (all tests, including the 2 tests that check field-following-prop behavior — they'll now also carry `maxStaleHops` through the spread `{...target}` fixtures already in the file, so no further edits needed there).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/types.ts src/api/client.ts src/components/ConfigPanel.tsx src/components/ConfigPanel.test.tsx
git commit -m "Add maxStaleHops setting to ConfigPanel"
```

---

### Task 4: Frontend — `MetricEdge` dashed/grey stale styling

**Files:**
- Modify: `frontend/src/components/MetricEdge.tsx`
- Test: `frontend/src/components/MetricEdge.test.tsx`

**Interfaces:**
- Produces: `MetricEdgeData.stale: boolean` (required), `MetricEdgeData.latest?: EdgeMetrics` (now optional), `MetricEdgeData.color` gains `'grey'` — consumed by Task 5 (`NetworkMap.tsx` constructs this data shape).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/src/components/MetricEdge.test.tsx` with:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { MetricEdge } from './MetricEdge.js';

const baseProps = {
  id: 'e1',
  source: '0',
  target: '1',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 0,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  data: {
    color: 'yellow' as const,
    active: true,
    stale: false,
    latest: { lossPct: 2, snt: 10, last: 1, avg: 1.2, best: 1, wrst: 1.5, stdev: 0.1 },
  },
};

describe('MetricEdge', () => {
  it('renders a curved (bezier) path colored by the edge data', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).not.toBeNull();
    expect(path).toHaveStyle({ stroke: 'yellow' });
    // A straight two-point path is a single "M x y L x y" segment; a bezier
    // path uses a "C" (cubic) command even between two simple points.
    expect(path?.getAttribute('d')).toMatch(/C/);
  });

  it('dashes the path when the edge is inactive', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, active: false }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ strokeDasharray: '6 4' });
  });

  it('renders grey and dashed when the edge is a stale connector', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge
            {...baseProps}
            data={{ color: 'grey', active: true, stale: true, latest: undefined }}
          />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ stroke: 'grey', strokeDasharray: '6 4' });
  });

  it('renders a thicker stroke when selected', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} selected />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ strokeWidth: '4' });
  });
});
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cd frontend && npx vitest run src/components/MetricEdge.test.tsx`
Expected: FAIL on `'renders grey and dashed when the edge is a stale connector'` — `strokeDasharray` is not yet set for a `stale: true` edge (current logic only checks `active`).

- [ ] **Step 3: Implement stale styling**

Replace the full contents of `frontend/src/components/MetricEdge.tsx` with:

```tsx
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EdgeMetrics } from '../types.js';

export interface MetricEdgeData extends Record<string, unknown> {
  color: 'green' | 'yellow' | 'red' | 'grey';
  latest?: EdgeMetrics;
  active: boolean;
  stale: boolean;
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
      }}
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/MetricEdge.test.tsx`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/components/MetricEdge.tsx src/components/MetricEdge.test.tsx
git commit -m "Style stale connector edges dashed and grey in MetricEdge"
```

---

### Task 5: Frontend — `NetworkMap` stale edge wiring and history-mode suppression

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/NetworkMap.tsx`
- Test: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `MetricEdgeData` shape from Task 4 (`{ color, latest?, active, stale }`).
- Produces: `MapEdge.stale: boolean`, `MapEdge.color` gains `'grey'`, `MapEdge.avgLossPct?`/`MapEdge.latest?` become optional on `frontend/src/types.ts` (mirrors the backend `MapEdge` shape from Task 2).

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/NetworkMap.test.tsx`, first update the shared `mapData` fixture near the top of the file to include `stale: false` on its existing edge:

```ts
const mapData: MapResult = {
  nodes: [{ id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 }],
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
  ],
};
```

Then add, after `'shows a metrics table at the click position when a link is clicked, and hides it on pane click'`:

```tsx
  it('renders a dashed grey edge for a stale connector', () => {
    const staleMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        { id: 2, ttl: 1, host: 'old-hop', active: false, x: 0, y: 140 },
      ],
      edges: [
        mapData.edges[0],
        { id: '0-2', source: 0, target: 2, color: 'grey', stale: true },
      ],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={staleMapData} />);
    const paths = container.querySelectorAll('path.react-flow__edge-path');
    expect(paths).toHaveLength(2);
    expect(paths[1]).toHaveStyle({ stroke: 'grey', strokeDasharray: '6 4' });
  });

  it('does not open the metrics popup when a stale edge is clicked', () => {
    const staleMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        { id: 2, ttl: 1, host: 'old-hop', active: false, x: 0, y: 140 },
      ],
      edges: [{ id: '0-2', source: 0, target: 2, color: 'grey', stale: true }],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={staleMapData} />);
    const edgePath = container.querySelector('path.react-flow__edge-path');
    fireEvent.click(edgePath!, { clientX: 300, clientY: 150 });
    expect(container.querySelector('.edge-metrics-table')).toBeNull();
  });

  it('hides stale connector edges while viewing a historical snapshot', () => {
    const staleMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        { id: 2, ttl: 1, host: 'old-hop', active: false, x: 0, y: 140 },
      ],
      edges: [
        mapData.edges[0],
        { id: '0-2', source: 0, target: 2, color: 'grey', stale: true },
      ],
    };
    const { container } = render(
      <NetworkMap
        targetId={1}
        mapData={staleMapData}
        historyActive={[{ ttl: 1, host: '192.168.1.1' }]}
      />,
    );
    const paths = container.querySelectorAll('path.react-flow__edge-path');
    expect(paths).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: FAIL — the stale edge currently renders solid (not dashed/grey, since `NetworkMap` doesn't yet pass `stale` into edge data), and it isn't filtered out in history mode.

- [ ] **Step 3: Update the shared `MapEdge` type**

In `frontend/src/types.ts`, update:

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

- [ ] **Step 4: Wire `stale` through edge construction, guard the click handler, and filter during history mode**

In `frontend/src/components/NetworkMap.tsx`, replace the `initialEdges` memo (currently at lines 222-241):

```tsx
  const initialEdges = useMemo<Edge[]>(
    () =>
      mapData.edges
        .filter((e) => !e.stale || historyActive == null)
        .map((e) => {
          const sourceNodeId = e.source === 0 ? SOURCE_NODE_ID : String(e.source);
          const targetNodeId = String(e.target);
          const active =
            historyActive != null
              ? (nodeActiveById.get(sourceNodeId) ?? false) &&
                (nodeActiveById.get(targetNodeId) ?? false)
              : true;
          return {
            id: e.id,
            source: sourceNodeId,
            target: targetNodeId,
            type: 'metricEdge',
            data: { color: e.color, latest: e.latest, active, stale: e.stale },
          };
        }),
    [mapData.edges, historyActive, nodeActiveById],
  );
```

And replace `handleEdgeClick` (currently at lines 265-272):

```tsx
  const handleEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    if ((edge.data as MetricEdgeData).stale) return;
    setPopup((current) =>
      current?.kind === 'edge' && current.edgeId === edge.id
        ? null
        : { kind: 'edge', edgeId: edge.id, clientX: event.clientX, clientY: event.clientY },
    );
  }, []);
```

(`MetricEdgeData` is already imported at the top of the file per the existing `import { MetricEdge, type MetricEdgeData } from './MetricEdge.js';`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 6: Run the full frontend suite and typecheck to check for regressions**

Run: `cd frontend && npm test && npm run build`
Expected: PASS — 56+ tests (existing count plus the 2 new tests from Task 3, 1 new test from Task 4, and 3 new tests from this task), and `tsc -b && vite build` completes with no type errors.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/types.ts src/components/NetworkMap.tsx src/components/NetworkMap.test.tsx
git commit -m "Render stale connector edges in NetworkMap, hidden during history playback"
```

---

### Task 6: Full-stack regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, no failures.

- [ ] **Step 2: Run the full backend build**

Run: `cd backend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 3: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: PASS, no failures.

- [ ] **Step 4: Run the full frontend build**

Run: `cd frontend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 5: Manually verify in the browser**

Start both dev servers (`cd backend && npm run dev`, `cd frontend && npm run dev`), add a target, let it run long enough to accumulate a route deviation (or seed one directly in the SQLite file), and confirm in the map view: the stale hop renders connected via dashed grey edges to its TTL neighbors, the ConfigPanel's "Max stale hops" field saves and reloads correctly, clicking a stale edge does nothing, and stale edges disappear while scrubbing to a historical timestamp.
