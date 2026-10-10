/**
 * Minimal cwd whitelist for Agent Hub (Face B) dispatch.
 *
 * Both POST /api/tasks/dispatch and swarm_dispatch go through spawnDetachedTask;
 * that path calls {@link assertCwdAllowed} before creating a task.
 *
 * Allowlist source:
 * - env `AGENT_HUB_TASK_ROOTS` — colon-separated absolute paths (replaces defaults)
 * - if unset — process cwd (repo root when the board is started from the repo)
 *   plus `/tmp/agent-hub*` demo dirs (prefix match after path.resolve)
 */
import { resolve, sep } from 'node:path';

/** Env var: colon-separated absolute roots. When set, replaces the default allowlist. */
export const TASK_ROOTS_ENV = 'AGENT_HUB_TASK_ROOTS';

/**
 * Demo / scratch prefix. After resolve(), `/tmp/agent-hub` becomes
 * `/private/tmp/agent-hub` on macOS; matching uses the resolved form so
 * `/tmp/agent-hub-demo-…` and `/tmp/agent-hub/nested` both pass.
 */
export const DEFAULT_TMP_DEMO_PREFIX = '/tmp/agent-hub';

export class CwdNotAllowedError extends Error {
  readonly name = 'CwdNotAllowedError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve the absolute roots from env, or default to `[repoRoot]`.
 * The `/tmp/agent-hub*` demo prefix is a separate rule applied only when env is unset
 * (see {@link isCwdAllowed}).
 */
export function resolveTaskRoots(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = process.cwd(),
): string[] {
  const raw = env[TASK_ROOTS_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    return raw
      .split(':')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => resolve(p));
  }
  return [resolve(repoRoot)];
}

/** Whether env explicitly set a non-empty AGENT_HUB_TASK_ROOTS. */
export function taskRootsEnvSet(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TASK_ROOTS_ENV];
  return raw !== undefined && raw.trim() !== '';
}

/**
 * True when cwd is under a root, or (only with default allowlist) under the
 * `/tmp/agent-hub*` demo prefix.
 */
export function isCwdAllowed(
  cwd: string,
  roots: readonly string[] = resolveTaskRoots(),
  options: { allowTmpDemoPrefix?: boolean; tmpDemoPrefix?: string } = {},
): boolean {
  const resolved = resolve(cwd);
  const allowTmp =
    options.allowTmpDemoPrefix ?? !taskRootsEnvSet();
  const tmpPrefix = resolve(options.tmpDemoPrefix ?? DEFAULT_TMP_DEMO_PREFIX);

  for (const root of roots) {
    if (resolved === root || resolved.startsWith(`${root}${sep}`)) return true;
  }
  if (allowTmp && (resolved === tmpPrefix || resolved.startsWith(tmpPrefix))) {
    return true;
  }
  return false;
}

/**
 * Refuse a dispatch cwd outside the allowlist.
 * @throws {CwdNotAllowedError} with a clear, operator-facing message
 */
export function assertCwdAllowed(
  cwd: string,
  roots: readonly string[] = resolveTaskRoots(),
  options?: { allowTmpDemoPrefix?: boolean; tmpDemoPrefix?: string },
): void {
  if (isCwdAllowed(cwd, roots, options)) return;
  const resolved = resolve(cwd);
  const allowTmp = options?.allowTmpDemoPrefix ?? !taskRootsEnvSet();
  const parts = [
    `Agent Hub: cwd ${resolved} is outside the task-root allowlist`,
    `roots=[${roots.join(', ')}]`,
  ];
  if (allowTmp) {
    parts.push(`also allowed: paths under ${resolve(DEFAULT_TMP_DEMO_PREFIX)}* (demo)`);
  }
  parts.push(
    `set ${TASK_ROOTS_ENV} to a colon-separated list of absolute roots, or use a cwd under the repo / demo prefix`,
  );
  throw new CwdNotAllowedError(parts.join(' — '));
}
