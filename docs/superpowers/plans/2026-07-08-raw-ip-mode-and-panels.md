# Raw IP Mode, Reverse-DNS Hostnames, and Layout Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `mtr` with `-n` (raw IPs only), add app-side reverse-DNS hostname resolution
displayed additively on each hop node, add a live "raw mtr values" panel on the left of the map,
and move the deviation timeline to the right of the map.

**Architecture:** Backend gains a `DnsService` (cache-backed reverse-DNS, mirroring the existing
`WhoisService` pattern) exposed via a bulk endpoint the frontend calls lazily, exactly like the
existing whois-bulk flow. `RunsService` gains a `getRecentRuns` read method exposing raw per-poll
hop data (already stored in `runs`/`hops`) through a new endpoint. The frontend adds a
`RawMtrPanel` component and reflows `App.tsx`'s layout into three columns around the map.

**Tech Stack:** Hono + better-sqlite3 (backend), React + Vite (frontend), Vitest for both.

## Global Constraints

- `mtr` always runs with `-n` — every hop's `host` field becomes a raw IP; `host` stays the raw IP
  everywhere in the system (whois, geoip, node identity, copy-to-clipboard) — resolved hostname is
  purely additive display, never a replacement.
- DNS resolution is lazy/bulk from the frontend (same pattern as whois), not eager during ingest —
  never blocks or delays the scheduler's poll cadence.
- `dns_cache` TTL: 24 hours.
- Raw-values panel shows the newest 50 polls only, one block per poll (not per individual ping
  cycle inside a poll), newest first. Server caps the returned count at 50 regardless of what a
  caller requests.
- A run with zero hops (a fully failed `mtr` run) still gets a block/entry — never silently
  dropped.
- Layout: `ConfigPanel` and the history banner stay full-width at the top, exactly as today. Below
  them, three columns: raw-values panel (left) | map (center) | deviation timeline (right).
- Both `tsconfig.json`s use `strict: true`; there is no ESLint/Prettier. `npm run build` (`tsc`) is
  the only type-check gate.

---

### Task 1: Backend — `mtr -n` flag + `DnsService`

**Files:**
- Modify: `backend/src/mtr/runner.ts`
- Modify: `backend/src/mtr/runner.test.ts`
- Modify: `backend/src/db/schema.sql`
- Create: `backend/src/services/dns.ts`
- Create: `backend/src/services/dns.test.ts`

**Interfaces:**
- Produces: `DnsService` class with `resolve(host: string): Promise<string | null>` and
  `DnsServiceOptions { reverseFn?: (ip: string) => Promise<string[]> }` constructor option —
  consumed by Task 2's route.

- [ ] **Step 1: Write the failing runner test**

In `backend/src/mtr/runner.test.ts`, change the assertion in
`'invokes mtr with report flags and parses the JSON result'`:

```ts
    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '-n', '1.1.1.1'],
      expect.any(Object),
      expect.any(Function),
    );
```

(This replaces the existing assertion, which currently omits `'-n'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/mtr/runner.test.ts`
Expected: FAIL — actual call args are `['--report', '--report-cycles=5', '-j', '1.1.1.1']`
(missing `'-n'`).

- [ ] **Step 3: Add `-n` to the mtr invocation**

In `backend/src/mtr/runner.ts`, change:

```ts
      ['--report', `--report-cycles=${cycles}`, '-j', host],
```

to:

```ts
      ['--report', `--report-cycles=${cycles}`, '-j', '-n', host],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/mtr/runner.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Add the `dns_cache` table**

In `backend/src/db/schema.sql`, after the `whois_cache` table block, add:

```sql
-- Cached reverse-DNS (PTR) lookups, keyed by IP. mtr runs with -n (see
-- mtr/runner.ts), so every hop's `host` is a raw IP; this cache lets the
-- app resolve a display hostname for it without re-querying DNS on every
-- request. TTL is shorter than whois_cache's since PTR records change more
-- readily than WHOIS ownership data.
CREATE TABLE IF NOT EXISTS dns_cache (
  host TEXT PRIMARY KEY,
  hostname TEXT,
  fetched_at TEXT NOT NULL
);
```

This is a brand-new table (not a column on an existing table), so the existing
`CREATE TABLE IF NOT EXISTS` + `db.exec(schema)` startup flow already handles it correctly for
both fresh and pre-existing database files — no separate migration guard needed (unlike a column
addition would require).

- [ ] **Step 6: Write the failing `DnsService` tests**

Create `backend/src/services/dns.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { DnsService } from './dns.js';

describe('DnsService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('resolves an IP to its first PTR hostname', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
    const service = new DnsService(db, { reverseFn });

    const hostname = await service.resolve('1.1.1.1');

    expect(reverseFn).toHaveBeenCalledWith('1.1.1.1');
    expect(hostname).toBe('host.example.com');
  });

  it('returns null and caches it when the lookup fails (no PTR record)', async () => {
    const reverseFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const service = new DnsService(db, { reverseFn });

    const hostname = await service.resolve('9.9.9.9');

    expect(hostname).toBeNull();
    await service.resolve('9.9.9.9');
    expect(reverseFn).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh cached hostname without calling reverseFn again', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
    const service = new DnsService(db, { reverseFn });

    await service.resolve('1.1.1.1');
    await service.resolve('1.1.1.1');

    expect(reverseFn).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the cached row is older than the cache TTL', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
    const service = new DnsService(db, { reverseFn });
    await service.resolve('1.1.1.1');

    db.prepare('UPDATE dns_cache SET fetched_at = ? WHERE host = ?').run(
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      '1.1.1.1',
    );

    await service.resolve('1.1.1.1');
    expect(reverseFn).toHaveBeenCalledTimes(2);
  });

  it('uses the first hostname when a PTR record returns multiple names', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['first.example.com', 'second.example.com']);
    const service = new DnsService(db, { reverseFn });

    expect(await service.resolve('1.1.1.1')).toBe('first.example.com');
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/dns.test.ts`
Expected: FAIL — `Cannot find module './dns.js'`

- [ ] **Step 8: Implement `DnsService`**

Create `backend/src/services/dns.ts`:

```ts
import dns from 'node:dns/promises';
import type Database from 'better-sqlite3';

