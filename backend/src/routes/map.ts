import type { Hono } from 'hono';
import type { MapService } from '../services/map.js';
import { parseId } from './parseId.js';

export function registerMapRoutes(app: Hono, mapService: MapService) {
  app.get('/api/targets/:id/map', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    return c.json(mapService.getMap(id));
  });
}
