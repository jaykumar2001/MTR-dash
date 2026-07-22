import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMaxmindData } from './ensureMaxmindData.js';

describe('ensureMaxmindData', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-maxmind-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('does nothing when confPath is undefined', async () => {
    const execFileFn = vi.fn();
    await ensureMaxmindData(undefined, '/tmp/whatever', { execFileFn });
    expect(execFileFn).not.toHaveBeenCalled();
  });

  it('does nothing when confPath does not exist on disk', async () => {
    const execFileFn = vi.fn();
    await ensureMaxmindData('/nonexistent/GeoIP.conf', '/tmp/whatever', { execFileFn });
    expect(execFileFn).not.toHaveBeenCalled();
  });

  it('skips geoipupdate when the mmdb file is fresh (under 24h old)', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const statFn = vi.fn().mockResolvedValue({ mtimeMs: Date.now() - 60_000 } as fs.Stats);

    await ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn });

    expect(execFileFn).not.toHaveBeenCalled();
  });

  it('runs geoipupdate when the mmdb file is missing', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const statFn = vi.fn().mockRejectedValue(new Error('ENOENT'));

    await ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn });

    expect(execFileFn).toHaveBeenCalledWith('geoipupdate', ['-f', confPath, '-d', tmpDir]);
  });

  it('runs geoipupdate when the mmdb file is older than 24h', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const statFn = vi
      .fn()
      .mockResolvedValue({ mtimeMs: Date.now() - 25 * 60 * 60 * 1000 } as fs.Stats);

    await ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn });

    expect(execFileFn).toHaveBeenCalledWith('geoipupdate', ['-f', confPath, '-d', tmpDir]);
  });

  it('swallows a geoipupdate failure without throwing', async () => {
    const tmpDir = makeTmpDir();
    const confPath = path.join(tmpDir, 'GeoIP.conf');
    fs.writeFileSync(confPath, '');
    const execFileFn = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const statFn = vi.fn().mockRejectedValue(new Error('ENOENT'));

    await expect(
      ensureMaxmindData(confPath, tmpDir, { execFileFn, statFn }),
    ).resolves.toBeUndefined();
  });
});
