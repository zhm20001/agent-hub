/**
 * Best-effort model/provider extraction for the board card (YAGNI).
 * Prefers on-disk model-io JSONL; falls back to scanning CLI result JSON in raw output.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface ModelInfo {
  readonly modelId?: string;
  readonly providerId?: string;
}

function fromModelObject(model: unknown): ModelInfo | null {
  if (typeof model !== 'object' || model === null) return null;
  const m = model as Record<string, unknown>;
  const modelId = typeof m['modelId'] === 'string' && m['modelId'].length > 0 ? m['modelId'] : undefined;
  const providerId = typeof m['providerId'] === 'string' && m['providerId'].length > 0
    ? m['providerId']
    : undefined;
  if (modelId === undefined && providerId === undefined) return null;
  return { ...modelId === undefined ? {} : { modelId }, ...providerId === undefined ? {} : { providerId } };
}

/** Read model/provider from a model-io / transcript JSONL file (last non-empty model wins). */
export function extractModelInfoFromTranscriptFile(path: string): ModelInfo | null {
  if (!existsSync(path)) return null;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let last: ModelInfo | null = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const info = fromModelObject(obj['model']);
      if (info !== null) last = info;
      // Also accept top-level modelId/providerId on rare shapes
      if (info === null) {
        const modelId = typeof obj['modelId'] === 'string' ? obj['modelId'] : undefined;
        const providerId = typeof obj['providerId'] === 'string' ? obj['providerId'] : undefined;
        if (modelId || providerId) {
          last = {
            ...modelId ? { modelId } : {},
            ...providerId ? { providerId } : {},
          };
        }
      }
    } catch {
      // skip bad lines
    }
  }
  return last;
}

/**
 * Scan CLI combined output for a result object that names model/provider.
 * Most measured ZCode results omit these; model-io is the reliable source.
 */
export function extractModelInfoFromOutput(output: string): ModelInfo | null {
  // Cheap scan: look for "modelId"/"providerId" string pairs in JSON-ish text.
  const modelIdMatch = output.match(/"modelId"\s*:\s*"([^"]+)"/);
  const providerIdMatch = output.match(/"providerId"\s*:\s*"([^"]+)"/);
  if (!modelIdMatch && !providerIdMatch) return null;
  return {
    ...modelIdMatch ? { modelId: modelIdMatch[1] } : {},
    ...providerIdMatch ? { providerId: providerIdMatch[1] } : {},
  };
}

/** Prefer transcript file; fall back to raw output scrape. */
export function resolveModelInfo(options: {
  readonly transcriptPath?: string | null;
  readonly output?: string | null;
}): ModelInfo | null {
  if (typeof options.transcriptPath === 'string' && options.transcriptPath.length > 0) {
    const fromFile = extractModelInfoFromTranscriptFile(options.transcriptPath);
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
