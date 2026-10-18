import { defaultHub, type Hub } from './hub.ts';
import { join } from 'node:path';
import type { DshContext, DshAgent } from './types/dsh.ts';

export function registerSwarmTools(ctx?: DshContext, activeAgentGetter?: () => DshAgent | undefined, hub: Hub = defaultHub): void {
  const {getTaskDetail, listTasks} = hub.queries;
  const {spawnDetachedTask, readTaskMeta, terminateTask} = hub.engine;
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
      request_key: { type: 'string', description: 'Stable request identity. Retry with identical input to get the original task; changed input conflicts.' },
      projectId: { type: 'string', description: 'Project notebook ID.' },
      parentTaskId: { type: 'string', description: 'Related parent task in the same project.' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ended upstream task IDs whose attributed handoffs become bounded context (text agents only).' },
      handoff: { type: 'boolean', description: 'Request a structured agent self-report, not a platform success verdict.' },
      cwd: { type: 'string', description: 'Working directory; defaults to project directory, active agent directory, then Hub directory.' },
      resumeSessionId: { type: 'string', description: 'CLI session handle to resume after its previous process has ended.' },
      timeout: {
        type: 'number',
        description: 'Maximum run seconds before watchdog termination (default 7200 or AGENT_HUB_DEFAULT_TIMEOUT).',
      },
    },
    async execute(args: any) {
      const activeAgent = activeAgentGetter ? activeAgentGetter() : undefined;
      const cwd = args.cwd ?? (args.projectId ? undefined : activeAgent?.session?.header?.cwd);

      const meta = spawnDetachedTask({
        prompt: args.prompt,
        ticket: args.ticket,
        label: args.description,
        adapter: args.adapter,
        mode: args.mode,
        cwd,
        timeout: args.timeout,
        request_key: args.request_key, projectId: args.projectId, parentTaskId: args.parentTaskId,
        dependsOn: args.dependsOn, handoff: args.handoff, resumeSessionId: args.resumeSessionId,
      });

      return {
        taskId: meta.taskId,
        ticket: meta.ticket,
        status: meta.status,
        pid: meta.pid,
        logPath: join(hub.store.dir(meta.taskId), 'raw.log'),
        reportPath: join(hub.store.dir(meta.taskId), 'report.md'),
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

      terminateTask(args.taskId, 'cancelled');

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
      return getTaskDetail(args.taskId) ?? { error: `Task ${args.taskId} not found` };
    },
  });

  // swarm_roster
  ctx.tools.register({
    name: 'swarm_roster',
    description: 'List all dispatched swarm subagent tasks with their status, tickets, and runtimes.',
    parameters: {},
    async execute() {
      return listTasks({ includeArchived: true });
    },
  });

  ctx.tools.register({
    name: 'swarm_projects', description: 'List project goals, latest continuation notes and task counts.', parameters: {},
    async execute() { return hub.projects.list(); },
  });
  ctx.tools.register({
    name: 'swarm_project_set', description: 'Explicitly register or update a project goal and working directory. Continuation notes use swarm_project_note.',
    parameters: { id: {type:'string',required:true}, name: {type:'string',required:true}, goal: {type:'string',required:true}, cwd: {type:'string'} },
    async execute(args: any) { return hub.projects.upsert(args); },
  });
  ctx.tools.register({
    name: 'swarm_project_context', description: 'Read project goal, continuation notes, related task facts and changes since the saved cursor. Reading does not mark anything seen.',
    parameters: { projectId: {type:'string',required:true}, viewerId: {type:'string'}, after: {type:'number'}, limit: {type:'number'} },
    async execute(args: any) { return hub.projects.context(args.projectId, {viewerId:args.viewerId, after:args.after, limit:args.limit}); },
  });
  ctx.tools.register({
    name: 'swarm_project_note', description: 'Append a sourced continuation note; never overwrites the project goal or previous notes. Suggested structure: what changed, unresolved issues, next step.',
    parameters: { projectId: {type:'string',required:true}, body: {type:'string',required:true}, author: {type:'string',required:true}, sourceTaskIds: {type:'array',items:{type:'string'}}, request_key: {type:'string'} },
    async execute(args: any) { return hub.projects.appendNote(args.projectId, args); },
  });
  ctx.tools.register({
    name: 'swarm_project_seen', description: 'Explicitly acknowledge project changes through the cursor returned by swarm_project_context.',
    parameters: {projectId:{type:'string',required:true},viewerId:{type:'string'},through:{type:'number',required:true}},
    async execute(args: any) { return hub.projects.markSeen(args.projectId, args); },
  });

}
