import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/hub.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';

test('quiet live tasks expose timestamped facts without becoming stalled or being cancelled', t => {
  const root = mkdtempSync(join(tmpdir(), 'hub-activity-'));
  const hub = createHub({ runsDir: root }); t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  hub.store.create({ taskId: 'quiet', adapter: 'bash', label: '', prompt: 'work', cwd: root, status: 'RUNNING', pid: process.pid, startTime: 1, timeout: 999999999 });
  writeFileSync(join(root, 'quiet/raw.log'), 'old'); utimesSync(join(root, 'quiet/raw.log'), 1, 1);
  const detail = hub.queries.getTaskDetail('quiet') as any;
  assert.equal(detail.activity.supervisorAlive, true);
  assert.equal(detail.activity.log.bytes, 3);
  assert.equal(detail.activity.log.modifiedAt, 1000);
  assert.equal(detail.activity.transcript.state, 'unlocated');
  assert.equal(detail.status, 'RUNNING'); assert.equal(hub.store.read('quiet')?.status, 'RUNNING');
  assert.equal(detail.activity.stalled, undefined);
});

test('adapter activity inspection is bounded and distinguishes events from message bodies', t => {
  const root = mkdtempSync(join(tmpdir(), 'hub-activity-tail-')); let observed = 0;
  const hub = createHub({ runsDir: root, getAdapter: () => ({ name: 'fixture', description: '', buildCommand: () => ({ cmd: 'false', args: [] }), observeActivity: (input: string) => { observed = input.length; return { latestEvent: 'fixture.event', latestToolEvent: null }; } } as any) });
  t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  hub.store.create({ taskId: 'bounded', adapter: 'fixture', label: '', prompt: '', cwd: root, status: 'RUNNING', pid: process.pid, startTime: 1, timeout: 999999999 });
  writeFileSync(join(root, 'bounded/raw.log'), 'x'.repeat(200000));
  assert.equal((hub.queries.getTaskDetail('bounded') as any).activity.agent.latestEvent, 'fixture.event');
  assert.ok(observed > 0 && observed <= 65536);
  const adapter = new CodexAdapter(process.execPath) as any;
  const view = adapter.observeActivity('{"type":"item.completed","item":{"type":"command_execution"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"model.request.started"}}');
  assert.equal(view.latestEvent, 'item.completed'); assert.equal(view.latestToolEvent, 'command_execution:completed');
});
