import type Database from 'better-sqlite3';
import { lookupCountry } from './lookupCountry.js';
import { lookupCity, type GeoLookupResult } from './maxmind.js';

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
): Promise<GeoLookupResult> {
  const lookupCityFn = options.lookupCityFn ?? lookupCity;
  const result = await lookupCityFn(maxmindDbPath, ip);
  if (result && result.country) return result;
  return { country: lookupCountry(db, ip), city: null };
}
