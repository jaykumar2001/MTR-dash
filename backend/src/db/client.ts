import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function migrateTargetsMaxStaleHops(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(targets)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'max_stale_hops')) {
    db.exec('ALTER TABLE targets ADD COLUMN max_stale_hops INTEGER NOT NULL DEFAULT 1');
  }
}

function migrateTargetsAddressFamily(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(targets)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'address_family')) {
    db.exec("ALTER TABLE targets ADD COLUMN address_family TEXT NOT NULL DEFAULT 'auto'");
  }
}

export function createDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  migrateTargetsMaxStaleHops(db);
  migrateTargetsAddressFamily(db);
  return db;
}
