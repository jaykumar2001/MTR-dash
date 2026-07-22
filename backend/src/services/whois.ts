import type Database from 'better-sqlite3';
import { runWhois } from '../whois/runner.js';
import { parseWhois, extractNetname, type WhoisField } from '../whois/parser.js';

export interface WhoisResult {
  host: string;
  fields: WhoisField[];
}

export interface WhoisSummary {
  netname: string | null;
}

// Whois records (netname/CIDR ownership) change rarely; caching for a month
// avoids re-hitting the whois protocol for every render of a hop that's
// already been looked up, while still refreshing eventually.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheRow {
  host: string;
  fields_json: string;
  netname: string | null;
  fetched_at: string;
}

export interface WhoisServiceOptions {
  runWhoisFn?: typeof runWhois;
}

export class WhoisService {
  private runWhoisFn: typeof runWhois;

  constructor(
    private db: Database.Database,
    options: WhoisServiceOptions = {},
  ) {
    this.runWhoisFn = options.runWhoisFn ?? runWhois;
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
    const fieldsJson = JSON.stringify(fields);
    const fetchedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO whois_cache (host, fields_json, netname, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET
           fields_json = excluded.fields_json,
           netname = excluded.netname,
           fetched_at = excluded.fetched_at`,
      )
      .run(host, fieldsJson, netname, fetchedAt);

    return { host, fields_json: fieldsJson, netname, fetched_at: fetchedAt };
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

  /** Netname only, cache-first. Fast path for lazily summarizing many
   * hosts at once for inline display on the map. Location data (country/
   * city) is a separate concern — see GeoipService, which is never
   * consulted here and never shares this cache table. */
  async getSummary(host: string): Promise<WhoisSummary> {
    const cached = this.getCached(host);
    if (cached && this.isFresh(cached)) {
      return { netname: cached.netname };
    }
    const row = await this.fetchAndCache(host);
    return { netname: row.netname };
  }
}
