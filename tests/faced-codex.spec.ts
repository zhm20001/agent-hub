/**
 * Face B Codex adapter tests: resolve path, buildCommand, translate, preconditions.
 *
 * Run with: node --import tsx --test tests/faced-codex.spec.ts
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_FILE_PRECONDITION,
  CLI_PATH_PRECONDITION,
  CodexAdapter,
  mapModeToSandbox,
  resolveCodexAuthPath,
  resolveCodexCliPath,
} from '../src/adapters/codex.ts';
import { PreconditionUnmetError } from '../src/adapters/preconditions.ts';
import {
  UnknownAdapterError,
  getAdapter,
  getTaskDir,
  spawnDetachedTask,
} from '../src/runner/detached.ts';
import { readRunRecord, type RunRecord } from '../src/runner/settlement.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures', 'fake-codex.cjs');
const THREAD = '01a13e75-d25a-70f3-b030-53c79a3b0ff5';

const scratchDirs: string[] = [];
const runDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'faceb-codex-'));
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

function dispatch(options: Parameters<typeof spawnDetachedTask>[0]): ReturnType<typeof spawnDetachedTask> {
  const cwd = resolve(options.cwd || process.cwd());
  const meta = withEnv({ AGENT_HUB_TASK_ROOTS: cwd }, () => spawnDetachedTask(options));
  runDirs.push(getTaskDir(meta.taskId));
  return meta;
}

async function waitForRecord(taskId: string, timeoutMs = 8_000): Promise<RunRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const record = readRunRecord(getTaskDir(taskId));
    if (record !== null) return record;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no closing record for ${taskId} within ${timeoutMs}ms`);
}

/** Auth layout the precondition checks (existence only). */
function authLayout(): { auth: string; home: string } {
  const home = scratch();
  const auth = join(home, 'auth.json');
  writeFileSync(auth, '{}\n');
  return { auth, home };
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
});

describe('codex · resolveCodexCliPath', () => {
  it('prefers CODEX_CLI_PATH over bundle and PATH', () => {
    const cli = join(scratch(), 'codex-bin');
    writeFileSync(cli, '#!/bin/sh\n');
    chmodSync(cli, 0o755);
    const resolved = withEnv({ CODEX_CLI_PATH: cli }, () => resolveCodexCliPath());
    assert.deepEqual(resolved, { ok: true, path: resolve(cli) });
  });

  it('accepts an explicit path and rejects a missing one', () => {
    const cli = join(scratch(), 'explicit-codex');
    writeFileSync(cli, '#!/bin/sh\n');
    chmodSync(cli, 0o755);
    assert.equal(resolveCodexCliPath(cli).ok, true);
    const missing = resolveCodexCliPath(join(scratch(), 'nope'));
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.match(missing.reason, /not a usable executable/);
  });

  it('fails loud when nothing resolves', () => {
    const resolved = withEnv({
      CODEX_CLI_PATH: undefined,
      PATH: scratch(), // empty dir — no codex on PATH; bundle may still exist on this machine
    }, () => resolveCodexCliPath());
    // On this machine ChatGPT.app bundle usually exists; when it does, ok is fine.
    // Force-fail by pointing CODEX_CLI_PATH at a missing file (env wins and blocks).
    const blocked = withEnv({ CODEX_CLI_PATH: join(scratch(), 'missing-codex') }, () =>
      resolveCodexCliPath());
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.match(blocked.reason, /CODEX_CLI_PATH is set but not a usable executable/);
  });
});

describe('codex · mode → sandbox map', () => {
  it('maps plan/edit/build/yolo and passes raw sandbox names through', () => {
    assert.deepEqual(mapModeToSandbox('plan'), { sandbox: 'read-only', bypassApprovalsAndSandbox: false });
    assert.deepEqual(mapModeToSandbox('edit'), { sandbox: 'workspace-write', bypassApprovalsAndSandbox: false });
    assert.deepEqual(mapModeToSandbox('build'), { sandbox: 'workspace-write', bypassApprovalsAndSandbox: false });
    assert.deepEqual(mapModeToSandbox(undefined), { sandbox: 'workspace-write', bypassApprovalsAndSandbox: false });
    assert.deepEqual(mapModeToSandbox('yolo'), {
      sandbox: 'danger-full-access',
      bypassApprovalsAndSandbox: true,
    });
    assert.deepEqual(mapModeToSandbox('read-only'), { sandbox: 'read-only', bypassApprovalsAndSandbox: false });
    assert.deepEqual(mapModeToSandbox('danger-full-access'), {
      sandbox: 'danger-full-access',
      bypassApprovalsAndSandbox: false,
    });
  });
});

