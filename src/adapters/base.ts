/**
 * WorkerAdapter interface for Agent Hub.
 * Allows pluggable subagent execution backends (ZCode CLI, Shell/Bash, Codex, etc.).
 *
 * Shape note: the full Agent Hub adapter contract (capabilities, permissions,
 * normalized events, `RunHandle`) is defined in
 * `docs/agent-hub/adapter-contract.md` and is *not* implemented here yet — this
 * seam still exposes argv assembly. Three contract members are implemented,
 * because a production dispatch path depended on them: `preconditions`
 * (ticket 11a) and `translate` / the settlement types (ticket 11c, see
 * `contract.ts`).
 */

import type { AdapterRawOutput, AdapterTranslation, SessionRef, TranscriptRef } from './contract.ts';

/** Disk-only lookup. Refs and session handles belong exclusively to this adapter. */
export interface TranscriptLookup {
  readonly transcriptRef?: TranscriptRef;
  readonly sessionRef?: SessionRef;
  readonly sessionId?: string;
  /** Supplied only for interrupted runs; an adapter may use it when no handle exists. */
  readonly interrupted?: { readonly startTimeMs?: number; readonly endTimeMs?: number };
  readonly home?: string;
}

export interface LocatedTranscript {
  readonly path: string;
  readonly transcriptRef: TranscriptRef;
  readonly sessionRef?: SessionRef;
  readonly via: string;
}

export interface AdapterCommandSpec {
  prompt: string;
  cwd: string;
  mode?: 'build' | 'edit' | 'plan' | 'yolo' | string;
  disallowedTools?: string[];
  resumeSessionId?: string;
  timeout?: number;
}

export interface AdapterCommandResult {
  cmd: string;
  args: string[];
  /** Full child environment, or `undefined` to inherit the parent's. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Layer of the child environment this adapter contributes on top of the parent
 * environment. Distinct from {@link AdapterCommandResult.env}: a delta is
 * merged into the inherited environment, never replaced wholesale.
 */
export interface AdapterEnvDelta {
  readonly key: string;
  readonly value: string;
}

export interface WorkerAdapter {
  readonly name: string;
  readonly description: string;
  buildCommand(spec: AdapterCommandSpec): AdapterCommandResult;

  /**
   * Static declaration of the conditions a dispatch must satisfy before the
   * process may start. Answering "this time" is `checkPreconditions()`, not the
   * adapter's constructor: the environment and the filesystem can change
   * between registration and dispatch.
   */
  readonly preconditions?: readonly string[];

  /**
   * Environment entries this adapter contributes on top of the inherited
   * environment. The engine merges them; the adapter does not replace the whole
   * environment, and reading them must not depend on the preconditions holding
   * (that would hide the unmet declaration behind a missing value).
   */
  adapterEnv?(): readonly AdapterEnvDelta[];

  /**
   * Re-check the declared preconditions *now*. Called by the engine before
   * every dispatch, never cached, because the facts behind them are
   * dispatch-time facts.
   * @throws {PreconditionUnmetError} naming the unmet precondition and why.
   */
  checkPreconditions?(): void;

  /**
   * Translate this run's raw output into the neutral closing pieces (final
   * text, refs, usage, adapter-reported stop cause). Pure: no disk, no state,
   * same input → same output. The engine owns the process and the log and calls
   * this once the process has ended.
   *
   * Omitted = the engine's fallback: the whole output is the final text, and
   * "no visible output" is the only empty case (true for an adapter whose
   * output *is* its answer).
   */
  translate?(raw: AdapterRawOutput): AdapterTranslation;

  /**
   * Locate an existing transcript without launching a CLI or writing state.
   * Return null when unavailable. Never substitute another session for a known
   * handle. Omitted means this adapter does not support on-disk discovery.
   */
  locateTranscript?(input: TranscriptLookup): LocatedTranscript | null;
}
