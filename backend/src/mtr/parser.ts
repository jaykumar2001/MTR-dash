import type { MtrReport } from './types.js';

export function parseMtrJson(raw: string): MtrReport {
  const parsed = JSON.parse(raw);
  const report = parsed.report;
  if (!report || !Array.isArray(report.hubs)) {
    throw new Error('Unexpected mtr JSON structure: missing report.hubs');
  }
  const hops = report.hubs.map((hub: Record<string, unknown>) => ({
    ttl: Number(hub.count),
    host: String(hub.host),
    lossPct: Number(hub['Loss%']),
    snt: Number(hub.Snt),
    last: Number(hub.Last),
    avg: Number(hub.Avg),
    best: Number(hub.Best),
    wrst: Number(hub.Wrst),
    stdev: Number(hub.StDev),
  }));
  return { target: String(report.mtr?.dst ?? ''), hops };
}
