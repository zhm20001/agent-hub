import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SWARM_RUNS_DIR,
  ensureRunsDir,
  spawnDetachedTask,
  readTaskMeta,
  readResolution,
  updateTaskMeta,
  killTaskProcess,
  generateReport,
  type TaskMeta,
} from './runner/detached.ts';
import { resolveDefaultTimeout } from './runner/timeout-policy.ts';
import type { DshContext, DshAgent } from './types/dsh.ts';

export function registerSwarmTools(ctx?: DshContext, activeAgentGetter?: () => DshAgent | undefined): void {
  if (!ctx || !ctx.tools) return;

  // swarm_dispatch
  ctx.tools.register({
    name: 'swarm_dispatch',
    description: 'Dispatch an autonomous background subagent task (ZCode CLI, Codex, or Bash) with detached filesystem logging (.swarm-runs/<taskId>/raw.log). Non-blocking and survives parent session reloads.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete instruction for the subagent task.',
      },
      ticket: {
        type: 'string',
        description: 'Optional issue/ticket identifier (e.g. "T1", "FEAT-102").',
      },
      description: {
        type: 'string',
        description: 'Short headline for task tracking.',
      },
      adapter: {
        type: 'string',
        description: 'Subagent execution backend: "zcode" (default), "codex", or "bash".',
      },
      mode: {
        type: 'string',
        description: 'Permission mode: "edit" (default), "build", "plan", or "yolo".',
      },
      timeout: {
        type: 'number',
        description: 'Maximum run seconds before watchdog termination (default 7200 or AGENT_HUB_DEFAULT_TIMEOUT).',
      },
    },
    async execute(args: any) {
      const activeAgent = activeAgentGetter ? activeAgentGetter() : undefined;
      const cwd = activeAgent?.session?.header?.cwd || process.cwd();

      const meta = spawnDetachedTask({
        prompt: args.prompt,
        ticket: args.ticket,
        label: args.description,
        adapter: args.adapter || 'zcode',
        mode: args.mode || 'edit',
        cwd,
        timeout: args.timeout || resolveDefaultTimeout(),
      });

      return {
        taskId: meta.taskId,
        ticket: meta.ticket,
        status: meta.status,
        pid: meta.pid,
        logPath: `.swarm-runs/${meta.taskId}/raw.log`,
        reportPath: `.swarm-runs/${meta.taskId}/report.md`,
      };
    },
  });

  // swarm_kill
  ctx.tools.register({
    name: 'swarm_kill',
    description: 'Terminate an active background swarm task by its taskId.',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: 'ID of the task to terminate.',
      },
    },
    async execute(args: { taskId: string }) {
      const meta = readTaskMeta(args.taskId);
      if (!meta) {
        return { error: `Task ${args.taskId} not found` };
      }
      if (meta.status !== 'RUNNING') {
        return { message: `Task ${args.taskId} is already ${meta.status}` };
      }

      if (meta.pid) {
        killTaskProcess(meta.pid);
      }

      const updated = updateTaskMeta(args.taskId, {
        status: 'KILLED',
        endTime: Date.now(),
      });

      if (updated) {
        generateReport(args.taskId, updated, 'Terminated via swarm_kill');
      }

      return { taskId: args.taskId, status: 'KILLED' };
    },
  });

  // swarm_status
  ctx.tools.register({
    name: 'swarm_status',
    description: 'Check metadata, closing record and log output of a specific swarm task.',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: 'ID of the task to query.',
      },
    },
    async execute(args: { taskId: string }) {
      const meta = readTaskMeta(args.taskId);
      if (!meta) return { error: `Task ${args.taskId} not found` };
      // The closing record is the platform's answer to "did this run end, why did
      // it stop, where are the handles" — it carries no verdict (ADR-0002).
      return { ...meta, closingRecord: readResolution(args.taskId) };
    },
  });

  // swarm_roster
  ctx.tools.register({
    name: 'swarm_roster',
    description: 'List all dispatched swarm subagent tasks with their status, tickets, and runtimes.',
    parameters: {},
    async execute() {
      ensureRunsDir();
      if (!existsSync(SWARM_RUNS_DIR)) return [];
      const entries = readdirSync(SWARM_RUNS_DIR, { withFileTypes: true });
      const tasks: TaskMeta[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = readTaskMeta(entry.name);
        if (meta) tasks.push(meta);
      }
      return tasks.sort((a, b) => b.startTime - a.startTime);
    },
  });
}
