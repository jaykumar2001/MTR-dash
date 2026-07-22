import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp } from './app.js';
import { createDb } from './db/client.js';

vi.mock('./geoip/ensureMaxmindData.js', () => ({
  ensureMaxmindData: vi.fn().mockResolvedValue(undefined),
}));

import { ensureMaxmindData } from './geoip/ensureMaxmindData.js';

describe('createApp', () => {
  beforeEach(() => {
    vi.mocked(ensureMaxmindData).mockClear();
  });

  it('responds to GET /api/health with ok status', async () => {
    const app = createApp({
      db: createDb(':memory:'),
      startScheduler: false,
      startMaxmindRefresh: false,
    });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('wires target creation through to the map endpoint', async () => {
    const app = createApp({
      db: createDb(':memory:'),
      startScheduler: false,
      startMaxmindRefresh: false,
    });
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

  it('wires the geoip bulk endpoint', async () => {
    const app = createApp({
      db: createDb(':memory:'),
      startScheduler: false,
      startMaxmindRefresh: false,
    });
    const res = await app.request('/api/geoip/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('triggers a MaxMind refresh on startup by default', () => {
    createApp({ db: createDb(':memory:'), startScheduler: false });
    expect(ensureMaxmindData).toHaveBeenCalledTimes(1);
  });

  it('skips the MaxMind refresh when startMaxmindRefresh is false', () => {
    createApp({ db: createDb(':memory:'), startScheduler: false, startMaxmindRefresh: false });
    expect(ensureMaxmindData).not.toHaveBeenCalled();
  });
});
