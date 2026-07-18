import type { Hono } from 'hono';
import type { DeviationsService } from '../services/deviations.js';
import { parseId } from './parseId.js';

export function registerDeviationRoutes(app: Hono, deviationsService: DeviationsService) {
  app.get('/api/targets/:id/deviations', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    return c.json(deviationsService.list(id));
  });

  app.get('/api/targets/:id/history', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    const at = c.req.query('at') ?? new Date().toISOString();
    const activeMap = deviationsService.activeAt(id, at);
    return c.json({
      at,
      active: Array.from(activeMap.entries()).map(([ttl, host]) => ({ ttl, host })),
    });
  });
}
