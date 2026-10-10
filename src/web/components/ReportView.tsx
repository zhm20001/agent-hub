import React, { useState } from 'react';
import { FileCheck, AlertCircle, Info, ScrollText, MessageSquareText, FolderOpen, ExternalLink, Copy, Check } from 'lucide-react';
import type { TaskDetailData } from '../types.ts';
import { translations, type Language } from '../i18n.ts';
import { MarkdownBody } from './MarkdownBody.tsx';

interface ReportViewProps {
  task: TaskDetailData;
  lang: Language;
}

export const ReportView: React.FC<ReportViewProps> = ({ task, lang }) => {
  const t = translations[lang];
  const closing = task.closingRecord;
  const resolution = closing?.resolution;
  const lastTurn = task.lastTurn;
  const transcriptPath = task.transcriptPath ?? null;
  const resolutionPath = task.resolutionPath ?? null;
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleRevealJson = async () => {
    setRevealError(null);
    setRevealNote(null);
    if (!transcriptPath && resolutionPath) {
      setRevealNote(t.harvestResolutionFallback);
    }
    setRevealing(true);
    try {
      const res = await fetch(`/api/tasks/${task.taskId}/reveal-transcript`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRevealError(typeof data.error === 'string' ? data.error : t.harvestOpenFailed);
      }
    } catch (err: any) {
      setRevealError(err?.message || t.harvestOpenFailed);
    }
    setRevealing(false);
  };

  const handleCopyLastTurn = async () => {
    if (!lastTurn) return;
    const source = lastTurn.fullText ?? lastTurn.text;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures
    }
  };

  const openPath = transcriptPath || resolutionPath;
  const canReveal = Boolean(openPath);

  return (
    <div className="flex flex-col h-full bg-page font-mono text-xs">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-line bg-surface/60 text-ink-secondary">
        <FileCheck className="h-4 w-4 text-accent-soft" />
        <span className="font-semibold text-ink-secondary">{t.reportTitle}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4 max-w-4xl">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg bg-surface border border-line">
            <span className="text-[11px] text-ink-muted block mb-0.5">{t.statStatus}</span>
            <span className="font-bold text-sm text-ink">{task.status}</span>
          </div>
          <div className="p-3 rounded-lg bg-surface border border-line">
            <span className="text-[11px] text-ink-muted block mb-0.5">{t.statAdapter}</span>
            <span className="font-bold text-sm text-accent-soft">{task.adapter}</span>
          </div>
          <div className="p-3 rounded-lg bg-surface border border-line">
            <span className="text-[11px] text-ink-muted block mb-0.5">{t.statTicket}</span>
            <span className="font-bold text-sm text-ink">{task.ticket || '—'}</span>
          </div>
          <div className="p-3 rounded-lg bg-surface border border-line">
            <span className="text-[11px] text-ink-muted block mb-0.5">{t.statExitCode}</span>
            <span className="font-bold text-sm text-ink">{task.exitCode ?? '—'}</span>
          </div>
        </div>

        {task.error && (
          <div className="p-4 rounded-lg bg-red-950/30 border border-danger/30 text-danger flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-danger shrink-0 mt-0.5" />
            <div>
              <div className="font-bold mb-1">{t.executionError}</div>
              <pre className="text-xs">{task.error}</pre>
            </div>
          </div>
        )}

        {/* Closing record = mechanical facts, NOT a semantic verdict (ADR-0002) */}
        <div className="p-4 rounded-lg bg-amber-950/20 border border-amber-800/40 text-amber-100/90 space-y-3">
          <div className="flex items-start gap-3">
            <ScrollText className="h-5 w-5 text-warn shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-amber-200">{t.closingRecordTitle}</div>
              <p className="text-[11px] text-amber-200/70 mt-1 leading-relaxed">{t.closingRecordHint}</p>
            </div>
          </div>
          {resolution ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-8">
              <div>
                <span className="text-[10px] text-amber-500/80 block">stopCause</span>
                <span className="text-ink">{resolution.stopCause ?? '—'}</span>
              </div>
              <div>
                <span className="text-[10px] text-amber-500/80 block">finalText</span>
                <span className="text-ink break-all">
                  {resolution.finalText?.kind === 'text'
                    ? (resolution.finalText.value?.slice(0, 200) || '(empty text)')
                    : resolution.finalText?.kind || '—'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-amber-500/80 block">sessionRef</span>
                <span className="text-ink font-mono">
                  {resolution.sessionRef
                    ? `${resolution.sessionRef.provenance}:${resolution.sessionRef.handle}`
                    : '—'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-amber-500/80 block">transcriptRef</span>
                <span className="text-ink font-mono">
                  {resolution.transcriptRef
                    ? `${resolution.transcriptRef.provenance}:${resolution.transcriptRef.handle}`
                    : '—'}
                </span>
              </div>
            </div>
          ) : (
            <p className="pl-8 text-amber-200/60 text-[11px]">{t.closingRecordPending}</p>
          )}
        </div>

        {/* Last turn harvest — mechanical, not a verdict (ADR-0002) */}
        <div className="p-4 rounded-lg bg-accent/10 border border-accent/30 text-ink-secondary space-y-3">
          <div className="flex items-start gap-3">
            <MessageSquareText className="h-5 w-5 text-accent-soft shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="font-bold text-accent-soft">{t.harvestTitle}</div>
              <p className="text-[11px] text-accent-soft/70 mt-1 leading-relaxed">{t.harvestHint}</p>
            </div>
          </div>

          {lastTurn ? (
            <div className="pl-8 space-y-2">
              <div className="p-3 rounded-md bg-page/60 border border-line text-ink max-h-96 overflow-y-auto leading-relaxed">
                <MarkdownBody source={lastTurn.text} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-accent-soft/70">
                <span>
                  {lastTurn.source === 'transcript'
                    ? t.harvestSourceTranscript
                    : t.harvestSourceFinalText}
                </span>
                {lastTurn.truncated && (
                  <span className="text-amber-300/90">
                    {t.harvestTruncated
                      .replace('{cap}', String(lastTurn.cap))
                      .replace('{full}', String(lastTurn.fullLength))}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleCopyLastTurn}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/20 hover:bg-accent/35 text-accent-soft border border-accent/30 text-[10px] font-medium transition-all"
                >
                  {copied ? <Check className="h-3 w-3 text-live" /> : <Copy className="h-3 w-3" />}
                  <span>{copied ? t.copied : t.copyReply}</span>
                </button>
              </div>
            </div>
          ) : (
            <p className="pl-8 text-accent-soft/60 text-[11px]">{t.harvestEmpty}</p>
          )}

          <div className="pl-8 space-y-2 border-t border-line pt-3">
            <div>
              <span className="text-[10px] text-ink-muted block mb-0.5">{t.harvestTranscriptPath}</span>
              {transcriptPath ? (
                <code className="text-[11px] text-ink-secondary break-all">{transcriptPath}</code>
              ) : (
                <span className="text-[11px] text-accent-soft/50">{t.harvestPathUnknown}</span>
              )}
              {!transcriptPath && resolutionPath && (
                <div className="mt-1">
                  <span className="text-[10px] text-ink-muted block">resolution.json</span>
                  <code className="text-[11px] text-ink-secondary break-all">{resolutionPath}</code>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!canReveal || revealing}
                onClick={handleRevealJson}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/25 hover:bg-accent/40 disabled:opacity-40 disabled:cursor-not-allowed text-accent-soft border border-accent/30 text-[11px] font-medium transition-all"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span>{revealing ? '…' : t.harvestOpenJson}</span>
              </button>
              {openPath && (
                <a
                  href={`/api/tasks/${task.taskId}/transcript-file`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted hover:bg-line-strong text-ink-secondary border border-line-strong text-[11px] font-medium transition-all"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>JSON</span>
                </a>
              )}
            </div>
            {revealNote && (
              <p className="text-[10px] text-amber-200/70">{revealNote}</p>
            )}
            {revealError && (
              <p className="text-[10px] text-danger">{revealError}</p>
            )}
          </div>
        </div>

        {task.report ? (
          <div className="p-5 rounded-lg bg-surface border border-line text-ink-secondary leading-relaxed whitespace-pre-wrap">
            {task.report}
          </div>
        ) : (
          <div className="p-8 text-center text-ink-muted bg-surface/40 rounded-lg border border-line/60">
            <Info className="h-6 w-6 mx-auto mb-2 text-ink-faint" />
            {t.generatingReport}
          </div>
        )}
      </div>
    </div>
  );
};
