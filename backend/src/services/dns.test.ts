import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { DnsService } from './dns.js';

describe('DnsService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('resolves an IP to its first PTR hostname', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
    const service = new DnsService(db, { reverseFn });

    const hostname = await service.resolve('1.1.1.1');

    expect(reverseFn).toHaveBeenCalledWith('1.1.1.1');
    expect(hostname).toBe('host.example.com');
  });

  it('returns null and caches it when the lookup fails (no PTR record)', async () => {
    const reverseFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const service = new DnsService(db, { reverseFn });

    const hostname = await service.resolve('9.9.9.9');

    expect(hostname).toBeNull();
    await service.resolve('9.9.9.9');
    expect(reverseFn).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh cached hostname without calling reverseFn again', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
    const service = new DnsService(db, { reverseFn });

    await service.resolve('1.1.1.1');
    await service.resolve('1.1.1.1');

    expect(reverseFn).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the cached row is older than the cache TTL', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['host.example.com']);
    const service = new DnsService(db, { reverseFn });
    await service.resolve('1.1.1.1');

    db.prepare('UPDATE dns_cache SET fetched_at = ? WHERE host = ?').run(
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      '1.1.1.1',
    );

    await service.resolve('1.1.1.1');
    expect(reverseFn).toHaveBeenCalledTimes(2);
  });

  it('uses the first hostname when a PTR record returns multiple names', async () => {
    const reverseFn = vi.fn().mockResolvedValue(['first.example.com', 'second.example.com']);
    const service = new DnsService(db, { reverseFn });

    expect(await service.resolve('1.1.1.1')).toBe('first.example.com');
  });
});
