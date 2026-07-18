# MTR Network Path Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Hono + Vite dashboard that runs `mtr` against configured targets every N seconds, persists path/metrics/deviation history in SQLite, and visualizes the path as a draggable, color-coded node graph.

**Architecture:** A Hono (Node.js) backend owns an in-process scheduler that shells out to a from-source-built `mtr` binary per target, ingests JSON reports into SQLite (targets/runs/hops/path_nodes/node_positions/deviations tables), and exposes REST + SSE endpoints. A Vite + React + TypeScript frontend (React Flow canvas) renders the cumulative path per target, colors edges by rolling-average loss, and persists dragged node positions.

**Tech Stack:** Node.js 20, TypeScript, Hono, `@hono/node-server`, `better-sqlite3`, Vite, React 18, `@xyflow/react` (React Flow v12), Vitest + Testing Library, Docker multi-stage build, docker-compose.

Spec: `docs/superpowers/specs/2026-07-06-mtr-dashboard-design.md`

## Global Constraints

- Backend and frontend are separate npm packages: `backend/` and `frontend/`.
- Backend uses ESM (`"type": "module"`), TypeScript compiled with `tsc` for production, `tsx` for dev.
- SQLite via `better-sqlite3`; DB file path from `DB_PATH` env var, default `./data/mtr-dash.sqlite3`.
- `mtr` binary invoked via `child_process.execFile`, path from `MTR_BIN` env var, default `mtr`.
- Standard MTR metrics field set used everywhere: `lossPct, snt, last, avg, best, wrst, stdev` (camelCase in code/JSON, matching `Loss%, Snt, Last, Avg, Best, Wrst, StDev` from mtr's `-j` report).
- Rolling loss color window is fixed at 5 runs (per spec): green = 0%, yellow = >0-5%, red = >5%.
- All new backend code gets a Vitest test in the same task. All new frontend components get a Testing Library test in the same task.
- Every task ends with a commit.

---

### Task 1: Backend scaffold — Hono app with health check

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/src/app.ts`
- Create: `backend/src/index.ts`
- Test: `backend/src/app.test.ts`

**Interfaces:**
- Produces: `createApp(): Hono` (no deps yet — deps get threaded in in later tasks, this task establishes the factory shape and the `/api/health` route every later task's app instance will also expose).

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "mtr-dash-backend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "hono": "^4.6.3",
    "@hono/node-server": "^1.13.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.4",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `backend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd backend && npm install`
Expected: `package-lock.json` created, `node_modules` populated, no errors.

- [ ] **Step 5: Write the failing test for the app factory**

Create `backend/src/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('createApp', () => {
  it('responds to GET /api/health with ok status', async () => {
    const app = createApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npx vitest run src/app.test.ts`
Expected: FAIL — `Cannot find module './app.js'` (file doesn't exist yet).

- [ ] **Step 7: Create `backend/src/app.ts`**

```ts
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  return app;
}
```

- [ ] **Step 8: Create `backend/src/index.ts`**

```ts
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mtr-dash backend listening on port ${info.port}`);
});
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd backend && npx vitest run src/app.test.ts`
Expected: PASS (1 test)

- [ ] **Step 10: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/tsconfig.json backend/vitest.config.ts backend/src/app.ts backend/src/index.ts backend/src/app.test.ts
git commit -m "feat(backend): scaffold Hono app with health check"
```

---

### Task 2: SQLite schema and DB client

**Files:**
- Create: `backend/src/db/schema.sql`
- Create: `backend/src/db/client.ts`
- Test: `backend/src/db/client.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createDb(dbPath: string): Database.Database` (from `better-sqlite3`) — every later service takes this `Database.Database` instance in its constructor. Tables: `targets, runs, hops, path_nodes, node_positions, deviations` exactly as named/columned below.

- [ ] **Step 1: Create `backend/src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  report_cycles INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS hops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  host TEXT NOT NULL,
  loss_pct REAL NOT NULL,
  snt INTEGER NOT NULL,
  last REAL,
  avg REAL,
  best REAL,
  wrst REAL,
  stdev REAL
);

CREATE TABLE IF NOT EXISTS path_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  host TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  UNIQUE(target_id, ttl, host)
);

CREATE TABLE IF NOT EXISTS node_positions (
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES path_nodes(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (target_id, node_id)
);

CREATE TABLE IF NOT EXISTS deviations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  old_host TEXT,
  new_host TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/db/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';

describe('createDb', () => {
  it('creates all required tables on an in-memory database', () => {
    const db = createDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'targets',
        'runs',
        'hops',
        'path_nodes',
        'node_positions',
        'deviations',
      ]),
    );
  });

  it('allows inserting and reading a target row', () => {
    const db = createDb(':memory:');
    db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    const row = db.prepare('SELECT * FROM targets WHERE host = ?').get('1.1.1.1') as any;
    expect(row.host).toBe('1.1.1.1');
    expect(row.interval_seconds).toBe(60);
    expect(row.report_cycles).toBe(10);
    expect(row.enabled).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/db/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`

- [ ] **Step 3: Create `backend/src/db/client.ts`**

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/db/client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.sql backend/src/db/client.ts backend/src/db/client.test.ts
git commit -m "feat(backend): add SQLite schema and DB client"
```

---

### Task 3: MTR JSON report parser (pure function)

**Files:**
- Create: `backend/src/mtr/types.ts`
- Create: `backend/src/mtr/parser.ts`
- Test: `backend/src/mtr/parser.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface MtrHopReport { ttl: number; host: string; lossPct: number; snt: number; last: number; avg: number; best: number; wrst: number; stdev: number }`, `interface MtrReport { target: string; hops: MtrHopReport[] }`, `parseMtrJson(raw: string): MtrReport`. Task 4 (runner) and Task 6 (ingestion) depend on these exact names/shapes.

- [ ] **Step 1: Create `backend/src/mtr/types.ts`**

```ts
export interface MtrHopReport {
  ttl: number;
  host: string;
  lossPct: number;
  snt: number;
  last: number;
  avg: number;
  best: number;
  wrst: number;
  stdev: number;
}

export interface MtrReport {
  target: string;
  hops: MtrHopReport[];
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/mtr/parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseMtrJson } from './parser.js';

const SAMPLE = JSON.stringify({
  report: {
    mtr: { src: 'localhost', dst: '1.1.1.1', tos: '0x0', tests: 10 },
    hubs: [
      {
        count: 1,
        host: '192.168.1.1',
        'Loss%': 0.0,
        Snt: 10,
        Last: 1.2,
        Avg: 1.5,
        Best: 1.0,
        Wrst: 2.0,
        StDev: 0.3,
      },
      {
        count: 2,
        host: '10.0.0.1',
        'Loss%': 10.0,
        Snt: 10,
        Last: 5.2,
        Avg: 5.5,
        Best: 4.9,
        Wrst: 7.0,
        StDev: 0.8,
      },
    ],
  },
});

describe('parseMtrJson', () => {
  it('parses hops with the correct field mapping', () => {
    const result = parseMtrJson(SAMPLE);
    expect(result.target).toBe('1.1.1.1');
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0]).toEqual({
      ttl: 1,
      host: '192.168.1.1',
      lossPct: 0,
      snt: 10,
      last: 1.2,
      avg: 1.5,
      best: 1.0,
      wrst: 2.0,
      stdev: 0.3,
    });
    expect(result.hops[1].lossPct).toBe(10);
  });

  it('throws on malformed JSON missing report.hubs', () => {
    expect(() => parseMtrJson(JSON.stringify({ report: {} }))).toThrow(
      /missing report.hubs/,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/mtr/parser.test.ts`
Expected: FAIL — `Cannot find module './parser.js'`

- [ ] **Step 4: Create `backend/src/mtr/parser.ts`**

```ts
import type { MtrReport } from './types.js';

export function parseMtrJson(raw: string): MtrReport {
  const parsed = JSON.parse(raw);
  const report = parsed.report;
  if (!report || !Array.isArray(report.hubs)) {
    throw new Error('Unexpected mtr JSON structure: missing report.hubs');
  }
  const hops = report.hubs.map((hub: Record<string, unknown>) => ({
    ttl: Number(hub.count),
    host: String(hub.host),
    lossPct: Number(hub['Loss%']),
    snt: Number(hub.Snt),
    last: Number(hub.Last),
    avg: Number(hub.Avg),
    best: Number(hub.Best),
    wrst: Number(hub.Wrst),
    stdev: Number(hub.StDev),
  }));
  return { target: String(report.mtr?.dst ?? ''), hops };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/mtr/parser.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/mtr/types.ts backend/src/mtr/parser.ts backend/src/mtr/parser.test.ts
git commit -m "feat(backend): add mtr JSON report parser"
```

---

### Task 4: MTR runner (process invocation)

**Files:**
- Create: `backend/src/mtr/runner.ts`
- Test: `backend/src/mtr/runner.test.ts`

**Interfaces:**
- Consumes: `parseMtrJson` and `MtrReport` from Task 3.
- Produces: `runMtr(host: string, cycles: number, mtrBin?: string): Promise<MtrReport>`. Task 11 (scheduler) calls this exact signature.

- [ ] **Step 1: Write the failing test**

Create `backend/src/mtr/runner.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { runMtr } from './runner.js';

describe('runMtr', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('invokes mtr with report flags and parses the JSON result', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(
        null,
        JSON.stringify({
          report: {
            mtr: { dst: '1.1.1.1' },
            hubs: [
              {
                count: 1,
                host: '1.1.1.1',
                'Loss%': 0,
                Snt: 5,
                Last: 1,
                Avg: 1,
                Best: 1,
                Wrst: 1,
                StDev: 0,
              },
            ],
          },
        }),
        '',
      );
    });

    const report = await runMtr('1.1.1.1', 5, 'mtr');

    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '1.1.1.1'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(report.hops).toHaveLength(1);
  });

  it('rejects when the process fails', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(new Error('command not found'), '', '');
    });

    await expect(runMtr('1.1.1.1', 5, 'mtr')).rejects.toThrow('command not found');
  });
});
```

Note: Node's real `execFile` callback signature is `(error, stdout, stderr)` — three separate string arguments, not a single `{ stdout, stderr }` object. The mock above matches Node's actual API so it exercises the same code path production will hit.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/mtr/runner.test.ts`
Expected: FAIL — `Cannot find module './runner.js'`

- [ ] **Step 3: Create `backend/src/mtr/runner.ts`**

```ts
import { execFile } from 'node:child_process';
import { parseMtrJson } from './parser.js';
import type { MtrReport } from './types.js';

export function runMtr(
  host: string,
  cycles: number,
  mtrBin: string = process.env.MTR_BIN ?? 'mtr',
): Promise<MtrReport> {
  return new Promise((resolve, reject) => {
    execFile(
      mtrBin,
      ['--report', `--report-cycles=${cycles}`, '-j', host],
      { timeout: (cycles + 10) * 2000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseMtrJson(stdout.toString()));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/mtr/runner.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/mtr/runner.ts backend/src/mtr/runner.test.ts
git commit -m "feat(backend): add mtr process runner"
```

---

### Task 5: Targets service and routes

**Files:**
- Create: `backend/src/services/targets.ts`
- Create: `backend/src/routes/targets.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/src/services/targets.test.ts`
- Test: `backend/src/routes/targets.test.ts`

**Interfaces:**
- Consumes: `createDb` from Task 2.
- Produces: `interface Target { id: number; host: string; intervalSeconds: number; reportCycles: number; enabled: boolean; createdAt: string }`, `class TargetsService` with `list(): Target[]`, `get(id: number): Target | undefined`, `create(input): Target`, `update(id, input): Target | undefined`, `remove(id): boolean`. Also `registerTargetRoutes(app: Hono, targets: TargetsService, scheduler: SchedulerLike)` where `SchedulerLike = { scheduleTarget(id: number, intervalSeconds: number): void; clearTarget(id: number): void }` — Task 11's `Scheduler` class implements this shape. `createApp` gains an options parameter: `createApp(deps?: { db?: Database.Database })`.

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/services/targets.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { TargetsService } from './targets.js';

describe('TargetsService', () => {
  let db: Database.Database;
  let service: TargetsService;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new TargetsService(db);
  });

  it('creates a target with defaults', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(target.host).toBe('1.1.1.1');
    expect(target.intervalSeconds).toBe(60);
    expect(target.reportCycles).toBe(10);
    expect(target.enabled).toBe(true);
  });

  it('creates a target with custom interval and cycles', () => {
    const target = service.create({ host: '8.8.8.8', intervalSeconds: 30, reportCycles: 5 });
    expect(target.intervalSeconds).toBe(30);
    expect(target.reportCycles).toBe(5);
  });

  it('lists all created targets', () => {
    service.create({ host: '1.1.1.1' });
    service.create({ host: '8.8.8.8' });
    expect(service.list()).toHaveLength(2);
  });

  it('updates a target', () => {
    const target = service.create({ host: '1.1.1.1' });
    const updated = service.update(target.id, { intervalSeconds: 120, enabled: false });
    expect(updated?.intervalSeconds).toBe(120);
    expect(updated?.enabled).toBe(false);
  });

  it('returns undefined when updating a missing target', () => {
    expect(service.update(999, { intervalSeconds: 10 })).toBeUndefined();
  });

  it('removes a target', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(service.remove(target.id)).toBe(true);
    expect(service.get(target.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/targets.test.ts`
Expected: FAIL — `Cannot find module './targets.js'`

- [ ] **Step 3: Create `backend/src/services/targets.ts`**

```ts
import type Database from 'better-sqlite3';

export interface Target {
  id: number;
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  enabled: boolean;
  createdAt: string;
}

export interface CreateTargetInput {
  host: string;
  intervalSeconds?: number;
  reportCycles?: number;
}

export interface UpdateTargetInput {
  host?: string;
  intervalSeconds?: number;
  reportCycles?: number;
  enabled?: boolean;
}

interface TargetRow {
  id: number;
  host: string;
  interval_seconds: number;
  report_cycles: number;
  enabled: number;
  created_at: string;
}

function toTarget(row: TargetRow): Target {
  return {
    id: row.id,
    host: row.host,
    intervalSeconds: row.interval_seconds,
    reportCycles: row.report_cycles,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class TargetsService {
  constructor(private db: Database.Database) {}

  list(): Target[] {
    const rows = this.db.prepare('SELECT * FROM targets ORDER BY id ASC').all() as TargetRow[];
    return rows.map(toTarget);
  }

  get(id: number): Target | undefined {
    const row = this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as
      | TargetRow
      | undefined;
    return row ? toTarget(row) : undefined;
  }

  create(input: CreateTargetInput): Target {
    const intervalSeconds = input.intervalSeconds ?? 60;
    const reportCycles = input.reportCycles ?? 10;
    const result = this.db
      .prepare(
        'INSERT INTO targets (host, interval_seconds, report_cycles) VALUES (?, ?, ?)',
      )
      .run(input.host, intervalSeconds, reportCycles);
    return this.get(result.lastInsertRowid as number)!;
  }

  update(id: number, input: UpdateTargetInput): Target | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...input };
    this.db
      .prepare(
        'UPDATE targets SET host = ?, interval_seconds = ?, report_cycles = ?, enabled = ? WHERE id = ?',
      )
      .run(
        merged.host,
        merged.intervalSeconds,
        merged.reportCycles,
        merged.enabled ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  remove(id: number): boolean {
    const result = this.db.prepare('DELETE FROM targets WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/targets.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing test for the routes**

Create `backend/src/routes/targets.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { TargetsService } from '../services/targets.js';
import { registerTargetRoutes } from './targets.js';

describe('target routes', () => {
  let db: Database.Database;
  let app: Hono;
  let scheduler: { scheduleTarget: ReturnType<typeof vi.fn>; clearTarget: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createDb(':memory:');
    app = new Hono();
    scheduler = { scheduleTarget: vi.fn(), clearTarget: vi.fn() };
    registerTargetRoutes(app, new TargetsService(db), scheduler);
  });

  it('creates a target via POST and schedules it', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.host).toBe('1.1.1.1');
    expect(scheduler.scheduleTarget).toHaveBeenCalledWith(body.id, 60);
  });

  it('rejects POST without a host', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('lists targets via GET', async () => {
    await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1' }),
    });
    const res = await app.request('/api/targets');
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it('clears the scheduler when a target is disabled via PATCH', async () => {
    const created = await (
      await app.request('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '1.1.1.1' }),
      })
    ).json();

    const res = await app.request(`/api/targets/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(scheduler.clearTarget).toHaveBeenCalledWith(created.id);
  });

  it('returns 404 when deleting a missing target', async () => {
    const res = await app.request('/api/targets/999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('deletes a target via DELETE', async () => {
    const created = await (
      await app.request('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '1.1.1.1' }),
      })
    ).json();

    const res = await app.request(`/api/targets/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(scheduler.clearTarget).toHaveBeenCalledWith(created.id);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/targets.test.ts`
Expected: FAIL — `Cannot find module './targets.js'`

- [ ] **Step 7: Create `backend/src/routes/targets.ts`**

```ts
import type { Hono } from 'hono';
import type { TargetsService } from '../services/targets.js';

export interface SchedulerLike {
  scheduleTarget(targetId: number, intervalSeconds: number): void;
  clearTarget(targetId: number): void;
}

export function registerTargetRoutes(
  app: Hono,
  targets: TargetsService,
  scheduler: SchedulerLike,
) {
  app.get('/api/targets', (c) => c.json(targets.list()));

  app.post('/api/targets', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.host || typeof body.host !== 'string') {
      return c.json({ error: 'host is required' }, 400);
    }
    const target = targets.create({
      host: body.host,
      intervalSeconds: body.intervalSeconds,
      reportCycles: body.reportCycles,
    });
    if (target.enabled) scheduler.scheduleTarget(target.id, target.intervalSeconds);
    return c.json(target, 201);
  });

  app.patch('/api/targets/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const updated = targets.update(id, body);
    if (!updated) return c.json({ error: 'not found' }, 404);
    if (!updated.enabled) scheduler.clearTarget(updated.id);
    else scheduler.scheduleTarget(updated.id, updated.intervalSeconds);
    return c.json(updated);
  });

  app.delete('/api/targets/:id', (c) => {
    const id = Number(c.req.param('id'));
    scheduler.clearTarget(id);
    const removed = targets.remove(id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.body(null, 204);
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/targets.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/targets.ts backend/src/services/targets.test.ts backend/src/routes/targets.ts backend/src/routes/targets.test.ts
git commit -m "feat(backend): add targets service and CRUD routes"
```

---

### Task 6: Run ingestion service (path_nodes + deviation detection)

**Files:**
- Create: `backend/src/services/runs.ts`
- Test: `backend/src/services/runs.test.ts`

**Interfaces:**
- Consumes: `createDb` from Task 2, `MtrReport`/`MtrHopReport` from Task 3.
- Produces: `interface IngestResult { runId: number; deviations: { ttl: number; oldHost: string | null; newHost: string }[] }`, `class RunsService` with `ingest(targetId: number, report: MtrReport): IngestResult`. Task 7 (map) and Task 8 (deviations) read the `hops`, `path_nodes`, and `deviations` tables this populates.

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/runs.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from './runs.js';
import type { MtrReport } from '../mtr/types.js';

function report(hops: { ttl: number; host: string }[]): MtrReport {
  return {
    target: '1.1.1.1',
    hops: hops.map((h) => ({
      ttl: h.ttl,
      host: h.host,
      lossPct: 0,
      snt: 10,
      last: 1,
      avg: 1,
      best: 1,
      wrst: 1,
      stdev: 0,
    })),
  };
}

describe('RunsService', () => {
  let db: Database.Database;
  let service: RunsService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new RunsService(db);
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
  });

  it('inserts a run and its hops', () => {
    const result = service.ingest(targetId, report([{ ttl: 1, host: '192.168.1.1' }]));
    expect(result.runId).toBeGreaterThan(0);
    const hops = db.prepare('SELECT * FROM hops WHERE run_id = ?').all(result.runId);
    expect(hops).toHaveLength(1);
  });

  it('creates active path_nodes on the first run with no deviations', () => {
    const result = service.ingest(
      targetId,
      report([
        { ttl: 1, host: '192.168.1.1' },
        { ttl: 2, host: '10.0.0.1' },
      ]),
    );
    expect(result.deviations).toHaveLength(2); // no prior active node -> counts as a deviation from null
    const nodes = db
      .prepare('SELECT * FROM path_nodes WHERE target_id = ? ORDER BY ttl')
      .all(targetId) as any[];
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.active === 1)).toBe(true);
  });

  it('does not create a new node or deviation when the path is unchanged', () => {
    service.ingest(targetId, report([{ ttl: 1, host: '192.168.1.1' }]));
    const second = service.ingest(targetId, report([{ ttl: 1, host: '192.168.1.1' }]));
    expect(second.deviations).toHaveLength(0);
    const nodes = db.prepare('SELECT * FROM path_nodes WHERE target_id = ?').all(targetId);
    expect(nodes).toHaveLength(1);
  });

  it('creates a new node and deviation when a hop host changes, deactivating the old one', () => {
    service.ingest(targetId, report([{ ttl: 1, host: '192.168.1.1' }]));
    const second = service.ingest(targetId, report([{ ttl: 1, host: '192.168.1.99' }]));

    expect(second.deviations).toEqual([
      { ttl: 1, oldHost: '192.168.1.1', newHost: '192.168.1.99' },
    ]);
    const nodes = db
      .prepare('SELECT * FROM path_nodes WHERE target_id = ? ORDER BY host')
      .all(targetId) as any[];
    expect(nodes).toHaveLength(2);
    const oldNode = nodes.find((n) => n.host === '192.168.1.1');
    const newNode = nodes.find((n) => n.host === '192.168.1.99');
    expect(oldNode.active).toBe(0);
    expect(newNode.active).toBe(1);
  });

  it('reactivates a previously-seen node instead of duplicating it', () => {
    service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));
    service.ingest(targetId, report([{ ttl: 1, host: 'B' }]));
    service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));

    const nodes = db
      .prepare('SELECT * FROM path_nodes WHERE target_id = ?')
      .all(targetId) as any[];
    expect(nodes).toHaveLength(2);
    const nodeA = nodes.find((n) => n.host === 'A');
    expect(nodeA.active).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/runs.test.ts`
Expected: FAIL — `Cannot find module './runs.js'`

- [ ] **Step 3: Create `backend/src/services/runs.ts`**

```ts
import type Database from 'better-sqlite3';
import type { MtrHopReport, MtrReport } from '../mtr/types.js';

export interface DeviationEvent {
  ttl: number;
  oldHost: string | null;
  newHost: string;
}

export interface IngestResult {
  runId: number;
  deviations: DeviationEvent[];
}

interface PathNodeRow {
  id: number;
  host: string;
  active: number;
}

export class RunsService {
  constructor(private db: Database.Database) {}

  ingest(targetId: number, report: MtrReport): IngestResult {
    const now = new Date().toISOString();

    const runId = this.db
      .prepare(
        `INSERT INTO runs (target_id, started_at, finished_at, status) VALUES (?, ?, ?, 'ok')`,
      )
      .run(targetId, now, now).lastInsertRowid as number;

    const insertHop = this.db.prepare(
      `INSERT INTO hops (run_id, ttl, host, loss_pct, snt, last, avg, best, wrst, stdev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const hop of report.hops) {
      insertHop.run(
        runId,
        hop.ttl,
        hop.host,
        hop.lossPct,
        hop.snt,
        hop.last,
        hop.avg,
        hop.best,
        hop.wrst,
        hop.stdev,
      );
    }

    const deviations = this.updatePathNodes(targetId, report.hops, now);
    return { runId, deviations };
  }

  private updatePathNodes(
    targetId: number,
    hops: MtrHopReport[],
    now: string,
  ): DeviationEvent[] {
    const findActive = this.db.prepare(
      'SELECT id, host, active FROM path_nodes WHERE target_id = ? AND ttl = ? AND active = 1',
    );
    const findNode = this.db.prepare(
      'SELECT id, host, active FROM path_nodes WHERE target_id = ? AND ttl = ? AND host = ?',
    );
    const insertNode = this.db.prepare(
      'INSERT INTO path_nodes (target_id, ttl, host, first_seen_at, last_seen_at, active) VALUES (?, ?, ?, ?, ?, 1)',
    );
    const touchNode = this.db.prepare(
      'UPDATE path_nodes SET last_seen_at = ?, active = 1 WHERE id = ?',
    );
    const deactivate = this.db.prepare('UPDATE path_nodes SET active = 0 WHERE id = ?');
    const insertDeviation = this.db.prepare(
      'INSERT INTO deviations (target_id, ttl, old_host, new_host, detected_at) VALUES (?, ?, ?, ?, ?)',
    );

    const deviations: DeviationEvent[] = [];

    for (const hop of hops) {
      const active = findActive.get(targetId, hop.ttl) as PathNodeRow | undefined;

      if (active && active.host === hop.host) {
        touchNode.run(now, active.id);
        continue;
      }

      const existing = findNode.get(targetId, hop.ttl, hop.host) as PathNodeRow | undefined;

      if (active) deactivate.run(active.id);

      if (existing) {
        touchNode.run(now, existing.id);
      } else {
        insertNode.run(targetId, hop.ttl, hop.host, now, now);
      }

      insertDeviation.run(targetId, hop.ttl, active ? active.host : null, hop.host, now);
      deviations.push({ ttl: hop.ttl, oldHost: active ? active.host : null, newHost: hop.host });
    }

    return deviations;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/runs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/runs.ts backend/src/services/runs.test.ts
git commit -m "feat(backend): add run ingestion with path deviation detection"
```

---

### Task 7: Map service and route (nodes, edges, rolling-loss color)

**Files:**
- Create: `backend/src/services/map.ts`
- Create: `backend/src/routes/map.ts`
- Test: `backend/src/services/map.test.ts`
- Test: `backend/src/routes/map.test.ts`

**Interfaces:**
- Consumes: `createDb` from Task 2; reads `path_nodes`, `node_positions`, `hops`, `runs` tables populated by Task 6's `RunsService`.
- Produces: `interface MapNode { id: number; ttl: number; host: string; active: boolean; x: number; y: number }`, `interface EdgeMetrics { lossPct: number; snt: number; last: number; avg: number; best: number; wrst: number; stdev: number }`, `interface MapEdge { id: string; source: number; target: number; color: 'green' | 'yellow' | 'red'; avgLossPct: number; latest: EdgeMetrics }`, `interface MapResult { nodes: MapNode[]; edges: MapEdge[] }`, `class MapService` with `getMap(targetId: number): MapResult`. Edge `source` is `0` for the ttl=1 edge (representing "this host"). Frontend Task 15 maps `source === 0` to a synthetic `'source'` node id.

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/services/map.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from './runs.js';
import { MapService } from './map.js';
import type { MtrReport } from '../mtr/types.js';

function reportWithLoss(hops: { ttl: number; host: string; lossPct: number }[]): MtrReport {
  return {
    target: '1.1.1.1',
    hops: hops.map((h) => ({
      ttl: h.ttl,
      host: h.host,
      lossPct: h.lossPct,
      snt: 10,
      last: 1,
      avg: 1,
      best: 1,
      wrst: 1,
      stdev: 0,
    })),
  };
}

describe('MapService', () => {
  let db: Database.Database;
  let runs: RunsService;
  let map: MapService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runs = new RunsService(db);
    map = new MapService(db);
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
  });

  it('returns one node per active hop and edges linking them in ttl order', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].source).toBe(0);
    expect(result.edges[1].source).toBe(result.edges[0].target);
  });

  it('colors an edge green when average loss over recent runs is 0', () => {
    for (let i = 0; i < 3; i++) {
      runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    }
    const result = map.getMap(targetId);
    expect(result.edges[0].color).toBe('green');
  });

  it('colors an edge red when average loss over the last 5 runs exceeds 5%', () => {
    for (let i = 0; i < 5; i++) {
      runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 20 }]));
    }
    const result = map.getMap(targetId);
    expect(result.edges[0].color).toBe('red');
    expect(result.edges[0].avgLossPct).toBe(20);
  });

  it('includes inactive nodes after a deviation', () => {
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));

    const result = map.getMap(targetId);
    expect(result.nodes).toHaveLength(2);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    expect(nodeA.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: FAIL — `Cannot find module './map.js'`

- [ ] **Step 3: Create `backend/src/services/map.ts`**

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
  color: 'green' | 'yellow' | 'red';
  avgLossPct: number;
  latest: EdgeMetrics;
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
    const nodeRows = this.db
      .prepare('SELECT * FROM path_nodes WHERE target_id = ? ORDER BY ttl ASC')
      .all(targetId) as PathNodeRow[];

    const positions = new Map<number, { x: number; y: number }>();
    for (const p of this.db
      .prepare('SELECT node_id, x, y FROM node_positions WHERE target_id = ?')
      .all(targetId) as { node_id: number; x: number; y: number }[]) {
      positions.set(p.node_id, { x: p.x, y: p.y });
    }

    const nodes: MapNode[] = nodeRows.map((n, idx) => {
      const pos = positions.get(n.id) ?? { x: idx * 220, y: n.active ? 0 : 140 };
      return { id: n.id, ttl: n.ttl, host: n.host, active: n.active === 1, x: pos.x, y: pos.y };
    });

    const activeByTtl = new Map<number, PathNodeRow>();
    for (const n of nodeRows) if (n.active === 1) activeByTtl.set(n.ttl, n);

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

    return { nodes, edges };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/map.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for the route**

Create `backend/src/routes/map.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from '../services/runs.js';
import { MapService } from '../services/map.js';
import { registerMapRoutes } from './map.js';

describe('map routes', () => {
  let db: Database.Database;
  let app: Hono;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    app = new Hono();
    registerMapRoutes(app, new MapService(db));
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
    new RunsService(db).ingest(targetId, {
      target: '1.1.1.1',
      hops: [{ ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
    });
  });

  it('returns nodes and edges for a target', async () => {
    const res = await app.request(`/api/targets/${targetId}/map`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.edges).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/map.test.ts`
Expected: FAIL — `Cannot find module './map.js'`

- [ ] **Step 7: Create `backend/src/routes/map.ts`**

```ts
import type { Hono } from 'hono';
import type { MapService } from '../services/map.js';

export function registerMapRoutes(app: Hono, mapService: MapService) {
  app.get('/api/targets/:id/map', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(mapService.getMap(id));
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/map.test.ts`
Expected: PASS (1 test)

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/map.ts backend/src/services/map.test.ts backend/src/routes/map.ts backend/src/routes/map.test.ts
git commit -m "feat(backend): add map service and route with rolling-loss edge color"
```

---

### Task 8: Deviations service and routes (log + timeline history)

**Files:**
- Create: `backend/src/services/deviations.ts`
- Create: `backend/src/routes/deviations.ts`
- Test: `backend/src/services/deviations.test.ts`
- Test: `backend/src/routes/deviations.test.ts`

**Interfaces:**
- Consumes: `createDb` from Task 2; reads the `deviations` table populated by Task 6.
- Produces: `interface DeviationRecord { id: number; ttl: number; oldHost: string | null; newHost: string; detectedAt: string }`, `class DeviationsService` with `list(targetId: number): DeviationRecord[]` and `activeAt(targetId: number, at: string): Map<number, string>`. Routes: `GET /api/targets/:id/deviations`, `GET /api/targets/:id/history?at=<ISO>`.

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/services/deviations.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from './runs.js';
import { DeviationsService } from './deviations.js';
import type { MtrReport } from '../mtr/types.js';

function report(host: string): MtrReport {
  return {
    target: '1.1.1.1',
    hops: [{ ttl: 1, host, lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
  };
}

describe('DeviationsService', () => {
  let db: Database.Database;
  let runs: RunsService;
  let deviations: DeviationsService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runs = new RunsService(db);
    deviations = new DeviationsService(db);
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
  });

  it('lists deviations newest first', () => {
    runs.ingest(targetId, report('A'));
    runs.ingest(targetId, report('B'));
    const list = deviations.list(targetId);
    expect(list).toHaveLength(2);
    expect(list[0].newHost).toBe('B');
    expect(list[1].newHost).toBe('A');
  });

  it('reconstructs the active host per ttl at a point in time', async () => {
    runs.ingest(targetId, report('A'));
    const midpoint = new Date(Date.now() + 10).toISOString();
    // Two synchronous ingest() calls can land in the same millisecond, which
    // gives both rows the same detected_at and breaks the "midpoint falls
    // strictly between them" assumption below. A real wait avoids the race.
    await new Promise((resolve) => setTimeout(resolve, 20));
    runs.ingest(targetId, report('B'));

    const activeAtMidpoint = deviations.activeAt(targetId, midpoint);
    expect(activeAtMidpoint.get(1)).toBe('A');

    const activeNow = deviations.activeAt(targetId, new Date(Date.now() + 1000).toISOString());
    expect(activeNow.get(1)).toBe('B');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/deviations.test.ts`
Expected: FAIL — `Cannot find module './deviations.js'`

- [ ] **Step 3: Create `backend/src/services/deviations.ts`**

```ts
import type Database from 'better-sqlite3';

export interface DeviationRecord {
  id: number;
  ttl: number;
  oldHost: string | null;
  newHost: string;
  detectedAt: string;
}

interface DeviationRow {
  id: number;
  ttl: number;
  old_host: string | null;
  new_host: string;
  detected_at: string;
}

export class DeviationsService {
  constructor(private db: Database.Database) {}

  list(targetId: number): DeviationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM deviations WHERE target_id = ? ORDER BY id DESC')
      .all(targetId) as DeviationRow[];
    return rows.map((r) => ({
      id: r.id,
      ttl: r.ttl,
      oldHost: r.old_host,
      newHost: r.new_host,
      detectedAt: r.detected_at,
    }));
  }

  activeAt(targetId: number, at: string): Map<number, string> {
    const rows = this.db
      .prepare(
        `SELECT ttl, new_host as newHost FROM deviations d1
         WHERE target_id = ? AND detected_at <= ?
         AND id = (
           SELECT id FROM deviations d2
           WHERE d2.target_id = d1.target_id AND d2.ttl = d1.ttl AND d2.detected_at <= ?
           ORDER BY d2.id DESC LIMIT 1
         )`,
      )
      .all(targetId, at, at) as { ttl: number; newHost: string }[];

    const result = new Map<number, string>();
    for (const row of rows) result.set(row.ttl, row.newHost);
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/deviations.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for the routes**

Create `backend/src/routes/deviations.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from '../services/runs.js';
import { DeviationsService } from '../services/deviations.js';
import { registerDeviationRoutes } from './deviations.js';

describe('deviation routes', () => {
  let db: Database.Database;
  let app: Hono;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    app = new Hono();
    registerDeviationRoutes(app, new DeviationsService(db));
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
    new RunsService(db).ingest(targetId, {
      target: '1.1.1.1',
      hops: [{ ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
    });
  });

  it('lists deviations for a target', async () => {
    const res = await app.request(`/api/targets/${targetId}/deviations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it('returns active hosts at a given time via history', async () => {
    const at = new Date(Date.now() + 1000).toISOString();
    const res = await app.request(`/api/targets/${targetId}/history?at=${encodeURIComponent(at)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toEqual([{ ttl: 1, host: 'A' }]);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/deviations.test.ts`
Expected: FAIL — `Cannot find module './deviations.js'`

- [ ] **Step 7: Create `backend/src/routes/deviations.ts`**

```ts
import type { Hono } from 'hono';
import type { DeviationsService } from '../services/deviations.js';

export function registerDeviationRoutes(app: Hono, deviationsService: DeviationsService) {
  app.get('/api/targets/:id/deviations', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(deviationsService.list(id));
  });

  app.get('/api/targets/:id/history', (c) => {
    const id = Number(c.req.param('id'));
    const at = c.req.query('at') ?? new Date().toISOString();
    const activeMap = deviationsService.activeAt(id, at);
    return c.json({
      at,
      active: Array.from(activeMap.entries()).map(([ttl, host]) => ({ ttl, host })),
    });
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/deviations.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/deviations.ts backend/src/services/deviations.test.ts backend/src/routes/deviations.ts backend/src/routes/deviations.test.ts
git commit -m "feat(backend): add deviations log and history timeline routes"
```

---

### Task 9: Node position persistence (service + route)

**Files:**
- Create: `backend/src/services/positions.ts`
- Create: `backend/src/routes/positions.ts`
- Test: `backend/src/services/positions.test.ts`
- Test: `backend/src/routes/positions.test.ts`

**Interfaces:**
- Consumes: `createDb` from Task 2; writes to `node_positions`, read back by Task 7's `MapService.getMap`.
- Produces: `class PositionsService` with `setPosition(targetId: number, nodeId: number, x: number, y: number): void`. Route: `PUT /api/targets/:id/nodes/:nodeId/position`.

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/services/positions.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { PositionsService } from './positions.js';

describe('PositionsService', () => {
  let db: Database.Database;
  let service: PositionsService;
  let targetId: number;
  let nodeId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new PositionsService(db);
    targetId = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1')
      .lastInsertRowid as number;
    nodeId = db
      .prepare(
        "INSERT INTO path_nodes (target_id, ttl, host, first_seen_at, last_seen_at, active) VALUES (?, 1, 'A', datetime('now'), datetime('now'), 1)",
      )
      .run(targetId).lastInsertRowid as number;
  });

  it('inserts a new position', () => {
    service.setPosition(targetId, nodeId, 100, 200);
    const row = db
      .prepare('SELECT * FROM node_positions WHERE target_id = ? AND node_id = ?')
      .get(targetId, nodeId) as any;
    expect(row.x).toBe(100);
    expect(row.y).toBe(200);
  });

  it('updates an existing position instead of duplicating it', () => {
    service.setPosition(targetId, nodeId, 100, 200);
    service.setPosition(targetId, nodeId, 300, 400);
    const rows = db
      .prepare('SELECT * FROM node_positions WHERE target_id = ? AND node_id = ?')
      .all(targetId, nodeId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].x).toBe(300);
    expect(rows[0].y).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/positions.test.ts`
Expected: FAIL — `Cannot find module './positions.js'`

- [ ] **Step 3: Create `backend/src/services/positions.ts`**

```ts
import type Database from 'better-sqlite3';

export class PositionsService {
  constructor(private db: Database.Database) {}

  setPosition(targetId: number, nodeId: number, x: number, y: number): void {
    this.db
      .prepare(
        `INSERT INTO node_positions (target_id, node_id, x, y) VALUES (?, ?, ?, ?)
         ON CONFLICT(target_id, node_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
      )
      .run(targetId, nodeId, x, y);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/positions.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for the route**

Create `backend/src/routes/positions.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { PositionsService } from '../services/positions.js';
import { registerPositionRoutes } from './positions.js';

describe('position routes', () => {
  let db: Database.Database;
  let app: Hono;
  let targetId: number;
  let nodeId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    app = new Hono();
    registerPositionRoutes(app, new PositionsService(db));
    targetId = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1')
      .lastInsertRowid as number;
    nodeId = db
      .prepare(
        "INSERT INTO path_nodes (target_id, ttl, host, first_seen_at, last_seen_at, active) VALUES (?, 1, 'A', datetime('now'), datetime('now'), 1)",
      )
      .run(targetId).lastInsertRowid as number;
  });

  it('persists a position via PUT', async () => {
    const res = await app.request(`/api/targets/${targetId}/nodes/${nodeId}/position`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 50, y: 60 }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT * FROM node_positions WHERE target_id = ? AND node_id = ?')
      .get(targetId, nodeId) as any;
    expect(row.x).toBe(50);
  });

  it('rejects a non-numeric position', async () => {
    const res = await app.request(`/api/targets/${targetId}/nodes/${nodeId}/position`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'a', y: 60 }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/positions.test.ts`
Expected: FAIL — `Cannot find module './positions.js'`

- [ ] **Step 7: Create `backend/src/routes/positions.ts`**

```ts
import type { Hono } from 'hono';
import type { PositionsService } from '../services/positions.js';

export function registerPositionRoutes(app: Hono, positionsService: PositionsService) {
  app.put('/api/targets/:id/nodes/:nodeId/position', async (c) => {
    const targetId = Number(c.req.param('id'));
    const nodeId = Number(c.req.param('nodeId'));
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.x !== 'number' || typeof body.y !== 'number') {
      return c.json({ error: 'x and y must be numbers' }, 400);
    }
    positionsService.setPosition(targetId, nodeId, body.x, body.y);
    return c.json({ ok: true });
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/positions.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/positions.ts backend/src/services/positions.test.ts backend/src/routes/positions.ts backend/src/routes/positions.test.ts
git commit -m "feat(backend): add node position persistence"
```

---

### Task 10: SSE hub and stream route

**Files:**
- Create: `backend/src/sse/hub.ts`
- Create: `backend/src/routes/stream.ts`
- Test: `backend/src/sse/hub.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `class SseHub` with `subscribe(targetId: number, listener: (event: unknown) => void): () => void` and `publish(targetId: number, event: unknown): void`. Task 11's `Scheduler` calls `publish`; `registerStreamRoutes(app: Hono, sseHub: SseHub)` registers `GET /api/targets/:id/stream`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/sse/hub.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SseHub } from './hub.js';

describe('SseHub', () => {
  it('delivers published events only to subscribers of that target', () => {
    const hub = new SseHub();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    hub.subscribe(1, listenerA);
    hub.subscribe(2, listenerB);

    hub.publish(1, { type: 'run', runId: 1 });

    expect(listenerA).toHaveBeenCalledWith({ type: 'run', runId: 1 });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('stops delivering events after unsubscribe', () => {
    const hub = new SseHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(1, listener);
    unsubscribe();
    hub.publish(1, { type: 'run', runId: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/sse/hub.test.ts`
Expected: FAIL — `Cannot find module './hub.js'`

- [ ] **Step 3: Create `backend/src/sse/hub.ts`**

```ts
type Listener = (event: unknown) => void;

export class SseHub {
  private listeners = new Map<number, Set<Listener>>();

  subscribe(targetId: number, listener: Listener): () => void {
    if (!this.listeners.has(targetId)) this.listeners.set(targetId, new Set());
    this.listeners.get(targetId)!.add(listener);
    return () => {
      this.listeners.get(targetId)?.delete(listener);
    };
  }

  publish(targetId: number, event: unknown): void {
    for (const listener of this.listeners.get(targetId) ?? []) listener(event);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/sse/hub.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Create `backend/src/routes/stream.ts`**

No unit test for this file — SSE streaming is exercised in Task 20's manual sanity check because Hono's `streamSSE` keeps the HTTP response open indefinitely, which `app.request()` cannot observe deterministically in Vitest.

```ts
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SseHub } from '../sse/hub.js';

export function registerStreamRoutes(app: Hono, sseHub: SseHub) {
  app.get('/api/targets/:id/stream', (c) => {
    const targetId = Number(c.req.param('id'));
    return streamSSE(c, async (stream) => {
      const aborted = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      const unsubscribe = sseHub.subscribe(targetId, (event) => {
        stream.writeSSE({ data: JSON.stringify(event), event: 'run' });
      });
      await aborted;
      unsubscribe();
    });
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/sse/hub.ts backend/src/sse/hub.test.ts backend/src/routes/stream.ts
git commit -m "feat(backend): add SSE hub and per-target stream route"
```

---

### Task 11: Scheduler and full app wiring

**Files:**
- Create: `backend/src/scheduler/scheduler.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/scheduler/scheduler.test.ts`
- Test: `backend/src/app.test.ts` (extend)

**Interfaces:**
- Consumes: `TargetsService` (Task 5), `RunsService` (Task 6), `SseHub` (Task 10), `runMtr` (Task 4), `MapService` (Task 7), `DeviationsService` (Task 8), `PositionsService` (Task 9), all route registrars.
- Produces: `class Scheduler` with `start(): void`, `scheduleTarget(targetId: number, intervalSeconds: number): void`, `clearTarget(targetId: number): void`, `stop(): void`, `tick(targetId: number): Promise<void>` — implements `SchedulerLike` from Task 5. `createApp(deps?: { db?: Database.Database; runMtrFn?: typeof runMtr }): Hono` now wires every route. This is the last backend task; after this the backend is fully runnable.

- [ ] **Step 1: Write the failing test for the scheduler**

Create `backend/src/scheduler/scheduler.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { TargetsService } from '../services/targets.js';
import { RunsService } from '../services/runs.js';
import { SseHub } from '../sse/hub.js';
import { Scheduler } from './scheduler.js';
import type { MtrReport } from '../mtr/types.js';

describe('Scheduler', () => {
  let db: Database.Database;
  let targets: TargetsService;
  let runs: RunsService;
  let sseHub: SseHub;
  let runMtrFn: ReturnType<typeof vi.fn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createDb(':memory:');
    targets = new TargetsService(db);
    runs = new RunsService(db);
    sseHub = new SseHub();
    runMtrFn = vi.fn<[string, number], Promise<MtrReport>>();
    scheduler = new Scheduler(targets, runs, sseHub, runMtrFn);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('runs mtr and ingests a report on each tick', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockResolvedValue({
      target: '1.1.1.1',
      hops: [{ ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
    });

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runMtrFn).toHaveBeenCalledWith('1.1.1.1', 10);
    const hopRows = db.prepare('SELECT * FROM hops').all();
    expect(hopRows).toHaveLength(1);
  });

  it('publishes an SSE event with the new run id and deviations after each tick', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockResolvedValue({
      target: '1.1.1.1',
      hops: [{ ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
    });
    const listener = vi.fn();
    sseHub.subscribe(target.id, listener);

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run', deviations: expect.any(Array) }),
    );
  });

  it('publishes an error event when the mtr run fails', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockRejectedValue(new Error('boom'));
    const listener = vi.fn();
    sseHub.subscribe(target.id, listener);

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(listener).toHaveBeenCalledWith({ type: 'error', message: 'boom' });
  });

  it('stops ticking a target after clearTarget', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockResolvedValue({ target: '1.1.1.1', hops: [] });

    scheduler.scheduleTarget(target.id, 60);
    scheduler.clearTarget(target.id);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(runMtrFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/scheduler/scheduler.test.ts`
Expected: FAIL — `Cannot find module './scheduler.js'`

- [ ] **Step 3: Create `backend/src/scheduler/scheduler.ts`**

```ts
import type { TargetsService } from '../services/targets.js';
import type { RunsService } from '../services/runs.js';
import type { SseHub } from '../sse/hub.js';
import { runMtr } from '../mtr/runner.js';

export class Scheduler {
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(
    private targetsService: TargetsService,
    private runsService: RunsService,
    private sseHub: SseHub,
    private runMtrFn: typeof runMtr = runMtr,
  ) {}

  start(): void {
    for (const target of this.targetsService.list()) {
      if (target.enabled) this.scheduleTarget(target.id, target.intervalSeconds);
    }
  }

  scheduleTarget(targetId: number, intervalSeconds: number): void {
    this.clearTarget(targetId);
    const timer = setInterval(() => {
      void this.tick(targetId);
    }, intervalSeconds * 1000);
    this.timers.set(targetId, timer);
  }

  clearTarget(targetId: number): void {
    const existing = this.timers.get(targetId);
    if (existing) clearInterval(existing);
    this.timers.delete(targetId);
  }

  async tick(targetId: number): Promise<void> {
    const target = this.targetsService.get(targetId);
    if (!target || !target.enabled) return;
    try {
      const report = await this.runMtrFn(target.host, target.reportCycles);
      const result = this.runsService.ingest(targetId, report);
      this.sseHub.publish(targetId, {
        type: 'run',
        runId: result.runId,
        deviations: result.deviations,
      });
    } catch (err) {
      this.sseHub.publish(targetId, { type: 'error', message: (err as Error).message });
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/scheduler/scheduler.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Rewrite `backend/src/app.test.ts` to cover full wiring**

`createApp` is about to gain an options parameter (`db`, `runMtrFn`, `startScheduler`) so tests can inject an in-memory DB and skip starting the real scheduler — without that, tests would create a real SQLite file on disk and start live timers. Replace the whole file:

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createDb } from './db/client.js';

describe('createApp', () => {
  it('responds to GET /api/health with ok status', async () => {
    const app = createApp({ db: createDb(':memory:'), startScheduler: false });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('wires target creation through to the map endpoint', async () => {
    const app = createApp({ db: createDb(':memory:'), startScheduler: false });
    const createRes = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1' }),
    });
    expect(createRes.status).toBe(201);
    const target = await createRes.json();

    const mapRes = await app.request(`/api/targets/${target.id}/map`);
    expect(mapRes.status).toBe(200);
    const mapBody = await mapRes.json();
    expect(mapBody).toEqual({ nodes: [], edges: [] });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npx vitest run src/app.test.ts`
Expected: FAIL — `createApp` doesn't yet accept an options argument, and the targets/map routes aren't wired.

- [ ] **Step 7: Rewrite `backend/src/app.ts` to wire all services and routes**

```ts
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { createDb } from './db/client.js';
import { TargetsService } from './services/targets.js';
import { RunsService } from './services/runs.js';
import { MapService } from './services/map.js';
import { DeviationsService } from './services/deviations.js';
import { PositionsService } from './services/positions.js';
import { SseHub } from './sse/hub.js';
import { Scheduler } from './scheduler/scheduler.js';
import { registerTargetRoutes } from './routes/targets.js';
import { registerMapRoutes } from './routes/map.js';
import { registerDeviationRoutes } from './routes/deviations.js';
import { registerPositionRoutes } from './routes/positions.js';
import { registerStreamRoutes } from './routes/stream.js';
import { runMtr } from './mtr/runner.js';

export interface CreateAppOptions {
  db?: Database.Database;
  runMtrFn?: typeof runMtr;
  startScheduler?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? createDb(process.env.DB_PATH ?? './data/mtr-dash.sqlite3');

  const targetsService = new TargetsService(db);
  const runsService = new RunsService(db);
  const mapService = new MapService(db);
  const deviationsService = new DeviationsService(db);
  const positionsService = new PositionsService(db);
  const sseHub = new SseHub();
  const scheduler = new Scheduler(targetsService, runsService, sseHub, options.runMtrFn ?? runMtr);

  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  registerTargetRoutes(app, targetsService, scheduler);
  registerMapRoutes(app, mapService);
  registerDeviationRoutes(app, deviationsService);
  registerPositionRoutes(app, positionsService);
  registerStreamRoutes(app, sseHub);

  if (options.startScheduler !== false) scheduler.start();

  return app;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd backend && npx vitest run src/app.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Update `backend/src/index.ts` to serve the frontend build and use env config**

```ts
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
const staticDir = process.env.STATIC_DIR ?? '../public';

app.use('/*', serveStatic({ root: staticDir }));
app.get('/', serveStatic({ path: `${staticDir}/index.html` }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mtr-dash backend listening on port ${info.port}`);
});
```

- [ ] **Step 10: Run the full backend test suite**

Run: `cd backend && npx vitest run`
Expected: PASS (all tests across all files, 30+ tests total)

- [ ] **Step 11: Commit**

```bash
git add backend/src/scheduler/scheduler.ts backend/src/scheduler/scheduler.test.ts backend/src/app.ts backend/src/app.test.ts backend/src/index.ts
git commit -m "feat(backend): add scheduler and wire full app"
```

---

### Task 12: Frontend scaffold — Vite + React + TS, types, API client

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/test/setup.ts`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/api/client.ts`
- Test: `frontend/src/api/client.test.ts`

**Interfaces:**
- Produces: types `Target`, `MapNode`, `EdgeMetrics`, `MapEdge`, `MapResult`, `Deviation` (mirroring backend Task 5/7/8 JSON shapes exactly, camelCase). `api` object with `listTargets, createTarget, updateTarget, deleteTarget, getMap, getDeviations, getHistory, setNodePosition` — every later component task imports `api` from `'../api/client.js'` and types from `'../types.js'`.

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "mtr-dash-frontend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@xyflow/react": "^12.3.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src", "test"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create `frontend/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022"
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `frontend/vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
});
```

- [ ] **Step 5: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MTR Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `frontend/test/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 7: Install dependencies**

Run: `cd frontend && npm install`
Expected: `package-lock.json` created, `node_modules` populated, no errors.

- [ ] **Step 8: Create `frontend/src/types.ts`**

```ts
export interface Target {
  id: number;
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  enabled: boolean;
  createdAt: string;
}

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
  color: 'green' | 'yellow' | 'red';
  avgLossPct: number;
  latest: EdgeMetrics;
}

export interface MapResult {
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface Deviation {
  id: number;
  ttl: number;
  oldHost: string | null;
  newHost: string;
  detectedAt: string;
}

export interface HistoryResult {
  at: string;
  active: { ttl: number; host: string }[];
}
```

- [ ] **Step 9: Write the failing test for the API client**

Create `frontend/src/api/client.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { api } from './client.js';

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 1, host: '1.1.1.1' }),
      }),
    );
  });

  it('sends a POST with JSON body when creating a target', async () => {
    await api.createTarget({ host: '1.1.1.1', intervalSeconds: 30 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/targets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ host: '1.1.1.1', intervalSeconds: 30 }),
      }),
    );
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    await expect(api.listTargets()).rejects.toThrow('/api/targets');
  });

  it('builds the history query string with an encoded timestamp', async () => {
    await api.getHistory(1, '2026-07-06T10:00:00.000Z');
    expect(fetch).toHaveBeenCalledWith(
      '/api/targets/1/history?at=2026-07-06T10%3A00%3A00.000Z',
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`

- [ ] **Step 11: Create `frontend/src/api/client.ts`**

```ts
import type { Target, MapResult, Deviation, HistoryResult } from '../types.js';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`Request to ${path} failed with status ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface CreateTargetInput {
  host: string;
  intervalSeconds?: number;
  reportCycles?: number;
}

export interface UpdateTargetInput {
  host?: string;
  intervalSeconds?: number;
  reportCycles?: number;
  enabled?: boolean;
}

export const api = {
  listTargets: () => request<Target[]>('/targets'),
  createTarget: (input: CreateTargetInput) =>
    request<Target>('/targets', { method: 'POST', body: JSON.stringify(input) }),
  updateTarget: (id: number, input: UpdateTargetInput) =>
    request<Target>(`/targets/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteTarget: (id: number) => request<void>(`/targets/${id}`, { method: 'DELETE' }),
  getMap: (targetId: number) => request<MapResult>(`/targets/${targetId}/map`),
  getDeviations: (targetId: number) => request<Deviation[]>(`/targets/${targetId}/deviations`),
  getHistory: (targetId: number, at: string) =>
    request<HistoryResult>(`/targets/${targetId}/history?at=${encodeURIComponent(at)}`),
  setNodePosition: (targetId: number, nodeId: number, x: number, y: number) =>
    request<{ ok: true }>(`/targets/${targetId}/nodes/${nodeId}/position`, {
      method: 'PUT',
      body: JSON.stringify({ x, y }),
    }),
};
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 13: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/tsconfig.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/index.html frontend/test/setup.ts frontend/src/types.ts frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(frontend): scaffold Vite+React+TS project with API client"
```

---

### Task 13: Sidebar and TargetForm components

**Files:**
- Create: `frontend/src/components/TargetForm.tsx`
- Create: `frontend/src/components/Sidebar.tsx`
- Test: `frontend/src/components/TargetForm.test.tsx`
- Test: `frontend/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `Target` from Task 12's `types.ts`.
- Produces: `interface TargetFormValues { host: string; intervalSeconds: number; reportCycles: number }`, `TargetForm({ onSubmit: (values: TargetFormValues) => void })`, `Sidebar({ targets: Target[], selectedId: number | null, onSelect: (id: number) => void, onCreate: (values: TargetFormValues) => void, onDelete: (id: number) => void })`. Task 17's `App.tsx` renders `<Sidebar />` with these exact props.

- [ ] **Step 1: Write the failing test for TargetForm**

Create `frontend/src/components/TargetForm.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TargetForm } from './TargetForm.js';

describe('TargetForm', () => {
  it('submits host, interval, and cycles', () => {
    const onSubmit = vi.fn();
    render(<TargetForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('host'), { target: { value: '1.1.1.1' } });
    fireEvent.click(screen.getByRole('button', { name: /add target/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      host: '1.1.1.1',
      intervalSeconds: 60,
      reportCycles: 10,
    });
  });

  it('does not submit with an empty host', () => {
    const onSubmit = vi.fn();
    render(<TargetForm onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add target/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/TargetForm.test.tsx`
Expected: FAIL — `Cannot find module './TargetForm.js'`

- [ ] **Step 3: Create `frontend/src/components/TargetForm.tsx`**

```tsx
import { useState, type FormEvent } from 'react';

export interface TargetFormValues {
  host: string;
  intervalSeconds: number;
  reportCycles: number;
}

interface TargetFormProps {
  onSubmit: (values: TargetFormValues) => void;
}

export function TargetForm({ onSubmit }: TargetFormProps) {
  const [host, setHost] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [reportCycles, setReportCycles] = useState(10);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!host.trim()) return;
    onSubmit({ host: host.trim(), intervalSeconds, reportCycles });
    setHost('');
  }

  return (
    <form className="target-form" onSubmit={handleSubmit}>
      <input
        aria-label="host"
        placeholder="IP or hostname"
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <input
        aria-label="interval-seconds"
        type="number"
        min={10}
        value={intervalSeconds}
        onChange={(e) => setIntervalSeconds(Number(e.target.value))}
      />
      <input
        aria-label="report-cycles"
        type="number"
        min={1}
        value={reportCycles}
        onChange={(e) => setReportCycles(Number(e.target.value))}
      />
      <button type="submit">Add target</button>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/TargetForm.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for Sidebar**

Create `frontend/src/components/Sidebar.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';
import type { Target } from '../types.js';

const targets: Target[] = [
  {
    id: 1,
    host: '1.1.1.1',
    intervalSeconds: 60,
    reportCycles: 10,
    enabled: true,
    createdAt: '2026-07-06T00:00:00.000Z',
  },
];

describe('Sidebar', () => {
  it('renders each target and calls onSelect when clicked', () => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        targets={targets}
        selectedId={null}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('1.1.1.1'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('calls onDelete when the delete button is clicked', () => {
    const onDelete = vi.fn();
    render(
      <Sidebar
        targets={targets}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByLabelText('delete-1'));
    expect(onDelete).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Sidebar.test.tsx`
Expected: FAIL — `Cannot find module './Sidebar.js'`

- [ ] **Step 7: Create `frontend/src/components/Sidebar.tsx`**

```tsx
import type { Target } from '../types.js';
import { TargetForm, type TargetFormValues } from './TargetForm.js';

interface SidebarProps {
  targets: Target[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: (values: TargetFormValues) => void;
  onDelete: (id: number) => void;
}

export function Sidebar({ targets, selectedId, onSelect, onCreate, onDelete }: SidebarProps) {
  return (
    <aside className="sidebar">
      <h2>Targets</h2>
      <ul>
        {targets.map((t) => (
          <li key={t.id} className={t.id === selectedId ? 'selected' : ''}>
            <button onClick={() => onSelect(t.id)}>{t.host}</button>
            <button aria-label={`delete-${t.id}`} onClick={() => onDelete(t.id)}>
              &times;
            </button>
          </li>
        ))}
      </ul>
      <TargetForm onSubmit={onCreate} />
    </aside>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Sidebar.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/TargetForm.tsx frontend/src/components/TargetForm.test.tsx frontend/src/components/Sidebar.tsx frontend/src/components/Sidebar.test.tsx
git commit -m "feat(frontend): add Sidebar and TargetForm components"
```

---

### Task 14: HopNode, MetricEdge, and Legend (React Flow primitives)

**Files:**
- Create: `frontend/src/components/HopNode.tsx`
- Create: `frontend/src/components/MetricEdge.tsx`
- Create: `frontend/src/components/Legend.tsx`
- Test: `frontend/src/components/HopNode.test.tsx`
- Test: `frontend/src/components/MetricEdge.test.tsx`

**Interfaces:**
- Consumes: `Handle, Position, BaseEdge, EdgeLabelRenderer, getStraightPath` from `@xyflow/react`; `EdgeMetrics` from Task 12's `types.ts`.
- Produces: `interface HopNodeData { host: string; ttl: number; active: boolean }`, `HopNode` (React Flow node component, soft-corner rectangle, dimmed when inactive), `interface MetricEdgeData { color: 'green' | 'yellow' | 'red'; latest: EdgeMetrics; active: boolean }`, `MetricEdge` (React Flow edge component: colored stroke, dashed when inactive, metrics label), `Legend` (loss-color key, no props). Task 15's `NetworkMap` registers `{ hopNode: HopNode }` and `{ metricEdge: MetricEdge }` and renders `<Legend />`.

- [ ] **Step 1: Write the failing test for HopNode**

Create `frontend/src/components/HopNode.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { HopNode } from './HopNode.js';

function renderNode(active: boolean) {
  return render(
    <ReactFlowProvider>
      <HopNode
        id="1"
        data={{ host: '192.168.1.1', ttl: 3, active }}
        type="hopNode"
        selected={false}
        zIndex={0}
        isConnectable={true}
        dragging={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>,
  );
}

describe('HopNode', () => {
  it('renders the host and ttl', () => {
    renderNode(true);
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    expect(screen.getByText('ttl 3')).toBeInTheDocument();
  });

  it('applies the inactive class when not active', () => {
    const { container } = renderNode(false);
    expect(container.querySelector('.hop-node.inactive')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/HopNode.test.tsx`
Expected: FAIL — `Cannot find module './HopNode.js'`

- [ ] **Step 3: Create `frontend/src/components/HopNode.tsx`**

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface HopNodeData extends Record<string, unknown> {
  host: string;
  ttl: number;
  active: boolean;
}

export function HopNode({ data }: NodeProps) {
  const { host, ttl, active } = data as HopNodeData;
  return (
    <div className={`hop-node ${active ? 'active' : 'inactive'}`}>
      <Handle type="target" position={Position.Left} />
      <div className="hop-node-ttl">ttl {ttl}</div>
      <div className="hop-node-host">{host}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/HopNode.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for MetricEdge**

Create `frontend/src/components/MetricEdge.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { MetricEdge } from './MetricEdge.js';

describe('MetricEdge', () => {
  it('renders the latest metrics in the label', () => {
    render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge
            id="e1"
            source="0"
            target="1"
            sourceX={0}
            sourceY={0}
            targetX={100}
            targetY={0}
            data={{
              color: 'yellow',
              active: true,
              latest: { lossPct: 2, snt: 10, last: 1, avg: 1.2, best: 1, wrst: 1.5, stdev: 0.1 },
            }}
          />
        </svg>
      </ReactFlowProvider>,
    );
    expect(screen.getByText(/Loss 2%/)).toBeInTheDocument();
    expect(screen.getByText(/StDev 0.1/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/MetricEdge.test.tsx`
Expected: FAIL — `Cannot find module './MetricEdge.js'`

- [ ] **Step 7: Create `frontend/src/components/MetricEdge.tsx`**

```tsx
import { BaseEdge, EdgeLabelRenderer, getStraightPath, type EdgeProps } from '@xyflow/react';
import type { EdgeMetrics } from '../types.js';

export interface MetricEdgeData extends Record<string, unknown> {
  color: 'green' | 'yellow' | 'red';
  latest: EdgeMetrics;
  active: boolean;
}

export function MetricEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const edgeData = data as MetricEdgeData;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: edgeData.color,
          strokeWidth: 3,
          strokeDasharray: edgeData.active ? undefined : '6 4',
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          Loss {edgeData.latest.lossPct}% Snt {edgeData.latest.snt} Last {edgeData.latest.last} Avg{' '}
          {edgeData.latest.avg} Best {edgeData.latest.best} Wrst {edgeData.latest.wrst} StDev{' '}
          {edgeData.latest.stdev}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/MetricEdge.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 9: Create `frontend/src/components/Legend.tsx`** (no separate test — trivial static markup covered visually in Task 20's sanity check)

```tsx
export function Legend() {
  return (
    <div className="legend">
      <span className="legend-item">
        <span className="dot green" /> 0% loss
      </span>
      <span className="legend-item">
        <span className="dot yellow" /> &gt;0-5% loss
      </span>
      <span className="legend-item">
        <span className="dot red" /> &gt;5% loss
      </span>
    </div>
  );
}
```

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/HopNode.tsx frontend/src/components/HopNode.test.tsx frontend/src/components/MetricEdge.tsx frontend/src/components/MetricEdge.test.tsx frontend/src/components/Legend.tsx
git commit -m "feat(frontend): add HopNode, MetricEdge, and Legend components"
```

---

### Task 15: NetworkMap component (React Flow canvas wiring + drag persistence)

**Files:**
- Create: `frontend/src/components/NetworkMap.tsx`
- Test: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `HopNode` and `MetricEdge` from Task 14, `Legend` from Task 14, `api` from Task 12, `MapResult` from Task 12's `types.ts`.
- Produces: `NetworkMap({ targetId: number, mapData: MapResult })`. Task 17's `App.tsx` renders this with the result of `api.getMap(targetId)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/NetworkMap.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NetworkMap } from './NetworkMap.js';
import { api } from '../api/client.js';
import type { MapResult } from '../types.js';

vi.mock('../api/client.js', () => ({
  api: { setNodePosition: vi.fn() },
}));

const mapData: MapResult = {
  nodes: [{ id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 }],
  edges: [
    {
      id: '0-1',
      source: 0,
      target: 1,
      color: 'green',
      avgLossPct: 0,
      latest: { lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
    },
  ],
};

describe('NetworkMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a node per hop plus the synthetic source node', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    expect(screen.getByText('this host')).toBeInTheDocument();
  });

  it('renders the legend', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(screen.getByText(/0% loss/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: FAIL — `Cannot find module './NetworkMap.js'`

- [ ] **Step 3: Create `frontend/src/components/NetworkMap.tsx`**

```tsx
import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { HopNode } from './HopNode.js';
import { MetricEdge } from './MetricEdge.js';
import { Legend } from './Legend.js';
import { api } from '../api/client.js';
import type { MapResult } from '../types.js';

const nodeTypes = { hopNode: HopNode };
const edgeTypes = { metricEdge: MetricEdge };
const SOURCE_NODE_ID = 'source';

interface NetworkMapProps {
  targetId: number;
  mapData: MapResult;
}

export function NetworkMap({ targetId, mapData }: NetworkMapProps) {
  const initialNodes = useMemo<Node[]>(() => {
    const sourceNode: Node = {
      id: SOURCE_NODE_ID,
      type: 'hopNode',
      position: { x: -220, y: 0 },
      data: { host: 'this host', ttl: 0, active: true },
    };
    const hopNodes: Node[] = mapData.nodes.map((n) => ({
      id: String(n.id),
      type: 'hopNode',
      position: { x: n.x, y: n.y },
      data: { host: n.host, ttl: n.ttl, active: n.active },
    }));
    return [sourceNode, ...hopNodes];
  }, [mapData.nodes]);

  const initialEdges = useMemo<Edge[]>(
    () =>
      mapData.edges.map((e) => ({
        id: e.id,
        source: e.source === 0 ? SOURCE_NODE_ID : String(e.source),
        target: String(e.target),
        type: 'metricEdge',
        data: { color: e.color, latest: e.latest, active: true },
      })),
    [mapData.edges],
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeDragStop: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.id === SOURCE_NODE_ID) return;
      void api.setNodePosition(targetId, Number(node.id), node.position.x, node.position.y);
    },
    [targetId],
  );

  return (
    <div className="network-map">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
      <Legend />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "feat(frontend): add NetworkMap canvas with drag-to-persist positions"
```

---

### Task 16: useSSE hook, DeviationTimeline, and ConfigPanel

**Files:**
- Create: `frontend/src/hooks/useSSE.ts`
- Create: `frontend/src/components/DeviationTimeline.tsx`
- Create: `frontend/src/components/ConfigPanel.tsx`
- Test: `frontend/src/hooks/useSSE.test.tsx`
- Test: `frontend/src/components/DeviationTimeline.test.tsx`
- Test: `frontend/src/components/ConfigPanel.test.tsx`

**Interfaces:**
- Consumes: `Deviation`, `Target` from Task 12's `types.ts`.
- Produces: `useSSE(targetId: number | null, onEvent: (event: unknown) => void): void`, `DeviationTimeline({ deviations: Deviation[], onScrub: (at: string) => void })`, `ConfigPanel({ target: Target, onSave: (values: { intervalSeconds: number; reportCycles: number }) => void })`. Task 17's `App.tsx` uses all three.

- [ ] **Step 1: Write the failing test for useSSE**

Create `frontend/src/hooks/useSSE.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSSE } from './useSSE.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const handler of this.listeners[type] ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('opens a stream for the given target and forwards parsed events', () => {
    const onEvent = vi.fn();
    renderHook(() => useSSE(1, onEvent));

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/api/targets/1/stream');
    source.emit('run', { type: 'run', runId: 5 });
    expect(onEvent).toHaveBeenCalledWith({ type: 'run', runId: 5 });
  });

  it('closes the previous stream when targetId changes', () => {
    const { rerender } = renderHook(({ id }) => useSSE(id, vi.fn()), {
      initialProps: { id: 1 },
    });
    const first = FakeEventSource.instances[0];
    rerender({ id: 2 });
    expect(first.closed).toBe(true);
  });

  it('does not open a stream when targetId is null', () => {
    renderHook(() => useSSE(null, vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useSSE.test.tsx`
Expected: FAIL — `Cannot find module './useSSE.js'`

- [ ] **Step 3: Create `frontend/src/hooks/useSSE.ts`**

```ts
import { useEffect } from 'react';

export function useSSE(targetId: number | null, onEvent: (event: unknown) => void): void {
  useEffect(() => {
    if (targetId === null) return;
    const source = new EventSource(`/api/targets/${targetId}/stream`);
    const handler = (e: MessageEvent) => onEvent(JSON.parse(e.data));
    source.addEventListener('run', handler);
    return () => {
      source.removeEventListener('run', handler);
      source.close();
    };
  }, [targetId, onEvent]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useSSE.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for DeviationTimeline**

Create `frontend/src/components/DeviationTimeline.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeviationTimeline } from './DeviationTimeline.js';
import type { Deviation } from '../types.js';

const deviations: Deviation[] = [
  { id: 2, ttl: 1, oldHost: 'A', newHost: 'B', detectedAt: '2026-07-06T10:00:00.000Z' },
  { id: 1, ttl: 1, oldHost: null, newHost: 'A', detectedAt: '2026-07-06T09:00:00.000Z' },
];

describe('DeviationTimeline', () => {
  it('renders each deviation and calls onScrub with its timestamp when clicked', () => {
    const onScrub = vi.fn();
    render(<DeviationTimeline deviations={deviations} onScrub={onScrub} />);
    fireEvent.click(screen.getByText(/A -> B/));
    expect(onScrub).toHaveBeenCalledWith('2026-07-06T10:00:00.000Z');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/DeviationTimeline.test.tsx`
Expected: FAIL — `Cannot find module './DeviationTimeline.js'`

- [ ] **Step 7: Create `frontend/src/components/DeviationTimeline.tsx`**

```tsx
import type { Deviation } from '../types.js';

interface DeviationTimelineProps {
  deviations: Deviation[];
  onScrub: (at: string) => void;
}

export function DeviationTimeline({ deviations, onScrub }: DeviationTimelineProps) {
  return (
    <div className="deviation-timeline">
      <h3>Deviations</h3>
      <ul>
        {deviations.map((d) => (
          <li key={d.id}>
            <button onClick={() => onScrub(d.detectedAt)}>
              {new Date(d.detectedAt).toLocaleString()} — ttl {d.ttl}: {d.oldHost ?? '(none)'} -&gt;{' '}
              {d.newHost}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/DeviationTimeline.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 9: Write the failing test for ConfigPanel**

Create `frontend/src/components/ConfigPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigPanel } from './ConfigPanel.js';
import type { Target } from '../types.js';

const target: Target = {
  id: 1,
  host: '1.1.1.1',
  intervalSeconds: 60,
  reportCycles: 10,
  enabled: true,
  createdAt: '2026-07-06T00:00:00.000Z',
};

describe('ConfigPanel', () => {
  it('submits the edited interval and report cycles', () => {
    const onSave = vi.fn();
    render(<ConfigPanel target={target} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/interval/i), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledWith({ intervalSeconds: 30, reportCycles: 10 });
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ConfigPanel.test.tsx`
Expected: FAIL — `Cannot find module './ConfigPanel.js'`

- [ ] **Step 11: Create `frontend/src/components/ConfigPanel.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import type { Target } from '../types.js';

interface ConfigPanelProps {
  target: Target;
  onSave: (values: { intervalSeconds: number; reportCycles: number }) => void;
}

export function ConfigPanel({ target, onSave }: ConfigPanelProps) {
  const [intervalSeconds, setIntervalSeconds] = useState(target.intervalSeconds);
  const [reportCycles, setReportCycles] = useState(target.reportCycles);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave({ intervalSeconds, reportCycles });
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
      <button type="submit">Save</button>
    </form>
  );
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ConfigPanel.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 13: Commit**

```bash
git add frontend/src/hooks/useSSE.ts frontend/src/hooks/useSSE.test.tsx frontend/src/components/DeviationTimeline.tsx frontend/src/components/DeviationTimeline.test.tsx frontend/src/components/ConfigPanel.tsx frontend/src/components/ConfigPanel.test.tsx
git commit -m "feat(frontend): add live updates hook, deviation timeline, and config panel"
```

---

### Task 17: App wiring, entry point, and styling

**Files:**
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/styles.css`
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: every component/hook from Tasks 13-16 and `api`/`types` from Task 12.
- Produces: `App` (default export not required — named export), rendered by `main.tsx` into `#root`. This is the last frontend task; after this the frontend is fully runnable via `npm run dev` / `npm run build`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/App.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { api } from './api/client.js';

vi.mock('./api/client.js', () => ({
  api: {
    listTargets: vi.fn(),
    getMap: vi.fn(),
    getDeviations: vi.fn(),
    createTarget: vi.fn(),
    deleteTarget: vi.fn(),
    updateTarget: vi.fn(),
    getHistory: vi.fn(),
    setNodePosition: vi.fn(),
  },
}));

vi.mock('./hooks/useSSE.js', () => ({ useSSE: vi.fn() }));

describe('App', () => {
  beforeEach(() => {
    vi.mocked(api.listTargets).mockResolvedValue([
      {
        id: 1,
        host: '1.1.1.1',
        intervalSeconds: 60,
        reportCycles: 10,
        enabled: true,
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);
    vi.mocked(api.getMap).mockResolvedValue({ nodes: [], edges: [] });
    vi.mocked(api.getDeviations).mockResolvedValue([]);
  });

  it('loads targets and shows the selected target host in the config panel', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));
    expect(screen.getByDisplayValue('60')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL — `Cannot find module './App.js'`

- [ ] **Step 3: Create `frontend/src/App.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { NetworkMap } from './components/NetworkMap.js';
import { DeviationTimeline } from './components/DeviationTimeline.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { api } from './api/client.js';
import { useSSE } from './hooks/useSSE.js';
import type { Target, MapResult, Deviation } from './types.js';

export function App() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mapData, setMapData] = useState<MapResult | null>(null);
  const [deviations, setDeviations] = useState<Deviation[]>([]);

  const refreshTargets = useCallback(() => {
    api.listTargets().then((list) => {
      setTargets(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    });
  }, []);

  const refreshMap = useCallback((targetId: number) => {
    api.getMap(targetId).then(setMapData);
    api.getDeviations(targetId).then(setDeviations);
  }, []);

  useEffect(() => {
    refreshTargets();
  }, [refreshTargets]);

  useEffect(() => {
    if (selectedId !== null) refreshMap(selectedId);
  }, [selectedId, refreshMap]);

  useSSE(
    selectedId,
    useCallback(() => {
      if (selectedId !== null) refreshMap(selectedId);
    }, [selectedId, refreshMap]),
  );

  const selectedTarget = targets.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar
        targets={targets}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={(values) => {
          api.createTarget(values).then(refreshTargets);
        }}
        onDelete={(id) => {
          api.deleteTarget(id).then(refreshTargets);
        }}
      />
      <main>
        {selectedTarget && mapData && (
          <>
            <ConfigPanel
              target={selectedTarget}
              onSave={(values) => {
                api.updateTarget(selectedTarget.id, values).then(refreshTargets);
              }}
            />
            <NetworkMap targetId={selectedTarget.id} mapData={mapData} />
            <DeviationTimeline
              deviations={deviations}
              onScrub={(at) => {
                void api.getHistory(selectedTarget.id, at);
              }}
            />
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 5: Create `frontend/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Create `frontend/src/styles.css`**

```css
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
.app {
  display: flex;
  height: 100vh;
}
.sidebar {
  width: 260px;
  padding: 1rem;
  border-right: 1px solid #ddd;
  overflow-y: auto;
}
.sidebar ul {
  list-style: none;
  padding: 0;
}
.sidebar li {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sidebar li.selected button:first-child {
  font-weight: bold;
}
main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.network-map {
  flex: 1;
  position: relative;
}
.hop-node {
  padding: 10px 16px;
  border-radius: 12px;
  border: 2px solid #888;
  background: #fff;
  min-width: 120px;
  text-align: center;
}
.hop-node.inactive {
  opacity: 0.45;
  border-style: dashed;
}
.hop-node-ttl {
  font-size: 0.7rem;
  color: #666;
}
.hop-node-host {
  font-weight: 600;
}
.edge-label {
  position: absolute;
  background: rgba(255, 255, 255, 0.9);
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 0.7rem;
  white-space: nowrap;
  pointer-events: none;
}
.legend {
  display: flex;
  gap: 1rem;
  padding: 0.5rem;
  font-size: 0.8rem;
}
.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 4px;
}
.dot.green {
  background: green;
}
.dot.yellow {
  background: goldenrod;
}
.dot.red {
  background: crimson;
}
.deviation-timeline {
  border-top: 1px solid #ddd;
  padding: 0.5rem 1rem;
  max-height: 180px;
  overflow-y: auto;
}
.config-panel {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 1rem;
  align-items: flex-end;
}
.config-panel label {
  display: flex;
  flex-direction: column;
  font-size: 0.8rem;
}
.target-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 1rem;
}
```

- [ ] **Step 7: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (all tests across all files)

- [ ] **Step 8: Run a production build to confirm it compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds, `frontend/dist/` created with `index.html` and bundled assets.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/main.tsx frontend/src/styles.css
git commit -m "feat(frontend): wire App entry point and add styling"
```

---

### Task 18: Dockerfile (mtr-from-source + frontend + backend, multi-stage)

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `backend/` (Tasks 1-11) and `frontend/` (Tasks 12-17) as complete, buildable projects.
- Produces: a single image exposing port 3000, running `node dist/index.js`, with `/usr/local/bin/mtr` available on `PATH`, `DB_PATH=/data/mtr-dash.sqlite3`, `STATIC_DIR=/app/public`. Task 19's compose file builds this image.

Background (verified against the upstream repo): mtr's own README states building from git requires `./bootstrap.sh && ./configure && make`, that `-j` JSON output needs `libjansson`, and that `mtr-packet` needs raw-socket access (satisfied by running the container as root, Docker's default).

- [ ] **Step 1: Create `.dockerignore`**

```
**/node_modules
**/dist
backend/data
docs
.git
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# ---- Stage 1: build mtr from source (latest tag) ----
FROM debian:bookworm-slim AS mtr-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential autoconf automake libtool pkg-config \
      libjansson-dev libcap-dev gettext \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/traviscross/mtr.git . \
    && LATEST_TAG=$(git tag -l 'v*' | sort -V | tail -n1) \
    && git checkout "$LATEST_TAG"
RUN ./bootstrap.sh \
    && ./configure --without-gtk --without-ncurses --without-ncursesw \
    && make -j"$(nproc)" \
    && make install DESTDIR=/opt/mtr-install

# ---- Stage 2: build the frontend ----
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 3: build the backend ----
FROM node:20-bookworm-slim AS backend-builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ---- Stage 4: runtime ----
FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libcap2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mtr-builder /opt/mtr-install/usr/local /usr/local

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=frontend-builder /app/frontend/dist ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/mtr-dash.sqlite3 \
    MTR_BIN=/usr/local/bin/mtr \
    STATIC_DIR=/app/public

VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build the image**

Run: `docker build -t mtr-dash:local .`
Expected: Build completes through all four stages with no errors (this step takes several minutes — `mtr` compiles from source and both npm projects install/build).

- [ ] **Step 4: Verify the mtr binary works inside the built image**

Run: `docker run --rm mtr-dash:local mtr --version`
Expected: Prints an mtr version string (matching the latest git tag at build time), confirming the binary is on `PATH` and its shared library dependencies (`libjansson`, `libcap`) resolved correctly.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: add multi-stage Dockerfile building mtr from source"
```

---

### Task 19: docker-compose and .gitignore

**Files:**
- Create: `docker-compose.yml`
- Modify: `.gitignore` (already exists with a `.worktrees/` entry from workspace setup — append to it, don't overwrite)

**Interfaces:**
- Consumes: the `Dockerfile` from Task 18.
- Produces: a `mtr-dash` service reachable at `http://localhost:3000`, with a named volume `mtr-data` mounted at `/data` for SQLite persistence across restarts.

- [ ] **Step 1: Append to `.gitignore`**

Add these lines to the existing `.gitignore` (keep the existing `.worktrees/` line):

```
node_modules/
dist/
backend/data/
*.sqlite3
*.sqlite3-wal
*.sqlite3-shm
.DS_Store
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  mtr-dash:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - mtr-data:/data
    cap_add:
      - NET_RAW
      - NET_ADMIN
    restart: unless-stopped

volumes:
  mtr-data:
```

- [ ] **Step 3: Bring the stack up**

Run: `docker-compose up -d --build`
Expected: Image builds (or reuses the Task 18 build cache), container starts, `docker-compose ps` shows `mtr-dash` as `Up`.

- [ ] **Step 4: Verify the health endpoint**

Run: `curl -s http://localhost:3000/api/health`
Expected: `{"status":"ok"}`

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .gitignore
git commit -m "build: add docker-compose deployment"
```

---

### Task 20: End-to-end sanity check

**Files:** none (manual verification pass — no code changes expected unless a defect surfaces, in which case fix it in the relevant task's file and re-run this task).

**Interfaces:** none — this task exercises the full system built by Tasks 1-19 through its public HTTP API and the browser.

- [ ] **Step 1: Confirm the stack is running**

Run: `docker-compose ps`
Expected: `mtr-dash` service `Up`, port `3000` published.

- [ ] **Step 2: Add a target via the API**

Run:
```bash
curl -s -X POST http://localhost:3000/api/targets \
  -H 'Content-Type: application/json' \
  -d '{"host":"1.1.1.1","intervalSeconds":60,"reportCycles":5}'
```
Expected: JSON response with `id`, `host: "1.1.1.1"`, `enabled: true`. Note the returned `id` for the next steps.

- [ ] **Step 3: Wait for the first scheduled run and confirm data was recorded**

Wait ~65 seconds (one interval past target creation), then:

Run: `curl -s http://localhost:3000/api/targets/<id>/map`
Expected: `nodes` is a non-empty array (one entry per real hop to 1.1.1.1), `edges` connects them with `color` and `latest` metrics populated (not all zero).

- [ ] **Step 4: Open the frontend and verify the map renders**

Open `http://localhost:3000` in a browser.
Expected: Sidebar shows the `1.1.1.1` target; selecting it renders a node graph with a "this host" source node connected through soft-corner rectangular hop nodes to the destination, edges colored per the legend, edge labels showing Loss/Snt/Last/Avg/Best/Wrst/StDev.

- [ ] **Step 5: Verify drag-to-persist**

In the browser, drag any hop node to a new position, then reload the page.
Expected: The node stays at the dragged position after reload (confirms `PUT /api/targets/:id/nodes/:nodeId/position` round-trips through `GET /api/targets/:id/map`).

- [ ] **Step 6: Verify live updates**

Leave the page open for one more interval (60s) without reloading.
Expected: The edge labels update automatically with the next run's metrics (confirms the SSE stream at `/api/targets/:id/stream` is delivering events and the frontend re-fetches on receipt).

- [ ] **Step 7: Verify deviation tracking**

Run:
```bash
curl -s http://localhost:3000/api/targets/<id>/deviations
```
Expected: At least the initial "first sighting" deviations for each ttl (old_host null → new_host) are present. If the real network path to 1.1.1.1 changes during testing, a subsequent deviation with a non-null `oldHost` should also appear, and the corresponding hop should render as a second, dimmed, dashed-edge node on the map alongside the active one.

- [ ] **Step 8: Record results**

If every expectation above holds, the implementation is complete and matches the spec at `docs/superpowers/specs/2026-07-06-mtr-dashboard-design.md`. If any step fails, use the systematic-debugging skill to isolate whether the defect is in ingestion (Task 6), the map/color computation (Task 7), the scheduler (Task 11), or the frontend rendering (Tasks 14-17), fix it in that task's files, add/adjust its test to cover the gap, and re-run this task from Step 1.

