import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub.ts';
import { startServer } from '../src/server.ts';
import { registerSwarmTools } from '../src/tools.ts';
import { SwarmRunsWatcher } from '../src/watcher.ts';

const pause = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));
async function until(check:()=>boolean) { for(let i=0;i<150;i++) { if(check()) return; await pause(20); } assert.ok(check(),'condition did not become true'); }

test('HTTP and agent tools share project context, idempotency and strict input validation', async () => {
  const root = mkdtempSync(join(tmpdir(),'hub-api-'));
  const hub = createHub({runsDir:join(root,'runs'),env:{...process.env,AGENT_HUB_TASK_ROOTS:root}});
  const tools = new Map<string,any>(); registerSwarmTools({tools:{register:tool=>tools.set(tool.name,tool)}},undefined,hub);
  const server = await startServer(0,{frontend:false,hub}); const base=`http://127.0.0.1:${server.address.port}`;
  const post = (path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try {
    assert.equal((await post('/api/projects',{id:'p',name:'Project',goal:'Keep enough context to continue',cwd:root})).status,201);
    await tools.get('swarm_project_note').execute({projectId:'p',body:'Next: verify the pending result',author:'lead',request_key:'note'});
    const input={prompt:'printf "tail😀"',adapter:'bash',workspaceAccess:'read',projectId:'p',request_key:'same'};
    assert.equal((await (await post('/api/tasks/preflight', input)).json()).ready, true);
    assert.equal((await tools.get('swarm_preflight').execute(input)).ready, true);
    const first=await post('/api/tasks/dispatch',input); assert.equal(first.status,201,await first.clone().text());
    const task=await first.json(); assert.equal(task.cwd,root); assert.equal(task.prompt,input.prompt);
    const again=await tools.get('swarm_dispatch').execute(input); assert.equal(again.taskId,task.taskId);
    assert.equal((await post('/api/tasks/dispatch',{...input,prompt:'different'})).status,409);
    assert.equal((await post('/api/tasks/dispatch',{...input,request_key:'invalid',handoff:true})).status,400);
    assert.equal((await post('/api/tasks/dispatch',{...input,request_key:'invalid'})).status,201);
    assert.equal((await post('/api/tasks/dispatch',{prompt:'echo bad',timeout:'10oops'})).status,400);
    const refused = await post('/api/tasks/dispatch',{prompt:'echo bad',adapter:'typo',workspaceAccess:'read'});
    assert.equal(refused.status,201); assert.equal((await refused.json()).status,'FAILED');
    assert.equal((await post('/api/tasks/dispatch',{prompt:'echo bad',projectId:'missing'})).status,404);
    await until(()=>hub.queries.getTaskDetail(task.taskId)?.status!=='RUNNING');
    const stream=await fetch(base+`/api/tasks/${task.taskId}/stream`); const text=await stream.text();
    assert.match(text,/tail😀/); assert.match(text,/"done":true/);
    const detail=await tools.get('swarm_status').execute({taskId:task.taskId});
    assert.equal(detail.handoff.state,'missing'); assert.equal(detail.projectId,'p');
    const cp = await tools.get('swarm_project_checkpoint').execute({projectId:'p',expectedSequence:0,author:'lead',summary:'Verified',nextStep:'Review',revision:'abc',decision:'pending'});
    assert.equal((await post('/api/projects/p/checkpoints',{expectedSequence:0,author:'lead',summary:'stale',nextStep:'wait'})).status,409);
    const context=await tools.get('swarm_project_context').execute({projectId:'p'});
    assert.equal(context.checkpoint.sequence,cp.sequence);
    assert.equal(context.latestNote.body,'Next: verify the pending result'); assert.ok(context.changesSinceVisit.tasks.length);
    await tools.get('swarm_project_seen').execute({projectId:'p',through:context.changesSinceVisit.through});
    assert.equal((await tools.get('swarm_project_context').execute({projectId:'p'})).changesSinceVisit.tasks.length,0);
    assert.equal((await fetch(base+'/api/projects',{headers:{origin:'https://unrelated.invalid'}})).status,403);
  } finally { await server.close();
    await until(()=>hub.store.list().every(meta=>!meta.pid || existsSync(join(hub.store.dir(meta.taskId),'process-exit.json'))));
    hub.close(); rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});

test('project prompt and sourced handoff reach a dependent text agent without changing retries', async () => {
  const root=mkdtempSync(join(tmpdir(),'hub-context-')); const prompts:string[]=[];
  const final='Done\n\n## Agent Hub Handoff\n```json\n'+JSON.stringify({schemaVersion:1,status:'partial',summary:'Need one more check',nextSteps:['Review evidence']})+'\n```';
  const hub=createHub({runsDir:join(root,'runs'),env:{...process.env,AGENT_HUB_TASK_ROOTS:root},getAdapter:()=>({
    name:'codex',description:'fixture',buildCommand(spec){prompts.push(spec.prompt);return {cmd:process.execPath,args:['-e',`process.stdout.write(${JSON.stringify(final)})`]};},
  })});
  try {
    hub.projects.upsert({id:'p',name:'Project',goal:'A stable goal {{literal}}',cwd:root});
    hub.projects.appendNote('p',{body:'Continue here',author:'lead'});
    const first=hub.engine.spawnDetachedTask({projectId:'p',adapter:'codex',prompt:'Work',handoff:true,request_key:'first'});
    await until(()=>existsSync(join(hub.store.dir(first.taskId),'completion.json')));
    assert.equal(hub.queries.getTaskDetail(first.taskId)?.handoff?.selfReport?.status,'partial');
    const nextInput={projectId:'p',adapter:'codex',prompt:'Follow up',dependsOn:[first.taskId],request_key:'next'};
    const next=hub.engine.spawnDetachedTask(nextInput);
    assert.match(prompts[1],/Need one more check/); assert.match(prompts[1],/A stable goal {{literal}}/);
    hub.projects.appendNote('p',{body:'Later context',author:'lead'});
    assert.equal(hub.engine.spawnDetachedTask(nextInput).taskId,next.taskId); assert.equal(prompts.length,2);
    await until(()=>existsSync(join(hub.store.dir(next.taskId),'completion.json')));
  } finally { hub.close(); rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});

test('durable completion delivery retries failures and resumes after restart without replaying acknowledged work', async () => {
  const root=mkdtempSync(join(tmpdir(),'hub-notices-')); const hub=createHub({runsDir:join(root,'runs'),env:{...process.env,AGENT_HUB_TASK_ROOTS:root}});
  let watcher:SwarmRunsWatcher|undefined;
  try {
    const task=hub.engine.spawnDetachedTask({prompt:'printf done',adapter:'bash',cwd:root});
    await until(()=>existsSync(join(hub.store.dir(task.taskId),'completion.json')));
    let attempts=0;
    watcher=new SwarmRunsWatcher(hub.store,{consumerId:'lead-session',retryMs:25});
    watcher.subscribe(()=>{attempts++;throw new Error('destination unavailable');});
    await watcher.start(); await until(()=>attempts>1); await watcher.stop();
    const delivered:string[]=[];
    watcher=new SwarmRunsWatcher(hub.store,{consumerId:'lead-session',retryMs:25}); watcher.subscribe(meta=>{delivered.push(meta.taskId);});
    await watcher.start(); await until(()=>delivered.length===1); await watcher.stop();
    hub.close();
    watcher=new SwarmRunsWatcher(hub.store,{consumerId:'lead-session',retryMs:25}); watcher.subscribe(meta=>{delivered.push(meta.taskId);});
    await watcher.start(); await pause(100); assert.deepEqual(delivered,[task.taskId]);
  } finally { await watcher?.stop(); hub.close(); rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});
