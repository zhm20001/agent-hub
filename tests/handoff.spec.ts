import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { prepareTaskPrompt, readTaskHandoff, renderPromptTemplate, writeTaskHandoff } from '../src/runner/handoff.ts';
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'hub-handoff-')); dirs.push(d); return d; };
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
const block = (value: unknown) => '## Agent Hub Handoff\n```json\n' + JSON.stringify(value) + '\n```';
const report = { schemaVersion: 1, status: 'success', summary: 'Implemented login', verification: ['unit tests passed'] };
test('stores a strict, explicitly headed Agent self-report with source', () => {
 const d = dir(); const text = 'Details\n' + block(report);
 const record = writeTaskHandoff(d, { taskId: 't1', finalText: {kind:'text',value:text}, status:'COMPLETED', now: () => new Date('2026-10-18T00:00:00Z') });
 assert.equal(record.state, 'reported'); assert.deepEqual(record.selfReport, report);
 assert.equal(record.generatedAt, '2026-10-18T00:00:00.000Z');
 assert.equal(record.source.rawBlock, block(report)); assert.match(record.source.finalText, /resolution.json/);
 assert.deepEqual(readTaskHandoff(d), record); assert.equal(JSON.parse(readFileSync(join(d,'handoff.json'),'utf8')).taskId, 't1');
});
test('does not infer a report from prose, unheaded JSON or invalid schema', () => {
 for (const text of ['success', '```json\n'+JSON.stringify(report)+'\n```', block({...report, unexpected:true}), block({...report,verification:'passed'}), block({...report,summary:''}), block(report)+'\n'+block(report)]) {
  const result=writeTaskHandoff(dir(), {taskId:'t1',finalText:text,status:'COMPLETED'}); assert.notEqual(result.state,'reported'); assert.equal(result.selfReport,undefined);
 }
});
test('failed, killed and timed out tasks cannot advertise a valid successful handoff', () => {
 for (const status of ['FAILED','KILLED','TIMEOUT_KILLED']) { const r=writeTaskHandoff(dir(),{taskId:'t1',finalText:block(report),status}); assert.equal(r.state,'interrupted'); assert.equal(r.selfReport,undefined); assert.equal(r.source.rawBlock, block(report)); }
});
test('bash commands remain exact and reject language injection requests', () => {
 const prompt='printf "{{ raw }}"\n'; assert.equal(prepareTaskPrompt({prompt,adapter:'bash'},{getTask:()=>null}),prompt);
 assert.throws(()=>prepareTaskPrompt({prompt,adapter:'bash',handoff:true},{getTask:()=>null}),/bash/);
 assert.throws(()=>prepareTaskPrompt({prompt,adapter:'bash',dependsOn:['t1']},{getTask:()=>null}),/bash/);
});
test('templates substitute once without executing placeholders in user input', () => {
 assert.equal(renderPromptTemplate('hello {{prompt}}',{prompt:'{{context}}'}),'hello {{context}}');
 assert.throws(()=>renderPromptTemplate('{{missing}}',{prompt:'x'}),/missing/);
 const prompt='Implement {{literal}}'; const r=prepareTaskPrompt({prompt,adapter:'codex',handoff:true},{getTask:()=>null}); assert.ok(r.startsWith(prompt)); assert.match(r,/Agent Hub Handoff/); assert.match(r,/agent self-report/i);
});
test('dependency context checks ownership and terminal status, and bounds source text', () => {
 const getTask = (id:string) => id==='missing' ? null : {meta:{taskId:id,status:id==='running'?'RUNNING':'COMPLETED',projectId:id==='foreign'?'other':'p'},handoff:id==='up' ? {state:'reported',source:{rawBlock:'X'.repeat(30000)},selfReport:report} : null};
 for (const id of ['missing','running','foreign']) assert.throws(()=>prepareTaskPrompt({prompt:'next',adapter:'zcode',projectId:'p',dependsOn:[id]},{getTask}), /dependency/i);
 const result=prepareTaskPrompt({prompt:'next',adapter:'zcode',projectId:'p',dependsOn:['up','no-report']},{getTask});
 assert.match(result,/up/); assert.match(result,/truncated/i); assert.match(result,/missing handoff/i); assert.ok(result.length<20000);
});
test('project context is bounded, optional and never interprets user placeholders', () => {
 const prompt='Keep {{user}} exact';
 assert.equal(prepareTaskPrompt({prompt,adapter:'bash',projectId:'p'},{getTask:()=>null}),prompt);
 const result=prepareTaskPrompt({prompt,adapter:'codex',projectId:'p'},{getTask:()=>null,projectContextText:'Project {{literal}}\n'+'x'.repeat(10000)});
 assert.ok(result.startsWith(prompt));assert.match(result,/Project {{literal}}/);assert.match(result,/truncated source project/);assert.ok(result.length<6000);
});
