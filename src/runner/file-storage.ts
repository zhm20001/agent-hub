/** Atomic publication and short cross-process locks for local task files. */
import { writeFileSync, renameSync, unlinkSync, readFileSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
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

/** Lamport's bakery ordering: each contender owns a unique PID/UUID ticket.
 * Reaping a dead contender can never delete a new holder's ticket. Empty tickets
 * mean "choosing a number"; they must be waited on while their owner is alive.
 * This is a local-filesystem, synchronous lock, not a distributed lease.
 */
export function withFileLock<T>(path: string, action: () => T): T {
  if (held.has(path)) return action();
  const id = `${process.pid}-${randomUUID()}.json`;
  const own = `${path}/${id}`;
  const deadline = Date.now() + 5000;
  // A final releaser may remove the now-empty directory between mkdir and write.
  while (true) {
    mkdirSync(path, { recursive: true });
    try { writeFileSync(own, '', { flag: 'wx' }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  function entries() {
    return readdirSync(path).flatMap(name => {
      const match = /^(\d+)-[a-f0-9-]+\.json$/.exec(name);
      if (!match) return [];
      try { process.kill(Number(match[1]), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          try { unlinkSync(`${path}/${name}`); } catch {}
          return [];
        }
      }
      return [{ name, number: readJson<{ number: number }>(`${path}/${name}`)?.number ?? 0 }];
    });
  }
  try {
    const number = 1 + Math.max(0, ...entries().map(entry => entry.number));
    atomicWrite(own, JSON.stringify({ number }));
    while (entries().some(entry => entry.name !== id &&
      (entry.number === 0 || entry.number < number || (entry.number === number && entry.name < id)))) {
      if (Date.now() >= deadline) throw new Error(`Task storage lock busy: ${path}`);
      Atomics.wait(pause, 0, 0, 5);
    }
    held.add(path);
    try { return action(); } finally { held.delete(path); }
  } finally {
    try { unlinkSync(own); } finally { try { rmdirSync(path); } catch {} }
  }
}
