import { parseZcodeTranscript } from '../src/adapters/transcript-format.ts';
import { summarizeDocument } from '../src/shared/transcript.ts';
/**
 * Board UX helpers: Shanghai time, Built-in log noise filter, light transcript summary.
 * Fixtures only — no live CLI.
 *
 * Run with: node --import tsx --test tests/board-ux.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_NOISE_RE,
  filterLogNoise,
  formatShanghaiAbsolute,
} from '../src/web/lib/board-ux.ts';

describe('formatShanghaiAbsolute', () => {
  it('formats a known UTC instant as Asia/Shanghai CST', () => {
    // 2026-10-11T13:08:05.000Z → 21:08:05 CST (+8)
    const ms = Date.parse('2026-10-11T13:08:05.000Z');
    const s = formatShanghaiAbsolute(ms);
    assert.match(s, /2026-10-11 21:08:05 CST/);
  });

  it('returns em-dash for invalid', () => {
    assert.equal(formatShanghaiAbsolute(0), '—');
    assert.equal(formatShanghaiAbsolute(Number.NaN), '—');
  });
});

describe('filterLogNoise', () => {
  it('drops ZCode Built-in missing / skipped lines and counts them', () => {
    const raw = [
      'hello',
      'ZCode Built-in missing',
      'useful output',
      'ZCode Built-in skipped (not-due)',
      'ZCode Built-in skipped (not-due)',
      'done',
      '',
    ].join('\n');
    const { text, hidden } = filterLogNoise(raw);
    assert.equal(hidden, 3);
    assert.equal(text, ['hello', 'useful output', 'done', ''].join('\n'));
    assert.equal(BUILTIN_NOISE_RE.test('ZCode Built-in missing'), true);
  });

  it('keeps everything when no noise', () => {
    const raw = 'a\nb\n';
    assert.deepEqual(filterLogNoise(raw), { text: 'a\nb\n', hidden: 0 });
  });
});

describe('normalized conversation summary', () => {
  it('summarizes transcript.jsonl turn_started / turn_complete', () => {
    const jsonl = [
      JSON.stringify({ type: 'turn_started', payload: { input: 'Please review the diff' } }),
      JSON.stringify({ type: 'model_complete', payload: { content: 'mid', stopReason: 'tool-calls' } }),
      JSON.stringify({ type: 'turn_complete', payload: { response: 'Looks good overall.' } }),
    ].join('\n');
    const turns = summarizeDocument(parseZcodeTranscript(jsonl));
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.match(turns[0].text, /Please review/);
    assert.equal(turns[1].role, 'assistant');
    assert.match(turns[1].text, /Looks good/);
    assert.equal(turns[1].fullText, 'Looks good overall.');
  });

  it('summarizes model-io JSONL response.text with first user prompt', () => {
    const line = JSON.stringify({
      model: { modelId: 'step-5-preview', providerId: 'new-provider-2' },
      request: {
        messages: [
          { role: 'user', content: '<system-reminder>\nignore' },
          { role: 'user', content: 'Reply with ok' },
          { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
        ],
      },
      response: { text: 'ok' },
    });
    const turns = summarizeDocument(parseZcodeTranscript(line));
    assert.ok(turns.some((t) => t.role === 'user' && t.text.includes('Reply with ok')));
    assert.ok(turns.some((t) => t.role === 'assistant' && t.text === 'ok'));
  });

  it('summarizes a messages array document', () => {
    const doc = JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'hello there' }] },
    ]);
    const turns = summarizeDocument(parseZcodeTranscript(doc));
    assert.deepEqual(
      turns.map((t) => t.role),
      ['user', 'assistant'],
    );
  });
});
