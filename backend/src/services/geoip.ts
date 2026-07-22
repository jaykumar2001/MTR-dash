import type Database from 'better-sqlite3';
import { resolveGeo } from '../geoip/resolveGeo.js';
import { resolveHost, type ResolveHostFn } from '../net/resolveHost.js';

export interface GeoipSummary {
  country: string | null;
  city: string | null;
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  country: string | null;
  city: string | null;
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
    this.maxmindDbPath = options.maxmindDbPath ?? './geoip-maxmind/GeoLite2-City.mmdb';
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM geoip_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    return Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
  }

  async getSummary(host: string): Promise<GeoipSummary> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { country: cached.country, city: cached.city };
    }

    const ip = await this.resolveHostFn(host);
    const geo: GeoipSummary = ip
      ? await this.resolveGeoFn(this.db, ip, this.maxmindDbPath)
      : { country: null, city: null };
    const fetchedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO geoip_cache (host, country, city, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           country = excluded.country,
           city = excluded.city,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, geo.country, geo.city, fetchedAt);

    return geo;
  }
}
