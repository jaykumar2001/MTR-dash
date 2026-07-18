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

    it('treats a negative limit as zero rather than SQLite\'s "no limit" semantics', () => {
      service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));
      service.ingest(targetId, report([{ ttl: 1, host: 'A' }]));

      expect(service.getRecentRuns(targetId, -1)).toEqual([]);
    });
  });

  describe('truncated runs', () => {
    it('skips path/deviation updates for a run that ends unresolved short of the known path depth', () => {
      service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'C' },
          { ttl: 4, host: 'D' },
        ]),
      );

      // Poll dies mid-path: ends in ??? at ttl 3, well short of ttl 4.
      const result = service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: '???' },
        ]),
      );

      // Run + raw hops are still recorded (metric history)...
      expect(result.runId).toBeGreaterThan(0);
      expect(db.prepare('SELECT COUNT(*) c FROM hops WHERE run_id = ?').get(result.runId)).toEqual(
        { c: 3 },
      );
      // ...but no deviations, no path_nodes changes: C stays active at ttl3,
      // no ??? node exists anywhere.
      expect(result.deviations).toEqual([]);
      const nodes = db
        .prepare('SELECT ttl, host, active FROM path_nodes WHERE target_id = ? ORDER BY ttl')
        .all(targetId) as { ttl: number; host: string; active: number }[];
      expect(nodes).toHaveLength(4);
      expect(nodes.every((n) => n.active === 1)).toBe(true);
      expect(nodes.some((n) => n.host === '???')).toBe(false);
      // The run is flagged so it's distinguishable in history.
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(result.runId)).toEqual({
        status: 'truncated',
      });
    });

    it('still processes a full-depth run that ends unresolved (destination that never replies)', () => {
      service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: '???' },
        ]),
      );

      // Same depth, still ending ??? — a legitimate steady state for a
      // firewalled destination; deviations must keep flowing.
      const result = service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'X' },
          { ttl: 3, host: '???' },
        ]),
      );

      expect(result.deviations).toEqual([{ ttl: 2, oldHost: 'B', newHost: 'X' }]);
    });

    it('still processes a shorter run that ends in a real host (genuine route shortening)', () => {
      service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'C' },
        ]),
      );

      const result = service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'C' },
        ]),
      );

      expect(result.deviations).toEqual([{ ttl: 2, oldHost: 'B', newHost: 'C' }]);
    });

    it('processes the very first run for a target even when it ends unresolved', () => {
      const result = service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: '???' },
        ]),
      );

      expect(result.deviations).toHaveLength(2);
      const nodes = db.prepare('SELECT COUNT(*) c FROM path_nodes WHERE target_id = ?').get(targetId);
      expect(nodes).toEqual({ c: 2 });
    });

    it('skips a short run whose final real hop is an earlier hop of the active path (path collapsed onto itself)', () => {
      service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'C' },
          { ttl: 4, host: 'D' },
        ]),
      );

      // Outage shape seen in production: everything past the local gateway
      // dies, and the gateway (B, normally ttl2) echoes as the last live
      // hop at ttl3 — a real host, but plainly not a route change.
      const result = service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'B' },
        ]),
      );

      expect(result.deviations).toEqual([]);
      const nodes = db
        .prepare('SELECT ttl, host, active FROM path_nodes WHERE target_id = ? ORDER BY ttl')
        .all(targetId) as { ttl: number; host: string; active: number }[];
      expect(nodes).toHaveLength(4);
      expect(nodes.every((n) => n.active === 1)).toBe(true);
      expect(nodes.filter((n) => n.host === 'B')).toHaveLength(1);
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(result.runId)).toEqual({
        status: 'truncated',
      });
    });

    it('still processes a shorter run ending in a brand-new real host (destination change)', () => {
      service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'C' },
          { ttl: 4, host: 'D' },
        ]),
      );

      // Route legitimately shortened AND now ends at a host never seen in
      // the current path — must be treated as a real change, not truncation.
      const result = service.ingest(
        targetId,
        report([
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'Z' },
        ]),
      );

      expect(result.deviations).toEqual([{ ttl: 3, oldHost: 'C', newHost: 'Z' }]);
    });
  });
});
