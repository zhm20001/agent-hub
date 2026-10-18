/** Optional communication protocol. Reports are attributed to agents; never a platform verdict. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './file-storage.ts';

export interface AgentSelfReport {
  schemaVersion: 1;
  status: 'success' | 'partial' | 'blocked';
  summary: string;
  verification?: string[];
  nextSteps?: string[];
  artifacts?: string[];
}
export interface TaskHandoffRecord {
  schemaVersion: 1;
  taskId: string;
  generatedAt: string;
  source: { kind: 'agent-self-report'; finalText: string; rawBlock?: string };
  state: 'reported' | 'missing' | 'invalid' | 'interrupted';
  selfReport?: AgentSelfReport;
  reason?: string;
}
const allowedKeys = new Set(['schemaVersion','status','summary','verification','nextSteps','artifacts']);
function isSelfReport(value: unknown): value is AgentSelfReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).every(k => allowedKeys.has(k)) && r.schemaVersion === 1
    && ['success','partial','blocked'].includes(r.status as string)
    && typeof r.summary === 'string' && r.summary.trim().length > 0
    && ['verification','nextSteps','artifacts'].every(k => r[k] === undefined || (Array.isArray(r[k]) && (r[k] as unknown[]).every(v => typeof v === 'string')));
}
/** Parse only the named protocol section, preserving the original block for audit. */
export function writeTaskHandoff(taskDir: string, input: {
  taskId: string;
  finalText: string | { kind: string; value?: string };
  status: string;
  now?: () => Date;
}): TaskHandoffRecord {
  const text = typeof input.finalText === 'string' ? input.finalText : input.finalText.kind === 'text' ? input.finalText.value ?? '' : '';
  const headings = [...text.matchAll(/^## Agent Hub Handoff\s*\r?$/gm)];
  const sectionStart = headings[0]?.index;
  const section = sectionStart === undefined ? '' : text.slice(sectionStart);
  const nextHeading = section.indexOf('\n## ', 1);
  const isolated = nextHeading < 0 ? section : section.slice(0, nextHeading);
  const match = /^## Agent Hub Handoff[^\S\r\n]*\r?\n\s*```json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```[^\S\r\n]*(?:\r?\n|$)/.exec(isolated);
  const record: TaskHandoffRecord = {
    schemaVersion: 1, taskId: input.taskId, generatedAt: (input.now?.() ?? new Date()).toISOString(),
    source: { kind: 'agent-self-report', finalText: 'resolution.json#/resolution/finalText', ...(match ? { rawBlock: match[0].trimEnd() } : {}) },
    state: 'missing',
  };
  if (input.status !== 'COMPLETED') {
    record.state = 'interrupted'; record.reason = `Task ended as ${input.status}; output is not an accepted handoff.`;
  } else if (headings.length !== 0) {
    record.state = 'invalid'; record.reason = 'Expected exactly one headed JSON object conforming to schemaVersion 1.';
    if (headings.length === 1 && match && !isolated.slice(match[0].length).trim()) {
      try { const parsed = JSON.parse(match[1]); if (isSelfReport(parsed)) { record.state='reported'; record.selfReport=parsed; delete record.reason; } } catch { /* Preserve invalid source without inferring a result. */ }
    }
  } else record.reason = 'No explicit Agent Hub Handoff section.';
  atomicWrite(join(taskDir,'handoff.json'), JSON.stringify(record,null,2)+'\n');
  return record;
}
export function readTaskHandoff(taskDir: string): TaskHandoffRecord | null {
  try {
    const value = JSON.parse(readFileSync(join(taskDir,'handoff.json'),'utf8'));
    if (value?.schemaVersion !== 1 || typeof value.taskId !== 'string' || typeof value.generatedAt !== 'string'
      || value.source?.kind !== 'agent-self-report' || typeof value.source.finalText !== 'string'
      || !['reported','missing','invalid','interrupted'].includes(value.state)) return null;
    if (value.state === 'reported' ? !isSelfReport(value.selfReport) : value.selfReport !== undefined) return null;
    return value;
  } catch { return null; }
}

/** Replaces only placeholders in the template itself, never in substituted user text. */
export function renderPromptTemplate(template: string, values: Record<string,string>): string {
  return template.replace(/{{([^{}]+)}}/g, (_, raw: string) => {
    const key=raw.trim(); if (!Object.hasOwn(values,key)) throw new Error(`Unresolved prompt template placeholder: ${key}`);
    return values[key];
  });
}
export interface PromptOptions { prompt: string; adapter?: string; handoff?: boolean; dependsOn?: string[]; projectId?: string }
export interface PromptContext {
  getTask(id: string): { meta: { taskId?: string; status: string; projectId?: string }; closingRecord?: unknown; handoff?: unknown } | null | undefined;
  projectContextText?: string;
}
const MAX_CONTEXT_CHARS = 12000;
function bounded(text: string, max: number, source: string): string {
  return text.length <= max ? text : text.slice(0,Math.max(0,max-100)) + `\n[truncated source ${source}; read the original for remaining context]`;
}
export function prepareTaskPrompt(options: PromptOptions, context: PromptContext): string {
  const deps = options.dependsOn ?? [];
  if (!Array.isArray(deps) || deps.some(d => typeof d !== 'string' || !d.trim()) || deps.length > 32 || new Set(deps).size !== deps.length) throw new Error('Invalid dependency task IDs (maximum 32 distinct IDs).');
  const requested = options.handoff === true || deps.length > 0 || Boolean(context.projectContextText);
  if (!requested) return options.prompt;
  if (options.adapter === 'bash') throw new Error('bash accepts literal commands; handoff or natural-language dependency/project context injection is unsupported.');
  if (options.adapter && !['zcode','codex'].includes(options.adapter)) throw new Error(`Prompt context is unsupported for adapter ${options.adapter}`);
  const chunks: string[] = [];
  if (context.projectContextText) chunks.push('### Project context\n'+bounded(context.projectContextText,4000,'project'));
  for (const id of deps) {
    const task = context.getTask(id);
    if (!task) throw new Error(`Unknown dependency task: ${id}`);
    if (!['COMPLETED','FAILED','KILLED','TIMEOUT_KILLED'].includes(task.meta.status)) throw new Error(`Dependency task is still running: ${id}`);
    if (task.meta.projectId !== options.projectId) throw new Error(`Cross-project dependency rejected: ${id}`);
    const handoff = task.handoff as TaskHandoffRecord | null | undefined;
    const material = handoff?.state === 'reported'
      ? JSON.stringify({ sourceTaskId:id, state:handoff.state, source:handoff.source, agentSelfReport:handoff.selfReport })
      : `[missing handoff: ${handoff?.state ?? 'not recorded'}; source ${id}/resolution.json]\n${JSON.stringify(task.closingRecord ?? null)}`;
    chunks.push(`### Upstream task ${JSON.stringify(id)} (mechanical status ${task.meta.status})\n`+bounded(material,3000,`${id}/handoff.json`));
  }
  const appendix: string[] = [];
  if (chunks.length) {
    const template=readFileSync(new URL('../prompts/context.md',import.meta.url),'utf8');
    appendix.push(renderPromptTemplate(template,{context:bounded(chunks.join('\n\n'),MAX_CONTEXT_CHARS,'upstream context')}));
  }
  // Dependencies opt into the same response contract, so the next task can hand back context too.
  if (options.handoff || deps.length) appendix.push(renderPromptTemplate(readFileSync(new URL('../prompts/handoff.md',import.meta.url),'utf8'),{}));
  return options.prompt+'\n\n'+appendix.join('\n\n');
}
