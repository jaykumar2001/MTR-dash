import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { GeoipService } from '../services/geoip.js';
import { registerGeoipRoutes } from './geoip.js';

describe('geoip routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('POST /api/geoip/bulk', () => {
    it('returns a country/city summary per requested host', async () => {
      const app = new Hono();
      const resolveHostFn = vi.fn().mockResolvedValue('8.8.8.8');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'US', city: 'Mountain View' });
      registerGeoipRoutes(app, new GeoipService(db, { resolveHostFn, resolveGeoFn }));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { country: 'US', city: 'Mountain View' },
        '8.8.8.8': { country: 'US', city: 'Mountain View' },
      });
    });

    it('returns 400 when hosts is missing or not an array', async () => {
      const app = new Hono();
      registerGeoipRoutes(app, new GeoipService(db));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });

    it('silently drops invalid hosts and de-duplicates repeats instead of failing the batch', async () => {
      const app = new Hono();
      const resolveHostFn = vi.fn().mockResolvedValue('1.1.1.1');
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' });
      registerGeoipRoutes(app, new GeoipService(db, { resolveHostFn, resolveGeoFn }));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '1.1.1.1', 'bad;host', 42] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ '1.1.1.1': { country: 'DE', city: 'Berlin' } });
      expect(resolveGeoFn).toHaveBeenCalledTimes(1);
    });

    it('returns a null summary for a host whose lookup fails, without failing the batch', async () => {
      const app = new Hono();
      const resolveHostFn = vi.fn().mockImplementation(async (host: string) => {
        if (host === '9.9.9.9') throw new Error('boom');
        return '1.1.1.1';
      });
      const resolveGeoFn = vi.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' });
      registerGeoipRoutes(app, new GeoipService(db, { resolveHostFn, resolveGeoFn }));

      const res = await app.request('/api/geoip/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '9.9.9.9'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { country: 'DE', city: 'Berlin' },
        '9.9.9.9': { country: null, city: null },
      });
    });
  });
});
