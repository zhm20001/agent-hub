/**
 * TTL default + progress probe + extend-once watchdog decisions.
 * Fixtures only — no live processes required for most cases.
 *
 * Run with: node --import tsx --test tests/timeout-policy.spec.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIMEOUT_ENV,
  DEFAULT_TIMEOUT_SEC,
  decideWatchdogAction,
  probeTaskProgress,
  resolveDefaultTimeout,
  resolveExtendSeconds,
} from '../src/runner/timeout-policy.ts';
import {
  extractModelInfoFromTranscriptFile,
  formatModelLabel,
  resolveModelInfo,
} from '../src/runner/model-info.ts';

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'ttl-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe('resolveDefaultTimeout', () => {
  it('defaults to 7200', () => {
    assert.equal(resolveDefaultTimeout({}), DEFAULT_TIMEOUT_SEC);
    assert.equal(DEFAULT_TIMEOUT_SEC, 7200);
  });

  it('reads AGENT_HUB_DEFAULT_TIMEOUT', () => {
    assert.equal(resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: '9000' }), 9000);
  });

  it('rejects tiny/invalid values', () => {
    assert.equal(resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: '30' }), DEFAULT_TIMEOUT_SEC);
    assert.equal(resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: 'nope' }), DEFAULT_TIMEOUT_SEC);
  });
});

describe('probeTaskProgress + decideWatchdogAction', () => {
  it('waits when under deadline', () => {
    const dir = scratch();
    const d = decideWatchdogAction({
      elapsedMs: 1000,
      timeoutSec: 7200,
      taskDir: dir,
      pid: process.pid,
    });
    assert.equal(d.action, 'wait');
  });

  it('extends once when process alive and raw.log recently touched', () => {
    const dir = scratch();
    const log = join(dir, 'raw.log');
    writeFileSync(log, 'working\n');
    const now = Date.now();
    utimesSync(log, now / 1000, now / 1000);

    const d = decideWatchdogAction({
      elapsedMs: 7201_000,
      timeoutSec: 7200,
      timeoutExtended: false,
      pid: process.pid, // this test process is alive
      taskDir: dir,
      now,
    });
    assert.equal(d.action, 'extend');
    if (d.action === 'extend') {
      assert.ok(d.extendSec >= 600);
    }
  });

  it('kills when already extended', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'raw.log'), 'x\n');
    const d = decideWatchdogAction({
      elapsedMs: 20_000_000,
      timeoutSec: 7200,
      timeoutExtended: true,
      pid: process.pid,
      taskDir: dir,
      now: Date.now(),
    });
    assert.equal(d.action, 'kill');
  });

  it('kills when process not alive', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'raw.log'), 'x\n');
    // PID 2^31-2 is extremely unlikely to exist
    const d = decideWatchdogAction({
      elapsedMs: 20_000_000,
      timeoutSec: 7200,
      timeoutExtended: false,
      pid: 2147483646,
      taskDir: dir,
      now: Date.now(),
    });
    assert.equal(d.action, 'kill');
  });

  it('probe reports recentProgress from raw.log mtime', () => {
    const dir = scratch();
    const log = join(dir, 'raw.log');
    writeFileSync(log, 'x');
    const now = Date.now();
    utimesSync(log, now / 1000, now / 1000);
    const p = probeTaskProgress(process.pid, { taskDir: dir, now, freshMs: 60_000 });
    assert.equal(p.alive, true);
    assert.equal(p.recentProgress, true);
  });
});

describe('resolveExtendSeconds', () => {
  it('defaults to at least task timeout', () => {
    assert.equal(resolveExtendSeconds(7200, {}), 7200);
    assert.equal(resolveExtendSeconds(100, {}), 600);
  });
});

describe('model-info', () => {
  it('reads modelId/providerId from model-io JSONL', () => {
    const dir = scratch('model-');
    const file = join(dir, 'model-io.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({ model: { modelId: 'step-5-preview', providerId: 'new-provider-2' }, response: { text: 'ok' } })}\n`,
    );
    const info = extractModelInfoFromTranscriptFile(file);
    assert.deepEqual(info, { modelId: 'step-5-preview', providerId: 'new-provider-2' });
    assert.equal(formatModelLabel(info), 'new-provider-2/step-5-preview');
  });

  it('falls back to scraping raw output', () => {
    const info = resolveModelInfo({
      output: 'noise\n{"modelId":"m1","providerId":"p1"}\n',
    });
    assert.deepEqual(info, { modelId: 'm1', providerId: 'p1' });
  });
});
