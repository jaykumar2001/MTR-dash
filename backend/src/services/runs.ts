import type Database from 'better-sqlite3';
import type { MtrHopReport, MtrReport } from '../mtr/types.js';

export interface DeviationEvent {
  ttl: number;
  oldHost: string | null;
  newHost: string;
}

export interface IngestResult {
  runId: number;
  deviations: DeviationEvent[];
}

export interface RunHistoryHop {
  ttl: number;
  host: string;
  lossPct: number;
  snt: number;
  last: number;
  avg: number;
  best: number;
  wrst: number;
  stdev: number;
}

export interface RunHistoryEntry {
  id: number;
  startedAt: string;
  hops: RunHistoryHop[];
}

const MAX_RUN_HISTORY = 50;
const NO_REPLY_HOST = '???';

interface PathNodeRow {
  id: number;
  host: string;
  active: number;
}

export class RunsService {
  private ingestTx: (targetId: number, report: MtrReport) => IngestResult;

  constructor(private db: Database.Database) {
    this.ingestTx = this.db.transaction((targetId: number, report: MtrReport): IngestResult => {
      const now = new Date().toISOString();

      const runId = this.db
        .prepare(
          `INSERT INTO runs (target_id, started_at, finished_at, status) VALUES (?, ?, ?, 'ok')`,
        )
        .run(targetId, now, now).lastInsertRowid as number;

      const insertHop = this.db.prepare(
        `INSERT INTO hops (run_id, ttl, host, loss_pct, snt, last, avg, best, wrst, stdev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const hop of report.hops) {
        insertHop.run(
          runId,
          hop.ttl,
          hop.host,
          hop.lossPct,
          hop.snt,
          hop.last,
          hop.avg,
          hop.best,
          hop.wrst,
          hop.stdev,
        );
      }

      // A poll that dies mid-path, short of the current active path's
      // depth, is an outage artifact, not route evidence: it must not
      // deactivate nodes, create "???" path_nodes, or log deviations. The
      // run and its raw hop metrics are still recorded above (flagged
      // 'truncated'), so outage history stays visible without polluting
      // path shape. Two fingerprints, both observed in production:
      //   1. The run ends unresolved ("???") — the probe simply died.
      //   2. The run ends on a real host that already sits at an EARLIER
      //      ttl of the active path — the path collapsed onto itself (e.g.
      //      the local gateway echoing as the last live hop mid-outage).
      // A full-depth run ending in "???" is NOT truncated (the steady
      // state for a destination that never answers probes); a shorter run
      // ending on a genuinely new real host is NOT truncated either (a
      // real route shortening or destination change); and a target's very
      // first run always processes, since there is no known depth to fall
      // short of yet.
      const lastHop = report.hops[report.hops.length - 1];
      const activeDepth = (
        this.db
          .prepare('SELECT MAX(ttl) as depth FROM path_nodes WHERE target_id = ? AND active = 1')
          .get(targetId) as { depth: number | null }
      ).depth;
      let truncated = false;
      if (lastHop !== undefined && activeDepth !== null && lastHop.ttl < activeDepth) {
        truncated =
          lastHop.host === NO_REPLY_HOST ||
          this.db
            .prepare(
              `SELECT 1 FROM path_nodes
               WHERE target_id = ? AND active = 1 AND host = ? AND ttl < ? LIMIT 1`,
            )
            .get(targetId, lastHop.host, lastHop.ttl) !== undefined;
      }
      if (truncated) {
        this.db.prepare(`UPDATE runs SET status = 'truncated' WHERE id = ?`).run(runId);
        return { runId, deviations: [] };
      }

      const deviations = this.updatePathNodes(targetId, report.hops, now);
      return { runId, deviations };
    });
  }

  ingest(targetId: number, report: MtrReport): IngestResult {
    return this.ingestTx(targetId, report);
  }

  /** Raw per-poll mtr numbers for the target's most recent runs, newest
   * first, each with its hops nested and ordered by ttl — backs the raw
   * mtr-values panel. `limit` is always capped at MAX_RUN_HISTORY regardless
   * of what's requested, so a caller can't force an unbounded query. */
  getRecentRuns(targetId: number, limit: number): RunHistoryEntry[] {
    const cappedLimit = Math.max(0, Math.min(limit, MAX_RUN_HISTORY));
    const runRows = this.db
      .prepare('SELECT id, started_at FROM runs WHERE target_id = ? ORDER BY id DESC LIMIT ?')
      .all(targetId, cappedLimit) as { id: number; started_at: string }[];

    const hopsStmt = this.db.prepare(
      `SELECT ttl, host, loss_pct, snt, last, avg, best, wrst, stdev
       FROM hops WHERE run_id = ? ORDER BY ttl ASC`,
    );

    return runRows.map((run) => ({
      id: run.id,
      startedAt: run.started_at,
      hops: (
        hopsStmt.all(run.id) as {
          ttl: number;
          host: string;
          loss_pct: number;
          snt: number;
          last: number;
          avg: number;
          best: number;
          wrst: number;
          stdev: number;
        }[]
      ).map((h) => ({
        ttl: h.ttl,
        host: h.host,
        lossPct: h.loss_pct,
        snt: h.snt,
        last: h.last,
        avg: h.avg,
        best: h.best,
        wrst: h.wrst,
        stdev: h.stdev,
      })),
    }));
  }

  private updatePathNodes(
    targetId: number,
    hops: MtrHopReport[],
    now: string,
  ): DeviationEvent[] {
    const findActive = this.db.prepare(
      'SELECT id, host, active FROM path_nodes WHERE target_id = ? AND ttl = ? AND active = 1',
    );
    const findNode = this.db.prepare(
      'SELECT id, host, active FROM path_nodes WHERE target_id = ? AND ttl = ? AND host = ?',
    );
    const insertNode = this.db.prepare(
      'INSERT INTO path_nodes (target_id, ttl, host, first_seen_at, last_seen_at, active) VALUES (?, ?, ?, ?, ?, 1)',
    );
    const touchNode = this.db.prepare(
      'UPDATE path_nodes SET last_seen_at = ?, active = 1 WHERE id = ?',
    );
    const deactivate = this.db.prepare('UPDATE path_nodes SET active = 0 WHERE id = ?');
    const insertDeviation = this.db.prepare(
      'INSERT INTO deviations (target_id, ttl, old_host, new_host, detected_at) VALUES (?, ?, ?, ?, ?)',
    );

    const deviations: DeviationEvent[] = [];

    for (const hop of hops) {
      const active = findActive.get(targetId, hop.ttl) as PathNodeRow | undefined;

      if (active && active.host === hop.host) {
        touchNode.run(now, active.id);
        continue;
      }

      const existing = findNode.get(targetId, hop.ttl, hop.host) as PathNodeRow | undefined;

      if (active) deactivate.run(active.id);

      if (existing) {
        touchNode.run(now, existing.id);
      } else {
        insertNode.run(targetId, hop.ttl, hop.host, now, now);
      }

      insertDeviation.run(targetId, hop.ttl, active ? active.host : null, hop.host, now);
      deviations.push({ ttl: hop.ttl, oldHost: active ? active.host : null, newHost: hop.host });
    }

    return deviations;
  }
}
