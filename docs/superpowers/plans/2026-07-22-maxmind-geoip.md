# MaxMind GeoLite2 city/country lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a MaxMind GeoLite2-City lookup (country + city) as the primary IP-location
source, with the existing ipdeny CIDR-range lookup kept as a country-only fallback, fully
decoupled from WHOIS (a different data source: IP ownership, not location) — and show the
city name next to the country flag on the frontend hop node box.

**Architecture:** A new `GeoipService` (backend), a structural mirror of the existing
`WhoisService`/`DnsService`, owns its own cache table and calls a MaxMind-first/ipdeny-
fallback resolver. `geoipupdate` (MaxMind's official updater) is invoked by the backend
itself at runtime, gated by a 24h freshness check against the mmdb file's mtime — never
baked into the Docker image, never run unless `.GeoIP.conf` is present. The frontend adds
a third independent lazy bulk-load (alongside the existing whois and DNS ones) and renders
city text on `HopNode`.

**Tech Stack:** Hono (Node) + `better-sqlite3` backend, `maxmind` npm package (v5, wraps
`mmdb-lib`) for reading `.mmdb` files, `geoipupdate` CLI (Debian package) for downloading
them, React + `@xyflow/react` frontend, Vitest throughout.

## Global Constraints

- GeoIP (location) and WHOIS (ownership) are separate concerns: no shared cache table, no
  shared service, no field crossover in either direction.
- `.GeoIP.conf` must never be committed to git or baked into a Docker image layer.
- MaxMind's `geoipupdate` only runs when `GEOIP_CONF_PATH` is set **and** the file exists
  **and** (`GeoLite2-City.mmdb` is missing **or** its mtime is ≥24h old). It is otherwise a
  no-op — this is a hard requirement, not a tunable default.
- ipdeny country-only lookup remains the fallback whenever MaxMind has no usable record
  (file absent, IP not found, or the open/lookup call fails) — behavior must be identical
  to today's when MaxMind is unconfigured.
- Strict TypeScript (`strict: true` in both tsconfigs); Vitest is the only test runner;
  there is no ESLint/Prettier in this repo — don't add any.
- The host machine this plan is executed on has **no Node/npm installed** — every
  `npm`/`npx` command below must run inside a `node:20-bookworm-slim` container with the
  repo bind-mounted, e.g.:
  ```bash
  docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c '<command>'
  ```
  (swap `/repo/backend` for `/repo/frontend` for frontend tasks). `node_modules` in both
  packages are already populated and Linux-compatible — no `npm ci` needed except after
  changing `package.json` (Task 3 installs `maxmind`).
- Per this repo's `CLAUDE.md`: final verification is `docker compose up -d --build`, not
  bare `tsc`/`npm run build` — that's Task 14.

---

### Task 1: Decouple WhoisService from GeoIP

WHOIS and GeoIP must not share a cache or a code path. `WhoisService` currently calls
`lookupCountry` and stores a `country` field — remove that entirely so WHOIS is
netname-only, clearing the way for `GeoipService` (Task 6) to own location data
independently.

**Files:**
- Modify: `backend/src/services/whois.ts`
- Modify: `backend/src/services/whois.test.ts`
- Modify: `backend/src/routes/whois.ts`
- Modify: `backend/src/routes/whois.test.ts`

**Interfaces:**
- Produces: `WhoisSummary` (in `whois.ts`) shrinks to `{ netname: string | null }` — every
  later task that touches WHOIS types (Task 10's frontend `WhoisSummary`) must match this
  shape.

- [ ] **Step 1: Update the test files to the new (netname-only) shape**

Replace `backend/src/services/whois.test.ts` in full:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { WhoisService } from './whois.js';

describe('WhoisService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('lookup', () => {
    it('runs the whois lookup and parses the raw output into fields', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\nCIDR: 1.1.1.0/24\n');
      const service = new WhoisService(db, { runWhoisFn });

      const result = await service.lookup('1.1.1.1');

      expect(runWhoisFn).toHaveBeenCalledWith('1.1.1.1');
      expect(result).toEqual({
        host: '1.1.1.1',
        fields: [
          { key: 'NetName', value: 'TEST' },
          { key: 'CIDR', value: '1.1.1.0/24' },
        ],
      });
    });

    it('propagates a lookup failure', async () => {
      const runWhoisFn = vi.fn().mockRejectedValue(new Error('boom'));
      const service = new WhoisService(db, { runWhoisFn });

      await expect(service.lookup('1.1.1.1')).rejects.toThrow('boom');
    });

    it('serves a fresh cached lookup without calling the whois function again', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\n');
      const service = new WhoisService(db, { runWhoisFn });

      await service.lookup('1.1.1.1');
      await service.lookup('1.1.1.1');

      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches when the cached row is older than the cache TTL', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\n');
      const service = new WhoisService(db, { runWhoisFn });
      await service.lookup('1.1.1.1');

      db.prepare('UPDATE whois_cache SET fetched_at = ? WHERE host = ?').run(
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        '1.1.1.1',
      );

      await service.lookup('1.1.1.1');
      expect(runWhoisFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSummary', () => {
    it('extracts the netname', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('netname: EXAMPLE-NET\n');
      const service = new WhoisService(db, { runWhoisFn });

      const summary = await service.getSummary('dns.google');

      expect(summary).toEqual({ netname: 'EXAMPLE-NET' });
    });

    it('serves a fresh cached summary without calling whois again', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('netname: EXAMPLE-NET\n');
      const service = new WhoisService(db, { runWhoisFn });

      await service.getSummary('dns.google');
      await service.getSummary('dns.google');

      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });

    it('shares the cache with lookup() for the same host', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('netname: EXAMPLE-NET\n');
      const service = new WhoisService(db, { runWhoisFn });

      await service.getSummary('1.1.1.1');
      await service.lookup('1.1.1.1');

      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });
  });
});
```

Replace `backend/src/routes/whois.test.ts` in full:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { WhoisService } from '../services/whois.js';
import { registerWhoisRoutes } from './whois.js';

describe('whois routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('GET /api/whois/:host', () => {
    it('returns whois fields for a valid host', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\n');
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/1.1.1.1');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host: '1.1.1.1',
        fields: [{ key: 'NetName', value: 'TEST' }],
      });
    });

    it('returns 400 for a host containing characters outside the allowed set', async () => {
      const app = new Hono();
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn: vi.fn() }));

      const res = await app.request('/api/whois/' + encodeURIComponent('1.1.1.1; rm -rf /'));

      expect(res.status).toBe(400);
    });

    it('returns 502 when the whois lookup fails', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockRejectedValue(new Error('boom'));
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/1.1.1.1');

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'boom' });
    });
  });

  describe('POST /api/whois/bulk', () => {
    it('returns a netname summary per requested host', async () => {
      const app = new Hono();
      const runWhoisFn = vi
        .fn()
        .mockImplementation(async (host: string) =>
          host === '1.1.1.1' ? 'netname: ONE-NET\n' : 'netname: EIGHT-NET\n',
        );
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { netname: 'ONE-NET' },
        '8.8.8.8': { netname: 'EIGHT-NET' },
      });
    });

    it('returns 400 when hosts is missing or not an array', async () => {
      const app = new Hono();
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn: vi.fn() }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });

    it('silently drops invalid hosts and de-duplicates repeats instead of failing the batch', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockResolvedValue('netname: TEST\n');
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '1.1.1.1', 'bad;host', 42] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ '1.1.1.1': { netname: 'TEST' } });
      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });

    it('returns a null summary for a host whose lookup fails, without failing the batch', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockImplementation(async (host: string) => {
        if (host === '9.9.9.9') throw new Error('boom');
        return 'netname: TEST\n';
      });
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '9.9.9.9'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { netname: 'TEST' },
        '9.9.9.9': { netname: null },
      });
    });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail against the current implementation**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/services/whois.test.ts src/routes/whois.test.ts'`
