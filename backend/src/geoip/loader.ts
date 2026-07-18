import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

interface V4Entry {
  start: number;
  end: number;
  country: string;
}
interface V6Entry {
  startHex: string;
  endHex: string;
  country: string;
}

/**
 * Seeds the geoip_v4_ranges/geoip_v6_ranges tables from the JSON files baked
 * into the image by the Dockerfile's geoip-builder stage (see ipdeny.com's
 * country CIDR blocks). Idempotent: skips entirely if the tables already
 * have rows, so a container restart against an existing DB volume doesn't
 * re-parse ~330k rows every time. If the data files aren't present (e.g. a
 * local dev run outside Docker), logs a warning and leaves the tables empty
 * rather than crashing the app — country lookups just return null.
 */
export function loadGeoipData(db: Database.Database, dataDir: string): void {
  const existingCount = db.prepare('SELECT COUNT(*) as n FROM geoip_v4_ranges').get() as {
    n: number;
  };
  if (existingCount.n > 0) return;

  const v4Path = path.join(dataDir, 'geoip-v4.json');
  const v6Path = path.join(dataDir, 'geoip-v6.json');

  if (!fs.existsSync(v4Path) || !fs.existsSync(v6Path)) {
    console.warn(
      `geoip: data files not found at ${dataDir} (expected geoip-v4.json and geoip-v6.json) — country lookups will return null`,
    );
    return;
  }

  const v4: V4Entry[] = JSON.parse(fs.readFileSync(v4Path, 'utf-8'));
  const v6: V6Entry[] = JSON.parse(fs.readFileSync(v6Path, 'utf-8'));

  const insertV4 = db.prepare(
    'INSERT INTO geoip_v4_ranges (start_int, end_int, country) VALUES (?, ?, ?)',
  );
  const insertV6 = db.prepare(
    'INSERT INTO geoip_v6_ranges (start_hex, end_hex, country) VALUES (?, ?, ?)',
  );

  const insertAllV4 = db.transaction((rows: V4Entry[]) => {
    for (const row of rows) insertV4.run(row.start, row.end, row.country);
  });
  const insertAllV6 = db.transaction((rows: V6Entry[]) => {
    for (const row of rows) insertV6.run(row.startHex, row.endHex, row.country);
  });

  insertAllV4(v4);
  insertAllV6(v6);
}
