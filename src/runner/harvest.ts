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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FinalText, TranscriptRef } from '../adapters/contract.ts';
import { writeRunRecord, type RunRecord } from './settlement.ts';
import { getTaskDir } from './detached.ts';

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

/**
 * Resolve an on-disk conversation JSON/JSONL path from a transcriptRef, without
 * calling the live CLI. Returns `null` when nothing is on disk yet.
 */
export function resolveTranscriptPath(
  ref: TranscriptRef | undefined,
  options: { readonly home?: string } = {},
): string | null {
  if (ref === undefined) return null;
  if (ref.provenance !== 'zcode') return null;

  const home = options.home ?? homedir();
  const handle = ref.handle;
  if (typeof handle !== 'string' || handle.length === 0) return null;

  const candidates: string[] = [
    join(home, '.zcode', 'cli', 'rollout', `model-io-${handle}.jsonl`),
    join(home, '.zcode', 'cli', 'agents', handle, 'transcript.jsonl'),
  ];

  for (const path of candidates) {
    if (existsSync(path) && statSync(path).isFile()) return path;
  }

  // Nested agent dirs: ~/.zcode/cli/agents/<parent>/agent_*/transcript.jsonl
  // where metadata.childSessionId === handle, or the parent dir is the handle.
  const agentsRoot = join(home, '.zcode', 'cli', 'agents');
  if (!existsSync(agentsRoot)) return null;

  const direct = join(agentsRoot, handle);
  const nested = findTranscriptUnder(direct);
  if (nested !== null) return nested;

  // Scan a shallow set of sess_* dirs for metadata.childSessionId match.
  try {
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('sess_')) continue;
      const sessDir = join(agentsRoot, entry.name);
      for (const child of readdirSync(sessDir, { withFileTypes: true })) {
        if (!child.isDirectory() || !child.name.startsWith('agent_')) continue;
        const agentDir = join(sessDir, child.name);
        const metaPath = join(agentDir, 'metadata.json');
        if (!existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { childSessionId?: unknown };
          if (meta.childSessionId === handle) {
            const transcript = join(agentDir, 'transcript.jsonl');
            if (existsSync(transcript)) return transcript;
          }
        } catch {
          // ignore unreadable metadata
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function findTranscriptUnder(dir: string): string | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const direct = join(dir, 'transcript.jsonl');
  if (existsSync(direct)) return direct;
  try {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = join(dir, child.name, 'transcript.jsonl');
      if (existsSync(nested)) return nested;
    }
  } catch {
    return null;
  }
  return null;
}

function textFromFinalText(finalText: FinalText | undefined): string | null {
  if (finalText === undefined) return null;
  if (finalText.kind !== 'text') return null;
  return finalText.value.length > 0 ? finalText.value : null;
}

/** Filename pattern: model-io-sess_<uuid>.jsonl → sess_<uuid> */
const ROLLOUT_FILE_RE = /^model-io-(sess_[A-Za-z0-9_-]+)\.jsonl$/;

/** Default slack around task window when matching rollout mtime (45 minutes). */
export const ROLLOUT_PROXIMITY_SLACK_MS = 45 * 60 * 1000;

export interface DiscoverRolloutOptions {
  readonly home?: string;
  /** Explicit session id (meta.sessionId or transcriptRef.handle). */
  readonly sessionId?: string | null;
  /** Task start epoch-ms (meta.startTime). */
  readonly startTimeMs?: number | null;
  /** Task end epoch-ms (meta.endTime); falls back to start + timeout when absent. */
  readonly endTimeMs?: number | null;
  /** How far outside [start, end] mtime may fall (default {@link ROLLOUT_PROXIMITY_SLACK_MS}). */
  readonly slackMs?: number;
}

export interface DiscoveredRollout {
  readonly path: string;
  readonly sessionId: string;
  /** How the path was chosen. */
  readonly via: 'sessionId' | 'time-proximity';
}

/**
 * Discover an on-disk model-io JSONL when transcriptRef is missing (common for
 * TIMEOUT_KILLED: the CLI never printed a result object with sessionId).
 *
 * Preference:
 *   1. `sessionId` → same paths as {@link resolveTranscriptPath}
 *   2. Scan `~/.zcode/cli/rollout/model-io-sess_*.jsonl` whose mtime falls near
 *      the task window; pick the closest to endTime (then startTime).
 */
export function discoverRolloutTranscript(
  options: DiscoverRolloutOptions = {},
): DiscoveredRollout | null {
  const home = options.home ?? homedir();
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0
    ? options.sessionId
    : undefined;

  if (sessionId !== undefined) {
    const path = resolveTranscriptPath({ provenance: 'zcode', handle: sessionId }, { home });
    if (path !== null) return { path, sessionId, via: 'sessionId' };
  }

  const start = typeof options.startTimeMs === 'number' && Number.isFinite(options.startTimeMs)
    ? options.startTimeMs
    : null;
  const end = typeof options.endTimeMs === 'number' && Number.isFinite(options.endTimeMs)
    ? options.endTimeMs
    : start;
  if (start === null || end === null) return null;

  const slack = options.slackMs ?? ROLLOUT_PROXIMITY_SLACK_MS;
  const windowLo = start - slack;
  const windowHi = end + slack;
  const rolloutDir = join(home, '.zcode', 'cli', 'rollout');
  if (!existsSync(rolloutDir)) return null;

  type Cand = { path: string; sessionId: string; mtimeMs: number; dist: number };
  const cands: Cand[] = [];
  try {
    for (const name of readdirSync(rolloutDir)) {
      const match = ROLLOUT_FILE_RE.exec(name);
      if (match === null) continue;
      const full = join(rolloutDir, name);
      let mtimeMs: number;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < windowLo || mtimeMs > windowHi) continue;
      // Prefer files whose mtime is closest to the task end (kill often lands near last write).
      const dist = Math.abs(mtimeMs - end);
      cands.push({ path: full, sessionId: match[1], mtimeMs, dist });
    }
  } catch {
    return null;
  }

  if (cands.length === 0) return null;
  cands.sort((a, b) => a.dist - b.dist || b.mtimeMs - a.mtimeMs);
  const best = cands[0];
  return { path: best.path, sessionId: best.sessionId, via: 'time-proximity' };
}

