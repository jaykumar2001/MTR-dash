# Per-Target Address Family (-4/-6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-target `addressFamily: 'auto' | 'ipv4' | 'ipv6'` setting that appends `-4`/`-6` to the `mtr` invocation, so dual-stack hostnames can be monitored over a chosen IP family.

**Architecture:** Wiring follows the existing `maxStaleHops` precedent end to end: SQLite column with guarded `ALTER TABLE` migration → `TargetsService` field with save-time validation → scheduler passes it to `runMtr`, which appends the flag → REST body field → `ConfigPanel` select. Spec: `docs/superpowers/specs/2026-07-16-address-family-design.md`.

**Tech Stack:** Hono + better-sqlite3 backend, Vite/React frontend, vitest in both packages, TypeScript strict.

## Global Constraints

- `backend/` and `frontend/` are independent npm packages — always `cd` into the right one before running commands.
- No lint/format tooling: `npm run build` (tsc) and `npm test` (vitest) are the only checks.
- The Docker build is the source of truth — final verification is `docker compose up -d --build`.
- The three setting values are exactly the strings `'auto'`, `'ipv4'`, `'ipv6'`; DB column is `address_family TEXT NOT NULL DEFAULT 'auto'`; JSON field is `addressFamily`.
- `'auto'` must preserve today's behavior byte-for-byte: mtr args `['--report', '--report-cycles=N', '-j', '-n', host]` with no family flag.
- Commit messages: plain imperative sentences (no `feat:` prefixes — match `git log`), each ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `AddressFamily` type + runner flag

**Files:**
- Modify: `backend/src/mtr/types.ts` (add one exported type)
- Modify: `backend/src/mtr/runner.ts`
- Test: `backend/src/mtr/runner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type AddressFamily = 'auto' | 'ipv4' | 'ipv6'` in `mtr/types.ts`; `runMtr(host: string, cycles: number, family?: AddressFamily, mtrBin?: string)` — note `family` is inserted **before** the existing `mtrBin` optional param, so existing 3-arg call sites that passed `mtrBin` third must become 4-arg.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('runMtr', ...)` block in `backend/src/mtr/runner.test.ts` (reuse the file's existing `execFileMock`; the mock JSON body is identical to the first test's):

```ts
  it.each([
    ['ipv4', '-4'],
    ['ipv6', '-6'],
  ] as const)('appends %s flag %s before the host', async (family, flag) => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(null, JSON.stringify({
        report: { mtr: { dst: 'example.com' }, hubs: [] },
      }), '');
    });

    await runMtr('example.com', 5, family, 'mtr');

    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '-n', flag, 'example.com'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('passes no family flag for auto', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(null, JSON.stringify({
        report: { mtr: { dst: 'example.com' }, hubs: [] },
      }), '');
    });

    await runMtr('example.com', 5, 'auto', 'mtr');

    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '-n', 'example.com'],
      expect.any(Object),
      expect.any(Function),
    );
  });
```

Also update the two existing tests' calls from `runMtr('1.1.1.1', 5, 'mtr')` to `runMtr('1.1.1.1', 5, 'auto', 'mtr')` (both occurrences — `mtrBin` moves to fourth position).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd backend && npx vitest run src/mtr/runner.test.ts`
Expected: the two new tests FAIL (extra `'mtr'`/family args mismatch); existing tests fail too until the signature changes — that's fine at this step.

- [ ] **Step 3: Implement**

In `backend/src/mtr/types.ts`, add at the top level:

```ts
export type AddressFamily = 'auto' | 'ipv4' | 'ipv6';
```

Replace the signature and args construction in `backend/src/mtr/runner.ts`:

```ts
import { execFile } from 'node:child_process';
import { parseMtrJson } from './parser.js';
import type { AddressFamily, MtrReport } from './types.js';

export function runMtr(
  host: string,
  cycles: number,
  family: AddressFamily = 'auto',
  mtrBin: string = process.env.MTR_BIN ?? 'mtr',
): Promise<MtrReport> {
  const args = ['--report', `--report-cycles=${cycles}`, '-j', '-n'];
  if (family === 'ipv4') args.push('-4');
  if (family === 'ipv6') args.push('-6');
  args.push(host);
  return new Promise((resolve, reject) => {
    execFile(
      mtrBin,
      args,
      { timeout: (cycles + 10) * 2000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseMtrJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/mtr/runner.test.ts`
