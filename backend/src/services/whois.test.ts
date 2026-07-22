import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { WhoisService } from './whois.js';

describe('WhoisService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  describe('lookup', () => {
    it('runs the whois lookup and parses the raw output into fields', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\nCIDR: 1.1.1.0/24\n');
      const service = new WhoisService(db, { runWhoisFn });

      const result = await service.lookup('1.1.1.1');

      expect(runWhoisFn).toHaveBeenCalledWith('1.1.1.1');
      expect(result).toEqual({
        host: '1.1.1.1',
        fields: [
          { key: 'NetName', value: 'TEST' },
          { key: 'CIDR', value: '1.1.1.0/24' },
        ],
      });
    });

    it('propagates a lookup failure', async () => {
      const runWhoisFn = vi.fn().mockRejectedValue(new Error('boom'));
      const service = new WhoisService(db, { runWhoisFn });

      await expect(service.lookup('1.1.1.1')).rejects.toThrow('boom');
    });

    it('serves a fresh cached lookup without calling the whois function again', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\n');
      const service = new WhoisService(db, { runWhoisFn });

      await service.lookup('1.1.1.1');
      await service.lookup('1.1.1.1');

      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches when the cached row is older than the cache TTL', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('NetName: TEST\n');
      const service = new WhoisService(db, { runWhoisFn });
      await service.lookup('1.1.1.1');

      db.prepare('UPDATE whois_cache SET fetched_at = ? WHERE host = ?').run(
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        '1.1.1.1',
      );

      await service.lookup('1.1.1.1');
      expect(runWhoisFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSummary', () => {
    it('extracts the netname', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('netname: EXAMPLE-NET\n');
      const service = new WhoisService(db, { runWhoisFn });

      const summary = await service.getSummary('dns.google');

      expect(summary).toEqual({ netname: 'EXAMPLE-NET' });
    });

    it('serves a fresh cached summary without calling whois again', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('netname: EXAMPLE-NET\n');
      const service = new WhoisService(db, { runWhoisFn });

      await service.getSummary('dns.google');
      await service.getSummary('dns.google');

      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });

    it('shares the cache with lookup() for the same host', async () => {
      const runWhoisFn = vi.fn().mockResolvedValue('netname: EXAMPLE-NET\n');
      const service = new WhoisService(db, { runWhoisFn });

      await service.getSummary('1.1.1.1');
      await service.lookup('1.1.1.1');

      expect(runWhoisFn).toHaveBeenCalledTimes(1);
    });
  });
});
