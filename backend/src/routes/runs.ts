import type { Hono } from 'hono';
import type { RunsService } from '../services/runs.js';
import { parseId } from './parseId.js';

const DEFAULT_LIMIT = 50;

export function registerRunRoutes(app: Hono, runsService: RunsService) {
  app.get('/api/targets/:id/runs', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    const requested = Number(c.req.query('limit'));
    const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT;
    return c.json(runsService.getRecentRuns(id, limit));
  });
}
