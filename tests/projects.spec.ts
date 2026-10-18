import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/runner/task-store.ts';
import { ProjectStore } from '../src/projects.ts';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-projects-'));
  const tasks = new TaskStore(dir);
  t.after(() => { tasks.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, projects: new ProjectStore(tasks) };
}
function task(id: string, projectId = 'alpha') { return { taskId: id, projectId, label: id, prompt: 'work', status: 'RUNNING' as const, startTime: 1, timeout: 100, adapter: 'bash', cwd: tmpdir() }; }

test('projects and append-only notes survive reopening without overwriting the goal', t => {
  const { tasks, projects } = fixture(t);
  projects.upsert({ id: 'alpha', name: 'Alpha', goal: 'Stable intent' });
  projects.appendNote('alpha', { body: 'Current finding', author: 'main agent' });
  tasks.close();
  const restored = new ProjectStore(tasks);
  assert.equal(restored.get('alpha')?.goal, 'Stable intent');
  assert.equal(restored.context('alpha').latestNote?.body, 'Current finding');
  restored.appendNote('alpha', { body: 'Next finding' });
  assert.equal(restored.context('alpha').notes.length, 2);
  assert.equal(restored.get('alpha')?.goal, 'Stable intent');
});

test('note request keys return the original note and reject changed content', t => {
  const { projects } = fixture(t);
  projects.upsert({ id: 'alpha', name: 'Alpha', goal: 'Goal' });
  const input = { body: 'Result', request_key: 'same-request' };
  const first = projects.appendNote('alpha', input);
  assert.deepEqual(projects.appendNote('alpha', input), first);
  assert.throws(() => projects.appendNote('alpha', { ...input, body: 'Different' }), /conflict/i);
  assert.equal(projects.context('alpha').notes.length, 1);
});

test('source tasks must exist and belong to the project', t => {
  const { projects, tasks } = fixture(t);
  projects.upsert({ id: 'alpha', name: 'Alpha', goal: 'Goal' });
  tasks.create(task('other', 'beta'));
  assert.throws(() => projects.appendNote('alpha', { body: 'Result', sourceTaskIds: ['missing'] }), /task/i);
  assert.throws(() => projects.appendNote('alpha', { body: 'Result', sourceTaskIds: ['other'] }), /project/i);
  tasks.create(task('own'));
  assert.deepEqual(projects.appendNote('alpha', { body: 'Result', sourceTaskIds: ['own'] }).sourceTaskIds, ['own']);
});

test('reading does not mark changes seen and seen cannot skip future events', t => {
  const { projects } = fixture(t);
  projects.upsert({ id: 'alpha', name: 'Alpha', goal: 'Goal' });
  projects.appendNote('alpha', { body: 'First' });
  const first = projects.context('alpha', { viewerId: 'person' });
  assert.equal(first.changesSinceVisit.notes.length, 1);
  assert.equal(projects.context('alpha', { viewerId: 'person' }).changesSinceVisit.notes.length, 1);
  assert.throws(() => projects.markSeen('alpha', { viewerId: 'person', through: first.changesSinceVisit.through + 1 }), /cursor|through/i);
  projects.markSeen('alpha', { viewerId: 'person', through: first.changesSinceVisit.through });
  projects.appendNote('alpha', { body: 'Second' });
  assert.deepEqual(projects.context('alpha', { viewerId: 'person' }).changesSinceVisit.notes.map(n => n.body), ['Second']);
  assert.equal(projects.context('alpha', { viewerId: 'another' }).changesSinceVisit.notes.length, 2);
});

test('task facts use stable change cursors and status updates remain visible', t => {
  const { projects, tasks } = fixture(t);
  projects.upsert({ id: 'alpha', name: 'Alpha', goal: 'Goal' });
  tasks.create(task('one'));
  const first = projects.context('alpha');
  assert.equal(first.changesSinceVisit.tasks.length, 1);
  assert.equal(projects.context('alpha').changesSinceVisit.through, first.changesSinceVisit.through);
  projects.markSeen('alpha', { through: first.changesSinceVisit.through });
  tasks.update('one', { status: 'COMPLETED', endTime: 2 });
  const next = projects.context('alpha');
  assert.equal(next.changesSinceVisit.tasks[0].status, 'COMPLETED');
  assert.ok(next.changesSinceVisit.through > first.changesSinceVisit.through);
  projects.markSeen('alpha', { through: 0 });
  assert.equal(projects.context('alpha').changesSinceVisit.after, first.changesSinceVisit.through);
});

test('invalid and oversized fields are rejected without creating records', t => {
  const { projects } = fixture(t);
  assert.throws(() => projects.upsert({ id: '../bad', name: 'Bad', goal: 'Goal' }), /id/i);
  assert.throws(() => projects.upsert({ id: 'alpha', name: ' ', goal: 'Goal' }), /name/i);
  projects.upsert({ id: 'alpha', name: 'Alpha', goal: 'Goal' });
  assert.throws(() => projects.appendNote('alpha', { body: ' ' }), /body/i);
  assert.throws(() => projects.appendNote('alpha', { body: 'x'.repeat(40001) }), /body/i);
  assert.throws(() => projects.context('alpha', { limit: 0 }), /limit/i);
  assert.throws(() => projects.context('missing'), /not found/i);
});

 test('constructing project storage does not create a directory or open the database', t => {
  const parent = mkdtempSync(join(tmpdir(), 'hub-project-lazy-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'not-created');
  new ProjectStore(new TaskStore(dir));
  assert.equal(existsSync(dir), false);
});
