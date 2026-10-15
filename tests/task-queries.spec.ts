import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const queryUrl = new URL('../src/runner/task-queries.ts', import.meta.url).href;
const storeUrl = new URL('../src/runner/task-store.ts', import.meta.url).href;
const recordUrl = new URL('../src/runner/settlement.ts', import.meta.url).href;
const serverUrl = new URL('../src/server.ts', import.meta.url).href;
const toolsUrl = new URL('../src/tools.ts', import.meta.url).href;

test('isolated queries repair tasks, share transcript data, backfill individual fields and bound log tails', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-queries-')));
  try {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { writeFileSync, existsSync } from 'node:fs'; import { join } from 'node:path';
      const queries = await import(${JSON.stringify(queryUrl)});
      const {defaultTaskStore: store} = await import(${JSON.stringify(storeUrl)});
      const { writeRunRecord } = await import(${JSON.stringify(recordUrl)});
      const make = (id, patch={}) => ({ taskId:id,label:id,prompt:'fixture',cwd:process.cwd(),adapter:'zcode',status:'RUNNING',pid:process.pid,startTime:Date.now()-1000,timeout:7200,...patch });
      assert.equal(queries.getTaskDetail('missing'),null);
      assert.equal(queries.getTaskConversation('missing'),null);
      store.create(make('live'));
      assert.equal(queries.getTaskDetail('live').status,'RUNNING');
      store.create(make('orphan',{adapter:'bash',pid:2147483646}));
      assert.equal(queries.getTaskDetail('orphan').status,'COMPLETED');
      assert.equal(existsSync(join(store.dir('orphan'),'completion.json')),true);
      store.create(make('ended',{status:'COMPLETED',modelId:'known-model'}));
      const path = join(process.cwd(),'transcript.jsonl');
      writeFileSync(path,JSON.stringify({ model:{modelId:'other-model',providerId:'provider'},response:{text:'final answer'} }));
      writeRunRecord(store.dir('ended'),{ taskId:'ended',transcriptPath:path,resolution:{taskId:'ended',finalText:{kind:'text',value:'fallback'}},observation:{producedOutput:true,unmetPreconditions:[]} });
      writeFileSync(join(store.dir('ended'),'raw.log'),'x'.repeat(2*1024*1024)+'tail😀');
      const detail = queries.getTaskDetail('ended'); const conversation = queries.getTaskConversation('ended');
      assert.equal(detail.modelId,'known-model'); assert.equal(detail.providerId,'provider');
      assert.equal(detail.lastTurn.fullText,'final answer');
      assert.equal(conversation.turns.at(-1).fullText,detail.lastTurn.fullText);
      assert.equal(detail.rawLogTail.length,5000); assert.ok(detail.rawLogTail.endsWith('tail😀'));
      store.update('ended',{archived:true});
      assert.equal(queries.listTasks().some(t=>t.taskId==='ended'),false);
      assert.equal(queries.listTasks({includeArchived:true}).some(t=>t.taskId==='ended'),true);
      store.create(make('timeout',{adapter:'bash',status:'TIMEOUT_KILLED'}));
      assert.equal(queries.getTaskConversation('timeout').emptyReason,'timeout-no-transcript');
      store.create(make('cancelled',{adapter:'bash',status:'KILLED'}));
      assert.equal(queries.getTaskDetail('cancelled').closingRecord.resolution.stopCause,'cancelled');
      const { registerSwarmTools } = await import(${JSON.stringify(toolsUrl)});
      const registered = new Map(); registerSwarmTools({ tools:{register(tool){registered.set(tool.name,tool);}} });
      const toolDetail = await registered.get('swarm_status').execute({taskId:'ended'});
      assert.equal(toolDetail.lastTurn.fullText,detail.lastTurn.fullText);
      const { startServer } = await import(${JSON.stringify(serverUrl)});
      const runtime = await startServer(0,{frontend:false,host:'127.0.0.1'});
      try {
        const base='http://127.0.0.1:'+runtime.address.port;
        const httpDetail=await (await fetch(base+'/api/tasks/ended')).json();
        assert.equal(httpDetail.lastTurn.fullText,detail.lastTurn.fullText);
        const httpConversation=await (await fetch(base+'/api/tasks/ended/conversation')).json();
        assert.equal(httpConversation.turns.at(-1).fullText,detail.lastTurn.fullText);
        assert.equal((await fetch(base+'/api/tasks/missing')).status,404);
      } finally { await runtime.close(); }
    `], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