/** Best-effort read of meta.json fields used for rollout discovery / repair. */
function readMetaHints(taskId: string): {
  startTime?: number;
  endTime?: number;
  sessionId?: string;
  status?: string;
} {
  const metaPath = join(getTaskDir(taskId), 'meta.json');
  if (!existsSync(metaPath)) return {};
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    const out: { startTime?: number; endTime?: number; sessionId?: string; status?: string } = {};
    if (typeof meta['startTime'] === 'number') out.startTime = meta['startTime'];
    if (typeof meta['endTime'] === 'number') out.endTime = meta['endTime'];
    if (typeof meta['sessionId'] === 'string' && meta['sessionId'].length > 0) {
      out.sessionId = meta['sessionId'];
    }
    if (typeof meta['status'] === 'string') out.status = meta['status'];
    return out;
  } catch {
    return {};
  }
}

/**
 * Repair TIMEOUT (or any settled) tasks that lack transcriptRef / transcriptPath:
 * discover rollout JSONL, persist path + refs on the run record, and return the path.
 * Does not invent turns — only links an existing on-disk file.
 */
export function repairTimeoutTranscript(
  taskId: string,
  record: RunRecord | null,
  options: { readonly home?: string } = {},
): { record: RunRecord | null; transcriptPath: string | null; sessionId: string | null; via: string | null } {
  const home = options.home ?? homedir();
  const hints = readMetaHints(taskId);
  const existingPath = typeof record?.transcriptPath === 'string' && record.transcriptPath.length > 0
    && existsSync(record.transcriptPath)
    ? record.transcriptPath
    : null;
  if (existingPath !== null) {
    const handle = record?.resolution.transcriptRef?.handle
      ?? record?.resolution.sessionRef?.handle
      ?? hints.sessionId
      ?? null;
    return { record, transcriptPath: existingPath, sessionId: handle, via: 'existing' };
  }

  const refHandle = record?.resolution.transcriptRef?.handle
    ?? record?.resolution.sessionRef?.handle
    ?? hints.sessionId;

  // Time-proximity scan is only for killed/timeout runs (no CLI result object).
  // Never invent a handle for COMPLETED/FAILED/precondition-unmet from nearby files.
  const allowTimeProximity = hints.status === 'TIMEOUT_KILLED' || hints.status === 'KILLED'
    || record?.resolution.stopCause === 'timeout'
    || record?.resolution.stopCause === 'cancelled';

  const discovered = discoverRolloutTranscript({
    home,
    sessionId: refHandle,
    ...allowTimeProximity
      ? { startTimeMs: hints.startTime, endTimeMs: hints.endTime }
      : {},
  });

  if (discovered === null) {
    return { record, transcriptPath: null, sessionId: null, via: null };
  }

  let next: RunRecord | null = record;
  if (record !== null) {
    const resolution = {
      ...record.resolution,
      ...record.resolution.transcriptRef === undefined
        ? { transcriptRef: { provenance: 'zcode' as const, handle: discovered.sessionId } }
        : {},
      ...record.resolution.sessionRef === undefined
        ? { sessionRef: { provenance: 'zcode' as const, handle: discovered.sessionId } }
        : {},
    };
    next = { ...record, resolution, transcriptPath: discovered.path };
    try {
      writeRunRecord(getTaskDir(taskId), next);
    } catch {
      // best-effort
    }
  }

  return {
    record: next,
    transcriptPath: discovered.path,
    sessionId: discovered.sessionId,
    via: discovered.via,
  };
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
  let working = record;
  const ref = working?.resolution.transcriptRef;
  const home = options.home;

  // Prefer path already persisted at settle/harvest; re-resolve when missing/stale.
  let transcriptPath: string | null = null;
  if (typeof working?.transcriptPath === 'string' && working.transcriptPath.length > 0
      && existsSync(working.transcriptPath)) {
    transcriptPath = working.transcriptPath;
  } else {
    transcriptPath = resolveTranscriptPath(ref, { home });
    // TIMEOUT / kill often leave no transcriptRef — discover model-io by sessionId or time.
    if (transcriptPath === null) {
      const repaired = repairTimeoutTranscript(taskId, working, { home });
      transcriptPath = repaired.transcriptPath;
      if (repaired.record !== null) working = repaired.record;
    } else if (working !== null && working.transcriptPath !== transcriptPath) {
      // Persist when harvest finds a path settle missed (file may appear after exit).
      try {
        writeRunRecord(getTaskDir(taskId), { ...working, transcriptPath });
      } catch {
        // best-effort; board still gets the in-memory path
      }
    }
  }

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
