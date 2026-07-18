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

  it('returns 400 for a non-numeric id or nodeId', async () => {
    const res = await app.request(`/api/targets/abc/nodes/${nodeId}/position`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 50, y: 60 }),
    });
    expect(res.status).toBe(400);
  });
});
