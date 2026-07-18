import dns from 'node:dns/promises';
import type Database from 'better-sqlite3';
import { runWhois } from '../whois/runner.js';
import { parseWhois, extractNetname, type WhoisField } from '../whois/parser.js';
import { lookupCountry } from '../geoip/lookupCountry.js';
import { ipVersion } from '../geoip/ipMath.js';

export interface WhoisResult {
  host: string;
  fields: WhoisField[];
}

export interface WhoisSummary {
  netname: string | null;
  country: string | null;
}

// Whois records (netname, country/CIDR ownership) change rarely; caching for
// a month avoids re-hitting the whois protocol for every render of a hop
// that's already been looked up, while still refreshing eventually.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  fields_json: string;
  netname: string | null;
  country: string | null;
  fetched_at: string;
}

export interface WhoisServiceOptions {
  runWhoisFn?: typeof runWhois;
  /** Resolves a hop's reported host (an IP literal or a reverse-DNS
   * hostname) to an IP suitable for the geoip CIDR lookup. Returns null if
   * resolution isn't possible/fails — the summary's `country` is then null,
   * but the whois lookup itself still proceeds against the original host. */
  resolveHostFn?: (host: string) => Promise<string | null>;
}

async function defaultResolveHost(host: string): Promise<string | null> {
  if (ipVersion(host) !== 0) return host;
  try {
    const result = await dns.lookup(host);
    return result.address;
  } catch {
    return null;
  }
}

export class WhoisService {
  private runWhoisFn: typeof runWhois;
  private resolveHostFn: (host: string) => Promise<string | null>;

  constructor(
    private db: Database.Database,
    options: WhoisServiceOptions = {},
  ) {
    this.runWhoisFn = options.runWhoisFn ?? runWhois;
    this.resolveHostFn = options.resolveHostFn ?? defaultResolveHost;
  }

  private getCached(host: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM whois_cache WHERE host = ?').get(host) as
      | CacheRow
      | undefined;
  }

  private isFresh(row: CacheRow): boolean {
    return Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
  }

  private async fetchAndCache(host: string): Promise<CacheRow> {
    const raw = await this.runWhoisFn(host);
    const fields = parseWhois(raw);
    const netname = extractNetname(fields);
    const ip = await this.resolveHostFn(host);
    const country = ip ? lookupCountry(this.db, ip) : null;
    const fieldsJson = JSON.stringify(fields);
    const fetchedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO whois_cache (host, fields_json, netname, country, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           fields_json = excluded.fields_json,
           netname = excluded.netname,
           country = excluded.country,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, fieldsJson, netname, country, fetchedAt);

    return { host, fields_json: fieldsJson, netname, country, fetched_at: fetchedAt };
  }

  /** Full whois lookup (all parsed fields), cache-first. Backs the
   * single-host detail popup shown when a hop node is clicked. */
  async lookup(host: string): Promise<WhoisResult> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { host, fields: JSON.parse(cached.fields_json) };
    }
    const row = await this.fetchAndCache(host);
    return { host, fields: JSON.parse(row.fields_json) };
  }

  /** Netname + country only, cache-first. This is the fast path used to
   * lazily summarize many hosts at once for inline display on the map. */
  async getSummary(host: string): Promise<WhoisSummary> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { netname: cached.netname, country: cached.country };
    }
    const row = await this.fetchAndCache(host);
    return { netname: row.netname, country: row.country };
  }
}
