import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Clock, Cpu } from 'lucide-react';
import type { Task } from '../types.ts';
import { translations, type Language } from '../i18n.ts';
import { formatDuration, formatShanghaiAbsolute } from '../lib/board-ux.ts';
import { statusInkClass, statusLabel } from '../lib/status-ink.ts';

interface TaskTimelineProps {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  lang: Language;
}

export const TaskTimeline: React.FC<TaskTimelineProps> = ({
  tasks,
  selectedTaskId,
  onSelectTask,
  lang,
}) => {
  const t = translations[lang];
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const listRef = useRef<HTMLDivElement>(null);

  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) => {
        const q = search.toLowerCase();
        const matchesSearch =
          task.taskId.toLowerCase().includes(q) ||
          task.label.toLowerCase().includes(q) ||
          task.prompt.toLowerCase().includes(q) ||
          (task.ticket && task.ticket.toLowerCase().includes(q));

        if (!matchesSearch) return false;
        if (statusFilter === 'ALL') return true;
        if (statusFilter === 'RUNNING') return task.status === 'RUNNING';
        if (statusFilter === 'COMPLETED') return task.status === 'COMPLETED';
        if (statusFilter === 'FAILED') {
          return task.status === 'FAILED' || task.status === 'TIMEOUT_KILLED';
        }
        if (statusFilter === 'KILLED') return task.status === 'KILLED';
        return true;
      }),
    [tasks, search, statusFilter],
  );

  const selectRelative = useCallback(
    (delta: number) => {
      if (filteredTasks.length === 0) return;
      const idx = filteredTasks.findIndex((x) => x.taskId === selectedTaskId);
      const nextIdx =
        idx < 0
          ? delta > 0
            ? 0
            : filteredTasks.length - 1
          : Math.max(0, Math.min(filteredTasks.length - 1, idx + delta));
      const next = filteredTasks[nextIdx];
      if (next) {
        onSelectTask(next.taskId);
        // Keep selected row in view
        requestAnimationFrame(() => {
          const el = listRef.current?.querySelector<HTMLElement>(
            `[data-task-id="${CSS.escape(next.taskId)}"]`,
          );
          el?.scrollIntoView({ block: 'nearest' });
        });
      }
    },
    [filteredTasks, selectedTaskId, onSelectTask],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const root = listRef.current?.closest('[data-timeline-root]') as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return;
      // Only navigate when focus is in this pane (incl. search) or on the document body
      const bodyFocus =
        !active || active === document.body || active === document.documentElement;
      if (!bodyFocus && root && !root.contains(active)) return;
      e.preventDefault();
      selectRelative(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectRelative]);

  const filterLabels: Record<string, string> = {
    ALL: t.allFilter,
    RUNNING: t.runningFilter,
    COMPLETED: t.completedFilter,
    FAILED: t.failedFilter,
  };

  return (
    <div
      className="flex flex-col h-full bg-surface/50 border-r border-line"
      data-timeline-root
    >
      <div className="p-3.5 border-b border-line space-y-2.5">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            type="text"
            placeholder={t.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-surface-muted/60 border border-line-strong/60 rounded-sm pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-muted focus:outline-none focus:border-accent transition-colors"
            aria-label={t.searchPlaceholder}
          />
        </div>

        <div className="flex items-center gap-1 overflow-x-auto text-[11px] no-scrollbar">
          {(['ALL', 'RUNNING', 'COMPLETED', 'FAILED'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              className={`px-2.5 py-1 rounded-sm transition-colors whitespace-nowrap font-medium ${
                statusFilter === filter
                  ? 'bg-line-strong text-ink font-semibold'
                  : 'text-ink-secondary hover:text-ink hover:bg-surface-muted/60'
              }`}
            >
              {filterLabels[filter]}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-ink-faint">{t.timelineKeysHint}</p>
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto divide-y divide-line/60"
        role="listbox"
        aria-label={t.viewTimeline}
      >
        {filteredTasks.length === 0 ? (
          <div className="p-8 text-center text-ink-muted text-xs">
            <Cpu className="h-8 w-8 mx-auto mb-2 text-ink-faint stroke-[1.5]" />
            {t.noTasksFound}
          </div>
        ) : (
          filteredTasks.map((task) => {
            const isSelected = task.taskId === selectedTaskId;
            const ink = statusInkClass(task.status);
            return (
              <div
                key={task.taskId}
                data-task-id={task.taskId}
                role="option"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => onSelectTask(task.taskId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectTask(task.taskId);
                  }
                }}
                className={`px-3.5 py-2.5 cursor-pointer transition-colors outline-none ${
                  isSelected
                    ? 'bg-accent/10 outline outline-1 outline-accent/40 -outline-offset-1'
                    : 'hover:bg-surface-muted/40'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    {task.ticket && (
                      <span className="shrink-0 font-mono text-[10px] font-semibold text-accent-soft">
                        {task.ticket}
                      </span>
                    )}
                    <span className="text-xs font-semibold text-ink truncate">
                      {task.label || task.taskId}
                    </span>
                  </div>
                  <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${ink}`}>
                    {statusLabel(task.status, lang)}
                  </span>
                </div>

                <p className="text-[11px] text-ink-secondary line-clamp-2 mb-1.5 leading-snug font-mono">
                  {task.prompt}
                </p>

                <div className="flex items-center justify-between text-[10px] text-ink-muted font-mono gap-2">
                  <span className="truncate">
                    {task.adapter}
                    {task.pid ? ` · ${t.pid} ${task.pid}` : ''}
                  </span>
                  <span className="flex items-center gap-1 shrink-0" title={t.startedAt}>
                    <Clock className="h-3 w-3" aria-hidden />
                    {formatDuration(task.startTime, task.endTime)}
                    <span className="text-ink-faint">·</span>
                    {formatShanghaiAbsolute(task.startTime)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
