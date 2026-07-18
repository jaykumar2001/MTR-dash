import { describe, expect, it, vi, beforeEach } from 'vitest';
import { api } from './client.js';

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 1, host: '1.1.1.1' }),
      }),
    );
  });

  it('sends a POST with JSON body when creating a target', async () => {
    await api.createTarget({ host: '1.1.1.1', intervalSeconds: 30 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/targets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ host: '1.1.1.1', intervalSeconds: 30 }),
      }),
    );
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    await expect(api.listTargets()).rejects.toThrow('/api/targets');
  });

  it('builds the history query string with an encoded timestamp', async () => {
    await api.getHistory(1, '2026-07-06T10:00:00.000Z');
    expect(fetch).toHaveBeenCalledWith(
      '/api/targets/1/history?at=2026-07-06T10%3A00%3A00.000Z',
      expect.any(Object),
    );
  });

  it('encodes the host when requesting a whois lookup', async () => {
    await api.getWhois('a b.example');
    expect(fetch).toHaveBeenCalledWith('/api/whois/a%20b.example', expect.any(Object));
  });

  it('sends a POST with the host list when requesting bulk whois summaries', async () => {
    await api.getWhoisBulk(['1.1.1.1', '8.8.8.8']);
    expect(fetch).toHaveBeenCalledWith(
      '/api/whois/bulk',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ hosts: ['1.1.1.1', '8.8.8.8'] }),
      }),
    );
  });
});
