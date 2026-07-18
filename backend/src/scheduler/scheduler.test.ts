import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { TargetsService } from '../services/targets.js';
import { RunsService } from '../services/runs.js';
import { SseHub } from '../sse/hub.js';
import { Scheduler } from './scheduler.js';
import type { MtrReport } from '../mtr/types.js';

describe('Scheduler', () => {
  let db: Database.Database;
  let targets: TargetsService;
  let runs: RunsService;
  let sseHub: SseHub;
  let runMtrFn: ReturnType<typeof vi.fn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createDb(':memory:');
    targets = new TargetsService(db);
    runs = new RunsService(db);
    sseHub = new SseHub();
    runMtrFn = vi.fn<(host: string, cycles: number, family?: string) => Promise<MtrReport>>();
    scheduler = new Scheduler(targets, runs, sseHub, runMtrFn);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('runs mtr and ingests a report on each tick', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockResolvedValue({
      target: '1.1.1.1',
      hops: [{ ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
    });

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runMtrFn).toHaveBeenCalledWith('1.1.1.1', 10, 'auto');
    const hopRows = db.prepare('SELECT * FROM hops').all();
    expect(hopRows).toHaveLength(1);
  });

  it('publishes an SSE event with the new run id and deviations after each tick', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockResolvedValue({
      target: '1.1.1.1',
      hops: [{ ttl: 1, host: 'A', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 }],
    });
    const listener = vi.fn();
    sseHub.subscribe(target.id, listener);

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run', deviations: expect.any(Array) }),
    );
  });

  it('publishes an error event when the mtr run fails', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockRejectedValue(new Error('boom'));
    const listener = vi.fn();
    sseHub.subscribe(target.id, listener);

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(listener).toHaveBeenCalledWith({ type: 'error', message: 'boom' });
  });

  it('stops ticking a target after clearTarget', async () => {
    const target = targets.create({ host: '1.1.1.1', intervalSeconds: 60 });
    runMtrFn.mockResolvedValue({ target: '1.1.1.1', hops: [] });

    scheduler.scheduleTarget(target.id, 60);
    scheduler.clearTarget(target.id);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(runMtrFn).not.toHaveBeenCalled();
  });

  it('passes the target addressFamily to the runner', async () => {
    const target = targets.create({
      host: 'example.com',
      intervalSeconds: 60,
      addressFamily: 'ipv6',
    });
    runMtrFn.mockResolvedValue({ target: 'example.com', hops: [] });

    scheduler.scheduleTarget(target.id, 60);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runMtrFn).toHaveBeenCalledWith('example.com', 10, 'ipv6');
  });
});
