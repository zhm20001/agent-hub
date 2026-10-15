/**
 * Global concurrent RUNNING-task cap for Face B dispatch.
 *
 * Env: AGENT_HUB_MAX_CONCURRENT (positive integer, default 3).
 * Count comes from live .swarm-runs/<taskId>/meta.json with status === RUNNING.
 * Refuse new spawn with ConcurrentCapError (HTTP 429 at the API layer).
 *
 * @module
 */
import { resolve } from 'node:path';
import { TaskStore } from './task-store.ts';

/** Env var: max concurrent RUNNING tasks (default {@link DEFAULT_MAX_CONCURRENT}). */
export const MAX_CONCURRENT_ENV = 'AGENT_HUB_MAX_CONCURRENT';

/** Default global cap when env is unset or empty. */
export const DEFAULT_MAX_CONCURRENT = 3;

export class ConcurrentCapError extends Error {
  readonly name = 'ConcurrentCapError';
  readonly running: number;
  readonly max: number;

  constructor(running: number, max: number) {
    super(
      `Agent Hub: concurrent RUNNING tasks at cap (${running}/${max})`
        + ` — wait for a task to finish, kill one, or raise ${MAX_CONCURRENT_ENV}`,
    );
    this.running = running;
    this.max = max;
  }
}

/** Default .swarm-runs directory (same anchor as detached.ts: process cwd). */
export function defaultRunsDir(): string {
  return resolve(process.cwd(), '.swarm-runs');
}

/**
 * Resolve the positive integer cap from env (or default).
 * Invalid / non-positive values fall back to {@link DEFAULT_MAX_CONCURRENT}.
 */
export function resolveMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_CONCURRENT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_MAX_CONCURRENT;
  return n;
}

/**
 * Count tasks whose meta.json status is RUNNING under runsDir.
 * Unreadable / missing meta entries are skipped (not counted).
 */
export function countRunningTasks(runsDir: string = defaultRunsDir()): number {
  return new TaskStore(runsDir).list().filter(task => task.status === 'RUNNING').length;
}

/**
 * Refuse when live RUNNING count is already at or above the cap.
 * Call before creating a new RUNNING meta / spawning a process.
 * @throws {ConcurrentCapError}
 */
export function assertUnderConcurrentCap(
  env: NodeJS.ProcessEnv = process.env,
  runsDir: string = defaultRunsDir(),
): void {
  const max = resolveMaxConcurrent(env);
  const running = countRunningTasks(runsDir);
  if (running >= max) {
    throw new ConcurrentCapError(running, max);
  }
}
