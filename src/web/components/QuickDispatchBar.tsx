import React, { useState } from 'react';
import { Play, Sparkles, Terminal, CheckCircle2, Cpu } from 'lucide-react';
import { translations, type Language } from '../i18n.ts';

interface QuickDispatchBarProps {
  onDispatched: (taskId: string) => void;
  lang: Language;
}

export const QuickDispatchBar: React.FC<QuickDispatchBarProps> = ({ onDispatched, lang }) => {
  const t = translations[lang];
  const [prompt, setPrompt] = useState('');
  const [ticket, setTicket] = useState('');
  const [adapter, setAdapter] = useState<'zcode' | 'codex' | 'bash'>('zcode');
  const [mode, setMode] = useState('edit');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const presets = [
    { title: t.preset1, prompt: 'Review recent codebase changes, check architectural boundaries, and report code quality recommendations.', ticket: 'AUDIT-1' },
    { title: t.preset2, prompt: 'Check git repository status, uncommitted modifications, and branch health.', ticket: 'GIT-01' },
    { title: t.preset3, prompt: 'Refactor core task dispatcher utilities to optimize throughput and error handling.', ticket: 'REFACTOR-3' },
    { title: t.preset4, prompt: 'Perform environment sanity check on subagent runtime, ZCode fixtures, and filesystem logs.', ticket: 'SANITY-9' },
  ];

  const handleQuickDispatch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!prompt.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          ticket: ticket.trim() || `T-${Math.floor(Math.random() * 900 + 100)}`,
          label: prompt.trim().slice(0, 40),
          adapter,
          mode,
          timeout: 7200,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setToast(`${t.taskDispatchedToast} (${data.taskId})`);
        setTimeout(() => setToast(null), 4000);
        setPrompt('');
        onDispatched(data.taskId);
      }
    } catch (err) {
      console.error('Quick dispatch failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyPreset = (p: typeof presets[0]) => {
    setPrompt(p.prompt);
    setTicket(p.ticket);
  };

  return (
    <div className="bg-surface border border-line rounded-lg p-3.5 md:p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-accent/15 text-accent-soft border border-accent/25">
            <Cpu className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-ink flex items-center gap-2">
              {t.quickFormTitle}
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-live/10 text-live border border-live/20">
                Live Subagent Worker
              </span>
            </h2>
            <p className="text-xs text-ink-secondary">{t.quickFormSubtitle}</p>
          </div>
        </div>

        {/* Adapter Switcher */}
        <div className="flex items-center gap-1 bg-page/80 p-1 rounded-md border border-line self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setAdapter('zcode')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
 adapter === 'zcode'
 ? 'bg-accent text-page'
 : 'text-ink-secondary hover:text-ink'
 }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>ZCode CLI</span>
          </button>
          <button
            type="button"
            onClick={() => setAdapter('codex')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
 adapter === 'codex'
 ? 'bg-accent text-page'
 : 'text-ink-secondary hover:text-ink'
 }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>Codex</span>
          </button>
          <button
            type="button"
            onClick={() => setAdapter('bash')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
 adapter === 'bash'
 ? 'bg-accent text-page'
 : 'text-ink-secondary hover:text-ink'
 }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            <span>Bash Shell</span>
          </button>
        </div>
      </div>

      {toast && (
        <div className="mb-3 px-3.5 py-2 rounded-md bg-accent/20 border border-accent/40 text-accent-soft text-xs flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
          <CheckCircle2 className="h-4 w-4 text-live shrink-0" />
          <span>{toast}</span>
        </div>
      )}

      {/* Main Form Bar */}
      <form onSubmit={handleQuickDispatch} className="space-y-3">
        <div className="flex flex-col md:flex-row gap-2.5">
          <div className="w-full md:w-36 shrink-0">
            <input
              type="text"
              placeholder={t.quickTicketPlaceholder}
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              className="w-full bg-page/80 border border-line-strong/80 rounded-md px-3 py-2.5 text-xs text-ink placeholder-ink-muted font-mono focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex-1">
            <input
              type="text"
              placeholder={t.quickPromptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full bg-page/80 border border-line-strong/80 rounded-md px-4 py-2.5 text-xs text-ink placeholder-ink-muted focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="w-full md:w-auto shrink-0">
            <button
              type="submit"
              disabled={isSubmitting || !prompt.trim()}
              className="w-full md:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-md bg-accent hover:bg-accent-bright active:bg-accent-dim text-page font-semibold text-xs transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>{isSubmitting ? t.spawning : t.quickDispatchBtn}</span>
            </button>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="flex items-center gap-2 overflow-x-auto text-[11px] pt-1 no-scrollbar">
          <span className="text-ink-muted shrink-0 font-medium">{t.presetChipsTitle}</span>
          {presets.map((preset, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => applyPreset(preset)}
              className="px-2.5 py-1 rounded-lg bg-surface-muted/80 hover:bg-surface-muted hover:border-line-strong border border-line-strong/60 text-ink-secondary hover:text-ink transition-all whitespace-nowrap text-xs flex items-center gap-1.5"
            >
              <Sparkles className="h-3 w-3 text-accent-soft" />
              <span>{preset.title}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
};
