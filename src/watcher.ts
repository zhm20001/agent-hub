import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SWARM_RUNS_DIR, ensureRunsDir, type TaskMeta, readTaskMeta } from './runner/detached.ts';

export type TaskCompletionCallback = (meta: TaskMeta, report: string) => void;

export class SwarmRunsWatcher {
  private watcher: FSWatcher | null = null;
  private subscribers: Set<TaskCompletionCallback> = new Set();
  private knownStatus: Map<string, string> = new Map();

  start(): void {
    if (this.watcher) return;
    ensureRunsDir();

    this.watcher = watch(`${SWARM_RUNS_DIR}/*/meta.json`, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('change', (filePath) => this.handleFileChange(filePath));
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    this.knownStatus.clear();
    await watcher?.close();
  }

  subscribe(callback: TaskCompletionCallback): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private handleFileChange(filePath: string): void {
    try {
      const taskDir = dirname(filePath);
      const taskId = taskDir.split(/[/\\]/).pop();
      if (!taskId) return;

      const meta = readTaskMeta(taskId);
      if (!meta) return;

      const prevStatus = this.knownStatus.get(taskId);
      this.knownStatus.set(taskId, meta.status);

      if (meta.status !== 'RUNNING' && prevStatus === 'RUNNING') {
        const reportPath = join(taskDir, 'report.md');
        let report = '';
        if (existsSync(reportPath)) {
          try {
            report = readFileSync(reportPath, 'utf8');
          } catch {}
        }

        for (const cb of this.subscribers) {
          try {
            cb(meta, report);
          } catch {}
        }
      }
    } catch {}
  }
}
