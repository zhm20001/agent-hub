import React, { useState, useEffect } from 'react';
import { useTaskData } from './hooks/use-task-data.ts';
import type { Task, Project } from './types.ts';
import { ProjectOverview } from './components/ProjectOverview.tsx';
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
  const { data: taskData, loading, refresh: fetchTasks } = useTaskData<Task[]>(
    'tasks', '/api/tasks?includeArchived=1', data => data?.some(task => task.status === 'RUNNING') ? 1500 : 3500,
  );
  const [showProjects, setShowProjects] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projectsData = useTaskData<Project[]>('projects', '/api/projects', () => 5000);
  const projects = projectsData.data ?? [];
  const selectedProject = projects.find(project => project.id === selectedProjectId);
  const tasks = (taskData ?? []).filter(task => !task.archived && (!selectedProjectId || task.projectId === selectedProjectId));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isDispatchOpen, setIsDispatchOpen] = useState<boolean>(false);
  useEffect(() => {
    const first = taskData?.find(task => !task.archived && (!selectedProjectId || task.projectId === selectedProjectId));
    if (first) setSelectedTaskId(current => current ?? first.taskId);
  }, [taskData, selectedProjectId]);

  const handleTaskDispatched = (newTaskId: string) => {
    fetchTasks();
    setSelectedTaskId(newTaskId);
    setViewMode('timeline');
    setShowProjects(false);
  };

  /** Kanban card → open resizable Master–Detail with that task (no drawer). */
  const handleSelectFromKanban = (taskId: string) => {
    setSelectedTaskId(taskId);
    setViewMode('timeline');
    setShowProjects(false);
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

  const selectedTask = (taskData ?? []).find(task => task.taskId === selectedTaskId && (!selectedProjectId || task.projectId === selectedProjectId)) || null;

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
        onSelectViewMode={mode => { setViewMode(mode); setShowProjects(false); }}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      <nav aria-label={lang === 'zh' ? '项目与任务' : 'Projects and tasks'} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 text-xs">
        <button type="button" aria-pressed={showProjects} onClick={() => setShowProjects(true)} className={`rounded-sm border px-3 py-2 hover:bg-page ${showProjects ? 'border-accent text-accent' : 'border-line'}`}>{lang === 'zh' ? '项目接续' : 'Projects'}</button>
        <button type="button" aria-pressed={!showProjects && !selectedProjectId} onClick={() => { setSelectedProjectId(null); setShowProjects(false); }} className={`rounded-sm border px-3 py-2 hover:bg-page ${!showProjects && !selectedProjectId ? 'border-accent text-accent' : 'border-line'}`}>{lang === 'zh' ? '全部任务' : 'All tasks'}</button>
        {selectedProject && <span className="text-ink-muted">{lang === 'zh' ? '当前项目：' : 'Project: '}{selectedProject.name}</span>}
      </nav>
      {showProjects ? <ProjectOverview projects={projects} loading={projectsData.loading} error={projectsData.error}
        selectedProjectId={selectedProjectId} onSelectProject={id => { setSelectedProjectId(id); setSelectedTaskId(null); }} onRefresh={projectsData.refresh}
        onOpenTasks={id => { setSelectedProjectId(id); setSelectedTaskId(null); setShowProjects(false); }}
        onOpenTask={handleSelectFromKanban}
        onDispatch={id => { setSelectedProjectId(id); setIsDispatchOpen(true); }} lang={lang} /> : viewMode === 'kanban' ? (
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
        projectId={selectedProjectId ?? undefined}
        cwd={selectedProject?.cwd}
      />
    </div>
  );
};