Expected: FAIL — actual summaries still include a `country` field, and `WhoisService`'s
constructor signature still requires nothing new, but the old country-bearing assertions
no longer match (e.g. `{ netname: 'ONE-NET' }` received `{ netname: 'ONE-NET', country: null }`).

- [ ] **Step 3: Update `whois.ts` to remove country/geoip entirely**

Replace `backend/src/services/whois.ts` in full:

```ts
import type Database from 'better-sqlite3';
import { runWhois } from '../whois/runner.js';
import { parseWhois, extractNetname, type WhoisField } from '../whois/parser.js';

export interface WhoisResult {
  host: string;
  fields: WhoisField[];
}

export interface WhoisSummary {
  netname: string | null;
}

// Whois records (netname/CIDR ownership) change rarely; caching for a month
// avoids re-hitting the whois protocol for every render of a hop that's
// already been looked up, while still refreshing eventually.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  fields_json: string;
  netname: string | null;
  fetched_at: string;
}

export interface WhoisServiceOptions {
  runWhoisFn?: typeof runWhois;
}

export class WhoisService {
  private runWhoisFn: typeof runWhois;

  constructor(
    private db: Database.Database,
    options: WhoisServiceOptions = {},
  ) {
    this.runWhoisFn = options.runWhoisFn ?? runWhois;
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM whois_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    return Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
  }

  private async fetchAndCache(host: string): Promise<CacheRow> {
    const raw = await this.runWhoisFn(host);
    const fields = parseWhois(raw);
    const netname = extractNetname(fields);
    const fieldsJson = JSON.stringify(fields);
    const fetchedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO whois_cache (host, fields_json, netname, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           fields_json = excluded.fields_json,
           netname = excluded.netname,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, fieldsJson, netname, fetchedAt);

    return { host, fields_json: fieldsJson, netname, fetched_at: fetchedAt };
  }

  /** Full whois lookup (all parsed fields), cache-first. Backs the
   * single-host detail popup shown when a hop node is clicked. */
  async lookup(host: string): Promise<WhoisResult> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { host, fields: JSON.parse(cached.fields_json) };
    }
    const row = await this.fetchAndCache(host);
    return { host, fields: JSON.parse(row.fields_json) };
  }

  /** Netname only, cache-first. Fast path for lazily summarizing many
   * hosts at once for inline display on the map. Location data (country/
   * city) is a separate concern — see GeoipService, which is never
   * consulted here and never shares this cache table. */
  async getSummary(host: string): Promise<WhoisSummary> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { netname: cached.netname };
    }
    const row = await this.fetchAndCache(host);
    return { netname: row.netname };
  }
}
```

