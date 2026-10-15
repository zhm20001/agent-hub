#!/usr/bin/env node
'use strict'
/**
 * Scriptable fake of the Codex CLI `exec --json` surface for behavior tests.
 * Behavior is selected with FAKE_CODEX_BEHAVIOR (`ok` by default):
 * - `ok`              JSONL: thread.started + agent_message + turn.completed; exit 0
 * - `fail-exit`       write FAKE_CODEX_STDERR to stderr and exit FAKE_CODEX_EXIT_CODE (default 3)
 * - `bad-json`        print a non-JSON line and exit 0
 * - `missing-session` JSONL without thread.started (agent_message + turn.completed); exit 0
 * - `empty-stdout`    print nothing and exit 0
 * - `turn-failed`     thread.started + turn.failed; exit 0
 * - `reconnect-ok`    transient error lines then agent_message + turn.completed; exit 0
 * FAKE_CODEX_DELAY_MS delays the behavior to keep a run in flight.
 * FAKE_CODEX_RESPONSE overrides the agent_message text.
 * FAKE_CODEX_THREAD_ID overrides the minted thread_id for fresh dispatches.
 */

const args = process.argv.slice(2)

function flagValue(name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

const behavior = process.env.FAKE_CODEX_BEHAVIOR ?? 'ok'
const delay = Number(process.env.FAKE_CODEX_DELAY_MS ?? '0')
const resumeAt = args.indexOf('resume')
const isResume = resumeAt >= 0
const resumeSessionId = isResume
  ? (flagValue('--json') /* after resume, --json then session id */
      ? args[args.indexOf('--json', resumeAt) + 1]
      : undefined)
  : undefined
const threadId = resumeSessionId
  ?? process.env.FAKE_CODEX_THREAD_ID
  ?? '01a13e75-d25a-70f3-b030-53c79a3b0ff5'

setTimeout(() => {
  if (behavior === 'fail-exit') {
    process.stderr.write(process.env.FAKE_CODEX_STDERR ?? 'boom: quota exhausted\n')
    process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE ?? '3'))
  }
  if (behavior === 'bad-json') {
    if (process.env.FAKE_CODEX_STDERR) process.stderr.write(process.env.FAKE_CODEX_STDERR)
    process.stdout.write('not json at all\n')
    process.exit(0)
  }
  if (behavior === 'empty-stdout') {
    process.exit(0)
  }

  const response = process.env.FAKE_CODEX_RESPONSE ?? 'pong'
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 64,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
  }

  const lines = []

  if (behavior === 'missing-session') {
    lines.push(JSON.stringify({ type: 'turn.started' }))
    lines.push(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: response },
    }))
    lines.push(JSON.stringify({ type: 'turn.completed', usage }))
  } else if (behavior === 'turn-failed') {
    lines.push(JSON.stringify({ type: 'thread.started', thread_id: threadId }))
    lines.push(JSON.stringify({ type: 'turn.started' }))
    lines.push(JSON.stringify({
      type: 'turn.failed',
      error: { message: '{"detail":"model not supported"}' },
    }))
  } else if (behavior === 'reconnect-ok') {
    lines.push(JSON.stringify({ type: 'thread.started', thread_id: threadId }))
    lines.push(JSON.stringify({ type: 'turn.started' }))
    lines.push(JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (request timed out)' }))
    lines.push(JSON.stringify({ type: 'error', message: 'Reconnecting... 3/5 (request timed out)' }))
    lines.push(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'error',
        message: 'Falling back from WebSockets to HTTPS transport. request timed out',
      },
    }))
    lines.push(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: response },
    }))
    lines.push(JSON.stringify({ type: 'turn.completed', usage }))
  } else {
    // ok (default) — matches live probe shapes
    lines.push(JSON.stringify({ type: 'thread.started', thread_id: threadId }))
    lines.push(JSON.stringify({ type: 'turn.started' }))
    lines.push(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: response },
    }))
    lines.push(JSON.stringify({ type: 'turn.completed', usage }))
  }

  process.stdout.write(lines.join('\n') + '\n')
  process.exit(0)
}, delay)
