import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { TaskStore } from './task-store.ts';
import { recordedProcessPid } from './process-launcher.ts';
import { isProcessAlive } from './timeout-policy.ts';

export type WorkspaceAccess = 'read' | 'write';
export class WorkspaceBusyError extends Error {
  readonly name = 'WorkspaceBusyError';
  readonly statusCode = 409;
  constructor(readonly workspace: string, readonly taskIds: string[]) {
    super(`Workspace is occupied by ${taskIds.join(', ')}: ${workspace}. Wait for process exit and recover ended tasks before retrying.`);
  }
}
/** Repository children and symlink aliases share admission; separate worktrees do not. */
export function workspaceIdentity(cwd: string): string {
  const canonical = realpathSync(cwd);
  let current = canonical;
  for (;;) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, '.jj'))) return current;
    const parent = dirname(current);
    if (parent === current) return canonical;
    current = parent;
  }
}
function processGroupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  if (process.platform === 'win32') return isProcessAlive(pid);
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' || isProcessAlive(pid); }
}
/** Called under the existing dispatch lock. RUNNING records conservatively reserve admission. */
export function assertWorkspaceAvailable(store: TaskStore, cwd: string, access: WorkspaceAccess): string {
  const workspace = workspaceIdentity(cwd);
  const conflicts = store.list().filter(task => {
    const recorded = recordedProcessPid(store.dir(task.taskId));
    // Completed fixtures may carry arbitrary PIDs; only actual supervisor evidence owns a group.
    const pid = ['KILLED', 'TIMEOUT_KILLED'].includes(task.status) ? task.pid ?? recorded : recorded ?? (task.workspace ? task.pid : undefined);
    if (task.status !== 'RUNNING' && !processGroupAlive(pid)) return false;
    if (access === 'read' && task.workspaceAccess === 'read') return false;
    let other: string;
    try { other = task.workspace ?? workspaceIdentity(task.cwd); }
    catch { other = resolve(task.cwd); }
    const repository = (path: string) => existsSync(join(path, '.git')) || existsSync(join(path, '.jj'));
    if (repository(workspace) && repository(other)) return workspace === other;
    return workspace === other || workspace.startsWith(other + sep) || other.startsWith(workspace + sep);
  });
  if (conflicts.length) throw new WorkspaceBusyError(workspace, conflicts.map(task => task.taskId));
  return workspace;
}
