/**
 * Small YAGNI board UX helpers (time, log noise, light transcript summary).
 * Pure functions — unit-tested from tests/board-ux.spec.ts.
 */

/** Display timezone for absolute start/created times on the board. */
export const BOARD_TZ = 'Asia/Shanghai';

/**
 * Format an epoch-ms timestamp as an absolute local clock in Asia/Shanghai.
 * Example: `2026-10-11 21:08:05 CST`
 */
export function formatShanghaiAbsolute(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  // sv-SE yields `YYYY-MM-DD HH:mm:ss` in the given zone.
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: BOARD_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  return `${stamp} CST`;
}

/** Relative duration between start and optional end (defaults to now). */
export function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime ?? Date.now();
  const diffSec = Math.max(0, Math.round((end - startTime) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return `${min}m ${sec}s`;
}

/**
 * ZCode stderr noise lines that drown the terminal view.
 * Matches: "ZCode Built-in missing", "ZCode Built-in skipped (not-due)", etc.
 */
export const BUILTIN_NOISE_RE = /ZCode Built-in\b/i;

export interface FilteredLog {
  readonly text: string;
  readonly hidden: number;
}

/** Drop Built-in noise lines; keep everything else. Count how many were hidden. */
export function filterLogNoise(raw: string): FilteredLog {
  if (raw.length === 0) return { text: '', hidden: 0 };
  const endsWithNl = raw.endsWith('\n');
  const lines = raw.split('\n');
  // Trailing empty segment from final `\n` is not a real line — preserve join shape.
  const hadTrailingEmpty = endsWithNl && lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingEmpty) lines.pop();

  let hidden = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (BUILTIN_NOISE_RE.test(line)) {
      hidden += 1;
      continue;
    }
    kept.push(line);
  }
  let text = kept.join('\n');
  if (hadTrailingEmpty && text.length > 0) text += '\n';
  else if (hadTrailingEmpty && text.length === 0 && hidden > 0) text = '';
  return { text, hidden };
}

export type ConversationRole = 'user' | 'assistant' | 'other';

export interface ConversationTurn {
  readonly role: ConversationRole;
  /** Display text (may be truncated / whitespace-collapsed for the list summary). */
  readonly text: string;
  /** True when {@link text} was truncated for display. */
  readonly truncated: boolean;
  /**
   * Full untruncated source (newlines preserved) for markdown render / copy.
   * Always set when a turn is pushed.
   */
  readonly fullText: string;
}

export interface SummarizeOptions {
  /** Max characters per turn text (default 400). */
  readonly maxChars?: number;
  /** Max turns to keep (default 80). */
  readonly maxTurns?: number;
}

const DEFAULT_MAX_CHARS = 400;
const DEFAULT_MAX_TURNS = 80;

function truncateTurn(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (typeof part !== 'object' || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p['type'] === 'text' && typeof p['text'] === 'string') chunks.push(p['text']);
    else if (typeof p['text'] === 'string' && p['type'] !== 'reasoning' && p['type'] !== 'thinking') {
      chunks.push(p['text']);
    }
  }
  return chunks.join('\n');
}

function isNoiseUserText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.startsWith('<system-reminder>')) return true;
  if (t.startsWith('[SYSTEM NOTIFICATION')) return true;
  return false;
}

