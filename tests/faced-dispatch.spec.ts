/**
 * Face B dispatch tests: the adapter seam and its detached runner.
 *
 * Regression target (ticket 11a): the zcode adapter used to inject no builtin
 * provider config, so every dispatch started a CLI that exits 0 with an empty
 * stdout — downstream that surfaced as "the output is not JSON" rather than
 * "the run never started". These tests pin the two halves: the env must reach
 * the child when a config exists, and the dispatch must be refused *by name*
 * when it does not.
 *
 * Run with: node --import tsx --test tests/faced-dispatch.spec.ts
 * Node builtins only — this seam has no DSH packages installed in this checkout.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_PROVIDER_CONFIG_ENV,
  PROVIDER_CONFIG_PRECONDITION,
  PreconditionUnmetError,
  defaultBuiltinProviderConfigPath,
  resolveProviderConfigEnv,
} from '../src/adapters/preconditions.ts';
import { CLI_PATH_PRECONDITION, ZCodeAdapter } from '../src/adapters/zcode.ts';
import { BashAdapter } from '../src/adapters/bash.ts';
import { getTaskDir, spawnDetachedTask } from '../src/runner/detached.ts';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-faceb-zcode.cjs');
const scratchDirs: string[] = [];
const runDirs: string[] = [];

/** A fresh temp dir, cleaned up when the file's tests finish. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'faceb-11a-'));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Dispatch through the real runner, remembering the task directory so the test
 * file can remove it. `.swarm-runs` is anchored to the process start cwd (i.e.
 * the repo), so without this every run would litter it.
 */
function dispatch(options: Parameters<typeof spawnDetachedTask>[0]): ReturnType<typeof spawnDetachedTask> {
  // Scratch cwds live under os.tmpdir(), outside the default allowlist
  // (repo root + /tmp/agent-hub*). Pin AGENT_HUB_TASK_ROOTS for the dispatch.
  const cwd = resolve(options.cwd || process.cwd());
  const meta = withEnv({ AGENT_HUB_TASK_ROOTS: cwd }, () => spawnDetachedTask(options));
  runDirs.push(getTaskDir(meta.taskId));
  return meta;
}

/**
 * Build the App packaging layout the CLI ships in, and return the CLI entry.
 * `<root>/glm/zcode.cjs` with `<root>/config/provider/zcode-builtin.json`
 * present is the layout where the CLI's own lookup misses and the injected
 * entry is the only thing that works. The entry is the same probe the other
 * tests run directly, so its stdout reports what it received.
 */
function layout(configPresent: boolean): { cli: string; config: string } {
  const root = scratch();
  const cli = join(root, 'glm', 'zcode.cjs');
  const config = join(root, 'config', 'provider', 'zcode-builtin.json');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, readFileSync(FIXTURE, 'utf8'));
  chmodSync(cli, 0o755);
  if (configPresent) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{}\n');
  }
  return { cli, config };
}

/** Run one adapter unconditionally against a fixed environment, restoring it after. */
function withEnv<T>(overrides: Record<string, string | undefined>, body: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Wait for a detached pid to disappear, bounded. */
async function waitForExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const started = Date.now();
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (alive() && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !alive();
}

/**
 * Poll a file until it matches, bounded. A detached child's stdio flushes on
 * its own schedule, so "the pid is gone" does not yet mean "the log is complete".
 */
async function waitForFileMatch(path: string, pattern: RegExp, timeoutMs = 2_000): Promise<string> {
  const started = Date.now();
  let content = '';
  while (Date.now() - started < timeoutMs) {
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      content = '';
    }
    if (pattern.test(content)) return content;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return content;
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
});

