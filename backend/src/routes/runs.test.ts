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
