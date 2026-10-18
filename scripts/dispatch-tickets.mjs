#!/usr/bin/env node
/**
 * Batch-dispatch Matt-style ticket files to Agent Hub Face B.
 * Reads a tickets directory of .md (YAML front matter) / .json files and
 * POSTs each eligible ticket to /api/tasks/dispatch. No LLM.
 *
 * Usage:
 *   node scripts/dispatch-tickets.mjs <ticketsDir> [--dry-run] [--base-url URL]
 *     [--passes N] [--cwd PATH] [--adapter NAME]
 *
 * Directory defaults (ticket frontmatter wins when set):
 *   --cwd / AGENT_HUB_DEFAULT_CWD
 *   --adapter / AGENT_HUB_DEFAULT_ADAPTER
 *
 * Eligibility filter (in addition to blockedBy / already-dispatched):
 *   Type must be task AND status must be ready-for-agent
 *   (body Type:/Status: lines, or frontmatter type/status/label).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CWD_ENV = 'AGENT_HUB_DEFAULT_CWD';
export const DEFAULT_ADAPTER_ENV = 'AGENT_HUB_DEFAULT_ADAPTER';
export const READY_SIGNAL = 'ready-for-agent';

/**
 * Minimal YAML front-matter parser (flat keys only; enough for ticket files).
 * @param {string} text
 * @returns {{ meta: Record<string, unknown>, body: string } | null}
 */
