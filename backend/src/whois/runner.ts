import { lookup } from 'whois';

export interface RunWhoisOptions {
  follow?: number;
  timeout?: number;
}

/**
 * Looks up `host` via the native `whois` npm library (a direct WHOIS-protocol
 * socket client — no `whois` CLI binary or OS package required) and resolves
 * with the raw response text.
 */
export function runWhois(host: string, options: RunWhoisOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(
      host,
      { follow: options.follow ?? 2, timeout: options.timeout ?? 15000 },
      (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(data);
      },
    );
  });
}
