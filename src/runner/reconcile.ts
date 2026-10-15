/**
 * Reconcile orphan RUNNING tasks whose child process is already gone.
 *
 * When the board/server that spawned a detached child restarts (or the close
 * handler never fires), meta.json can stay `status: RUNNING` forever even
 * though the PID is dead. That blocks the concurrent cap and lies on the board.
 *
 * YAGNI: on list / board load / watchdog tick, flip those to COMPLETED (process
 * exited; exit code unknown), write settlement + report when missing. No new
 * TaskStatus enum values.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SWARM_RUNS_DIR,
  extractProcessOutput,
  generateReport,
  adapterForSettlement,
  getTaskDir,
  readTaskMeta,
  settleTask,
  updateTaskMeta,
  type TaskMeta,
} from './detached.ts';
import { readRunRecord } from './settlement.ts';
import { isProcessAlive } from './timeout-policy.ts';

/** Note written into report.md when reconcile settles a missed close. */
export const RECONCILE_NOTE =
  'Reconciled: meta was RUNNING but child PID is gone (close handler missed / board restarted)';

export interface ReconcileResult {
  /** Tasks whose meta was flipped from RUNNING to a terminal status. */
  readonly repaired: TaskMeta[];
}

/**
 * True when this RUNNING task should be treated as finished on disk:
 * no usable pid, or the OS says the pid is gone.
 */
export function isOrphanRunning(meta: TaskMeta): boolean {
  if (meta.status !== 'RUNNING') return false;
  return !isProcessAlive(meta.pid);
}

/**
 * Settle one orphan RUNNING task: COMPLETED + settlement/harvest path.
 * No-op (returns null) when not RUNNING or the process is still alive.
 */
export function reconcileOrphanTask(taskId: string): TaskMeta | null {
  const meta = readTaskMeta(taskId);
  if (meta === null || !isOrphanRunning(meta)) return null;

  const taskDir = getTaskDir(taskId);
  const existing = readRunRecord(taskDir);
  const endTime = Date.now();

  // Process gone with no recorded exit — mechanical COMPLETED (ADR-0002: not a verdict).
  // If a closing record already exists, still sync meta so the board / cap unblock.
  const updated = updateTaskMeta(taskId, {
    status: 'COMPLETED',
    endTime,
    // Keep any prior exitCode; otherwise leave unset (unknown).
  });
  if (updated === null) return null;

  if (existing === null) {
    const rawLogPath = join(taskDir, 'raw.log');
    const started = existsSync(rawLogPath);
    settleTask(taskId, {
      status: 'COMPLETED',
      adapter: adapterForSettlement(meta.adapter),
      ...started
        ? { output: extractProcessOutput(readFileSync(rawLogPath, 'utf8')) }
        : {},
      exitCode: meta.exitCode ?? null,
    });
  }

  generateReport(taskId, updated, RECONCILE_NOTE);
  return updated;
}

/**
 * Scan `.swarm-runs` and settle every RUNNING task whose PID is missing/dead.
 * Safe to call on every board list / watchdog tick (idempotent for live PIDs).
 */
export function reconcileOrphanRunningTasks(
  runsDir: string = SWARM_RUNS_DIR,
): ReconcileResult {
  const repaired: TaskMeta[] = [];
  if (!existsSync(runsDir)) return { repaired };

  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return { repaired };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const fixed = reconcileOrphanTask(entry.name);
      if (fixed !== null) repaired.push(fixed);
    } catch {
      // best-effort per task — never let one corrupt meta abort the scan
    }
  }
  return { repaired };
}
