import dns from 'node:dns/promises';
import type Database from 'better-sqlite3';

// PTR records shift more readily than WHOIS ownership data (whois_cache uses
// a 30-day window) — cache for a day so a hop's resolved hostname stays
// fresh without re-querying DNS on every map render.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  hostname: string | null;
  fetched_at: string;
}

export interface DnsServiceOptions {
  reverseFn?: (ip: string) => Promise<string[]>;
}

export class DnsService {
  private reverseFn: (ip: string) => Promise<string[]>;

  constructor(
    private db: Database.Database,
    options: DnsServiceOptions = {},
  ) {
    this.reverseFn = options.reverseFn ?? ((ip: string) => dns.reverse(ip));
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM dns_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    return Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
  }

  /** Reverse-DNS hostname for an IP, cache-first. Returns null when there's
   * no PTR record or the lookup fails — that's the normal case for most
   * IPs, not an error condition, and is cached too so a persistently
   * unresolvable IP doesn't get re-queried on every request within the TTL. */
  async resolve(host: string): Promise<string | null> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return cached.hostname;
    }

    let hostname: string | null;
    try {
      const names = await this.reverseFn(host);
      hostname = names[0] ?? null;
    } catch {
      hostname = null;
    }

    const fetchedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO dns_cache (host, hostname, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           hostname = excluded.hostname,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, hostname, fetchedAt);

    return hostname;
  }
}
