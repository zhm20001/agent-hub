import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hub-checkpoint-')); const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const hub = createHub({ runsDir: join(root, 'runs') });
  hub.projects.upsert({ id: 'p', name: 'Project', goal: 'Stable intent', cwd });
  t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, hub, checkpoints: (hub as any).checkpoints };
}
const input = { expectedSequence: 0, author: 'lead', summary: 'Verified reading', nextStep: 'Review', revision: 'abc123', decision: 'accepted', checks: [{ name: 'linux', status: 'not-run', required: true }] };

test('explicit decisions remain separate from mechanical status and survive reopen with CAS', t => {
  const { hub, checkpoints } = fixture(t);
  const first = checkpoints.append('p', input);
  assert.equal(first.decision, 'accepted'); assert.equal(first.checks[0].status, 'not-run');
  assert.throws(() => checkpoints.append('p', { ...input, summary: 'stale' }), /conflict/i);
  const second = checkpoints.append('p', { ...input, expectedSequence: first.sequence, revision: 'new', decision: 'pending' });
  hub.close();
  const context = hub.projects.context('p') as any;
  assert.equal(context.checkpoint.revision, 'new'); assert.equal(context.checkpoint.sequence, second.sequence);
  assert.equal(context.project.goal, 'Stable intent'); assert.equal(context.latestNote, null);
});

test('explicit retention preserves an untracked artifact and detects missing or changed originals', t => {
  const { cwd, hub, checkpoints } = fixture(t);
  const file = join(cwd, 'untracked.log'); writeFileSync(file, 'actual check log');
  const first = checkpoints.append('p', { ...input, artifacts: [{ path: file, retain: true }] });
  assert.equal(first.artifacts[0].sha256.length, 64);
  writeFileSync(file, 'changed');
  let view = (hub.projects.context('p') as any).checkpoint;
  assert.equal(view.artifacts[0].sourceState, 'changed'); assert.equal(view.artifacts[0].retainedState, 'available');
  rmSync(file); view = (hub.projects.context('p') as any).checkpoint;
  assert.equal(view.artifacts[0].sourceState, 'missing');
  assert.equal(readFileSync(view.artifacts[0].retainedPath, 'utf8'), 'actual check log');
});

test('checkpoint rejects cross-project tasks, invalid decisions and artifact escapes including symlinks', t => {
  const { root, cwd, hub, checkpoints } = fixture(t);
  hub.store.create({ taskId: 'foreign', projectId: 'other', adapter: 'bash', label: '', prompt: '', cwd, status: 'COMPLETED', startTime: 1, timeout: 1 });
  assert.throws(() => checkpoints.append('p', { ...input, sourceTaskIds: ['foreign'] }), /project/i);
  assert.throws(() => checkpoints.append('p', { ...input, decision: 'automatic' }), /decision/i);
  const outside = join(root, 'outside'); writeFileSync(outside, 'private'); const alias = join(cwd, 'escape'); symlinkSync(outside, alias);
  assert.throws(() => checkpoints.append('p', { ...input, artifacts: [{ path: alias, retain: true }] }), /outside/i);
  assert.throws(() => checkpoints.append('p', { ...input, checks: [{ name: 'test', status: 'passed', required: 'yes' }] }), /required/i);
});

test('note limits expose omitted history without silently replacing the current checkpoint', t => {
  const { hub, checkpoints } = fixture(t);
  checkpoints.append('p', input);
  for (let i = 0; i < 3; i++) hub.projects.appendNote('p', { body: `history ${i}` });
  const context = hub.projects.context('p', { limit: 1 }) as any;
  assert.equal(context.notesPage.total, 3); assert.equal(context.notesPage.truncated, true);
  assert.equal(context.checkpoint.summary, input.summary); assert.equal(context.latestNote.body, 'history 2');
});

test('a project with no cwd may retain only runsDir evidence, never its parent siblings', t => {
  const { root, hub, checkpoints } = fixture(t);
  hub.projects.upsert({ id: 'no-cwd', name: 'No directory', goal: 'Intent' });
  const outside = join(root, 'sibling.log'); writeFileSync(outside, 'not project evidence');
  assert.throws(() => checkpoints.append('no-cwd', { ...input, artifacts: [{ path: outside, retain: true }] }), /outside/i);
});
