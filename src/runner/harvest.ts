/**
 * Mechanical harvest for the board Report view (ADR-0002).
 *
 * This is NOT a semantic verdict. It only surfaces:
 *   - the dispatched task's conversation **last turn** (executing agent's final
 *     reply text), length-capped for the UI;
 *   - an absolute path to a full conversation JSON/JSONL on disk when one is
 *     already known — never by calling the live CLI / spending tokens.
 *
 * Source preference for last-turn text:
 *   1. On-disk transcript JSON/JSONL (extract true last assistant message)
 *   2. `closingRecord.resolution.finalText` (adapter-settled final reply)
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalText } from '../adapters/contract.ts';
import { writeRunRecord, type RunRecord } from './settlement.ts';
import { getTaskDir, readTaskMeta } from './detached.ts';
import { locateRunTranscript, type LocatedRunTranscript } from './transcript.ts';

/** Env var: override last-turn display cap (default {@link DEFAULT_LAST_TURN_CAP}). */
export const LAST_TURN_CAP_ENV = 'AGENT_HUB_LAST_TURN_CAP';

/** Default UI display cap for last-turn text when env is unset. Documented in DEMO.md. */
export const DEFAULT_LAST_TURN_CAP = 8000;

/**
 * Resolve last-turn display cap from env (or default).
 * Invalid / non-positive values fall back to {@link DEFAULT_LAST_TURN_CAP}.
 */
export function resolveLastTurnCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LAST_TURN_CAP_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_LAST_TURN_CAP;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_LAST_TURN_CAP;
  return n;
}

/** UI display cap for last-turn text (env {@link LAST_TURN_CAP_ENV} or {@link DEFAULT_LAST_TURN_CAP}). */
export const LAST_TURN_CAP = resolveLastTurnCap();

/** Where the last-turn text was taken from (mechanical, for the board label). */
export type LastTurnSource = 'transcript' | 'finalText';

export interface LastTurn {
  /** Display text (already truncated when {@link truncated} is true). */
  readonly text: string;
  readonly truncated: boolean;
  /** Length of the untruncated source string. */
  readonly fullLength: number;
  readonly source: LastTurnSource;
  /** Cap used for this projection (= {@link LAST_TURN_CAP} unless overridden). */
  readonly cap: number;
  /**
   * Full untruncated markdown/source text for copy. Always present when harvest
   * found text; equals {@link text} when not truncated.
   */
  readonly fullText: string;
}

/** Board-facing harvest projection for one task. */
export interface HarvestView {
  readonly lastTurn: LastTurn | null;
  /**
   * Absolute path of a full conversation JSON/JSONL on disk, when resolved
   * without calling the live CLI. `null` when only a transcriptRef handle is
   * known (open via `npm run transcript` / readback instead).
   */
  readonly transcriptPath: string | null;
}

export interface TruncateResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly fullLength: number;
  readonly cap: number;
}

/**
 * Truncate `text` to `cap` characters, appending an ellipsis when cut.
 * @param text - full source string.
 * @param cap - max display length (default {@link LAST_TURN_CAP}).
 */
export function truncateText(text: string, cap: number = LAST_TURN_CAP): TruncateResult {
  const fullLength = text.length;
  if (fullLength <= cap) {
    return { text, truncated: false, fullLength, cap };
  }
  return {
    text: `${text.slice(0, Math.max(0, cap - 1))}…`,
    truncated: true,
    fullLength,
    cap,
  };
}

/**
 * Extract the last assistant / agent reply text from a transcript document.
 *
 * Accepts:
 *   - an array of readback-style messages (`role` + `parts[].text`);
 *   - a single JSON object (model-io line, or `{ messages: [...] }`);
 *   - a JSONL string (zcode `transcript.jsonl` / `model-io-*.jsonl`).
 *
 * Returns `null` when nothing recognizable is found — caller falls back to
 * `finalText`. Never invents content.
 */
export function extractLastAssistantMessage(input: unknown): string | null {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    // JSONL: try line-by-line first (transcript.jsonl / model-io).
    if (trimmed.includes('\n') || looksLikeJsonl(trimmed)) {
      const fromJsonl = extractFromJsonl(trimmed);
      if (fromJsonl !== null) return fromJsonl;
    }
    try {
      return extractLastAssistantMessage(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (Array.isArray(input)) {
    return extractFromMessages(input);
  }

  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;

  // model-io line: { response: { text: "..." } }
  const response = obj['response'];
  if (typeof response === 'string' && response.length > 0) return response;
  if (typeof response === 'object' && response !== null) {
    const text = (response as Record<string, unknown>)['text'];
    if (typeof text === 'string' && text.length > 0) return text;
  }

  if (Array.isArray(obj['messages'])) {
    return extractFromMessages(obj['messages'] as readonly unknown[]);
  }

  // turn_complete / model_complete style single event
  const payload = obj['payload'];
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    if (typeof p['response'] === 'string' && p['response'].length > 0) return p['response'];
    if (typeof p['content'] === 'string' && p['content'].length > 0) return p['content'];
  }

  return null;
}

function looksLikeJsonl(text: string): boolean {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  return first.startsWith('{') && first.endsWith('}');
}

function extractFromJsonl(text: string): string | null {
  let lastTurnComplete: string | null = null;
  let lastModelComplete: string | null = null;
  let lastResponseText: string | null = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj['type'];
    const payload = obj['payload'];
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      if (type === 'turn_complete' && typeof p['response'] === 'string' && p['response'].length > 0) {
        lastTurnComplete = p['response'];
      }
      if (type === 'model_complete' && typeof p['content'] === 'string' && p['content'].length > 0) {
        // Prefer a final stop over mid-turn tool-call completes.
        if (p['stopReason'] !== 'tool-calls') lastModelComplete = p['content'];
      }
    }

    const response = obj['response'];
    if (typeof response === 'object' && response !== null) {
      const textValue = (response as Record<string, unknown>)['text'];
      if (typeof textValue === 'string' && textValue.length > 0) lastResponseText = textValue;
    } else if (typeof response === 'string' && response.length > 0) {
      lastResponseText = response;
    }
  }

  return lastTurnComplete ?? lastModelComplete ?? lastResponseText;
}