// PTR records shift more readily than WHOIS ownership data (whois_cache uses
// a 30-day window) — cache for a day so a hop's resolved hostname stays
// fresh without re-querying DNS on every map render.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  hostname: string | null;
  fetched_at: string;
}

export interface DnsServiceOptions {
  reverseFn?: (ip: string) => Promise<string[]>;
}

export class DnsService {
  private reverseFn: (ip: string) => Promise<string[]>;

  constructor(
    private db: Database.Database,
    options: DnsServiceOptions = {},
  ) {
    this.reverseFn = options.reverseFn ?? ((ip: string) => dns.reverse(ip));
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM dns_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    return Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
  }

  /** Reverse-DNS hostname for an IP, cache-first. Returns null when there's
   * no PTR record or the lookup fails — that's the normal case for most
   * IPs, not an error condition, and is cached too so a persistently
   * unresolvable IP doesn't get re-queried on every request within the TTL. */
  async resolve(host: string): Promise<string | null> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return cached.hostname;
    }

    let hostname: string | null;
    try {
      const names = await this.reverseFn(host);
      hostname = names[0] ?? null;
    } catch {
      hostname = null;
    }

    const fetchedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO dns_cache (host, hostname, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           hostname = excluded.hostname,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, hostname, fetchedAt);

    return hostname;
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/dns.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 10: Commit**

```bash
cd backend && git add src/mtr/runner.ts src/mtr/runner.test.ts src/db/schema.sql src/services/dns.ts src/services/dns.test.ts
git commit -m "Run mtr with -n and add reverse-DNS resolution via DnsService"
```

---

### Task 2: Backend — DNS bulk route + wiring

**Files:**
- Create: `backend/src/routes/dns.ts`
- Create: `backend/src/routes/dns.test.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**
- Consumes: `DnsService.resolve(host: string): Promise<string | null>` (Task 1).
- Produces: `POST /api/dns/bulk` — consumed by Task 6 (frontend `api.getDnsBulk`).

- [ ] **Step 1: Write the failing route tests**

Create `backend/src/routes/dns.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { DnsService } from '../services/dns.js';
import { registerDnsRoutes } from './dns.js';

