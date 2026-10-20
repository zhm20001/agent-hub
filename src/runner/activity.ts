import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerAdapter } from '../adapters/base.ts';
import type { TaskMeta } from './task-types.ts';
import { recordedProcessPid } from './process-launcher.ts';
import { isProcessAlive } from './timeout-policy.ts';

function fileFacts(path: string | null) {
  if (!path) return { state: 'unlocated' as const, bytes: null, modifiedAt: null };
  try {
    const stat = statSync(path); if (!stat.isFile()) throw Error('not a file');
    return { state: 'available' as const, bytes: stat.size, modifiedAt: stat.mtimeMs };
  } catch { return { state: 'missing' as const, bytes: null, modifiedAt: null }; }
}
function tail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r'); const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 65536));
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, size - buffer.length)).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Observation has no stalled verdict and never participates in termination policy. */
export function taskActivity(meta: TaskMeta, taskDir: string, transcriptPath: string | null, adapter: WorkerAdapter, now: number) {
  const logPath = join(taskDir, 'raw.log');
  const log = fileFacts(logPath), transcript = fileFacts(transcriptPath);
  const source = transcript.state === 'available' && (transcript.modifiedAt ?? 0) > (log.modifiedAt ?? 0) ? transcriptPath : logPath;
  return { observedAt: now, supervisorAlive: isProcessAlive(meta.pid ?? recordedProcessPid(taskDir)), launchOwnerAlive: isProcessAlive(meta.launchOwnerPid), log, transcript,
    agent: adapter.observeActivity?.(tail(source!)) ?? null,
    agentSource: adapter.observeActivity ? (source === logPath ? 'raw-log' : 'transcript') : null };
}
