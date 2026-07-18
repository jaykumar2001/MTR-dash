import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { TargetsService } from '../services/targets.js';
import { registerTargetRoutes } from './targets.js';

describe('target routes', () => {
  let db: Database.Database;
  let app: Hono;
  let scheduler: { scheduleTarget: ReturnType<typeof vi.fn>; clearTarget: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createDb(':memory:');
    app = new Hono();
    scheduler = { scheduleTarget: vi.fn(), clearTarget: vi.fn() };
    registerTargetRoutes(app, new TargetsService(db), scheduler);
  });

  it('creates a target via POST and schedules it', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.host).toBe('1.1.1.1');
    expect(scheduler.scheduleTarget).toHaveBeenCalledWith(body.id, 60);
  });

  it('rejects POST without a host', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('creates a target with a custom maxStaleHops via POST', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1', maxStaleHops: 2 }),
    });
    const body = await res.json();
    expect(body.maxStaleHops).toBe(2);
  });

  it('lists targets via GET', async () => {
    await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '1.1.1.1' }),
    });
    const res = await app.request('/api/targets');
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it('clears the scheduler when a target is disabled via PATCH', async () => {
    const created = await (
      await app.request('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '1.1.1.1' }),
      })
    ).json();

    const res = await app.request(`/api/targets/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(scheduler.clearTarget).toHaveBeenCalledWith(created.id);
  });

  it('returns 404 when deleting a missing target', async () => {
    const res = await app.request('/api/targets/999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('deletes a target via DELETE', async () => {
    const created = await (
      await app.request('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '1.1.1.1' }),
      })
    ).json();

    const res = await app.request(`/api/targets/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(scheduler.clearTarget).toHaveBeenCalledWith(created.id);
  });

  it('returns 400 for a non-numeric id on PATCH', async () => {
    const res = await app.request('/api/targets/abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-numeric id on DELETE', async () => {
    const res = await app.request('/api/targets/abc', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('creates a target with an explicit addressFamily via POST', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'example.com', addressFamily: 'ipv6' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.addressFamily).toBe('ipv6');
  });

  it('rejects a contradictory literal host and addressFamily with 400', async () => {
    const res = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '8.8.8.8', addressFamily: 'ipv6' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ipv6/i);
  });

  it('rejects a PATCH that makes host contradict addressFamily with 400', async () => {
    const created = await app.request('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'example.com', addressFamily: 'ipv6' }),
    });
    const { id } = await created.json();
    const res = await app.request(`/api/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '8.8.8.8' }),
    });
    expect(res.status).toBe(400);
  });
});
