/**
 * Best-effort model/provider extraction for the board card (YAGNI).
 * Prefers on-disk model-io JSONL; falls back to scanning CLI result JSON in raw output.
 */

import { readTranscriptDocument } from './transcript-document.ts';
import { modelInfoFromOutput } from '../adapters/transcript-format.ts';

export interface ModelInfo {
  readonly modelId?: string;
  readonly providerId?: string;
}

export function extractModelInfoFromTranscriptFile(path: string, adapter?: string): ModelInfo | null {
  return readTranscriptDocument(path, adapter)?.modelInfo ?? null;
}
export const extractModelInfoFromOutput = modelInfoFromOutput;

/** Prefer transcript file; fall back to raw output scrape. */
export function resolveModelInfo(options: {
  readonly transcriptPath?: string | null;
  readonly output?: string | null;
  readonly adapter?: string;
}): ModelInfo | null {
  if (typeof options.transcriptPath === 'string' && options.transcriptPath.length > 0) {
    const fromFile = extractModelInfoFromTranscriptFile(options.transcriptPath, options.adapter);
    if (fromFile !== null) return fromFile;
  }
  if (typeof options.output === 'string' && options.output.length > 0) {
    return extractModelInfoFromOutput(options.output);
  }
  return null;
}

/** Short card label, e.g. `new-provider-2/step-5-preview`. */
export function formatModelLabel(info: ModelInfo | null | undefined): string | null {
  if (!info) return null;
  const { modelId, providerId } = info;
  if (modelId && providerId) return `${providerId}/${modelId}`;
  return modelId ?? providerId ?? null;
}
