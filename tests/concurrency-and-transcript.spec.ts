/**
 * Face B: concurrent RUNNING cap + transcriptPath persistence on settle/harvest.
 * Fixtures only — no live CLI / no ZCode tokens.
 *
 * Run with: node --import tsx --test tests/concurrency-and-transcript.spec.ts
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConcurrentCapError,
  MAX_CONCURRENT_ENV,
  assertUnderConcurrentCap,
  countRunningTasks,
  resolveMaxConcurrent,
} from '../src/runner/concurrency.ts';
import {
  getTaskDir,
  settleTask,
  spawnDetachedTask,
} from '../src/runner/detached.ts';
import { repairTaskTranscript, projectHarvest } from '../src/runner/harvest.ts';
import { readTranscriptDocument } from '../src/runner/transcript-document.ts';
import { readRunRecord, writeRunRecord, type RunRecord } from '../src/runner/settlement.ts';
import { ZCodeAdapter } from '../src/adapters/zcode.ts';
import { adapterForSettlement } from '../src/adapters/registry.ts';
import { locateRunTranscript } from '../src/runner/transcript.ts';
import type { WorkerAdapter } from '../src/adapters/base.ts';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-faceb-zcode.cjs',
);

const scratchDirs: string[] = [];
const runDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'conc-'): string {
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

function writeMeta(runsDir: string, taskId: string, status: string): void {
  const dir = join(runsDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      taskId,
      label: taskId,
      prompt: 'x',
      status,
      startTime: Date.now(),
      timeout: 60,
      adapter: 'bash',
      cwd: runsDir,
    }),
  );
}

describe('resolveMaxConcurrent / countRunningTasks', () => {
  it('defaults to 3 when env unset', () => {
    const n = withEnv({ [MAX_CONCURRENT_ENV]: undefined }, () => resolveMaxConcurrent());
    assert.equal(n, 3);
  });

  it('parses AGENT_HUB_MAX_CONCURRENT', () => {
    const n = withEnv({ [MAX_CONCURRENT_ENV]: '5' }, () => resolveMaxConcurrent());
    assert.equal(n, 5);
  });

  it('falls back to default on invalid values', () => {
    for (const bad of ['0', '-1', 'nope', '1.5']) {
      const n = withEnv({ [MAX_CONCURRENT_ENV]: bad }, () => resolveMaxConcurrent());
      assert.equal(n, 3, `expected default for ${bad}`);
    }
  });

  it('counts only RUNNING metas', () => {
    const runs = scratch('runs-');
    writeMeta(runs, 'a', 'RUNNING');
    writeMeta(runs, 'b', 'COMPLETED');
    writeMeta(runs, 'c', 'RUNNING');
    writeMeta(runs, 'd', 'FAILED');
    assert.equal(countRunningTasks(runs), 2);
  });

  it('assertUnderConcurrentCap throws ConcurrentCapError at cap', () => {
    const runs = scratch('cap-');
    writeMeta(runs, 'r1', 'RUNNING');
    writeMeta(runs, 'r2', 'RUNNING');
    withEnv({ [MAX_CONCURRENT_ENV]: '2' }, () => {
      assert.throws(
        () => assertUnderConcurrentCap(process.env, runs),
        (err: unknown) => {
          assert.ok(err instanceof ConcurrentCapError);
          assert.equal(err.running, 2);
          assert.equal(err.max, 2);
          return true;
        },
      );
    });
  });

  it('assertUnderConcurrentCap allows when under cap', () => {
    const runs = scratch('undercap-');
    writeMeta(runs, 'r1', 'RUNNING');
    withEnv({ [MAX_CONCURRENT_ENV]: '3' }, () => {
      assert.doesNotThrow(() => assertUnderConcurrentCap(process.env, runs));
    });
  });
});

describe('spawnDetachedTask concurrent cap', () => {
  it('refuses new spawn when live RUNNING count is at AGENT_HUB_MAX_CONCURRENT', () => {
    // Plant a fake RUNNING meta in the real .swarm-runs (same dir spawn counts).
    const fakeId = `task-cap-test-${Date.now().toString(36)}`;
    const fakeDir = getTaskDir(fakeId);
    mkdirSync(fakeDir, { recursive: true });
    runDirs.push(fakeDir);
    writeFileSync(
      join(fakeDir, 'meta.json'),
      JSON.stringify({
        taskId: fakeId,
        label: 'cap-plant',
        prompt: 'plant',
        pid: process.pid,
        status: 'RUNNING',
        startTime: Date.now(),
        timeout: 60,
        adapter: 'bash',
        cwd: process.cwd(),
      }),
    );

    const cwd = scratch('spawn-cwd-');
    withEnv(
      {
        [MAX_CONCURRENT_ENV]: '1',
        AGENT_HUB_TASK_ROOTS: cwd,
        ZCODE_CLI_PATH: FIXTURE,
      },
      () => {
        assert.throws(
          () =>
            spawnDetachedTask({
              prompt: 'should-refuse',
              adapter: 'bash',
              cwd,
              timeout: 5,
            }),
          (err: unknown) => err instanceof ConcurrentCapError,
        );
      },
    );
  });
});

describe('transcriptPath persistence', () => {
  it('keeps a session handle in metadata even without on-disk transcript support', () => {
    const taskId = `task-session-only-${Date.now()}`;
    const taskDir = getTaskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    runDirs.push(taskDir);
    writeFileSync(join(taskDir, 'meta.json'), JSON.stringify({ taskId, adapter: 'codex' }));
    settleTask(taskId, {
      status: 'COMPLETED', adapter: adapterForSettlement('codex'),
      output: '{"type":"thread.started","thread_id":"opaque-codex-session"}\n'
        + '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n',
      exitCode: 0,
    });
    const meta = JSON.parse(readFileSync(join(taskDir, 'meta.json'), 'utf8'));
    assert.equal(meta.sessionId, 'opaque-codex-session');
  });

  for (const adapterName of ['bash', 'codex', 'unknown']) {
    it(`settlement of interrupted ${adapterName} never adopts ZCode storage`, () => {
      const home = scratch('settle-home-');
      const rollout = join(home, '.zcode', 'cli', 'rollout');
      mkdirSync(rollout, { recursive: true });
      writeFileSync(join(rollout, 'model-io-sess_other.jsonl'), '{"response":{"text":"other"}}');
      const taskId = `task-settle-owner-${adapterName}-${Date.now()}`;
      const taskDir = getTaskDir(taskId);
      mkdirSync(taskDir, { recursive: true });
      runDirs.push(taskDir);
      writeFileSync(join(taskDir, 'meta.json'), JSON.stringify({
        taskId, adapter: adapterName, status: 'KILLED',
        startTime: Date.now() - 1000, endTime: Date.now(),
      }));
      const record = withEnv({ HOME: home }, () => settleTask(taskId, {
        status: 'KILLED', adapter: adapterForSettlement(adapterName), output: '',
      }));
      assert.equal(record.transcriptPath, undefined);
      assert.equal(record.resolution.transcriptRef, undefined);
      assert.equal(record.resolution.sessionRef, undefined);
      assert.equal(readRunRecord(taskDir)?.transcriptPath, undefined);
    });
  }

  it('settlement uses the supplied adapter capability without knowing its layout', () => {
    const taskId = `task-custom-transcript-${Date.now()}`;
    const taskDir = getTaskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    runDirs.push(taskDir);
    const path = join(scratch(), 'custom-conversation.json');
    writeFileSync(path, '[]');
    const adapter: WorkerAdapter = {
      name: 'custom', description: 'test adapter with independent storage',
      buildCommand: () => ({ cmd: 'unused', args: [] }),
      locateTranscript: () => ({
        path, via: 'custom-storage',
        transcriptRef: { provenance: 'custom', handle: 'opaque-transcript' },
        sessionRef: { provenance: 'custom', handle: 'opaque-session' },
      }),
    };
    const record = settleTask(taskId, { status: 'COMPLETED', adapter, output: 'answer' });
    assert.equal(record.transcriptPath, path);
    assert.equal(record.resolution.transcriptRef?.handle, 'opaque-transcript');
    assert.equal(record.resolution.sessionRef?.handle, 'opaque-session');
    assert.equal(readRunRecord(taskDir)?.transcriptPath, path);
    // A persisted path remains usable even without that adapter installed.
    assert.equal(locateRunTranscript(record, { adapter: 'custom' }).transcriptPath, path);
  });

  it('settleTask writes transcriptPath into resolution.json when file exists', () => {
    const home = scratch('home-');
    const handle = 'sess_persist-path-0001';
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    const transcriptFile = join(rollout, `model-io-${handle}.jsonl`);
    writeFileSync(
      transcriptFile,
      `${JSON.stringify({ response: { text: 'persisted-last' } })}\n`,
    );

    const taskId = `task-persist-${Date.now().toString(36)}`;
    const taskDir = getTaskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    runDirs.push(taskDir);
    writeFileSync(
      join(taskDir, 'meta.json'),
      JSON.stringify({
        taskId,
        label: 'persist',
        prompt: 'p',
        status: 'COMPLETED',
        startTime: Date.now(),
        endTime: Date.now(),
        timeout: 60,
        adapter: 'zcode',
        cwd: process.cwd(),
        exitCode: 0,
      }),
    );

    const adapter = new ZCodeAdapter();

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const record = settleTask(taskId, {
        status: 'COMPLETED',
        adapter,
        output: JSON.stringify({ sessionId: handle, response: 'persisted-last' }),
        exitCode: 0,
      });
      assert.equal(record.transcriptPath, transcriptFile);
      const disk = readRunRecord(taskDir);
      assert.equal(disk?.transcriptPath, transcriptFile);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it('transcript repair persists newly resolved transcriptPath into resolution.json', () => {
    const home = scratch('home-h-');
    const handle = 'sess_harvest-persist-0002';
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    const transcriptFile = join(rollout, `model-io-${handle}.jsonl`);
    writeFileSync(
      transcriptFile,
      `${JSON.stringify({ response: { text: 'harvest-persist' } })}\n`,
    );

    const taskId = `task-hpersist-${Date.now().toString(36)}`;
    const taskDir = getTaskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    runDirs.push(taskDir);

    const record: RunRecord = {
      taskId,
      resolution: {
        taskId,
        finalText: { kind: 'text', value: 'fallback' },
        transcriptRef: { provenance: 'zcode', handle },
      },
      observation: { producedOutput: true, unmetPreconditions: [] },
      // deliberately no transcriptPath yet
    };
    writeRunRecord(taskDir, record);

    const located = repairTaskTranscript(taskId, record, { home });
    const view = projectHarvest(located.record, located.transcriptPath, readTranscriptDocument(located.transcriptPath!, 'zcode'));
    assert.equal(view.transcriptPath, transcriptFile);
    assert.equal(view.lastTurn?.text, 'harvest-persist');

    const disk = readRunRecord(taskDir);
    assert.equal(disk?.transcriptPath, transcriptFile);
  });
});
