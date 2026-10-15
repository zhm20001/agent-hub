import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPoller } from '../src/web/lib/task-data.ts';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function scheduler() {
  const pending = new Set<() => void>();
  return { pending, schedule(fn: () => void, _ms: number) { pending.add(fn); return () => pending.delete(fn); },
    tick() { const jobs = [...pending]; pending.clear(); jobs.forEach(fn => fn()); } };
}
test('loading data waits for the next tick; manual refresh never overlaps requests', async () => {
  const clock = scheduler(); let calls = 0; let resolve!: (n: number) => void;
  const values: number[] = [];
  const poller = createTaskPoller({ load: () => { calls++; return new Promise<number>(r => resolve = r); },
    receive: n => values.push(n), delay: () => 1500, schedule: clock.schedule });
  assert.equal(calls, 1);
  poller.refresh(); poller.refresh();
  assert.equal(calls, 1);
  resolve(1); await flush();
  assert.equal(calls, 2); // one coalesced explicit refresh
  resolve(2); await flush();
  assert.deepEqual(values, [1, 2]); assert.equal(calls, 2); assert.equal(clock.pending.size, 1);
  clock.tick(); assert.equal(calls, 3);
  poller.stop(); resolve(3); await flush();
  assert.deepEqual(values, [1, 2]); assert.equal(clock.pending.size, 0);
});
test('stopped task ignores late responses and aborts the request', async () => {
  let resolve!: (n: number) => void; let signal!: AbortSignal; const values: number[] = [];
  const poller = createTaskPoller({ load: s => { signal = s; return new Promise<number>(r => resolve = r); },
    receive: n => values.push(n), delay: () => null });
  poller.stop(); resolve(7); await flush();
  assert.equal(signal.aborted, true); assert.deepEqual(values, []);
});
test('failed requests retry after a delay and terminal data stops polling', async () => {
  const clock = scheduler(); let calls = 0; const errors: unknown[] = []; const values: number[] = [];
  const poller = createTaskPoller({ load: async () => { if (++calls === 1) throw Error('offline'); return 2; },
    receive: n => values.push(n), failed: e => errors.push(e), delay: value => value === 2 ? null : 3000,
    schedule: clock.schedule });
  await flush(); assert.equal(errors.length, 1); assert.equal(clock.pending.size, 1);
  clock.tick(); await flush(); assert.deepEqual(values, [2]); assert.equal(clock.pending.size, 0);
  poller.stop();
});