describe('dns routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('POST /api/dns/bulk', () => {
    it('returns a resolved hostname per requested IP', async () => {
      const app = new Hono();
      const reverseFn = vi
        .fn()
        .mockImplementation(async (ip: string) =>
          ip === '1.1.1.1' ? ['one.example.com'] : ['eight.example.com'],
        );
      registerDnsRoutes(app, new DnsService(db, { reverseFn }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': 'one.example.com',
        '8.8.8.8': 'eight.example.com',
      });
    });

    it('returns 400 when hosts is missing or not an array', async () => {
      const app = new Hono();
      registerDnsRoutes(app, new DnsService(db, { reverseFn: vi.fn() }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });

    it('silently drops invalid hosts and de-duplicates repeats instead of failing the batch', async () => {
      const app = new Hono();
      const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
      registerDnsRoutes(app, new DnsService(db, { reverseFn }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '1.1.1.1', 'bad;host', 42] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ '1.1.1.1': 'host.example.com' });
      expect(reverseFn).toHaveBeenCalledTimes(1);
    });

    it('returns a null hostname for an IP whose lookup fails, without failing the batch', async () => {
      const app = new Hono();
      const reverseFn = vi.fn().mockImplementation(async (ip: string) => {
        if (ip === '9.9.9.9') throw new Error('ENOTFOUND');
        return ['host.example.com'];
      });
      registerDnsRoutes(app, new DnsService(db, { reverseFn }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '9.9.9.9'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': 'host.example.com',
        '9.9.9.9': null,
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/dns.test.ts`
Expected: FAIL — `Cannot find module './dns.js'`

- [ ] **Step 3: Implement the route**

Create `backend/src/routes/dns.ts`:

```ts
import type { Hono } from 'hono';
import type { DnsService } from '../services/dns.js';

// IPv4/IPv6 literal characters only — mtr runs with -n, so every hop host
// reaching this route is a raw IP, never a hostname.
const VALID_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
const MAX_BULK_HOSTS = 200;

export function registerDnsRoutes(app: Hono, dnsService: DnsService) {
  // Bulk reverse-DNS hostnames for every hop IP currently shown on the map,
  // in one round trip. Cache-backed (see DnsService), so repeat calls for
  // already-resolved IPs are fast. A per-IP failure (no PTR record, lookup
  // timeout) yields a null hostname for that IP rather than failing the
  // whole batch.
  app.post('/api/dns/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.hosts)) {
      return c.json({ error: 'hosts must be an array' }, 400);
    }
    const hosts: string[] = [...new Set(body.hosts)]
      .filter((h): h is string => typeof h === 'string' && VALID_HOST.test(h))
      .slice(0, MAX_BULK_HOSTS);

    const entries = await Promise.all(
      hosts.map(async (host): Promise<[string, string | null]> => {
        try {
          return [host, await dnsService.resolve(host)];
        } catch {
          return [host, null];
        }
      }),
    );

    return c.json(Object.fromEntries(entries));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/dns.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Wire `DnsService`/routes into the app**

In `backend/src/app.ts`, add the import alongside the other service/route imports:

```ts
import { WhoisService } from './services/whois.js';
import { DnsService } from './services/dns.js';
```

and:

```ts
import { registerWhoisRoutes } from './routes/whois.js';
import { registerDnsRoutes } from './routes/dns.js';
```

Inside `createApp`, alongside `const whoisService = new WhoisService(db);`:

```ts
  const whoisService = new WhoisService(db);
  const dnsService = new DnsService(db);
```

and alongside `registerWhoisRoutes(app, whoisService);`:

```ts
  registerWhoisRoutes(app, whoisService);
  registerDnsRoutes(app, dnsService);
```

- [ ] **Step 6: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
cd backend && git add src/routes/dns.ts src/routes/dns.test.ts src/app.ts
git commit -m "Add DNS bulk-resolution route and wire it into the app"
```

---

### Task 3: Backend — `RunsService.getRecentRuns`

**Files:**
- Modify: `backend/src/services/runs.ts`
- Modify: `backend/src/services/runs.test.ts`

**Interfaces:**
- Produces: `RunHistoryHop { ttl, host, lossPct, snt, last, avg, best, wrst, stdev }`,
  `RunHistoryEntry { id: number, startedAt: string, hops: RunHistoryHop[] }`, and
  `RunsService.getRecentRuns(targetId: number, limit: number): RunHistoryEntry[]` — consumed by
  Task 4's route and mirrored by Task 7's frontend `RunHistoryEntry`/`RunHistoryHop` types.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/services/runs.test.ts`, inside the existing `describe('RunsService', ...)`
block, after the last existing test (`'reactivates a previously-seen node...'`):

```ts
  describe('getRecentRuns', () => {
    it('returns the most recent runs newest-first, with hops nested and ordered by ttl', () => {
      service.ingest(
        targetId,
        report([
          { ttl: 2, host: 'B' },
          { ttl: 1, host: 'A' },
        ]),
      );
      service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));

      const runs = service.getRecentRuns(targetId, 50);

      expect(runs).toHaveLength(2);
      expect(runs[0].hops).toEqual([
        { ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
      ]);
      expect(runs[1].hops.map((h) => h.ttl)).toEqual([1, 2]);
    });

    it('caps the returned runs at the requested limit', () => {
      service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));
      service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));
      service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));

      expect(service.getRecentRuns(targetId, 2)).toHaveLength(2);
    });

    it('caps the returned runs at 50 even when a larger limit is requested', () => {
      for (let i = 0; i < 55; i++) service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));

      expect(service.getRecentRuns(targetId, 1000)).toHaveLength(50);
    });

    it('returns an entry with an empty hops array for a run with no hops', () => {
      service.ingest(targetId, report([]));

      const runs = service.getRecentRuns(targetId, 50);
      expect(runs).toHaveLength(1);
      expect(runs[0].hops).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/runs.test.ts`
Expected: FAIL — `service.getRecentRuns is not a function`

- [ ] **Step 3: Implement `getRecentRuns`**

In `backend/src/services/runs.ts`, add these exported interfaces near the top of the file
(after the existing `IngestResult` interface):

```ts
export interface RunHistoryHop {
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

export interface RunHistoryEntry {
  id: number;
  startedAt: string;
  hops: RunHistoryHop[];
}
```

Add a module-level constant near the top of the file (alongside the imports):

```ts
const MAX_RUN_HISTORY = 50;
```

Add this method to the `RunsService` class, after the `ingest` method:

```ts
  /** Raw per-poll mtr numbers for the target's most recent runs, newest
   * first, each with its hops nested and ordered by ttl — backs the raw
   * mtr-values panel. `limit` is always capped at MAX_RUN_HISTORY regardless
   * of what's requested, so a caller can't force an unbounded query. */
  getRecentRuns(targetId: number, limit: number): RunHistoryEntry[] {
    const cappedLimit = Math.min(limit, MAX_RUN_HISTORY);
    const runRows = this.db
      .prepare('SELECT id, started_at FROM runs WHERE target_id = ? ORDER BY id DESC LIMIT ?')
      .all(targetId, cappedLimit) as { id: number; started_at: string }[];

    const hopsStmt = this.db.prepare(
      `SELECT ttl, host, loss_pct, snt, last, avg, best, wrst, stdev
       FROM hops WHERE run_id = ? ORDER BY ttl ASC`,
    );

    return runRows.map((run) => ({
      id: run.id,
      startedAt: run.started_at,
      hops: (
        hopsStmt.all(run.id) as {
          ttl: number;
          host: string;
          loss_pct: number;
          snt: number;
          last: number;
          avg: number;
          best: number;
          wrst: number;
          stdev: number;
        }[]
      ).map((h) => ({
        ttl: h.ttl,
        host: h.host,
        lossPct: h.loss_pct,
        snt: h.snt,
        last: h.last,
        avg: h.avg,
        best: h.best,
        wrst: h.wrst,
        stdev: h.stdev,
      })),
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/runs.test.ts`
Expected: PASS (all tests, including the 4 new ones)

- [ ] **Step 5: Commit**

```bash
cd backend && git add src/services/runs.ts src/services/runs.test.ts
git commit -m "Add RunsService.getRecentRuns for raw per-poll history"
```

---

### Task 4: Backend — run-history route + wiring

**Files:**
- Create: `backend/src/routes/runs.ts`
- Create: `backend/src/routes/runs.test.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**
- Consumes: `RunsService.getRecentRuns(targetId: number, limit: number): RunHistoryEntry[]`
  (Task 3).
- Produces: `GET /api/targets/:id/runs?limit=N` — consumed by Task 7 (frontend
  `api.getRunHistory`).

- [ ] **Step 1: Write the failing route tests**

Create `backend/src/routes/runs.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from '../services/runs.js';
import { registerRunRoutes } from './runs.js';

describe('run history routes', () => {
  let db: Database.Database;
  let app: Hono;
  let runs: RunsService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    app = new Hono();
    runs = new RunsService(db);
    registerRunRoutes(app, runs);
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
  });

  it('returns recent runs with nested hops for a target', async () => {
    runs.ingest(targetId, {
      target: '1.1.1.1',
      hops: [
        { ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
      ],
    });

    const res = await app.request(`/api/targets/${targetId}/runs`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].hops).toEqual([
      { ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
    ]);
  });

  it('respects a valid limit query parameter', async () => {
    for (let i = 0; i < 3; i++) {
      runs.ingest(targetId, { target: '1.1.1.1', hops: [] });
    }

    const res = await app.request(`/api/targets/${targetId}/runs?limit=2`);
    expect(await res.json()).toHaveLength(2);
  });

  it('falls back to the default limit for an invalid limit query parameter', async () => {
    runs.ingest(targetId, { target: '1.1.1.1', hops: [] });

    const res = await app.request(`/api/targets/${targetId}/runs?limit=not-a-number`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await app.request('/api/targets/abc/runs');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/runs.test.ts`
Expected: FAIL — `Cannot find module './runs.js'`

- [ ] **Step 3: Implement the route**

Create `backend/src/routes/runs.ts`:

```ts
import type { Hono } from 'hono';
import type { RunsService } from '../services/runs.js';
import { parseId } from './parseId.js';

const DEFAULT_LIMIT = 50;

export function registerRunRoutes(app: Hono, runsService: RunsService) {
  app.get('/api/targets/:id/runs', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    const requested = Number(c.req.query('limit'));
    const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT;
    return c.json(runsService.getRecentRuns(id, limit));
  });
}
```

(The `MAX_RUN_HISTORY = 50` hard cap lives in `RunsService.getRecentRuns` itself — this route just
parses/defaults the query parameter, it doesn't need to duplicate the cap.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/runs.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Wire the route into the app**

In `backend/src/app.ts`, add the import:

```ts
import { registerRunRoutes } from './routes/runs.js';
```

and register it alongside the other route registrations (e.g. right after
`registerDnsRoutes(app, dnsService);`):

```ts
  registerRunRoutes(app, runsService);
```

(`runsService` already exists in `createApp` from the original composition root.)

- [ ] **Step 6: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
cd backend && git add src/routes/runs.ts src/routes/runs.test.ts src/app.ts
git commit -m "Add run-history route and wire it into the app"
```

---

### Task 5: Frontend — `HopNode` resolved-hostname display

**Files:**
- Modify: `frontend/src/components/HopNode.tsx`
- Modify: `frontend/src/components/HopNode.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `HopNodeData.resolvedHost?: string | null` — consumed by Task 6 (`NetworkMap.tsx`
  populates this field).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/HopNode.test.tsx`, inside the existing `describe('HopNode', ...)`
block, after `'renders nothing extra when netname is absent'`:

```ts
  it('renders the resolved hostname when present', () => {
    renderNode({
      host: '192.168.1.1',
      ttl: 3,
      active: true,
      resolvedHost: 'router.example.com',
    });
    expect(screen.getByText('router.example.com')).toBeInTheDocument();
  });

  it('renders nothing extra when resolvedHost is absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node-hostname')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/HopNode.test.tsx`
Expected: FAIL — `getByText('router.example.com')` finds no matching element yet.

- [ ] **Step 3: Add `resolvedHost` to `HopNode`**

Replace the full contents of `frontend/src/components/HopNode.tsx` with:

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
  resolvedHost?: string | null;
}

// `Flags` exports one component per ISO 3166-1 alpha-2 code (e.g. `Flags.US`);
// country codes come from the geoip lookup (a data source, not a fixed enum
// at compile time), so this is always a dynamic, string-keyed lookup.
const FlagComponents = Flags as unknown as Record<string, React.ComponentType>;

export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, resolvedHost } = data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}`}>
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
      {netname && <div className="hop-node-netname">{netname}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

- [ ] **Step 4: Add styling**

In `frontend/src/styles.css`, insert this block between the existing `.hop-node-host` /
`.hop-node.inactive .hop-node-host` rules and the `.hop-node-netname` rule (around line 548),
so the visual treatment matches the netname line:

```css
.hop-node-hostname {
  margin-top: 0.2rem;
  font-family: var(--font-ui);
  font-size: 0.66rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hop-node.inactive .hop-node-hostname {
  color: var(--text-faint);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/HopNode.test.tsx`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/components/HopNode.tsx src/components/HopNode.test.tsx src/styles.css
git commit -m "Render a resolved hostname line on HopNode when present"
```

---

### Task 6: Frontend — `NetworkMap` DNS bulk-fetch wiring

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/components/NetworkMap.tsx`
- Modify: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `HopNodeData.resolvedHost?: string | null` (Task 5),
  `POST /api/dns/bulk` (Task 2, backend).
- Produces: `api.getDnsBulk(hosts: string[]): Promise<Record<string, string | null>>`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/components/NetworkMap.test.tsx`, first update the `vi.mock('../api/client.js', ...)`
factory at the top of the file to include the new endpoint:

```ts
vi.mock('../api/client.js', () => ({
  api: {
    setNodePosition: vi.fn(),
    getWhois: vi.fn(),
    getWhoisBulk: vi.fn().mockResolvedValue({}),
    getDnsBulk: vi.fn().mockResolvedValue({}),
  },
}));
```

Then add, after the `'renders a node per hop plus the synthetic source node'` test:

```tsx
  it('shows a resolved hostname on a hop node once the DNS bulk lookup resolves', async () => {
    vi.mocked(api.getDnsBulk).mockResolvedValueOnce({ '192.168.1.1': 'router.example.com' });
    render(<NetworkMap targetId={1} mapData={mapData} />);

    expect(await screen.findByText('router.example.com')).toBeInTheDocument();
    expect(api.getDnsBulk).toHaveBeenCalledWith(['192.168.1.1']);
  });
```

(`mockResolvedValueOnce` rather than `mockResolvedValue` — the override should apply only to this
test and fall back to the shared default `{}` for every other test in the file, since
`vi.clearAllMocks()` in `beforeEach` clears call history but not a standing mock implementation.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: FAIL — `api.getDnsBulk` doesn't exist yet on the real client, and the test can't find
the resolved hostname text.

- [ ] **Step 3: Add `getDnsBulk` to the API client**

In `frontend/src/api/client.ts`, add to the `api` object, after `getWhoisBulk`:

```ts
  getDnsBulk: (hosts: string[]) =>
    request<Record<string, string | null>>('/dns/bulk', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),
```

- [ ] **Step 4: Wire the bulk-fetch effect into `NetworkMap`**

In `frontend/src/components/NetworkMap.tsx`, add this block immediately after the existing
`whoisSummaries` effect (after the `}, [uniqueHosts]);` that closes it, before `const initialNodes`):

```tsx
  // Lazily loads a reverse-DNS hostname for every hop IP currently on the
  // map, same fetch-once-per-host strategy as whoisSummaries above (mtr now
  // runs with -n, so `host` is always a raw IP — this is the only source of
  // a human-readable name for a hop).
  const [dnsHostnames, setDnsHostnames] = useState<Record<string, string | null>>({});
  const requestedDnsHostsRef = useRef(new Set<string>());

  useEffect(() => {
    const newHosts = uniqueHosts.filter((host) => !requestedDnsHostsRef.current.has(host));
    if (newHosts.length === 0) return;
    newHosts.forEach((host) => requestedDnsHostsRef.current.add(host));
    api
      .getDnsBulk(newHosts)
      .then((hostnames) => setDnsHostnames((prev) => ({ ...prev, ...hostnames })))
      .catch(() => {
        newHosts.forEach((host) => requestedDnsHostsRef.current.delete(host));
      });
  }, [uniqueHosts]);
```

Then update the `displayNodes` memo to layer `resolvedHost` on the same way `netname`/`country`
are layered on. Change:

```tsx
  const displayNodes = useMemo<Node[]>(
    () =>
      initialNodes.map((node) => {
        const host = (node.data as { host: string }).host;
        const summary = whoisSummaries[host];
        return {
          ...node,
          data: {
            ...node.data,
            netname: summary?.netname ?? null,
            country: summary?.country ?? null,
          },
        };
      }),
    [initialNodes, whoisSummaries],
  );
```

to:

```tsx
  const displayNodes = useMemo<Node[]>(
    () =>
      initialNodes.map((node) => {
        const host = (node.data as { host: string }).host;
        const summary = whoisSummaries[host];
        return {
          ...node,
          data: {
            ...node.data,
            netname: summary?.netname ?? null,
            country: summary?.country ?? null,
            resolvedHost: dnsHostnames[host] ?? null,
          },
        };
      }),
    [initialNodes, whoisSummaries, dnsHostnames],
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/NetworkMap.test.tsx`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Run the full frontend suite and typecheck to check for regressions**

Run: `cd frontend && npm test && npm run build`
Expected: PASS, zero type errors.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/api/client.ts src/components/NetworkMap.tsx src/components/NetworkMap.test.tsx
git commit -m "Bulk-resolve and display reverse-DNS hostnames on the map"
```

---

### Task 7: Frontend — `RawMtrPanel` component

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Create: `frontend/src/components/RawMtrPanel.tsx`
- Create: `frontend/src/components/RawMtrPanel.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `GET /api/targets/:id/runs?limit=N` (Task 4, backend).
- Produces: `RunHistoryHop`, `RunHistoryEntry` types on `frontend/src/types.ts`;
  `api.getRunHistory(targetId: number, limit?: number): Promise<RunHistoryEntry[]>`; `RawMtrPanel`
  component taking `{ runs: RunHistoryEntry[] }` — consumed by Task 8 (`App.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/RawMtrPanel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RawMtrPanel } from './RawMtrPanel.js';
import type { RunHistoryEntry } from '../types.js';

const runs: RunHistoryEntry[] = [
  {
    id: 2,
    startedAt: '2026-07-08T10:01:00.000Z',
    hops: [
      { ttl: 1, host: '10.0.0.1', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
    ],
  },
  {
    id: 1,
    startedAt: '2026-07-08T10:00:00.000Z',
    hops: [],
  },
];

describe('RawMtrPanel', () => {
  it('renders one block per run with its hop rows', () => {
    render(<RawMtrPanel runs={runs} />);
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
  });

  it('renders runs in the order given', () => {
    const { container } = render(<RawMtrPanel runs={runs} />);
    const headers = container.querySelectorAll('.raw-mtr-run-header');
    expect(headers[0].textContent).toContain(
      new Date('2026-07-08T10:01:00.000Z').toLocaleString(),
    );
    expect(headers[1].textContent).toContain(
      new Date('2026-07-08T10:00:00.000Z').toLocaleString(),
    );
  });

  it('still renders a block for a run with no hops', () => {
    const { container } = render(<RawMtrPanel runs={runs} />);
    expect(container.querySelectorAll('.raw-mtr-run')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/RawMtrPanel.test.tsx`
Expected: FAIL — `Cannot find module './RawMtrPanel.js'`

- [ ] **Step 3: Add the shared types**

In `frontend/src/types.ts`, add (anywhere after the existing `MapEdge`/`MapResult` interfaces):

```ts
export interface RunHistoryHop {
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

export interface RunHistoryEntry {
  id: number;
  startedAt: string;
  hops: RunHistoryHop[];
}
```

- [ ] **Step 4: Add `getRunHistory` to the API client**

In `frontend/src/api/client.ts`, add `RunHistoryEntry` to the type-only import at the top of the
file:

```ts
import type {
  Target,
  MapResult,
  Deviation,
  HistoryResult,
  WhoisResult,
  WhoisSummary,
  RunHistoryEntry,
} from '../types.js';
```

Add to the `api` object, after `getDnsBulk`:

```ts
  getRunHistory: (targetId: number, limit = 50) =>
    request<RunHistoryEntry[]>(`/targets/${targetId}/runs?limit=${limit}`),
```

- [ ] **Step 5: Implement `RawMtrPanel`**

Create `frontend/src/components/RawMtrPanel.tsx`:

```tsx
import type { RunHistoryEntry } from '../types.js';

interface RawMtrPanelProps {
  runs: RunHistoryEntry[];
}

export function RawMtrPanel({ runs }: RawMtrPanelProps) {
  return (
    <div className="raw-mtr-panel">
      <h3>Raw MTR Values</h3>
      {runs.map((run) => (
        <div className="raw-mtr-run" key={run.id}>
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
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Add styling**

In `frontend/src/styles.css`, add this block immediately before the existing
`.deviation-timeline` block (around line 780):

```css
/* ==========================================================================
   Raw MTR values panel — the live per-poll log
   ========================================================================== */

.raw-mtr-panel {
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 0.5rem 1rem 0.7rem;
  overflow-y: auto;
  min-width: 0;
  width: 320px;
  flex-shrink: 0;
}

.raw-mtr-panel h3 {
  margin: 0.2rem 0 0.45rem;
  font-family: var(--font-display);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.raw-mtr-run {
  margin-bottom: 0.75rem;
}

.raw-mtr-run-header {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-bottom: 0.3rem;
}

.raw-mtr-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 0.68rem;
}

.raw-mtr-table th,
.raw-mtr-table td {
  padding: 0.15rem 0.4rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
}

.raw-mtr-table th {
  color: var(--text-faint);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.6rem;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/RawMtrPanel.test.tsx`
Expected: PASS (all 3 tests)

- [ ] **Step 8: Run the full frontend suite and typecheck to check for regressions**

Run: `cd frontend && npm test && npm run build`
Expected: PASS, zero type errors.

- [ ] **Step 9: Commit**

```bash
cd frontend && git add src/types.ts src/api/client.ts src/components/RawMtrPanel.tsx src/components/RawMtrPanel.test.tsx src/styles.css
git commit -m "Add RawMtrPanel showing live per-poll raw mtr values"
```

---

### Task 8: Frontend — layout: raw panel left, map center, deviations right

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `RawMtrPanel` (Task 7), `api.getRunHistory` (Task 7), `DeviationTimeline` (unchanged,
  existing component), `NetworkMap` (unchanged, existing component).

- [ ] **Step 1: Write the failing tests**

In `frontend/src/App.test.tsx`, first add `getRunHistory` to the `vi.mock('./api/client.js', ...)`
factory (required — `App.tsx` will call this on every render once Step 3 lands, and every existing
test in this file renders `<App />`, so omitting the mock would break every test in the file, not
just the new one):

```ts
vi.mock('./api/client.js', () => ({
  api: {
    listTargets: vi.fn(),
    getMap: vi.fn(),
    getDeviations: vi.fn(),
    getRunHistory: vi.fn(),
    createTarget: vi.fn(),
    deleteTarget: vi.fn(),
    updateTarget: vi.fn(),
    getHistory: vi.fn(),
    setNodePosition: vi.fn(),
    getWhois: vi.fn(),
    getWhoisBulk: vi.fn().mockResolvedValue({}),
    getDnsBulk: vi.fn().mockResolvedValue({}),
  },
}));
```

Then add `vi.mocked(api.getRunHistory).mockResolvedValue([]);` to the existing `beforeEach` block,
alongside the other default mock resolutions:

```ts
  beforeEach(() => {
    vi.mocked(api.listTargets).mockResolvedValue([
      {
        id: 1,
        host: '1.1.1.1',
        intervalSeconds: 60,
        reportCycles: 10,
        enabled: true,
        maxStaleHops: 1,
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);
    vi.mocked(api.getMap).mockResolvedValue({ nodes: [], edges: [] });
    vi.mocked(api.getDeviations).mockResolvedValue([]);
    vi.mocked(api.getRunHistory).mockResolvedValue([]);
  });
```

Then add a new test, after `'loads targets and shows the selected target host in the config panel'`:

```tsx
  it('renders the raw-values panel, map, and deviation timeline in that left-to-right order', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));

    const columns = document.querySelector('.main-columns') as HTMLElement;
    expect(columns).not.toBeNull();
    const children = Array.from(columns.children).map((el) => el.className);
    expect(children[0]).toContain('raw-mtr-panel');
    expect(children[1]).toContain('network-map');
    expect(children[2]).toContain('deviation-timeline');
  });
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL — `.main-columns` doesn't exist yet; `document.querySelector('.main-columns')` is
`null`.

- [ ] **Step 3: Reorder `App.tsx`'s layout**

In `frontend/src/App.tsx`, add the import:

```ts
import { RawMtrPanel } from './components/RawMtrPanel.js';
```

and add `RunHistoryEntry` to the type-only import:

```ts
import type { Target, MapResult, Deviation, RunHistoryEntry } from './types.js';
```

Add state:

```ts
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
```

Update `refreshMap` to also fetch run history:

```ts
  const refreshMap = useCallback((targetId: number) => {
    api.getMap(targetId).then(setMapData);
    api.getDeviations(targetId).then(setDeviations);
    api.getRunHistory(targetId).then(setRunHistory);
    setHistoryActive(null);
  }, []);
```

Replace the `<main>` JSX block:

```tsx
      <main>
        {selectedTarget && mapData && (
          <>
            <ConfigPanel
              target={selectedTarget}
              onSave={(values) => {
                api.updateTarget(selectedTarget.id, values).then(refreshTargets);
              }}
            />
            {historyActive !== null && (
              <div className="history-banner">
                <span>Viewing historical path</span>
                <button onClick={() => setHistoryActive(null)}>Back to live</button>
              </div>
            )}
            <NetworkMap
              targetId={selectedTarget.id}
              mapData={mapData}
              historyActive={historyActive}
            />
            <DeviationTimeline
              deviations={deviations}
              onScrub={(at) => {
                api
                  .getHistory(selectedTarget.id, at)
                  .then((result) => setHistoryActive(result.active));
              }}
            />
          </>
        )}
      </main>
```

with:

```tsx
      <main>
        {selectedTarget && mapData && (
          <>
            <ConfigPanel
              target={selectedTarget}
              onSave={(values) => {
                api.updateTarget(selectedTarget.id, values).then(refreshTargets);
              }}
            />
            {historyActive !== null && (
              <div className="history-banner">
                <span>Viewing historical path</span>
                <button onClick={() => setHistoryActive(null)}>Back to live</button>
              </div>
            )}
            <div className="main-columns">
              <RawMtrPanel runs={runHistory} />
              <NetworkMap
                targetId={selectedTarget.id}
                mapData={mapData}
                historyActive={historyActive}
              />
              <DeviationTimeline
                deviations={deviations}
                onScrub={(at) => {
                  api
                    .getHistory(selectedTarget.id, at)
                    .then((result) => setHistoryActive(result.active));
                }}
              />
            </div>
          </>
        )}
      </main>
```

- [ ] **Step 4: Update layout CSS**

In `frontend/src/styles.css`:

Add a new rule right after the existing `main { ... }` block (around line 296):

```css
.main-columns {
  display: flex;
  flex: 1;
  min-height: 0;
}
```

Change the `.deviation-timeline` block (around line 781) from:

```css
.deviation-timeline {
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding: 0.5rem 1.25rem 0.7rem;
  max-height: 190px;
  overflow-y: auto;
}
```

to:

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

In the existing `@media (max-width: 760px) { ... }` block at the bottom of the file, add (right
after the `.sidebar { ... }` rule inside that block):

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

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Run the full frontend suite and typecheck to check for regressions**

Run: `cd frontend && npm test && npm run build`
Expected: PASS, zero type errors.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/App.tsx src/App.test.tsx src/styles.css
git commit -m "Move raw-values panel and deviation timeline to flank the map"
```

---

### Task 9: Full-stack regression check

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

Start both dev servers (`cd backend && npm run dev`, `cd frontend && npm run dev`), select a
target with at least one completed poll, and confirm: the page shows three columns below the
config panel (raw mtr values on the left, map in the center, deviations on the right); the raw
panel shows a new block appearing at the top after each poll; each hop node shows its IP (not a
hostname, confirming `-n` took effect) and, once the DNS bulk lookup resolves, a resolved hostname
line beneath it for any IP with a PTR record; an IP with no PTR record shows no hostname line.
