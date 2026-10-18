import { PROCESS_LAUNCHER, recordedProcessExit, recordedProcessPid, abandonUnclaimedLaunch } from './process-launcher.ts';
import { spawn, execSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { assertCwdAllowed, resolveTaskRoots, taskRootsEnvSet } from './task-roots.ts';
import { assertUnderConcurrentCap } from './concurrency.ts';
import { locateRunTranscript } from './transcript.ts';
import { resolveDefaultTimeout } from './timeout-policy.ts';
import { resolveModelInfo } from './model-info.ts';
import type { WorkerAdapter } from '../adapters/base.ts';
import type { FinalText, PreconditionUnmet, SessionRef, TranscriptRef } from '../adapters/contract.ts';
import { getAdapter, adapterForSettlement, UnknownAdapterError } from '../adapters/registry.ts';
export { getAdapter, adapterForSettlement, UnknownAdapterError, KNOWN_ADAPTERS } from '../adapters/registry.ts';
import { PreconditionUnmetError } from '../adapters/preconditions.ts';
import {
  RUN_RECORD_FILE,
  fallbackTranslation,
  readRunRecord,
  settleRun,
  writeRunRecord,
  type RunRecord,
} from './settlement.ts';

import { defaultTaskStore, TaskStore } from './task-store.ts';
import { atomicWrite, withFileLock } from './file-storage.ts';
import type { TaskMeta, TaskStatus } from './task-types.ts';
export type { TaskMeta, TaskStatus } from './task-types.ts';

export const SWARM_RUNS_DIR = defaultTaskStore.runsDir;
export const getTaskDir = (id: string): string => defaultTaskStore.dir(id);
export const ensureRunsDir = (): void => defaultTaskStore.ensure();

/**
 * The process's own output: `raw.log` minus the header this runner prepended.
 * The header's last line is a run of `=` followed by a blank line, and it is the
 * first such block in the file (the task line above it is not a bare run of `=`).
 */
export function extractProcessOutput(log: string): string {
  if (!log.startsWith('=== Swarm Task ')) return log;
  const boundary = /\n=+\n\n/.exec(log);
  return boundary === null ? log : log.slice(boundary.index + boundary[0].length);
}

/**
 * Settle one run and persist its record. Called at the moment the engine knows
 * the run ended — or that it never started. Only the engine holds those facts.
 *
 * `output === undefined` means nothing ran at all, so the adapter is not asked
 * to translate: there is nothing to translate, and asking would tempt a
 * "best-effort" reading of an empty log.
 * @param taskId - the task whose process facts these are.
 * @param facts - terminal status, the adapter that owns translation, and the
 * process's output/exit facts when there was a process.
 * @returns the persisted record, so callers can render it immediately.
 */
export interface TaskCompletion {
  status: Exclude<TaskStatus, 'RUNNING'>;
  output?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  note?: string;
}

export interface DispatchOptions {
  taskId?: string;
  request_key?: string;
  projectId?: string;
  parentTaskId?: string;
  dependsOn?: string[];
  handoff?: boolean;
  originalPrompt?: string;
  ticket?: string;
  label?: string;
  prompt: string;
  cwd?: string;
  adapter?: string;
  mode?: string;
  disallowedTools?: string[];
  resumeSessionId?: string;
  timeout?: number;
}

export class DispatchValidationError extends Error {
  readonly name = 'DispatchValidationError';
  readonly statusCode = 400;
}
export class RequestConflictError extends Error {
  readonly name = 'RequestConflictError';
  readonly statusCode = 409;
  constructor(readonly request_key: string) { super(`Request key already used with different input: ${request_key}`); }
}
export class TaskIdConflictError extends Error {
  readonly name = 'TaskIdConflictError';
  readonly statusCode = 409;
  constructor(readonly taskId: string) { super(`Task already exists: ${taskId}`); }
}
export class DispatchRecoveryRequiredError extends Error {
  readonly name = 'DispatchRecoveryRequiredError';
  readonly statusCode = 409;
  constructor(readonly taskId: string) { super(`Dispatch ${taskId} was reserved before interruption; inspect before retrying`); }
}
export interface TaskEngineOptions {
  store: TaskStore;
  getAdapter?: (name: string) => WorkerAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  prepareDispatch?: (options: DispatchOptions, original: DispatchOptions) => DispatchOptions;
  onSettled?: (taskId: string) => void;
}
function taskContext(options: DispatchOptions): Partial<TaskMeta> {
  return { request_key: options.request_key, projectId: options.projectId, parentTaskId: options.parentTaskId,
    dependsOn: options.dependsOn, handoff: options.handoff, originalPrompt: options.originalPrompt };
}
function validateDispatch(options: DispatchOptions): void {
  if (!options || typeof options.prompt !== 'string' || !options.prompt.trim()) throw new DispatchValidationError('Invalid dispatch prompt');
  if (options.timeout !== undefined && (typeof options.timeout !== 'number' || !Number.isFinite(options.timeout) || options.timeout <= 0)) throw new DispatchValidationError('Invalid dispatch timeout');
  for (const field of ['taskId', 'request_key', 'adapter', 'cwd', 'projectId', 'parentTaskId', 'ticket', 'label', 'mode', 'resumeSessionId'] as const) {
    if (options[field] !== undefined && (typeof options[field] !== 'string' || !options[field]!.trim())) throw new DispatchValidationError(`Invalid dispatch ${field}`);
  }
  for (const field of ['dependsOn', 'disallowedTools'] as const) {
    if (options[field] !== undefined && (!Array.isArray(options[field]) || options[field]!.some(value => typeof value !== 'string' || !value.trim()))) throw new DispatchValidationError(`Invalid dispatch ${field}`);
  }
  for (const id of [options.taskId, options.parentTaskId, ...(options.dependsOn ?? [])]) {
    if (id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new DispatchValidationError('Invalid dispatch task id');
  }
  if (options.originalPrompt !== undefined && typeof options.originalPrompt !== 'string') throw new DispatchValidationError('Invalid dispatch originalPrompt');
  if (options.handoff !== undefined && typeof options.handoff !== 'boolean') throw new DispatchValidationError('Invalid dispatch handoff');
}
export function createTaskEngine(settings: TaskEngineOptions) {
  const store = settings.store;
  const env = settings.env ?? process.env;
  const now = settings.now ?? Date.now;
  const lookupAdapter = settings.getAdapter ?? getAdapter;
  const settlementAdapter = (name: string): WorkerAdapter => {
    try { return lookupAdapter(name); } catch { return adapterForSettlement(name); }
  };
  const getTaskDir = (id: string) => store.dir(id);
  const ensureRunsDir = () => store.ensure();
  function settleTask(taskId: string, facts: {
    status: TaskStatus;
    adapter: WorkerAdapter;
    output?: string;
    exitCode?: number | null;
    signal?: string | null;
    unmetPreconditions?: readonly PreconditionUnmet[];
  }): RunRecord {
    const raw = {
      output: facts.output ?? '',
      exitCode: facts.exitCode ?? null,
      signal: facts.signal ?? null,
    };
    const translation = facts.output === undefined
      ? { producedOutput: false, finalText: { kind: 'empty' } as FinalText }
      : facts.adapter.translate?.(raw) ?? fallbackTranslation(raw);

    const record = settleRun({
      taskId,
      status: facts.status,
      exitCode: facts.exitCode ?? null,
      translation,
      unmetPreconditions: facts.unmetPreconditions ?? [],
    });
    const taskDir = getTaskDir(taskId);
    const meta = readTaskMeta(taskId);
    const located = locateRunTranscript(record, {
      ...meta,
      adapter: facts.adapter.name,
      status: facts.status,
    }, { adapter: facts.adapter });
    const toWrite = located.record ?? record;
    const sessionId = toWrite.resolution.sessionRef?.handle;
    writeRunRecord(taskDir, toWrite);

    // Best-effort model/provider for the kanban card (from model-io or raw output).
    const modelInfo = resolveModelInfo({
      transcriptPath: toWrite.transcriptPath,
      adapter: facts.adapter.name,
      output: facts.output,
    });
    const patch: Partial<TaskMeta> = {};
    if (modelInfo !== null) {
      if (modelInfo.modelId) patch.modelId = modelInfo.modelId;
      if (modelInfo.providerId) patch.providerId = modelInfo.providerId;
    }
    if (sessionId && !(readTaskMeta(taskId)?.sessionId)) {
      patch.sessionId = sessionId;
    }
    if (Object.keys(patch).length > 0) updateTaskMeta(taskId, patch);

    return toWrite;
  }

  /** Rebuild the record from disk alone — for runs whose dispatcher process is gone. */
  function materializeRunRecord(taskId: string): RunRecord | null {
    const meta = readTaskMeta(taskId);
    if (meta === null || meta.status === 'RUNNING') return null;
    const rawLogPath = join(getTaskDir(taskId), 'raw.log');
    const started = existsSync(rawLogPath);
    return settleTask(taskId, {
      status: meta.status,
      adapter: settlementAdapter(meta.adapter),
      ...started ? { output: extractProcessOutput(readFileSync(rawLogPath, 'utf8')) } : {},
      exitCode: meta.exitCode ?? null,
      unmetPreconditions: (meta.unmetPreconditions ?? []).map((name) => ({ name })),
    });
  }

  /**
   * The closing record of a task: the persisted one when it exists, otherwise
   * derived from `meta.json` + `raw.log` and persisted. The fallback exists
   * because a detached child outlives its dispatcher, so "settled at close" is not
   * guaranteed to have happened; the facts on disk are enough to settle late.
   * @param taskId - the task to read.
   * @returns the record, or `null` when the task is unknown or still running.
   */
  function readResolution(taskId: string): RunRecord | null {
    const existing = readRunRecord(getTaskDir(taskId));
    if (existing !== null) return existing;
    return materializeRunRecord(taskId);
  }

  /** Facts available when a process closes, fails to start, or is recovered. */


  /**
   * Publish a terminal task together with its closing record and report.
   * The first terminal status/end time wins; a late close may enrich exit facts.
   * Recovery preserves an existing record, while actual process output refreshes it.
   */
  function completeTask(taskId: string, completion: TaskCompletion): TaskMeta | null {
    if (!readTaskMeta(taskId)) return null;
    return withFileLock(join(getTaskDir(taskId), '.completion.lock'), () => publishCompletion(taskId, completion));
  }

  function publishCompletion(taskId: string, completion: TaskCompletion): TaskMeta | null {
    const current = readTaskMeta(taskId);
    if (current === null) return null;
    const status = current.status === 'RUNNING' ? completion.status : current.status;
    const endTime = current.endTime ?? now();
    // Persist the stop intent first: if settlement fails or this process exits,
    // readResolution can reconstruct the record without losing cancellation/TTL.
    const terminal = updateTaskMeta(taskId, {
      status,
      endTime,
      ...(completion.exitCode === undefined ? {} : { exitCode: completion.exitCode }),
      ...(completion.error === undefined ? {} : { error: completion.error }),
    });
    if (terminal === null) return null;
    const rawLogPath = join(getTaskDir(taskId), 'raw.log');
    if (completion.output !== undefined || readRunRecord(getTaskDir(taskId)) === null) {
      const output = completion.output ?? (existsSync(rawLogPath)
        ? extractProcessOutput(readFileSync(rawLogPath, 'utf8')) : undefined);
      settleTask(taskId, {
        status,
        adapter: settlementAdapter(current.adapter),
        output,
        exitCode: completion.exitCode !== undefined ? completion.exitCode : current.exitCode,
        signal: completion.signal,
        unmetPreconditions: (current.unmetPreconditions ?? []).map(name => ({ name })),
      });
    }

    // Settlement may have enriched model/session metadata. Return that version.
    const updated = readTaskMeta(taskId);
    if (updated !== null) {
      const note = status === 'KILLED' ? 'Terminated by request'
        : status === 'TIMEOUT_KILLED' ? 'Task exceeded execution TTL limit and was terminated by Watchdog'
        : completion.note ?? updated.error;
      generateReport(taskId, updated, note);
      const publicationPath = join(getTaskDir(taskId), 'completion.json');
      if (!existsSync(publicationPath)) {
        settings.onSettled?.(taskId);
        atomicWrite(publicationPath, JSON.stringify({ taskId, publishedAt: now() }));
      }
      store.appendEvent(taskId, 'completion', { status: updated.status });
    }
    return updated;
  }

  /**
   * Stop a running task and persist all closing artifacts before returning.
   * Missing tasks return null. Repeating a stop on a terminal task has no effects.
   */
  function terminateTask(taskId: string, cause: 'cancelled' | 'timeout'): TaskMeta | null {
    const meta = readTaskMeta(taskId);
    if (meta === null || meta.status !== 'RUNNING') return meta;
    let pid = meta.pid ?? recordedProcessPid(getTaskDir(taskId));
    if (!pid && meta.launchOwnerPid) {
      abandonUnclaimedLaunch(getTaskDir(taskId));
      pid = recordedProcessPid(getTaskDir(taskId));
    }
    if (pid) killTaskProcess(pid);
    return completeTask(taskId, {
      status: cause === 'timeout' ? 'TIMEOUT_KILLED' : 'KILLED',
    });
  }

  /**
   * Spawns a detached background subagent task redirecting stdio to raw.log.
   */


  function spawnDetachedTask(options: DispatchOptions): TaskMeta {
    validateDispatch(options);
    const normalized = { ...options, cwd: resolve(options.cwd ?? dirname(store.runsDir)), adapter: options.adapter === 'shell' ? 'bash' : options.adapter ?? 'zcode', mode: options.mode ?? 'edit', timeout: options.timeout ?? resolveDefaultTimeout(env) };
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    return store.withDispatchLock(() => {
      if (options.request_key) {
        const existing = store.request(options.request_key);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new RequestConflictError(options.request_key);
          const task = readTaskMeta(existing.taskId);
          if (!task) throw new DispatchRecoveryRequiredError(existing.taskId);
          return task;
        }
      }
      assertUnderConcurrentCap(env, store.runsDir);
      const taskId = options.taskId || `task-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const prepared = settings.prepareDispatch?.({ ...normalized, taskId }, options) ?? { ...normalized, taskId };
      validateDispatch(prepared);
      assertCwdAllowed(resolve(prepared.cwd!), resolveTaskRoots(env, dirname(store.runsDir)), { allowTmpDemoPrefix: !taskRootsEnvSet(env) });
      if (store.read(taskId) || existsSync(store.dir(taskId))) throw new TaskIdConflictError(taskId);
      // Reserve the directory before binding a request key: an existing task
      // must never be adopted by a failed new dispatch, including on retry.
      store.reserve(taskId);
      if (options.request_key) store.reserveRequest(options.request_key, fingerprint, taskId);
      return spawnTask({ ...prepared, taskId, request_key: options.request_key });
    });
  }

  function spawnTask(options: DispatchOptions): TaskMeta {
    const taskCwd = resolve(options.cwd || dirname(store.runsDir));
    // Platform cwd whitelist — refuse before any task dir / process is created.
    assertCwdAllowed(taskCwd, resolveTaskRoots(env, dirname(store.runsDir)), { allowTmpDemoPrefix: !taskRootsEnvSet(env) });
    ensureRunsDir();

    const taskId = options.taskId || `task-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const taskDir = getTaskDir(taskId);
    const rawLogPath = join(taskDir, 'raw.log');
    const adapterName = options.adapter || 'zcode';
    const timeout = options.timeout ?? resolveDefaultTimeout(env); // default 7200s or AGENT_HUB_DEFAULT_TIMEOUT

    /**
     * Record a dispatch that never started, as its own mechanical fact. A refused
     * precondition is not a task that ran and failed: nothing was spawned, so
     * there is no output, no pid, and no log to read.
     */
    const refuseToStart = (
      reason: string,
      unmet: readonly PreconditionUnmet[] = [],
    ): TaskMeta => {
      const meta: TaskMeta = {
        taskId, ...taskContext(options),
        ticket: options.ticket,
        label: options.label || options.prompt.slice(0, 50),
        prompt: options.prompt,
        status: 'FAILED',
        startTime: now(),
        endTime: now(),
        timeout,
        adapter: adapterName,
        cwd: taskCwd,
        error: reason,
        ...unmet.length === 0 ? {} : { unmetPreconditions: unmet.map(({ name }) => name) },
      };
      store.writeInitial(meta);
      return completeTask(taskId, {
        status: 'FAILED', note: `Not started: ${reason}`,
      })!;
    };

    let adapter: WorkerAdapter;
    try {
      adapter = lookupAdapter(adapterName);
    } catch (err) {
      if (err instanceof UnknownAdapterError) {
        return refuseToStart(err.message);
      }
      throw err;
    }

    // The adapter declares; the engine checks — every dispatch, never cached.
    // Only the engine holds the environment and workspace this dispatch will
    // actually run with.
    try {
      adapter.checkPreconditions?.();
    } catch (err: any) {
      if (err instanceof PreconditionUnmetError) {
        return refuseToStart(err.message, [{ name: err.precondition }]);
      }
      throw err;
    }

    const commandSpec = adapter.buildCommand({
      prompt: options.prompt,
      cwd: taskCwd,
      mode: options.mode,
      disallowedTools: options.disallowedTools,
      resumeSessionId: options.resumeSessionId,
      timeout,
    });

    const header = `=== Swarm Task ${taskId} [${options.ticket || 'NO-TICKET'}] ===\n`
      + `Adapter: ${adapterName} | Started: ${new Date().toISOString()}\n`
      + `Command: ${commandSpec.cmd} ${commandSpec.args.join(' ')}\n`
      + `Working Dir: ${taskCwd}\n`
      + `====================================================\n\n`;

    writeFileSync(rawLogPath, header, { flag: 'a' });

    // Reserve the slot before any process can start. A supervisor writes its own
    // identity before launching the Agent, closing the spawn→meta crash window.
    const meta: TaskMeta = {
      taskId, ...taskContext(options), ticket: options.ticket,
      label: options.label || options.prompt.slice(0, 50),
      prompt: options.prompt, status: 'RUNNING', startTime: now(), timeout,
      adapter: adapterName, cwd: taskCwd, launchOwnerPid: process.pid,
      ...(options.resumeSessionId ? { sessionId: options.resumeSessionId } : {}),
    };
    store.writeInitial(meta);
    let logFd: number | undefined;
    let child;
    try {
      logFd = openSync(rawLogPath, 'a');
      child = spawn(process.execPath, ['-e', PROCESS_LAUNCHER, taskDir, commandSpec.cmd, ...commandSpec.args], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: taskCwd,
        env: { ...env, ...Object.fromEntries(Object.entries(commandSpec.env ?? {}).filter(([key, value]) => value !== process.env[key])) },
      });
      if (child.pid) {
        meta.pid = child.pid;
        store.update(taskId, { pid: child.pid, launchOwnerPid: undefined });
      }
    } catch (err: any) {
      if (logFd !== undefined) closeSync(logFd);
      if (child?.pid) killTaskProcess(child.pid);
      return completeTask(taskId, { status: 'FAILED', output: '', error: err.message })!;
    }

    // Node emits close after error too. Close the descriptor exactly once.
    let logClosed = false;
    const closeLog = () => {
      if (logClosed) return;
      logClosed = true;
      closeSync(logFd);
    };

    child.on('close', (code, signal) => {
      closeLog();
      const actual = recordedProcessExit(taskDir) ?? { exitCode: code, signal };
      completeTask(taskId, {
        status: actual.exitCode === 0 ? 'COMPLETED' : 'FAILED',
        output: extractProcessOutput(readFileSync(rawLogPath, 'utf8')),
        ...actual,
      });
    });

    child.on('error', (err) => {
      closeLog();
      completeTask(taskId, {
        status: 'FAILED',
        output: extractProcessOutput(readFileSync(rawLogPath, 'utf8')),
        exitCode: null,
        error: err.message,
      });
    });

    // unref allows caller (and server/DSH) to exit or live independently
    child.unref();

    return meta;
  }

  const readTaskMeta = (id: string): TaskMeta | null => store.read(id);
  const updateTaskMeta = (id: string, patch: Partial<TaskMeta>): TaskMeta | null => store.update(id, patch);

  function generateReport(taskId: string, meta: TaskMeta, extraNote?: string): void {
    const reportPath = join(getTaskDir(taskId), 'report.md');
    const durationSec = meta.endTime ? Math.round((meta.endTime - meta.startTime) / 1000) : 0;

    let logSnippet = '';
    const rawLogPath = join(getTaskDir(taskId), 'raw.log');
    if (existsSync(rawLogPath)) {
      try {
        const content = readFileSync(rawLogPath, 'utf8');
        const lines = content.split('\n');
        logSnippet = lines.slice(-40).join('\n');
      } catch {}
    }

    const report = `# Task Execution Summary: ${meta.taskId}

  - **Ticket**: ${meta.ticket || 'N/A'}
  - **Label**: ${meta.label}
  - **Adapter**: \`${meta.adapter}\`
  - **Status**: **${meta.status}**
  - **Duration**: ${durationSec}s
  - **Exit Code**: ${meta.exitCode ?? 'N/A'}
  - **Working Dir**: \`${meta.cwd}\`
  - **Completed At**: ${new Date(meta.endTime || now()).toISOString()}

  ${extraNote ? `> ⚠️ **Note**: ${extraNote}\n` : ''}
  ${renderResolutionSection(readResolution(taskId))}
  ### Task Prompt
  \`\`\`
  ${meta.prompt}
  \`\`\`

  ### Output Log Tail
  \`\`\`
  ${logSnippet || '(No log output)'}
  \`\`\`
  `;

    atomicWrite(reportPath, report);
  }

  return { store, env, now, getAdapter: lookupAdapter, getTaskDir, ensureRunsDir, spawnDetachedTask, readTaskMeta, updateTaskMeta, settleTask, completeTask, terminateTask, readResolution, generateReport };
}
export type TaskEngine = ReturnType<typeof createTaskEngine>;
export const defaultEngine = createTaskEngine({ store: defaultTaskStore });
export const defaultTaskEngine = defaultEngine;
export const { spawnDetachedTask, readTaskMeta, updateTaskMeta, settleTask, completeTask, terminateTask, readResolution, generateReport } = defaultEngine;

/**
 * The closing record as a human-readable block. It deliberately states no
 * verdict (ADR-0002): it reports whether the run ended, why it stopped, what the
 * engine observed, and where the handles point.
 */
function renderResolutionSection(record: RunRecord | null): string {
  if (record === null) return '';
  const { resolution, observation } = record;
  const finalText = resolution.finalText.kind === 'text'
    ? `text (${resolution.finalText.value.length} chars)`
    : 'empty';
  return `### Closing Record (Resolution — not a verdict)

- **finalText**: ${finalText}
- **stopCause**: ${resolution.stopCause ?? '(ended normally)'}
- **producedOutput**: ${observation.producedOutput}
- **unmetPreconditions**: ${observation.unmetPreconditions.length === 0
    ? '(none)'
    : observation.unmetPreconditions.map(({ name }) => name).join(', ')}
- **sessionRef**: ${renderRef(resolution.sessionRef)}
- **transcriptRef**: ${renderRef(resolution.transcriptRef)}
- Record file: \`${RUN_RECORD_FILE}\`

`;
}

function renderRef(ref: SessionRef | TranscriptRef | undefined): string {
  return ref === undefined ? '(none)' : `\`${ref.provenance}:${ref.handle}\``;
}

/**
 * Cross-platform process termination (POSIX SIGKILL or Windows taskkill).
 */
export function killTaskProcess(pid: number): boolean {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`);
    } else {
      process.kill(-pid, 'SIGKILL'); // try kill process group
    }
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

export { ConcurrentCapError } from './concurrency.ts';
