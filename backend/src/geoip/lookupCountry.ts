import type Database from 'better-sqlite3';
import { ipVersion, ipv4ToInt, ipv6ToBigInt, bigIntToHex128 } from './ipMath.js';

/**
 * Looks up the ISO 3166-1 alpha-2 country code for an IP literal against the
 * offline geoip_v4_ranges/geoip_v6_ranges tables (see loader.ts). Returns
 * null if the input isn't a valid IP, no range matches, or the tables
 * haven't been seeded.
 */
export function lookupCountry(db: Database.Database, ip: string): string | null {
  const version = ipVersion(ip);
  if (version === 4) {
    const target = ipv4ToInt(ip);
    const row = db
      .prepare(
        'SELECT end_int, country FROM geoip_v4_ranges WHERE start_int <= ? ORDER BY start_int DESC LIMIT 1',
      )
      .get(target) as { end_int: number; country: string } | undefined;
    if (!row || target > row.end_int) return null;
    return row.country;
  }
  if (version === 6) {
    const targetHex = bigIntToHex128(ipv6ToBigInt(ip));
    const row = db
      .prepare(
        'SELECT end_hex, country FROM geoip_v6_ranges WHERE start_hex <= ? ORDER BY start_hex DESC LIMIT 1',
      )
      .get(targetHex) as { end_hex: string; country: string } | undefined;
    if (!row || targetHex > row.end_hex) return null;
    return row.country;
  }
  return null;
}
