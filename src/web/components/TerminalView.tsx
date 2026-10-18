import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Terminal as TerminalIcon, Copy, Check, ArrowDown, Download } from 'lucide-react';
import { translations, type Language } from '../i18n.ts';
import { filterLogNoise } from '../lib/board-ux.ts';

interface TerminalViewProps {
  taskId: string;
  isLive: boolean;
  lang: Language;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ taskId, isLive, lang }) => {
  const t = translations[lang];
  const [rawLogs, setRawLogs] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const [streamActive, setStreamActive] = useState<boolean>(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterLogNoise(rawLogs), [rawLogs]);

  useEffect(() => {
    setRawLogs('');
    setStreamActive(true);

    const eventSource = new EventSource(`/api/tasks/${taskId}/stream`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.text || data.reset) {
          setRawLogs((prev) => ((data.reset ? '' : prev) + (data.text ?? '')).slice(-1024 * 1024));
        }
        setStreamActive(true);
        if (data.done) {
          setStreamActive(false);
          eventSource.close();
        }
      } catch {
        setRawLogs((prev) => prev + event.data + '\n');
      }
    };

    eventSource.onerror = () => {
      setStreamActive(false);
      // EventSource reconnects with Last-Event-ID; closing here would lose recovery.
    };

    return () => {
      eventSource.close();
    };
  }, [taskId]);

  useEffect(() => {
    if (autoScroll) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filtered.text, autoScroll]);

  const handleCopy = () => {
    navigator.clipboard.writeText(filtered.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([filtered.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${taskId}-raw.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const connecting = rawLogs.length === 0 && streamActive;

  return (
    <div className="flex flex-col h-full bg-page font-mono text-xs">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface/60 text-ink-secondary">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-4 w-4 text-accent-soft" />
          <span className="font-semibold text-ink-secondary">raw.log</span>
          {streamActive ? (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-live/10 text-live border border-live/20">
              <span className="h-1.5 w-1.5 rounded-full bg-live animate-pulse" />
              {t.liveSseStream}
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-muted text-ink-muted">
              {t.streamClosed}
            </span>
          )}
          {filtered.hidden > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-muted/80 text-ink-muted border border-line-strong/50">
              {t.noiseLinesHidden.replace('{n}', String(filtered.hidden))}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
 autoScroll ? 'bg-accent/20 text-accent-soft border border-accent/30' : 'text-ink-muted hover:text-ink-secondary'
 }`}
          >
            <ArrowDown className="h-3 w-3" />
            <span>{t.autoScroll}</span>
          </button>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-live" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? t.copied : t.copy}</span>
          </button>

          <button
            onClick={handleDownload}
            className="p-1 rounded text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
            title={t.downloadLog}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 overflow-y-auto leading-relaxed whitespace-pre-wrap select-text text-ink-secondary">
        {connecting ? (
          <span className="text-ink-faint">{t.connectingStream}</span>
        ) : filtered.text ? (
          filtered.text
        ) : (
          <span className="text-ink-faint">{t.waitingStdout}</span>
        )}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
};
