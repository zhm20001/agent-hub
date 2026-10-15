import React, { useState, useEffect } from 'react';
import { Terminal, FileCheck, GitBranch, Code2, Ban, RefreshCw, Folder, MessagesSquare, Archive } from 'lucide-react';
import { useTaskData } from '../hooks/use-task-data.ts';
import type { Task, TaskDetailData } from '../types.ts';
import { translations, type Language } from '../i18n.ts';
import { TerminalView } from './TerminalView.tsx';
import { ReportView } from './ReportView.tsx';
import { DiffView } from './DiffView.tsx';
import { ConversationView } from './ConversationView.tsx';

interface TaskDetailProps {
  task: Task;
  onRefresh: () => void;
  /** Soft-archive: hide from board without deleting runs. */
  onArchive?: (taskId: string) => void;
  lang: Language;
}

/** Report first; terminal + VCS (jj) last. */
type TabType = 'report' | 'conversation' | 'json' | 'terminal' | 'vcs';

const TABS: TabType[] = ['report', 'conversation', 'json', 'terminal', 'vcs'];

export const TaskDetail: React.FC<TaskDetailProps> = ({ task, onRefresh, onArchive, lang }) => {
  const t = translations[lang];
  const [activeTab, setActiveTab] = useState<TabType>('report');
  const { data: detailData, refresh: fetchDetail } = useTaskData<TaskDetailData>(
    `${task.taskId}:${task.status}`, `/api/tasks/${encodeURIComponent(task.taskId)}`,
    data => !data || data.status === 'RUNNING' ? 3000 : null,
  );
  const [isKilling, setIsKilling] = useState<boolean>(false);

  useEffect(() => { setActiveTab('report'); }, [task.taskId]);

  const handleKill = async () => {
    const confirmMsg = t.confirmKill.replace('{taskId}', task.taskId).replace('{pid}', String(task.pid || ''));
    if (!confirm(confirmMsg)) return;
    setIsKilling(true);
    try {
      await fetch(`/api/tasks/${task.taskId}/kill`, { method: 'POST' });
      fetchDetail();
      onRefresh();
    } catch {}
    setIsKilling(false);
  };

  const currentTask = detailData || task;

  const tabLabel = (tab: TabType): string => {
    switch (tab) {
      case 'report':
        return t.tabReport;
      case 'conversation':
        return t.tabConversation;
      case 'json':
        return t.tabJson;
      case 'terminal':
        return t.tabTerminal;
      case 'vcs':
        return t.tabVcs;
    }
  };

  const tabIcon = (tab: TabType) => {
    const cls = 'h-3.5 w-3.5';
    switch (tab) {
      case 'report':
        return <FileCheck className={cls} />;
      case 'conversation':
        return <MessagesSquare className={cls} />;
      case 'json':
        return <Code2 className={cls} />;
      case 'terminal':
        return <Terminal className={cls} />;
      case 'vcs':
        return <GitBranch className={cls} />;
    }
  };

  return (
    <div className="flex flex-col h-full bg-page overflow-hidden">
      <div className="px-6 py-3.5 border-b border-line bg-surface/40 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {currentTask.ticket && (
            <span className="px-2 py-0.5 rounded-sm bg-accent/15 text-accent-soft font-mono text-xs font-semibold border border-accent/30">
              {currentTask.ticket}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink truncate flex items-center gap-2">
              <span>{currentTask.label || currentTask.taskId}</span>
              <span className="text-xs font-mono text-ink-muted font-normal">({currentTask.taskId})</span>
            </h2>
            <div className="flex items-center gap-2 text-[11px] text-ink-secondary font-mono mt-0.5">
              <span className="flex items-center gap-1">
                <Folder className="h-3 w-3 text-ink-muted" />
                <span className="truncate max-w-xs">{currentTask.cwd}</span>
              </span>
              {currentTask.pid && <span>• {t.pid} {currentTask.pid}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {currentTask.status === 'RUNNING' && (
            <button
              onClick={handleKill}
              disabled={isKilling}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-danger/20 hover:bg-danger/30 text-danger border border-danger/30 text-xs font-medium transition-all"
            >
              <Ban className="h-3.5 w-3.5" />
              <span>{isKilling ? t.killing : t.killProcess}</span>
            </button>
          )}

          {onArchive ? (
            <button
              type="button"
              onClick={() => onArchive(currentTask.taskId)}
              title={t.archiveTaskTitle}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-surface-muted hover:bg-line-strong text-ink-secondary hover:text-ink border border-line text-xs font-medium transition-colors"
            >
              <Archive className="h-3.5 w-3.5" />
              <span>{t.archiveTask}</span>
            </button>
          ) : null}

          <button
            onClick={() => {
              fetchDetail();
              onRefresh();
            }}
            title={t.refreshDetail}
            className="p-1.5 rounded-sm bg-surface-muted hover:bg-line-strong text-ink-secondary hover:text-ink transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 px-6 border-b border-line bg-surface/20 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-2 px-3 py-2.5 text-xs font-medium border-b-2 transition-all shrink-0 ${
              activeTab === tab
                ? 'border-accent text-accent-soft font-semibold'
                : 'border-transparent text-ink-secondary hover:text-ink'
            }`}
          >
            {tabIcon(tab)}
            <span>{tabLabel(tab)}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'report' && <ReportView task={currentTask} lang={lang} />}
        {activeTab === 'conversation' && <ConversationView task={currentTask} lang={lang} />}
        {activeTab === 'json' && (
          <div className="h-full p-4 overflow-y-auto bg-page font-mono text-xs">
            <pre className="p-4 rounded-sm bg-surface border border-line text-accent-soft">
              {JSON.stringify(currentTask, null, 2)}
            </pre>
          </div>
        )}
        {activeTab === 'terminal' && (
          <TerminalView taskId={currentTask.taskId} isLive={currentTask.status === 'RUNNING'} lang={lang} />
        )}
        {activeTab === 'vcs' && <DiffView taskId={currentTask.taskId} lang={lang} />}
      </div>
    </div>
  );
};
