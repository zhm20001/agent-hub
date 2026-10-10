/**
 * Unit tests for Agent Hub cwd whitelist (Face B dispatch fence).
 * Fixtures / path math only — no live CLI / no tokens.
 *
 * Run with: node --import tsx --test tests/task-roots.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CwdNotAllowedError,
  DEFAULT_TMP_DEMO_PREFIX,
  TASK_ROOTS_ENV,
  assertCwdAllowed,
  isCwdAllowed,
  resolveTaskRoots,
} from '../src/runner/task-roots.ts';
import { getTaskDir, spawnDetachedTask } from '../src/runner/detached.ts';

const scratchDirs: string[] = [];
const runDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'task-roots-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

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

describe('resolveTaskRoots', () => {
  it('defaults to the given repo root when env is unset', () => {
    const root = scratch();
    const roots = withEnv({ [TASK_ROOTS_ENV]: undefined }, () =>
      resolveTaskRoots(process.env, root));
    assert.deepEqual(roots, [resolve(root)]);
  });

  it('parses colon-separated absolute paths from AGENT_HUB_TASK_ROOTS', () => {
    const a = scratch();
    const b = scratch();
    const roots = withEnv({ [TASK_ROOTS_ENV]: `${a}:${b}` }, () =>
      resolveTaskRoots(process.env, '/should-not-use'));
    assert.deepEqual(roots, [resolve(a), resolve(b)]);
  });

  it('ignores empty segments', () => {
    const a = scratch();
    const roots = withEnv({ [TASK_ROOTS_ENV]: `:${a}::` }, () =>
      resolveTaskRoots());
    assert.deepEqual(roots, [resolve(a)]);
  });
});

describe('isCwdAllowed / assertCwdAllowed', () => {
  it('allows the repo root and nested paths under default roots', () => {
    const root = scratch();
    const nested = join(root, 'nested', 'ws');
    mkdirSync(nested, { recursive: true });
    withEnv({ [TASK_ROOTS_ENV]: undefined }, () => {
      const roots = resolveTaskRoots(process.env, root);
      assert.equal(isCwdAllowed(root, roots), true);
      assert.equal(isCwdAllowed(nested, roots), true);
      assert.doesNotThrow(() => assertCwdAllowed(nested, roots));
    });
  });

  it('allows /tmp/agent-hub* demo dirs only when env is unset', () => {
    const demo = mkdtempSync(`${resolve(DEFAULT_TMP_DEMO_PREFIX)}-`);
    scratchDirs.push(demo);
    const nested = join(demo, 'ws');
    mkdirSync(nested, { recursive: true });

    withEnv({ [TASK_ROOTS_ENV]: undefined }, () => {
      const roots = resolveTaskRoots(process.env, scratch());
      assert.equal(isCwdAllowed(demo, roots), true);
      assert.equal(isCwdAllowed(nested, roots), true);
    });

    // Env set → demo prefix is NOT an automatic exception
    const only = scratch();
    withEnv({ [TASK_ROOTS_ENV]: only }, () => {
      const roots = resolveTaskRoots();
      assert.equal(isCwdAllowed(demo, roots), false);
      assert.throws(
        () => assertCwdAllowed(demo, roots),
        (err: unknown) => {
          assert.ok(err instanceof CwdNotAllowedError);
          assert.match((err as Error).message, /outside the task-root allowlist/);
          assert.match((err as Error).message, new RegExp(TASK_ROOTS_ENV));
          return true;
        },
      );
    });
  });

  it('refuses a sibling path outside every root', () => {
    const root = scratch();
    const sibling = scratch();
    withEnv({ [TASK_ROOTS_ENV]: root }, () => {
      const roots = resolveTaskRoots();
      assert.equal(isCwdAllowed(sibling, roots), false);
      assert.throws(() => assertCwdAllowed(sibling, roots), CwdNotAllowedError);
    });
  });
});

describe('spawnDetachedTask enforces the whitelist', () => {
  it('throws CwdNotAllowedError before creating a task when cwd is outside', () => {
    const outside = scratch();
    const allowed = scratch();
    withEnv({ [TASK_ROOTS_ENV]: allowed }, () => {
      assert.throws(
        () => spawnDetachedTask({ prompt: 'must not start', cwd: outside, adapter: 'bash' }),
        CwdNotAllowedError,
      );
    });
  });

  it('allows a cwd under AGENT_HUB_TASK_ROOTS (bash, no tokens)', async () => {
    const dir = scratch();
    const meta = withEnv({ [TASK_ROOTS_ENV]: dir }, () =>
      spawnDetachedTask({
        prompt: 'echo whitelist-ok',
        cwd: dir,
        adapter: 'bash',
        timeout: 5,
      }));
    runDirs.push(getTaskDir(meta.taskId));
    assert.ok(meta.status === 'RUNNING' || meta.status === 'COMPLETED' || meta.status === 'FAILED');
    assert.equal(meta.cwd, resolve(dir));
    // Wait for the detached child to exit so close handlers finish before after() rm.
    if (meta.pid) {
      const started = Date.now();
      while (Date.now() - started < 2_000) {
        try {
          process.kill(meta.pid, 0);
          await new Promise((r) => setTimeout(r, 25));
        } catch {
          break;
        }
      }
      // Brief settle for close handler writes
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
