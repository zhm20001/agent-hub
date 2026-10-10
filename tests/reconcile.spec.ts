/**
 * Orphan RUNNING reconcile: PID gone → COMPLETED + settlement.
 * Fixtures only — plants meta under real .swarm-runs, cleaned up after.
 *
 * Run with: node --import tsx --test tests/reconcile.spec.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SWARM_RUNS_DIR,
  getTaskDir,
  readTaskMeta,
  readResolution,
} from '../src/runner/detached.ts';
import { RUN_RECORD_FILE, readRunRecord } from '../src/runner/settlement.ts';
import {
  RECONCILE_NOTE,
  isOrphanRunning,
  reconcileOrphanTask,
  reconcileOrphanRunningTasks,
} from '../src/runner/reconcile.ts';
import { isProcessAlive } from '../src/runner/timeout-policy.ts';

const planted: string[] = [];
const scratchDirs: string[] = [];

after(() => {
  for (const taskId of planted) {
    try { rmSync(getTaskDir(taskId), { recursive: true, force: true }); } catch {}
  }
  for (const dir of scratchDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function plantRunning(partial: {
  taskId: string;
  pid?: number;
  adapter?: string;
  withLog?: boolean;
  logBody?: string;
}): string {
  const taskId = partial.taskId;
  const taskDir = getTaskDir(taskId);
  mkdirSync(taskDir, { recursive: true });
  planted.push(taskId);
  const meta = {
    taskId,
    label: 'reconcile-fixture',
    prompt: 'fixture',
    pid: partial.pid,
    status: 'RUNNING' as const,
    startTime: Date.now() - 60_000,
    timeout: 7200,
    adapter: partial.adapter ?? 'bash',
    cwd: process.cwd(),
  };
  writeFileSync(join(taskDir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (partial.withLog !== false) {
    const body = partial.logBody
      ?? `=== Swarm Task ${taskId} [NO-TICKET] ===\nAdapter: bash | Started: 2026-01-01T00:00:00.000Z\nCommand: echo hi\nWorking Dir: /\n====================================================\n\nhi\n`;
    writeFileSync(join(taskDir, 'raw.log'), body);
  }
  return taskId;
}

describe('isOrphanRunning', () => {
  it('is false for live pid (this process)', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(
      isOrphanRunning({
        taskId: 'x',
        label: 'x',
        prompt: 'x',
        pid: process.pid,
        status: 'RUNNING',
        startTime: 1,
        timeout: 1,
        adapter: 'bash',
        cwd: '/',
      }),
      false,
    );
  });

  it('is true when pid missing or dead', () => {
    assert.equal(
      isOrphanRunning({
        taskId: 'x',
        label: 'x',
        prompt: 'x',
        status: 'RUNNING',
        startTime: 1,
        timeout: 1,
        adapter: 'bash',
        cwd: '/',
      }),
      true,
    );
    // PID 1 may be alive on some hosts; use a very high unlikely pid.
    const deadPid = 2_147_483_646;
    assert.equal(isProcessAlive(deadPid), false);
    assert.equal(
      isOrphanRunning({
        taskId: 'x',
        label: 'x',
        prompt: 'x',
        pid: deadPid,
        status: 'RUNNING',
        startTime: 1,
        timeout: 1,
        adapter: 'bash',
        cwd: '/',
      }),
      true,
    );
  });

  it('is false when already terminal', () => {
    assert.equal(
      isOrphanRunning({
        taskId: 'x',
        label: 'x',
        prompt: 'x',
        status: 'COMPLETED',
        startTime: 1,
        timeout: 1,
        adapter: 'bash',
        cwd: '/',
      }),
      false,
    );
  });
});

describe('reconcileOrphanTask', () => {
  it('no-ops when process is still alive', () => {
    const taskId = plantRunning({
      taskId: `task-reconcile-alive-${Date.now().toString(36)}`,
      pid: process.pid,
    });
    assert.equal(reconcileOrphanTask(taskId), null);
    assert.equal(readTaskMeta(taskId)?.status, 'RUNNING');
    assert.equal(readRunRecord(getTaskDir(taskId)), null);
  });

  it('marks COMPLETED, writes resolution + report when pid is dead', () => {
    const taskId = plantRunning({
      taskId: `task-reconcile-dead-${Date.now().toString(36)}`,
      pid: 2_147_483_646,
      logBody: `=== Swarm Task fixture ===\n====================================================\n\norphaned output ok\n`,
    });

    const updated = reconcileOrphanTask(taskId);
    assert.ok(updated);
    assert.equal(updated.status, 'COMPLETED');
    assert.ok(typeof updated.endTime === 'number');

    const meta = readTaskMeta(taskId);
    assert.equal(meta?.status, 'COMPLETED');
    assert.ok(meta?.endTime);

    const record = readResolution(taskId);
    assert.ok(record);
    assert.equal(record.taskId, taskId);
    assert.equal(record.observation.producedOutput, true);
    assert.deepEqual(record.resolution.finalText, {
      kind: 'text',
      value: 'orphaned output ok\n',
    });

    const report = readFileSync(join(getTaskDir(taskId), 'report.md'), 'utf8');
    assert.match(report, new RegExp(RECONCILE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(report, /COMPLETED/);
  });

  it('syncs meta to COMPLETED when resolution already exists (no rewrite needed)', () => {
    const taskId = plantRunning({
      taskId: `task-reconcile-hasres-${Date.now().toString(36)}`,
      pid: 2_147_483_645,
    });
    const taskDir = getTaskDir(taskId);
    writeFileSync(join(taskDir, RUN_RECORD_FILE), JSON.stringify({
      taskId,
      resolution: {
        taskId,
        finalText: { kind: 'text', value: 'already settled' },
      },
      observation: { producedOutput: true, unmetPreconditions: [] },
    }, null, 2) + '\n');

    const before = readFileSync(join(taskDir, RUN_RECORD_FILE), 'utf8');
    const updated = reconcileOrphanTask(taskId);
    assert.equal(updated?.status, 'COMPLETED');
    assert.equal(readFileSync(join(taskDir, RUN_RECORD_FILE), 'utf8'), before);
  });

  it('idempotent: second call is a no-op', () => {
    const taskId = plantRunning({
      taskId: `task-reconcile-idem-${Date.now().toString(36)}`,
      pid: 2_147_483_644,
    });
    assert.ok(reconcileOrphanTask(taskId));
    assert.equal(reconcileOrphanTask(taskId), null);
  });
});

describe('reconcileOrphanRunningTasks', () => {
  it('repairs dead RUNNING and leaves live RUNNING alone', () => {
    const deadId = plantRunning({
      taskId: `task-reconcile-scan-dead-${Date.now().toString(36)}`,
      pid: 2_147_483_643,
    });
    const liveId = plantRunning({
      taskId: `task-reconcile-scan-live-${Date.now().toString(36)}`,
      pid: process.pid,
    });

    const { repaired } = reconcileOrphanRunningTasks(SWARM_RUNS_DIR);
    const repairedIds = repaired.map((m) => m.taskId);
    assert.ok(repairedIds.includes(deadId));
    assert.ok(!repairedIds.includes(liveId));
    assert.equal(readTaskMeta(deadId)?.status, 'COMPLETED');
    assert.equal(readTaskMeta(liveId)?.status, 'RUNNING');
  });
});
