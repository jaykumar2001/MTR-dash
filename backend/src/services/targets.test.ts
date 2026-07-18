import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { TargetsService, TargetValidationError } from './targets.js';

describe('TargetsService', () => {
  let db: Database.Database;
  let service: TargetsService;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new TargetsService(db);
  });

  it('creates a target with defaults', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(target.host).toBe('1.1.1.1');
    expect(target.intervalSeconds).toBe(60);
    expect(target.reportCycles).toBe(10);
    expect(target.enabled).toBe(true);
  });

  it('creates a target with custom interval and cycles', () => {
    const target = service.create({ host: '8.8.8.8', intervalSeconds: 30, reportCycles: 5 });
    expect(target.intervalSeconds).toBe(30);
    expect(target.reportCycles).toBe(5);
  });

  it('creates a target with a default maxStaleHops of 1', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(target.maxStaleHops).toBe(1);
  });

  it('creates a target with a custom maxStaleHops', () => {
    const target = service.create({ host: '8.8.8.8', maxStaleHops: 3 });
    expect(target.maxStaleHops).toBe(3);
  });

  it('updates maxStaleHops', () => {
    const target = service.create({ host: '1.1.1.1' });
    const updated = service.update(target.id, { maxStaleHops: 0 });
    expect(updated?.maxStaleHops).toBe(0);
  });

  it('lists all created targets', () => {
    service.create({ host: '1.1.1.1' });
    service.create({ host: '8.8.8.8' });
    expect(service.list()).toHaveLength(2);
  });

  it('updates a target', () => {
    const target = service.create({ host: '1.1.1.1' });
    const updated = service.update(target.id, { intervalSeconds: 120, enabled: false });
    expect(updated?.intervalSeconds).toBe(120);
    expect(updated?.enabled).toBe(false);
  });

  it('returns undefined when updating a missing target', () => {
    expect(service.update(999, { intervalSeconds: 10 })).toBeUndefined();
  });

  it('removes a target', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(service.remove(target.id)).toBe(true);
    expect(service.get(target.id)).toBeUndefined();
  });

  it('creates a target with a default addressFamily of auto', () => {
    const target = service.create({ host: '1.1.1.1' });
    expect(target.addressFamily).toBe('auto');
  });

  it('persists an explicit addressFamily', () => {
    const target = service.create({ host: 'example.com', addressFamily: 'ipv6' });
    expect(target.addressFamily).toBe('ipv6');
    expect(service.get(target.id)!.addressFamily).toBe('ipv6');
  });

  it('updates addressFamily', () => {
    const target = service.create({ host: 'example.com' });
    const updated = service.update(target.id, { addressFamily: 'ipv4' });
    expect(updated!.addressFamily).toBe('ipv4');
  });

  it('rejects an unknown addressFamily value', () => {
    expect(() =>
      service.create({ host: 'example.com', addressFamily: 'ipv5' as never }),
    ).toThrow(TargetValidationError);
  });

  it('rejects an IPv4 literal host with addressFamily ipv6', () => {
    expect(() => service.create({ host: '8.8.8.8', addressFamily: 'ipv6' })).toThrow(
      TargetValidationError,
    );
  });

  it('rejects an IPv6 literal host with addressFamily ipv4', () => {
    expect(() =>
      service.create({ host: '2606:4700:4700::1111', addressFamily: 'ipv4' }),
    ).toThrow(TargetValidationError);
  });

  it('rejects an update that makes host contradict addressFamily', () => {
    const target = service.create({ host: 'example.com', addressFamily: 'ipv6' });
    expect(() => service.update(target.id, { host: '8.8.8.8' })).toThrow(
      TargetValidationError,
    );
  });

  it('allows a matching literal host and family', () => {
    const target = service.create({ host: '8.8.8.8', addressFamily: 'ipv4' });
    expect(target.addressFamily).toBe('ipv4');
  });
});
