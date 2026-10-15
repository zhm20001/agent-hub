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

// Shared display shapes; Agent-specific parsing is owned by adapters.
export type { ConversationRole, ConversationTurn, SummarizeOptions } from '../../shared/transcript.ts';
