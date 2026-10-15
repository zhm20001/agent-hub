import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskMeta } from '../src/runner/detached.ts';
import { readRunRecord } from '../src/runner/settlement.ts';

// Each node:test file has its own process. Resolve the runner's storage root only
// after changing cwd, so dispatch/cap/watchdog never touch real repository tasks.
const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'agent-hub-lifecycle-'));
process.chdir(scratch);
const savedRoots = process.env.AGENT_HUB_TASK_ROOTS;
process.env.AGENT_HUB_TASK_ROOTS = process.cwd();
const runner = await import('../src/runner/detached.ts');
const { TtlWatchdog } = await import('../src/runner/ttl.ts');
const { registerSwarmTools } = await import('../src/tools.ts');

const tasks: string[] = [];
const children = new Set<string>();
function spawn(prompt: string) {
  const meta = runner.spawnDetachedTask({ adapter: 'bash', prompt });
  tasks.push(meta.taskId);
  children.add(meta.taskId);
  return meta;
}
after(async () => {
  for (const id of tasks) {
    const meta = runner.readTaskMeta(id);
    if (children.has(id) && meta?.pid) {
      if (!Object.hasOwn(meta, 'exitCode')) runner.killTaskProcess(meta.pid);
      await waitFor(() => Object.hasOwn(runner.readTaskMeta(id)!, 'exitCode'));
    }
    rmSync(runner.getTaskDir(id), { recursive: true, force: true });
  }
  process.chdir(originalCwd);
  if (savedRoots === undefined) delete process.env.AGENT_HUB_TASK_ROOTS;
  else process.env.AGENT_HUB_TASK_ROOTS = savedRoots;
  rmSync(scratch, { recursive: true, force: true });
});
function seed(patch: Partial<TaskMeta> = {}): string {
  const id = `task-lifecycle-${process.pid}-${tasks.length}`;
  tasks.push(id);
  mkdirSync(runner.getTaskDir(id), { recursive: true });
  writeFileSync(join(runner.getTaskDir(id), 'meta.json'), JSON.stringify({
    taskId: id, label: id, prompt: 'fixture', adapter: 'bash', cwd: process.cwd(),
    status: 'RUNNING', startTime: Date.now() - 1000, timeout: 7200, ...patch,
  }));
  writeFileSync(join(runner.getTaskDir(id), 'raw.log'), 'fixture output\n');
  return id;
}
function artifacts(id: string) {
  return ['meta.json', 'resolution.json', 'report.md'].map(file =>
    readFileSync(join(runner.getTaskDir(id), file), 'utf8'));
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'child should finish within 5 seconds');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('task lifecycle', () => {
  it('offers one termination interface and leaves missing tasks absent', () => {
    assert.equal(typeof runner.terminateTask, 'function');
    assert.equal(runner.terminateTask('task-lifecycle-missing', 'cancelled'), null);
    assert.equal(existsSync(runner.getTaskDir('task-lifecycle-missing')), false);
  });

  for (const [cause, status] of [['cancelled', 'KILLED'], ['timeout', 'TIMEOUT_KILLED']] as const) {
    it(`persists ${cause} with its closing record and report`, () => {
      const id = seed();
      const meta = runner.terminateTask(id, cause);
      assert.equal(meta?.status, status);
      assert.ok(meta?.endTime);
      const record = readRunRecord(runner.getTaskDir(id));
      assert.equal(record?.resolution.stopCause, cause);
      assert.deepEqual(record?.resolution.finalText, { kind: 'text', value: 'fixture output\n' });
      assert.match(artifacts(id)[2], new RegExp(`stopCause.*${cause}`));
      const before = artifacts(id);
      runner.terminateTask(id, cause === 'timeout' ? 'cancelled' : 'timeout');
      assert.deepEqual(artifacts(id), before, 'repeated termination must not rewrite any artifact');
    });
  }

  it('retains termination intent if writing the closing record fails', () => {
    const id = seed();
    const recordPath = join(runner.getTaskDir(id), 'resolution.json');
    mkdirSync(recordPath); // force the atomic record rename to fail
    assert.throws(() => runner.terminateTask(id, 'cancelled'));
    assert.equal(runner.readTaskMeta(id)?.status, 'KILLED');
    rmSync(recordPath, { recursive: true });
    assert.equal(runner.readResolution(id)?.resolution.stopCause, 'cancelled');
  });

  it('preserves a completed task without signalling its recorded pid', () => {
    const id = seed({ status: 'COMPLETED', pid: process.pid, endTime: 123 });
    const before = readFileSync(join(runner.getTaskDir(id), 'meta.json'), 'utf8');
    assert.equal(runner.terminateTask(id, 'cancelled')?.endTime, 123);
    assert.equal(readFileSync(join(runner.getTaskDir(id), 'meta.json'), 'utf8'), before);
    assert.equal(readRunRecord(runner.getTaskDir(id)), null);
  });

  it('keeps cancellation after the real child closes and records actual exit facts', async () => {
    const meta = spawn('echo ready; sleep 30');
    await waitFor(() => readFileSync(join(runner.getTaskDir(meta.taskId), 'raw.log'), 'utf8').includes('\nready\n'));
    const stopped = runner.terminateTask(meta.taskId, 'cancelled');
    const endTime = stopped?.endTime;
    await waitFor(() => Object.hasOwn(runner.readTaskMeta(meta.taskId)!, 'exitCode'));
    assert.equal(runner.readTaskMeta(meta.taskId)?.status, 'KILLED');
    assert.equal(runner.readTaskMeta(meta.taskId)?.endTime, endTime);
    assert.equal(readRunRecord(runner.getTaskDir(meta.taskId))?.resolution.stopCause, 'cancelled');
    assert.match(artifacts(meta.taskId)[2], /cancelled/);
  });

  it('settles the swarm tool through the same termination interface', async () => {
    const registered = new Map();
    registerSwarmTools({ tools: { register: tool => registered.set(tool.name, tool) } });
    const id = seed();
    const result = await registered.get('swarm_kill').execute({ taskId: id });
    assert.deepEqual(result, { taskId: id, status: 'KILLED' });
    assert.equal(readRunRecord(runner.getTaskDir(id))?.resolution.stopCause, 'cancelled');
    assert.match(artifacts(id)[2], /cancelled/);
  });

  it('settles spawn errors without interpreting the runner header as child output', async () => {
    const savedPath = process.env.PATH;
    let meta: TaskMeta;
    try {
      process.env.PATH = scratch; // no bash executable: Node emits error, then close
      meta = spawn('echo unreachable');
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    await waitFor(() => runner.readTaskMeta(meta.taskId)?.exitCode === -2);
    assert.equal(runner.readTaskMeta(meta.taskId)?.status, 'FAILED');
    assert.match(runner.readTaskMeta(meta.taskId)?.error ?? '', /ENOENT/);
    const record = readRunRecord(runner.getTaskDir(meta.taskId));
    assert.equal(record?.observation.producedOutput, false);
    assert.deepEqual(record?.resolution.finalText, { kind: 'empty' });
    assert.match(artifacts(meta.taskId)[2], /ENOENT/);
  });

  it('uses the same lifecycle for a watchdog timeout', async () => {
    // A live child prevents orphan recovery from handling this as a missed exit.
    const meta = spawn('sleep 30');
    runner.updateTaskMeta(meta.taskId, {
      startTime: Date.now() - 60_000, timeout: 1, timeoutExtended: true,
    });
    new TtlWatchdog().checkTimeouts();
    assert.equal(runner.readTaskMeta(meta.taskId)?.status, 'TIMEOUT_KILLED');
    assert.equal(readRunRecord(runner.getTaskDir(meta.taskId))?.resolution.stopCause, 'timeout');
    assert.match(artifacts(meta.taskId)[2], /timeout/);
    await waitFor(() => Object.hasOwn(runner.readTaskMeta(meta.taskId)!, 'exitCode'));
    assert.equal(runner.readTaskMeta(meta.taskId)?.status, 'TIMEOUT_KILLED');
  });
});
