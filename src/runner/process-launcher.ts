/** A detached supervisor records its PID before starting the Agent. No Hub imports
 * or open control channel: it survives dispatcher shutdown and owns the group.
 * Arguments are passed as argv, never interpolated into shell source.
 */
import { readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export const PROCESS_LAUNCHER = `
const {spawn} = require('node:child_process');
const {writeFileSync, renameSync, linkSync, unlinkSync} = require('node:fs');
const {join} = require('node:path');
const [dir, command, ...args] = process.argv.slice(1);
function publish(name, value) {
  const target = join(dir,name), temporary = target+'.'+process.pid+'.tmp';
  writeFileSync(temporary,value); renameSync(temporary,target);
}
try {
  const identity = join(dir,'process.pid'), candidate = identity+'.'+process.pid+'.tmp';
  writeFileSync(candidate,String(process.pid));
  let claimed = false;
  try { linkSync(candidate,identity); claimed = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { unlinkSync(candidate); }
  // Recovery may have claimed a not-yet-started launch as abandoned.
  if (!claimed) process.exit(0);
  const child = spawn(command,args,{stdio:'inherit'});
  let error;
  child.once('error',e=>{error=e.message;});
  child.once('close',(exitCode,signal)=>{
    try { publish('process-exit.json',JSON.stringify({exitCode,signal,error})); } catch {}
    if (signal) process.kill(process.pid,signal);
    else process.exitCode = exitCode >= 0 && exitCode <= 255 ? exitCode : 1;
  });
} catch (error) {
  try { publish('process-exit.json',JSON.stringify({exitCode:1,signal:null,error:error.message})); } catch {}
  process.exitCode=1;
}
`;
export function recordedProcessPid(taskDir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(taskDir, 'process.pid'), 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}
export function recordedProcessExit(taskDir: string): { exitCode: number | null; signal: string | null; error?: string } | null {
  try { return JSON.parse(readFileSync(join(taskDir, 'process-exit.json'), 'utf8')); } catch { return null; }
}

/** Compete atomically with the supervisor's PID claim. Zero means abandoned.
 * If the supervisor wins, recovery reads its PID instead of declaring it dead.
 */
export function abandonUnclaimedLaunch(taskDir: string): void {
  const target = join(taskDir, 'process.pid');
  const candidate = `${target}.abandon-${process.pid}.tmp`;
  try {
    writeFileSync(candidate, '0');
    try { linkSync(candidate, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { try { unlinkSync(candidate); } catch {} }
}
