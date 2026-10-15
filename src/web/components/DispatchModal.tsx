import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X, Play, AlertCircle } from 'lucide-react';
import { translations, type Language } from '../i18n.ts';
import { getFocusableElements, trapTabKey } from '../lib/focus-trap.ts';
import {
  readLastTemplateIndex,
  writeLastTemplateIndex,
} from '../lib/dispatch-template.ts';

interface DispatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDispatched: (newTaskId: string) => void;
  lang: Language;
}

type Preset = { title: string; prompt: string; ticket: string };

function buildPresets(lang: Language): Preset[] {
  const t = translations[lang];
  return [
    {
      title: t.preset1,
      prompt:
        'Review recent codebase changes, check architectural boundaries, and report code quality recommendations.',
      ticket: 'AUDIT-1',
    },
    {
      title: t.preset2,
      prompt: 'Check git repository status, uncommitted modifications, and branch health.',
      ticket: 'GIT-01',
    },
    {
      title: t.preset3,
      prompt: 'Refactor core task dispatcher utilities to optimize throughput and error handling.',
      ticket: 'REFACTOR-3',
    },
    {
      title: t.preset4,
      prompt:
        'Perform environment sanity check on subagent runtime, ZCode fixtures, and filesystem logs.',
      ticket: 'SANITY-9',
    },
  ];
}

