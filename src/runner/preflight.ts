import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { WorkerAdapter, AdapterCommandResult, AdapterCommandSpec } from '../adapters/base.ts';
import { PreconditionUnmetError } from '../adapters/preconditions.ts';

export interface LaunchCheck { name: string; ok: boolean; reason?: string }
export function inspectCommand(command: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\') ? [isAbsolute(command) ? command : join(cwd, command)]
    : (env.PATH ?? '').split(delimiter).flatMap(dir => process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')].map(ext => join(dir || cwd, command + ext)) : [join(dir || cwd, command)]);
  return candidates.some(path => { try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; } });
}
/** Inspect filesystem and adapter declarations without starting the command. */
export function inspectLaunch(adapter: WorkerAdapter, spec: AdapterCommandSpec, env: NodeJS.ProcessEnv): { checks: LaunchCheck[]; command?: AdapterCommandResult } {
  const checks: LaunchCheck[] = [];
  try {
    if (!statSync(spec.cwd).isDirectory()) throw Error('not a directory');
    accessSync(spec.cwd, constants.R_OK | constants.X_OK);
    checks.push({ name: 'cwd-access', ok: true });
  } catch { checks.push({ name: 'cwd-access', ok: false, reason: `Working directory is not an accessible directory: ${spec.cwd}` }); }
  try { adapter.checkPreconditions?.(); checks.push({ name: 'adapter-preconditions', ok: true }); }
  catch (error) {
    if (!(error instanceof PreconditionUnmetError)) throw error;
    checks.push({ name: error.precondition, ok: false, reason: error.message });
  }
  if (checks.some(check => !check.ok)) return { checks };
  const command = adapter.buildCommand(spec);
  const effectiveEnv = { ...env, ...Object.fromEntries(Object.entries(command.env ?? {}).filter(([key, value]) => value !== process.env[key])) };
  checks.push({ name: 'command', ok: inspectCommand(command.cmd, effectiveEnv, spec.cwd), reason: `Command is not an executable file on the launch PATH: ${command.cmd}` });
  return { checks, command };
}
