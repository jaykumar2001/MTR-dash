import { describe, expect, it } from 'vitest';
import {
  ipv4ToInt,
  cidrToRangeV4,
  ipv6ToBigInt,
  bigIntToHex128,
  cidrToRangeV6,
  ipVersion,
} from './ipMath.js';

describe('ipv4ToInt', () => {
  it('converts a dotted-quad address to its 32-bit integer form', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
    expect(ipv4ToInt('1.2.3.4')).toBe(1 * 2 ** 24 + 2 * 2 ** 16 + 3 * 2 ** 8 + 4);
  });
});

describe('cidrToRangeV4', () => {
  it('computes the inclusive range for a /24 block', () => {
    const range = cidrToRangeV4('1.2.3.0/24');
    expect(range).toEqual({ start: ipv4ToInt('1.2.3.0'), end: ipv4ToInt('1.2.3.255') });
  });

  it('computes a single-address range for a /32 block', () => {
    const range = cidrToRangeV4('8.8.8.8/32');
    expect(range).toEqual({ start: ipv4ToInt('8.8.8.8'), end: ipv4ToInt('8.8.8.8') });
  });

  it('computes the whole address space for a /0 block', () => {
    const range = cidrToRangeV4('0.0.0.0/0');
    expect(range).toEqual({ start: 0, end: 4294967295 });
  });

  it('handles a non-aligned base address by masking it to the block start', () => {
    // /19 covers 8192 addresses; 14.1.64.0 is already block-aligned per ipdeny data.
    const range = cidrToRangeV4('14.1.64.0/19');
    expect(range!.start).toBe(ipv4ToInt('14.1.64.0'));
    expect(range!.end).toBe(ipv4ToInt('14.1.95.255'));
  });

  it('returns null for malformed input', () => {
    expect(cidrToRangeV4('not-an-ip/24')).toBeNull();
    expect(cidrToRangeV4('1.2.3.4/33')).toBeNull();
    expect(cidrToRangeV4('1.2.3.4')).toBeNull();
  });
});

describe('ipv6ToBigInt / bigIntToHex128', () => {
  it('expands :: shorthand correctly', () => {
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('::')).toBe(0n);
  });

  it('round-trips a full address through hex128', () => {
    const value = ipv6ToBigInt('2001:db8::1');
    expect(bigIntToHex128(value)).toBe('20010db8000000000000000000000001');
  });
});

describe('cidrToRangeV6', () => {
  it('computes the inclusive hex range for a /32 block', () => {
    const range = cidrToRangeV6('2001:db8::/32');
    expect(range!.startHex).toBe('20010db8000000000000000000000000');
    expect(range!.endHex).toBe('20010db8ffffffffffffffffffffffff');
  });

  it('computes a single-address range for a /128 block', () => {
    const range = cidrToRangeV6('::1/128');
    expect(range).toEqual({
      startHex: bigIntToHex128(1n),
      endHex: bigIntToHex128(1n),
    });
  });

  it('preserves numeric ordering via lexicographic hex string comparison', () => {
    const a = cidrToRangeV6('2001:db8::/48')!;
    const b = cidrToRangeV6('2001:db9::/48')!;
    expect(a.startHex < b.startHex).toBe(true);
  });

  it('returns null for malformed input', () => {
    expect(cidrToRangeV6('not-an-ip/32')).toBeNull();
    expect(cidrToRangeV6('::1/129')).toBeNull();
    expect(cidrToRangeV6('::1')).toBeNull();
  });
});

describe('ipVersion', () => {
  it('identifies IPv4, IPv6, and invalid input', () => {
    expect(ipVersion('1.2.3.4')).toBe(4);
    expect(ipVersion('::1')).toBe(6);
    expect(ipVersion('not-an-ip')).toBe(0);
  });
});
