import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../src/runner/task-store.ts';
import { atomicWrite } from '../src/runner/file-storage.ts';
import { SwarmRunsWatcher } from '../src/watcher.ts';
import { completeTask, getTaskDir } from '../src/runner/detached.ts';
import { defaultTaskStore } from '../src/runner/task-store.ts';
const meta = (id: string) => ({ taskId: id, label: id, prompt: 'fixture', adapter: 'bash', cwd: '/', status: 'COMPLETED' as const, startTime: 1, endTime: 2, timeout: 7200 });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i=0; i<80; i++) { if(check()) return; await pause(25); } assert.ok(check(), 'notification did not arrive'); }
test('completion publishes only after the closing record and report exist', () => {
  const id = `publish-${Date.now()}`;
  defaultTaskStore.create(meta(id));
  try {
    completeTask(id, { status: 'COMPLETED', output: 'answer' });
    assert.equal(existsSync(join(getTaskDir(id), 'completion.json')), true);
    assert.match(readFileSync(join(getTaskDir(id), 'report.md'), 'utf8'), /Closing Record/);
    const first = readFileSync(join(getTaskDir(id), 'completion.json'), 'utf8');
    completeTask(id, { status: 'FAILED', output: 'late answer' });
    assert.equal(readFileSync(join(getTaskDir(id), 'completion.json'), 'utf8'), first);
  } finally { rmSync(getTaskDir(id), { recursive: true, force: true }); }
});
test('watcher sees short tasks without RUNNING, skips history and notifies once after publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-publish-')); const store = new TaskStore(root);
  const watcher = new SwarmRunsWatcher(store); const notices: string[] = [];
  function publish(id: string) {
    const dir = store.dir(id);
    atomicWrite(join(dir, 'resolution.json'), JSON.stringify({ taskId: id }));
    atomicWrite(join(dir, 'report.md'), `ready ${id}`);
    atomicWrite(join(dir, 'completion.json'), JSON.stringify({ taskId: id }));
  }
  store.create(meta('history')); publish('history');
  watcher.subscribe((task, report) => { assert.equal(report, `ready ${task.taskId}`); notices.push(task.taskId); });
  try {
    await watcher.start();
    store.create(meta('fast')); await pause(100); assert.deepEqual(notices, []);
    publish('fast'); await until(() => notices.length === 1);
    publish('fast'); await pause(200); assert.deepEqual(notices, ['fast']);
    await watcher.stop(); store.create(meta('stopped')); publish('stopped'); await pause(100);
    assert.deepEqual(notices, ['fast']);
  } finally { await watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});
