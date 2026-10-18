import React, { useEffect, useRef, useState } from 'react';
import type { Project, ProjectContext } from '../types.ts';
import type { Language } from '../i18n.ts';
import { useTaskData } from '../hooks/use-task-data.ts';

const field = 'w-full rounded-sm border border-line bg-page p-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent';
const button = 'rounded-sm border border-line px-3 py-2 text-xs hover:bg-surface disabled:opacity-50';
function useMutation() {
  const controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => controller.current?.abort(), []);
  async function post(path: string, body: unknown): Promise<boolean> {
    if (controller.current) return false;
    const current = new AbortController();
    controller.current = current;
    setPending(true); setError('');
    try {
      const response = await fetch(path, { method: 'POST', signal: current.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      return true;
    } catch (error) {
      if (!current.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (!current.signal.aborted) setPending(false);
      if (controller.current === current) controller.current = null;
    }
  }
  return { post, pending, error };
}

interface Props {
  projects: Project[];
  loading: boolean;
  error?: string;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onRefresh: () => void;
  onOpenTasks: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onDispatch: (id: string) => void;
  lang: Language;
}
export function ProjectOverview(props: Props) {
  const zh = props.lang === 'zh';
  const [creating, setCreating] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState('');
  const mutation = useMutation();
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (await mutation.post('/api/projects', { id: projectId, name, goal, cwd: cwd.trim() || undefined })) {
      props.onRefresh(); props.onSelectProject(projectId.trim()); setCreating(false);
      setProjectId(''); setName(''); setGoal(''); setCwd('');
    }
  }
  return <main className="flex-1 min-h-0 overflow-auto p-4 md:p-6" aria-label={zh ? '项目接续' : 'Project handovers'}>
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-lg font-semibold">{zh ? '从上次停下的地方继续' : 'Pick up where you left off'}</h1>
          <p className="mt-1 text-sm text-ink-muted">{zh ? '保留目标、接续说明和相关任务；结论由你和主 Agent 记录。' : 'Keep goals, handovers and related tasks together. You and your lead agent record the conclusions.'}</p></div>
        <button type="button" className={button} onClick={() => setCreating(value => !value)}>{creating ? (zh ? '收起' : 'Close') : (zh ? '登记项目' : 'Add project')}</button>
      </div>
      {(props.error || mutation.error) && <p role="alert" className="mb-3 text-sm text-red-500">{props.error || mutation.error}</p>}
      {creating && <form onSubmit={create} className="mb-5 grid gap-3 rounded-sm border border-line bg-surface p-4 md:grid-cols-2">
        <label className="text-xs">{zh ? '项目编号（字母、数字、点、短横线）' : 'Project ID (letters, digits, dots, hyphens)'}<input required maxLength={100} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" value={projectId} onChange={e => setProjectId(e.target.value)} className={field} /></label>
        <label className="text-xs">{zh ? '项目名称' : 'Name'}<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} className={field} /></label>
        <label className="text-xs md:col-span-2">{zh ? '目标与约束' : 'Goal and constraints'}<textarea required maxLength={20000} rows={3} value={goal} onChange={e => setGoal(e.target.value)} className={field} /></label>
        <label className="text-xs md:col-span-2">{zh ? '默认工作目录（选填）' : 'Default working directory (optional)'}<input maxLength={4096} value={cwd} onChange={e => setCwd(e.target.value)} className={field} /></label>
        <button disabled={mutation.pending} className={`${button} justify-self-start`} type="submit">{mutation.pending ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存项目' : 'Save project')}</button>
      </form>}
      {props.loading && !props.projects.length && <p role="status" className="text-sm text-ink-muted">{zh ? '正在读取项目…' : 'Loading projects…'}</p>}
      {!props.loading && !props.projects.length && <p className="rounded-sm border border-dashed border-line p-6 text-sm text-ink-muted">{zh ? '先登记一个正在推进的项目，再留下几句下次回来时需要知道的话。已有任务仍可从“全部任务”查看。' : 'Add a project, then leave a few notes for your next visit. Existing tasks remain under All tasks.'}</p>}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {props.projects.map(project => <button type="button" key={project.id} aria-pressed={props.selectedProjectId === project.id} onClick={() => props.onSelectProject(project.id)} className={`min-w-0 rounded-sm border p-4 text-left hover:bg-surface ${props.selectedProjectId === project.id ? 'border-accent bg-surface' : 'border-line'}`}>
          <h2 className="truncate text-sm font-semibold">{project.name}</h2>
          <p className="mt-2 line-clamp-2 text-xs text-ink-muted whitespace-pre-wrap break-words">{project.latestNote?.body || project.goal}</p>
          <p className="mt-3 text-xs text-ink-muted">{zh ? `${project.taskCount ?? 0} 个任务 · ${project.runningCount ?? 0} 个运行中` : `${project.taskCount ?? 0} tasks · ${project.runningCount ?? 0} running`}</p>
        </button>)}
      </div>
      {props.selectedProjectId && <ProjectDetail key={props.selectedProjectId} id={props.selectedProjectId} {...props} />}
    </div>
  </main>;
}
function ProjectDetail(props: Props & { id: string }) {
  const zh = props.lang === 'zh';
  const { data, error, loading, refresh } = useTaskData<ProjectContext>(`project:${props.id}`, `/api/projects/${encodeURIComponent(props.id)}/context?viewerId=local`, () => 5000);
  const [body, setBody] = useState('');
  const keyRef = useRef(crypto.randomUUID());
  const mutation = useMutation();
  async function addNote(event: React.FormEvent) {
    event.preventDefault();
    if (await mutation.post(`/api/projects/${encodeURIComponent(props.id)}/notes`, { body, author: 'operator', request_key: keyRef.current })) {
      setBody(''); keyRef.current = crypto.randomUUID(); refresh(); props.onRefresh();
    }
  }
  async function seen() {
    if (data && await mutation.post(`/api/projects/${encodeURIComponent(props.id)}/seen`, { viewerId: 'local', through: data.changesSinceVisit.through })) refresh();
  }
  if (!data) return <p role={error ? 'alert' : 'status'} className="text-sm text-ink-muted">{error || (loading ? (zh ? '正在读取接续资料…' : 'Loading context…') : '')}</p>;
  const changes = data.changesSinceVisit;
  return <section className="rounded-sm border border-line bg-surface p-4 md:p-5">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{data.project.name}</h2><p className="mt-1 text-xs text-ink-muted break-all">{data.project.cwd}</p></div>
      <div className="flex gap-2"><button className={button} type="button" onClick={() => props.onOpenTasks(props.id)}>{zh ? '查看任务' : 'View tasks'}</button><button className={button} type="button" onClick={() => props.onDispatch(props.id)}>{zh ? '派发任务' : 'Dispatch'}</button></div></div>
    {(error || mutation.error) && <p role="alert" className="mb-3 text-sm text-red-500">{error || mutation.error}</p>}
    <h3 className="text-xs font-semibold text-ink-muted">{zh ? '目标与约束' : 'Goal and constraints'}</h3><p className="mt-2 mb-5 text-sm whitespace-pre-wrap break-words">{data.project.goal}</p>
    <div className="mb-5 rounded-sm border border-line p-3"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{zh ? '自上次确认以来' : 'Since your last review'}</h3><button className={button} disabled={mutation.pending} type="button" onClick={seen}>{zh ? '确认已读到这里' : 'Mark reviewed through here'}</button></div>
      <p className="mt-2 text-xs text-ink-muted">{zh ? `${changes.notes.length} 条接续记录 · ${changes.tasks.length} 个任务有变化` : `${changes.notes.length} handovers · ${changes.tasks.length} changed tasks`}</p>
      {changes.tasks.map(task => <button key={task.taskId} type="button" onClick={() => props.onOpenTask(task.taskId)} className="mt-2 block text-left text-xs underline">{task.label || task.taskId} · {task.status}</button>)}
    </div>
    <h3 className="mb-3 text-sm font-semibold">{zh ? '接续记录' : 'Handovers'}</h3>
    <p className="mb-3 text-xs text-ink-muted">{zh ? '记录已确认的结论、尚未验证的部分和下一步建议。保留历史，不覆盖项目目标。' : 'Record confirmed findings, open questions and next steps. Notes preserve history and keep the goal separate.'}</p>
    <form onSubmit={addNote} className="mb-5"><label className="sr-only" htmlFor={`note-${props.id}`}>{zh ? '新增接续记录' : 'New handover'}</label><textarea id={`note-${props.id}`} className={field} rows={4} maxLength={40000} required disabled={mutation.pending} value={body} onChange={event => { setBody(event.target.value); keyRef.current = crypto.randomUUID(); }} placeholder={zh ? '下次回来时，你或主 Agent 应该先知道什么？' : 'What should you or the lead agent know next time?'} /><button className={`${button} mt-2`} disabled={mutation.pending || !body.trim()} type="submit">{mutation.pending ? (zh ? '保存中…' : 'Saving…') : (zh ? '追加记录' : 'Add handover')}</button></form>
    {!data.notes.length && <p className="text-sm text-ink-muted">{zh ? '还没有接续记录。' : 'No handover yet.'}</p>}
    <div className="space-y-4">{data.notes.map(note => <article key={note.id} className="border-t border-line pt-3"><p className="mb-2 text-xs text-ink-muted">{new Date(note.createdAt).toLocaleString()} · {note.author}</p><p className="text-sm whitespace-pre-wrap break-words">{note.body}</p>{!!note.sourceTaskIds.length && <div className="mt-2 flex flex-wrap gap-2">{note.sourceTaskIds.map(taskId => <button className="text-xs underline" key={taskId} type="button" onClick={() => props.onOpenTask(taskId)}>{taskId}</button>)}</div>}</article>)}</div>
  </section>;
}
