import type { Hono } from 'hono';
import type { GeoipService, GeoipSummary } from '../services/geoip.js';

// Mirrors backend/src/routes/whois.ts's VALID_HOST/MAX_BULK_HOSTS exactly.
const VALID_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;
const MAX_BULK_HOSTS = 200;

export function registerGeoipRoutes(app: Hono, geoipService: GeoipService) {
  // Bulk country+city summaries for lazily loading GeoIP data across every
  // hop currently shown on the map in one round trip. Cache-backed (see
  // GeoipService). A per-host failure yields a null summary for that host
  // rather than failing the whole batch.
  app.post('/api/geoip/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.hosts)) {
      return c.json({ error: 'hosts must be an array' }, 400);
    }
    const hosts: string[] = [...new Set(body.hosts)]
      .filter((h): h is string => typeof h === 'string' && VALID_HOST.test(h))
      .slice(0, MAX_BULK_HOSTS);

    const entries = await Promise.all(
      hosts.map(async (host): Promise<[string, GeoipSummary]> => {
        try {
          return [host, await geoipService.getSummary(host)];
        } catch {
          return [host, { country: null, city: null }];
        }
      }),
    );

    return c.json(Object.fromEntries(entries));
  });
}
