import type { TaskStatus } from '../types.ts';
import type { Language } from '../i18n.ts';
import { translations } from '../i18n.ts';

/** One status ink class — no multi-badge chrome. */
export function statusInkClass(status: TaskStatus): string {
  switch (status) {
    case 'RUNNING':
      return 'text-live';
    case 'COMPLETED':
      return 'text-done';
    case 'TIMEOUT_KILLED':
      return 'text-warn';
    case 'KILLED':
      return 'text-ink-secondary';
    case 'FAILED':
    default:
      return 'text-danger';
  }
}

export function statusLabel(status: TaskStatus, lang: Language): string {
  const t = translations[lang];
  switch (status) {
    case 'RUNNING':
      return t.statusRunning;
    case 'COMPLETED':
      return t.statusCompleted;
    case 'TIMEOUT_KILLED':
      return t.statusTimeout;
    case 'KILLED':
      return t.statusKilled;
    case 'FAILED':
    default:
      return t.statusFailed;
  }
}

/** Short live marker for kanban (still one ink). */
export function statusShortLabel(status: TaskStatus, lang: Language): string {
  const t = translations[lang];
  if (status === 'RUNNING') return t.runningBadge;
  if (status === 'COMPLETED') return 'exit 0';
  return statusLabel(status, lang);
}
