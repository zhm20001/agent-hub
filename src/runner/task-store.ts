import { mkdirSync, readdirSync, readFileSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite, readJson, withFileLock } from './file-storage.ts';
import type { TaskMeta } from './task-types.ts';

export interface TaskEvent { seq: number; taskId: string; type: string; payload: unknown; createdAt: number }

/** SQLite owns registered state; JSON remains a readable compatibility artifact. */
export class TaskStore {
  readonly runsDir: string;
  private connection?: DatabaseSync;
  get database(): DatabaseSync {
    if (this.connection) return this.connection;
    this.ensure();
    const db = new DatabaseSync(join(this.runsDir, 'hub.sqlite'));
    try {
      db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS completion_once ON task_events(task_id) WHERE type='completion';
      CREATE TABLE IF NOT EXISTS dispatch_requests (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumer_cursors (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    `);
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
    this.connection = db;
    return db;
  }
  close(): void { this.connection?.close(); this.connection = undefined; }
  private save(meta: TaskMeta, type: string): void {
    const db = this.database;
    db.exec('SAVEPOINT task_meta_write');
    try {
      db.prepare('INSERT INTO tasks(id,meta) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta').run(meta.taskId, JSON.stringify(meta));
      this.appendEvent(meta.taskId, type, meta);
      db.exec('RELEASE task_meta_write');
    } catch (error) { db.exec('ROLLBACK TO task_meta_write'); db.exec('RELEASE task_meta_write'); throw error; }
  }
  appendEvent(taskId: string, type: string, payload: unknown): number {
    if (type === 'completion') {
      const existing = this.database.prepare("SELECT seq FROM task_events WHERE task_id=? AND type='completion'").get(taskId);
      if (existing) return Number(existing.seq);
    }
    return Number(this.database.prepare('INSERT OR IGNORE INTO task_events(task_id,type,payload,created_at) VALUES (?,?,?,?)').run(taskId, type, JSON.stringify(payload), Date.now()).lastInsertRowid);
  }
  events(options: { after?: number; taskId?: string; limit?: number } = {}): TaskEvent[] {
    if (!existsSync(this.runsDir)) return [];
    const limit = Math.min(10000, Math.max(1, Math.floor(options.limit ?? 1000)));
    const rows = this.database.prepare('SELECT * FROM task_events WHERE seq > ? AND (? IS NULL OR task_id = ?) ORDER BY seq LIMIT ?').all(options.after ?? 0, options.taskId ?? null, options.taskId ?? null, limit);
    return rows.map(row => ({ seq: Number(row.seq), taskId: String(row.task_id), type: String(row.type), payload: JSON.parse(String(row.payload)), createdAt: Number(row.created_at) }));
  }
  consumerCursor(id: string): number {
    if (!existsSync(this.runsDir)) return 0;
    const row = this.database.prepare('SELECT seq FROM consumer_cursors WHERE id=?').get(id);
    return Number(row?.seq ?? 0);
  }
  acknowledge(id: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid event cursor');
    this.database.prepare('INSERT INTO consumer_cursors(id,seq) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET seq=max(seq,excluded.seq)').run(id, seq);
  }
  request(key: string): { fingerprint: string; taskId: string } | null {
    const row = this.database.prepare('SELECT fingerprint,task_id FROM dispatch_requests WHERE request_key=?').get(key);
    return row ? { fingerprint: String(row.fingerprint), taskId: String(row.task_id) } : null;
  }
  reserveRequest(key: string, fingerprint: string, taskId: string): void {
    this.database.prepare('INSERT INTO dispatch_requests(request_key,fingerprint,task_id) VALUES (?,?,?)').run(key, fingerprint, taskId);
  }
  constructor(runsDir: string) { this.runsDir = resolve(runsDir); }
  ensure(): void { mkdirSync(this.runsDir, { recursive: true }); }
  dir(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    return join(this.runsDir, id);
  }
  reserve(id: string): void { this.ensure(); mkdirSync(this.dir(id)); }
  read(id: string): TaskMeta | null {
    const path = join(this.dir(id), 'meta.json');
    if (!existsSync(this.runsDir)) return null;
    const row = this.database.prepare('SELECT meta FROM tasks WHERE id=?').get(id);
    if (row) return JSON.parse(String(row.meta));
    const legacy = readJson<TaskMeta>(path);
    if (!legacy || legacy.taskId !== id) return null;
    const inserted = this.database.prepare('INSERT OR IGNORE INTO tasks(id,meta) VALUES (?,?)').run(id, JSON.stringify(legacy));
    if (inserted.changes) this.appendEvent(id, 'task.imported', legacy);
    return JSON.parse(String(this.database.prepare('SELECT meta FROM tasks WHERE id=?').get(id)!.meta));
  }
  list(): TaskMeta[] {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(this.runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    // Only directory-name validation and unreadable legacy JSON are skippable.
    // Failure to read authoritative SQLite state must stop dispatch admission.
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) this.read(entry.name);
    }
    return this.database.prepare('SELECT meta FROM tasks').all().map(row => JSON.parse(String(row.meta)));
  }
  create(meta: TaskMeta): TaskMeta { this.reserve(meta.taskId); this.writeInitial(meta); return meta; }
  /** Only used after an exclusive directory reservation; never overwrites a task. */
  writeInitial(meta: TaskMeta): void {
    if (this.read(meta.taskId)) throw new Error(`Task already exists: ${meta.taskId}`);
    atomicWrite(join(this.dir(meta.taskId), 'meta.json'), JSON.stringify(meta, null, 2));
    this.save(meta, 'task.created');
  }
  update(id: string, patch: Partial<TaskMeta> | ((current: TaskMeta) => Partial<TaskMeta>)): TaskMeta | null {
    const dir = this.dir(id);
    if (this.read(id) === null) return null;
    return withFileLock(join(dir, '.meta.lock'), () => {
      const current = this.read(id);
      if (!current) return null;
      const changes = typeof patch === 'function' ? patch(current) : patch;
      const updated = { ...current, ...changes, taskId: current.taskId };
      // The first recorded stop wins; later close callbacks may add exit facts.
      if (current.status !== 'RUNNING') {
        updated.status = current.status;
        if (current.endTime !== undefined) updated.endTime = current.endTime;
      }
      atomicWrite(join(dir, 'meta.json'), JSON.stringify(updated, null, 2));
      this.save(updated, 'task.updated');
      return updated;
    });
  }
  readReport(id: string): string {
    try { return readFileSync(join(this.dir(id), 'report.md'), 'utf8'); } catch { return ''; }
  }
  /** Read a bounded suffix, leaving room for four-byte UTF-8 characters. */
  readLogTail(id: string, chars = 5000): string {
    let fd: number | undefined;
    try {
      fd = openSync(join(this.dir(id), 'raw.log'), 'r');
      const size = fstatSync(fd).size;
      const length = Math.min(size, Math.max(0, chars) * 4);
      const buffer = Buffer.alloc(length);
      const count = readSync(fd, buffer, 0, length, size - length);
      return chars > 0 ? buffer.subarray(0, count).toString('utf8').slice(-chars) : '';
    } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
  }
  withDispatchLock<T>(action: () => T): T {
    this.ensure(); return withFileLock(join(this.runsDir, '.dispatch.lock'), action);
  }
}
export const defaultTaskStore = new TaskStore(resolve(process.cwd(), '.swarm-runs'));
