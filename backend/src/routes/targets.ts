import type { Hono } from 'hono';
import { TargetValidationError, type TargetsService } from '../services/targets.js';
import { parseId } from './parseId.js';

export interface SchedulerLike {
  scheduleTarget(targetId: number, intervalSeconds: number): void;
  clearTarget(targetId: number): void;
}

export function registerTargetRoutes(
  app: Hono,
  targets: TargetsService,
  scheduler: SchedulerLike,
) {
  app.get('/api/targets', (c) => c.json(targets.list()));

  app.post('/api/targets', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.host || typeof body.host !== 'string') {
      return c.json({ error: 'host is required' }, 400);
    }
    try {
      const target = targets.create({
        host: body.host,
        intervalSeconds: body.intervalSeconds,
        reportCycles: body.reportCycles,
        maxStaleHops: body.maxStaleHops,
        addressFamily: body.addressFamily,
      });
      if (target.enabled) scheduler.scheduleTarget(target.id, target.intervalSeconds);
      return c.json(target, 201);
    } catch (err) {
      if (err instanceof TargetValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.patch('/api/targets/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      const updated = targets.update(id, body);
      if (!updated) return c.json({ error: 'not found' }, 404);
      if (!updated.enabled) scheduler.clearTarget(updated.id);
      else scheduler.scheduleTarget(updated.id, updated.intervalSeconds);
      return c.json(updated);
    } catch (err) {
      if (err instanceof TargetValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.delete('/api/targets/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid id' }, 400);
    scheduler.clearTarget(id);
    const removed = targets.remove(id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.body(null, 204);
  });
}
