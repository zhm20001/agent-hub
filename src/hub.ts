import { resolve } from 'node:path';
import { TaskStore, defaultTaskStore } from './runner/task-store.ts';
import { createTaskEngine, type TaskEngineOptions } from './runner/detached.ts';
import { createTaskQueries } from './runner/task-queries.ts';
import { ProjectStore, ProjectError } from './projects.ts';
import { prepareTaskPrompt, readTaskHandoff, writeTaskHandoff } from './runner/handoff.ts';

export interface HubOptions {
  runsDir?: string;
  store?: TaskStore;
  getAdapter?: TaskEngineOptions['getAdapter'];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** The assembly point: transports share one task engine, project notebook and query view. */
export function createHub(options: HubOptions = {}) {
  const store = options.store ?? (options.runsDir ? new TaskStore(resolve(options.runsDir)) : defaultTaskStore);
  const projects = new ProjectStore(store);
  const engine = createTaskEngine({
    store, getAdapter: options.getAdapter, env: options.env, now: options.now,
    prepareDispatch(input, original) {
      let projectContextText: string | undefined;
      let cwd = input.cwd;
      if (input.projectId) {
        const context = projects.context(input.projectId);
        // The caller explicitly supplies cwd to override the project's working directory.
        cwd = original.cwd ?? context.project.cwd ?? input.cwd;
        if (!['bash','shell'].includes(input.adapter ?? 'zcode')) {
          projectContextText = JSON.stringify({ project: context.project, latestNote: context.latestNote });
        }
      }
      if (input.parentTaskId) {
        const parent = store.read(input.parentTaskId);
        if (!parent) throw new ProjectError(`Parent task not found: ${input.parentTaskId}`);
        if (parent.projectId !== input.projectId) throw new ProjectError('Parent task belongs to a different project');
      }
      try {
        return { ...input, cwd, originalPrompt: input.prompt, prompt: prepareTaskPrompt(input, {
          projectContextText,
          getTask(id) {
            const meta = store.read(id);
            return meta ? { meta, closingRecord: engine.readResolution(id), handoff: readTaskHandoff(store.dir(id)) } : null;
          },
        }) };
      } catch (error) {
        if (error instanceof ProjectError) throw error;
        throw new ProjectError(error instanceof Error ? error.message : String(error));
      }
    },
    onSettled(taskId) {
      const meta = store.read(taskId);
      if (!meta) return;
      const record = engine.readResolution(taskId);
      writeTaskHandoff(store.dir(taskId), { taskId, status: meta.status,
        finalText: record?.resolution.finalText ?? { kind: 'empty' },
        now: () => new Date(options.now?.() ?? Date.now()),
      });
    },
  });
  const baseQueries = createTaskQueries(engine);
  const queries = {
    ...baseQueries,
    getTaskDetail(id: string) {
      const detail = baseQueries.getTaskDetail(id);
      if (!detail) return null;
      return { ...detail, handoff: readTaskHandoff(store.dir(id)) };
    },
  };
  return { store, engine, queries, projects, close: () => store.close() };
}
export type Hub = ReturnType<typeof createHub>;
export const defaultHub = createHub();
