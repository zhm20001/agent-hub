import React, { useEffect, useState } from 'react';
import { GitBranch, RefreshCw, FileText } from 'lucide-react';
import type { VcsData } from '../types.ts';
import { translations, type Language } from '../i18n.ts';

interface DiffViewProps {
  taskId: string;
  lang: Language;
}

export const DiffView: React.FC<DiffViewProps> = ({ taskId, lang }) => {
  const t = translations[lang];
  const [vcsData, setVcsData] = useState<VcsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchVcs = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/vcs`);
      const data = await res.json();
      setVcsData(data);
    } catch {
      setVcsData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVcs();
  }, [taskId]);

  const engineLabel =
    vcsData?.engine === 'jj'
      ? t.vcsEngineJj
      : vcsData?.engine === 'git'
        ? t.vcsEngineGit
        : t.vcsEngineNone;

  return (
    <div className="flex flex-col h-full bg-page font-mono text-xs">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface/60 text-ink-secondary">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="h-4 w-4 text-live shrink-0" />
          <span className="font-semibold text-ink-secondary truncate">{t.vcsTitle}</span>
          <span className="px-1.5 py-0.5 rounded-sm bg-surface-muted text-[10px] text-ink-muted shrink-0">
            {engineLabel}
          </span>
          {vcsData?.cwd && (
            <span className="text-[10px] text-ink-faint truncate hidden sm:inline" title={vcsData.cwd}>
              {vcsData.cwd}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={fetchVcs}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-surface-muted hover:bg-line-strong text-ink-secondary text-[11px] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.refreshVcs}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {vcsData?.error && (
          <div className="p-3 rounded-sm bg-surface border border-line text-ink-secondary text-[11px] leading-relaxed">
            {vcsData.error}
          </div>
        )}

        {vcsData?.status != null && vcsData.status !== '' && (
          <div className="p-3 rounded-sm bg-surface border border-line text-ink-secondary">
            <div className="text-[11px] font-semibold text-ink-secondary mb-1 flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-accent-soft" />
              <span>{t.vcsStatusSummary}</span>
            </div>
            <pre className="text-ink-secondary text-xs whitespace-pre-wrap">{vcsData.status}</pre>
          </div>
        )}

        <div className="p-4 rounded-sm bg-surface/80 border border-line">
          <div className="text-[11px] font-semibold text-ink-secondary mb-2 border-b border-line pb-1.5">
            {vcsData?.engine === 'jj' ? t.jjLogOutput : t.vcsLogOutput}
          </div>
          <pre className="overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-secondary">
            {vcsData?.log || t.vcsEmpty}
          </pre>
        </div>

        {vcsData?.engine === 'jj' && vcsData.diff ? (
          <div className="p-4 rounded-sm bg-surface/80 border border-line">
            <div className="text-[11px] font-semibold text-ink-secondary mb-2 border-b border-line pb-1.5">
              {t.jjDiffOutput}
            </div>
            <pre className="overflow-x-auto text-xs leading-relaxed">
              {vcsData.diff.split('\n').map((line, idx) => {
                let lineStyle = 'text-ink-secondary';
                if (line.startsWith('+') && !line.startsWith('+++')) {
                  lineStyle = 'text-live bg-emerald-950/30 -mx-4 px-4 block';
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                  lineStyle = 'text-danger bg-rose-950/30 -mx-4 px-4 block';
                } else if (line.startsWith('@@')) {
                  lineStyle = 'text-cyan-400 font-semibold';
                }
                return (
                  <span key={idx} className={lineStyle}>
                    {line}
                    {'\n'}
                  </span>
                );
              })}
            </pre>
          </div>
        ) : null}

        {vcsData?.engine === 'git' && vcsData.diff ? (
          <div className="p-4 rounded-sm bg-surface/80 border border-line">
            <div className="text-[11px] font-semibold text-ink-muted mb-2 border-b border-line pb-1.5">
              {t.gitDiffSecondary}
            </div>
            <pre className="overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-muted">
              {vcsData.diff}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
};