/**
 * Last assistant message from a readback-style `messages` array
 * (`role` / `parts[{type:'text', text}]`). Also accepts `role: 'agent'`.
 */
function messageRole(message: Record<string, unknown>): string | undefined {
  if (typeof message['role'] === 'string') return message['role'];
  const info = message['info'];
  if (typeof info === 'object' && info !== null) {
    const role = (info as Record<string, unknown>)['role'];
    if (typeof role === 'string') return role;
  }
  return undefined;
}

function extractFromMessages(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (typeof message !== 'object' || message === null) continue;
    const obj = message as Record<string, unknown>;
    const role = messageRole(obj);
    // Only assistant/agent turns — never harvest the user prompt as "last turn".
    if (role !== 'assistant' && role !== 'agent') continue;

    const parts = obj['parts'];
    if (Array.isArray(parts)) {
      const chunks: string[] = [];
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const { type, text: partText } = part as { type?: unknown; text?: unknown };
        if (type === 'text' && typeof partText === 'string' && partText.length > 0) {
          chunks.push(partText);
        }
      }
      if (chunks.length > 0) return chunks.join('\n\n');
    }

    if (typeof obj['text'] === 'string' && obj['text'].length > 0) return obj['text'];
    if (typeof obj['content'] === 'string' && obj['content'].length > 0) return obj['content'];
  }
  return null;
}

function textFromFinalText(finalText: FinalText | undefined): string | null {
  if (finalText === undefined) return null;
  if (finalText.kind !== 'text') return null;
  return finalText.value.length > 0 ? finalText.value : null;
}

/** Locate through the task's adapter and persist any newly discovered refs/path. */
export function repairTaskTranscript(
  taskId: string,
  record: RunRecord | null,
  options: { readonly home?: string } = {},
): LocatedRunTranscript {
  const located = locateRunTranscript(record, readTaskMeta(taskId) ?? {}, options);
  if (located.record !== null && located.record !== record) {
    try {
      writeRunRecord(getTaskDir(taskId), located.record);
    } catch {
      // Best effort: presentation still uses the located path.
    }
  }
  return located;
}

/**
 * Build the board harvest projection for one settled (or still-running) task.
 * Pure wrt the live CLI: only reads disk + the already-persisted RunRecord.
 */
export function harvestTask(
  taskId: string,
  record: RunRecord | null,
  options: { readonly home?: string; readonly cap?: number } = {},
): HarvestView {
  const cap = options.cap ?? resolveLastTurnCap();
  const { record: working, transcriptPath } = repairTaskTranscript(taskId, record, options);

  let rawText: string | null = null;
  let source: LastTurnSource = 'finalText';

  if (transcriptPath !== null) {
    try {
      const body = readFileSync(transcriptPath, 'utf8');
      const extracted = extractLastAssistantMessage(body);
      if (extracted !== null && extracted.length > 0) {
        rawText = extracted;
        source = 'transcript';
      }
    } catch {
      // fall through to finalText
    }
  }

  if (rawText === null) {
    rawText = textFromFinalText(working?.resolution.finalText);
    source = 'finalText';
  }

  // Also try reading resolution.json path as a weak fallback marker for "open JSON"
  // when no conversation file exists — only expose real transcript paths above.
  if (rawText === null) {
    return { lastTurn: null, transcriptPath };
  }

  const truncated = truncateText(rawText, cap);
  return {
    lastTurn: {
      text: truncated.text,
      truncated: truncated.truncated,
      fullLength: truncated.fullLength,
      source,
      cap: truncated.cap,
      fullText: rawText,
    },
    transcriptPath,
  };
}

/**
 * Absolute path of the task's `resolution.json` when present — useful as a
 * secondary "open JSON" target for demos when no conversation transcript is on
 * disk yet. Not a conversation; callers should label it accordingly.
 */
export function resolutionJsonPath(taskId: string): string | null {
  const path = join(getTaskDir(taskId), 'resolution.json');
  return existsSync(path) ? path : null;
}
