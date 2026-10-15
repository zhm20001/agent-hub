import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscriptDocument, readTranscriptDocument, summarizeDocument, lastAssistantText } from '../src/runner/transcript-document.ts';

test('one document supplies messages, last answer and model info without losing repeated replies', () => {
  const raw = [
    { model: { modelId: 'm', providerId: 'p' }, request: { messages: [{ role: 'user', content: 'hello' }] }, response: { text: 'first' } },
    { response: { text: 'again' } }, { response: { text: 'again' } },
  ].map(value => JSON.stringify(value)).join('\n');
  const doc = parseTranscriptDocument(raw, 'zcode');
  assert.deepEqual(doc.modelInfo, { modelId: 'm', providerId: 'p' });
  assert.equal(doc.messages.length, 4);
  assert.equal(lastAssistantText(doc), 'again');
  assert.equal(summarizeDocument(doc).at(-1)?.fullText, lastAssistantText(doc));
});
test('ZCode final events exclude intermediate tool text and tolerate bad lines', () => {
  const raw = [
    JSON.stringify({ type: 'turn_started', payload: { input: 'question' } }),
    JSON.stringify({ type: 'model_complete', payload: { content: 'tool draft', stopReason: 'tool-calls' } }),
    'broken line',
    JSON.stringify({ type: 'turn_complete', payload: { response: 'final\n\nanswer' } }),
  ].join('\n');
  const doc = parseTranscriptDocument(raw, 'zcode');
  assert.deepEqual(doc.messages.map(m => m.text), ['question', 'final\n\nanswer']);
  assert.equal(summarizeDocument(doc).at(-1)?.fullText, lastAssistantText(doc));
});
test('Codex exec and rollout dialects are owned by Codex and never treated as ZCode', () => {
  const exec = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'exec answer' } });
  assert.equal(lastAssistantText(parseTranscriptDocument(exec, 'codex')), 'exec answer');
  assert.equal(lastAssistantText(parseTranscriptDocument(exec, 'zcode')), null);
  const rollout = [
    { type: 'session_meta', payload: { model: 'codex-model', model_provider: 'openai' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } },
    { type: 'response_item', payload: { type: 'reasoning', content: [{ text: 'secret thinking' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'rollout answer' }] } },
  ].map(value => JSON.stringify(value)).join('\n');
  const doc = parseTranscriptDocument(rollout, 'codex');
  assert.deepEqual(doc.messages.map(m => m.text), ['question', 'rollout answer']);
  assert.deepEqual(doc.modelInfo, { modelId: 'codex-model', providerId: 'openai' });
});
test('pretty message documents preserve reasoning exclusion and show the most recent turns', () => {
  const doc = parseTranscriptDocument(JSON.stringify({ messages: [
    { role: 'user', text: 'first' },
    { info: { role: 'agent' }, parts: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }] },
    { role: 'user', content: 'last question' },
  ] }, null, 2), 'zcode');
  assert.equal(lastAssistantText(doc), 'visible');
  assert.deepEqual(summarizeDocument(doc, { maxTurns: 2 }).map(t => t.fullText), ['visible', 'last question']);
});
test('file cache reuses a document and invalidates on growth or atomic replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-transcript-')); const path = join(root, 'transcript.jsonl');
  try {
    writeFileSync(path, JSON.stringify({ response: { text: 'first' } }));
    const first = readTranscriptDocument(path, 'zcode');
    assert.equal(first, readTranscriptDocument(path, 'zcode'));
    writeFileSync(path, JSON.stringify({ response: { text: 'longer second' } }));
    assert.equal(lastAssistantText(readTranscriptDocument(path, 'zcode')!), 'longer second');
    writeFileSync(join(root, 'next'), JSON.stringify({ response: { text: 'third answer!' } })); renameSync(join(root, 'next'), path);
    assert.equal(lastAssistantText(readTranscriptDocument(path, 'zcode')!), 'third answer!');
    assert.equal(lastAssistantText(readTranscriptDocument(path, 'bash')!), null);
    assert.equal(readTranscriptDocument(join(root, 'missing'), 'zcode'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
