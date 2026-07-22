import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { WhoisService } from '../services/whois.js';
import { registerWhoisRoutes } from './whois.js';

describe('whois routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('GET /api/whois/:host', () => {
    it('returns whois fields for a valid host', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\n');
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/1.1.1.1');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host: '1.1.1.1',
        fields: [{ key: 'NetName', value: 'TEST' }],
      });
    });

    it('returns 400 for a host containing characters outside the allowed set', async () => {
      const app = new Hono();
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn: vi.fn() }));

      const res = await app.request('/api/whois/' + encodeURIComponent('1.1.1.1; rm -rf /'));

      expect(res.status).toBe(400);
    });

    it('returns 502 when the whois lookup fails', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockRejectedValue(new Error('boom'));
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/1.1.1.1');

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'boom' });
    });
  });

  describe('POST /api/whois/bulk', () => {
    it('returns a netname summary per requested host', async () => {
      const app = new Hono();
      const runWhoisFn = vi
        .fn()
        .mockImplementation(async (host: string) =>
          host === '1.1.1.1' ? 'netname: ONE-NET\n' : 'netname: EIGHT-NET\n',
        );
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { netname: 'ONE-NET' },
        '8.8.8.8': { netname: 'EIGHT-NET' },
      });
    });

    it('returns 400 when hosts is missing or not an array', async () => {
      const app = new Hono();
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn: vi.fn() }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });

    it('silently drops invalid hosts and de-duplicates repeats instead of failing the batch', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockResolvedValue('netname: TEST\n');
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '1.1.1.1', 'bad;host', 42] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ '1.1.1.1': { netname: 'TEST' } });
      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });

    it('returns a null summary for a host whose lookup fails, without failing the batch', async () => {
      const app = new Hono();
      const runWhoisFn = vi.fn().mockImplementation(async (host: string) => {
        if (host === '9.9.9.9') throw new Error('boom');
        return 'netname: TEST\n';
      });
      registerWhoisRoutes(app, new WhoisService(db, { runWhoisFn }));

      const res = await app.request('/api/whois/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: ['1.1.1.1', '9.9.9.9'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        '1.1.1.1': { netname: 'TEST' },
        '9.9.9.9': { netname: null },
      });
    });
  });
});