Expected: all runner tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/mtr/types.ts backend/src/mtr/runner.ts backend/src/mtr/runner.test.ts
git commit -m "Add address-family flag support to the mtr runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: DB column + migration

**Files:**
- Modify: `backend/src/db/schema.sql` (targets table, after `max_stale_hops`)
- Modify: `backend/src/db/client.ts`
- Test: `backend/src/db/client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `targets.address_family TEXT NOT NULL DEFAULT 'auto'` column, present on both fresh and pre-existing databases.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('createDb', ...)` in `backend/src/db/client.test.ts` (add `import fs from 'node:fs';`, `import os from 'node:os';`, `import path from 'node:path';`, and `import Database from 'better-sqlite3';` to the imports):

```ts
  it('defaults address_family to auto on fresh databases', () => {
    const db = createDb(':memory:');
    db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    const row = db.prepare('SELECT * FROM targets WHERE host = ?').get('1.1.1.1') as any;
    expect(row.address_family).toBe('auto');
  });

  it('adds address_family to a pre-existing database missing the column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtr-dash-migrate-'));
    const dbPath = path.join(dir, 'legacy.sqlite3');
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL DEFAULT 60,
      report_cycles INTEGER NOT NULL DEFAULT 10,
      max_stale_hops INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    legacy.prepare('INSERT INTO targets (host) VALUES (?)').run('8.8.8.8');
    legacy.close();

    const db = createDb(dbPath);
    const row = db.prepare('SELECT * FROM targets WHERE host = ?').get('8.8.8.8') as any;
    expect(row.address_family).toBe('auto');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/db/client.test.ts`
Expected: both new tests FAIL (`address_family` undefined).

- [ ] **Step 3: Implement**

In `backend/src/db/schema.sql`, in `CREATE TABLE IF NOT EXISTS targets`, add after the `max_stale_hops` line:

```sql
  address_family TEXT NOT NULL DEFAULT 'auto',
```

In `backend/src/db/client.ts`, add below `migrateTargetsMaxStaleHops` and call it from `createDb` right after the existing migration call:

```ts
function migrateTargetsAddressFamily(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(targets)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'address_family')) {
    db.exec("ALTER TABLE targets ADD COLUMN address_family TEXT NOT NULL DEFAULT 'auto'");
  }
}
```

```ts
  migrateTargetsMaxStaleHops(db);
  migrateTargetsAddressFamily(db);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/db/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.sql backend/src/db/client.ts backend/src/db/client.test.ts
git commit -m "Add address_family column to targets with guarded migration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `TargetsService` field + save-time validation

**Files:**
- Modify: `backend/src/services/targets.ts`
- Test: `backend/src/services/targets.test.ts`

**Interfaces:**
- Consumes: `AddressFamily` from `../mtr/types.js` (Task 1); `address_family` column (Task 2).
- Produces: `Target.addressFamily: AddressFamily`; `addressFamily?: AddressFamily` on `CreateTargetInput`/`UpdateTargetInput`; `export class TargetValidationError extends Error` thrown by `create`/`update` on an unknown family value or a literal-IP/family contradiction.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('TargetsService', ...)` in `backend/src/services/targets.test.ts` (add `TargetValidationError` to the import from `./targets.js`):

```ts
  it('creates a target with a default addressFamily of auto', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(target.addressFamily).toBe('auto');
  });

  it('persists an explicit addressFamily', () => {
    const target = service.create({ host: 'example.com', addressFamily: 'ipv6' });
    expect(target.addressFamily).toBe('ipv6');
    expect(service.get(target.id)!.addressFamily).toBe('ipv6');
  });

  it('updates addressFamily', () => {
    const target = service.create({ host: 'example.com' });
    const updated = service.update(target.id, { addressFamily: 'ipv4' });
    expect(updated!.addressFamily).toBe('ipv4');
  });

  it('rejects an unknown addressFamily value', () => {
    expect(() =>
      service.create({ host: 'example.com', addressFamily: 'ipv5' as never }),
    ).toThrow(TargetValidationError);
  });

  it('rejects an IPv4 literal host with addressFamily ipv6', () => {
    expect(() => service.create({ host: '8.8.8.8', addressFamily: 'ipv6' })).toThrow(
      TargetValidationError,
    );
  });

  it('rejects an IPv6 literal host with addressFamily ipv4', () => {
    expect(() =>
      service.create({ host: '2606:4700:4700::1111', addressFamily: 'ipv4' }),
    ).toThrow(TargetValidationError);
  });

  it('rejects an update that makes host contradict addressFamily', () => {
    const target = service.create({ host: 'example.com', addressFamily: 'ipv6' });
    expect(() => service.update(target.id, { host: '8.8.8.8' })).toThrow(
      TargetValidationError,
    );
  });

  it('allows a matching literal host and family', () => {
    const target = service.create({ host: '8.8.8.8', addressFamily: 'ipv4' });
    expect(target.addressFamily).toBe('ipv4');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/targets.test.ts`
