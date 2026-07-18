import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SseHub } from '../sse/hub.js';
import { parseId } from './parseId.js';

export function registerStreamRoutes(app: Hono, sseHub: SseHub) {
  app.get('/api/targets/:id/stream', (c) => {
    const targetId = parseId(c.req.param('id'));
    if (targetId === undefined) return c.json({ error: 'invalid id' }, 400);
    return streamSSE(c, async (stream) => {
      const aborted = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      const unsubscribe = sseHub.subscribe(targetId, (event) => {
        stream.writeSSE({ data: JSON.stringify(event), event: 'run' });
      });
      await aborted;
      unsubscribe();
    });
  });
}
