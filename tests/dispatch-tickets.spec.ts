/**
 * Unit tests for scripts/dispatch-tickets.mjs helpers.
 * Fixtures only — no live board / no ZCode tokens.
 *
 * Run with: node --import tsx --test tests/dispatch-tickets.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  READY_SIGNAL,
  applyDefaults,
  isReadyTask,
  loadTicket,
  parseArgs,
  parseMattField,
  typeToken,
  toPayload,
} from '../scripts/dispatch-tickets.mjs';

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'dispatch-tickets-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe('parseMattField / typeToken', () => {
  it('reads Type and Status from Matt body lines', () => {
    const body = `# 03: Wire login

Type: task
Status: ready-for-agent

**Blocked by:** None
`;
    assert.equal(parseMattField(body, 'Type'), 'task');
    assert.equal(parseMattField(body, 'Status'), READY_SIGNAL);
    assert.equal(typeToken('parking-lot（不是待办票）'), 'parking-lot');
    assert.equal(typeToken('task'), 'task');
  });

  it('reads bold Matt Status line', () => {
    assert.equal(
      parseMattField('**Status:** ready-for-agent\n', 'Status'),
      READY_SIGNAL,
    );
  });
});

describe('isReadyTask filter', () => {
  it('accepts Type: task + Status ready-for-agent from body', () => {
    const gate = isReadyTask({
      prompt: 'Type: task\nStatus: ready-for-agent\n\nDo the thing.\n',
    });
    assert.deepEqual(gate, { ok: true });
  });

  it('rejects grilling / parking-lot / missing type', () => {
    assert.equal(
      isReadyTask({ prompt: 'Type: grilling\nStatus: ready-for-agent\n' }).ok,
      false,
    );
    assert.equal(
      isReadyTask({ prompt: 'Type: parking-lot（x）\nStatus: ready-for-agent\n' }).ok,
      false,
    );
    assert.match(
      String(isReadyTask({ prompt: 'Status: ready-for-agent\n' }).reason),
      /missing-type/,
    );
  });

  it('rejects task that is not ready-for-agent', () => {
    const gate = isReadyTask({
      prompt: 'Type: task\nStatus: closed\n',
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'not-ready-for-agent');
  });

  it('accepts frontmatter type + status', () => {
    const gate = isReadyTask({
      prompt: 'Implement login.\n',
      meta: { type: 'task', status: 'ready-for-agent' },
    });
    assert.deepEqual(gate, { ok: true });
  });

  it('accepts frontmatter labels containing ready-for-agent', () => {
    const gate = isReadyTask({
      prompt: 'Type: task\nStatus: open\n',
      meta: { labels: ['ready-for-agent', 'p1'] },
    });
    assert.deepEqual(gate, { ok: true });
  });
});

describe('applyDefaults / parseArgs', () => {
  it('fills cwd and adapter only when ticket omitted them', () => {
    const t = applyDefaults(
      { prompt: 'x', source: 'a.md', cwd: '/ticket/cwd' },
      { cwd: '/default/cwd', adapter: 'bash' },
    );
    assert.equal(t.cwd, '/ticket/cwd');
    assert.equal(t.adapter, 'bash');
  });

  it('CLI --cwd/--adapter override env; ticket still wins in applyDefaults', () => {
    const parsed = parseArgs(
      ['./tickets', '--cwd', '/cli/cwd', '--adapter', 'bash'],
      {
        AGENT_HUB_DEFAULT_CWD: '/env/cwd',
        AGENT_HUB_DEFAULT_ADAPTER: 'zcode',
      },
    );
    assert.ok(!('error' in parsed));
    assert.equal(parsed.defaultCwd, '/cli/cwd');
    assert.equal(parsed.defaultAdapter, 'bash');

    const fromEnv = parseArgs(['./tickets'], {
      AGENT_HUB_DEFAULT_CWD: '/env/cwd',
      AGENT_HUB_DEFAULT_ADAPTER: 'zcode',
    });
    assert.equal(fromEnv.defaultCwd, '/env/cwd');
    assert.equal(fromEnv.defaultAdapter, 'zcode');
  });
});

describe('loadTicket + toPayload with defaults', () => {
  it('loads Matt md without frontmatter and applies directory defaults', () => {
    const dir = scratch();
    const path = join(dir, '03-wire-login.md');
    writeFileSync(
      path,
      `# 03: Wire login

Type: task
Status: ready-for-agent

**What to build:** login form works.

**Blocked by:** None (can start immediately)

- [ ] happy path
`,
      'utf8',
    );
    const t = loadTicket(path);
    assert.ok(t);
    assert.equal(t!.ticket, '03-wire-login');
    assert.deepEqual(isReadyTask(t!), { ok: true });
    applyDefaults(t!, { cwd: '/ws', adapter: 'bash' });
    const payload = toPayload(t!);
    assert.equal(payload.cwd, '/ws');
    assert.equal(payload.adapter, 'bash');
    assert.equal(payload.ticket, '03-wire-login');
    assert.match(String(payload.prompt), /Type: task/);
  });

  it('skips grilling ticket via isReadyTask after load', () => {
    const dir = scratch();
    const path = join(dir, '01-adapter-contract.md');
    writeFileSync(
      path,
      `# 01

Type: grilling
Status: ready-for-agent

## Question
why?
`,
      'utf8',
    );
    const t = loadTicket(path);
    assert.ok(t);
    const gate = isReadyTask(t!);
    assert.equal(gate.ok, false);
    assert.match(String(gate.reason), /not-task/);
  });
});

// Exercise the actual remote board contract, independent of local .swarm-runs.
import { createServer } from 'node:http';
import { runDispatch, isEligible } from '../scripts/dispatch-tickets.mjs';
async function board(handler: (req: any, res: any) => void, use: (url:string)=>Promise<void>) {
 const server=createServer(handler); await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const address=server.address() as {port:number}; try { await use(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>(done=>server.close(()=>done())); }
}
it('remote roster prevents dispatch and resolves dependencies with stable request keys',async()=>{
 const dir=scratch(); writeFileSync(join(dir,'next.json'),JSON.stringify({ticket:'next',type:'task',status:'ready-for-agent',prompt:'continue',adapter:'codex',projectId:'p',blockedBy:[{ticket:'prior',condition:'self-report-success'}]}));
 const payloads:any[]=[]; const paths:string[]=[];
 await board((req,res)=>{ paths.push(req.url); res.setHeader('content-type','application/json');
  if(req.method==='GET') { res.end(JSON.stringify([{taskId:'upstream',ticket:'prior',projectId:'p',status:'COMPLETED',handoff:{state:'reported',selfReport:{schemaVersion:1,status:'success',summary:'done'}}}])); return; }
  let raw=''; req.on('data',(c:any)=>raw+=c); req.on('end',()=>{payloads.push(JSON.parse(raw));res.statusCode=201;res.end(JSON.stringify({taskId:'new',status:'RUNNING'}));});
 },async url=>{ assert.equal(await runDispatch({ticketsDir:dir,baseUrl:url}),0); assert.equal(await runDispatch({ticketsDir:dir,baseUrl:url}),0); });
 assert.deepEqual(payloads[0].dependsOn,['upstream']); assert.equal(payloads[0].request_key,payloads[1].request_key); assert.match(payloads[0].request_key,/^ticket-/); assert.ok(paths.includes('/api/tasks?includeArchived=1'));
});
it('remote already-dispatched tickets are skipped and roster errors fail closed',async()=>{
 const dir=scratch();writeFileSync(join(dir,'a.json'),JSON.stringify({ticket:'a',type:'task',status:'ready-for-agent',prompt:'x'}));let posts=0;
 await board((req,res)=>{ if(req.method==='POST')posts++; res.setHeader('content-type','application/json');res.end(JSON.stringify([{taskId:'existing',ticket:'a',status:'RUNNING'}])); },async url=>assert.equal(await runDispatch({ticketsDir:dir,baseUrl:url}),0));assert.equal(posts,0);
 await board((_req,res)=>{res.statusCode=503;res.end('unavailable');},async url=>assert.equal(await runDispatch({ticketsDir:dir,baseUrl:url}),1));
});
it('self-report gate does not accept mechanical completion alone and validates gate schema',()=>{
 const completed=new Set(['a']);const dispatched=new Set<string>();
 assert.equal(isEligible({blockedBy:[{ticket:'a',condition:'self-report-success'}]},completed,dispatched,new Map([['a',{status:'COMPLETED'}]])).ok,false);
 assert.throws(()=>isEligible({blockedBy:[{ticket:'a',condition:'eval something'}]},completed,dispatched),/condition/);
});
for (const adapter of ['bash','shell']) it(`${adapter} dependencies gate dispatch without changing the literal command or injecting context`,async()=>{
 const dir=scratch();writeFileSync(join(dir,'b.json'),JSON.stringify({ticket:'b',type:'task',status:'ready-for-agent',prompt:'printf "{{x}}"',adapter,blockedBy:['a']}));let payload:any;
 await board((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify([{taskId:'up',ticket:'a',status:'COMPLETED'}]));return;}let raw='';req.on('data',(c:any)=>raw+=c);req.on('end',()=>{payload=JSON.parse(raw);res.statusCode=201;res.end('{}');});},async url=>assert.equal(await runDispatch({ticketsDir:dir,baseUrl:url}),0));
 assert.equal(payload.prompt,'printf "{{x}}"');assert.equal(payload.dependsOn,undefined);
});
it('same ticket in another project cannot satisfy dependency or suppress this project dispatch',async()=>{
 const dir=scratch();writeFileSync(join(dir,'a.json'),JSON.stringify({ticket:'a',type:'task',status:'ready-for-agent',prompt:'x',projectId:'p',adapter:'codex'}));
 writeFileSync(join(dir,'b.json'),JSON.stringify({ticket:'b',type:'task',status:'ready-for-agent',prompt:'x',projectId:'p',blockedBy:['foreign']}));const seen:any[]=[];
 await board((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify([{taskId:'old',ticket:'a',projectId:'q',status:'COMPLETED'},{taskId:'wrong',ticket:'foreign',projectId:'q',status:'COMPLETED'}]));return;}let raw='';req.on('data',(c:any)=>raw+=c);req.on('end',()=>{seen.push(JSON.parse(raw));res.statusCode=201;res.end('{"taskId":"new","status":"RUNNING"}');});},async url=>assert.equal(await runDispatch({ticketsDir:dir,baseUrl:url}),0));
 assert.deepEqual(seen.map(p=>p.ticket),['a']);
});
