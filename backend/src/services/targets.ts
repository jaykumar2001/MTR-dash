import { isIP } from 'node:net';
import type Database from 'better-sqlite3';
import type { AddressFamily } from '../mtr/types.js';

export interface Target {
  id: number;
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  maxStaleHops: number;
  enabled: boolean;
  createdAt: string;
  addressFamily: AddressFamily;
}

export interface CreateTargetInput {
  host: string;
  intervalSeconds?: number;
  reportCycles?: number;
  maxStaleHops?: number;
  addressFamily?: AddressFamily;
}

export interface UpdateTargetInput {
  host?: string;
  intervalSeconds?: number;
  reportCycles?: number;
  maxStaleHops?: number;
  enabled?: boolean;
  addressFamily?: AddressFamily;
}

interface TargetRow {
  id: number;
  host: string;
  interval_seconds: number;
  report_cycles: number;
  max_stale_hops: number;
  enabled: number;
  created_at: string;
  address_family: string;
}

function toTarget(row: TargetRow): Target {
  return {
    id: row.id,
    host: row.host,
    intervalSeconds: row.interval_seconds,
    reportCycles: row.report_cycles,
    maxStaleHops: row.max_stale_hops,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    addressFamily: row.address_family as AddressFamily,
  };
}

export class TargetValidationError extends Error {}

const ADDRESS_FAMILIES: readonly AddressFamily[] = ['auto', 'ipv4', 'ipv6'];

function validateAddressFamily(host: string, family: AddressFamily): void {
  if (!ADDRESS_FAMILIES.includes(family)) {
    throw new TargetValidationError(`invalid addressFamily: ${String(family)}`);
  }
  const literal = isIP(host);
  if (literal === 4 && family === 'ipv6') {
    throw new TargetValidationError('host is an IPv4 literal but addressFamily is ipv6');
  }
  if (literal === 6 && family === 'ipv4') {
    throw new TargetValidationError('host is an IPv6 literal but addressFamily is ipv4');
  }
}

export class TargetsService {
  constructor(private db: Database.Database) {}

  list(): Target[] {
    const rows = this.db.prepare('SELECT * FROM targets ORDER BY id ASC').all() as TargetRow[];
    return rows.map(toTarget);
  }

  get(id: number): Target | undefined {
    const row = this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as
      | TargetRow
      | undefined;
    return row ? toTarget(row) : undefined;
  }

  create(input: CreateTargetInput): Target {
    const intervalSeconds = input.intervalSeconds ?? 60;
    const reportCycles = input.reportCycles ?? 10;
    const maxStaleHops = input.maxStaleHops ?? 1;
    const addressFamily = input.addressFamily ?? 'auto';
    validateAddressFamily(input.host, addressFamily);
    const result = this.db
      .prepare(
        'INSERT INTO targets (host, interval_seconds, report_cycles, max_stale_hops, address_family) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.host, intervalSeconds, reportCycles, maxStaleHops, addressFamily);
    return this.get(result.lastInsertRowid as number)!;
  }

  update(id: number, input: UpdateTargetInput): Target | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...input };
    validateAddressFamily(merged.host, merged.addressFamily);
    this.db
      .prepare(
        'UPDATE targets SET host = ?, interval_seconds = ?, report_cycles = ?, max_stale_hops = ?, address_family = ?, enabled = ? WHERE id = ?',
      )
      .run(
        merged.host,
        merged.intervalSeconds,
        merged.reportCycles,
        merged.maxStaleHops,
        merged.addressFamily,
        merged.enabled ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  remove(id: number): boolean {
    const result = this.db.prepare('DELETE FROM targets WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
