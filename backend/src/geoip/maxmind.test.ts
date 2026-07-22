import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'maxmind';
import { lookupCity, _resetMaxmindCacheForTests } from './maxmind.js';

vi.mock('maxmind', () => ({ open: vi.fn() }));

describe('lookupCity', () => {
  let dbPath: string;

  beforeEach(() => {
    _resetMaxmindCacheForTests();
    vi.mocked(open).mockReset();
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'maxmind-test-')),
      'GeoLite2-City.mmdb',
    );
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns null when the database file does not exist', async () => {
    const result = await lookupCity(dbPath, '8.8.8.8');
    expect(result).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('returns country and city from a resolved record', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({
      get: vi.fn().mockReturnValue({
        country: { iso_code: 'US' },
        city: { names: { en: 'Mountain View' } },
      }),
    } as never);

    const result = await lookupCity(dbPath, '8.8.8.8');

    expect(result).toEqual({ country: 'US', city: 'Mountain View' });
  });

  it('returns null when the IP has no record in the database', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({ get: vi.fn().mockReturnValue(null) } as never);

    const result = await lookupCity(dbPath, '203.0.113.1');

    expect(result).toBeNull();
  });

  it('returns null and does not throw when open() fails', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockRejectedValue(new Error('corrupt database'));

    const result = await lookupCity(dbPath, '8.8.8.8');

    expect(result).toBeNull();
  });

  it('reuses the open reader across calls to the same, unchanged file', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({
      get: vi.fn().mockReturnValue({ country: { iso_code: 'US' }, city: { names: { en: 'X' } } }),
    } as never);

    await lookupCity(dbPath, '8.8.8.8');
    await lookupCity(dbPath, '1.1.1.1');

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reopens the reader when the file is replaced with a newer mtime', async () => {
    fs.writeFileSync(dbPath, 'fake-mmdb-bytes');
    vi.mocked(open).mockResolvedValue({
      get: vi.fn().mockReturnValue({ country: { iso_code: 'US' }, city: { names: { en: 'X' } } }),
    } as never);
    await lookupCity(dbPath, '8.8.8.8');

    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(dbPath, 'new-fake-mmdb-bytes');
    fs.utimesSync(dbPath, future, future);

    await lookupCity(dbPath, '8.8.8.8');

    expect(open).toHaveBeenCalledTimes(2);
  });
});
