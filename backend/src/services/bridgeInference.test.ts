import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { BridgeInferenceService } from './bridgeInference.js';

interface HopSpec {
  ttl: number;
  host: string;
}

function insertRun(db: Database.Database, targetId: number, hops: HopSpec[]): number {
  const runId = db
    .prepare(
      `INSERT INTO runs (target_id, started_at, finished_at, status) VALUES (?, datetime('now'), datetime('now'), 'ok')`,
    )
    .run(targetId).lastInsertRowid as number;
  const insertHop = db.prepare(
    `INSERT INTO hops (run_id, ttl, host, loss_pct, snt, last, avg, best, wrst, stdev)
     VALUES (?, ?, ?, 0, 10, 1, 1, 1, 1, 0)`,
  );
  for (const h of hops) insertHop.run(runId, h.ttl, h.host);
  return runId;
}

describe('BridgeInferenceService', () => {
  let db: Database.Database;
  let service: BridgeInferenceService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new BridgeInferenceService(db);
    targetId = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1')
      .lastInsertRowid as number;
  });

  describe('findExactBridge', () => {
    it('finds the sole known real bridge between two hosts', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toEqual(['X']);
    });

    it('finds a multi-hop bridge', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'Y' },
        { ttl: 4, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 2, 1)).toEqual(['X', 'Y']);
    });

    it('returns null when no occurrence connects the two hosts', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toBeNull();
    });

    it('returns null when two different real sequences have been observed (ECMP-like ambiguity)', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'D' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'Y' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toBeNull();
    });

    it('works in the backward direction', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'D' },
      ]);

      expect(service.findExactBridge(targetId, 'D', 'A', 1, -1)).toEqual(['X']);
    });

    it("only considers the near host's most recent 20 occurrences, ignoring older disagreeing data", () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'OLD' },
        { ttl: 3, host: 'D' },
      ]);
      for (let i = 0; i < 20; i++) {
        insertRun(db, targetId, [
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'X' },
          { ttl: 3, host: 'D' },
        ]);
      }

      expect(service.findExactBridge(targetId, 'A', 'D', 1, 1)).toEqual(['X']);
    });
  });

  describe('findKnownContinuation', () => {
    it('finds the sole known continuation that runs into another unknown hop', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'Y' },
        { ttl: 4, host: '???' },
      ]);

      // maxLen is 3 (not 2) so the walk actually reaches ttl 4's "???" and is
      // forced to stop there — proving early-stop fired and returned a
      // sequence shorter than maxLen, rather than the loop merely exhausting
      // its budget before ever seeing a "???".
      expect(service.findKnownContinuation(targetId, 'A', 3, 1)).toEqual(['X', 'Y']);
    });

    it('does not walk past the "???" boundary even when maxLen would allow it', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: '???' },
        { ttl: 4, host: 'Z' },
      ]);

      // maxLen is large enough to reach ttl 4's real host 'Z' if the "???"
      // were skipped over or treated as a valid host. The correct result
      // stops collecting at the "???" and never includes it or anything
      // beyond it.
      expect(service.findKnownContinuation(targetId, 'A', 3, 1)).toEqual(['X']);
    });

    it('returns null when occurrences disagree on the continuation', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: '???' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'Z' },
        { ttl: 3, host: '???' },
      ]);

      expect(service.findKnownContinuation(targetId, 'A', 1, 1)).toBeNull();
    });

    it('returns null when no occurrence of the near host exists at all', () => {
      expect(service.findKnownContinuation(targetId, 'NOPE', 2, 1)).toBeNull();
    });
  });

  describe('findSoleIdentityAtTtl', () => {
    it('returns the sole identity when the ttl and both neighbors are unanimous', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBe('B');
    });

    it('returns null when two identities were ever recorded at the ttl, however recent the agreement', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'C' },
      ]);
      for (let i = 0; i < 30; i++) {
        insertRun(db, targetId, [
          { ttl: 1, host: 'A' },
          { ttl: 2, host: 'B' },
          { ttl: 3, host: 'C' },
        ]);
      }

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('returns null when the ttl has zero real sightings ever', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('returns null when a neighboring ttl is not unanimous', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'Z' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('returns null past the end of the path (no right-bound evidence ever)', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: '???' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBeNull();
    });

    it('ignores ??? sightings at the neighbor ttls — they neither help nor veto', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: '???' },
        { ttl: 2, host: '???' },
        { ttl: 3, host: '???' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBe('B');
    });

    it('scopes evidence to the given target', () => {
      const otherTarget = db.prepare('INSERT INTO targets (host) VALUES (?)').run('2.2.2.2')
        .lastInsertRowid as number;
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
        { ttl: 3, host: 'C' },
      ]);
      insertRun(db, otherTarget, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'X' },
        { ttl: 3, host: 'C' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 2)).toBe('B');
    });

    it('resolves ttl 1 without any ttl-0 evidence — the left bound is the monitoring source itself', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: '???' },
        { ttl: 2, host: 'B' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 1)).toBe('A');
    });

    it('returns null at ttl 1 when a second identity was ever recorded there', () => {
      insertRun(db, targetId, [
        { ttl: 1, host: 'A' },
        { ttl: 2, host: 'B' },
      ]);
      insertRun(db, targetId, [
        { ttl: 1, host: 'Z' },
        { ttl: 2, host: 'B' },
      ]);

      expect(service.findSoleIdentityAtTtl(targetId, 1)).toBeNull();
    });
  });
});
