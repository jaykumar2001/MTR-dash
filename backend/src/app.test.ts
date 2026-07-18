import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createDb } from './db/client.js';

describe('createApp', () => {
  it('responds to GET /api/health with ok status', async () => {
    const app = createApp({ db: createDb(':memory:'), startScheduler: false });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('wires target creation through to the map endpoint', async () => {
    const app = createApp({ db: createDb(':memory:'), startScheduler: false });
    const createRes = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1' }),
    });
    expect(createRes.status).toBe(201);
    const target = await createRes.json();

    const mapRes = await app.request(`/api/targets/${target.id}/map`);
    expect(mapRes.status).toBe(200);
    const mapBody = await mapRes.json();
    expect(mapBody).toEqual({ nodes: [], edges: [] });
  });
});
