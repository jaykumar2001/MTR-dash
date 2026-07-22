import fs from 'node:fs';
import { open, type Reader, type CityResponse } from 'maxmind';

/** The GeoLite2-City filename `geoipupdate` writes and this module reads —
 * shared so app.ts (constructing the path GeoipService reads from) and
 * ensureMaxmindData.ts (constructing the path geoipupdate writes to and
 * checks the mtime of) can never drift apart on the filename. */
export const MAXMIND_CITY_FILENAME = 'GeoLite2-City.mmdb';

export interface GeoLookupResult {
  country: string | null;
  city: string | null;
}

let cachedReaderPromise: Promise<Reader<CityResponse> | null> | null = null;
let cachedPath: string | null = null;
let cachedMtimeMs = 0;

async function getReader(dbPath: string): Promise<Reader<CityResponse> | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  if (cachedPath === dbPath && cachedMtimeMs === stat.mtimeMs && cachedReaderPromise) {
    return cachedReaderPromise;
  }
  // Set the cache fields synchronously, before awaiting `open()` — this is
  // what lets a concurrent call that arrives before this promise settles
  // see the cache as already populated and reuse this same promise instead
  // of starting its own redundant open() of the same multi-MB file.
  cachedPath = dbPath;
  cachedMtimeMs = stat.mtimeMs;
  cachedReaderPromise = open<CityResponse>(dbPath).catch(() => null);
  return cachedReaderPromise;
}

/** Looks up country + city for an IP against a GeoLite2-City .mmdb file.
 * Returns null if the file doesn't exist, can't be opened, or has no
 * record for the IP — all of which mean "fall back to ipdeny," not an
 * error to surface. The opened reader is cached and only reopened when
 * the file's mtime advances (i.e. after a geoipupdate refresh); concurrent
 * calls against a cold/stale cache share the same in-flight open() rather
 * than each starting their own. */
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
  cachedReaderPromise = null;
  cachedPath = null;
  cachedMtimeMs = 0;
}
