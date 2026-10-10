/**
 * The subset of the Agent Hub adapter contract that Face B actually implements
 * today. The full contract is `docs/agent-hub/adapter-contract.md`; this module
 * carries only the members a production path needed once ticket 11c closed the
 * loop (dispatch → 收尾记录 → 原文指针), so the names here are the contract's
 * names and the shapes are the contract's shapes.
 *
 * Deliberately *not* here, and not pretended to be: `AdapterContractV1`,
 * `capabilities`, `available()`, `DispatchSpec` / `RunHandle` /
 * `NormalizedEventStream` / `dispatch()`, the permission dimension mapping, and
 * the event vocabulary. See `base.ts` for the still-argv-shaped seam.
 *
 * Contract disciplines reproduced here, because they are the point of the type
 * names (ADR-0002: 平台不判定活成没成):
 *   - `Resolution` is a **收尾记录**, not a verdict: 结束了没有 / 为什么停 / 把柄在哪。
 *   - `RunObservation` is the **engine's** observation, a different kind of fact
 *     from the closing record; the two must not be folded into one field.
 *   - `transcriptRef` promises **可定位**, never 能渲染: no parsing, no copying.
 *
 * @module
 */

/** Session ref: the handle a later dispatch resumes with. Opaque to the platform. */
export interface SessionRef {
  /** `Adapter.name` that produced it; a ref may not be replayed across adapters. */
  readonly provenance: string;
  /** Opaque handle. The platform never parses it, never assumes it is a path. */
  readonly handle: string;
}

/**
 * Transcript ref: where *this run's* original conversation lives, for a human or
 * an upstream AI to open. Parallel to {@link SessionRef} but a different
 * question ("原文在哪" vs "怎么接着聊"); the platform does not parse it, does
 * not copy its body, and does not promise to render it. `undefined` = 这次没得看,
 * which is not a run failure.
 */
export interface TranscriptRef {
  /** `Adapter.name` that produced it. */
  readonly provenance: string;
  /** Opaque handle. */
  readonly handle: string;
}

/** Best-effort accounting. `bash` reports none, so it is never required. */
export interface AdapterUsage {
  readonly tokens?: {
    readonly total: number;
    /** `exact` only when the agent really reported it. */
    readonly completeness: 'exact' | 'estimated';
  };
  readonly cost?: { readonly amount: number; readonly currency: string };
}

/**
 * The final message slot. Both an empty-but-produced body and "nothing was ever
 * produced" land on `kind: 'empty'` — the two are told apart by
 * {@link RunObservation.producedOutput}, not here (contract §5, ADR-0001).
 */
export type FinalText =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'empty' };

/**
 * 收尾记录. Must be the last (and exactly one) entry of a run's event sequence.
 * It answers only: this run ended / why it stopped / where the handles are.
 * It carries **no verdict** — see ADR-0002.
 */
export interface Resolution {
  readonly taskId: string;
  readonly finalText: FinalText;
  /**
   * Why the run no longer runs. Free string in v0, deliberately not an enum
   * (that is 01d's parking lot). Platform-initiated stops (timeout, cancel) and
   * mechanical facts (no output, unmet precondition) are the producers.
   */
  readonly stopCause?: string;
  readonly usage?: AdapterUsage;
  readonly sessionRef?: SessionRef;
  readonly transcriptRef?: TranscriptRef;
}

/** One declared precondition the engine observed as unmet for this dispatch. */
export interface PreconditionUnmet {
  /** The neutral `PreconditionRequirement.name`, echoed verbatim. */
  readonly name: string;
}

/**
 * What the engine directly observed about this run. A different kind of fact
 * from {@link Resolution}: `${producedOutput}` is the only thing that tells the
 * two `finalText.kind: 'empty'` cases apart.
 */
export interface RunObservation {
  /** Whether the run produced any interpretable raw content. Whitespace counts as none. */
  readonly producedOutput: boolean;
  /** Only the unmet ones. Empty when the dispatch started with everything it needed. */
  readonly unmetPreconditions: readonly PreconditionUnmet[];
}

/**
 * Raw output of one finished process, as handed to the adapter for translation.
 * The engine owns the process and the log; it strips its own log header here so
 * no adapter has to know that Face B writes one.
 */
export interface AdapterRawOutput {
  /** Everything the process itself wrote (stdout and stderr, combined). */
  readonly output: string;
  /** Process exit code, or `null` when it was signalled instead of exiting. */
  readonly exitCode: number | null;
  /** Terminating signal, when the process was killed rather than exited. */
  readonly signal: string | null;
}

/**
 * An adapter's translation of {@link AdapterRawOutput}. Pure: same input, same
 * output, no disk, no state — translation is the adapter's whole job here.
 *
 * `producedOutput` is the adapter's answer because in Face B the engine holds
 * only the *combined* stream: separating "the CLI reported a result" from "the
 * process merely printed to stderr" is a CLI-dialect judgement, which belongs on
 * this side of the seam. (Gap recorded in the 11c ticket: a later ticket that
 * gives the engine separated streams moves this observation back to the engine.)
 */
export interface AdapterTranslation {
  /** See {@link RunObservation.producedOutput}. */
  readonly producedOutput: boolean;
  readonly finalText: FinalText;
  /** Adapter-reported stop cause; the engine may override it (cancel / timeout / precondition). */
  readonly stopCause?: string;
  readonly sessionRef?: SessionRef;
  readonly transcriptRef?: TranscriptRef;
  readonly usage?: AdapterUsage;
}
