import dns from 'node:dns/promises';
import { ipVersion } from '../geoip/ipMath.js';

export type ResolveHostFn = (host: string) => Promise<string | null>;

/** Resolves a hop's reported host (an IP literal or a reverse-DNS hostname)
 * to an IP literal, suitable for a CIDR/mmdb lookup keyed by IP. Returns
 * null if resolution isn't possible or fails. */
export const resolveHost: ResolveHostFn = async (host) => {
  if (ipVersion(host) !== 0) return host;
  try {
    const result = await dns.lookup(host);
    return result.address;
  } catch {
    return null;
  }
};
