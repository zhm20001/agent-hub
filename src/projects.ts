import { ProjectCheckpoints } from './project-checkpoints.ts';
import { randomUUID } from 'node:crypto';
import type { TaskStore } from './runner/task-store.ts';
import type { TaskMeta } from './runner/task-types.ts';

export interface Project {
  id: string;
  name: string;
  goal: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
}
export interface ProjectNote {
  id: string;
  projectId: string;
  body: string;
  author: string;
  sourceTaskIds: string[];
  createdAt: number;
  sequence: number;
}
export interface ProjectContext {
  project: Project;
  latestNote: ProjectNote | null;
  notes: ProjectNote[];
  tasks: TaskMeta[];
  checkpoint: ReturnType<ProjectCheckpoints['latest']>;
  notesPage: { total: number; truncated: boolean };
  changesSinceVisit: { after: number; through: number; notes: ProjectNote[]; tasks: TaskMeta[] };
}
export class ProjectError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'ProjectError'; }
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProjectError(`${field} must be non-empty text (maximum ${max} characters)`);
  return value.trim();
}
function id(value: unknown): string {
  const result = text(value, 'id', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw new ProjectError('Invalid project id');
  return result;
}
function cursor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ProjectError(`${field} must be a non-negative integer cursor`);
  return Number(value);
}

