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
