import type Database from 'better-sqlite3';
import { resolveGeo, type ResolvedGeo } from '../geoip/resolveGeo.js';
import { resolveHost, type ResolveHostFn } from '../net/resolveHost.js';

export interface GeoipSummary {
  country: string | null;
  city: string | null;
}

// A genuine MaxMind hit is stable for a month, same reasoning as
// whois_cache. A fallback result (ipdeny, or no host resolution at all)
// gets a much shorter TTL: it's often taken during a transient window —
// most notably the first-deploy geoipupdate download, which can take a
// few seconds — and pinning that for 30 days would hide city data that
// became available moments later. Re-checking hourly is cheap and lets
// the cache self-heal quickly once MaxMind data is present.
const MAXMIND_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheRow {
  host: string;
  country: string | null;
  city: string | null;
  source: string | null;
  fetched_at: string;
}

export interface GeoipServiceOptions {
  resolveHostFn?: ResolveHostFn;
  resolveGeoFn?: typeof resolveGeo;
  maxmindDbPath?: string;
}

/** Country + city for a hop host, cache-first. Structural mirror of
 * WhoisService/DnsService: its own cache table, its own TTL, and no
 * knowledge of WHOIS data — GeoIP (location) and WHOIS (ownership) are
 * deliberately separate concerns. */
export class GeoipService {
  private resolveHostFn: ResolveHostFn;
  private resolveGeoFn: typeof resolveGeo;
  private maxmindDbPath: string;

  constructor(
    private db: Database.Database,
    options: GeoipServiceOptions = {},
  ) {
    this.resolveHostFn = options.resolveHostFn ?? resolveHost;
    this.resolveGeoFn = options.resolveGeoFn ?? resolveGeo;
    this.maxmindDbPath = options.maxmindDbPath ?? './maxmind/GeoLite2-City.mmdb';
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM geoip_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    const ttl = row.source === 'maxmind' ? MAXMIND_CACHE_TTL_MS : FALLBACK_CACHE_TTL_MS;
    return Date.now() - new Date(row.fetched_at).getTime() < ttl;
  }

  async getSummary(host: string): Promise<GeoipSummary> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { country: cached.country, city: cached.city };
    }

    const ip = await this.resolveHostFn(host);
    const geo: ResolvedGeo = ip
      ? await this.resolveGeoFn(this.db, ip, this.maxmindDbPath)
      : { country: null, city: null, source: 'fallback' };
    // Defensive default: an injected/mocked resolveGeoFn in a test might
    // not supply `source` — treat that as 'fallback' (the short TTL)
    // rather than let a missing field bind as SQL `undefined`, which
    // better-sqlite3 rejects.
    const source = geo.source ?? 'fallback';
    const fetchedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO geoip_cache (host, country, city, source, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           country = excluded.country,
           city = excluded.city,
           source = excluded.source,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, geo.country, geo.city, source, fetchedAt);

    return { country: geo.country, city: geo.city };
  }
}