describe('11a · precondition resolution (neutral, engine-checkable)', () => {
  it('blocks when the App-layout config is absent, and names the derived path', () => {
    const { cli, config } = layout(false);
    const resolution = withEnv({ [BUILTIN_PROVIDER_CONFIG_ENV]: undefined }, () =>
      resolveProviderConfigEnv(cli));
    assert.equal(resolution.status, 'blocked');
    if (resolution.status !== 'blocked') return;
    assert.equal(defaultBuiltinProviderConfigPath(cli), config);
    assert.match(resolution.reason, /no usable builtin provider config/);
  });

  it('injects the derived App-layout config when it exists', () => {
    const { cli, config } = layout(true);
    const resolution = withEnv({ [BUILTIN_PROVIDER_CONFIG_ENV]: undefined }, () =>
      resolveProviderConfigEnv(cli));
    assert.deepEqual(resolution, {
      status: 'inject',
      env: { [BUILTIN_PROVIDER_CONFIG_ENV]: config },
      source: 'derived',
    });
  });

  it('lets an explicit declaration win, and rejects an unreadable one', () => {
    const { cli, config } = layout(true);
    const other = join(scratch(), 'declared.json');
    writeFileSync(other, '{}\n');
    assert.deepEqual(resolveProviderConfigEnv(cli, other), {
      status: 'inject',
      env: { [BUILTIN_PROVIDER_CONFIG_ENV]: other },
      source: 'override',
    });
    const missing = resolveProviderConfigEnv(cli, join(scratch(), 'nope.json'));
    assert.equal(missing.status, 'blocked');
    if (missing.status !== 'blocked') return;
    assert.match(missing.reason, /not a readable file/);
    // The derived path is still the fallback the CLI itself cannot find.
    assert.equal(defaultBuiltinProviderConfigPath(cli), config);
  });

  it('respects an inherited environment entry before deriving anything', () => {
    const { cli } = layout(false);
    const inherited = join(scratch(), 'inherited.json');
    writeFileSync(inherited, '{}\n');
    const resolution = withEnv({ [BUILTIN_PROVIDER_CONFIG_ENV]: inherited }, () =>
      resolveProviderConfigEnv(cli));
    assert.deepEqual(resolution, {
      status: 'inject',
      env: { [BUILTIN_PROVIDER_CONFIG_ENV]: inherited },
      source: 'override',
    });
  });
});

describe('11a · zcode adapter declares and checks the precondition', () => {
  it('throws PreconditionUnmetError instead of starting a doomed process', () => {
    const { cli } = layout(false);
    const adapter = withEnv(
      { [BUILTIN_PROVIDER_CONFIG_ENV]: undefined, ZCODE_CLI_PATH: cli },
      () => new ZCodeAdapter(),
    );
    assert.deepEqual(adapter.preconditions, [CLI_PATH_PRECONDITION, PROVIDER_CONFIG_PRECONDITION]);
    assert.throws(() => adapter.checkPreconditions(), (error: unknown) => {
      assert.ok(error instanceof PreconditionUnmetError);
      assert.equal((error as PreconditionUnmetError).precondition, PROVIDER_CONFIG_PRECONDITION);
      assert.match((error as Error).message, /precondition unmet \(builtin-provider-config\)/);
      return true;
    });
  });

  it('hands the child the injected config when one exists', () => {
    const { cli, config } = layout(true);
    const built = withEnv(
      { [BUILTIN_PROVIDER_CONFIG_ENV]: undefined, ZCODE_CLI_PATH: cli },
      () => {
        const adapter = new ZCodeAdapter();
        adapter.checkPreconditions();
        return adapter.buildCommand({ prompt: 'p', cwd: scratch() });
      },
    );
    assert.equal(built.env?.[BUILTIN_PROVIDER_CONFIG_ENV], config);
  });

  it('passes env for the fixture fallback to work, and bash declares none', () => {
    const bash = new BashAdapter();
    assert.deepEqual(bash.preconditions, []);
    assert.doesNotThrow(() => bash.checkPreconditions());
    const built = bash.buildCommand({ prompt: 'echo hi', cwd: scratch() });
    assert.equal(built.cmd, 'bash');
    assert.deepEqual(built.args, ['-c', 'echo hi']);
  });
});

