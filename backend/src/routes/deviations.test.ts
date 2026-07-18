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

  it('returns 400 for a non-numeric id on the deviations list route', async () => {
    const res = await app.request('/api/targets/abc/deviations');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-numeric id on the history route', async () => {
    const res = await app.request('/api/targets/abc/history');
    expect(res.status).toBe(400);
  });
});
