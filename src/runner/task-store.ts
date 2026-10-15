import { mkdirSync, readdirSync, readFileSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite, readJson, withFileLock } from './file-storage.ts';
import type { TaskMeta } from './task-types.ts';

/** A concrete file store. Construct with a temporary directory for isolated use. */
export class TaskStore {
  readonly runsDir: string;
  constructor(runsDir: string) { this.runsDir = resolve(runsDir); }
  ensure(): void { mkdirSync(this.runsDir, { recursive: true }); }
  dir(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    return join(this.runsDir, id);
  }
  reserve(id: string): void { this.ensure(); mkdirSync(this.dir(id)); }
  read(id: string): TaskMeta | null { return readJson<TaskMeta>(join(this.dir(id), 'meta.json')); }
  list(): TaskMeta[] {
    try { return readdirSync(this.runsDir, { withFileTypes: true }).filter(e => e.isDirectory())
      .flatMap(e => { try { const meta = this.read(e.name); return meta ? [meta] : []; } catch { return []; } }); }
    catch { return []; }
  }
  create(meta: TaskMeta): TaskMeta { this.reserve(meta.taskId); this.writeInitial(meta); return meta; }
  /** Only used after an exclusive directory reservation; never overwrites a task. */
  writeInitial(meta: TaskMeta): void {
    if (this.read(meta.taskId)) throw new Error(`Task already exists: ${meta.taskId}`);
    atomicWrite(join(this.dir(meta.taskId), 'meta.json'), JSON.stringify(meta, null, 2));
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
