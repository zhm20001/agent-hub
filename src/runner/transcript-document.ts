import { readFileSync, statSync } from 'node:fs';
import { adapterForSettlement } from '../adapters/registry.ts';
import { parseKnownTranscript, parseMessageDocument } from '../adapters/transcript-format.ts';
import type { TranscriptDocument } from '../shared/transcript.ts';
export { lastAssistantText, summarizeDocument } from '../shared/transcript.ts';
export type { TranscriptDocument } from '../shared/transcript.ts';

export function parseTranscriptDocument(input: unknown, owner?: string): TranscriptDocument {
  if (!owner) return parseKnownTranscript(input);
  return adapterForSettlement(owner).parseTranscript?.(input) ?? parseMessageDocument(input);
}
const cache = new Map<string, { version: string; document: TranscriptDocument }>();
const MAX_CACHED_FILES = 32;
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
/** Cache only unchanged files, partitioned by adapter; large files are not retained. */
export function readTranscriptDocument(path: string, owner?: string): TranscriptDocument | null {
  const key = `${owner ?? 'legacy'}\0${path}`;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const previous = cache.get(key);
    if (previous?.version === version) { cache.delete(key); cache.set(key, previous); return previous.document; }
    const document = parseTranscriptDocument(readFileSync(path, 'utf8'), owner);
    cache.delete(key);
    if (stat.size <= MAX_CACHED_BYTES) cache.set(key, { version, document });
    while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
    return document;
  } catch { cache.delete(key); return null; }
}
