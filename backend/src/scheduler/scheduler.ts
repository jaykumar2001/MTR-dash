import type { TargetsService } from '../services/targets.js';
import type { RunsService } from '../services/runs.js';
import type { SseHub } from '../sse/hub.js';
import { runMtr } from '../mtr/runner.js';

export class Scheduler {
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(
    private targetsService: TargetsService,
    private runsService: RunsService,
    private sseHub: SseHub,
    private runMtrFn: typeof runMtr = runMtr,
  ) {}

  start(): void {
    for (const target of this.targetsService.list()) {
      if (target.enabled) this.scheduleTarget(target.id, target.intervalSeconds);
    }
  }

  scheduleTarget(targetId: number, intervalSeconds: number): void {
    this.clearTarget(targetId);
    const timer = setInterval(() => {
      void this.tick(targetId);
    }, intervalSeconds * 1000);
    this.timers.set(targetId, timer);
  }

  clearTarget(targetId: number): void {
    const existing = this.timers.get(targetId);
    if (existing) clearInterval(existing);
    this.timers.delete(targetId);
  }

  async tick(targetId: number): Promise<void> {
    const target = this.targetsService.get(targetId);
    if (!target || !target.enabled) return;
    try {
      const report = await this.runMtrFn(target.host, target.reportCycles, target.addressFamily);
      const result = this.runsService.ingest(targetId, report);
      this.sseHub.publish(targetId, {
        type: 'run',
        runId: result.runId,
        deviations: result.deviations,
      });
    } catch (err) {
      this.sseHub.publish(targetId, { type: 'error', message: (err as Error).message });
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
