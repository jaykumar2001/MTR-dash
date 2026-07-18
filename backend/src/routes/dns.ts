import type { Hono } from 'hono';
import type { DnsService } from '../services/dns.js';

// IPv4/IPv6 literal characters only — mtr runs with -n, so every hop host
// reaching this route is a raw IP, never a hostname.
const VALID_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
const MAX_BULK_HOSTS = 200;

export function registerDnsRoutes(app: Hono, dnsService: DnsService) {
  // Bulk reverse-DNS hostnames for every hop IP currently shown on the map,
  // in one round trip. Cache-backed (see DnsService), so repeat calls for
  // already-resolved IPs are fast. A per-IP failure (no PTR record, lookup
  // timeout) yields a null hostname for that IP rather than failing the
  // whole batch.
  app.post('/api/dns/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.hosts)) {
      return c.json({ error: 'hosts must be an array' }, 400);
    }
    const hosts: string[] = [...new Set(body.hosts)]
      .filter((h): h is string => typeof h === 'string' && VALID_HOST.test(h))
      .slice(0, MAX_BULK_HOSTS);

    const entries = await Promise.all(
      hosts.map(async (host): Promise<[string, string | null]> => {
        try {
          return [host, await dnsService.resolve(host)];
        } catch {
          return [host, null];
        }
      }),
    );

    return c.json(Object.fromEntries(entries));
  });
}