export function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const yaml = text.slice(3, end).replace(/^\r?\n/, '');
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  /** @type {Record<string, unknown>} */
  const meta = {};
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();
    if (raw === 'true') meta[key] = true;
    else if (raw === 'false') meta[key] = false;
    else if (raw === '[]') meta[key] = [];
    else if (/^\[.*\]$/.test(raw)) {
      const inner = raw.slice(1, -1).trim();
      meta[key] = inner.length === 0
        ? []
        : inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (/^-?\d+$/.test(raw)) meta[key] = Number.parseInt(raw, 10);
    else meta[key] = raw.replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

/**
 * Read a Matt-style field from ticket body: `Type: …` / `**Type:** …`
 * (first matching line). Value is trimmed raw remainder of the line.
 * @param {string} text
 * @param {string} name
 * @returns {string | undefined}
 */
export function parseMattField(text, name) {
  // Matt uses `**Status:** value` (colon inside bold) or plain `Status: value`.
  const re = new RegExp(
    `^(?:\\*\\*${name}:\\*\\*|\\*\\*${name}\\*\\*\\s*:|${name}\\s*:)\\s*(.+)$`,
    'im',
  );
  const m = re.exec(text);
  return m ? m[1].trim().replace(/^\\*\\*\\s*|\\s*\\*\\*$/g, '') : undefined;
}

/**
 * First token of a Type line (stops at whitespace or paren / fullwidth paren).
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
export function typeToken(raw) {
  if (raw === undefined) return undefined;
  const m = /^([^\s（(]+)/.exec(raw.trim());
  return m ? m[1] : undefined;
}

/**
 * Dispatch accepts only Type: task AND ready-for-agent.
 *
 * Signals (first match wins per axis):
 * - type: frontmatter `type`, else body `Type:` / `**Type:**` (token must be `task`)
 * - ready: body `Status:` / `**Status:**` contains `ready-for-agent`,
 *   OR frontmatter `status` / `label` string contains it,
 *   OR frontmatter `labels` array includes it
 *
 * @param {{ type?: string, status?: string, label?: string, labels?: string[], prompt: string, meta?: Record<string, unknown> }} ticket
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function isReadyTask(ticket) {
  const body = ticket.prompt ?? '';
  const meta = ticket.meta ?? {};

  const typeRaw =
    (typeof ticket.type === 'string' ? ticket.type : undefined)
    ?? (typeof meta.type === 'string' ? meta.type : undefined)
    ?? parseMattField(body, 'Type');
  const type = typeToken(typeRaw);
  if (type !== 'task') {
    return { ok: false, reason: type ? `not-task:type=${type}` : 'not-task:missing-type' };
  }

  const statusBody = parseMattField(body, 'Status');
  const statusFm = typeof meta.status === 'string' ? meta.status
    : (typeof ticket.status === 'string' ? ticket.status : undefined);
  const labelFm = typeof meta.label === 'string' ? meta.label
    : (typeof ticket.label === 'string' ? ticket.label : undefined);
  const labelsFm = Array.isArray(meta.labels) ? meta.labels.map(String)
    : (Array.isArray(ticket.labels) ? ticket.labels.map(String) : []);

  const ready =
    (statusBody !== undefined && statusBody.includes(READY_SIGNAL))
    || (statusFm !== undefined && statusFm.includes(READY_SIGNAL))
    || (labelFm !== undefined && labelFm.includes(READY_SIGNAL))
    || labelsFm.some((l) => l.includes(READY_SIGNAL));

  if (!ready) {
    return { ok: false, reason: 'not-ready-for-agent' };
  }
  return { ok: true };
}

/**
 * Apply directory-level cwd/adapter defaults when ticket omitted them.
 * Precedence: ticket field > CLI/env default > leave unset.
 * @param {Ticket} ticket
 * @param {{ cwd?: string, adapter?: string }} defaults
 */
export function applyDefaults(ticket, defaults) {
  if (!ticket.cwd && defaults.cwd) ticket.cwd = defaults.cwd;
  if (!ticket.adapter && defaults.adapter) ticket.adapter = defaults.adapter;
  return ticket;
}

/** @typedef {{
 *   ticket?: string,
 *   label?: string,
 *   prompt: string,
 *   adapter?: string,
 *   mode?: string,
 *   cwd?: string,
 *   timeout?: number,
 *   blockedBy?: (string | {ticket: string, condition: 'completed' | 'ended' | 'self-report-success'})[],
 *   projectId?: string,
 *   handoff?: boolean,
 *   parallel?: boolean,
 *   type?: string,
 *   status?: string,
 *   labels?: string[],
 *   meta?: Record<string, unknown>,
 *   source: string,
 * }} Ticket */

/** Validate caller-supplied fields before defaults or coercion can hide a malformed ticket. */
export function validateTicketFields(value, source, promptRequired = true) {
  const fail = field => { throw new Error(`${source}: invalid ${field}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ticket object');
  if (promptRequired && (typeof value.prompt !== 'string' || !value.prompt.trim())) fail('prompt');
  for (const field of ['prompt','ticket','label','adapter','mode','cwd','projectId','type','status','request_key','resumeSessionId']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field].trim())) fail(field);
  }
  if (value.adapter !== undefined && !['zcode','codex','bash','shell'].includes(value.adapter)) fail('adapter');
  if (value.handoff === true && ['bash','shell'].includes(value.adapter)) fail('handoff: Bash accepts literal commands');
  if (value.projectId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.projectId)) fail('projectId');
  for (const field of ['handoff','parallel']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') fail(field);
  }
  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout <= 0)) fail('timeout');
  if (value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.some(label => typeof label !== 'string'))) fail('labels');
  try { normalizeBlockers(value.blockedBy); } catch (error) { throw new Error(`${source}: ${error.message}`); }
}

function ticketIdentity(ticket) { return ticket.ticket ?? ticket.source; }
function graphKey(projectId, identity) { return JSON.stringify([projectId ?? null, identity]); }

/** A preflight check only: does not schedule work or infer semantic success. */
export function validateTicketGraph(tickets, roster) {
  const nodes = new Map();
  const remote = new Set(roster.filter(task => typeof task.ticket === 'string').map(task => graphKey(task.projectId, task.ticket)));
  for (const ticket of tickets) {
    validateTicketFields(ticket, ticket.source);
    const identity = ticketIdentity(ticket);
    if (typeof identity !== 'string' || !identity.trim()) throw new Error('Ticket identity required');
    const key = graphKey(ticket.projectId, identity);
    if (nodes.has(key)) throw new Error(`Duplicate ticket identity ${identity} in project ${ticket.projectId ?? '(none)'}: ${nodes.get(key).source}, ${ticket.source}`);
    nodes.set(key, ticket);
  }
  const edges = new Map();
  for (const [key, ticket] of nodes) {
    const dependencies = normalizeBlockers(ticket.blockedBy).map(blocker => typeof blocker === 'string' ? blocker : blocker.ticket);
    const paths = [];
    for (const dependency of dependencies) {
      const target = graphKey(ticket.projectId, dependency);
      if (target === key) throw new Error(`Self dependency: ${ticketIdentity(ticket)} -> ${dependency} (${ticket.source})`);
      if (!nodes.has(target) && !remote.has(target)) throw new Error(`Unknown dependency ${dependency} for ${ticketIdentity(ticket)} in project ${ticket.projectId ?? '(none)'}`);
      if (nodes.has(target)) paths.push(target);
    }
    edges.set(key, paths);
  }
  // Iterative DFS keeps large directories from overflowing the JavaScript call stack.
  const visited = new Set();
  for (const root of nodes.keys()) {
    if (visited.has(root)) continue;
    const path = [root], active = new Map([[root,0]]), stack = [{ key:root, next:0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = edges.get(frame.key)[frame.next++];
      if (next === undefined) {
        visited.add(frame.key); active.delete(frame.key); stack.pop(); path.pop();
      } else if (active.has(next)) {
        const cycle = [...path.slice(active.get(next)), next].map(key => ticketIdentity(nodes.get(key)));
        throw new Error(`Dependency cycle in project ${nodes.get(root).projectId ?? '(none)'}: ${cycle.join(' -> ')}`);
      } else if (!visited.has(next)) {
        active.set(next,path.length); path.push(next); stack.push({key:next,next:0});
      }
    }
  }
}

/**
 * @param {string} filePath
 * @returns {Ticket | null}
 */
export function loadTicket(filePath) {
  const ext = extname(filePath).toLowerCase();
  const raw = readFileSync(filePath, 'utf8');
  const source = basename(filePath);

  if (ext === '.json') {
    const obj = JSON.parse(raw);
    validateTicketFields(obj, source);
    return {
      ticket: typeof obj.ticket === 'string' ? obj.ticket : undefined,
      label: typeof obj.label === 'string' ? obj.label : undefined,
      prompt: obj.prompt,
      adapter: typeof obj.adapter === 'string' ? obj.adapter : undefined,
      mode: typeof obj.mode === 'string' ? obj.mode : undefined,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      timeout: typeof obj.timeout === 'number' ? obj.timeout : undefined,
      blockedBy: normalizeBlockers(obj.blockedBy),
      projectId: typeof obj.projectId === 'string' ? obj.projectId : undefined,
      handoff: obj.handoff === true,
      parallel: obj.parallel !== false,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      status: typeof obj.status === 'string' ? obj.status : undefined,
      labels: Array.isArray(obj.labels) ? obj.labels.map(String) : undefined,
      meta: obj,
      source,
    };
  }

  if (ext === '.md') {
    const parsed = parseFrontMatter(raw);
    if (parsed === null) {
      const prompt = raw.trim();
      if (!prompt) return null;
      return {
        ticket: basename(filePath, ext),
        prompt,
        blockedBy: [],
        parallel: true,
        source,
      };
    }
    validateTicketFields(parsed.meta, source, false);
    const prompt = typeof parsed.meta.prompt === 'string' && parsed.meta.prompt.trim() !== ''
      ? String(parsed.meta.prompt)
      : parsed.body.trim();
    if (!prompt) {
      console.warn(`[skip] ${source}: empty prompt/body`);
      return null;
    }
    return {
      ticket: typeof parsed.meta.ticket === 'string' ? parsed.meta.ticket : basename(filePath, ext),
      label: typeof parsed.meta.label === 'string' ? parsed.meta.label : undefined,
      prompt,
      adapter: typeof parsed.meta.adapter === 'string' ? parsed.meta.adapter : undefined,
      mode: typeof parsed.meta.mode === 'string' ? parsed.meta.mode : undefined,
      cwd: typeof parsed.meta.cwd === 'string' ? parsed.meta.cwd : undefined,
      timeout: typeof parsed.meta.timeout === 'number' ? parsed.meta.timeout : undefined,
      blockedBy: normalizeBlockers(parsed.meta.blockedBy),
      projectId: typeof parsed.meta.projectId === 'string' ? parsed.meta.projectId : undefined,
      handoff: parsed.meta.handoff === true,
      parallel: parsed.meta.parallel !== false,
      type: typeof parsed.meta.type === 'string' ? parsed.meta.type : undefined,
      status: typeof parsed.meta.status === 'string' ? parsed.meta.status : undefined,
      labels: Array.isArray(parsed.meta.labels) ? parsed.meta.labels.map(String) : undefined,
      meta: parsed.meta,
      source,
    };
  }

  return null;
}

/** A string preserves the legacy mechanical COMPLETED gate. No content judgment. */
export function normalizeBlockers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('blockedBy must be an array');
  return value.map(blocker => {
    if (typeof blocker === 'string' && blocker.trim()) return blocker;
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)
      || typeof blocker.ticket !== 'string' || !blocker.ticket.trim()
      || !['completed', 'ended', 'self-report-success'].includes(blocker.condition)
      || Object.keys(blocker).some(key => !['ticket','condition'].includes(key))) {
      throw new Error('Invalid blockedBy condition; use a ticket string or {ticket, condition: completed|ended|self-report-success}');
    }
    return { ticket: blocker.ticket, condition: blocker.condition };
  });
}

export function isEligible(ticket, completed, dispatched, records = new Map()) {
  if (dispatched.has(ticketIdentity(ticket))) return { ok:false, reason:'already-dispatched' };
  const blockers=normalizeBlockers(ticket.blockedBy);
  const unmet=blockers.filter(blocker => {
    const id=typeof blocker === 'string' ? blocker : blocker.ticket;
    const condition=typeof blocker === 'string' ? 'completed' : blocker.condition;
    const task=records.get(id);
    if (condition === 'completed') return !completed.has(id);
    if (condition === 'ended') return !task || !['COMPLETED','FAILED','KILLED','TIMEOUT_KILLED'].includes(task.status);
    return !(task?.status === 'COMPLETED' && task.handoff?.state === 'reported' && task.handoff?.selfReport?.status === 'success');
  });
  return unmet.length ? {ok:false,reason:`blocked-by:${unmet.map(b=>typeof b === 'string'?b:b.ticket).join(',')}`} : {ok:true,reason:'eligible'};
}

/** Always consult the selected board, including archived tickets; never local runtime files. */
export async function readBoardTicketState(baseUrl) {
  const roster=await getBoardJson(baseUrl, '/api/tasks?includeArchived=1');
  if (!Array.isArray(roster) || roster.some(task => !task || typeof task.taskId !== 'string' || typeof task.status !== 'string')) throw new Error('Invalid board roster response');
  return { roster, ...ticketState(roster) };
}

function ticketState(roster) {
  const records=new Map();
  // Multiple attempts must never accidentally select an older successful run.
  for (const task of roster) {
    if (typeof task.ticket !== 'string') continue;
    const previous=records.get(task.ticket);
    if (!previous || (task.startTime ?? 0) > (previous.startTime ?? 0)) records.set(task.ticket, task);
  }
  return { records, completed:new Set([...records].filter(([,task])=>task.status==='COMPLETED').map(([id])=>id)), dispatched:new Set(records.keys()) };
}

async function getBoardJson(baseUrl, path) {
  const res=await fetch(`${baseUrl.replace(/\/$/,'')}${path}`);
  if (!res.ok) throw new Error(`Board ${path} HTTP ${res.status}: ${await res.text()}`);
  try { return await res.json(); } catch { throw new Error(`Board ${path} returned invalid JSON`); }
}

/** Same ticket identity always maps to the same request; changed content must conflict, not silently rerun. */
export function ticketRequestKey(ticketsDir, ticket) {
  return 'ticket-'+createHash('sha256').update(JSON.stringify([resolve(ticketsDir),ticket.projectId ?? null,ticketIdentity(ticket)])).digest('hex');
}

/** @param {Ticket} ticket */
export function toPayload(ticket) {
  /** @type {Record<string, unknown>} */
  const body = { prompt: ticket.prompt };
  body.ticket = ticketIdentity(ticket);
  if (ticket.projectId) body.projectId = ticket.projectId;
  if (ticket.handoff === true) body.handoff = true;
  if (ticket.label) body.label = ticket.label;
  if (ticket.adapter) body.adapter = ticket.adapter;
  if (ticket.mode) body.mode = ticket.mode;
  if (ticket.cwd) body.cwd = ticket.cwd;
  if (ticket.timeout !== undefined) body.timeout = ticket.timeout;
  return body;
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseArgs(argv, env = process.env) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    return { help: true, exitCode: argv.length === 0 ? 1 : 0 };
  }

  const ticketsDir = resolve(argv[0]);
  let dryRun = false;
  let baseUrl = 'http://127.0.0.1:3000';
  let passes = 1;
  /** @type {string | undefined} */
  let defaultCwd = env[DEFAULT_CWD_ENV] || undefined;
  /** @type {string | undefined} */
  let defaultAdapter = env[DEFAULT_ADAPTER_ENV] || undefined;

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--base-url') {
      baseUrl = argv[++i];
      if (!baseUrl) return { error: '--base-url requires a value' };
    } else if (a === '--passes') {
      passes = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isSafeInteger(passes) || passes < 1) {
        return { error: '--passes must be a positive integer' };
      }
    } else if (a === '--cwd') {
      defaultCwd = argv[++i];
      if (!defaultCwd) return { error: '--cwd requires a value' };
    } else if (a === '--adapter') {
      defaultAdapter = argv[++i];
      if (!defaultAdapter) return { error: '--adapter requires a value' };
    } else {
      return { error: `Unknown arg: ${a}` };
    }
  }

  return {
    ticketsDir,
    dryRun,
    baseUrl,
    passes,
    defaultCwd,
    defaultAdapter,
  };
}

export function usageText() {
  return `Usage: node scripts/dispatch-tickets.mjs <ticketsDir> [--dry-run] [--base-url URL] [--passes N] [--cwd PATH] [--adapter NAME]

Defaults (ticket frontmatter wins):
  --cwd PATH       or ${DEFAULT_CWD_ENV}
  --adapter NAME   or ${DEFAULT_ADAPTER_ENV}

Filter: only Type: task AND Status/ready containing "${READY_SIGNAL}"
  (body Type:/Status: lines, or frontmatter type / status / label / labels).`;
}

/**
 * @param {ReturnType<typeof parseArgs> & { ticketsDir: string }} opts
 */
export async function runDispatch(opts) {
  const {
    ticketsDir,
    dryRun = false,
    baseUrl = 'http://127.0.0.1:3000',
    passes = 1,
    defaultCwd,
    defaultAdapter,
  } = opts;

  if (!existsSync(ticketsDir)) {
    console.error(`Tickets dir not found: ${ticketsDir}`);
    return 1;
  }

  const defaults = { cwd: defaultCwd, adapter: defaultAdapter };

  const files = readdirSync(ticketsDir)
    .filter((n) => ['.md', '.json'].includes(extname(n).toLowerCase()))
    .map((n) => join(ticketsDir, n))
    .sort();

  /** @type {Ticket[]} */
  const tickets = [];
  try {
    for (const f of files) {
      const t = loadTicket(f);
      if (t) {
        applyDefaults(t, defaults);
        validateTicketFields(t, t.source);
        tickets.push(t);
      }
    }
  } catch (error) { console.error(`[fail] ticket validation: ${error.message}`); return 1; }

  if (tickets.length === 0) {
    console.error(`No ticket files found in ${ticketsDir}`);
    return 1;
  }

  console.log(
    `[dispatch-tickets] dir=${ticketsDir} tickets=${tickets.length} dryRun=${dryRun}`
    + ` baseUrl=${baseUrl} passes=${passes}`
    + ` defaultCwd=${defaultCwd ?? '(none)'} defaultAdapter=${defaultAdapter ?? '(none)'}`,
  );

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  async function postDispatch(payload) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  for (let pass = 1; pass <= passes; pass += 1) {
    let state;
    try { state=await readBoardTicketState(baseUrl); }
    catch (err) { console.error(`[fail] roster: ${err.message}`); return 1; }
    try { validateTicketGraph(tickets, state.roster); }
    catch (error) { console.error(`[fail] ticket graph: ${error.message}`); return 1; }
    const projectStates=new Map();
    function stateFor(ticket) {
      const project=ticket.projectId ?? null;
      if (!projectStates.has(project)) projectStates.set(project,ticketState(state.roster.filter(t=>(t.projectId ?? null) === project)));
      return projectStates.get(project);
    }
    // Fetch detail only for gates which need a self-report absent from the roster.
    try {
      for (const ticket of tickets) {
        const {records}=stateFor(ticket);
        for (const blocker of normalizeBlockers(ticket.blockedBy)) {
          if (typeof blocker === 'string' || blocker.condition !== 'self-report-success') continue;
          const task=records.get(blocker.ticket);
          if (task && task.status === 'COMPLETED' && task.handoff === undefined) {
            const detail=await getBoardJson(baseUrl, `/api/tasks/${encodeURIComponent(task.taskId)}`);
            if (detail?.taskId !== task.taskId) throw new Error('Invalid board task detail');
            records.set(blocker.ticket,{...task,handoff:detail.handoff ?? null});
          }
        }
      }
    } catch (err) { console.error(`[fail] dependency details: ${err.message}`); return 1; }


    /** @type {Ticket[]} */
    const eligible = [];
    for (const ticket of tickets) {
      const {completed,dispatched:localDispatched,records}=stateFor(ticket);
      const id = ticketIdentity(ticket);
      const ready = isReadyTask(ticket);
      if (!ready.ok) {
        skipped += 1;
        console.log(`[skip] ${ticket.source}${id ? ` (${id})` : ''}: ${ready.reason}`);
        continue;
      }
      if (id && localDispatched.has(id)) {
        skipped += 1;
        console.log(`[skip] ${ticket.source} (${id}): already-dispatched`);
        continue;
      }
      const gate = isEligible(ticket, completed, localDispatched, records);
      if (!gate.ok) {
        skipped += 1;
        console.log(`[skip] ${ticket.source}${id ? ` (${id})` : ''}: ${gate.reason}`);
        continue;
      }
      eligible.push(ticket);
    }

    const serial = eligible.filter((t) => t.parallel === false);
    const parallel = eligible.filter((t) => t.parallel !== false);
    /** @type {Ticket[]} */
    let batch;
    if (serial.length > 0 && pass === 1) {
      batch = [serial[0], ...parallel];
    } else if (serial.length > 0) {
      batch = [serial[0]];
    } else {
      batch = parallel;
    }

    if (batch.length === 0) {
      console.log(`[pass ${pass}] nothing eligible`);
      continue;
    }

    for (const ticket of batch) {
      const {dispatched:localDispatched,records}=stateFor(ticket);
      const payload = toPayload(ticket);
      payload.request_key=ticketRequestKey(ticketsDir,ticket);
      const dependencies=normalizeBlockers(ticket.blockedBy);
      if (dependencies.length) {
        console.log(`[gate] ${ticket.source}: mechanical completion is not content success; self-report-success is an agent claim, not verification`);
        if (!['bash','shell'].includes(ticket.adapter)) payload.dependsOn=dependencies.map(b=>records.get(typeof b === 'string'?b:b.ticket).taskId);
      }
      if (dryRun) {
        console.log(`[dry-run] would POST ${ticket.source}:`, JSON.stringify(payload));
        posted += 1;
        localDispatched.add(ticketIdentity(ticket));
        if (ticket.parallel === false) break;
        continue;
      }
      try {
        const { status, json } = await postDispatch(payload);
        if (status === 201 || status === 200) {
          console.log(`[ok] ${ticket.source} → taskId=${json.taskId} status=${json.status}`);
          posted += 1;
          localDispatched.add(ticketIdentity(ticket));
        } else {
          console.error(`[fail] ${ticket.source} HTTP ${status}:`, json);
          if (status === 409) console.error('Same ticket request_key has different content. Review the original task; use a new explicit ticket identity for a new attempt.');
          failed += 1;
        }
      } catch (err) {
        console.error(`[fail] ${ticket.source}:`, err instanceof Error ? err.message : err);
        failed += 1;
      }
      if (ticket.parallel === false) break;
    }
  }

  console.log(`[done] posted=${posted} skipped=${skipped} failed=${failed}`);
  return failed > 0 ? 1 : 0;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ('help' in parsed && parsed.help) {
    console.log(usageText());
    process.exit(parsed.exitCode ?? 0);
  }
  if ('error' in parsed && parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }
  const code = await runDispatch(/** @type {any} */ (parsed));
  process.exit(code);
}

const entry = process.argv[1] && resolve(process.argv[1]);
const isDirect = Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
if (isDirect) {
  main();
}
