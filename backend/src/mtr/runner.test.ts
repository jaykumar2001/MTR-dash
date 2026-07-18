import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { runMtr } from './runner.js';

describe('runMtr', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('invokes mtr with report flags and parses the JSON result', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(null, JSON.stringify({
        report: {
          mtr: { dst: '1.1.1.1' },
          hubs: [
            {
              count: 1,
              host: '1.1.1.1',
              'Loss%': 0,
              Snt: 5,
              Last: 1,
              Avg: 1,
              Best: 1,
              Wrst: 1,
              StDev: 0,
            },
          ],
        },
      }), '');
    });

    const report = await runMtr('1.1.1.1', 5, 'auto', 'mtr');

    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '-n', '1.1.1.1'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(report.hops).toHaveLength(1);
  });

  it('rejects when the process fails', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(new Error('command not found'), '', '');
    });

    await expect(runMtr('1.1.1.1', 5, 'auto', 'mtr')).rejects.toThrow('command not found');
  });

  it.each([
    ['ipv4', '-4'],
    ['ipv6', '-6'],
  ] as const)('appends %s flag %s before the host', async (family, flag) => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(null, JSON.stringify({
        report: { mtr: { dst: 'example.com' }, hubs: [] },
      }), '');
    });

    await runMtr('example.com', 5, family, 'mtr');

    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '-n', flag, 'example.com'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('passes no family flag for auto', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, callback) => {
      callback(null, JSON.stringify({
        report: { mtr: { dst: 'example.com' }, hubs: [] },
      }), '');
    });

    await runMtr('example.com', 5, 'auto', 'mtr');

    expect(execFileMock).toHaveBeenCalledWith(
      'mtr',
      ['--report', '--report-cycles=5', '-j', '-n', 'example.com'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});
