import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHub } from '../src/hub.ts';
import { startServer } from '../src/server.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-review-'));
  const hub = createHub({ runsDir: join(root, 'runs'), env: { ...process.env, AGENT_HUB_TASK_ROOTS: root } });
  return { root, hub, close() { hub.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('a colliding taskId cannot bind a new request key to unrelated existing work', () => {
  const f = fixture();
  try {
    f.hub.store.create({ taskId: 'existing', label: 'original', prompt: 'original task', adapter: 'bash', cwd: f.root, status: 'COMPLETED', startTime: 1, timeout: 10 });
    const input = { taskId: 'existing', request_key: 'new-key', prompt: 'different task', adapter: 'bash', cwd: f.root };
    assert.throws(() => f.hub.engine.spawnDetachedTask(input));
    assert.equal(f.hub.store.request('new-key'), null, 'rejected task identity must not claim an unrelated task');
    assert.throws(() => f.hub.engine.spawnDetachedTask(input));
  } finally { f.close(); }
});

async function firstEvent(response: Response): Promise<{ id: string; data: any }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('Stream ended before first event');
    text += decoder.decode(chunk.value, { stream: true });
  }
  const event = text.split('\n\n')[0];
  return { id: /^id: (.+)$/m.exec(event)![1], data: JSON.parse(/^data: (.+)$/m.exec(event)![1]) };
}

test('SSE reconnect after log replacement resets instead of dropping the new log prefix', async () => {
  const f = fixture();
  const first = new AbortController();
  const second = new AbortController();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    f.hub.store.create({ taskId: 'live', label: 'live', prompt: 'fixture', adapter: 'bash', cwd: f.root, status: 'RUNNING', pid: process.pid, startTime: Date.now(), timeout: 100 });
    const path = join(f.hub.store.dir('live'), 'raw.log');
    writeFileSync(path, 'old');
    server = await startServer(0, { hub: f.hub, frontend: false });
    const url = `http://127.0.0.1:${server.address.port}/api/tasks/live/stream`;
    const original = await firstEvent(await fetch(url, { signal: first.signal }));
    assert.equal(original.data.text, 'old');
    first.abort();
    renameSync(path, path + '.old');
    writeFileSync(path, 'new replacement');
    const replay = await firstEvent(await fetch(url, { headers: { 'Last-Event-ID': original.id }, signal: second.signal }));
    assert.equal(replay.data.reset, true);
    assert.equal(replay.data.text, 'new replacement');
  } finally {
    first.abort(); second.abort();
    await server?.close(); f.close();
  }
});