/** Project intent and append-only handovers; execution facts remain owned by TaskStore. */
export class ProjectStore {
  private initialized = false;
  readonly checkpoints: ProjectCheckpoints;
  constructor(private readonly store: TaskStore) { this.checkpoints = new ProjectCheckpoints(store, id => this.get(id)); }
  private get db() {
    const database = this.store.database;
    if (this.initialized) return database;
    database.exec(`
      CREATE TABLE IF NOT EXISTS hub_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, cwd TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_project_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_project_events_project ON hub_project_events(project_id, sequence);
      CREATE TABLE IF NOT EXISTS hub_project_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, source_task_ids TEXT NOT NULL, created_at INTEGER NOT NULL, sequence INTEGER NOT NULL, request_key TEXT, request_body TEXT, UNIQUE(project_id, request_key));
      CREATE TABLE IF NOT EXISTS hub_project_task_snapshots (project_id TEXT NOT NULL, task_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(project_id,task_id));
      CREATE TABLE IF NOT EXISTS hub_project_visits (project_id TEXT NOT NULL, viewer_id TEXT NOT NULL, through_sequence INTEGER NOT NULL, PRIMARY KEY(project_id,viewer_id));
    `);
    this.initialized = true;
    return database;
  }
  private transaction<T>(action: () => T): T {
    this.store.list(); // Import legacy task files before beginning the project transaction.
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(projectId: string, kind: string, objectId: string, body: unknown): number {
    return Number(this.db.prepare('INSERT INTO hub_project_events(project_id,kind,object_id,body) VALUES (?,?,?,?)').run(projectId, kind, objectId, JSON.stringify(body)).lastInsertRowid);
  }
  private require(projectId: string): Project {
    const project = this.get(projectId);
    if (!project) throw new ProjectError(`Project not found: ${projectId}`, 404);
    return project;
  }
  get(projectId: string): Project | null {
    const row = this.db.prepare('SELECT * FROM hub_projects WHERE id=?').get(id(projectId));
    return row ? { id: String(row.id), name: String(row.name), goal: String(row.goal), ...(row.cwd ? { cwd: String(row.cwd) } : {}), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) } : null;
  }
  upsert(input: { id: string; name: string; goal: string; cwd?: string }): Project {
    const projectId = id(input.id), name = text(input.name, 'name', 200), goal = text(input.goal, 'goal', 20000);
    const cwd = input.cwd === undefined ? null : text(input.cwd, 'cwd', 4096);
    return this.transaction(() => {
      const previous = this.get(projectId), now = Date.now();
      this.db.prepare(`INSERT INTO hub_projects(id,name,goal,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,goal=excluded.goal,cwd=excluded.cwd,updated_at=excluded.updated_at`).run(projectId, name, goal, cwd, previous?.createdAt ?? now, now);
      return this.get(projectId)!;
    });
  }
  list(): Array<Project & { latestNote: ProjectNote | null; taskCount: number; runningCount: number }> {
    return this.db.prepare('SELECT id FROM hub_projects ORDER BY updated_at DESC,id').all().map(row => {
      const context = this.context(String(row.id));
      return { ...context.project, latestNote: context.latestNote, taskCount: context.tasks.length, runningCount: context.tasks.filter(task => task.status === 'RUNNING').length };
    });
  }
  appendNote(projectId: string, input: { body: string; author?: string; sourceTaskIds?: string[]; request_key?: string }): ProjectNote {
    id(projectId);
    const body = text(input.body, 'body', 40000), author = input.author === undefined ? 'unspecified' : text(input.author, 'author', 200);
    const key = input.request_key === undefined ? null : text(input.request_key, 'request_key', 200);
    if (input.sourceTaskIds !== undefined && (!Array.isArray(input.sourceTaskIds) || input.sourceTaskIds.length > 100 || input.sourceTaskIds.some(value => typeof value !== 'string' || !value || value.length > 200))) throw new ProjectError('sourceTaskIds must contain up to 100 task ids');
    const sourceTaskIds = [...new Set(input.sourceTaskIds ?? [])].sort();
    const requestBody = JSON.stringify({ body, author, sourceTaskIds });
    return this.transaction(() => {
      this.require(projectId);
      if (key !== null) {
        const previous = this.db.prepare('SELECT * FROM hub_project_notes WHERE project_id=? AND request_key=?').get(projectId, key);
        if (previous) {
          if (previous.request_body !== requestBody) throw new ProjectError('request_key conflict: this key belongs to different note content', 409);
          return this.note(previous);
        }
      }
      for (const taskId of sourceTaskIds) {
        const task = this.store.read(taskId);
        if (!task) throw new ProjectError(`Source task not found: ${taskId}`);
        if (task.projectId !== projectId) throw new ProjectError(`Source task ${taskId} does not belong to project ${projectId}`);
      }
      const noteId = randomUUID(), createdAt = Date.now();
      const sequence = this.event(projectId, 'note', noteId, { body });
      this.db.prepare('INSERT INTO hub_project_notes(id,project_id,body,author,source_task_ids,created_at,sequence,request_key,request_body) VALUES (?,?,?,?,?,?,?,?,?)').run(noteId, projectId, body, author, JSON.stringify(sourceTaskIds), createdAt, sequence, key, requestBody);
      this.db.prepare('UPDATE hub_projects SET updated_at=? WHERE id=?').run(createdAt, projectId);
      return { id: noteId, projectId, body, author, sourceTaskIds, createdAt, sequence };
    });
  }
  private note(row: Record<string, unknown>): ProjectNote {
    return { id: String(row.id), projectId: String(row.project_id), body: String(row.body), author: String(row.author), sourceTaskIds: JSON.parse(String(row.source_task_ids)), createdAt: Number(row.created_at), sequence: Number(row.sequence) };
  }
  private synchronizeTasks(projectId: string): TaskMeta[] {
    const tasks = this.store.list().filter(task => task.projectId === projectId).sort((a, b) => b.startTime - a.startTime || a.taskId.localeCompare(b.taskId));
    for (const task of tasks) {
      // Only user-relevant mechanical facts create changes; transcript discovery does not.
      const fingerprint = JSON.stringify({ status: task.status, endTime: task.endTime, exitCode: task.exitCode, archived: !!task.archived, label: task.label, error: task.error });
      const old = this.db.prepare('SELECT fingerprint FROM hub_project_task_snapshots WHERE project_id=? AND task_id=?').get(projectId, task.taskId);
      if (old?.fingerprint !== fingerprint) {
        this.event(projectId, 'task', task.taskId, task);
        this.db.prepare('INSERT INTO hub_project_task_snapshots(project_id,task_id,fingerprint) VALUES (?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET fingerprint=excluded.fingerprint').run(projectId, task.taskId, fingerprint);
      }
    }
    return tasks;
  }
  context(projectId: string, options: { after?: number; limit?: number; viewerId?: string } = {}): ProjectContext {
    const limit = options.limit === undefined ? 20 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProjectError('limit must be between 1 and 100');
    const viewer = options.viewerId === undefined ? 'local' : text(options.viewerId, 'viewerId', 200);
    if (options.after !== undefined) cursor(options.after, 'after');
    return this.transaction(() => {
      const project = this.require(projectId), tasks = this.synchronizeTasks(projectId);
      const visit = this.db.prepare('SELECT through_sequence FROM hub_project_visits WHERE project_id=? AND viewer_id=?').get(projectId, viewer);
      const after = options.after ?? Number(visit?.through_sequence ?? 0);
      const through = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM hub_project_events WHERE project_id=?').get(projectId)!.n);
      if (after > through) throw new ProjectError('after cursor exceeds current project progress');
      const notes = this.db.prepare('SELECT * FROM hub_project_notes WHERE project_id=? ORDER BY sequence DESC LIMIT ?').all(projectId, limit).map(row => this.note(row));
      const changedIds = new Set(this.db.prepare("SELECT DISTINCT object_id FROM hub_project_events WHERE project_id=? AND kind='task' AND sequence>? AND sequence<=?").all(projectId, after, through).map(row => String(row.object_id)));
      const changedNotes = this.db.prepare('SELECT * FROM hub_project_notes WHERE project_id=? AND sequence>? AND sequence<=? ORDER BY sequence DESC').all(projectId, after, through).map(row => this.note(row));
      const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM hub_project_notes WHERE project_id=?').get(projectId)!.count);
      return { project, checkpoint: this.checkpoints.latest(projectId), notesPage: { total, truncated: notes.length < total }, latestNote: notes[0] ?? null, notes, tasks, changesSinceVisit: { after, through, notes: changedNotes, tasks: tasks.filter(task => changedIds.has(task.taskId)) } };
    });
  }
  markSeen(projectId: string, options: { viewerId?: string; through?: number } = {}): { through: number } {
    const viewer = options.viewerId === undefined ? 'local' : text(options.viewerId, 'viewerId', 200);
    if (options.through !== undefined) cursor(options.through, 'through');
    return this.transaction(() => {
      this.require(projectId);
      this.synchronizeTasks(projectId);
      const current = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM hub_project_events WHERE project_id=?').get(projectId)!.n);
      const through = options.through ?? current;
      if (through > current) throw new ProjectError('through cursor exceeds current project progress');
      this.db.prepare('INSERT INTO hub_project_visits(project_id,viewer_id,through_sequence) VALUES (?,?,?) ON CONFLICT(project_id,viewer_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)').run(projectId, viewer, through);
      return { through: Number(this.db.prepare('SELECT through_sequence FROM hub_project_visits WHERE project_id=? AND viewer_id=?').get(projectId, viewer)!.through_sequence) };
    });
  }
}