Expected: new tests FAIL (missing export / `addressFamily` undefined).

- [ ] **Step 3: Implement**

In `backend/src/services/targets.ts`:

Add imports at the top:

```ts
import { isIP } from 'node:net';
import type { AddressFamily } from '../mtr/types.js';
```

Add `addressFamily: AddressFamily;` to `Target`, `addressFamily?: AddressFamily;` to both `CreateTargetInput` and `UpdateTargetInput`, `address_family: string;` to `TargetRow`, and `addressFamily: row.address_family as AddressFamily,` to `toTarget`.

Add above the class:

```ts
export class TargetValidationError extends Error {}

const ADDRESS_FAMILIES: readonly AddressFamily[] = ['auto', 'ipv4', 'ipv6'];

function validateAddressFamily(host: string, family: AddressFamily): void {
  if (!ADDRESS_FAMILIES.includes(family)) {
    throw new TargetValidationError(`invalid addressFamily: ${String(family)}`);
  }
  const literal = isIP(host);
  if (literal === 4 && family === 'ipv6') {
    throw new TargetValidationError('host is an IPv4 literal but addressFamily is ipv6');
  }
  if (literal === 6 && family === 'ipv4') {
    throw new TargetValidationError('host is an IPv6 literal but addressFamily is ipv4');
  }
}
```

In `create`, before the INSERT:

```ts
    const addressFamily = input.addressFamily ?? 'auto';
    validateAddressFamily(input.host, addressFamily);
```

and extend the INSERT to
`'INSERT INTO targets (host, interval_seconds, report_cycles, max_stale_hops, address_family) VALUES (?, ?, ?, ?, ?)'`
with `addressFamily` as the fifth `.run(...)` argument.

In `update`, after `const merged = { ...existing, ...input };`:

```ts
    validateAddressFamily(merged.host, merged.addressFamily);
```

and extend the UPDATE statement to
`'UPDATE targets SET host = ?, interval_seconds = ?, report_cycles = ?, max_stale_hops = ?, address_family = ?, enabled = ? WHERE id = ?'`
passing `merged.addressFamily` between `merged.maxStaleHops` and the `enabled` ternary.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/targets.ts backend/src/services/targets.test.ts
git commit -m "Add validated addressFamily field to TargetsService

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Route wiring — accept `addressFamily`, map validation to 400

**Files:**
- Modify: `backend/src/routes/targets.ts`
- Test: `backend/src/routes/targets.test.ts`

