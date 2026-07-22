export type AddressFamily = 'auto' | 'ipv4' | 'ipv6';

export interface Target {
  id: number;
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  maxStaleHops: number;
  addressFamily: AddressFamily;
  enabled: boolean;
  createdAt: string;
}

export interface MapNode {
  id: number | string;
  ttl: number;
  host: string;
  // The host actually recorded for this node's underlying poll history,
  // unaffected by any display-only relabeling (e.g. known-bridge inference) —
  // history-at-a-point-in-time matching must compare against this, not `host`.
  // Optional (falls back to `host`) so fixtures/mocks that predate this field
  // still describe an ordinary, never-relabeled node.
  rawHost?: string;
  active: boolean;
  x: number;
  y: number;
  hasCustomPosition?: boolean;
  inferred?: boolean;
}

export interface EdgeMetrics {
  lossPct: number;
  snt: number;
  last: number;
  avg: number;
  best: number;
  wrst: number;
  stdev: number;
}

export interface MapEdge {
  id: string;
  source: number | string;
  target: number | string;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}

export interface MapResult {
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface Deviation {
  id: number;
  ttl: number;
  oldHost: string | null;
  newHost: string;
  detectedAt: string;
}

export interface HistoryResult {
  at: string;
  active: { ttl: number; host: string }[];
}

export interface WhoisField {
  key: string;
  value: string;
}

export interface WhoisResult {
  host: string;
  fields: WhoisField[];
}

export interface WhoisSummary {
  netname: string | null;
}

export interface GeoipSummary {
  country: string | null;
  city: string | null;
}

export interface RunHistoryHop {
  ttl: number;
  host: string;
  lossPct: number;
  snt: number;
  last: number;
  avg: number;
  best: number;
  wrst: number;
  stdev: number;
}

export interface RunHistoryEntry {
  id: number;
  startedAt: string;
  hops: RunHistoryHop[];
}
