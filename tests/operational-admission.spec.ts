import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskEngine } from '../src/runner/detached.ts';
import { TaskStore } from '../src/runner/task-store.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hub-admission-'));
  const cwd = join(root, 'workspace'); mkdirSync(cwd); mkdirSync(join(cwd, '.git')); mkdirSync(join(cwd, 'sub'));
  const store = new TaskStore(join(root, 'runs'));
  const engine = createTaskEngine({ store, env: { ...process.env, AGENT_HUB_TASK_ROOTS: root, AGENT_HUB_MAX_CONCURRENT: '10' } });
  t.after(async () => { for (const task of store.list()) if (task.status === 'RUNNING' && task.taskId !== 'owner') engine.terminateTask(task.taskId, 'cancelled'); await new Promise(r => setTimeout(r, 100)); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, store, engine };
}
function own(store: TaskStore, cwd: string, access: 'read' | 'write' = 'write') {
  store.create({ taskId: 'owner', adapter: 'bash', label: 'owner', prompt: 'work', status: 'RUNNING', pid: process.pid, startTime: Date.now(), timeout: 60, cwd, workspaceAccess: access } as any);
}

test('preflight distinguishes cwd denial and missing command without reserving requests or tasks', t => {
  const { root, cwd, store } = fixture(t);
  const engine = createTaskEngine({ store, env: { ...process.env, AGENT_HUB_TASK_ROOTS: cwd }, getAdapter: () => ({ name: 'fixture', description: '', buildCommand: () => ({ cmd: join(root, 'missing'), args: [] }) }) });
  const denied = (engine as any).preflight({ prompt: 'work', cwd: root, adapter: 'fixture', request_key: 'same' });
  assert.equal(denied.ready, false);
  assert.equal(denied.checks.find((c: any) => c.name === 'cwd-allowed').ok, false);
  const missing = (engine as any).preflight({ prompt: 'work', cwd, adapter: 'fixture', request_key: 'same' });
  assert.equal(missing.checks.find((c: any) => c.name === 'command').ok, false);
  assert.deepEqual(store.list(), []); assert.equal(store.request('same'), null);
});

test('default writer conflicts with same repository through subdirectories and symlinks before task creation', t => {
  const { root, cwd, store, engine } = fixture(t); own(store, cwd);
  const alias = join(root, 'alias'); symlinkSync(cwd, alias);
  for (const path of [join(cwd, 'sub'), alias]) {
    assert.throws(() => engine.spawnDetachedTask({ prompt: 'echo unsafe', cwd: path, adapter: 'bash', request_key: path }), { name: 'WorkspaceBusyError' });
    assert.equal(store.request(path), null);
  }
  assert.equal(store.list().length, 1);
});

test('readers coexist but a writer refuses an active reader; terminal alive owners retain occupancy', t => {
  const { cwd, store, engine } = fixture(t); own(store, cwd, 'read');
  assert.equal((engine as any).preflight({ prompt: 'work', cwd, adapter: 'bash', workspaceAccess: 'read' }).ready, true);
  assert.throws(() => engine.spawnDetachedTask({ prompt: 'echo unsafe', cwd, adapter: 'bash' }), { name: 'WorkspaceBusyError' });
  store.update('owner', { status: 'KILLED', endTime: Date.now() });
  assert.throws(() => engine.spawnDetachedTask({ prompt: 'echo unsafe', cwd, adapter: 'bash' }), { name: 'WorkspaceBusyError' });
  store.update('owner', { pid: undefined });
  const next = engine.spawnDetachedTask({ prompt: 'echo safe', cwd, adapter: 'bash', request_key: 'next' });
  assert.equal(engine.spawnDetachedTask({ prompt: 'echo safe', cwd, adapter: 'bash', request_key: 'next' }).taskId, next.taskId);
});

test('invalid access declarations are refused before execution', t => {
  const { engine, cwd } = fixture(t);
  assert.throws(() => engine.spawnDetachedTask({ prompt: 'echo no', adapter: 'bash', cwd, workspaceAccess: 'guess' } as any), /workspaceAccess/);
});

test('two dispatcher processes atomically admit only one writer', async t => {
  const { root, cwd, store } = fixture(t);
  const { spawn } = await import('node:child_process');
  const engineUrl = new URL('../src/runner/detached.ts', import.meta.url).href;
  const storeUrl = new URL('../src/runner/task-store.ts', import.meta.url).href;
  const code = `const {createTaskEngine}=await import(${JSON.stringify(engineUrl)});const {TaskStore}=await import(${JSON.stringify(storeUrl)});const s=new TaskStore(${JSON.stringify(store.runsDir)});const e=createTaskEngine({store:s,env:{...process.env,AGENT_HUB_TASK_ROOTS:${JSON.stringify(root)}}});try{e.spawnDetachedTask({prompt:'sleep 1',adapter:'bash',cwd:${JSON.stringify(cwd)}});console.log('admitted')}catch(error){console.log(error.name)}finally{s.close()}`;
  const results = await Promise.all([1, 2].map(() => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject); child.on('close', status => status === 0 ? resolve(output.trim()) : reject(Error(error)));
  })));
  assert.deepEqual(results.sort(), ['WorkspaceBusyError', 'admitted'].sort());
});

test('CLI and provider preconditions reject directories instead of calling them files', async t => {
  const { root } = fixture(t);
  const { resolveZcodeCliPath } = await import('../src/adapters/zcode.ts');
  const { resolveCodexCliPath } = await import('../src/adapters/codex.ts');
  const { resolveProviderConfigEnv } = await import('../src/adapters/preconditions.ts');
  assert.equal(resolveZcodeCliPath(root).ok, false);
  assert.equal(resolveCodexCliPath(root).ok, false);
  assert.equal(resolveProviderConfigEnv(join(root, 'cli.cjs'), root).status, 'blocked');
});

test('launch rechecks a removed CLI and inherited provider config readability', async t => {
  const { root } = fixture(t);
  const { ZCodeAdapter } = await import('../src/adapters/zcode.ts');
  const { BUILTIN_PROVIDER_CONFIG_ENV, resolveProviderConfigEnv } = await import('../src/adapters/preconditions.ts');
  const cli = join(root, 'cli.cjs'); writeFileSync(cli, ''); const adapter = new ZCodeAdapter(cli); rmSync(cli);
  assert.throws(() => adapter.checkPreconditions(), (e: any) => e.precondition === 'cli-path');
  const saved = process.env[BUILTIN_PROVIDER_CONFIG_ENV];
  try { process.env[BUILTIN_PROVIDER_CONFIG_ENV] = root; assert.equal(resolveProviderConfigEnv(cli).status, 'blocked'); }
  finally { if (saved === undefined) delete process.env[BUILTIN_PROVIDER_CONFIG_ENV]; else process.env[BUILTIN_PROVIDER_CONFIG_ENV] = saved; }
});
