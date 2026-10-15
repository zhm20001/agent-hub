/** Adapter-neutral transcript lookup and record enrichment. No persistence here. */
import { statSync } from 'node:fs';
import type { WorkerAdapter, TranscriptLookup, LocatedTranscript } from '../adapters/base.ts';
import { adapterForSettlement } from '../adapters/registry.ts';
import type { RunRecord } from './settlement.ts';

interface TranscriptTaskHints {
  readonly adapter?: string;
  readonly sessionId?: string;
  readonly status?: string;
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface LocatedRunTranscript {
  readonly record: RunRecord | null;
  readonly transcriptPath: string | null;
  readonly sessionId: string | null;
  readonly via: string | null;
}

function isFile(path: string | undefined): boolean {
  if (!path) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Validate both sides of the adapter seam; lookup failure is best effort. */
function locateTranscript(adapter: WorkerAdapter, input: TranscriptLookup): LocatedTranscript | null {
  if ([input.transcriptRef, input.sessionRef].some(ref => ref && ref.provenance !== adapter.name)) return null;
  try {
    const found = adapter.locateTranscript?.(input);
    if (!found || found.transcriptRef.provenance !== adapter.name
        || (found.sessionRef && found.sessionRef.provenance !== adapter.name)
        || !isFile(found.path)) return null;
    return found;
  } catch {
    // Missing/unreadable storage must not prevent settlement or board reads.
    return null;
  }
}

/**
 * Enrich an immutable record using only its owning adapter. Existing paths are
 * reusable; missing or foreign refs never authorize a scan of another adapter.
 * Callers decide when/how to persist the returned record.
 */
export function locateRunTranscript(
  record: RunRecord | null,
  hints: TranscriptTaskHints,
  options: { readonly home?: string; readonly adapter?: WorkerAdapter } = {},
): LocatedRunTranscript {
  const absent: LocatedRunTranscript = { record, transcriptPath: null, sessionId: null, via: null };
  const transcriptRef = record?.resolution.transcriptRef;
  const sessionRef = record?.resolution.sessionRef;
  const owner = hints.adapter ?? transcriptRef?.provenance ?? sessionRef?.provenance;
  const adapter = options.adapter ?? (owner ? adapterForSettlement(owner) : undefined);
  if (adapter && [transcriptRef, sessionRef].some(ref => ref && ref.provenance !== adapter.name)) {
    return absent;
  }
  if (isFile(record?.transcriptPath)) {
    return {
      record, transcriptPath: record!.transcriptPath!, via: 'existing',
      sessionId: sessionRef?.handle ?? hints.sessionId ?? null,
    };
  }
  if (!adapter?.locateTranscript) return absent;
  const interrupted = hints.status === 'KILLED' || hints.status === 'TIMEOUT_KILLED'
    || record?.resolution.stopCause === 'cancelled' || record?.resolution.stopCause === 'timeout';
  const found = locateTranscript(adapter, {
    transcriptRef, sessionRef, sessionId: hints.sessionId, home: options.home,
    ...(interrupted ? { interrupted: { startTimeMs: hints.startTime, endTimeMs: hints.endTime } } : {}),
  });
  if (found === null) return absent;
  const next = record === null ? null : {
    ...record,
    transcriptPath: found.path,
    resolution: {
      ...record.resolution,
      transcriptRef: transcriptRef ?? found.transcriptRef,
      ...(sessionRef || found.sessionRef ? { sessionRef: sessionRef ?? found.sessionRef } : {}),
    },
  };
  return {
    record: next, transcriptPath: found.path,
    sessionId: sessionRef?.handle ?? found.sessionRef?.handle ?? null, via: found.via,
  };
}
