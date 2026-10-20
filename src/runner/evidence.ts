import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export interface ArtifactReference { path: string; sha256: string; bytes: number; retainedPath?: string }
const MAX_BYTES = 8 * 1024 * 1024;
function under(path: string, root: string) { return path === root || path.startsWith(root + sep); }
function readBounded(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('Evidence must be a regular file of at most 8 MiB');
    const bytes = Buffer.alloc(Math.min(MAX_BYTES, stat.size) + 1); let total = 0, count: number;
    while (total < bytes.length && (count = readSync(fd, bytes, total, bytes.length - total, null)) > 0) total += count;
    if (total > stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) throw Error('Evidence changed while reading');
    return bytes.subarray(0, total);
  } finally { closeSync(fd); }
}
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
/** Only explicitly named local files are retained; no transcript discovery or repository cleanup. */
export function captureArtifact(input: { path: string; retain?: boolean }, roots: string[], destination: string): ArtifactReference {
  if (!input || typeof input.path !== 'string' || !isAbsolute(input.path) || (input.retain !== undefined && typeof input.retain !== 'boolean')) throw Error('Artifact requires an absolute path and optional boolean retain');
  const path = realpathSync(input.path);
  if (!roots.some(root => under(path, realpathSync(root)))) throw Error(`Artifact is outside project and runs directories: ${path}`);
  const bytes = readBounded(path), sha256 = digest(bytes);
  const result: ArtifactReference = { path, sha256, bytes: bytes.length };
  if (input.retain) {
    mkdirSync(destination, { recursive: true });
    const canonicalDestination = realpathSync(destination);
    if (!under(canonicalDestination, realpathSync(roots[1]))) throw Error('Evidence destination is outside runs directory');
    const retainedPath = join(canonicalDestination, sha256);
    // A preexisting content-addressed file must still contain the recorded bytes.
    if (existsSync(retainedPath)) {
      if (digest(readBounded(retainedPath)) !== sha256) throw Error('Retained evidence hash mismatch');
    } else writeFileSync(retainedPath, bytes, { flag: 'wx', mode: 0o600 });
    result.retainedPath = retainedPath;
  }
  return result;
}
const hashes = new Map<string, { version: string; sha256: string }>();
export function artifactState(path: string | undefined, sha256: string): 'available' | 'missing' | 'changed' | 'not-retained' {
  if (!path) return 'not-retained';
  try {
    const stat = statSync(path);
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = hashes.get(path);
    const actual = cached?.version === version ? cached.sha256 : digest(readBounded(resolve(path)));
    hashes.delete(path); hashes.set(path, { version, sha256: actual });
    while (hashes.size > 64) hashes.delete(hashes.keys().next().value!);
    return actual === sha256 ? 'available' : 'changed';
  } catch { hashes.delete(path); return 'missing'; }
}
