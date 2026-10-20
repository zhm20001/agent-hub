#!/usr/bin/env node
/** Explicit command matrices, mechanical results and immutable report directories. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const skippedDirectories = new Set(['node_modules', '.git', '.jj', '.swarm-runs', '.scratch']);
function fileHash(path) {
  if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw Error(`Matrix source must be a file of at most 1 MiB: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function inventory(root, exclusions = []) {
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (entry.isDirectory() && !skippedDirectories.has(entry.name) && !exclusions.some(exclusion => relativePath === exclusion || relativePath.startsWith(exclusion + '/'))) walk(path);
      if (!entry.isFile()) continue;
      const name = relative(root, path).split(sep).join('/');
      if (['package.json', 'Cargo.toml'].includes(entry.name) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) entries.push({ path: name, sha256: fileHash(path) });
    }
  }
  walk(root); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
function sourcePath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || !path) throw Error('Matrix source path must be relative');
  const actual = realpathSync(resolve(root, path));
  if (actual !== root && !actual.startsWith(root + sep)) throw Error(`Matrix source escapes root: ${path}`);
  return actual;
}
function sourceIssues(root, manifest) {
  const issues = [];
  if (manifest.inventory !== undefined) {
    let found;
    try { found = inventory(root, manifest.inventoryExcludes ?? []); } catch (error) { issues.push(`Inventory unavailable: ${error.message}`); found = []; }
    const actual = new Map(found.map(source => [source.path, source.sha256]));
    const expected = new Map(manifest.inventory.map(source => [source.path, source.sha256]));
    for (const path of new Set([...actual.keys(), ...expected.keys()])) if (actual.get(path) !== expected.get(path)) issues.push(`Inventory changed: ${path}`);
  }
  for (const source of manifest.sources ?? []) {
    try { if (fileHash(sourcePath(root, source.path)) !== source.sha256) issues.push(`Source changed: ${source.path}`); }
    catch (error) { issues.push(`Source unavailable: ${source.path}: ${error.message}`); }
  }
  return issues;
}
function validateExclusions(exclusions) {
  if (!Array.isArray(exclusions) || exclusions.some(path => typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(segment => !segment || segment === '.' || segment === '..'))) throw Error('inventoryExcludes must contain relative directory paths');
}
function validate(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.checks) || !manifest.checks.length || manifest.checks.length > 100) throw Error('Manifest v1 requires 1–100 checks');
  for (const field of ['sources', 'inventory']) if (manifest[field] !== undefined && (!Array.isArray(manifest[field]) || manifest[field].some(source => !source || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)))) throw Error(`Invalid ${field}`);
  if (manifest.root !== undefined && (typeof manifest.root !== 'string' || manifest.root.includes('\0'))) throw Error('Invalid manifest root');
  validateExclusions(manifest.inventoryExcludes ?? []);
  const names = new Set();
  for (const check of manifest.checks) {
    if (!check || typeof check.name !== 'string' || !check.name.trim() || names.has(check.name)) throw Error('Checks require distinct nonempty names');
    names.add(check.name);
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !check.argv[0]) throw Error('Check argv must be a nonempty string array');
    if (check.required !== undefined && typeof check.required !== 'boolean') throw Error('Check required must be boolean');
    if (check.platforms !== undefined && (!Array.isArray(check.platforms) || check.platforms.some(value => typeof value !== 'string'))) throw Error('Invalid check platforms');
    if (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 3600000)) throw Error('Check timeoutMs must be 1–3600000');
    if (check.cwd !== undefined && (typeof check.cwd !== 'string' || check.cwd.includes('\0'))) throw Error('Invalid check cwd');
  }
}
function runCommand(check, root, logPath) {
  const fd = openSync(logPath, 'wx', 0o600);
  return new Promise(resolveResult => {
    let error, interrupted, timedOut = false;
    const child = spawn(check.argv[0], check.argv.slice(1), { cwd: resolve(root, check.cwd ?? '.'), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    const stop = () => {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const interrupt = signal => { interrupted = signal; stop(); };
    const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    const timer = setTimeout(() => { timedOut = true; stop(); }, check.timeoutMs ?? 900000);
    child.on('error', failure => { error = failure.message; });
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timer);
      const groupAlive = () => {
        if (process.platform === 'win32' || !child.pid) return false;
        try { process.kill(-child.pid, 0); return true; } catch (failure) { return failure.code === 'EPERM'; }
      };
      const lingeringChildren = groupAlive();
      if (lingeringChildren) {
        stop();
        const deadline = Date.now() + 500;
        while (groupAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      }
      closeSync(fd);
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      resolveResult({ status: exitCode === 0 && !signal && !error && !timedOut && !interrupted && !lingeringChildren ? 'passed' : 'failed', exitCode, signal, timedOut, lingeringChildren, ...(interrupted ? { interrupted } : {}), ...(error ? { error } : {}) });
    });
  });
}
async function main() {
  const [manifestPath, outputPath, ...exclusions] = process.argv.slice(2);
  if (manifestPath === '--inventory' && outputPath) { validateExclusions(exclusions); console.log(JSON.stringify(inventory(realpathSync(outputPath), exclusions), null, 2)); return; }
  if (!manifestPath || !outputPath || exclusions.length) throw Error('Usage: verify.mjs <manifest.json> <new-report-directory> | --inventory <root>');
  const bytes = readFileSync(manifestPath), manifest = JSON.parse(bytes); validate(manifest);
  const root = realpathSync(resolve(dirname(resolve(manifestPath)), manifest.root ?? '.'));
  const issues = sourceIssues(root, manifest);
  const output = resolve(outputPath); mkdirSync(output, { mode: 0o700 });
  const report = { version: 1, manifestPath: resolve(manifestPath), manifestSha256: createHash('sha256').update(bytes).digest('hex'), root, platform: process.platform,
    startedAt: new Date().toISOString(), sources: { status: issues.length ? 'changed' : 'matched', inventoryExcludes: manifest.inventoryExcludes ?? [], issues }, checks: [], requiredChecksPassed: false };
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  let interrupted = false;
  for (const [index, check] of manifest.checks.entries()) {
    const entry = { name: check.name, argv: check.argv, cwd: resolve(root, check.cwd ?? '.'), required: check.required ?? true };
    if (interrupted) Object.assign(entry, { status: 'not-run', reason: 'Verification interrupted' });
    else if (issues.length) Object.assign(entry, { status: 'not-run', reason: 'Matrix sources changed; review the manifest' });
    else if (check.platforms && !check.platforms.includes(process.platform)) Object.assign(entry, { status: 'not-run', reason: `Unavailable on platform ${process.platform}` });
    else {
      const log = `${index + 1}.log`;
      Object.assign(entry, { log, startedAt: new Date().toISOString() }, await runCommand(check, root, join(output, log)), { completedAt: new Date().toISOString() });
    }
    if (entry.interrupted) interrupted = true;
    report.checks.push(entry); save(); console.log(`${entry.status}: ${entry.name}`);
  }
  const finalIssues = sourceIssues(root, manifest);
  try { if (createHash('sha256').update(readFileSync(manifestPath)).digest('hex') !== report.manifestSha256) finalIssues.push('Verification manifest changed during execution'); }
  catch { finalIssues.push('Verification manifest became unavailable'); }
  report.sources.issues = [...new Set([...issues, ...finalIssues])];
  report.sources.status = report.sources.issues.length ? 'changed' : 'matched';
  report.completedAt = new Date().toISOString();
  report.requiredChecksPassed = !interrupted && !report.sources.issues.length && report.checks.every(check => !check.required || check.status === 'passed');
  save(); process.exitCode = interrupted ? 130 : report.requiredChecksPassed ? 0 : 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