**Interfaces:**
- Consumes: `TargetValidationError` and the `addressFamily` inputs from Task 3.
- Produces: `POST /api/targets` and `PATCH /api/targets/:id` accept `addressFamily` in the JSON body; validation failures return `{ error: <message> }` with status 400.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('target routes', ...)` in `backend/src/routes/targets.test.ts`:

```ts
  it('creates a target with an explicit addressFamily via POST', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'example.com', addressFamily: 'ipv6' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.addressFamily).toBe('ipv6');
  });

  it('rejects a contradictory literal host and addressFamily with 400', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '8.8.8.8', addressFamily: 'ipv6' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ipv6/i);
  });

  it('rejects a PATCH that makes host contradict addressFamily with 400', async () => {
    const created = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'example.com', addressFamily: 'ipv6' }),
    });
    const { id } = await created.json();
    const res = await app.request(`/api/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '8.8.8.8' }),
    });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/targets.test.ts`
Expected: first new test FAILS (`addressFamily` missing from create call → comes back `'auto'`); the two 400-tests FAIL with an unhandled `TargetValidationError` (500).

- [ ] **Step 3: Implement**

In `backend/src/routes/targets.ts`, import `TargetValidationError`:

```ts
import { TargetValidationError, type TargetsService } from '../services/targets.js';
```

In the POST handler, add `addressFamily: body.addressFamily,` to the `targets.create({...})` object and wrap the create-and-schedule block:

```ts
    try {
      const target = targets.create({
        host: body.host,
        intervalSeconds: body.intervalSeconds,
        reportCycles: body.reportCycles,
        maxStaleHops: body.maxStaleHops,
        addressFamily: body.addressFamily,
      });
      if (target.enabled) scheduler.scheduleTarget(target.id, target.intervalSeconds);
      return c.json(target, 201);
    } catch (err) {
      if (err instanceof TargetValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
```

In the PATCH handler, wrap the existing update-and-reschedule block the same way (body already flows into `targets.update(id, body)` wholesale):

```ts
    try {
      const updated = targets.update(id, body);
      if (!updated) return c.json({ error: 'not found' }, 404);
      if (!updated.enabled) scheduler.clearTarget(updated.id);
      else scheduler.scheduleTarget(updated.id, updated.intervalSeconds);
      return c.json(updated);
    } catch (err) {
      if (err instanceof TargetValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/targets.ts backend/src/routes/targets.test.ts
git commit -m "Accept addressFamily on target routes and map validation errors to 400

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Scheduler passes the family to the runner

**Files:**
- Modify: `backend/src/scheduler/scheduler.ts:40`
- Test: `backend/src/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `Target.addressFamily` (Task 3); `runMtr`'s third parameter (Task 1). `runMtrFn` is typed `typeof runMtr`, so the extra argument type-checks without signature changes.
- Produces: every tick calls `runMtrFn(host, reportCycles, addressFamily)`.

- [ ] **Step 1: Write the failing test**

Append inside `describe('Scheduler', ...)` in `backend/src/scheduler/scheduler.test.ts`:

```ts
  it('passes the target addressFamily to the runner', async () => {
    const target = targets.create({
      host: 'example.com',
      intervalSeconds: 60,
      addressFamily: 'ipv6',
    });
    runMtrFn.mockResolvedValue({ target: 'example.com', hops: [] });

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runMtrFn).toHaveBeenCalledWith('example.com', 10, 'ipv6');
  });
```

Also update the existing assertion `expect(runMtrFn).toHaveBeenCalledWith('1.1.1.1', 10);` to `expect(runMtrFn).toHaveBeenCalledWith('1.1.1.1', 10, 'auto');`.

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cd backend && npx vitest run src/scheduler/scheduler.test.ts`
Expected: new test FAILS (called without third argument).

- [ ] **Step 3: Implement**

In `backend/src/scheduler/scheduler.ts` `tick()`, change the runner call to:

```ts
      const report = await this.runMtrFn(target.host, target.reportCycles, target.addressFamily);
```

- [ ] **Step 4: Run backend suite to verify everything passes**

Run: `cd backend && npm test && npm run build`
Expected: all backend tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scheduler/scheduler.ts backend/src/scheduler/scheduler.test.ts
git commit -m "Pass the target address family from the scheduler to the mtr runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — type, API client, ConfigPanel select

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/components/ConfigPanel.tsx`
- Modify: fixtures in `frontend/src/App.test.tsx`, `frontend/src/components/Sidebar.test.tsx` (add the new required field; find them with `grep -n maxStaleHops`)
- Test: `frontend/src/components/ConfigPanel.test.tsx`

**Interfaces:**
- Consumes: backend JSON field `addressFamily` (Tasks 3–4).
- Produces: `export type AddressFamily = 'auto' | 'ipv4' | 'ipv6'` and `Target.addressFamily: AddressFamily` in `types.ts`; `addressFamily?: AddressFamily` on both API input types; `ConfigPanel` `onSave` now emits `{ intervalSeconds, reportCycles, maxStaleHops, addressFamily }`. `App.tsx` forwards `onSave` values into `api.updateTarget` unchanged, so it needs no edit.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/ConfigPanel.test.tsx`: add `addressFamily: 'auto',` to the `target` fixture, add `addressFamily: 'auto'` to the expected object of the two existing `toHaveBeenCalledWith` assertions, and append:

```tsx
  it('submits the selected address family', () => {
    const onSave = vi.fn();
    render(<ConfigPanel target={target} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/address family/i), { target: { value: 'ipv6' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledWith({
      intervalSeconds: 60,
      reportCycles: 10,
      maxStaleHops: 1,
      addressFamily: 'ipv6',
    });
  });

  it('defaults the address family select to the target value', () => {
    render(<ConfigPanel target={target} onSave={vi.fn()} />);
    expect(screen.getByLabelText(/address family/i)).toHaveValue('auto');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/ConfigPanel.test.tsx`
Expected: new tests FAIL (no "Address family" control); the two updated assertions FAIL (payload lacks `addressFamily`).

- [ ] **Step 3: Implement**

`frontend/src/types.ts` — add above `Target` and extend it:

```ts
export type AddressFamily = 'auto' | 'ipv4' | 'ipv6';
```

with `addressFamily: AddressFamily;` added to `Target` after `maxStaleHops`.

`frontend/src/api/client.ts` — add `AddressFamily` to the type import from `../types.js` and add `addressFamily?: AddressFamily;` to both `CreateTargetInput` and `UpdateTargetInput`.

`frontend/src/components/ConfigPanel.tsx` — full updated component:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import type { AddressFamily, Target } from '../types.js';

interface ConfigPanelProps {
  target: Target;
  onSave: (values: {
    intervalSeconds: number;
    reportCycles: number;
    maxStaleHops: number;
    addressFamily: AddressFamily;
  }) => void;
}

export function ConfigPanel({ target, onSave }: ConfigPanelProps) {
  const [intervalSeconds, setIntervalSeconds] = useState(target.intervalSeconds);
  const [reportCycles, setReportCycles] = useState(target.reportCycles);
  const [maxStaleHops, setMaxStaleHops] = useState(target.maxStaleHops);
  const [addressFamily, setAddressFamily] = useState(target.addressFamily);

  // `target` is looked up fresh from App's `targets` list on every render,
  // not a value this component owns — if the target's config changes by any
  // means other than this form's own Save button (e.g. re-fetched after some
  // other update), the fields must follow it rather than silently keep
  // showing whatever was true when this component first mounted.
  useEffect(() => {
    setIntervalSeconds(target.intervalSeconds);
    setReportCycles(target.reportCycles);
    setMaxStaleHops(target.maxStaleHops);
    setAddressFamily(target.addressFamily);
  }, [
    target.id,
    target.intervalSeconds,
    target.reportCycles,
    target.maxStaleHops,
    target.addressFamily,
  ]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave({ intervalSeconds, reportCycles, maxStaleHops, addressFamily });
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
      <label>
        Address family
        <select
          value={addressFamily}
          onChange={(e) => setAddressFamily(e.target.value as AddressFamily)}
        >
          <option value="auto">Auto</option>
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
        </select>
      </label>
      <button type="submit">Save</button>
    </form>
  );
}
```

Fixtures: `Target` gained a required field, so `npx tsc -b` will flag every incomplete fixture object. Add `addressFamily: 'auto',` to each `Target` fixture in `frontend/src/App.test.tsx` and `frontend/src/components/Sidebar.test.tsx` (and anywhere else the compiler points).

- [ ] **Step 4: Run the frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all frontend tests PASS, `tsc -b && vite build` clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts frontend/src/components/ConfigPanel.tsx frontend/src/components/ConfigPanel.test.tsx frontend/src/App.test.tsx frontend/src/components/Sidebar.test.tsx
git commit -m "Add address family select to the target config panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification via the Docker build

**Files:** none modified — verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence the feature works in the production container (the Docker build is this repo's source of truth).

- [ ] **Step 1: Full test suites one more time**

Run: `cd backend && npm test && cd ../frontend && npm test`
Expected: all tests PASS (backend was 132, frontend 78, both now higher).

- [ ] **Step 2: Rebuild and restart the container**

Run: `docker compose up -d --build`
Expected: builds all stages, container starts. Note: the compose network is IPv6-enabled (`enable_ipv6: true`) — required for `-6` probes to work.

- [ ] **Step 3: Verify a forced-IPv6 target end to end**

```bash
curl -s -X POST localhost:3000/api/targets \
  -H 'Content-Type: application/json' \
  -d '{"host": "one.one.one.one", "addressFamily": "ipv6", "intervalSeconds": 30}'
```

Expected: 201-style JSON body containing `"addressFamily":"ipv6"`. After ~35 s:

```bash
TID=<id from the response>
curl -s "localhost:3000/api/targets/$TID/runs?limit=1"
```

Expected: one run whose hop list is IPv6 (first hop is the Docker ULA gateway `fd80:...`, destination `2606:4700:4700::1111` or `...::1001`). Also verify the 400 path live:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/targets \
  -H 'Content-Type: application/json' \
  -d '{"host": "8.8.8.8", "addressFamily": "ipv6"}'
```

Expected: `400`.

- [ ] **Step 4: Clean up the verification target**

```bash
curl -s -X DELETE "localhost:3000/api/targets/$TID" -o /dev/null -w '%{http_code}\n'
```

Expected: `204`.