function pushTurn(
  out: ConversationTurn[],
  role: ConversationRole,
  rawText: string,
  maxChars: number,
  seen: Set<string>,
): void {
  const fullText = rawText.replace(/\r\n/g, '\n').trimEnd();
  const { text, truncated } = truncateTurn(rawText, maxChars);
  if (text.length === 0) return;
  const key = `${role}:${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ role, text, truncated, fullText });
}

/**
 * Light chronological summary from transcript JSON / JSONL (not a full chat product).
 *
 * Supported shapes:
 *   - zcode `transcript.jsonl`: turn_started.input → user, turn_complete.response → assistant
 *   - zcode `model-io-*.jsonl`: response.text → assistant; last real user msg in request.messages
 *   - readback-style `{ messages: [...] }` or a bare messages array
 */
export function summarizeTranscript(raw: string, options: SummarizeOptions = {}): ConversationTurn[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  // Single JSON document (messages array / {messages}) — if empty, fall through
  // so a lone model-io line can still be summarized.
  if (!trimmed.includes('\n') && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromDoc = summarizeJsonDocument(parsed, maxChars);
      if (fromDoc.length > 0) return fromDoc.slice(0, maxTurns);
    } catch {
      // fall through to JSONL
    }
  }

  const turns: ConversationTurn[] = [];
  const seen = new Set<string>();
  let parsedAny = false;

  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (s.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    parsedAny = true;

    const type = obj['type'];

    // transcript.jsonl events
    if (type === 'turn_started') {
      const payload = obj['payload'];
      if (typeof payload === 'object' && payload !== null) {
        const input = (payload as Record<string, unknown>)['input'];
        if (typeof input === 'string' && !isNoiseUserText(input)) {
          pushTurn(turns, 'user', input, maxChars, seen);
        }
      }
      continue;
    }
    if (type === 'turn_complete') {
      const payload = obj['payload'];
      if (typeof payload === 'object' && payload !== null) {
        const response = (payload as Record<string, unknown>)['response'];
        if (typeof response === 'string' && response.trim().length > 0) {
          pushTurn(turns, 'assistant', response, maxChars, seen);
        }
      }
      continue;
    }

    // model-io line: emit the first real user prompt once, then each non-empty response.text
    const request = obj['request'];
    if (typeof request === 'object' && request !== null && !seen.has('__model_io_user__')) {
      const messages = (request as Record<string, unknown>)['messages'];
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (typeof m !== 'object' || m === null) continue;
          const role = (m as Record<string, unknown>)['role'];
          if (role !== 'user') continue;
          const text = contentToText((m as Record<string, unknown>)['content']);
          if (isNoiseUserText(text)) continue;
          pushTurn(turns, 'user', text, maxChars, seen);
          seen.add('__model_io_user__');
          break;
        }
      }
    }

    const response = obj['response'];
    if (typeof response === 'string' && response.trim().length > 0) {
      pushTurn(turns, 'assistant', response, maxChars, seen);
    } else if (typeof response === 'object' && response !== null) {
      const text = (response as Record<string, unknown>)['text'];
      if (typeof text === 'string' && text.trim().length > 0) {
        pushTurn(turns, 'assistant', text, maxChars, seen);
      }
    }
  }

  if (!parsedAny) {
    // Maybe a multi-line pretty JSON array/object
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return summarizeJsonDocument(parsed, maxChars).slice(0, maxTurns);
    } catch {
      return [];
    }
  }

  return turns.slice(0, maxTurns);
}

function summarizeJsonDocument(parsed: unknown, maxChars: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const seen = new Set<string>();

  const messages: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['messages'])
      ? ((parsed as Record<string, unknown>)['messages'] as unknown[])
      : null;

  if (messages === null) return turns;

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const obj = message as Record<string, unknown>;
    let roleRaw: string | undefined;
    if (typeof obj['role'] === 'string') roleRaw = obj['role'];
    else if (typeof obj['info'] === 'object' && obj['info'] !== null) {
      const r = (obj['info'] as Record<string, unknown>)['role'];
      if (typeof r === 'string') roleRaw = r;
    }
    if (roleRaw === undefined) continue;

    let role: ConversationRole = 'other';
    if (roleRaw === 'user') role = 'user';
    else if (roleRaw === 'assistant' || roleRaw === 'agent') role = 'assistant';
    else continue;

    let text = '';
    if (Array.isArray(obj['parts'])) {
      const chunks: string[] = [];
      for (const part of obj['parts']) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') chunks.push(p.text);
      }
      text = chunks.join('\n\n');
    } else {
      text = contentToText(obj['content']);
      if (text.length === 0 && typeof obj['text'] === 'string') text = obj['text'];
    }
    if (role === 'user' && isNoiseUserText(text)) continue;
    pushTurn(turns, role, text, maxChars, seen);
  }
  return turns;
}
