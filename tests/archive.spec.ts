/**
 * Soft-archive: meta.archived hides tasks from the default board list.
 * Does not delete `.swarm-runs`. Fixtures only.
 *
 * Run with: node --import tsx --test tests/archive.spec.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterBoardTasks,
  getTaskDir,
  readTaskMeta,
  updateTaskMeta,
  type TaskMeta,
} from '../src/runner/detached.ts';

const taskIds: string[] = [];

after(() => {
  for (const taskId of taskIds) {
    try {
      rmSync(getTaskDir(taskId), { recursive: true, force: true });
    } catch {}
  }
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

describe('filterBoardTasks', () => {
  it('excludes archived by default', () => {
    const tasks = [
      { taskId: 'a', archived: true },
      { taskId: 'b' },
      { taskId: 'c', archived: false },
    ];
    assert.deepEqual(
      filterBoardTasks(tasks).map((t) => t.taskId),
      ['b', 'c'],
    );
  });

  it('includeArchived keeps all', () => {
    const tasks = [
      { taskId: 'a', archived: true },
      { taskId: 'b' },
    ];
    assert.equal(filterBoardTasks(tasks, { includeArchived: true }).length, 2);
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