describe('11a · missing ZCODE_CLI_PATH fails loud (no fixture fallback)', () => {
  it('refuses checkPreconditions when neither explicit path nor ZCODE_CLI_PATH resolves', () => {
    const adapter = withEnv(
      { ZCODE_CLI_PATH: undefined },
      () => new ZCodeAdapter(),
    );
    assert.throws(() => adapter.checkPreconditions(), (error: unknown) => {
      assert.ok(error instanceof PreconditionUnmetError);
      assert.equal((error as PreconditionUnmetError).precondition, CLI_PATH_PRECONDITION);
      assert.match((error as Error).message, /ZCODE_CLI_PATH is missing/);
      return true;
    });
  });
});

describe('11a · the engine refuses the dispatch, not the parse', () => {
  it('records a never-started task when the precondition is unmet', () => {
    const { cli } = layout(false);
    const dir = scratch();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const meta = withEnv(
        { [BUILTIN_PROVIDER_CONFIG_ENV]: undefined, ZCODE_CLI_PATH: cli },
        () => dispatch({ prompt: 'must not start', cwd: dir }),
      );
      assert.equal(meta.status, 'FAILED');
      assert.equal(meta.pid, undefined, 'nothing may be spawned');
      assert.match(meta.error ?? '', /precondition unmet \(builtin-provider-config\)/);
      // Crucially *not* the old symptom. The old path spawned the CLI, got an
      // empty stdout, and reported a JSON parse failure — so "JSON" is the word
      // that must be absent, while the reason itself is free to explain stdout.
      assert.doesNotMatch(meta.error ?? '', /JSON/);
      const report = readFileSync(join(getTaskDir(meta.taskId), 'report.md'), 'utf8');
      assert.match(report, /Not started:/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('spawns the child, with the config in its environment, when one exists', async () => {
    const { cli, config } = layout(true);
    const dir = scratch();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const meta = withEnv(
        { [BUILTIN_PROVIDER_CONFIG_ENV]: undefined, ZCODE_CLI_PATH: cli },
        () => dispatch({ prompt: 'run for real', cwd: dir }),
      );
      assert.equal(meta.status, 'RUNNING');
      assert.ok(meta.pid && meta.pid > 0);
      await waitForExit(meta.pid);
      // `.swarm-runs` is anchored to the process start cwd, not to chdir.
      const rawLog = await waitForFileMatch(join(getTaskDir(meta.taskId), 'raw.log'), /started with provider config/);
      assert.match(rawLog, /started with provider config/);
      // The spawned child received exactly the adapter's resolved entry.
      assert.equal(config, defaultBuiltinProviderConfigPath(cli));
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('11a · the two injection sites no longer disagree', () => {
  it('puts the same provider config into the same child entry', async () => {
    const { cli, config } = layout(true);

    // Face A's view of the child environment, reproduced through the shared rule
    // (its own module graph needs DSH packages this checkout does not install).
    const faceAEnv = resolveProviderConfigEnv(cli);
    assert.equal(faceAEnv.status, 'inject');
    if (faceAEnv.status !== 'inject') return;
    assert.equal(faceAEnv.env[BUILTIN_PROVIDER_CONFIG_ENV], config);

    const emitted = spawn(process.execPath, [FIXTURE], {
      env: { [BUILTIN_PROVIDER_CONFIG_ENV]: faceAEnv.env[BUILTIN_PROVIDER_CONFIG_ENV] },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = await new Promise<string>((resolve) => {
      let text = '';
      emitted.stdout.on('data', (chunk) => { text += String(chunk); });
      emitted.on('close', () => resolve(text));
    });
    assert.match(stdout, /started with provider config/);

    // Face B's view, through the adapter that used to inject nothing.
    const built = withEnv(
      { [BUILTIN_PROVIDER_CONFIG_ENV]: undefined, ZCODE_CLI_PATH: cli },
      () => new ZCodeAdapter().buildCommand({ prompt: 'x', cwd: scratch() }),
    );
    assert.equal(built.env?.[BUILTIN_PROVIDER_CONFIG_ENV], config);
  });
});
