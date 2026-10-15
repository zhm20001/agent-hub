/**
 * Engine-side settlement: turn one finished (or never-started) run into its
 * closing record, and keep the two kinds of fact apart while doing it.
 *
 *   `Resolution`     = 收尾记录（结束了没有 / 为什么停 / 把柄在哪）— ADR-0002, no verdict.
 *   `RunObservation` = 引擎观测（这台机器看到了什么）— `producedOutput`,
 *                      `unmetPreconditions`. The only thing that tells the two
 *                      `finalText.kind: 'empty'` cases apart.
 *
 * Both are persisted together as `<taskDir>/resolution.json`, next to the
 * `meta.json` / `raw.log` Face B already writes. Nothing here parses a CLI, and
 * nothing here decides whether the work was good — see
 * `docs/agent-hub/adapter-contract.md` §5.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterRawOutput,
  AdapterTranslation,
  PreconditionUnmet,
  Resolution,
  RunObservation,
} from '../adapters/contract.ts';
import type { TaskStatus } from './task-types.ts';
import { atomicWrite, withFileLock } from './file-storage.ts';

/** File name of the persisted {@link RunRecord} inside a task directory. */
export const RUN_RECORD_FILE = 'resolution.json';

/**
 * The two facts of one run, kept apart on purpose. `resolution` is what the
 * platform records; `observation` is what the platform saw.
 */
export interface RunRecord {
  readonly taskId: string;
  readonly resolution: Resolution;
  readonly observation: RunObservation;
  /**
   * Absolute on-disk conversation JSON/JSONL path when resolved at settle or
   * harvest time. Platform-owned (not an adapter verdict); omitted when unknown.
   * ADR-0002: still not a semantic success signal.
   */
  readonly transcriptPath?: string;
}

/**
 * Stop causes the **engine** produces. Free strings, deliberately not an enum —
 * tightening them is 01d's parking lot, and adapters may contribute their own.
 */
export const STOP_CAUSE = {
  /** The dispatch never started: a declared precondition was unmet. */
  preconditionUnmet: 'precondition-unmet',
  /** The platform stopped it (operator kill, or the runner's stop path). */
  cancelled: 'cancelled',
  /** The platform's time budget ran out. */
  timeout: 'timeout',
} as const;

/** Inputs the engine has after a process ended (or was refused). */
export interface SettlementInput {
  readonly taskId: string;
  /** Terminal task status, as the runner recorded it. */
  readonly status: TaskStatus;
  /** Translation produced by the adapter's `translate()`, or the engine fallback. */
  readonly translation: AdapterTranslation;
  /** Preconditions the engine found unmet before dispatch. Empty when it started. */
  readonly unmetPreconditions?: readonly PreconditionUnmet[];
  /** Process exit code, when there was a process. */
  readonly exitCode?: number | null;
}

/**
 * Build the closing record for one run.
 *
 * Precedence of `stopCause` follows who actually stopped the run: an unmet
 * precondition means nothing ever started; a kill or timeout is the platform's
 * own doing (contract §5); otherwise the adapter's report stands; and if it
 * reported none while producing no output, the engine records the mechanical
 * fallback rather than leaving the stop unexplained.
 * @param input - the engine's facts about the finished dispatch.
 * @returns the record to persist, unmodified by any verdict.
 */
export function settleRun(input: SettlementInput): RunRecord {
  const unmet = input.unmetPreconditions ?? [];
  const { translation } = input;

  let stopCause = translation.stopCause;
  if (unmet.length > 0) {
    stopCause = STOP_CAUSE.preconditionUnmet;
  } else if (input.status === 'KILLED') {
    stopCause = STOP_CAUSE.cancelled;
  } else if (input.status === 'TIMEOUT_KILLED') {
    stopCause = STOP_CAUSE.timeout;
  } else if (stopCause === undefined && !translation.producedOutput) {
    stopCause = input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0
      ? `process-exited-nonzero (exit=${input.exitCode})`
      : 'no-output';
  }

  const resolution: Resolution = {
    taskId: input.taskId,
    finalText: translation.finalText,
    ...stopCause === undefined ? {} : { stopCause },
    ...translation.usage === undefined ? {} : { usage: translation.usage },
    ...translation.sessionRef === undefined ? {} : { sessionRef: translation.sessionRef },
    ...translation.transcriptRef === undefined ? {} : { transcriptRef: translation.transcriptRef },
  };

  return {
    taskId: input.taskId,
    resolution,
    observation: {
      producedOutput: translation.producedOutput,
      unmetPreconditions: unmet.map(({ name }) => ({ name })),
    },
  };
}

/**
 * The engine's translation fallback for an adapter that declared no `translate`:
 * the whole output *is* the answer, and whitespace-only output counts as no
 * output (ADR-0001). Adapters whose output needs interpreting must translate it
 * themselves — this fallback never guesses.
 * @param raw - the finished process's combined output.
 * @returns a translation that invents nothing.
 */
export function fallbackTranslation(raw: AdapterRawOutput): AdapterTranslation {
  const hasContent = raw.output.replace(/\s+/g, '').length > 0;
  return {
    producedOutput: hasContent,
    finalText: hasContent ? { kind: 'text', value: raw.output } : { kind: 'empty' },
  };
}

/** Persist one record atomically inside the task directory. */
export function writeRunRecord(taskDir: string, record: RunRecord): void {
  const target = join(taskDir, RUN_RECORD_FILE);
  withFileLock(join(taskDir, '.record.lock'), () => {
    const existing = readRunRecord(taskDir);
    const merged: RunRecord = existing ? {
      ...existing, ...record,
      resolution: { ...existing.resolution, ...record.resolution },
    } : record;
    atomicWrite(target, `${JSON.stringify(merged, null, 2)}\n`);
  });
}

/** Read the persisted record, or `null` when this run has not been settled yet. */
export function readRunRecord(taskDir: string): RunRecord | null {
  const target = join(taskDir, RUN_RECORD_FILE);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as RunRecord;
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