export const DispatchModal: React.FC<DispatchModalProps> = ({
  isOpen,
  onClose,
  onDispatched,
  lang,
}) => {
  const t = translations[lang];
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const submittingRef = useRef(false);

  const [prompt, setPrompt] = useState('');
  const [ticket, setTicket] = useState('');
  const [label, setLabel] = useState('');
  const [adapter, setAdapter] = useState('zcode');
  const [mode, setMode] = useState('edit');
  const [timeout, setTimeoutVal] = useState('7200');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<number | null>(null);

  const presets = buildPresets(lang);

  const clearFailure = useCallback(() => {
    setError(null);
  }, []);

  const applyPreset = useCallback(
    (idx: number, list: Preset[]) => {
      const p = list[idx];
      if (!p) return;
      setPrompt(p.prompt);
      setTicket(p.ticket);
      setLabel((prev) => (prev.trim() ? prev : p.title));
      setActivePreset(idx);
      writeLastTemplateIndex(idx);
      setError(null);
    },
    [],
  );

  // Open lifecycle: trap focus, Esc, recall last template, clear failure
  useEffect(() => {
    if (!isOpen) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    submittingRef.current = false;
    setIsSubmitting(false);
    setError(null);

    const list = buildPresets(lang);
    const saved = readLastTemplateIndex();
    if (saved !== null && saved < list.length) {
      applyPreset(saved, list);
    } else {
      setActivePreset(null);
    }

    const dialog = dialogRef.current;
    const raf = requestAnimationFrame(() => {
      if (!dialog) return;
      const nodes = getFocusableElements(dialog);
      const prefer =
        nodes.find((el) => el.tagName === 'TEXTAREA') ??
        nodes.find((el) => el.getAttribute('type') !== 'button') ??
        nodes[0];
      prefer?.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (!dialogRef.current) return;
      const root = dialogRef.current;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setError(null);
        setIsSubmitting(false);
        submittingRef.current = false;
        onClose();
        return;
      }

      trapTabKey(root, e);

      // Safe Enter: Ctrl/Cmd+Enter in textarea → submit; plain Enter in inputs uses native form
      if (e.key === 'Enter' && !submittingRef.current) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'textarea' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          root.querySelector<HTMLFormElement>('form')?.requestSubmit();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus?.();
    };
  }, [isOpen, onClose, lang, applyPreset]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      setError(t.promptRequired);
      return;
    }
    if (submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          ticket: ticket.trim() || undefined,
          label: label.trim() || undefined,
          adapter,
          mode,
          timeout: parseInt(timeout, 10) || 7200,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          (errJson as { error?: string }).error || 'Failed to dispatch task',
        );
      }

      const data = await res.json();
      onDispatched(data.taskId);
      setPrompt('');
      setTicket('');
      setLabel('');
      setError(null);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setError(null);
    setIsSubmitting(false);
    submittingRef.current = false;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 ah-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-xl bg-surface border border-line rounded-md overflow-hidden flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <div className="text-left">
            <h2 id={titleId} className="font-semibold text-sm text-ink">
              {t.modalTitle}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">{t.modalDesc}</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-sm text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
            aria-label={t.cancel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-left">
          {error && (
            <div
              className="p-2.5 rounded-sm bg-danger/10 border border-danger/25 text-danger text-xs flex items-center gap-2"
              role="alert"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-2">
              {t.presetChipsTitle}
            </p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.presetChipsTitle}>
              {presets.map((preset, idx) => {
                const selected = activePreset === idx;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => applyPreset(idx, presets)}
                    aria-pressed={selected}
                    className={`px-2 py-1 rounded-sm border text-[11px] transition-colors ${
                      selected
                        ? 'border-accent bg-accent/10 text-accent-soft'
                        : 'border-line text-ink-secondary hover:text-ink hover:border-line-strong hover:bg-surface-muted'
                    }`}
                  >
                    {preset.title}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-ink-faint mt-1.5">{t.templateRememberHint}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">
                {t.ticketLabel}
              </label>
              <input
                type="text"
                placeholder={t.ticketPlaceholder}
                value={ticket}
                onChange={(e) => {
                  setTicket(e.target.value);
                  clearFailure();
                }}
                className="w-full bg-page border border-line-strong rounded-sm px-3 py-2 text-xs text-ink placeholder-ink-muted font-mono focus:outline-none focus:border-accent"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">
                {t.labelTitle}
              </label>
              <input
                type="text"
                placeholder={t.labelPlaceholder}
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  clearFailure();
                }}
                className="w-full bg-page border border-line-strong rounded-sm px-3 py-2 text-xs text-ink placeholder-ink-muted focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">
                {t.adapterLabel}
              </label>
              <select
                value={adapter}
                onChange={(e) => {
                  setAdapter(e.target.value);
                  clearFailure();
                }}
                className="w-full bg-page border border-line-strong rounded-sm px-3 py-2 text-xs text-ink focus:outline-none focus:border-accent"
              >
                <option value="zcode">{t.adapterZcode}</option>
                <option value="codex">{t.adapterCodex}</option>
                <option value="bash">{t.adapterBash}</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">
                {t.modeLabel}
              </label>
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  clearFailure();
                }}
                className="w-full bg-page border border-line-strong rounded-sm px-3 py-2 text-xs text-ink focus:outline-none focus:border-accent"
              >
                <option value="edit">{t.modeEdit}</option>
                <option value="build">{t.modeBuild}</option>
                <option value="plan">{t.modePlan}</option>
                <option value="yolo">{t.modeYolo}</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">
                {t.timeoutLabel}
              </label>
              <input
                type="number"
                value={timeout}
                onChange={(e) => {
                  setTimeoutVal(e.target.value);
                  clearFailure();
                }}
                className="w-full bg-page border border-line-strong rounded-sm px-3 py-2 text-xs text-ink font-mono focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">
              {t.promptLabel} <span className="text-danger">*</span>
            </label>
            <textarea
              rows={6}
              placeholder={t.promptPlaceholder}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                clearFailure();
              }}
              className="w-full bg-page border border-line-strong rounded-sm p-3 text-xs text-ink placeholder-ink-muted font-mono leading-relaxed focus:outline-none focus:border-accent resize-none"
            />
            <p className="text-[10px] text-ink-faint mt-1">{t.submitShortcutHint}</p>
          </div>

          <div className="pt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-3.5 py-2 rounded-sm text-xs font-medium text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-3.5 py-2 rounded-sm bg-accent hover:bg-accent-bright active:bg-accent-dim text-cta font-medium text-xs transition-colors disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>{isSubmitting ? t.spawning : t.spawnBtn}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
