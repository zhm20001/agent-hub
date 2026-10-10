/** Persist last-used dispatch preset chip index. */
export const DISPATCH_TEMPLATE_KEY = 'agent-hub-dispatch-template';

export function readLastTemplateIndex(): number | null {
  try {
    const raw = localStorage.getItem(DISPATCH_TEMPLATE_KEY);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastTemplateIndex(index: number): void {
  try {
    localStorage.setItem(DISPATCH_TEMPLATE_KEY, String(index));
  } catch {
    /* ignore quota / private mode */
  }
}
