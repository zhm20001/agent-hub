import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { defaultTaskStore, type TaskStore } from './runner/task-store.ts';
import type { TaskMeta } from './runner/task-types.ts';

export type TaskCompletionCallback = (meta: TaskMeta, report: string) => void;

/** Notify once per task in this watcher lifetime, only after artifact publication.
 * Existing tasks are a startup baseline; this is not a durable delivery queue.
 */
export class SwarmRunsWatcher {
  private watcher: FSWatcher | null = null;
  private subscribers = new Set<TaskCompletionCallback>();
  private delivered = new Set<string>();
  private starting: Promise<void> | null = null;
  constructor(private readonly store: TaskStore = defaultTaskStore) {}

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.store.ensure();
    // Ignore old terminal tasks even if their missing marker is repaired later.
    this.delivered = new Set(this.store.list().filter(meta => meta.status !== 'RUNNING').map(meta => meta.taskId));
    const watcher = watch(this.store.runsDir, { depth: 1, ignoreInitial: false });
    this.watcher = watcher;
    const changed = (path: string) => {
      if (this.watcher !== watcher || basename(path) !== 'completion.json') return;
      const id = basename(dirname(path));
      if (this.delivered.has(id)) return;
      const meta = this.store.read(id);
      if (!meta || meta.status === 'RUNNING') return;
      const dir = this.store.dir(id);
      if (!existsSync(join(dir, 'resolution.json'))) return;
      let report: string;
      try { report = readFileSync(join(dir, 'report.md'), 'utf8'); } catch { return; }
      this.delivered.add(id);
      for (const callback of this.subscribers) { try { callback(meta, report); } catch {} }
    };
    watcher.on('add', changed).on('change', changed);
    this.starting = new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    this.starting = null;
    this.delivered.clear();
    await watcher?.close();
  }
  subscribe(callback: TaskCompletionCallback): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
}
