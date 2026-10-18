import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/runner/task-store.ts';
import { createTaskEngine } from '../src/runner/detached.ts';

test('engine isolates state and returns keyed dispatch before admission and preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-engine-'));
  const a = new TaskStore(join(root, 'a')), b = new TaskStore(join(root, 'b'));
  let prepared = 0;
  const engine = createTaskEngine({ store: a, env: { ...process.env, AGENT_HUB_TASK_ROOTS: root, AGENT_HUB_MAX_CONCURRENT: '1' }, prepareDispatch: options => { prepared++; return options; } });
  try {
    assert.equal(existsSync(a.runsDir), false);
    const options = { taskId: 'keyed', adapter: 'bash', prompt: 'sleep 1', cwd: root, request_key: 'retry-one' };
    const first = engine.spawnDetachedTask(options);
    assert.equal(engine.spawnDetachedTask(options).taskId, first.taskId);
    assert.equal(prepared, 1);
    assert.equal(b.read('keyed'), null);
    assert.throws(() => engine.spawnDetachedTask({ ...options, prompt: 'echo changed' }), { name: 'RequestConflictError' });
    engine.terminateTask(first.taskId, 'cancelled');
    const events = a.events({ taskId: first.taskId });
    assert.ok(events.length >= 2);
    a.acknowledge('test', events.at(-1)!.seq);
    assert.equal(a.consumerCursor('test'), events.at(-1)!.seq);
    a.close();
    const reopened = new TaskStore(a.runsDir);
    assert.equal(reopened.read(first.taskId)?.status, 'KILLED');
    assert.equal(reopened.consumerCursor('test'), events.at(-1)!.seq);
    reopened.close();
  } finally { a.close(); b.close(); await new Promise(r => setTimeout(r, 100)); rmSync(root, { recursive: true, force: true }); }
});

test('engine rejects invalid input before creating files', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-invalid-'));
  const store = new TaskStore(join(root, 'runs'));
  const engine = createTaskEngine({ store });
  try {
    for (const options of [{ prompt: '' }, { prompt: 'ok', timeout: 0 }, { prompt: 'ok', timeout: NaN }, { prompt: 'ok', adapter: 4 }]) {
      assert.throws(() => engine.spawnDetachedTask(options as any), /invalid/i);
    }
    assert.equal(existsSync(store.runsDir), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed preparation does not poison the request key and defaults are canonical', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-prepare-'));
  const store = new TaskStore(join(root, 'runs'));
  let refuse = true;
  const engine = createTaskEngine({ store, env: { ...process.env, AGENT_HUB_TASK_ROOTS: root }, prepareDispatch(options, original) {
    assert.equal(original.cwd, undefined);
    if (refuse) throw new Error('prepare refused');
    return { ...options, prompt: 'sleep 1' };
  } });
  try {
    const options = { request_key: 'retry', prompt: 'original', adapter: 'shell' };
    assert.throws(() => engine.spawnDetachedTask(options), /prepare refused/);
    refuse = false;
    const first = engine.spawnDetachedTask(options);
    const again = engine.spawnDetachedTask({ ...options, adapter: 'bash', mode: 'edit' });
    assert.equal(first.taskId, again.taskId);
    engine.terminateTask(first.taskId, 'cancelled');
    // Repeated publication remains a single durable event.
    engine.completeTask(first.taskId, { status: 'KILLED' });
    assert.equal(store.events({ taskId: first.taskId }).filter(event => event.type === 'completion').length, 1);
  } finally { store.close(); /* close callbacks still need the directory */ setTimeout(() => rmSync(root, { recursive: true, force: true }), 100); }
});

