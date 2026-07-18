// The `whois` npm package ships no type declarations of its own. This is a
// minimal ambient shim covering only the `lookup` API this project uses.
declare module 'whois' {
  export interface WhoisLookupOptions {
    follow?: number;
    timeout?: number;
    server?: string;
  }

  export function lookup(
    addr: string,
    options: WhoisLookupOptions,
    callback: (error: Error | null, data: string) => void,
  ): void;
  export function lookup(addr: string, callback: (error: Error | null, data: string) => void): void;
}
