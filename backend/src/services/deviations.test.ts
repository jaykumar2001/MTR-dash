import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from './runs.js';
import { DeviationsService } from './deviations.js';
import type { MtrReport } from '../mtr/types.js';

function report(host: string): MtrReport {
  return {
    target: '1.1.1.1',
    hops: [{ ttl: 1, host, lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
  };
}

describe('DeviationsService', () => {
  let db: Database.Database;
  let runs: RunsService;
  let deviations: DeviationsService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runs = new RunsService(db);
    deviations = new DeviationsService(db);
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
  });

  it('lists deviations newest first', () => {
    runs.ingest(targetId, report('A'));
    runs.ingest(targetId, report('B'));
    const list = deviations.list(targetId);
    expect(list).toHaveLength(2);
    expect(list[0].newHost).toBe('B');
    expect(list[1].newHost).toBe('A');
  });

  it('reconstructs the active host per ttl at a point in time', async () => {
    runs.ingest(targetId, report('A'));
    const midpoint = new Date(Date.now() + 10).toISOString();
    // detected_at has millisecond resolution and these calls are synchronous and
    // fast, so without an actual wait the second ingest can land at (or before)
    // `midpoint`, making the "active as of midpoint" assertion below flaky/wrong.
    await new Promise((resolve) => setTimeout(resolve, 20));
    runs.ingest(targetId, report('B'));

    const activeAtMidpoint = deviations.activeAt(targetId, midpoint);
    expect(activeAtMidpoint.get(1)).toBe('A');

    const activeNow = deviations.activeAt(targetId, new Date(Date.now() + 1000).toISOString());
    expect(activeNow.get(1)).toBe('B');
  });
});
