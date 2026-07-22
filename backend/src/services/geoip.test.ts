import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { GeoipService } from './geoip.js';

describe('GeoipService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('getSummary', () => {
    it('resolves the host to an IP and returns the geo result', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });

      const summary = await service.getSummary('dns.google');

      expect(resolveHostFn).toHaveBeenCalledWith('dns.google');
      expect(resolveGeoFn).toHaveBeenCalledWith(db, '8.8.8.8', expect.any(String));
      expect(summary).toEqual({ country: 'US', city: 'Mountain View' });
    });

    it('returns all-null without calling resolveGeo when the host cannot be resolved', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue(null);
      const resolveGeoFn = vi.fn();
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });

      const summary = await service.getSummary('unresolvable.example');

      expect(resolveGeoFn).not.toHaveBeenCalled();
      expect(summary).toEqual({ country: null, city: null });
    });

    it('serves a fresh cached summary without calling resolveHost or resolveGeo again', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });

      await service.getSummary('dns.google');
      await service.getSummary('dns.google');

      expect(resolveHostFn).toHaveBeenCalledTimes(1);
      expect(resolveGeoFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches when the cached row is older than the 30-day TTL', async () => {
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      const service = new GeoipService(db, { resolveHostFn, resolveGeoFn });
      await service.getSummary('dns.google');

      db.prepare('UPDATE geoip_cache SET fetched_at = ? WHERE host = ?').run(
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        'dns.google',
      );

      await service.getSummary('dns.google');
      expect(resolveGeoFn).toHaveBeenCalledTimes(2);
    });
  });
});
