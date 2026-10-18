/**
 * Face B closed-loop tests (ticket 11c): dispatch → closing record → the
 * original transcript can be opened.
 *
 * What these pin, in the ticket's acceptance terms:
 *   - a normal dispatch settles into a `Resolution` whose `finalText` carries
 *     the answer, with `sessionRef` and `transcriptRef` both obtainable;
 *   - an unmet precondition settles as `producedOutput: false` +
 *     `unmetPreconditions` + a named `stopCause` — and specifically *not* as the
 *     old "the output is not JSON" symptom;
 *   - an exit-0 empty stdout, a dead resume handle (exit 1 + empty stdout), and
 *     "produced but empty" are four different mechanical facts, not one;
 *   - a `TranscriptRef` can be opened through the agent's app-server, including
 *     the three-way handshake that stalls it if unanswered;
 *   - `npm run transcript -- <taskId>` prints that transcript for a human.
 *
 * Run with: node --import tsx --test tests/faced-close-the-loop.spec.ts
 * Node builtins only — this seam has no DSH packages installed in this checkout.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_PROVIDER_CONFIG_ENV } from '../src/adapters/preconditions.ts';
import { ZCodeAdapter } from '../src/adapters/zcode.ts';
import { RUN_RECORD_FILE, readRunRecord, type RunRecord } from '../src/runner/settlement.ts';
import { getTaskDir, readResolution, readTaskMeta, spawnDetachedTask } from '../src/runner/detached.ts';
import { TranscriptUnavailableError, readTranscript } from '../src/runner/readback.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZCODE = resolve(HERE, 'fixtures', 'fake-zcode.cjs');
const FIXTURE_APPSERVER = resolve(HERE, 'fixtures', 'fake-faceb-appserver.cjs');

/** Session id the fake CLI mints for a fresh dispatch. */
const SESSION = 'sess_11c-00000000-0000-4000-8000-000000000001';

const scratchDirs: string[] = [];
const runDirs: string[] = [];

/** A fresh temp dir, cleaned up when the file's tests finish. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'faceb-11c-'));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Build the App packaging layout the CLI ships in (`<root>/glm/zcode.cjs` with
 * `<root>/config/provider/zcode-builtin.json`), and put `entry` at the CLI path.
 * With the config absent this is the layout where the dispatch must be refused.
 */
function layout(options: { config?: boolean; entry?: string } = {}): { cli: string; config: string } {
  const root = scratch();
  const cli = join(root, 'glm', 'zcode.cjs');
  const config = join(root, 'config', 'provider', 'zcode-builtin.json');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, readFileSync(options.entry ?? FIXTURE_ZCODE, 'utf8'));
  if (options.config !== false) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{}\n');
  }
  return { cli, config };
}

/** Run one dispatch through the real runner, remembering its dir for cleanup. */
function dispatch(options: Parameters<typeof spawnDetachedTask>[0]): ReturnType<typeof spawnDetachedTask> {
  // Scratch cwds live under os.tmpdir(), outside the default allowlist
  // (repo root + /tmp/agent-hub*). Pin AGENT_HUB_TASK_ROOTS for the dispatch.
  const cwd = resolve(options.cwd || process.cwd());
  const meta = withEnv({ AGENT_HUB_TASK_ROOTS: cwd }, () => spawnDetachedTask(options));
  runDirs.push(getTaskDir(meta.taskId));
  return meta;
}

/** Run `body` against a fixed environment, restoring it after. */
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

/** Dispatch one run with a fixed environment, and wait for its closing record. */
async function dispatchAndSettle(
  layoutOptions: { config?: boolean; entry?: string },
  env: Record<string, string | undefined>,
  dispatchOptions: Parameters<typeof spawnDetachedTask>[0],
): Promise<{ taskId: string; record: RunRecord }> {
  const { cli } = layout(layoutOptions);
  const meta = withEnv(
    { [BUILTIN_PROVIDER_CONFIG_ENV]: undefined, ZCODE_CLI_PATH: cli, ...env },
    () => dispatch({ cwd: scratch(), ...dispatchOptions }),
  );
  return { taskId: meta.taskId, record: await waitForRecord(meta.taskId) };
}

