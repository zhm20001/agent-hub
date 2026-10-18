import { adapterForSettlement } from '../adapters/registry.ts';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultEngine, type TaskEngine } from './detached.ts';
import { decideWatchdogAction } from './timeout-policy.ts';
import { locateRunTranscript } from './transcript.ts';
import { reconcileOrphanRunningTasks } from './reconcile.ts';

export class TtlWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(intervalMs: number = 10_000, readonly engine: TaskEngine = defaultEngine) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkTimeouts();
    }, this.intervalMs);
    // unref so timer doesn't prevent graceful server shutdown
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkTimeouts(): void {
    if (!existsSync(this.engine.store.runsDir)) return;

    try {
      // Periodic: settle orphans before TTL decisions (dead PID ≠ timeout kill).
      reconcileOrphanRunningTasks(this.engine);
      const tasks = this.engine.store.list();
      const now = this.engine.now();

      for (const meta of tasks) {
        const taskId = meta.taskId;
        if (meta.status !== 'RUNNING') continue;

        const timeoutSec = meta.timeout || 7200;
        const elapsedMs = now - meta.startTime;
        const taskDir = this.engine.getTaskDir(taskId);
        const record = this.engine.readResolution(taskId);
        let adapter;
        try { adapter = this.engine.getAdapter(meta.adapter); } catch { adapter = adapterForSettlement(meta.adapter); }
        const { transcriptPath } = locateRunTranscript(record, meta, { adapter });

        const decision = decideWatchdogAction({
          elapsedMs,
          timeoutSec,
          timeoutExtended: meta.timeoutExtended === true,
          pid: meta.pid,
          taskDir,
          transcriptPath,
          now,
          env: this.engine.env,
        });

        if (decision.action === 'wait') continue;

        const rawLogPath = join(taskDir, 'raw.log');

        if (decision.action === 'extend') {
          const newTimeout = timeoutSec + decision.extendSec;
          const note = `\n[WATCHDOG] Deadline reached after ${Math.round(elapsedMs / 1000)}s `
            + `(limit: ${timeoutSec}s) but ${decision.reason}`
            + (decision.evidencePath ? ` (${decision.evidencePath})` : '')
            + ` — extending once by ${decision.extendSec}s (new limit: ${newTimeout}s).\n`;
          try {
            appendFileSync(rawLogPath, note, 'utf8');
          } catch {}
          this.engine.updateTaskMeta(taskId, {
            timeout: newTimeout,
            timeoutExtended: true,
          });
          continue;
        }

        // kill
        const timeoutWarning = `\n[WATCHDOG] Task timed out after ${Math.round(elapsedMs / 1000)}s `
          + `(limit: ${timeoutSec}s). ${decision.reason}. Terminating PID ${meta.pid}...\n`;
        try {
          appendFileSync(rawLogPath, timeoutWarning, 'utf8');
        } catch {}

        this.engine.terminateTask(taskId, 'timeout');
      }
    } catch {}
  }
}
