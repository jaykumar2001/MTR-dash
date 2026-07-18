import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { DnsService } from '../services/dns.js';
import { registerDnsRoutes } from './dns.js';

describe('dns routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('POST /api/dns/bulk', () => {
    it('returns a resolved hostname per requested IP', async () => {
      const app = new Hono();
      const reverseFn = vi
        .fn()
        .mockImplementation(async (ip: string) =>
          ip === '1.1.1.1' ? ['one.example.com'] : ['eight.example.com'],
        );
      registerDnsRoutes(app, new DnsService(db, { reverseFn }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': 'one.example.com',
        '8.8.8.8': 'eight.example.com',
      });
    });

    it('returns 400 when hosts is missing or not an array', async () => {
      const app = new Hono();
      registerDnsRoutes(app, new DnsService(db, { reverseFn: vi.fn() }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });

    it('silently drops invalid hosts and de-duplicates repeats instead of failing the batch', async () => {
      const app = new Hono();
      const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
      registerDnsRoutes(app, new DnsService(db, { reverseFn }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '1.1.1.1', 'bad;host', 42] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ '1.1.1.1': 'host.example.com' });
      expect(reverseFn).toHaveBeenCalledTimes(1);
    });

    it('returns a null hostname for an IP whose lookup fails, without failing the batch', async () => {
      const app = new Hono();
      const reverseFn = vi.fn().mockImplementation(async (ip: string) => {
        if (ip === '9.9.9.9') throw new Error('ENOTFOUND');
        return ['host.example.com'];
      });
      registerDnsRoutes(app, new DnsService(db, { reverseFn }));

      const res = await app.request('/api/dns/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '9.9.9.9'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': 'host.example.com',
        '9.9.9.9': null,
      });
    });
  });
});
