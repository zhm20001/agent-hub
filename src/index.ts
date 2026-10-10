/**
 * Agent Hub plugin entry point.
 * Integrates Cordis microkernel plugin with detached task execution and DispatchDock Web UI.
 * @module agent-hub
 */

import type { DshContext, DshAgent } from './types/dsh.ts';
import { registerSwarmTools } from './tools.ts';
import { defaultWatcher } from './watcher.ts';
import { startServer } from './server.ts';

export const name = 'subagent-swarm';
export const inject = ['tools'];

let activeServer: any = null;
let currentAgent: DshAgent | undefined = undefined;

/**
 * DSH Plugin apply hook.
 */
export function apply(ctx: DshContext, _config?: any): void {
  // Register tools on ctx.tools
  registerSwarmTools(ctx, () => currentAgent);

  // When a task finishes in .swarm-runs/, notify active DSH agent if present
  defaultWatcher.subscribe((meta, report) => {
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
  });

  // Start HTTP / SSE Web workspace
  startServer(3000).then((server) => {
    activeServer = server;
  }).catch((err) => {
    ctx.logger?.error?.('[Swarm] Failed to start web server:', err);
  });
}

/**
 * Dispose hook for DSH microkernel reloads.
 */
export function dispose(): void {
  if (activeServer) {
    try {
      activeServer.close();
    } catch {}
    activeServer = null;
  }
  defaultWatcher.stop();
}

export default { name, apply, dispose };
