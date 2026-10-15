/**
 * Agent Hub plugin entry point.
 * Integrates Cordis microkernel plugin with detached task execution and DispatchDock Web UI.
 * @module agent-hub
 */

import type { DshContext, DshAgent } from './types/dsh.ts';
import { registerSwarmTools } from './tools.ts';
import { startServer, type RunningServer, type ServerOptions } from './server.ts';

export const name = 'subagent-swarm';
export const inject = ['tools'];

let activeRun: Promise<RunningServer> | null = null;
let cleanup: Promise<void> = Promise.resolve();
let currentAgent: DshAgent | undefined = undefined;

/**
 * DSH Plugin apply hook.
 */
export function apply(ctx: DshContext, config: ServerOptions & { port?: number } = {}): void {
  if (activeRun) return;
  // Register tools on ctx.tools
  registerSwarmTools(ctx, () => currentAgent);

  // When a task finishes in .swarm-runs/, notify active DSH agent if present
  const onCompletion: NonNullable<ServerOptions['onCompletion']> = (meta, report) => {
    if (currentAgent && currentAgent.inject) {
      try {
        currentAgent.inject({
          type: 'text',
          text: `[Swarm Notice] Task ${meta.taskId} (${meta.ticket || 'NO-TICKET'}) finished with status: ${meta.status}.\n\n${report}`,
        });
      } catch (err) {
        ctx.logger?.warn?.('[Swarm] Failed to inject completion notice to agent:', err);
      }
    }
  };

  // Start HTTP / SSE Web workspace
  const starting = cleanup.then(() => startServer(config.port ?? 3000, { ...config, onCompletion }));
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
