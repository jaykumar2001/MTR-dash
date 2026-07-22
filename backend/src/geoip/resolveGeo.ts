import type Database from 'better-sqlite3';
import { lookupCountry } from './lookupCountry.js';
import { lookupCity } from './maxmind.js';

export interface ResolvedGeo {
  country: string | null;
  city: string | null;
  /** Which source produced this result. `'fallback'` covers both the
   * ipdeny country-only lookup and the all-null case — callers should
   * treat both the same way: cache them for a much shorter TTL than a
   * genuine MaxMind hit, since a fallback taken while MaxMind is
   * transiently unavailable (most notably the first-deploy download
   * window) shouldn't get pinned for weeks. */
  source: 'maxmind' | 'fallback';
}

export interface ResolveGeoOptions {
  lookupCityFn?: typeof lookupCity;
}

/** Country + city for an IP: tries the MaxMind GeoLite2-City mmdb first
 * (via `maxmindDbPath`), and falls back to the offline ipdeny CIDR-range
 * table (country only — ipdeny has no city data) whenever MaxMind has no
 * usable record (file missing, IP not found, or the lookup failed). */
export async function resolveGeo(
  db: Database.Database,
  ip: string,
  maxmindDbPath: string,
  options: ResolveGeoOptions = {},
): Promise<ResolvedGeo> {
  const lookupCityFn = options.lookupCityFn ?? lookupCity;
  const result = await lookupCityFn(maxmindDbPath, ip);
  if (result && result.country) return { ...result, source: 'maxmind' };
  return { country: lookupCountry(db, ip), city: null, source: 'fallback' };
}
