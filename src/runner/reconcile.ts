import { recordedProcessPid, recordedProcessExit, abandonUnclaimedLaunch } from './process-launcher.ts';
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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTaskStore } from './task-store.ts';
import {
  SWARM_RUNS_DIR,
  readTaskMeta,
  updateTaskMeta,
  completeTask,
  type TaskMeta,
} from './detached.ts';
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
  const pid = meta.pid ?? recordedProcessPid(defaultTaskStore.dir(meta.taskId));
  if (isProcessAlive(pid)) return false;
  if (!pid && isProcessAlive(meta.launchOwnerPid)) return false;
  return true;
}

/**
 * Settle one orphan RUNNING task: COMPLETED + settlement/harvest path.
 * No-op (returns null) when not RUNNING or the process is still alive.
 */
export function reconcileOrphanTask(taskId: string): TaskMeta | null {
  const meta = readTaskMeta(taskId);
  if (meta === null || meta.status !== 'RUNNING') return null;
  let recordedPid = meta.pid ?? recordedProcessPid(defaultTaskStore.dir(taskId));
  if (!recordedPid && meta.launchOwnerPid && !isProcessAlive(meta.launchOwnerPid)) {
    abandonUnclaimedLaunch(defaultTaskStore.dir(taskId));
    recordedPid = recordedProcessPid(defaultTaskStore.dir(taskId));
  }
  if (!meta.pid && recordedPid) updateTaskMeta(taskId, { pid: recordedPid, launchOwnerPid: undefined });
  if (!isOrphanRunning({ ...meta, pid: recordedPid })) return null;
  const actual = recordedProcessExit(defaultTaskStore.dir(taskId));
  return completeTask(taskId, { status: actual && actual.exitCode !== 0 ? 'FAILED' : 'COMPLETED',
    ...actual, note: RECONCILE_NOTE });
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

  for (const meta of defaultTaskStore.list()) {
    try {
      if (meta.status !== 'RUNNING') {
        if (!existsSync(join(defaultTaskStore.dir(meta.taskId), 'completion.json'))) {
          completeTask(meta.taskId, { status: meta.status });
        }
      } else {
        const fixed = reconcileOrphanTask(meta.taskId);
        if (fixed !== null) repaired.push(fixed);
      }
    } catch { /* A corrupt task must not stop recovery of other tasks. */ }
  }
  return { repaired };
}