test('legacy JSON imports safely inside a caller-owned transaction and SQLite remains authoritative', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-legacy-'));
  const store = new TaskStore(root);
  try {
    const meta = { taskId: 'old', label: 'old', prompt: 'old', adapter: 'bash', cwd: root, status: 'COMPLETED' as const, startTime: 1, timeout: 60 };
    mkdirSync(store.dir(meta.taskId));
    writeFileSync(join(store.dir(meta.taskId), 'meta.json'), JSON.stringify(meta));
    store.database.exec('BEGIN IMMEDIATE');
    assert.equal(store.read('old')?.label, 'old');
    // A registered task survives losing its disposable JSON mirror.
    store.update('old', { label: 'new' });
    store.database.exec('COMMIT');
    rmSync(join(root, 'old/meta.json'));
    assert.equal(store.read('old')?.label, 'new');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('parallel processes sharing request_key launch only one process', async () => {
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-key-race-'));
  const runnerUrl = new URL('../src/runner/detached.ts', import.meta.url).href;
  const storeUrl = new URL('../src/runner/task-store.ts', import.meta.url).href;
  const code = `
    const { createTaskEngine } = await import(${JSON.stringify(runnerUrl)});
    const { TaskStore } = await import(${JSON.stringify(storeUrl)});
    const store = new TaskStore(${JSON.stringify(join(root, 'runs'))});
    const engine = createTaskEngine({store,env:{...process.env,AGENT_HUB_TASK_ROOTS:${JSON.stringify(root)},AGENT_HUB_MAX_CONCURRENT:'1'}});
    const task = engine.spawnDetachedTask({request_key:'once',adapter:'bash',cwd:${JSON.stringify(root)},prompt:'echo launched >> launches; sleep 0.1'});
    console.log(task.taskId);
    store.close();
  `;
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
      child.on('error', reject); child.on('close', status => status === 0 ? resolve(out.trim()) : reject(Error(err)));
    })));
    assert.equal(new Set(results).size, 1);
    const { recordedProcessExit } = await import('../src/runner/process-launcher.ts');
    const deadline = Date.now() + 3000;
    while (!recordedProcessExit(join(root, 'runs', results[0])) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(recordedProcessExit(join(root, 'runs', results[0])), 'detached process exited');
    assert.equal(readFileSync(join(root, 'launches'), 'utf8').trim(), 'launched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a crash after reserving a request never blindly starts it on retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-reserved-'));
  const store = new TaskStore(join(root, 'runs'));
  const engine = createTaskEngine({ store, env: { ...process.env, AGENT_HUB_TASK_ROOTS: root } });
  const original = store.writeInitial;
  try {
    store.writeInitial = () => { throw new Error('interrupted before metadata'); };
    const options = { request_key: 'reserved', adapter: 'bash', prompt: 'echo must-not-run', cwd: root };
    assert.throws(() => engine.spawnDetachedTask(options), /interrupted/);
    store.writeInitial = original;
    assert.throws(() => engine.spawnDetachedTask(options), { name: 'DispatchRecoveryRequiredError' });
    assert.equal(store.list().length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('query repairs the publication-marker to durable-event crash window', async () => {
  const { writeFileSync } = await import('node:fs');
  const { createTaskQueries } = await import('../src/runner/task-queries.ts');
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-publication-'));
  const store = new TaskStore(root);
  const engine = createTaskEngine({ store });
  try {
    store.create({ taskId: 'done', label: 'done', prompt: 'done', adapter: 'bash', cwd: root, status: 'COMPLETED', startTime: 1, timeout: 60 });
    writeFileSync(join(store.dir('done'), 'report.md'), 'report ready');
    writeFileSync(join(store.dir('done'), 'completion.json'), JSON.stringify({ taskId: 'done', publishedAt: 2 }));
    assert.equal(store.events().some(event => event.type === 'completion'), false);
    createTaskQueries(engine).getTaskDetail('done');
    assert.equal(store.events().filter(event => event.type === 'completion').length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('transcript cache respects injected parsers instead of a global registry name', async () => {
  const { writeFileSync } = await import('node:fs');
  const { readTranscriptDocument } = await import('../src/runner/transcript-document.ts');
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-parser-'));
  const path = join(root, 'transcript'); writeFileSync(path, 'custom-format');
  try {
    const make = (answer: string) => ({ name: 'custom', description: 'fixture', buildCommand: () => ({ cmd: 'true', args: [] }), parseTranscript: () => ({ messages: [{ role: 'assistant' as const, text: answer }], modelInfo: null }) });
    const a = make('first'), b = make('second');
    assert.equal(readTranscriptDocument(path, a)?.messages[0].text, 'first');
    assert.equal(readTranscriptDocument(path, b)?.messages[0].text, 'second');
    assert.equal(readTranscriptDocument(path, a)?.messages[0].text, 'first');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new request key cannot claim an existing task ID on either initial call or retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-id-conflict-'));
  const store = new TaskStore(join(root, 'runs'));
  const engine = createTaskEngine({ store, env: { ...process.env, AGENT_HUB_TASK_ROOTS: root } });
  try {
    store.create({ taskId: 'taken', label: 'original', prompt: 'original', adapter: 'bash', cwd: root, status: 'COMPLETED', startTime: 1, timeout: 60 });
    const options = { taskId: 'taken', request_key: 'new-key', adapter: 'bash', prompt: 'different', cwd: root };
    assert.throws(() => engine.spawnDetachedTask(options), /exist/i);
    assert.throws(() => engine.spawnDetachedTask(options), /exist/i);
    assert.equal(store.request('new-key'), null);
    assert.equal(store.read('taken')?.prompt, 'original');
    // An interrupted reservation with no metadata is equally unavailable.
    store.reserve('reserved-id');
    assert.throws(() => engine.spawnDetachedTask({ ...options, taskId: 'reserved-id' }), /exist/i);
    assert.equal(store.request('new-key'), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt authoritative database refuses listing and admission instead of inventing an empty queue', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-corrupt-db-'));
  const store = new TaskStore(join(root, 'runs'));
  let commandsBuilt = 0;
  const engine = createTaskEngine({ store, env: { ...process.env, AGENT_HUB_TASK_ROOTS: root }, getAdapter: () => ({ name: 'fixture', description: 'must not start', buildCommand() { commandsBuilt++; return { cmd: 'true', args: [] }; } }) });
  try {
    mkdirSync(store.runsDir);
    writeFileSync(join(store.runsDir, 'hub.sqlite'), 'this is a damaged database, not a SQLite file');
    assert.throws(() => store.list(), /database|file is not/i);
    assert.throws(() => engine.spawnDetachedTask({ taskId: 'blocked', adapter: 'fixture', prompt: 'must not launch', cwd: root }), /database|file is not/i);
    assert.equal(commandsBuilt, 0);
    assert.equal(existsSync(store.dir('blocked')), false);
    // A failed lazy initialization must not leave an unusable cached connection.
    rmSync(join(store.runsDir, 'hub.sqlite'));
    assert.deepEqual(store.list(), []);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
