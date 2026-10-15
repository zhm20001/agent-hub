/**
 * Soft-archive: meta.archived hides tasks from the default board list.
 * Does not delete `.swarm-runs`. Fixtures only.
 *
 * Run with: node --import tsx --test tests/archive.spec.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TaskMeta } from '../src/runner/task-types.ts';
const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'hub-archive-'));
process.chdir(scratch);
const { getTaskDir, readTaskMeta, updateTaskMeta } = await import('../src/runner/detached.ts');
const { listTasks } = await import('../src/runner/task-queries.ts');

const taskIds: string[] = [];

after(() => {
  for (const taskId of taskIds) {
    try {
      rmSync(getTaskDir(taskId), { recursive: true, force: true });
    } catch {}
  }
  process.chdir(originalCwd);
  rmSync(scratch, { recursive: true, force: true });
});

function seedMeta(taskId: string, partial: Partial<TaskMeta> = {}): TaskMeta {
  taskIds.push(taskId);
  const dir = getTaskDir(taskId);
  mkdirSync(dir, { recursive: true });
  const meta: TaskMeta = {
    taskId,
    label: taskId,
    prompt: 'archive fixture',
    status: 'COMPLETED',
    startTime: Date.now(),
    timeout: 60,
    adapter: 'bash',
    cwd: process.cwd(),
    ...partial,
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

describe('listTasks archived filtering', () => {
  it('excludes archived by default and keeps explicit false', () => {
    seedMeta('archived', { archived: true });
    seedMeta('visible');
    seedMeta('explicit-visible', { archived: false });
    assert.deepEqual(listTasks().map(task => task.taskId).sort(), ['explicit-visible', 'visible']);
  });
  it('includeArchived keeps every task', () => {
    assert.equal(listTasks({ includeArchived: true }).length, 3);
  });
});

describe('updateTaskMeta archived persistence', () => {
  it('persists archived:true without removing the run dir', () => {
    const taskId = `task-archive-fixture-${Date.now()}`;
    seedMeta(taskId);

    const before = readTaskMeta(taskId);
    assert.ok(before);
    assert.equal(before.archived, undefined);

    const updated = updateTaskMeta(taskId, { archived: true });
    assert.ok(updated);
    assert.equal(updated.archived, true);

    const disk = JSON.parse(
      readFileSync(join(getTaskDir(taskId), 'meta.json'), 'utf8'),
    ) as TaskMeta;
    assert.equal(disk.archived, true);

    // Soft-archive: directory / meta still readable
    assert.ok(readTaskMeta(taskId));

    const restored = updateTaskMeta(taskId, { archived: false });
    assert.equal(restored?.archived, false);
  });
});
