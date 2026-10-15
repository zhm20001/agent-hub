/**
 * Unit tests for mechanical harvest (last-turn truncate + extract).
 * Fixtures only — no live CLI / no ZCode tokens.
 *
 * Run with: node --import tsx --test tests/harvest.spec.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAST_TURN_CAP,
  DEFAULT_LAST_TURN_CAP,
  LAST_TURN_CAP_ENV,
  resolveLastTurnCap,
  extractLastAssistantMessage,
  harvestTask,
  repairTaskTranscript,
  truncateText,
} from '../src/runner/harvest.ts';
import { ZCodeAdapter } from '../src/adapters/zcode.ts';
import { readRunRecord, type RunRecord } from '../src/runner/settlement.ts';
import { getTaskDir } from '../src/runner/detached.ts';

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harvest-'));
  scratchDirs.push(dir);
  return dir;
}

describe('truncateText', () => {
  it('leaves short text alone', () => {
    const r = truncateText('hello', 10);
    assert.deepEqual(r, { text: 'hello', truncated: false, fullLength: 5, cap: 10 });
  });

  it('truncates with ellipsis and reports full length', () => {
    const r = truncateText('abcdefghij', 5);
    assert.equal(r.truncated, true);
    assert.equal(r.fullLength, 10);
    assert.equal(r.cap, 5);
    assert.equal(r.text.endsWith('…'), true);
    assert.ok(r.text.length <= 5);
  });

  it('defaults to LAST_TURN_CAP', () => {
    const long = 'x'.repeat(LAST_TURN_CAP + 50);
    const r = truncateText(long);
    assert.equal(r.truncated, true);
    assert.equal(r.cap, LAST_TURN_CAP);
    assert.equal(r.fullLength, LAST_TURN_CAP + 50);
  });
});

describe('resolveLastTurnCap', () => {
  it('defaults to DEFAULT_LAST_TURN_CAP (8000)', () => {
    assert.equal(resolveLastTurnCap({}), DEFAULT_LAST_TURN_CAP);
    assert.equal(DEFAULT_LAST_TURN_CAP, 8000);
  });

  it('reads AGENT_HUB_LAST_TURN_CAP when valid', () => {
    assert.equal(resolveLastTurnCap({ [LAST_TURN_CAP_ENV]: '12000' }), 12000);
  });

  it('falls back on invalid values', () => {
    assert.equal(resolveLastTurnCap({ [LAST_TURN_CAP_ENV]: '0' }), DEFAULT_LAST_TURN_CAP);
    assert.equal(resolveLastTurnCap({ [LAST_TURN_CAP_ENV]: '-1' }), DEFAULT_LAST_TURN_CAP);
    assert.equal(resolveLastTurnCap({ [LAST_TURN_CAP_ENV]: 'nope' }), DEFAULT_LAST_TURN_CAP);
  });
});

describe('extractLastAssistantMessage', () => {
  it('takes the last assistant text parts from a messages array', () => {
    const text = extractLastAssistantMessage([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'ignore me' },
          { type: 'text', text: 'first reply' },
        ],
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'final reply' }],
      },
    ]);
    assert.equal(text, 'final reply');
  });

  it('reads turn_complete.response from transcript.jsonl', () => {
    const jsonl = [
      JSON.stringify({ type: 'model_complete', payload: { content: 'mid', stopReason: 'tool-calls' } }),
      JSON.stringify({ type: 'model_complete', payload: { content: 'almost', stopReason: 'stop' } }),
      JSON.stringify({ type: 'turn_complete', payload: { response: 'true last turn' } }),
    ].join('\n');
    assert.equal(extractLastAssistantMessage(jsonl), 'true last turn');
  });

  it('reads response.text from a model-io JSONL line', () => {
    const line = JSON.stringify({
      type: 'model-io',
      response: { text: '11c-loop-ok' },
      request: { body: {} },
    });
    assert.equal(extractLastAssistantMessage(line), '11c-loop-ok');
  });

  it('returns null for unrecognizable input', () => {
    assert.equal(extractLastAssistantMessage(null), null);
    assert.equal(extractLastAssistantMessage('not json'), null);
    assert.equal(extractLastAssistantMessage({ foo: 1 }), null);
  });
});

describe('adapter transcript lookup + harvestTask', () => {
  it('resolves model-io-*.jsonl under ~/.zcode/cli/rollout', () => {
    const home = scratch();
    const handle = 'sess_harvest-test-0001';
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    const path = join(rollout, `model-io-${handle}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ response: { text: 'from-disk' } })}\n`);

    assert.equal(
      new ZCodeAdapter().locateTranscript({ transcriptRef: { provenance: 'zcode', handle }, home })?.path,
      path,
    );
  });

  it('prefers on-disk transcript text over finalText', () => {
    const home = scratch();
    const handle = 'sess_harvest-test-0002';
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    writeFileSync(
      join(rollout, `model-io-${handle}.jsonl`),
      `${JSON.stringify({ response: { text: 'disk-last-turn' } })}\n`,
    );

    const record: RunRecord = {
      taskId: 'task-harvest-1',
      resolution: {
        taskId: 'task-harvest-1',
        finalText: { kind: 'text', value: 'finalText-fallback' },
        transcriptRef: { provenance: 'zcode', handle },
      },
      observation: { producedOutput: true, unmetPreconditions: [] },
    };

    const view = harvestTask('task-harvest-1', record, { home, cap: 2000 });
    assert.equal(view.lastTurn?.text, 'disk-last-turn');
    assert.equal(view.lastTurn?.fullText, 'disk-last-turn');
    assert.equal(view.lastTurn?.source, 'transcript');
    assert.ok(view.transcriptPath?.endsWith(`model-io-${handle}.jsonl`));
  });

  it('falls back to finalText when no transcript file exists', () => {
    const home = scratch();
    const record: RunRecord = {
      taskId: 'task-harvest-2',
      resolution: {
        taskId: 'task-harvest-2',
        finalText: { kind: 'text', value: 'only-final' },
        transcriptRef: { provenance: 'zcode', handle: 'sess_missing' },
      },
      observation: { producedOutput: true, unmetPreconditions: [] },
    };

    const view = harvestTask('task-harvest-2', record, { home });
    assert.equal(view.transcriptPath, null);
    assert.equal(view.lastTurn?.text, 'only-final');
    assert.equal(view.lastTurn?.fullText, 'only-final');
    assert.equal(view.lastTurn?.source, 'finalText');
  });

  it('truncates long last-turn text at the configured cap', () => {
    const home = scratch();
    const record: RunRecord = {
      taskId: 'task-harvest-3',
      resolution: {
        taskId: 'task-harvest-3',
        finalText: { kind: 'text', value: 'Z'.repeat(100) },
      },
      observation: { producedOutput: true, unmetPreconditions: [] },
    };

    const view = harvestTask('task-harvest-3', record, { home, cap: 20 });
    assert.equal(view.lastTurn?.truncated, true);
    assert.equal(view.lastTurn?.fullLength, 100);
    assert.equal(view.lastTurn?.cap, 20);
    assert.ok((view.lastTurn?.text.length ?? 0) <= 20);
    assert.equal(view.lastTurn?.fullText, 'Z'.repeat(100));
  });
});

describe('ZCodeAdapter.locateTranscript', () => {
  it('resolves by explicit sessionId', () => {
    const home = scratch();
    const handle = 'sess_discover-by-id-0001';
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    const path = join(rollout, `model-io-${handle}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ response: { text: 'by-id' } })}\n`);

    const found = new ZCodeAdapter().locateTranscript({ home, sessionId: handle });
    assert.equal(found?.path, path);
    assert.equal(found?.transcriptRef.handle, handle);
    assert.equal(found?.via, 'sessionId');
  });

  it('picks model-io by mtime proximity to task window', () => {
    const home = scratch();
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });

    const start = Date.now() - 60_000;
    const end = Date.now();

    const wrong = join(rollout, 'model-io-sess_discover-old-0002.jsonl');
    writeFileSync(wrong, `${JSON.stringify({ response: { text: 'old' } })}\n`);
    // Force an old mtime (2 hours before start)
    utimesSync(wrong, new Date(start - 2 * 3600_000), new Date(start - 2 * 3600_000));

    const handle = 'sess_discover-near-0002';
    const near = join(rollout, `model-io-${handle}.jsonl`);
    writeFileSync(near, `${JSON.stringify({ response: { text: 'near' } })}\n`);
    utimesSync(near, new Date(end - 5_000), new Date(end - 5_000));

    const found = new ZCodeAdapter().locateTranscript({
      home,
      interrupted: { startTimeMs: start, endTimeMs: end },
    });
    assert.equal(found?.transcriptRef.handle, handle);
    assert.equal(found?.path, near);
    assert.equal(found?.via, 'time-proximity');
  });

  it('returns null when nothing is in the time window', () => {
    const home = scratch();
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    const path = join(rollout, 'model-io-sess_discover-far-0003.jsonl');
    writeFileSync(path, '{}\n');
    const ancient = Date.now() - 10 * 24 * 3600_000;
    utimesSync(path, new Date(ancient), new Date(ancient));

    const found = new ZCodeAdapter().locateTranscript({
      home,
      interrupted: { startTimeMs: Date.now() - 60_000, endTimeMs: Date.now() },
    });
    assert.equal(found, null);
  });
});

describe('transcript ownership', () => {
  function fixture(adapter: string, status = 'TIMEOUT_KILLED', sessionId?: string) {
    const home = scratch();
    const handle = 'sess_unrelated-zcode';
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    const path = join(rollout, `model-io-${handle}.jsonl`);
    writeFileSync(path, JSON.stringify({ response: { text: 'another agents answer' } }));
    const taskId = `task-ownership-${adapter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskDir = getTaskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    scratchDirs.push(taskDir);
    writeFileSync(join(taskDir, 'meta.json'), JSON.stringify({
      taskId, adapter, status, sessionId,
      startTime: Date.now() - 60_000, endTime: Date.now(),
    }));
    const record: RunRecord = {
      taskId,
      resolution: { taskId, finalText: { kind: 'text', value: 'own answer' } },
      observation: { producedOutput: true, unmetPreconditions: [] },
    };
    return { home, taskId, record, path, handle };
  }

  for (const adapter of ['bash', 'shell', 'codex', 'unknown']) {
    it(`${adapter} interrupted task never adopts a nearby ZCode transcript`, () => {
      const { home, taskId, record } = fixture(adapter);
      const repaired = repairTaskTranscript(taskId, record, { home });
      assert.equal(repaired.transcriptPath, null);
      assert.deepEqual(repaired.record, record);
      const view = harvestTask(taskId, record, { home });
      assert.equal(view.transcriptPath, null);
      assert.equal(view.lastTurn?.text, 'own answer');
    });
  }

  it('ZCode interrupted task can still discover and persist its transcript', () => {
    const { home, taskId, record, path, handle } = fixture('zcode');
    const repaired = repairTaskTranscript(taskId, record, { home });
    assert.equal(repaired.transcriptPath, path);
    assert.deepEqual(repaired.record?.resolution.transcriptRef, { provenance: 'zcode', handle });
    assert.deepEqual(repaired.record?.resolution.sessionRef, { provenance: 'zcode', handle });
    assert.equal(repaired.via, 'time-proximity');
    assert.equal(readRunRecord(getTaskDir(taskId))?.transcriptPath, path);
  });

  it('completed ZCode task without a handle never guesses from timestamps', () => {
    const { home, taskId, record } = fixture('zcode', 'COMPLETED');
    assert.equal(repairTaskTranscript(taskId, record, { home }).transcriptPath, null);
  });

  it('a missing explicit ZCode session never falls back to another session', () => {
    const { home, taskId, record } = fixture('zcode', 'KILLED', 'sess_missing');
    assert.equal(repairTaskTranscript(taskId, record, { home }).transcriptPath, null);
  });

  it('foreign refs cannot redirect discovery into ZCode storage', () => {
    const { home, taskId, record, handle } = fixture('codex');
    const foreignRecord = {
      ...record, resolution: { ...record.resolution, transcriptRef: { provenance: 'zcode', handle } },
    };
    assert.equal(harvestTask(taskId, foreignRecord, { home }).transcriptPath, null);
  });

  it('a Codex ref without metadata never falls back to a matching ZCode session', () => {
    const { home, record, handle } = fixture('zcode');
    const foreignRecord = {
      ...record, resolution: { ...record.resolution, transcriptRef: { provenance: 'codex', handle } },
    };
    assert.equal(harvestTask('missing-task-metadata', foreignRecord, { home }).transcriptPath, null);
  });
});
