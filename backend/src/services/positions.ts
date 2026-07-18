import type Database from 'better-sqlite3';

export class PositionsService {
  constructor(private db: Database.Database) {}

  setPosition(targetId: number, nodeId: number, x: number, y: number): void {
    this.db
      .prepare(
        `INSERT INTO node_positions (target_id, node_id, x, y) VALUES (?, ?, ?, ?)
         ON CONFLICT(target_id, node_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
      )
      .run(targetId, nodeId, x, y);
  }
}
