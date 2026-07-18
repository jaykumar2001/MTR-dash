export type AddressFamily = 'auto' | 'ipv4' | 'ipv6';

export interface MtrHopReport {
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

export interface MtrReport {
  target: string;
  hops: MtrHopReport[];
}
