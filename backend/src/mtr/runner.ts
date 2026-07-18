import { execFile } from 'node:child_process';
import { parseMtrJson } from './parser.js';
import type { AddressFamily, MtrReport } from './types.js';

export function runMtr(
  host: string,
  cycles: number,
  family: AddressFamily = 'auto',
  mtrBin: string = process.env.MTR_BIN ?? 'mtr',
): Promise<MtrReport> {
  const args = ['--report', `--report-cycles=${cycles}`, '-j', '-n'];
  if (family === 'ipv4') args.push('-4');
  if (family === 'ipv6') args.push('-6');
  args.push(host);
  return new Promise((resolve, reject) => {
    execFile(
      mtrBin,
      args,
      { timeout: (cycles + 10) * 2000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseMtrJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
