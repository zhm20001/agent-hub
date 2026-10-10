/**
 * Face B TTL policy: default timeout + YAGNI progress probe before kill.
 *
 * Env:
 *   AGENT_HUB_DEFAULT_TIMEOUT   — seconds (default 7200)
 *   AGENT_HUB_TIMEOUT_EXTEND_SEC — one-shot extension when progress seen (default = same as task timeout, capped)
 *   AGENT_HUB_PROGRESS_FRESH_MS  — how recent raw.log / transcript mtime must be (default 120000)
 *
 * @module
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TIMEOUT_ENV = 'AGENT_HUB_DEFAULT_TIMEOUT';
export const TIMEOUT_EXTEND_ENV = 'AGENT_HUB_TIMEOUT_EXTEND_SEC';
export const PROGRESS_FRESH_ENV = 'AGENT_HUB_PROGRESS_FRESH_MS';

/** Default TTL when env unset / invalid — 2 hours (was 1800s / 30 min). */
export const DEFAULT_TIMEOUT_SEC = 7200;

/** Default: treat file mtime within 2 minutes as "still making progress". */
export const DEFAULT_PROGRESS_FRESH_MS = 120_000;

export function resolveDefaultTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEFAULT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60) return DEFAULT_TIMEOUT_SEC;
  return Math.floor(n);
}

export function resolveProgressFreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PROGRESS_FRESH_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROGRESS_FRESH_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000) return DEFAULT_PROGRESS_FRESH_MS;
  return Math.floor(n);
}

/**
 * One-shot extension length in seconds when the probe says "still alive + progress".
 * Defaults to the task's own timeout (another full budget), minimum 600.
 */
export function resolveExtendSeconds(
  taskTimeoutSec: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[TIMEOUT_EXTEND_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 60) return Math.floor(n);
  }
  return Math.max(600, Math.floor(taskTimeoutSec) || DEFAULT_TIMEOUT_SEC);
}

/** True when the OS still has this PID (signal 0 probe). */
export function isProcessAlive(pid: number | undefined | null): boolean {
  if (pid === undefined || pid === null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProgressProbeInput {
  readonly taskDir: string;
  /** Absolute transcript JSONL path when known. */
  readonly transcriptPath?: string | null;
  readonly now?: number;
  readonly freshMs?: number;
}

export interface ProgressProbeResult {
  readonly alive: boolean;
  readonly recentProgress: boolean;
  /** Path whose mtime counted, when recentProgress. */
  readonly evidencePath?: string;
  readonly mtimeMs?: number;
}

function mtimeMs(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * YAGNI progress probe: process alive + recent mtime on raw.log and/or transcript.
 * Not full hang detection — just "don't kill a busy coding agent on first deadline".
 */
export function probeTaskProgress(
  pid: number | undefined | null,
  input: ProgressProbeInput,
): ProgressProbeResult {
  const alive = isProcessAlive(pid);
  const now = input.now ?? Date.now();
  const freshMs = input.freshMs ?? resolveProgressFreshMs();
  const candidates: string[] = [
    join(input.taskDir, 'raw.log'),
  ];
  if (typeof input.transcriptPath === 'string' && input.transcriptPath.length > 0) {
    candidates.push(input.transcriptPath);
  }

  let bestPath: string | undefined;
  let bestMtime = 0;
  for (const path of candidates) {
    const mt = mtimeMs(path);
    if (mt === null) continue;
    if (mt > bestMtime) {
      bestMtime = mt;
      bestPath = path;
    }
  }

  const recentProgress = bestPath !== undefined && now - bestMtime <= freshMs;
  return {
    alive,
    recentProgress,
    ...bestPath === undefined ? {} : { evidencePath: bestPath, mtimeMs: bestMtime },
  };
}

export type WatchdogDecision =
  | { readonly action: 'wait' }
  | { readonly action: 'extend'; readonly extendSec: number; readonly reason: string; readonly evidencePath?: string }
  | { readonly action: 'kill'; readonly reason: string };

export interface WatchdogInput {
  readonly elapsedMs: number;
  readonly timeoutSec: number;
  readonly timeoutExtended?: boolean;
  readonly pid?: number | null;
  readonly taskDir: string;
  readonly transcriptPath?: string | null;
  readonly now?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Decide what the TTL watchdog should do for one RUNNING task past (or near) deadline.
 */
export function decideWatchdogAction(input: WatchdogInput): WatchdogDecision {
  const now = input.now ?? Date.now();
  const limitMs = (input.timeoutSec || resolveDefaultTimeout(input.env)) * 1000;
  if (input.elapsedMs <= limitMs) return { action: 'wait' };

  const probe = probeTaskProgress(input.pid, {
    taskDir: input.taskDir,
    transcriptPath: input.transcriptPath,
    now,
    freshMs: resolveProgressFreshMs(input.env),
  });

  // Already used the one-shot extension → kill.
  if (input.timeoutExtended) {
    return {
      action: 'kill',
      reason: probe.alive
        ? 'deadline+extension exhausted (process still alive)'
        : 'deadline+extension exhausted (process gone)',
    };
  }

  // Alive + recent file activity → extend once.
  if (probe.alive && probe.recentProgress) {
    const extendSec = resolveExtendSeconds(input.timeoutSec, input.env);
    return {
      action: 'extend',
      extendSec,
      reason: 'process alive with recent progress',
      ...probe.evidencePath === undefined ? {} : { evidencePath: probe.evidencePath },
    };
  }

  return {
    action: 'kill',
    reason: !probe.alive
      ? 'deadline hit and process not alive'
      : 'deadline hit and no recent progress on raw.log/transcript',
  };
}
