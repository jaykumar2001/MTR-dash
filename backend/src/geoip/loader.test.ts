import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { loadGeoipData } from './loader.js';

describe('loadGeoipData', () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = createDb(':memory:');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoip-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('loads v4 and v6 ranges from the JSON data files', () => {
    fs.writeFileSync(
      path.join(dataDir, 'geoip-v4.json'),
      JSON.stringify([{ start: 100, end: 200, country: 'US' }]),
    );
    fs.writeFileSync(
      path.join(dataDir, 'geoip-v6.json'),
      JSON.stringify([{ startHex: 'a'.repeat(32), endHex: 'b'.repeat(32), country: 'DE' }]),
    );

    loadGeoipData(db, dataDir);

    const v4Rows = db.prepare('SELECT * FROM geoip_v4_ranges').all();
    const v6Rows = db.prepare('SELECT * FROM geoip_v6_ranges').all();
    expect(v4Rows).toEqual([{ start_int: 100, end_int: 200, country: 'US' }]);
    expect(v6Rows).toEqual([{ start_hex: 'a'.repeat(32), end_hex: 'b'.repeat(32), country: 'DE' }]);
  });

  it('is idempotent: does not re-load if the tables already have rows', () => {
    fs.writeFileSync(
      path.join(dataDir, 'geoip-v4.json'),
      JSON.stringify([{ start: 1, end: 2, country: 'US' }]),
    );
    fs.writeFileSync(
      path.join(dataDir, 'geoip-v6.json'),
      JSON.stringify([{ startHex: 'a'.repeat(32), endHex: 'a'.repeat(32), country: 'US' }]),
    );

    loadGeoipData(db, dataDir);
    loadGeoipData(db, dataDir);

    const count = db.prepare('SELECT COUNT(*) as n FROM geoip_v4_ranges').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('warns and leaves tables empty when data files are missing, without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => loadGeoipData(db, dataDir)).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) as n FROM geoip_v4_ranges').get() as { n: number };
    expect(count.n).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
