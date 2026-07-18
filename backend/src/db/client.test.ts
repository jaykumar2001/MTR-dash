import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

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
});
