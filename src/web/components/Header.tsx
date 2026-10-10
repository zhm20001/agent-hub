import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Activity,
  CheckCircle2,
  ShieldAlert,
  RefreshCw,
  Layers,
  Languages,
  LayoutGrid,
  Columns2,
  MoreHorizontal,
  Sun,
  Moon,
} from 'lucide-react';
import type { Task } from '../types.ts';
import { translations, type Language } from '../i18n.ts';
import type { ThemeMode } from '../lib/theme.ts';

interface HeaderProps {
  tasks: Task[];
  onOpenDispatch: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  lang: Language;
  onToggleLang: () => void;
  viewMode: 'kanban' | 'timeline';
  onSelectViewMode: (mode: 'kanban' | 'timeline') => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  tasks,
  onOpenDispatch,
  onRefresh,
  isLoading,
  lang,
  onToggleLang,
  viewMode,
  onSelectViewMode,
  theme,
  onToggleTheme,
}) => {
  const t = translations[lang];
  const runningCount = tasks.filter((task) => task.status === 'RUNNING').length;
  const completedCount = tasks.filter((task) => task.status === 'COMPLETED').length;
  const failedCount = tasks.filter(
    (task) => task.status === 'FAILED' || task.status === 'TIMEOUT_KILLED'
  ).length;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <header className="border-b border-line bg-surface px-6 py-3 sticky top-0 z-30 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="h-7 w-7 rounded-sm bg-accent flex items-center justify-center text-cta shrink-0"
            aria-hidden
          >
            <Layers className="h-3.5 w-3.5" strokeWidth={2.25} />
          </div>
          <div className="min-w-0 text-left">
            <h1 className="font-semibold text-[15px] tracking-tight text-ink truncate">
              {t.appName}
              <span className="ml-2 text-[10px] font-medium tracking-wide uppercase text-ink-muted">
                {theme === "light" ? t.badgeLight : t.badgeDark}
              </span>
            </h1>
            <p className="text-[11px] text-ink-muted truncate">{t.subtitle}</p>
          </div>
        </div>

        <div className="hidden md:flex items-center gap-3 ml-4 pl-4 border-l border-line text-[11px]">
          <span className="flex items-center gap-1.5 text-ink-secondary">
            <Activity
              className={`h-3 w-3 ${runningCount > 0 ? 'text-live' : 'text-ink-faint'}`}
            />
            <span className="text-ink-muted">{t.running}</span>
            <span className="font-semibold tabular-nums text-ink">{runningCount}</span>
          </span>
          <span className="flex items-center gap-1.5 text-ink-secondary">
            <CheckCircle2 className="h-3 w-3 text-done" />
            <span className="text-ink-muted">{t.done}</span>
            <span className="font-semibold tabular-nums text-ink">{completedCount}</span>
          </span>
          {failedCount > 0 && (
            <span className="flex items-center gap-1.5 text-danger">
              <ShieldAlert className="h-3 w-3" />
              <span>{t.errors}</span>
              <span className="font-semibold tabular-nums">{failedCount}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div
          className="flex items-center border border-line rounded-sm p-0.5 bg-page"
          role="group"
          aria-label={t.viewModeLabel}
        >
          <button
            type="button"
            onClick={() => onSelectViewMode('kanban')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[11px] font-medium transition-colors ${
              viewMode === 'kanban'
                ? 'bg-surface-muted text-ink'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.viewKanban}</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectViewMode('timeline')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[11px] font-medium transition-colors ${
              viewMode === 'timeline'
                ? 'bg-surface-muted text-ink'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.viewTimeline}</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          title={theme === 'light' ? t.themeToDark : t.themeToLight}
          className="p-2 rounded-sm border border-line text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
          aria-label={theme === 'light' ? t.themeToDark : t.themeToLight}
        >
          {theme === 'light' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </button>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="p-2 rounded-sm border border-line text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t.moreActions}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="ah-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="ah-menu-item"
                onClick={() => {
                  onToggleLang();
                  setMenuOpen(false);
                }}
              >
                <Languages className="h-3.5 w-3.5 text-ink-muted" />
                <span>{t.langToggle}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ah-menu-item"
                disabled={isLoading}
                onClick={() => {
                  onRefresh();
                  setMenuOpen(false);
                }}
              >
                <RefreshCw className={`h-3.5 w-3.5 text-ink-muted ${isLoading ? 'animate-spin' : ''}`} />
                <span>{t.refreshRoster}</span>
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenDispatch}
          className="flex items-center gap-2 px-3.5 py-2 rounded-sm bg-accent hover:bg-accent-bright active:bg-accent-dim text-cta font-medium text-xs transition-colors"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
          <span>{t.dispatchSubagent}</span>
        </button>
      </div>
    </header>
  );
};
