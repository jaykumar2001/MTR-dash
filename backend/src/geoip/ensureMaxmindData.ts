import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface EnsureMaxmindDataOptions {
  execFileFn?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  statFn?: (path: string) => Promise<fs.Stats>;
}

/** Refreshes the MaxMind GeoLite2-City database by running `geoipupdate`,
 * but only when it's actually needed: skipped entirely when `confPath` is
 * unset (feature disabled) or missing (not configured), and skipped when
 * `GeoLite2-City.mmdb` already exists and is under 24h old. Never throws —
 * a missing `geoipupdate` binary, bad credentials, or a network failure is
 * logged and swallowed so it can never break app startup or the periodic
 * refresh timer. */
export async function ensureMaxmindData(
  confPath: string | undefined,
  dbDir: string,
  options: EnsureMaxmindDataOptions = {},
): Promise<void> {
  if (!confPath) return;
  if (!fs.existsSync(confPath)) {
    console.warn(`geoip: GEOIP_CONF_PATH (${confPath}) does not exist — skipping MaxMind refresh`);
    return;
  }

  const execFileFn = options.execFileFn ?? execFileAsync;
  const statFn = options.statFn ?? fs.promises.stat;
  const dbPath = path.join(dbDir, 'GeoLite2-City.mmdb');

  try {
    const stat = await statFn(dbPath);
    if (Date.now() - stat.mtimeMs < MAX_AGE_MS) return;
  } catch {
    // Doesn't exist yet — fall through and download it.
  }

  try {
    fs.mkdirSync(dbDir, { recursive: true });
    await execFileFn('geoipupdate', ['-f', confPath, '-d', dbDir]);
  } catch (err) {
    console.warn(
      `geoip: geoipupdate failed — keeping existing/no MaxMind data: ${(err as Error).message}`,
    );
  }
}
