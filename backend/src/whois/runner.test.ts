import { describe, expect, it, vi, beforeEach } from 'vitest';

const lookupMock = vi.fn();

vi.mock('whois', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { runWhois } from './runner.js';

describe('runWhois', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('looks up the host via the whois library and resolves with the raw text', async () => {
    lookupMock.mockImplementation((_addr, _options, callback) => {
      callback(null, 'NetName: TEST\n');
    });

    const result = await runWhois('1.1.1.1');

    expect(lookupMock).toHaveBeenCalledWith(
      '1.1.1.1',
      { follow: 2, timeout: 15000 },
      expect.any(Function),
    );
    expect(result).toBe('NetName: TEST\n');
  });

  it('respects custom follow/timeout options', async () => {
    lookupMock.mockImplementation((_addr, _options, callback) => {
      callback(null, 'ok');
    });

    await runWhois('1.1.1.1', { follow: 0, timeout: 5000 });

    expect(lookupMock).toHaveBeenCalledWith(
      '1.1.1.1',
      { follow: 0, timeout: 5000 },
      expect.any(Function),
    );
  });

  it('rejects when the lookup fails', async () => {
    lookupMock.mockImplementation((_addr, _options, callback) => {
      callback(new Error('no whois server is known for this kind of object'), '');
    });

    await expect(runWhois('not-a-real-host')).rejects.toThrow(
      'no whois server is known for this kind of object',
    );
  });
});
