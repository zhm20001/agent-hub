#!/usr/bin/env node
'use strict'
/**
 * Stand-in for the agent's `app-server --stdio` surface, for Face B readback
 * tests. It reproduces the three measured protocol facts that the readback
 * client depends on (see 11b §8.1):
 *   1. the envelope is bare — no `jsonrpc` key;
 *   2. `session/messages` refuses a session that has not been resumed;
 *   3. the server makes a request of its own
 *      (`session/requestRuntimePreferences`) and stalls the resume until the
 *      client answers it.
 *
 * Every frame the client sends is appended to `FAKE_APPSERVER_RECORD` (JSONL) so
 * a test can assert the handshake actually happened.
 *
 * Env switches:
 *   FAKE_APPSERVER_RECORD=<path>        record client frames here
 *   FAKE_APPSERVER_TEXT=<text>          body of the assistant text part
 *   FAKE_APPSERVER_RESUME_ERROR=1       refuse `session/resume`
 */

const fs = require('node:fs')

const RECORD = process.env.FAKE_APPSERVER_RECORD
const record = (frame) => {
  if (RECORD) fs.appendFileSync(RECORD, JSON.stringify(frame) + '\n')
}
const send = (frame) => { process.stdout.write(JSON.stringify(frame) + '\n') }

const CALLBACK_ID = 'srv-1'
let buffer = ''
let resumed = false
let awaitingCallbackFor = null

function messages() {
  return [
    {
      info: { role: 'user' },
      parts: [{ type: 'text', text: 'fake app-server: user turn' }],
    },
    {
      info: { role: 'assistant' },
      parts: [
        { type: 'step-start' },
        // A reasoning part also carries `text`, so the readback must filter by type.
        { type: 'reasoning', text: 'fake app-server: reasoning that must not be reported as the answer' },
        { type: 'text', text: process.env.FAKE_APPSERVER_TEXT ?? 'fake app-server: assistant answer' },
      ],
    },
  ]
}

function handleResume(frame) {
  if (process.env.FAKE_APPSERVER_RESUME_ERROR === '1') {
    send({ id: frame.id, error: { code: -32602, message: `Session not found: ${frame.params.sessionId}` } })
    return
  }
  // Ask the client first; the resume answer waits for that answer.
  send({
    id: CALLBACK_ID,
    method: 'session/requestRuntimePreferences',
    params: { sessionId: frame.params.sessionId, scope: 'runtime-materialization' },
  })
  awaitingCallbackFor = frame
}

function finishResume(frame) {
  resumed = true
  send({ id: frame.id, result: { session: { sessionId: frame.params.sessionId }, messages: messages() } })
}

function handleMessages(frame) {
  if (!resumed) {
    send({ id: frame.id, error: { code: -32004, message: `Session is not active: ${frame.params.sessionId}` } })
    return
  }
  send({ id: frame.id, result: { messages: messages() } })
}

function handle(line) {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  record(frame)

  // The client's answer to our own request.
  if (frame.id === CALLBACK_ID) {
    const waiting = awaitingCallbackFor
    awaitingCallbackFor = null
    if (waiting) finishResume(waiting)
    return
  }
  if (frame.method === 'session/resume') { handleResume(frame); return }
  if (frame.method === 'session/messages') { handleMessages(frame); return }
  send({ id: frame.id, error: { code: -32601, message: `unknown method ${frame.method}` } })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) handle(line)
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