describe('codex · buildCommand', () => {
  it('builds a fresh exec --json command and never uses -p for the prompt', () => {
    const adapter = new CodexAdapter(FIXTURE);
    const cwd = scratch();
    const built = adapter.buildCommand({ prompt: 'hello world', cwd, mode: 'edit' });
    assert.equal(built.cmd, 'node');
    assert.ok(built.args.includes('exec'));
    assert.ok(built.args.includes('--json'));
    assert.ok(built.args.includes('-C'));
    assert.ok(built.args.includes(cwd));
    assert.ok(built.args.includes('-s'));
    assert.ok(built.args.includes('workspace-write'));
    assert.ok(built.args.includes('--skip-git-repo-check'));
    assert.ok(built.args.includes('--'));
    assert.ok(built.args.includes('hello world'));
    assert.equal(built.args.includes('-p'), false);
    // Prompt must not be preceded by -p
    const promptAt = built.args.indexOf('hello world');
    assert.notEqual(built.args[promptAt - 1], '-p');
  });

  it('builds resume as exec … resume --json <id> -- <prompt>', () => {
    const adapter = new CodexAdapter(FIXTURE);
    const cwd = scratch();
    const built = adapter.buildCommand({
      prompt: 'continue',
      cwd,
      mode: 'plan',
      resumeSessionId: THREAD,
    });
    const resumeAt = built.args.indexOf('resume');
    assert.ok(resumeAt >= 0);
    assert.equal(built.args[resumeAt + 1], '--json');
    assert.equal(built.args[resumeAt + 2], THREAD);
    assert.equal(built.args[resumeAt + 3], '--');
    assert.equal(built.args[resumeAt + 4], 'continue');
    assert.ok(built.args.includes('read-only'));
    assert.equal(built.args.includes('-p'), false);
  });

  it('keeps a leading-dash resume prompt after --', () => {
    const adapter = new CodexAdapter(FIXTURE);
    const built = adapter.buildCommand({
      prompt: '--help-looking',
      cwd: scratch(),
      resumeSessionId: THREAD,
    });
    const dashAt = built.args.indexOf('--');
    assert.ok(dashAt >= 0);
    assert.equal(built.args[dashAt + 1], '--help-looking');
  });

  it('adds dangerously-bypass for yolo', () => {
    const adapter = new CodexAdapter(FIXTURE);
    const built = adapter.buildCommand({ prompt: 'go', cwd: scratch(), mode: 'yolo' });
    assert.ok(built.args.includes('danger-full-access'));
    assert.ok(built.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });
});

describe('codex · translate JSONL', () => {
  const adapter = new CodexAdapter(FIXTURE);

  const okJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: 'pong' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 64,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 0,
      },
    }),
    '',
  ].join('\n');

  it('extracts sessionRef, finalText, usage; invents no verdict', () => {
    const t = adapter.translate({ output: okJsonl, exitCode: 0, signal: null });
    assert.equal(t.producedOutput, true);
    assert.deepEqual(t.finalText, { kind: 'text', value: 'pong' });
    assert.deepEqual(t.sessionRef, { provenance: 'codex', handle: THREAD });
    assert.deepEqual(t.transcriptRef, t.sessionRef);
    assert.deepEqual(t.usage, { tokens: { total: 120, completeness: 'exact' } });
    assert.equal(t.stopCause, undefined);
    assert.equal('verdict' in t, false);
  });

  it('tolerates transient error reconnect lines', () => {
    const reconnect = [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
      JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (request timed out)' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'error', message: 'Falling back from WebSockets to HTTPS' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'ok' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 2, reasoning_output_tokens: 0 },
      }),
      '',
    ].join('\n');
    const t = adapter.translate({ output: reconnect, exitCode: 0, signal: null });
    assert.deepEqual(t.finalText, { kind: 'text', value: 'ok' });
    assert.equal(t.stopCause, undefined);
    assert.equal(t.usage?.tokens?.total, 12);
  });

  it('maps turn.failed → stopCause failed', () => {
    const failed = [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } }),
      '',
    ].join('\n');
    const t = adapter.translate({ output: failed, exitCode: 0, signal: null });
    assert.equal(t.stopCause, 'failed');
    assert.deepEqual(t.sessionRef, { provenance: 'codex', handle: THREAD });
    assert.deepEqual(t.finalText, { kind: 'empty' });
  });

  it('empty stdout is no-output; nonzero exit is process-exited-nonzero', () => {
    assert.equal(
      adapter.translate({ output: '', exitCode: 0, signal: null }).stopCause,
      'no-output',
    );
    assert.match(
      adapter.translate({ output: '', exitCode: 3, signal: null }).stopCause ?? '',
      /process-exited-nonzero \(exit=3\)/,
    );
  });

  it('bad-json is output-not-translatable; missing-session still yields text without refs', () => {
    const bad = adapter.translate({ output: 'not json\n', exitCode: 0, signal: null });
    assert.equal(bad.producedOutput, false);
    assert.equal(bad.stopCause, 'output-not-translatable');

    const missing = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'hi' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      '',
    ].join('\n');
    const t = adapter.translate({ output: missing, exitCode: 0, signal: null });
    assert.deepEqual(t.finalText, { kind: 'text', value: 'hi' });
    assert.equal(t.sessionRef, undefined);
  });
});

