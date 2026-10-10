import React, { useEffect, useState } from 'react';
import { MessagesSquare, Copy, Check } from 'lucide-react';
import type { Task } from '../types.ts';
import { translations, type Language } from '../i18n.ts';
import type { ConversationTurn } from '../lib/board-ux.ts';
import { MarkdownBody } from './MarkdownBody.tsx';

interface ConversationViewProps {
  task: Task;
  lang: Language;
}

interface ConversationResponse {
  turns: ConversationTurn[];
  transcriptPath: string | null;
  emptyReason: string | null;
  sessionId: string | null;
}

/** Display cap for assistant markdown in the conversation tab (list summary may still truncate). */
const ASSISTANT_DISPLAY_CAP = 8000;

function displaySource(turn: ConversationTurn): { source: string; truncated: boolean; fullLength: number } {
  const full = turn.fullText ?? turn.text;
  if (turn.role !== 'assistant') {
    return { source: turn.text, truncated: turn.truncated, fullLength: full.length };
  }
  if (full.length <= ASSISTANT_DISPLAY_CAP) {
    return { source: full, truncated: false, fullLength: full.length };
  }
  return {
    source: `${full.slice(0, ASSISTANT_DISPLAY_CAP - 1)}…`,
    truncated: true,
    fullLength: full.length,
  };
}

export const ConversationView: React.FC<ConversationViewProps> = ({ task, lang }) => {
  const t = translations[lang];
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolvedPath, setResolvedPath] = useState<string | null>(task.transcriptPath ?? null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const transcriptRef = task.closingRecord?.resolution?.transcriptRef;
  const isTimeout = task.status === 'TIMEOUT_KILLED';

  useEffect(() => {
    let cancelled = false;
    setTurns(null);
    setError(null);
    setEmptyReason(null);
    setLoading(true);

    (async () => {
      try {
        const res = await fetch(`/api/tasks/${task.taskId}/conversation`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        const data = (await res.json()) as ConversationResponse;
        if (cancelled) return;
        setTurns(Array.isArray(data.turns) ? data.turns : []);
        setResolvedPath(data.transcriptPath ?? null);
        setEmptyReason(data.emptyReason ?? null);
        setSessionId(data.sessionId ?? null);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setTurns([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [task.taskId]);

  const roleLabel = (role: ConversationTurn['role']) => {
    if (role === 'user') return t.conversationRoleUser;
    if (role === 'assistant') return t.conversationRoleAssistant;
    return role;
  };

  const handleCopy = async (turn: ConversationTurn, idx: number) => {
    const source = turn.fullText ?? turn.text;
    try {
      await navigator.clipboard.writeText(source);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 2000);
    } catch {
      // ignore
    }
  };

  let body: React.ReactNode;
  if (loading) {
    body = <p className="text-ink-muted text-xs">{t.conversationLoading}</p>;
  } else if (error) {
    body = <p className="text-danger text-xs">{error}</p>;
  } else if (!turns || turns.length === 0) {
    if (emptyReason === 'timeout-no-transcript' || (isTimeout && !resolvedPath && !transcriptRef)) {
      body = (
        <p className="text-warn/90 text-xs leading-relaxed max-w-xl">
          {t.conversationTimeoutFallback}
          {sessionId ? ` (sessionId: ${sessionId})` : ''}
        </p>
      );
    } else if (!resolvedPath) {
      body = (
        <p className="text-ink-muted text-xs leading-relaxed max-w-xl">
          {t.conversationNoPath}
          {transcriptRef
            ? ` (${transcriptRef.provenance}:${transcriptRef.handle})`
            : ''}
        </p>
      );
    } else {
      body = <p className="text-ink-muted text-xs">{t.conversationEmpty}</p>;
    }
  } else {
    body = (
      <ul className="space-y-3">
        {turns.map((turn, idx) => {
          const shown = displaySource(turn);
          const isAssistant = turn.role === 'assistant';
          return (
            <li
              key={`${turn.role}-${idx}`}
              className={`rounded-lg border px-3 py-2 ${
 turn.role === 'user'
 ? 'border-line-strong/80 bg-surface/80'
 : isAssistant
 ? 'border-accent/20 bg-accent/10'
 : 'border-line bg-surface/40'
 }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider ${
 turn.role === 'user'
 ? 'text-ink-secondary'
 : isAssistant
 ? 'text-accent-soft'
 : 'text-ink-muted'
 }`}
                >
                  {roleLabel(turn.role)}
                </span>
                {shown.truncated && (
                  <span className="text-[10px] text-amber-300/80">
                    {t.harvestTruncated
                      .replace('{cap}', String(ASSISTANT_DISPLAY_CAP))
                      .replace('{full}', String(shown.fullLength))}
                  </span>
                )}
                {isAssistant && (
                  <button
                    type="button"
                    onClick={() => handleCopy(turn, idx)}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/20 hover:bg-accent/35 text-accent-soft border border-accent/30 text-[10px] font-medium transition-all"
                  >
                    {copiedIdx === idx ? (
                      <Check className="h-3 w-3 text-live" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>{copiedIdx === idx ? t.copied : t.copyReply}</span>
                  </button>
                )}
              </div>
              {isAssistant ? (
                <MarkdownBody
                  source={shown.source}
                  className="text-[12px] text-ink-secondary leading-relaxed"
                />
              ) : (
                <p className="text-[12px] text-ink-secondary leading-relaxed whitespace-pre-wrap break-words">
                  {shown.source}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex flex-col h-full bg-page font-mono text-xs">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-line bg-surface/60 text-ink-secondary">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare className="h-4 w-4 text-accent-soft shrink-0" />
          <span className="font-semibold text-ink-secondary">{t.tabConversation}</span>
          {resolvedPath && (
            <span className="truncate text-[10px] text-ink-faint font-mono" title={resolvedPath}>
              {resolvedPath}
            </span>
          )}
        </div>
        <span className="text-[10px] text-ink-faint shrink-0">{t.conversationTruncatedNote}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">{body}</div>
    </div>
  );
};
