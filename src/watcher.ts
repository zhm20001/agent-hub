import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTaskStore, type TaskStore } from './runner/task-store.ts';
import type { TaskMeta } from './runner/task-types.ts';

export type TaskCompletionCallback = (meta: TaskMeta, report: string) => void | Promise<void>;
export interface CompletionOptions {
  /** Stable delivery destination. Omit to watch new completions only. */
  consumerId?: string;
  retryMs?: number;
  onError?: (error: unknown) => void;
}

/** Durable consumers acknowledge only after callbacks succeed: delivery is at least once. */
export class SwarmRunsWatcher {
  private watcher: FSWatcher | null = null;
  private subscribers = new Set<TaskCompletionCallback>();
  private delivered = new Set<string>();
  private starting: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  constructor(private readonly store: TaskStore = defaultTaskStore, private readonly options: CompletionOptions = {}) {}

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.store.ensure();
    this.delivered = new Set(this.store.list().filter(meta => meta.status !== 'RUNNING').map(meta => meta.taskId));
    const watcher = watch(this.store.runsDir, { depth: 1, ignoreInitial: false });
    this.watcher = watcher;
    const changed = () => { if (this.watcher === watcher) void this.poll(); };
    watcher.on('add', changed).on('change', changed);
    this.timer = setInterval(changed, this.options.retryMs ?? 500);
    this.timer.unref();
    this.starting = new Promise<void>((resolve, reject) => {
      watcher.once('ready', () => { void this.poll().then(resolve, reject); });
      watcher.once('error', reject);
    });
    return this.starting;
  }

  private poll(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.deliver().catch(error => this.options.onError?.(error)).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async deliver(): Promise<void> {
    if (!this.watcher || !this.subscribers.size) return;
    const consumer = this.options.consumerId;
    if (consumer) {
      const events = this.store.events({ after: this.store.consumerCursor(consumer), limit: 100 });
      for (const event of events) {
        if (!this.watcher) break;
        if (event.type === 'completion') {
          if (!await this.notify(event.taskId)) break;
        }
        this.store.acknowledge(consumer, event.seq);
      }
    } else {
      for (const meta of this.store.list()) {
        if (!this.watcher) break;
        if (meta.status === 'RUNNING' || this.delivered.has(meta.taskId)) continue;
        if (await this.notify(meta.taskId)) this.delivered.add(meta.taskId);
      }
    }
  }

  private async notify(id: string): Promise<boolean> {
    const meta = this.store.read(id);
    if (!meta || meta.status === 'RUNNING') return false;
    const dir = this.store.dir(id);
    if (!existsSync(join(dir, 'completion.json')) || !existsSync(join(dir, 'resolution.json'))) return false;
    let report: string;
    try { report = readFileSync(join(dir, 'report.md'), 'utf8'); } catch { return false; }
    // A callback must reject if the destination did not accept this task.
    for (const callback of this.subscribers) await callback(meta, report);
    return true;
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    clearInterval(this.timer);
    this.timer = undefined;
    this.starting = null;
    await this.pending;
    this.delivered.clear();
    await watcher?.close();
  }
  subscribe(callback: TaskCompletionCallback): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
}
