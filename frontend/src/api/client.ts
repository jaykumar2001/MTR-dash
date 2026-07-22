import type {
  AddressFamily,
  Target,
  MapResult,
  Deviation,
  HistoryResult,
  WhoisResult,
  WhoisSummary,
  GeoipSummary,
  RunHistoryEntry,
} from '../types.js';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const fullPath = `${BASE}${path}`;
  const res = await fetch(fullPath, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`Request to ${fullPath} failed with status ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
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
  addressFamily?: AddressFamily;
  enabled?: boolean;
}

export const api = {
  listTargets: () => request<Target[]>('/targets'),
  createTarget: (input: CreateTargetInput) =>
    request<Target>('/targets', { method: 'POST', body: JSON.stringify(input) }),
  updateTarget: (id: number, input: UpdateTargetInput) =>
    request<Target>(`/targets/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteTarget: (id: number) => request<void>(`/targets/${id}`, { method: 'DELETE' }),
  getMap: (targetId: number) => request<MapResult>(`/targets/${targetId}/map`),
  getDeviations: (targetId: number) => request<Deviation[]>(`/targets/${targetId}/deviations`),
  getHistory: (targetId: number, at: string) =>
    request<HistoryResult>(`/targets/${targetId}/history?at=${encodeURIComponent(at)}`),
  setNodePosition: (targetId: number, nodeId: number, x: number, y: number) =>
    request<{ ok: true }>(`/targets/${targetId}/nodes/${nodeId}/position`, {
      method: 'PUT',
      body: JSON.stringify({ x, y }),
    }),
  getWhois: (host: string) => request<WhoisResult>(`/whois/${encodeURIComponent(host)}`),
  getWhoisBulk: (hosts: string[]) =>
    request<Record<string, WhoisSummary>>('/whois/bulk', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),
  getDnsBulk: (hosts: string[]) =>
    request<Record<string, string | null>>('/dns/bulk', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),
  getGeoipBulk: (hosts: string[]) =>
    request<Record<string, GeoipSummary>>('/geoip/bulk', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),
  getRunHistory: (targetId: number, limit = 50) =>
    request<RunHistoryEntry[]>(`/targets/${targetId}/runs?limit=${limit}`),
};
