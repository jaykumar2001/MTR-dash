import fs from 'node:fs';
import { open, type Reader, type CityResponse } from 'maxmind';

export interface GeoLookupResult {
  country: string | null;
  city: string | null;
}

let cachedReader: Reader<CityResponse> | null = null;
let cachedPath: string | null = null;
let cachedMtimeMs = 0;

async function getReader(dbPath: string): Promise<Reader<CityResponse> | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  if (cachedReader && cachedPath === dbPath && cachedMtimeMs === stat.mtimeMs) {
    return cachedReader;
  }
  try {
    const reader = await open<CityResponse>(dbPath);
    cachedReader = reader;
    cachedPath = dbPath;
    cachedMtimeMs = stat.mtimeMs;
    return reader;
  } catch {
    return null;
  }
}

/** Looks up country + city for an IP against a GeoLite2-City .mmdb file.
 * Returns null if the file doesn't exist, can't be opened, or has no
 * record for the IP — all of which mean "fall back to ipdeny," not an
 * error to surface. The opened reader is cached and only reopened when
 * the file's mtime advances (i.e. after a geoipupdate refresh). */
export async function lookupCity(dbPath: string, ip: string): Promise<GeoLookupResult | null> {
  const reader = await getReader(dbPath);
  if (!reader) return null;
  const result = reader.get(ip);
  if (!result) return null;
  return {
    country: result.country?.iso_code ?? null,
    city: result.city?.names?.en ?? null,
  };
}

/** Test-only: clears the module-level cached reader. */
export function _resetMaxmindCacheForTests(): void {
  cachedReader = null;
  cachedPath = null;
  cachedMtimeMs = 0;
}
