import { isIPv4, isIPv6 } from 'node:net';

/** Converts a dotted-quad IPv4 address to its 32-bit unsigned integer form. */
export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export interface IntRange {
  start: number;
  end: number;
}

/** Converts an IPv4 CIDR block (e.g. "1.2.3.0/24") to its inclusive [start, end] integer range. */
export function cidrToRangeV4(cidr: string): IntRange | null {
  const [ip, prefixStr] = cidr.split('/');
  if (!ip || !isIPv4(ip)) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const base = ipv4ToInt(ip);
  const hostBits = 32 - prefix;
  // `<< 32` is a no-op in JS (shift amounts wrap mod 32), so prefix=0 (a
  // full-32-bit host mask) needs an explicit special case rather than
  // computing `0xffffffff << 32`.
  const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  const start = (base & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

/** Expands an IPv6 address (with optional `::` shorthand) to a 128-bit BigInt. */
export function ipv6ToBigInt(ip: string): bigint {
  const [headPart, tailPart] = ip.split('::');
  const head = headPart ? headPart.split(':').filter((g) => g !== '') : [];
  const tail = tailPart ? tailPart.split(':').filter((g) => g !== '') : [];
  const missing = 8 - (head.length + tail.length);
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group || '0', 16));
  }
  return value;
}

/** Renders a 128-bit BigInt as a fixed-width, zero-padded 32-character hex string. */
export function bigIntToHex128(value: bigint): string {
  return value.toString(16).padStart(32, '0');
}

export interface HexRange {
  startHex: string;
  endHex: string;
}

/** Converts an IPv6 CIDR block (e.g. "2001:db8::/32") to its inclusive [startHex, endHex] range. */
export function cidrToRangeV6(cidr: string): HexRange | null {
  const [ip, prefixStr] = cidr.split('/');
  if (!ip || !isIPv6(ip)) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const base = ipv6ToBigInt(ip);
  const hostBits = BigInt(128 - prefix);
  const fullMask = (1n << 128n) - 1n;
  const mask = hostBits === 0n ? fullMask : (fullMask << hostBits) & fullMask;
  const start = base & mask;
  const end = start | (fullMask ^ mask);
  return { startHex: bigIntToHex128(start), endHex: bigIntToHex128(end) };
}

/** Returns 4 for a valid IPv4 literal, 6 for a valid IPv6 literal, or 0 otherwise. */
export function ipVersion(ip: string): 0 | 4 | 6 {
  if (isIPv4(ip)) return 4;
  if (isIPv6(ip)) return 6;
  return 0;
}
