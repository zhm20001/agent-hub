/**
 * Agent Hub plugin entry point.
 * Integrates Cordis microkernel plugin with detached task execution and DispatchDock Web UI.
 * @module agent-hub
 */

import type { DshContext, DshAgent } from './types/dsh.ts';
import { createHub, type Hub } from './hub.ts';
export { createHub } from './hub.ts';
export type { Hub, HubOptions } from './hub.ts';
export { startServer } from './server.ts';
export { registerSwarmTools } from './tools.ts';
import { registerSwarmTools } from './tools.ts';
import { startServer, type RunningServer, type ServerOptions } from './server.ts';

export const name = 'subagent-swarm';
export const inject = ['tools'];

let activeRun: Promise<RunningServer> | null = null;
let cleanup: Promise<void> = Promise.resolve();


/**
 * DSH Plugin apply hook.
 */
export function apply(ctx: DshContext, config: ServerOptions & { port?: number; activeAgentGetter?: () => DshAgent | undefined } = {}): void {
  if (activeRun) return;
  const hub: Hub = config.hub ?? createHub();
  registerSwarmTools(ctx, config.activeAgentGetter, hub);
  const onCompletion: ServerOptions['onCompletion'] = config.onCompletion ?? (config.activeAgentGetter ? async (meta, report) => {
    const target = config.activeAgentGetter?.();
    if (!target?.inject) throw new Error('No active agent accepts completion notices; delivery remains pending');
    await target.inject({ type: 'text',
      text: `[Swarm Notice] Task ${meta.taskId} (${meta.ticket || 'NO-TICKET'}) ended as ${meta.status}.\n\n${report}` });
  } : undefined);
  const starting = cleanup.then(async () => {
    try {
      const run = await startServer(config.port ?? 3000, { ...config, hub, onCompletion });
      return { address: run.address, async close() { try { await run.close(); } finally { if (!config.hub) hub.close(); } } };
    } catch (error) { if (!config.hub) hub.close(); throw error; }
  });
  activeRun = starting;
  void starting.catch((err) => {
    if (activeRun === starting) activeRun = null;
    ctx.logger?.error?.('[Swarm] Failed to start web server:', err);
  });
}

/** Await startup, then release its resources; a reload waits for this cleanup. */
export function dispose(): Promise<void> {
  const starting = activeRun;
  activeRun = null;
  if (starting) {
    const closing = starting.then(run => run.close(), () => {});
    // Keep reload possible even if cleanup failed; return the failure to the host.
    cleanup = closing.catch(() => {});
    return closing;
  }
  return cleanup;
}

export default { name, apply, dispose };
