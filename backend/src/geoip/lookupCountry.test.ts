import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { lookupCountry } from './lookupCountry.js';
import { cidrToRangeV4, cidrToRangeV6, ipv4ToInt } from './ipMath.js';

describe('lookupCountry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
    const usV4 = cidrToRangeV4('8.8.8.0/24')!;
    const deV4 = cidrToRangeV4('1.1.1.0/24')!;
    db.prepare('INSERT INTO geoip_v4_ranges (start_int, end_int, country) VALUES (?, ?, ?)').run(
      usV4.start,
      usV4.end,
      'US',
    );
    db.prepare('INSERT INTO geoip_v4_ranges (start_int, end_int, country) VALUES (?, ?, ?)').run(
      deV4.start,
      deV4.end,
      'DE',
    );
    const jpV6 = cidrToRangeV6('2001:db8::/32')!;
    db.prepare(
      'INSERT INTO geoip_v6_ranges (start_hex, end_hex, country) VALUES (?, ?, ?)',
    ).run(jpV6.startHex, jpV6.endHex, 'JP');
  });

  it('finds the country for an IPv4 address inside a known block', () => {
    expect(lookupCountry(db, '8.8.8.8')).toBe('US');
    expect(lookupCountry(db, '1.1.1.1')).toBe('DE');
  });

  it('returns null for an IPv4 address outside any known block', () => {
    expect(lookupCountry(db, '203.0.113.1')).toBeNull();
  });

  it('finds the country for an IPv6 address inside a known block', () => {
    expect(lookupCountry(db, '2001:db8::1')).toBe('JP');
  });

  it('returns null for an IPv6 address outside any known block', () => {
    expect(lookupCountry(db, '2001:db9::1')).toBeNull();
  });

  it('returns null for a non-IP string', () => {
    expect(lookupCountry(db, 'not-an-ip')).toBeNull();
  });

  it('correctly rejects an address just past the end of a block', () => {
    // 8.8.8.0/24 ends at 8.8.8.255; 8.8.9.0 must not match.
    expect(ipv4ToInt('8.8.9.0')).toBeGreaterThan(ipv4ToInt('8.8.8.255'));
    expect(lookupCountry(db, '8.8.9.0')).toBeNull();
  });
});
