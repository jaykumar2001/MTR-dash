import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { resolveGeo } from './resolveGeo.js';

describe('resolveGeo', () => {
  let db: Database.Database;
  const MAXMIND_DB_PATH = '/data/maxmind/GeoLite2-City.mmdb';

  beforeEach(() => {
    db = createDb(':memory:');
    db.prepare('INSERT INTO geoip_v4_ranges (start_int, end_int, country) VALUES (?, ?, ?)').run(
      0,
      4294967295,
      'DE',
    );
  });

  it('returns the MaxMind result when it has a country', async () => {
    const lookupCityFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });

    const result = await resolveGeo(db, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: 'US', city: 'Mountain View' });
    expect(lookupCityFn).toHaveBeenCalledWith(MAXMIND_DB_PATH, '8.8.8.8');
  });

  it('falls back to ipdeny country (with null city) when MaxMind returns null', async () => {
    const lookupCityFn = vi.fn().mockResolvedValue(null);

    const result = await resolveGeo(db, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: 'DE', city: null });
  });

  it('falls back to ipdeny when MaxMind resolves but has no country', async () => {
    const lookupCityFn = vi.fn().mockResolvedValue({ country: null, city: 'Somewhere' });

    const result = await resolveGeo(db, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: 'DE', city: null });
  });

  it('returns all-null when both MaxMind and ipdeny have nothing', async () => {
    const emptyDb = createDb(':memory:');
    const lookupCityFn = vi.fn().mockResolvedValue(null);

    const result = await resolveGeo(emptyDb, '8.8.8.8', MAXMIND_DB_PATH, { lookupCityFn });

    expect(result).toEqual({ country: null, city: null });
  });
});
