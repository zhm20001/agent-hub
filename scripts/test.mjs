#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDirectory = join(repository, 'tests');
const loader = import.meta.resolve('tsx');
const specifications = readdirSync(testsDirectory).filter(name => name.endsWith('.spec.ts')).sort();
const failures = [];
let interrupted = false;
let activeChild;
function interrupt(signal) {
  interrupted = true;
  activeChild?.kill(signal);
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

// Each file owns its process-start cwd, default store, SQLite connection and artifacts.
for (const specification of specifications) {
  if (interrupted) break;
  const cwd = mkdtempSync(join(tmpdir(), 'agent-hub-spec-'));
  process.stdout.write(`\nRunning ${specification}\n`);
  try {
    const result = await new Promise(resolve => {
      activeChild = spawn(process.execPath, ['--import', loader, '--test', join(testsDirectory, specification)], {
        cwd, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit',
      });
      activeChild.once('error', error => resolve({ code: 1, error }));
      activeChild.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    if (result.code !== 0) failures.push(specification);
  } finally {
    activeChild = undefined;
    rmSync(cwd, { recursive: true, force: true });
  }
}
process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
if (failures.length) process.stderr.write(`\nFailed test files: ${failures.join(', ')}\n`);
else if (!interrupted) process.stdout.write(`\nAll ${specifications.length} isolated test files passed.\n`);
process.exitCode = interrupted ? 130 : failures.length ? 1 : 0;
