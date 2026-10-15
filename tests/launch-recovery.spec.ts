import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const runnerUrl = new URL('../src/runner/detached.ts', import.meta.url).href;
const storeUrl = new URL('../src/runner/task-store.ts', import.meta.url).href;
const reconcileUrl = new URL('../src/runner/reconcile.ts', import.meta.url).href;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function execute(cwd: string, code: string) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
    { cwd, env: { ...process.env, AGENT_HUB_TASK_ROOTS: cwd, AGENT_HUB_MAX_CONCURRENT: '1' }, encoding: 'utf8', timeout: 10000 });
}
test('a metadata write failure cannot start an untracked Agent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-launch-fail-')));
  try {
    const result = execute(root, `
      const { TaskStore } = await import(${JSON.stringify(storeUrl)});
      const runner = await import(${JSON.stringify(runnerUrl)});
      TaskStore.prototype.writeInitial = function() { throw Error('injected disk failure'); };
      try { runner.spawnDetachedTask({taskId:'failed', adapter:'bash',prompt:'echo $$ > agent.pid; sleep 5'}); } catch {}
      process.exit(0);
    `);
    assert.equal(result.status, 0, result.stderr);
    await wait(150);
    assert.equal(existsSync(join(root, 'agent.pid')), false, 'no child may start before reservation is durable');
  } finally {
    if (existsSync(join(root, 'agent.pid'))) { try { process.kill(-Number(readFileSync(join(root, 'agent.pid'), 'utf8')), 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});
test('a dispatcher crash before saving pid leaves a discoverable process and reserves its slot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-launch-crash-')));
  let pid: number | undefined;
  try {
    const result = execute(root, `
      const { TaskStore } = await import(${JSON.stringify(storeUrl)});
      const runner = await import(${JSON.stringify(runnerUrl)});
      const original = TaskStore.prototype.update;
      TaskStore.prototype.update = function(id, patch) { if (patch.pid) process.exit(0); return original.call(this,id,patch); };
      runner.spawnDetachedTask({taskId:'crashed',adapter:'bash',prompt:'echo ready > started; sleep 30'});
    `);
    assert.equal(result.status, 0, result.stderr);
    for (let i=0;i<100 && !existsSync(join(root,'started'));i++) await wait(10);
    assert.ok(existsSync(join(root, 'started')));
    const pidFile = join(root,'.swarm-runs/crashed/process.pid');
    assert.ok(existsSync(pidFile), 'launcher records its identity before starting the Agent');
    pid = Number(readFileSync(pidFile,'utf8'));
    const recovered = execute(root, `
      import assert from 'node:assert/strict';
      const runner = await import(${JSON.stringify(runnerUrl)});
      const { reconcileOrphanTask } = await import(${JSON.stringify(reconcileUrl)});
      reconcileOrphanTask('crashed');
      assert.equal(runner.readTaskMeta('crashed').status,'RUNNING');
      assert.ok(runner.readTaskMeta('crashed').pid);
      assert.throws(()=>runner.spawnDetachedTask({adapter:'bash',prompt:'true'}),e=>e.name==='ConcurrentCapError');
      runner.terminateTask('crashed','cancelled');
    `);
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally {
    if (!pid) { try { pid = JSON.parse(readFileSync(join(root,'.swarm-runs/crashed/meta.json'),'utf8')).pid; } catch {} }
    if (pid) { try { process.kill(-pid,'SIGKILL'); } catch {} }
    rmSync(root, { recursive:true,force:true });
  }
});

for (const action of ['recover', 'cancel']) {
  test(`${action} can win before a delayed supervisor registers without starting an Agent`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-launch-delayed-')));
    try {
      const result = execute(root, `
        import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
        const originalSpawn=cp.spawn;
        cp.spawn=function(command,args,options) {
          if (args[0]==='-e') args=[...args.slice(0,1),'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);'+args[1],...args.slice(2)];
          return originalSpawn(command,args,options);
        }; syncBuiltinESMExports();
        const {TaskStore}=await import(${JSON.stringify(storeUrl)});
        const runner=await import(${JSON.stringify(runnerUrl)});
        const original=TaskStore.prototype.update;
        TaskStore.prototype.update=function(id,patch){if(patch.pid) process.exit(0); return original.call(this,id,patch);};
        runner.spawnDetachedTask({taskId:'delayed',adapter:'bash',prompt:'echo should-not-start > started'});
      `);
      assert.equal(result.status,0,result.stderr);
      const stopped=execute(root, `
        import assert from 'node:assert/strict';
        const runner=await import(${JSON.stringify(runnerUrl)});
        const {reconcileOrphanTask}=await import(${JSON.stringify(reconcileUrl)});
        ${action === 'recover' ? "reconcileOrphanTask('delayed');" : "runner.terminateTask('delayed','cancelled');"}
        assert.equal(runner.readTaskMeta('delayed').status,${JSON.stringify(action === 'recover' ? 'COMPLETED' : 'KILLED')});
      `);
      assert.equal(stopped.status,0,stopped.stderr);
      await wait(600);
      assert.equal(existsSync(join(root,'started')),false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
}

test('failure opening the log after reservation releases the dispatch slot', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-launch-open-')));
  try {
    const result = execute(root, `
      import assert from 'node:assert/strict';
      import {rmSync,mkdirSync} from 'node:fs'; import {join} from 'node:path';
      const {TaskStore}=await import(${JSON.stringify(storeUrl)});
      const runner=await import(${JSON.stringify(runnerUrl)});
      const original=TaskStore.prototype.writeInitial;
      TaskStore.prototype.writeInitial=function(meta){
        original.call(this,meta);
        if(meta.taskId==='bad-log') {const path=join(this.dir(meta.taskId),'raw.log');rmSync(path);mkdirSync(path);}
      };
      try {runner.spawnDetachedTask({taskId:'bad-log',adapter:'bash',prompt:'true'});} catch {}
      assert.equal(runner.readTaskMeta('bad-log').status,'FAILED');
      const next=runner.spawnDetachedTask({taskId:'next',adapter:'bash',prompt:'true'});
      assert.equal(next.status,'RUNNING');
    `);
    assert.equal(result.status,0,result.stderr);
  } finally {rmSync(root,{recursive:true,force:true});}
});
