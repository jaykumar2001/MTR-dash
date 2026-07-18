import type { Hono } from 'hono';
import type { PositionsService } from '../services/positions.js';
import { parseId } from './parseId.js';

export function registerPositionRoutes(app: Hono, positionsService: PositionsService) {
  app.put('/api/targets/:id/nodes/:nodeId/position', async (c) => {
    const targetId = parseId(c.req.param('id'));
    const nodeId = parseId(c.req.param('nodeId'));
    if (targetId === undefined || nodeId === undefined) {
      return c.json({ error: 'invalid id' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.x !== 'number' || typeof body.y !== 'number') {
      return c.json({ error: 'x and y must be numbers' }, 400);
    }
    positionsService.setPosition(targetId, nodeId, body.x, body.y);
    return c.json({ ok: true });
  });
}