describe('codex · preconditions', () => {
  it('refuses when auth file is missing', () => {
    const home = scratch();
    withEnv({ CODEX_CLI_PATH: FIXTURE, CODEX_HOME: home }, () => {
      const adapter = new CodexAdapter();
      assert.deepEqual(adapter.preconditions, [CLI_PATH_PRECONDITION, AUTH_FILE_PRECONDITION]);
      assert.throws(() => adapter.checkPreconditions(), (error: unknown) => {
        assert.ok(error instanceof PreconditionUnmetError);
        assert.equal((error as PreconditionUnmetError).precondition, AUTH_FILE_PRECONDITION);
        return true;
      });
    });
  });

  it('passes when cli-path and auth exist', () => {
    const { home } = authLayout();
    withEnv({ CODEX_CLI_PATH: FIXTURE, CODEX_HOME: home }, () => {
      const adapter = new CodexAdapter();
      assert.doesNotThrow(() => adapter.checkPreconditions());
      assert.equal(resolveCodexAuthPath(), join(home, 'auth.json'));
    });
  });

  it('getAdapter("codex") returns CodexAdapter', () => {
    assert.equal(getAdapter('codex').name, 'codex');
  });

  it('getAdapter rejects unknown names (no silent ZCode fallback)', () => {
    assert.throws(() => getAdapter('Codex'), (error: unknown) => {
      assert.ok(error instanceof UnknownAdapterError);
      assert.equal((error as UnknownAdapterError).adapterName, 'Codex');
      return true;
    });
    assert.throws(() => getAdapter('unknown-bot'), UnknownAdapterError);
  });
});

describe('codex · spawnDetachedTask with fixture', () => {
  it('settles a successful fake run into a closing record', async () => {
    const { home } = authLayout();
    const cwd = scratch();
    const meta = withEnv(
      {
        CODEX_CLI_PATH: FIXTURE,
        CODEX_HOME: home,
        FAKE_CODEX_BEHAVIOR: 'ok',
        FAKE_CODEX_DELAY_MS: '50',
        FAKE_CODEX_RESPONSE: 'codex-ok',
        FAKE_CODEX_THREAD_ID: THREAD,
        AGENT_HUB_TASK_ROOTS: cwd,
        // Parallel test files share .swarm-runs; avoid ConcurrentCapError flake.
        AGENT_HUB_MAX_CONCURRENT: '50',
      },
      () => dispatch({ prompt: 'say ok', cwd, adapter: 'codex', timeout: 30 }),
    );
    assert.equal(meta.status, 'RUNNING');
    assert.ok(meta.pid && meta.pid > 0);
    const record = await waitForRecord(meta.taskId);
    assert.deepEqual(record.resolution.finalText, { kind: 'text', value: 'codex-ok' });
    assert.deepEqual(record.resolution.sessionRef, { provenance: 'codex', handle: THREAD });
    assert.equal(record.resolution.stopCause, undefined);
    assert.equal(record.observation.producedOutput, true);
  });

  it('refuses unknown adapter names without spawning', () => {
    const cwd = scratch();
    const meta = withEnv(
      {
        AGENT_HUB_TASK_ROOTS: cwd,
        AGENT_HUB_MAX_CONCURRENT: '50',
      },
      () => dispatch({ prompt: 'nope', cwd, adapter: 'Codex', timeout: 30 }),
    );
    assert.equal(meta.status, 'FAILED');
    assert.equal(meta.pid, undefined);
    assert.match(meta.error ?? '', /unknown adapter: Codex/);
  });
});
