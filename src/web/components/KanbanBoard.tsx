import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import type { Task } from '../types.ts';
import { translations, type Language } from '../i18n.ts';
import { formatDuration, formatShanghaiAbsolute } from '../lib/board-ux.ts';
import { statusInkClass, statusShortLabel } from '../lib/status-ink.ts';

interface KanbanBoardProps {
  tasks: Task[];
  selectedTaskId: string | null;
  /** Arrow-key / roving highlight — stays on Kanban. */
  onHighlightTask: (taskId: string) => void;
  /** Click / Enter — open Master–Detail. */
  onOpenTask: (taskId: string) => void;
  lang: Language;
}

type LaneId = 'running' | 'completed' | 'terminated';

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  tasks,
  selectedTaskId,
  onHighlightTask,
  onOpenTask,
  lang,
}) => {
  const t = translations[lang];
  const boardRef = useRef<HTMLDivElement>(null);

  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const runningTasks = tasks.filter((task) => task.status === 'RUNNING');
  const completedTasks = tasks.filter((task) => task.status === 'COMPLETED');
  const terminatedTasks = tasks.filter(
    (task) =>
      task.status === 'FAILED' ||
      task.status === 'KILLED' ||
      task.status === 'TIMEOUT_KILLED',
  );

  const emptyHint = (lane: LaneId) => {
    if (tasks.length === 0) return t.emptyBoardHint;
    if (lane === 'running') return t.emptyRunningHint;
    if (lane === 'completed') return t.emptyCompletedHint;
    return t.emptyTerminatedHint;
  };

  const moveSelection = useCallback(
    (dir: 'up' | 'down' | 'left' | 'right') => {
      const order: LaneId[] = ['running', 'completed', 'terminated'];
      const map: Record<LaneId, Task[]> = {
        running: runningTasks,
        completed: completedTasks,
        terminated: terminatedTasks,
      };
      if (tasks.length === 0) return;

      let laneIdx = 0;
      let cardIdx = 0;
      let found = false;
      for (let li = 0; li < order.length; li++) {
        const list = map[order[li]];
        const ci = list.findIndex((x) => x.taskId === selectedTaskId);
        if (ci >= 0) {
          laneIdx = li;
          cardIdx = ci;
          found = true;
          break;
        }
      }
      if (!found) {
        const firstLane = order.find((id) => map[id].length > 0);
        if (!firstLane) return;
        onHighlightTask(map[firstLane][0].taskId);
        return;
      }

      if (dir === 'up') {
        const list = map[order[laneIdx]];
        const next = list[Math.max(0, cardIdx - 1)];
        if (next) onHighlightTask(next.taskId);
        return;
      }
      if (dir === 'down') {
        const list = map[order[laneIdx]];
        const next = list[Math.min(list.length - 1, cardIdx + 1)];
        if (next) onHighlightTask(next.taskId);
        return;
      }
      if (dir === 'left' || dir === 'right') {
        const step = dir === 'left' ? -1 : 1;
        for (let offset = 1; offset < order.length; offset++) {
          const ni = (laneIdx + step * offset + order.length * 4) % order.length;
          const list = map[order[ni]];
          if (list.length === 0) continue;
          const niCard = Math.min(cardIdx, list.length - 1);
          onHighlightTask(list[niCard].taskId);
          return;
        }
      }
    },
    [tasks, selectedTaskId, onHighlightTask, runningTasks, completedTasks, terminatedTasks],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      // Only when focus is within the board (or nowhere interactive)
      const active = document.activeElement as HTMLElement | null;
      const inBoard = boardRef.current?.contains(active);
      const bodyFocus = active === document.body || active === document.documentElement;
      if (!inBoard && !bodyFocus) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection('down');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveSelection('left');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveSelection('right');
      } else if (e.key === 'Enter' && selectedTaskId) {
        e.preventDefault();
        onOpenTask(selectedTaskId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveSelection, selectedTaskId, onOpenTask]);

  const renderCard = (task: Task) => {
    const isSelected = task.taskId === selectedTaskId;
    const isRunning = task.status === 'RUNNING';
    const ink = statusInkClass(task.status);

    return (
      <div
        key={task.taskId}
        role="option"
        aria-selected={isSelected}
        tabIndex={isSelected ? 0 : -1}
        onClick={() => onOpenTask(task.taskId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenTask(task.taskId);
          }
        }}
        className={`group relative rounded-md px-3 py-2.5 transition-colors duration-150 cursor-pointer border text-left outline-none ${
          isRunning
            ? 'bg-surface border-live/30 hover:border-live/50'
            : 'bg-surface/90 border-line hover:border-line-strong hover:bg-surface-raised'
        } ${isSelected ? 'ring-1 ring-accent border-accent bg-accent/5' : ''}`}
      >
        {isRunning && (
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-live rounded-t-md" />
        )}

        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="min-w-0 flex items-baseline gap-1.5">
            {task.ticket ? (
              <span className="shrink-0 font-mono text-[10px] font-semibold text-accent-soft">
                {task.ticket}
              </span>
            ) : null}
            <h4 className="font-semibold text-xs text-ink line-clamp-1">
              {task.label || task.taskId}
            </h4>
          </div>
          <span
            className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${ink}`}
          >
            {statusShortLabel(task.status, lang)}
          </span>
        </div>

        <p className="text-[11px] text-ink-secondary font-mono line-clamp-2 leading-snug mb-2">
          {task.prompt}
        </p>

        <div className="flex items-center gap-1.5 text-[10px] text-ink-muted font-mono min-w-0">
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate" title={t.startedAt}>
            {formatShanghaiAbsolute(task.startTime)}
          </span>
          <span className="text-ink-faint">·</span>
          <span>{formatDuration(task.startTime, task.endTime)}</span>
          <span className="text-ink-faint">·</span>
          <span className="truncate">{task.adapter}</span>
        </div>
      </div>
    );
  };

  const renderLane = (
    title: string,
    count: number,
    bayClass: string,
    laneTasks: Task[],
    lane: LaneId,
    countTone: string,
  ) => (
    <div
      className="flex flex-col bg-surface/40 rounded-md border border-line overflow-hidden"
      role="group"
      aria-label={title}
    >
      <div className="border-b border-line/80 bg-surface/60">
        <div className="px-3 py-2.5 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold text-ink-secondary uppercase tracking-wider">
            {title}
          </h3>
          <span className={`px-1.5 py-0.5 rounded-sm text-[11px] font-mono font-medium ${countTone}`}>
            {count}
          </span>
        </div>
        <div className={`bay-mark ${bayClass}`} aria-hidden />
      </div>

      <div className="flex-1 p-3 overflow-y-auto space-y-2" role="listbox" aria-label={title}>
        {laneTasks.length === 0 ? (
          <div className="py-8 px-2 text-left">
            <p className="text-[11px] text-ink-faint leading-relaxed max-w-[16rem]">
              {emptyHint(lane)}
            </p>
          </div>
        ) : (
          laneTasks.map(renderCard)
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={boardRef}
      className="h-full flex flex-col p-4 md:p-6 overflow-hidden bg-page"
      tabIndex={-1}
      aria-label={t.kanbanTitle}
    >
      <div className="flex items-baseline justify-between mb-3 shrink-0 gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-sm text-ink tracking-tight">{t.kanbanTitle}</h2>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {t.kanbanSubtitle}
            <span className="text-ink-faint font-mono"> · {tasks.length}</span>
            <span className="text-ink-faint"> · {t.kanbanKeysHint}</span>
          </p>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 min-h-0 overflow-hidden">
        {renderLane(
          t.colRunning,
          runningTasks.length,
          'bay-mark-live',
          runningTasks,
          'running',
          'bg-live/10 text-live',
        )}
        {renderLane(
          t.colCompleted,
          completedTasks.length,
          'bay-mark-done',
          completedTasks,
          'completed',
          'bg-done/10 text-done',
        )}
        {renderLane(
          t.colTerminated,
          terminatedTasks.length,
          'bay-mark-warn',
          terminatedTasks,
          'terminated',
          'bg-surface-muted text-ink-secondary',
        )}
      </div>
    </div>
  );
};
