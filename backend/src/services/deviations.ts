import type Database from 'better-sqlite3';

export interface DeviationRecord {
  id: number;
  ttl: number;
  oldHost: string | null;
  newHost: string;
  detectedAt: string;
}

interface DeviationRow {
  id: number;
  ttl: number;
  old_host: string | null;
  new_host: string;
  detected_at: string;
}

export class DeviationsService {
  constructor(private db: Database.Database) {}

  list(targetId: number): DeviationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM deviations WHERE target_id = ? ORDER BY id DESC')
      .all(targetId) as DeviationRow[];
    return rows.map((r) => ({
      id: r.id,
      ttl: r.ttl,
      oldHost: r.old_host,
      newHost: r.new_host,
      detectedAt: r.detected_at,
    }));
  }

  activeAt(targetId: number, at: string): Map<number, string> {
    const rows = this.db
      .prepare(
        `SELECT ttl, new_host as newHost FROM deviations d1
         WHERE target_id = ? AND detected_at <= ?
         AND id = (
           SELECT id FROM deviations d2
           WHERE d2.target_id = d1.target_id AND d2.ttl = d1.ttl AND d2.detected_at <= ?
           ORDER BY d2.id DESC LIMIT 1
         )`,
      )
      .all(targetId, at, at) as { ttl: number; newHost: string }[];

    const result = new Map<number, string>();
    for (const row of rows) result.set(row.ttl, row.newHost);
    return result;
  }
}