Note: `whois_cache.country` stays in `schema.sql` unchanged (no destructive migration,
per this codebase's additive-only convention) — it's just no longer written or read.

- [ ] **Step 4: Update `routes/whois.ts`'s failure fallback to match the new shape**

In `backend/src/routes/whois.ts`, in the `POST /api/whois/bulk` handler, change:

```ts
          return [host, { netname: null, country: null }];
```

to:

```ts
          return [host, { netname: null }];
```

- [ ] **Step 5: Run the tests again to confirm they pass**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/services/whois.test.ts src/routes/whois.test.ts'`
Expected: PASS — all tests green.

- [ ] **Step 6: Run the full backend suite to confirm no other regressions**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npm test'`
Expected: PASS (every other test file is untouched by this task).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/whois.ts backend/src/services/whois.test.ts backend/src/routes/whois.ts backend/src/routes/whois.test.ts
git commit -m "Decouple WhoisService from GeoIP — netname only, country removed"
```

---

### Task 2: Shared `resolveHost` helper

`GeoipService` (Task 6) needs to resolve a hop's reported host (raw IP or reverse-DNS
hostname) to an IP literal before doing a location lookup — the same operation
`WhoisService` used to do for its (now-removed) country field. Write it as a standalone,
shared module rather than duplicating the logic.

**Files:**
- Create: `backend/src/net/resolveHost.ts`
- Create: `backend/src/net/resolveHost.test.ts`

**Interfaces:**
- Consumes: `ipVersion` from `backend/src/geoip/ipMath.ts` (existing, `(ip: string) => 0 | 4 | 6`).
- Produces: `ResolveHostFn` type and `resolveHost: ResolveHostFn` — `(host: string) =>
  Promise<string | null>`. Task 6's `GeoipService` imports both.

- [ ] **Step 1: Write the failing test**

Create `backend/src/net/resolveHost.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { resolveHost } from './resolveHost.js';

vi.mock('node:dns/promises');

describe('resolveHost', () => {
  it('returns an IPv4 literal unchanged, without a DNS lookup', async () => {
    const result = await resolveHost('8.8.8.8');
    expect(result).toBe('8.8.8.8');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('returns an IPv6 literal unchanged, without a DNS lookup', async () => {
    const result = await resolveHost('2001:db8::1');
    expect(result).toBe('2001:db8::1');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('forward-resolves a hostname to an IP', async () => {
    vi.mocked(dns.lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const result = await resolveHost('example.com');
    expect(result).toBe('93.184.216.34');
    expect(dns.lookup).toHaveBeenCalledWith('example.com');
  });

  it('returns null when the hostname cannot be resolved', async () => {
    vi.mocked(dns.lookup).mockRejectedValue(new Error('ENOTFOUND'));
    const result = await resolveHost('unresolvable.example');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/net/resolveHost.test.ts'`
Expected: FAIL with "Cannot find module './resolveHost.js'" (or similar).

- [ ] **Step 3: Implement**

Create `backend/src/net/resolveHost.ts`:

```ts
import dns from 'node:dns/promises';
import { ipVersion } from '../geoip/ipMath.js';

export type ResolveHostFn = (host: string) => Promise<string | null>;

/** Resolves a hop's reported host (an IP literal or a reverse-DNS hostname)
 * to an IP literal, suitable for a CIDR/mmdb lookup keyed by IP. Returns
 * null if resolution isn't possible or fails. */
export const resolveHost: ResolveHostFn = async (host) => {
  if (ipVersion(host) !== 0) return host;
  try {
    const result = await dns.lookup(host);
    return result.address;
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/net/resolveHost.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/net/resolveHost.ts backend/src/net/resolveHost.test.ts
git commit -m "Add shared resolveHost helper for GeoIP lookups"
```

---

### Task 3: MaxMind mmdb reader wrapper

Add the `maxmind` npm package and a thin wrapper around it that opens a GeoLite2-City
`.mmdb` file and returns country + city for an IP, with a lazily-cached reader that
reopens when the file's mtime advances (i.e. after a `geoipupdate` refresh).

**Files:**
- Modify: `backend/package.json` (add `maxmind` dependency)
- Create: `backend/src/geoip/maxmind.ts`
- Create: `backend/src/geoip/maxmind.test.ts`

**Interfaces:**
- Produces: `GeoLookupResult { country: string | null; city: string | null }`,
  `lookupCity(dbPath: string, ip: string): Promise<GeoLookupResult | null>` — null means
  "no usable MaxMind data, caller should fall back." Task 5 (`resolveGeo`) consumes this
  directly.

- [ ] **Step 1: Install the `maxmind` dependency**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npm install maxmind@^5.0.6'`
Expected: `backend/package.json` and `backend/package-lock.json` are updated, and
`backend/node_modules/maxmind` exists.

- [ ] **Step 2: Write the failing test**

Create `backend/src/geoip/maxmind.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'maxmind';
import { lookupCity, _resetMaxmindCacheForTests } from './maxmind.js';

vi.mock('maxmind', () => ({ open: vi.fn() }));

describe('lookupCity', () => {
  let dbPath: string;

  beforeEach(() => {
    _resetMaxmindCacheForTests();
    vi.mocked(open).mockReset();
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'maxmind-test-')),
      'GeoLite2-City.mmdb',
    );
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns null when the database file does not exist', async () => {
    const result = await lookupCity(dbPath, '8.8.8.8');
    expect(result).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('returns country and city from a resolved record', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({
      get: vi.fn().mockReturnValue({
        country: { iso_code: 'US' },
        city: { names: { en: 'Mountain View' } },
      }),
    } as never);

    const result = await lookupCity(dbPath, '8.8.8.8');

    expect(result).toEqual({ country: 'US', city: 'Mountain View' });
  });

  it('returns null when the IP has no record in the database', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({ get: vi.fn().mockReturnValue(null) } as never);

    const result = await lookupCity(dbPath, '203.0.113.1');

    expect(result).toBeNull();
  });

  it('returns null and does not throw when open() fails', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockRejectedValue(new Error('corrupt database'));

    const result = await lookupCity(dbPath, '8.8.8.8');

    expect(result).toBeNull();
  });

  it('reuses the open reader across calls to the same, unchanged file', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({
      get: vi.fn().mockReturnValue({ country: { iso_code: 'US' }, city: { names: { en: 'X' } } }),
    } as never);

    await lookupCity(dbPath, '8.8.8.8');
    await lookupCity(dbPath, '1.1.1.1');

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reopens the reader when the file is replaced with a newer mtime', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({
      get: vi.fn().mockReturnValue({ country: { iso_code: 'US' }, city: { names: { en: 'X' } } }),
    } as never);
    await lookupCity(dbPath, '8.8.8.8');

    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(dbPath, 'new-fake-mmdb-bytes');
    fs.utimesSync(dbPath, future, future);

    await lookupCity(dbPath, '8.8.8.8');

    expect(open).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/geoip/maxmind.test.ts'`
Expected: FAIL with "Cannot find module './maxmind.js'" (or similar).

- [ ] **Step 4: Implement**

Create `backend/src/geoip/maxmind.ts`:

```ts
import fs from 'node:fs';
import { open, type Reader, type CityResponse } from 'maxmind';

export interface GeoLookupResult {
  country: string | null;
  city: string | null;
}

let cachedReader: Reader<CityResponse> | null = null;
let cachedPath: string | null = null;
let cachedMtimeMs = 0;

async function getReader(dbPath: string): Promise<Reader<CityResponse> | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  if (cachedReader && cachedPath === dbPath && cachedMtimeMs === stat.mtimeMs) {
    return cachedReader;
  }
  try {
    const reader = await open<CityResponse>(dbPath);
    cachedReader = reader;
    cachedPath = dbPath;
    cachedMtimeMs = stat.mtimeMs;
    return reader;
  } catch {
    return null;
  }
}

/** Looks up country + city for an IP against a GeoLite2-City .mmdb file.
 * Returns null if the file doesn't exist, can't be opened, or has no
 * record for the IP — all of which mean "fall back to ipdeny," not an
 * error to surface. The opened reader is cached and only reopened when
 * the file's mtime advances (i.e. after a geoipupdate refresh). */
export async function lookupCity(dbPath: string, ip: string): Promise<GeoLookupResult | null> {
  const reader = await getReader(dbPath);
  if (!reader) return null;
  const result = reader.get(ip);
  if (!result) return null;
  return {
    country: result.country?.iso_code ?? null,
    city: result.city?.names?.en ?? null,
  };
}

/** Test-only: clears the module-level cached reader. */
export function _resetMaxmindCacheForTests(): void {
  cachedReader = null;
  cachedPath = null;
  cachedMtimeMs = 0;
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/geoip/maxmind.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/geoip/maxmind.ts backend/src/geoip/maxmind.test.ts
git commit -m "Add MaxMind GeoLite2-City mmdb reader wrapper"
```

---

### Task 4: Age-gated `geoipupdate` invocation

Wraps MaxMind's `geoipupdate` CLI: only actually runs it (and thus only makes a network
call) when the mmdb file is missing or older than 24 hours, and never throws — a broken
or absent MaxMind setup must never break app startup.

**Files:**
- Create: `backend/src/geoip/ensureMaxmindData.ts`
- Create: `backend/src/geoip/ensureMaxmindData.test.ts`

**Interfaces:**
- Produces: `ensureMaxmindData(confPath: string | undefined, dbDir: string, options?):
  Promise<void>` — never rejects. Task 8 (`app.ts`) calls this at startup and on a 24h
  interval.

- [ ] **Step 1: Write the failing test**

Create `backend/src/geoip/ensureMaxmindData.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMaxmindData } from './ensureMaxmindData.js';

describe('ensureMaxmindData', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-maxmind-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('does nothing when confPath is undefined', async () => {
    const execFileFn = vi.fn();
    await ensureMaxmindData(undefined, '/tmp/whatever', { execFileFn });
    expect(execFileFn).not.toHaveBeenCalled();
  });

  it('does nothing when confPath does not exist on disk', async () => {
    const execFileFn = vi.fn();
    await ensureMaxmindData('/nonexistent/GeoIP.conf', '/tmp/whatever', { execFileFn });
    expect(execFileFn).not.toHaveBeenCalled();
  });

  it('skips geoipupdate when the mmdb file is fresh (under 24h old)', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const statFn = vi.fn().mockResolvedValue({ mtimeMs: Date.now() - 60_000 } as fs.Stats);

    await ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn });

    expect(execFileFn).not.toHaveBeenCalled();
  });

  it('runs geoipupdate when the mmdb file is missing', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const statFn = vi.fn().mockRejectedValue(new Error('ENOENT'));

    await ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn });

    expect(execFileFn).toHaveBeenCalledWith('geoipupdate', ['-f', confPath, '-d', tmpDir]);
  });

  it('runs geoipupdate when the mmdb file is older than 24h', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const statFn = vi
      .fn()
      .mockResolvedValue({ mtimeMs: Date.now() - 25 * 60 * 60 * 1000 } as fs.Stats);

    await ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn });

    expect(execFileFn).toHaveBeenCalledWith('geoipupdate', ['-f', confPath, '-d', tmpDir]);
  });

  it('swallows a geoipupdate failure without throwing', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const statFn = vi.fn().mockRejectedValue(new Error('ENOENT'));

    await expect(
      ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/geoip/ensureMaxmindData.test.ts'`
Expected: FAIL with "Cannot find module './ensureMaxmindData.js'" (or similar).

- [ ] **Step 3: Implement**

Create `backend/src/geoip/ensureMaxmindData.ts`:

```ts
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface EnsureMaxmindDataOptions {
  execFileFn?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  statFn?: (path: string) => Promise<fs.Stats>;
}

/** Refreshes the MaxMind GeoLite2-City database by running `geoipupdate`,
 * but only when it's actually needed: skipped entirely when `confPath` is
 * unset (feature disabled) or missing (not configured), and skipped when
 * `GeoLite2-City.mmdb` already exists and is under 24h old. Never throws —
 * a missing `geoipupdate` binary, bad credentials, or a network failure is
 * logged and swallowed so it can never break app startup or the periodic
 * refresh timer. */
export async function ensureMaxmindData(
  confPath: string | undefined,
  dbDir: string,
  options: EnsureMaxmindDataOptions = {},
): Promise<void> {
  if (!confPath) return;
  if (!fs.existsSync(confPath)) {
    console.warn(`geoip: GEOIP_CONF_PATH (${confPath}) does not exist — skipping MaxMind refresh`);
    return;
  }

  const execFileFn = options.execFileFn ?? execFileAsync;
  const statFn = options.statFn ?? fs.promises.stat;
  const dbPath = path.join(dbDir, 'GeoLite2-City.mmdb');

  try {
    const stat = await statFn(dbPath);
    if (Date.now() - stat.mtimeMs < MAX_AGE_MS) return;
  } catch {
    // Doesn't exist yet — fall through and download it.
  }

  try {
    fs.mkdirSync(dbDir, { recursive: true });
    await execFileFn('geoipupdate', ['-f', confPath, '-d', dbDir]);
  } catch (err) {
    console.warn(
      `geoip: geoipupdate failed — keeping existing/no MaxMind data: ${(err as Error).message}`,
    );
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/geoip/ensureMaxmindData.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/geoip/ensureMaxmindData.ts backend/src/geoip/ensureMaxmindData.test.ts
git commit -m "Add age-gated geoipupdate invocation"
```

---

### Task 5: MaxMind → ipdeny fallback chain

The single function both `GeoipService` and (indirectly) the frontend rely on for "give me
the best available country+city for this IP."

**Files:**
- Create: `backend/src/geoip/resolveGeo.ts`
- Create: `backend/src/geoip/resolveGeo.test.ts`

**Interfaces:**
- Consumes: `lookupCity` from Task 3, `lookupCountry` from existing
  `backend/src/geoip/lookupCountry.ts` (`(db, ip: string) => string | null`).
- Produces: `resolveGeo(db, ip: string, maxmindDbPath: string, options?):
  Promise<GeoLookupResult>` (always resolves, never null — `{country: null, city: null}`
  is the "nothing found anywhere" case). Task 6 (`GeoipService`) consumes this.

- [ ] **Step 1: Write the failing test**

Create `backend/src/geoip/resolveGeo.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { resolveGeo } from './resolveGeo.js';

describe('resolveGeo', () => {
  let db: Database.Database;
  const MAXMIND_DB_PATH = '/data/maxmind/GeoLite2-City.mmdb';

  beforeEach(() => {
    db = createDb(':memory:');
    db.prepare('INSERT INTO geoip_v4_ranges (start_int, end_int, country) VALUES (?, ?, ?)').run(
      0,
      4294967295,
      'DE',
    );
  });

  it('returns the MaxMind result when it has a country', async () => {
    const lookupCityFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });

    const result = await resolveGeo(db, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: 'US', city: 'Mountain View' });
    expect(lookupCityFn).toHaveBeenCalledWith(MAXMIND_DB_PATH, '8.8.8.8');
  });

  it('falls back to ipdeny country (with null city) when MaxMind returns null', async () => {
    const lookupCityFn = vi.fn().mockResolvedValue(null);

    const result = await resolveGeo(db, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: 'DE', city: null });
  });

  it('falls back to ipdeny when MaxMind resolves but has no country', async () => {
    const lookupCityFn = vi.fn().mockResolvedValue({ country: null, city: 'Somewhere' });

    const result = await resolveGeo(db, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: 'DE', city: null });
  });

  it('returns all-null when both MaxMind and ipdeny have nothing', async () => {
    const emptyDb = createDb(':memory:');
    const lookupCityFn = vi.fn().mockResolvedValue(null);

    const result = await resolveGeo(emptyDb, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: null, city: null });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/geoip/resolveGeo.test.ts'`
Expected: FAIL with "Cannot find module './resolveGeo.js'" (or similar).

- [ ] **Step 3: Implement**

Create `backend/src/geoip/resolveGeo.ts`:

```ts
import type Database from 'better-sqlite3';
import { lookupCountry } from './lookupCountry.js';
import { lookupCity, type GeoLookupResult } from './maxmind.js';

export interface ResolveGeoOptions {
  lookupCityFn?: typeof lookupCity;
}

/** Country + city for an IP: tries the MaxMind GeoLite2-City mmdb first
 * (via `maxmindDbPath`), and falls back to the offline ipdeny CIDR-range
 * table (country only — ipdeny has no city data) whenever MaxMind has no
 * usable record (file missing, IP not found, or the lookup failed). */
export async function resolveGeo(
  db: Database.Database,
  ip: string,
  maxmindDbPath: string,
  options: ResolveGeoOptions = {},
): Promise<GeoLookupResult> {
  const lookupCityFn = options.lookupCityFn ?? lookupCity;
  const result = await lookupCityFn(maxmindDbPath, ip);
  if (result && result.country) return result;
  return { country: lookupCountry(db, ip), city: null };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/geoip/resolveGeo.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/geoip/resolveGeo.ts backend/src/geoip/resolveGeo.test.ts
git commit -m "Add MaxMind-to-ipdeny GeoIP fallback chain"
```

---

### Task 6: `GeoipService`

A structural mirror of `WhoisService`/`DnsService`: its own cache table, its own TTL, no
knowledge of WHOIS.

**Files:**
- Modify: `backend/src/db/schema.sql`
- Create: `backend/src/services/geoip.ts`
- Create: `backend/src/services/geoip.test.ts`

**Interfaces:**
- Consumes: `resolveHost`/`ResolveHostFn` (Task 2), `resolveGeo` (Task 5).
- Produces: `GeoipSummary { country: string | null; city: string | null }`,
  `GeoipService` with constructor `(db, options?: { resolveHostFn?, resolveGeoFn?,
  maxmindDbPath?: string })` and `async getSummary(host: string): Promise<GeoipSummary>`.
  Task 7 (`routes/geoip.ts`) and Task 8 (`app.ts`) consume this class.

- [ ] **Step 1: Add the `geoip_cache` table to the schema**

In `backend/src/db/schema.sql`, after the `dns_cache` table definition (and before the
`geoip_v4_ranges` comment block), add:

```sql
-- Cached GeoIP (country + city) summaries, keyed by host. A separate data
-- source and cache from whois_cache: GeoIP is IP location, WHOIS is IP
-- ownership — deliberately not merged. 30-day TTL, same reasoning as
-- whois_cache (location/allocation data changes about as rarely as WHOIS
-- registrant data).
CREATE TABLE IF NOT EXISTS geoip_cache (
  host TEXT PRIMARY KEY,
  country TEXT,
  city TEXT,
  fetched_at TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/services/geoip.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { GeoipService } from './geoip.js';

describe('GeoipService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('getSummary', () => {
    it('resolves the host to an IP and returns the geo result', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });

      const summary = await service.getSummary('dns.google');

      expect(resolveHostFn).toHaveBeenCalledWith('dns.google');
      expect(resolveGeoFn).toHaveBeenCalledWith(db, '8.8.8.8', expect.any(String));
      expect(summary).toEqual({ country: 'US', city: 'Mountain View' });
    });

    it('returns all-null without calling resolveGeo when the host cannot be resolved', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue(null);
      const resolveGeoFn = vi.fn();
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });

      const summary = await service.getSummary('unresolvable.example');

      expect(resolveGeoFn).not.toHaveBeenCalled();
      expect(summary).toEqual({ country: null, city: null });
    });

    it('serves a fresh cached summary without calling resolveHost or resolveGeo again', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });

      await service.getSummary('dns.google');
      await service.getSummary('dns.google');

      expect(resolveHostFn).toHaveBeenCalledTimes(1);
      expect(resolveGeoFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches when the cached row is older than the 30-day TTL', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });
      await service.getSummary('dns.google');

      db.prepare('UPDATE geoip_cache SET fetched_at = ? WHERE host = ?').run(
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        'dns.google',
      );

      await service.getSummary('dns.google');
      expect(resolveGeoFn).toHaveBeenCalledTimes(2);
    });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/services/geoip.test.ts'`
Expected: FAIL with "Cannot find module './geoip.js'" (or similar).

- [ ] **Step 4: Implement**

Create `backend/src/services/geoip.ts`:

```ts
import type Database from 'better-sqlite3';
import { resolveGeo } from '../geoip/resolveGeo.js';
import { resolveHost, type ResolveHostFn } from '../net/resolveHost.js';

export interface GeoipSummary {
  country: string | null;
  city: string | null;
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  country: string | null;
  city: string | null;
  fetched_at: string;
}

export interface GeoipServiceOptions {
  resolveHostFn?: ResolveHostFn;
  resolveGeoFn?: typeof resolveGeo;
  maxmindDbPath?: string;
}

/** Country + city for a hop host, cache-first. Structural mirror of
 * WhoisService/DnsService: its own cache table, its own TTL, and no
 * knowledge of WHOIS data — GeoIP (location) and WHOIS (ownership) are
 * deliberately separate concerns. */
export class GeoipService {
  private resolveHostFn: ResolveHostFn;
  private resolveGeoFn: typeof resolveGeo;
  private maxmindDbPath: string;

  constructor(
    private db: Database.Database,
    options: GeoipServiceOptions = {},
  ) {
    this.resolveHostFn = options.resolveHostFn ?? resolveHost;
    this.resolveGeoFn = options.resolveGeoFn ?? resolveGeo;
    this.maxmindDbPath = options.maxmindDbPath ?? './geoip-maxmind/GeoLite2-City.mmdb';
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM geoip_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    return Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
  }

  async getSummary(host: string): Promise<GeoipSummary> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { country: cached.country, city: cached.city };
    }

    const ip = await this.resolveHostFn(host);
    const geo: GeoipSummary = ip
      ? await this.resolveGeoFn(this.db, ip, this.maxmindDbPath)
      : { country: null, city: null };
    const fetchedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO geoip_cache (host, country, city, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           country = excluded.country,
           city = excluded.city,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, geo.country, geo.city, fetchedAt);

    return geo;
  }
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/services/geoip.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/schema.sql backend/src/services/geoip.ts backend/src/services/geoip.test.ts
git commit -m "Add GeoipService, decoupled from WHOIS"
```

---

### Task 7: `POST /api/geoip/bulk` route

Mirrors `routes/whois.ts`'s bulk endpoint exactly (same validation, cap, per-host-failure
handling), backed by `GeoipService`.

**Files:**
- Create: `backend/src/routes/geoip.ts`
- Create: `backend/src/routes/geoip.test.ts`

**Interfaces:**
- Consumes: `GeoipService`, `GeoipSummary` (Task 6).
- Produces: `registerGeoipRoutes(app: Hono, geoipService: GeoipService): void`. Task 8
  (`app.ts`) calls this.

- [ ] **Step 1: Write the failing test**

Create `backend/src/routes/geoip.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { GeoipService } from '../services/geoip.js';
import { registerGeoipRoutes } from './geoip.js';

describe('geoip routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('POST /api/geoip/bulk', () => {
    it('returns a country/city summary per requested host', async () => {
      const app = new Hono();
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      registerGeoipRoutes(app, new GeoipService(db, { resolveHostFn, resolveGeoFn }));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { country: 'US', city: 'Mountain View' },
        '8.8.8.8': { country: 'US', city: 'Mountain View' },
      });
    });

    it('returns 400 when hosts is missing or not an array', async () => {
      const app = new Hono();
      registerGeoipRoutes(app, new GeoipService(db));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });

    it('silently drops invalid hosts and de-duplicates repeats instead of failing the batch', async () => {
      const app = new Hono();
      const resolveHostFn = vi.fn().mockResolvedValue('1.1.1.1');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' });
      registerGeoipRoutes(app, new GeoipService(db, { resolveHostFn, resolveGeoFn }));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '1.1.1.1', 'bad;host', 42] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ '1.1.1.1': { country: 'DE', city: 'Berlin' } });
      expect(resolveGeoFn).toHaveBeenCalledTimes(1);
    });

    it('returns a null summary for a host whose lookup fails, without failing the batch', async () => {
      const app = new Hono();
      const resolveHostFn = vi.fn().mockImplementation(async (host: string) => {
        if (host === '9.9.9.9') throw new Error('boom');
        return '1.1.1.1';
      });
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' });
      registerGeoipRoutes(app, new GeoipService(db, { resolveHostFn, resolveGeoFn }));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '9.9.9.9'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { country: 'DE', city: 'Berlin' },
        '9.9.9.9': { country: null, city: null },
      });
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/routes/geoip.test.ts'`
Expected: FAIL with "Cannot find module './geoip.js'" (or similar).

- [ ] **Step 3: Implement**

Create `backend/src/routes/geoip.ts`:

```ts
import type { Hono } from 'hono';
import type { GeoipService, GeoipSummary } from '../services/geoip.js';

// Mirrors backend/src/routes/whois.ts's VALID_HOST/MAX_BULK_HOSTS exactly.
const VALID_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
const MAX_BULK_HOSTS = 200;

export function registerGeoipRoutes(app: Hono, geoipService: GeoipService) {
  // Bulk country+city summaries for lazily loading GeoIP data across every
  // hop currently shown on the map in one round trip. Cache-backed (see
  // GeoipService). A per-host failure yields a null summary for that host
  // rather than failing the whole batch.
  app.post('/api/geoip/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.hosts)) {
      return c.json({ error: 'hosts must be an array' }, 400);
    }
    const hosts: string[] = [...new Set(body.hosts)]
      .filter((h): h is string => typeof h === 'string' && VALID_HOST.test(h))
      .slice(0, MAX_BULK_HOSTS);

    const entries = await Promise.all(
      hosts.map(async (host): Promise<[string, GeoipSummary]> => {
        try {
          return [host, await geoipService.getSummary(host)];
        } catch {
          return [host, { country: null, city: null }];
        }
      }),
    );

    return c.json(Object.fromEntries(entries));
  });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/routes/geoip.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/geoip.ts backend/src/routes/geoip.test.ts
git commit -m "Add POST /api/geoip/bulk route"
```

---

### Task 8: Wire `GeoipService` and MaxMind refresh into `app.ts`

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/app.test.ts`

**Interfaces:**
- Consumes: `GeoipService` (Task 6), `registerGeoipRoutes` (Task 7), `ensureMaxmindData`
  (Task 4).
- Produces: `createApp(options)` accepts a new `startMaxmindRefresh?: boolean` option
  (mirrors `startScheduler`, defaults on, must be `false` in tests) and exposes
  `POST /api/geoip/bulk`.

- [ ] **Step 1: Write the failing test**

Replace `backend/src/app.test.ts` in full:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp } from './app.js';
import { createDb } from './db/client.js';

vi.mock('./geoip/ensureMaxmindData.js', () => ({
  ensureMaxmindData: vi.fn().mockResolvedValue(undefined),
}));

import { ensureMaxmindData } from './geoip/ensureMaxmindData.js';

describe('createApp', () => {
  beforeEach(() => {
    vi.mocked(ensureMaxmindData).mockClear();
  });

  it('responds to GET /api/health with ok status', async () => {
    const app = createApp({
      db: createDb(':memory:'),
      startScheduler: false,
      startMaxmindRefresh: false,
    });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('wires target creation through to the map endpoint', async () => {
    const app = createApp({
      db: createDb(':memory:'),
      startScheduler: false,
      startMaxmindRefresh: false,
    });
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

  it('wires the geoip bulk endpoint', async () => {
    const app = createApp({
      db: createDb(':memory:'),
      startScheduler: false,
      startMaxmindRefresh: false,
    });
    const res = await app.request('/api/geoip/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('triggers a MaxMind refresh on startup by default', () => {
    createApp({ db: createDb(':memory:'), startScheduler: false });
    expect(ensureMaxmindData).toHaveBeenCalledTimes(1);
  });

  it('skips the MaxMind refresh when startMaxmindRefresh is false', () => {
    createApp({ db: createDb(':memory:'), startScheduler: false, startMaxmindRefresh: false });
    expect(ensureMaxmindData).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm the new tests fail**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/app.test.ts'`
Expected: FAIL — `/api/geoip/bulk` doesn't exist yet (404), `startMaxmindRefresh` is an
unknown option, `ensureMaxmindData` is never called.

- [ ] **Step 3: Implement**

In `backend/src/app.ts`, add these imports alongside the existing ones:

```ts
import path from 'node:path';
import { GeoipService } from './services/geoip.js';
import { registerGeoipRoutes } from './routes/geoip.js';
import { ensureMaxmindData } from './geoip/ensureMaxmindData.js';
```

Change the `CreateAppOptions` interface to:

```ts
export interface CreateAppOptions {
  db?: Database.Database;
  runMtrFn?: typeof runMtr;
  startScheduler?: boolean;
  startMaxmindRefresh?: boolean;
}
```

Change the body of `createApp` to (full replacement of the function):

```ts
export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? createDb(process.env.DB_PATH ?? './data/mtr-dash.sqlite3');
  loadGeoipData(db, process.env.GEOIP_DATA_DIR ?? './geoip');

  const maxmindDbDir =
    process.env.MAXMIND_DB_DIR ??
    path.join(path.dirname(process.env.DB_PATH ?? './data/mtr-dash.sqlite3'), 'maxmind');
  const maxmindDbPath = path.join(maxmindDbDir, 'GeoLite2-City.mmdb');

  const targetsService = new TargetsService(db);
  const runsService = new RunsService(db);
  const mapService = new MapService(db);
  const deviationsService = new DeviationsService(db);
  const positionsService = new PositionsService(db);
  const whoisService = new WhoisService(db);
  const dnsService = new DnsService(db);
  const geoipService = new GeoipService(db, { maxmindDbPath });
  const sseHub = new SseHub();
  const scheduler = new Scheduler(targetsService, runsService, sseHub, options.runMtrFn ?? runMtr);

  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  registerTargetRoutes(app, targetsService, scheduler);
  registerMapRoutes(app, mapService);
  registerDeviationRoutes(app, deviationsService);
  registerPositionRoutes(app, positionsService);
  registerStreamRoutes(app, sseHub);
  registerWhoisRoutes(app, whoisService);
  registerDnsRoutes(app, dnsService);
  registerGeoipRoutes(app, geoipService);
  registerRunRoutes(app, runsService);

  if (options.startScheduler !== false) scheduler.start();

  if (options.startMaxmindRefresh !== false) {
    const refresh = () => {
      ensureMaxmindData(process.env.GEOIP_CONF_PATH, maxmindDbDir).catch((err) =>
        console.warn(`geoip: maxmind refresh failed: ${(err as Error).message}`),
      );
    };
    refresh();
    setInterval(refresh, 24 * 60 * 60 * 1000).unref();
  }

  return app;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npx vitest run src/app.test.ts'`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npm test'`
Expected: PASS — every backend test, old and new.

- [ ] **Step 6: Commit**

```bash
git add backend/src/app.ts backend/src/app.test.ts
git commit -m "Wire GeoipService and MaxMind refresh into app.ts"
```

---

### Task 9: Docker, compose, and `.gitignore`

Adds the `geoipupdate` binary to the runtime image, mounts `.GeoIP.conf` at runtime
(never baked into the image), and keeps it out of git.

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.gitignore`

**Interfaces:** None (infrastructure-only; no code depends on these files).

- [ ] **Step 1: Add `geoipupdate` to the runtime image**

In `Dockerfile`, in the `# ---- Stage 4: runtime ----` section, change:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libcap2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

to:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libcap2 ca-certificates geoipupdate \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Mount `.GeoIP.conf` and set `GEOIP_CONF_PATH` in compose**

Replace `docker-compose.yml` in full:

```yaml
services:
  mtr-dash:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - mtr-data:/data
      - ./.GeoIP.conf:/app/GeoIP.conf:ro
    environment:
      - GEOIP_CONF_PATH=/app/GeoIP.conf
    cap_add:
      - NET_RAW
      - NET_ADMIN
    restart: unless-stopped

volumes:
  mtr-data:

networks:
  default:
    enable_ipv6: true
```

- [ ] **Step 3: Gitignore `.GeoIP.conf`**

In `.gitignore`, add a line right after `.env`:

```
.GeoIP.conf
```

(The full block should read `.worktrees/`, `.claude/settings.local.json`, `.mcp.json`,
`.env`, `.GeoIP.conf`, `HANDOFF.md`, then the rest unchanged.)

- [ ] **Step 4: Verify `.GeoIP.conf` is no longer trackable**

Run: `git status --short .GeoIP.conf`
Expected: no output (the file is untracked and now ignored, so git reports nothing for
it — confirm with `git check-ignore .GeoIP.conf` instead, which should print
`.GeoIP.conf`).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .gitignore
git commit -m "Wire geoipupdate + .GeoIP.conf mount into Docker build/compose"
```

---

### Task 10: Frontend types + API client

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/client.test.ts`

**Interfaces:**
- Produces: `GeoipSummary { country: string | null; city: string | null }` (new),
  `WhoisSummary { netname: string | null }` (shrunk — matches Task 1's backend shape),
  `api.getGeoipBulk(hosts: string[]): Promise<Record<string, GeoipSummary>>`. Tasks 11–12
  (`HopNode.tsx`, `NetworkMap.tsx`) consume these.

- [ ] **Step 1: Write the failing test**

In `frontend/src/api/client.test.ts`, add this test after the existing
`'sends a POST with the host list when requesting bulk whois summaries'` test:

```ts
  it('sends a POST with the host list when requesting bulk geoip summaries', async () => {
    await api.getGeoipBulk(['1.1.1.1', '8.8.8.8']);
    expect(fetch).toHaveBeenCalledWith(
      '/api/geoip/bulk',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      }),
    );
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/api/client.test.ts'`
Expected: FAIL — `api.getGeoipBulk` is not a function.

- [ ] **Step 3: Update `types.ts`**

In `frontend/src/types.ts`, replace:

```ts
export interface WhoisSummary {
  netname: string | null;
  country: string | null;
}
```

with:

```ts
export interface WhoisSummary {
  netname: string | null;
}

export interface GeoipSummary {
  country: string | null;
  city: string | null;
}
```

- [ ] **Step 4: Update `api/client.ts`**

In `frontend/src/api/client.ts`, change the type import line from:

```ts
import type {
  AddressFamily,
  Target,
  MapResult,
  Deviation,
  HistoryResult,
  WhoisResult,
  WhoisSummary,
  RunHistoryEntry,
} from '../types.js';
```

to:

```ts
import type {
  AddressFamily,
  Target,
  MapResult,
  Deviation,
  HistoryResult,
  WhoisResult,
  WhoisSummary,
  GeoipSummary,
  RunHistoryEntry,
} from '../types.js';
```

Then add this alongside the existing `getDnsBulk` entry in the `api` object:

```ts
  getGeoipBulk: (hosts: string[]) =>
    request<Record<string, GeoipSummary>>('/geoip/bulk', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/api/client.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "Add GeoipSummary type and getGeoipBulk API client method"
```

---

### Task 11: `HopNode.tsx` city line

**Files:**
- Modify: `frontend/src/components/HopNode.tsx`
- Modify: `frontend/src/components/HopNode.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `HopNodeData` gains `city?: string | null`. Task 12 (`NetworkMap.tsx`)
  populates this field.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/HopNode.test.tsx`, add these tests after the existing
`'renders nothing extra when resolvedHost is absent'` test:

```ts
  it('renders the city and country together when both are present', () => {
    renderNode({ host: '192.168.1.1', ttl: 3, active: true, country: 'DE', city: 'Frankfurt' });
    expect(screen.getByText('Frankfurt, DE')).toBeInTheDocument();
  });

  it('renders the city alone when country is absent', () => {
    renderNode({ host: '192.168.1.1', ttl: 3, active: true, city: 'Frankfurt' });
    expect(screen.getByText('Frankfurt')).toBeInTheDocument();
  });

  it('renders nothing extra when city is absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node-geo')).toBeNull();
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/HopNode.test.tsx'`
Expected: FAIL — no element with text "Frankfurt, DE" is rendered.

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
}

// `Flags` exports one component per ISO 3166-1 alpha-2 code (e.g. `Flags.US`);
// country codes come from the geoip lookup (a data source, not a fixed enum
// at compile time), so this is always a dynamic, string-keyed lookup.
const FlagComponents = Flags as unknown as Record<string, React.ComponentType>;

export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, city, resolvedHost, inferred } =
    data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div
      className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}${inferred ? ' inferred' : ''}`}
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

In `frontend/src/styles.css`, insert this block right after the
`.hop-node.inactive .hop-node-hostname { color: var(--text-faint); }` rule and before the
`.hop-node-netname` rule:

```css
.hop-node-geo {
  margin-top: 0.2rem;
  font-family: var(--font-ui);
  font-size: 0.66rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hop-node.inactive .hop-node-geo {
  color: var(--text-faint);
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/HopNode.test.tsx'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HopNode.tsx frontend/src/components/HopNode.test.tsx frontend/src/styles.css
git commit -m "Render city name on HopNode"
```

---

### Task 12: `NetworkMap.tsx` geoip bulk-load wiring

Adds a third independent lazy bulk-load (alongside the existing whois and DNS ones),
feeding `country`/`city` into `displayNodes` from `GeoipService` instead of
`WhoisService`.

**Files:**
- Modify: `frontend/src/components/NetworkMap.tsx`
- Modify: `frontend/src/components/NetworkMap.test.tsx`

**Interfaces:**
- Consumes: `api.getGeoipBulk` (Task 10), `HopNodeData.city` (Task 11).

- [ ] **Step 1: Update the test mock and existing test to the new (decoupled) shape**

In `frontend/src/components/NetworkMap.test.tsx`, replace the `vi.mock` block:

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

with:

```ts
vi.mock('../api/client.js', () => ({
  api: {
    setNodePosition: vi.fn(),
    getWhois: vi.fn(),
    getWhoisBulk: vi.fn().mockResolvedValue({}),
    getDnsBulk: vi.fn().mockResolvedValue({}),
    getGeoipBulk: vi.fn().mockResolvedValue({}),
  },
}));
```

Then replace this test (currently around line 334):

```ts
  it('renders netname and a country flag inline once the bulk summary resolves', async () => {
    vi.mocked(api.getWhoisBulk).mockResolvedValue({
      '192.168.1.1': { netname: 'EXAMPLE-NET', country: 'US' },
    });
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);

    await screen.findByText('EXAMPLE-NET');
    expect(container.querySelector('.hop-node-flag')).not.toBeNull();
  });
```

with:

```ts
  it('renders the netname once the whois bulk summary resolves', async () => {
    vi.mocked(api.getWhoisBulk).mockResolvedValue({
      '192.168.1.1': { netname: 'EXAMPLE-NET' },
    });
    render(<NetworkMap targetId={1} mapData={mapData} />);

    await screen.findByText('EXAMPLE-NET');
  });

  it('renders a country flag and city once the geoip bulk summary resolves', async () => {
    vi.mocked(api.getGeoipBulk).mockResolvedValue({
      '192.168.1.1': { country: 'US', city: 'Mountain View' },
    });
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);

    await screen.findByText('Mountain View, US');
    expect(container.querySelector('.hop-node-flag')).not.toBeNull();
  });

  it('lazily bulk-loads geoip summaries for every hop host on mount, without any click', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(api.getGeoipBulk).toHaveBeenCalledWith(['192.168.1.1']);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/NetworkMap.test.tsx'`
Expected: FAIL — `country`/`city` never appear because `NetworkMap` doesn't call
`getGeoipBulk` yet.

- [ ] **Step 3: Implement**

In `frontend/src/components/NetworkMap.tsx`, change the type import line from:

```ts
import type { MapResult, WhoisResult, WhoisSummary } from '../types.js';
```

to:

```ts
import type { MapResult, WhoisResult, WhoisSummary, GeoipSummary } from '../types.js';
```

Add this new effect right after the existing `dnsHostnames` effect block (after the
`}, [uniqueHosts]);` that closes the DNS-loading `useEffect`):

```tsx
  // Lazily loads country+city for every hop currently on the map — same
  // fetch-once-per-host strategy as whoisSummaries/dnsHostnames above, but
  // a fully separate data source and cache (GeoIP location vs. WHOIS
  // ownership are deliberately not correlated; see backend/src/services/geoip.ts).
  const [geoipSummaries, setGeoipSummaries] = useState<Record<string, GeoipSummary>>({});
  const requestedGeoipHostsRef = useRef(new Set<string>());

  useEffect(() => {
    const newHosts = uniqueHosts.filter((host) => !requestedGeoipHostsRef.current.has(host));
    if (newHosts.length === 0) return;
    newHosts.forEach((host) => requestedGeoipHostsRef.current.add(host));
    api
      .getGeoipBulk(newHosts)
      .then((summaries) => setGeoipSummaries((prev) => ({ ...prev, ...summaries })))
      .catch(() => {
        newHosts.forEach((host) => requestedGeoipHostsRef.current.delete(host));
      });
  }, [uniqueHosts]);
```

Then replace the `displayNodes` memo:

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

with:

```tsx
  const displayNodes = useMemo<Node[]>(
    () =>
      initialNodes.map((node) => {
        const host = (node.data as { host: string }).host;
        const summary = whoisSummaries[host];
        const geo = geoipSummaries[host];
        return {
          ...node,
          data: {
            ...node.data,
            netname: summary?.netname ?? null,
            country: geo?.country ?? null,
            city: geo?.city ?? null,
            resolvedHost: dnsHostnames[host] ?? null,
          },
        };
      }),
    [initialNodes, whoisSummaries, geoipSummaries, dnsHostnames],
  );
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npx vitest run src/components/NetworkMap.test.tsx'`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite**

Run: `docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npm test'`
Expected: PASS — every frontend test, old and new.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/NetworkMap.tsx frontend/src/components/NetworkMap.test.tsx
git commit -m "Wire independent geoip bulk-load into NetworkMap"
```

---

### Task 13: README updates

Document the shipped feature: the new GeoIP/WHOIS split, MaxMind configuration, and API
surface. Done last among the doc-bearing tasks so the test counts quoted are the real,
final ones.

**Files:**
- Modify: `README.md`

**Interfaces:** None (documentation-only).

- [ ] **Step 1: Get the final test counts**

Run:
```bash
docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/backend node:20-bookworm-slim sh -c 'npm test' 2>&1 | tail -5
docker run --rm -v /home/jkumar/Github/MTR-dash:/repo -w /repo/frontend node:20-bookworm-slim sh -c 'npm test' 2>&1 | tail -5
```
Note the two "N passed" counts reported by Vitest — you'll need them for Step 5.

- [ ] **Step 2: Rewrite the "Whois + GeoIP" section**

In `README.md`, replace:

```markdown
### Whois + GeoIP, lazily loaded and cached
- Click any hop node for a **whois lookup** (via a native WHOIS-protocol client — no OS package or
  external CLI needed), shown as a scrollable table anchored to your cursor.
- **NETNAME** and a **country flag** are loaded lazily and shown right on the node for every hop
  on the map — no click required, and nothing blocks the initial render.
- Whois results are **cached in SQLite** (30-day TTL) — repeat views of the same host are instant.
- Country lookup is **fully offline at runtime**: IPv4/IPv6 CIDR-to-country data from
  [ipdeny.com](https://www.ipdeny.com/) is downloaded and baked into the Docker image at *build*
  time, so there's no dependency on any third-party IP-geolocation API in production.
- Hops that only report a reverse-DNS hostname (not a raw IP) are forward-resolved before the
  GeoIP lookup, so flags/countries show up for the common case, not just raw-IP hops.
- Any IP-looking value (a hop's host, or a whois field like `NetRange`) is **click-to-copy**, with
  brief visual feedback.
```

with:

```markdown
### Whois + GeoIP — two separate data sources, both lazily loaded and cached
- Click any hop node for a **whois lookup** (via a native WHOIS-protocol client — no OS package or
  external CLI needed), shown as a scrollable table anchored to your cursor.
- **NETNAME** (from WHOIS, IP *ownership*) and a **country flag + city** (from GeoIP, IP
  *location*) are loaded lazily and shown right on the node for every hop on the map — no click
  required, and nothing blocks the initial render. These are deliberately separate lookups with
  separate SQLite caches (`whois_cache`, `geoip_cache`, both 30-day TTL) — WHOIS ownership data
  and GeoIP location data are different concerns and are never correlated.
- **GeoIP location** tries a MaxMind GeoLite2-City database first (country + city), falling back
  to an offline ipdeny.com IPv4/IPv6 CIDR-range table (country only) whenever MaxMind has no
  usable record — including when it isn't configured at all, which is the default. See
  [Configuration](#configuration) for enabling MaxMind.
- Hops that only report a reverse-DNS hostname (not a raw IP) are forward-resolved before either
  lookup, so netnames/flags/cities show up for the common case, not just raw-IP hops.
- Any IP-looking value (a hop's host, or a whois field like `NetRange`) is **click-to-copy**, with
  brief visual feedback.
```

- [ ] **Step 3: Update the architecture section's GeoIP bullet**

In `README.md`, replace:

```markdown
- **GeoIP** — [ipdeny.com](https://www.ipdeny.com/)'s country CIDR-block lists, downloaded and
  converted into SQLite range tables at Docker build time; looked up via an indexed
  "closest start ≤ ip" query for both IPv4 (32-bit int) and IPv6 (128-bit value, stored as a
  fixed-width hex string for correct ordering).
```

with:

```markdown
- **GeoIP** — [MaxMind GeoLite2-City](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)
  (country + city) when configured, via the official `geoipupdate` tool run by the backend itself
  at startup and on a 24h interval (skipped entirely when the mmdb file is already fresh, or when
  MaxMind isn't configured). Falls back to [ipdeny.com](https://www.ipdeny.com/)'s country
  CIDR-block lists (downloaded and converted into SQLite range tables at Docker build time,
  looked up via an indexed "closest start ≤ ip" query for both IPv4 and IPv6) whenever MaxMind has
  nothing for an IP. Kept as a fully separate service/cache from WHOIS — see above.
```

- [ ] **Step 4: Update the env var and API reference tables**

In `README.md`'s Configuration section, replace:

```markdown
| `GEOIP_DATA_DIR` | `/app/geoip` | Where the baked GeoIP JSON data lives |
```

with:

```markdown
| `GEOIP_DATA_DIR` | `/app/geoip` | Where the baked ipdeny GeoIP JSON data (fallback) lives |
| `GEOIP_CONF_PATH` | *(unset)* | Path to a MaxMind `geoipupdate` config file (see `.GeoIP.conf.example` conventions at [dev.maxmind.com](https://dev.maxmind.com/geoip/updating-databases)); unset disables MaxMind entirely, falling back to ipdeny only |
| `MAXMIND_DB_DIR` | `<dir of DB_PATH>/maxmind` | Where the downloaded MaxMind `.mmdb` files live |
```

In the API reference table, replace:

```markdown
| `POST` | `/whois/bulk` | `{hosts: string[]}` → `{[host]: {netname, country}}` (cached, batched) |
| `POST` | `/dns/bulk` | `{hosts: string[]}` → `{[ip]: hostname \| null}` (reverse DNS, cached, batched) |
```

with:

```markdown
| `POST` | `/whois/bulk` | `{hosts: string[]}` → `{[host]: {netname}}` (cached, batched) |
| `POST` | `/dns/bulk` | `{hosts: string[]}` → `{[ip]: hostname \| null}` (reverse DNS, cached, batched) |
| `POST` | `/geoip/bulk` | `{hosts: string[]}` → `{[host]: {country, city}}` (MaxMind, ipdeny fallback; cached, batched) |
```

- [ ] **Step 5: Update the test-count line with the real numbers from Step 1**

In `README.md`, replace:

```markdown
cd backend && npm test     # 196 tests — services, routes, geoip, whois, dns, scheduler
cd frontend && npm test    # 105 tests — components, hooks, API client
```

with the actual counts observed in Step 1, e.g. (substitute the real numbers):

```markdown
cd backend && npm test     # <N> tests — services, routes, geoip, whois, dns, scheduler
cd frontend && npm test    # <N> tests — components, hooks, API client
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document the MaxMind GeoIP feature and WHOIS/GeoIP split"
```

---

### Task 14: Full Docker build verification

Per this repo's `CLAUDE.md`, the Docker build is the source of truth — bare `tsc`/`npm
run build` isn't sufficient sign-off.

**Files:** None (verification only).

**Interfaces:** None.

- [ ] **Step 1: Build and start the full stack**

Run: `cd /home/jkumar/Github/MTR-dash && docker compose up -d --build`
Expected: build succeeds (frontend + backend compile cleanly, `geoipupdate` installs in
the runtime stage), container starts and stays up.

- [ ] **Step 2: Confirm the backend is healthy**

Run: `curl -s http://localhost:3000/api/health`
Expected: `{"status":"ok"}`

- [ ] **Step 3: Confirm the geoip bulk endpoint responds**

Run: `curl -s -X POST http://localhost:3000/api/geoip/bulk -H 'Content-Type: application/json' -d '{"hosts":["8.8.8.8"]}'`
Expected: `{"8.8.8.8":{"country":"US","city":<string or null>}}` if `.GeoIP.conf` is
present and valid (MaxMind data downloaded on startup), or `{"8.8.8.8":{"country":"US","city":null}}`
(ipdeny fallback) if `.GeoIP.conf` is absent/invalid — either is a correct outcome, not a
failure.

- [ ] **Step 4: Check the startup logs for the MaxMind refresh outcome**

Run: `docker compose logs mtr-dash | grep -i geoip`
Expected: either no output (MaxMind data was already fresh) or a line reporting the
`geoipupdate` invocation's outcome (success, or a swallowed warning if credentials/network
are unavailable in this environment) — confirms `ensureMaxmindData` ran without crashing
the app either way.

- [ ] **Step 5: Open the dashboard and visually confirm the city line**

Visit `http://localhost:3000` in a browser, add or select a target with real internet
hops, and confirm a hop node shows a country flag plus a city name beneath the resolved
hostname (e.g. "Mountain View, US"). If `.GeoIP.conf` isn't configured in this
environment, confirm instead that behavior is unchanged from before this feature (flag
shown, no city line) — i.e. the fallback path works.

- [ ] **Step 6: Report status to the user**

No commit for this task — it's a verification checkpoint. Report the outcome of Steps
1–5 (especially whether `.GeoIP.conf` was actually exercised or the ipdeny fallback was
used) back to the user.
