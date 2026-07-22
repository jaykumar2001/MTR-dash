import type { Hono } from 'hono';
import type { WhoisService, WhoisSummary } from '../services/whois.js';

// IPv4/IPv6/hostname characters only; no shell is involved (the `whois`
// library talks the WHOIS protocol directly over a socket), but this still
// guards against obviously-malformed input before spending a lookup on it.
const VALID_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
const MAX_BULK_HOSTS = 200;

export function registerWhoisRoutes(app: Hono, whoisService: WhoisService) {
  app.get('/api/whois/:host', async (c) => {
    const host = c.req.param('host');
    if (!VALID_HOST.test(host)) {
      return c.json({ error: 'invalid host' }, 400);
    }
    try {
      const result = await whoisService.lookup(host);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // Bulk netname+country summaries for lazily loading whois data across
  // every hop currently shown on the map in one round trip. Cache-backed
  // (see WhoisService), so repeat calls for already-seen hosts are fast.
  // A per-host failure (e.g. a lookup timeout) yields a null summary for
  // that host rather than failing the whole batch.
  app.post('/api/whois/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.hosts)) {
      return c.json({ error: 'hosts must be an array' }, 400);
    }
    const hosts: string[] = [...new Set(body.hosts)]
      .filter((h): h is string => typeof h === 'string' && VALID_HOST.test(h))
      .slice(0, MAX_BULK_HOSTS);

    const entries = await Promise.all(
      hosts.map(async (host): Promise<[string, WhoisSummary]> => {
        try {
          return [host, await whoisService.getSummary(host)];
        } catch {
          return [host, { netname: null }];
        }
      }),
    );

    return c.json(Object.fromEntries(entries));
  });
}
