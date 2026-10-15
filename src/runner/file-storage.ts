/** Atomic publication and short cross-process locks for local task files. */
import { openSync, closeSync, writeFileSync, renameSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function atomicWrite(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
export function readJson<T>(path: string): T | null {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
}
const held = new Set<string>();
const pause = new Int32Array(new SharedArrayBuffer(4));
export function withFileLock<T>(path: string, action: () => T): T {
  // Reentrant only inside a synchronous call stack in this process.
  if (held.has(path)) return action();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const before = statSync(path);
        const owner = readJson<{ pid?: number }>(path);
        let dead = false;
        if (owner?.pid) { try { process.kill(owner.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
        // Empty lock: the owner may be writing its PID. Allow a grace period.
        if ((dead || (!owner?.pid && Date.now() - before.mtimeMs > 5000)) && statSync(path).ino === before.ino) {
          unlinkSync(path); continue;
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error(`Task storage lock busy: ${path}`);
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  held.add(path);
  try { return action(); }
  finally { held.delete(path); unlinkSync(path); }
}