/** Poll for the record the runner writes when the process closes. */
async function waitForRecord(taskId: string, timeoutMs = 8_000): Promise<RunRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const record = readRunRecord(getTaskDir(taskId));
    if (record !== null) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no closing record for ${taskId} within ${timeoutMs}ms`);
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
});

describe('11c · a normal dispatch settles into a closing record', () => {
  it('carries finalText, sessionRef and transcriptRef, and invents no verdict', async () => {
    const { taskId, record } = await dispatchAndSettle({}, {
      FAKE_ZCODE_RESPONSE: '11c answer',
      FAKE_ZCODE_SESSION_ID: SESSION,
    }, { prompt: 'say ok', adapter: 'zcode' });

    assert.equal(record.taskId, taskId);
    assert.deepEqual(record.resolution.finalText, { kind: 'text', value: '11c answer' });
    // A run that ended normally has no stop cause to report — not "succeeded".
    assert.equal(record.resolution.stopCause, undefined);
    assert.equal(record.resolution.usage?.tokens?.total, 120);
    assert.deepEqual(record.observation, { producedOutput: true, unmetPreconditions: [] });
    assert.deepEqual(record.resolution.sessionRef, { provenance: 'zcode', handle: SESSION });
    assert.deepEqual(record.resolution.transcriptRef, { provenance: 'zcode', handle: SESSION });
    // No verdict fields: ADR-0002 removed them from the contract.
    assert.deepEqual(Object.keys(record.resolution).sort(),
      ['finalText', 'sessionRef', 'taskId', 'transcriptRef', 'usage']);

    const meta = readTaskMeta(taskId);
    assert.equal(meta?.status, 'COMPLETED');
    assert.equal(meta?.exitCode, 0);

    const report = readFileSync(join(getTaskDir(taskId), 'report.md'), 'utf8');
    assert.match(report, /### Closing Record/);
    assert.match(report, /text \(10 chars\)/);
    assert.match(report, new RegExp(`zcode:${SESSION}`));
  });

  it('materializes the same record from disk when the close handler never ran', async () => {
    const { taskId, record } = await dispatchAndSettle({}, {
      FAKE_ZCODE_RESPONSE: 'late settle',
      FAKE_ZCODE_SESSION_ID: SESSION,
    }, { prompt: 'say ok' });

    // Simulate a dispatcher that exited before its detached child finished.
    rmSync(join(getTaskDir(taskId), RUN_RECORD_FILE));
    assert.equal(readRunRecord(getTaskDir(taskId)), null);

    assert.deepEqual(readResolution(taskId), record);
  });
});

describe('11c · the real CLI prints its result across many lines', () => {
  // Measured against the real CLI on 2026-10-11: stdout is a *pretty-printed*
  // object (26 lines / 650 bytes), and stderr may write a warning line before it.
  const prettyResult = (response: string): string => [
    'ZCode Built-in missing',
    '{',
    '  "sessionId": "sess_c13ac173-e5c8-4854-83f2-41eb293ebda7",',
    '  "traceId": "bbb80ff5-1f90-49e9-bfc8-7b497a46acba",',
    '  "turnId": "turn_7a24ec80-ca2c-4fd0-bdc3-1d8212c46b71",',
    `  "response": ${JSON.stringify(response)},`,
    '  "usage": {',
    '    "source": "provider",',
    '    "modelRequestCount": 1,',
    '    "inputTokens": 20304,',
    '    "outputTokens": 4,',
    '    "totalTokens": 20308,',
    '    "cacheReadTokens": 0,',
    '    "cacheWriteTokens": 0',
    '  },',
    '  "eventCount": 4,',
    '  "projection": { "status": "idle", "turnCount": 1 }',
    '}',
    '',
  ].join('\n');

  it('finds the multi-line result after a stderr warning', () => {
    const { cli } = layout();
    const translation = new ZCodeAdapter(cli).translate({ output: prettyResult('11c-loop-ok'), exitCode: 0, signal: null });

    assert.deepEqual(translation.finalText, { kind: 'text', value: '11c-loop-ok' });
    assert.equal(translation.producedOutput, true);
    assert.equal(translation.stopCause, undefined);
    assert.equal(translation.sessionRef?.handle, 'sess_c13ac173-e5c8-4854-83f2-41eb293ebda7');
    assert.deepEqual(translation.transcriptRef, translation.sessionRef);
    assert.deepEqual(translation.usage, { tokens: { total: 20308, completeness: 'exact' } });
  });

  it('is not confused by braces and quotes inside the answer', () => {
    const { cli } = layout();
    const answer = 'emit {"a":1} and \\"quoted\\" literally';
    const translation = new ZCodeAdapter(cli).translate({ output: prettyResult(answer), exitCode: 0, signal: null });
    assert.deepEqual(translation.finalText, { kind: 'text', value: answer });
  });
});

describe('11c · unmet preconditions are observed, not guessed at from stdout', () => {
  it('settles a never-started dispatch as unmetPreconditions + a named stopCause', async () => {
    const { taskId, record } = await dispatchAndSettle({ config: false }, {},
      { prompt: 'must not start', adapter: 'zcode' });

    assert.deepEqual(record.observation, {
      producedOutput: false,
      unmetPreconditions: [{ name: 'builtin-provider-config' }],
    });
    assert.deepEqual(record.resolution.finalText, { kind: 'empty' });
    assert.equal(record.resolution.stopCause, 'precondition-unmet');
    // No session was established, so there is no handle to hand out (§5.1).
    assert.equal(record.resolution.sessionRef, undefined);
    assert.equal(record.resolution.transcriptRef, undefined);

    const meta = readTaskMeta(taskId);
    assert.equal(meta?.pid, undefined, 'nothing may be spawned');
    assert.deepEqual(meta?.unmetPreconditions, ['builtin-provider-config']);
    // The old symptom must not appear anywhere: the run never started, so no
    // output was ever parsed and no parse error can be the story.
    assert.doesNotMatch(meta?.error ?? '', /JSON/);

    const report = readFileSync(join(getTaskDir(taskId), 'report.md'), 'utf8');
    assert.match(report, /precondition-unmet/);
    assert.match(report, /builtin-provider-config/);
    assert.match(report, /Not started:/);
  });
});

describe('11c · four empty-looking outcomes stay four facts', () => {
  it('exit 0 with empty stdout is no-output', async () => {
    const { record } = await dispatchAndSettle({}, { FAKE_ZCODE_BEHAVIOR: 'empty-stdout' },
      { prompt: 'say nothing' });
    assert.deepEqual(record.observation, { producedOutput: false, unmetPreconditions: [] });
    assert.equal(record.resolution.stopCause, 'no-output');
    assert.deepEqual(record.resolution.finalText, { kind: 'empty' });
  });

  it('a dead resume handle (exit 1 + empty stdout) is not an unmet precondition', async () => {
    const dead = 'sess_00000000-0000-0000-0000-000000000000';
    const { taskId, record } = await dispatchAndSettle({}, {
      FAKE_ZCODE_BEHAVIOR: 'fail-exit',
      FAKE_ZCODE_EXIT_CODE: '1',
      FAKE_ZCODE_STDERR: `Error: Session not found: ${dead} (traceId: t)\n`,
    }, { prompt: 'carry on', resumeSessionId: dead });

    assert.deepEqual(record.observation, { producedOutput: false, unmetPreconditions: [] });
    assert.match(record.resolution.stopCause ?? '', /process-exited-nonzero \(exit=1\)/);
    // The distinction 11b demanded: this run *did* start and *did* fail on its
    // handle, which is a different fact from "the precondition was unmet".
    assert.notEqual(record.resolution.stopCause, 'precondition-unmet');
    assert.equal(readTaskMeta(taskId)?.exitCode, 1);
    assert.equal(readTaskMeta(taskId)?.error, undefined);
  });

  it('a produced but empty answer is still produced output', async () => {
    const { record } = await dispatchAndSettle({}, {
      FAKE_ZCODE_BEHAVIOR: 'ok',
      FAKE_ZCODE_RESPONSE: '',
      FAKE_ZCODE_SESSION_ID: SESSION,
    }, { prompt: 'answer with nothing' });

    assert.deepEqual(record.observation, { producedOutput: true, unmetPreconditions: [] });
    assert.deepEqual(record.resolution.finalText, { kind: 'empty' });
    assert.equal(record.resolution.stopCause, undefined);
    assert.deepEqual(record.resolution.sessionRef, { provenance: 'zcode', handle: SESSION });
  });
});

describe('11c · the transcript pointer opens', () => {
  it('reads the run back through the app-server, answering its callback first', async () => {
    const { cli } = layout({ entry: FIXTURE_APPSERVER });
    const framesPath = join(scratch(), 'frames.jsonl');

    const readback = await readTranscript({ provenance: 'zcode', handle: SESSION }, {
      cliPath: cli,
      env: { FAKE_APPSERVER_RECORD: framesPath, FAKE_APPSERVER_TEXT: '11c transcript body' },
      timeoutMs: 15_000,
    });

    assert.ok(readback !== undefined);
    assert.equal(readback.messages.length, 2);
    // Only `type: 'text'` parts are reported; a `reasoning` part also has `text`.
    assert.deepEqual(readback.textParts, ['fake app-server: user turn', '11c transcript body']);
    assert.match(readback.text, /11c transcript body/);
    assert.doesNotMatch(readback.text, /reasoning that must not be reported/);

    const frames = readFileSync(framesPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // Activation must precede the snapshot: an inactive session is refused.
    const resumeAt = frames.findIndex((frame) => frame.method === 'session/resume');
    const messagesAt = frames.findIndex((frame) => frame.method === 'session/messages');
    assert.ok(resumeAt >= 0, 'resume was sent');
    assert.ok(messagesAt > resumeAt, 'the snapshot is requested only after activation');
    // The three-way handshake: the server asked, and the client answered with the
    // minimal strict body — without it the resume times out.
    assert.ok(frames.some((frame) => frame.id === 'srv-1'
      && JSON.stringify(frame.result) === JSON.stringify({ nativeSearchEnhancementsEnabled: false })));
    // The envelope is bare: the server's schema rejects a `jsonrpc` key.
    assert.ok(frames.every((frame) => !('jsonrpc' in frame)));
  });

  it('surfaces a refused session instead of returning an empty transcript', async () => {
    const { cli } = layout({ entry: FIXTURE_APPSERVER });
    await assert.rejects(
      readTranscript({ provenance: 'zcode', handle: 'sess_gone' }, {
        cliPath: cli,
        env: { FAKE_APPSERVER_RESUME_ERROR: '1' },
        timeoutMs: 15_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptUnavailableError);
        assert.match((error as Error).message, /Session not found: sess_gone/);
        return true;
      },
    );
  });

  it('has no route for a provenance this platform cannot read', async () => {
    assert.equal(await readTranscript({ provenance: 'claude', handle: 'x' }, {}), undefined);
  });

  it('prints the transcript for a human through `npm run transcript`', async () => {
    const appServer = layout({ entry: FIXTURE_APPSERVER });
    const { taskId, record } = await dispatchAndSettle({}, {
      FAKE_ZCODE_RESPONSE: 'cli answer',
      FAKE_ZCODE_SESSION_ID: SESSION,
    }, { prompt: 'say ok' });
    assert.equal(record.resolution.transcriptRef?.handle, SESSION);

    const { ZCODE_CLI_PATH: _unused, ...env } = process.env;
    const child = spawn(process.execPath, [
      '--import', import.meta.resolve('tsx'), new URL('../src/runner/read-transcript.ts', import.meta.url).pathname, taskId, '--cli', appServer.cli,
    ], {
      cwd: process.cwd(),
      env: { ...env, FAKE_APPSERVER_TEXT: '11c human-readable transcript' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    assert.equal(code, 0, stderr);
    assert.match(stdout, /11c human-readable transcript/);
    assert.match(stderr, /messages=2/);
    assert.match(stderr, new RegExp(`zcode:${SESSION}`));
  });
});
