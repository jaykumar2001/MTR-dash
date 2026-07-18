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

  it('returns 400 for a non-numeric id', async () => {
    const res = await app.request('/api/targets/abc/map');
    expect(res.status).toBe(400);
  });
});
