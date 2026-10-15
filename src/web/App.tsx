import React, { useState, useEffect } from 'react';
import type { Task } from './types.ts';
import { translations, type Language } from './i18n.ts';
import { Header } from './components/Header.tsx';
import { TaskTimeline } from './components/TaskTimeline.tsx';
import { TaskDetail } from './components/TaskDetail.tsx';
import { DispatchModal } from './components/DispatchModal.tsx';
import { KanbanBoard } from './components/KanbanBoard.tsx';
import { ResizableSplit } from './components/ResizableSplit.tsx';
import { Cpu, Play } from 'lucide-react';
import {
  applyTheme,
  readStoredTheme,
  toggleTheme,
  type ThemeMode,
} from './lib/theme.ts';

export const App: React.FC = () => {
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem('dsh_swarm_lang');
    return saved === 'en' || saved === 'zh' ? saved : 'zh';
  });

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const mode = readStoredTheme();
    applyTheme(mode);
    return mode;
  });

  const [viewMode, setViewMode] = useState<'kanban' | 'timeline'>('kanban');

  const toggleLang = () => {
    setLang((prev) => {
      const next = prev === 'zh' ? 'en' : 'zh';
      localStorage.setItem('dsh_swarm_lang', next);
      return next;
    });
  };

  const handleToggleTheme = () => {
    setTheme((prev) => toggleTheme(prev));
  };

  const t = translations[lang];
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isDispatchOpen, setIsDispatchOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (res.ok) {
        const data: Task[] = await res.json();
        setTasks(data);
        if (data.length > 0 && !selectedTaskId) {
          setSelectedTaskId(data[0].taskId);
        }
      }
    } catch (err) {
      console.error('Failed to load tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    const hasRunningTasks = tasks.some((task) => task.status === 'RUNNING');
    const intervalTime = hasRunningTasks ? 1500 : 3500;
    const interval = setInterval(fetchTasks, intervalTime);
    return () => clearInterval(interval);
  }, [tasks]);

  const handleTaskDispatched = (newTaskId: string) => {
    fetchTasks();
    setSelectedTaskId(newTaskId);
    setViewMode('timeline');
  };

  /** Kanban card → open resizable Master–Detail with that task (no drawer). */
  const handleSelectFromKanban = (taskId: string) => {
    setSelectedTaskId(taskId);
    setViewMode('timeline');
  };

  /** Soft-archive: persist meta.archived and drop from default roster. */
  const handleArchiveTask = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) return;
      if (selectedTaskId === taskId) setSelectedTaskId(null);
      await fetchTasks();
    } catch (err) {
      console.error('Failed to archive task:', err);
    }
  };

  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId) || null;

  return (
    <div className="flex flex-col h-screen w-screen bg-page text-ink overflow-hidden font-sans">
      <Header
        tasks={tasks}
        onOpenDispatch={() => setIsDispatchOpen(true)}
        onRefresh={fetchTasks}
        isLoading={loading}
        lang={lang}
        onToggleLang={toggleLang}
        viewMode={viewMode}
        onSelectViewMode={setViewMode}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      {viewMode === 'kanban' ? (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <KanbanBoard
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onHighlightTask={setSelectedTaskId}
            onOpenTask={handleSelectFromKanban}
            onArchiveTask={handleArchiveTask}
            lang={lang}
          />
        </div>
      ) : (
        <ResizableSplit
          left={
            <TaskTimeline
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              lang={lang}
            />
          }
          right={
            selectedTask ? (
              <TaskDetail
                task={selectedTask}
                onRefresh={fetchTasks}
                onArchive={handleArchiveTask}
                lang={lang}
              />
            ) : (
              <div className="h-full flex flex-col items-start justify-center p-8 bg-page">
                <div className="h-10 w-10 rounded-sm bg-surface border border-line flex items-center justify-center text-accent-soft mb-4">
                  <Cpu className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-sm text-ink mb-1 text-left">{t.noTaskSelectedTitle}</h3>
                <p className="text-xs text-ink-muted max-w-sm mb-6 leading-relaxed text-left">
                  {t.noTaskSelectedDesc}
                </p>
                <button
                  type="button"
                  onClick={() => setIsDispatchOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-sm bg-accent hover:bg-accent-bright text-cta font-medium text-xs transition-colors"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>{t.launchFirstTask}</span>
                </button>
              </div>
            )
          }
        />
      )}

      <DispatchModal
        isOpen={isDispatchOpen}
        onClose={() => setIsDispatchOpen(false)}
        onDispatched={handleTaskDispatched}
        lang={lang}
      />
    </div>
  );
};
