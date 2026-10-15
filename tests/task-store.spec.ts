import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { TaskStore } from '../src/runner/task-store.ts';
const storeUrl = new URL('../src/runner/task-store.ts', import.meta.url).href;
const runnerUrl = new URL('../src/runner/detached.ts', import.meta.url).href;
function child(code: string, cwd: string, env = {}) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
      { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => error += c);
    p.on('error', reject); p.on('close', code => code === 0 ? resolve(out) : reject(Error(error)));
  });
}
function meta(id: string) { return { taskId: id, label: id, prompt: 'fixture', adapter: 'bash', cwd: '/', status: 'RUNNING' as const, startTime: 1, timeout: 7200 }; }
test('stores isolate directories, reject duplicate IDs and reject path traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-store-'));
  try {
    const a = new TaskStore(join(root, 'a')), b = new TaskStore(join(root, 'b'));
    a.create(meta('task-one')); assert.equal(b.read('task-one'), null);
    assert.throws(() => a.create(meta('task-one')), /exist/i);
    for (const id of ['../escape', '.', '..', 'a/b', 'a\\b']) assert.throws(() => a.dir(id), /task id/i);
    a.update('task-one', { archived: true });
    a.update('task-one', { status: 'KILLED', endTime: 10 });
    a.update('task-one', { status: 'RUNNING', endTime: 20, modelId: 'model' });
    assert.deepEqual(a.read('task-one'), { ...meta('task-one'), status: 'KILLED', endTime: 10, archived: true, modelId: 'model' });
    assert.equal(a.list().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('cross-process updates merge the latest data while readers only see complete JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-store-')); const store = new TaskStore(root);
  try {
    store.create(meta('counter'));
    const writers = Array.from({ length: 3 }, (_, i) => child(`
      const { TaskStore } = await import(${JSON.stringify(storeUrl)});
      const store = new TaskStore(${JSON.stringify(root)});
      for (let i=0; i<30; i++) store.update('counter', current => ({ label: String(Number(current.label === 'counter' ? 0 : current.label) + 1), modelId: 'm${i}' }));
    `, root));
    const reader = setInterval(() => assert.ok(JSON.parse(readFileSync(join(root, 'counter/meta.json'), 'utf8'))), 1);
    try { await Promise.all(writers); } finally { clearInterval(reader); }
    assert.equal(store.read('counter')?.label, '90');
    assert.equal(existsSync(join(root, 'counter/.meta.lock')), false);
    writeFileSync(join(root, 'counter/.meta.lock'), JSON.stringify({ pid: 2147483646 }));
    store.update('counter', { archived: true }); assert.equal(store.read('counter')?.archived, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('parallel dispatcher processes share one admission lock and cannot reuse IDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-admission-'));
  try {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => child(`
      const { spawnDetachedTask } = await import(${JSON.stringify(runnerUrl)});
      try { const task = spawnDetachedTask({taskId:'admit-${i}',adapter:'bash',prompt:'sleep 2',cwd:process.cwd()}); console.log(task.status); }
      catch (e) { if (e.name !== 'ConcurrentCapError') throw e; console.log('REFUSED'); }
    `, root, { AGENT_HUB_TASK_ROOTS: realpathSync(root), AGENT_HUB_MAX_CONCURRENT: '1' })));
    assert.equal(results.filter(s => s.trim() === 'RUNNING').length, 1);
    assert.equal(results.filter(s => s.trim() === 'REFUSED').length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dead dispatcher lock is recovered before admitting another task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-dead-dispatch-'));
  const store = new TaskStore(root);
  try {
    writeFileSync(join(root, '.dispatch.lock'), JSON.stringify({ pid: 2147483646 }));
    assert.equal(store.withDispatchLock(() => 'admitted'), 'admitted');
    assert.equal(existsSync(join(root, '.dispatch.lock')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
