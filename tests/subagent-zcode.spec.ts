/**
 * ⚠️ DEPRECATED — Face A (legacy). Quarantined; NOT in `npm test`.
 * Live path = Face B swarm (tests/faced-*.spec.ts, harvest, task-roots,
 * concurrency-and-transcript). See DEMO.md / ADR-0002 / src/_legacy_face_a/.
 * Do not revive Face A assertions here; prefer Face B fixtures.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DatabaseSync } from 'node:sqlite'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { JobId, type JobView } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ZcodeSessionId } from '../src/brand.ts'
import {
  asZcodeHeadlessOutput,
  buildZcodeCommand,
  joinPromptText,
  parseZcodeHeadlessOutput,
  ZcodeOutputError,
} from '../src/_legacy_face_a/cli.ts'
import { assertInsideTaskRoots, defaultBuiltinProviderConfigPath, resolveConfig, type CompletionDelivery, type Config, type ZcodeMode } from '../src/config.ts'
import { ZcodeJobIndex, type ZcodeJobRecord } from '../src/_legacy_face_a/job-index.ts'
import { defaultZcodeDbPath, BillingSelfCheckError, createBillingGuard } from '../src/_legacy_face_a/billing.ts'
import { defaultZcodeLogDir, zcodeLogTailSource } from '../src/_legacy_face_a/log-tail.ts'
import { startZcodeRun, subprocessSources, disposeZcodeChild, ZcodeProcessFailure } from '../src/_legacy_face_a/run.ts'
import { settleForegroundRun, settleZcodeJob } from '../src/tools.ts'
import { noticeSummary, noticeText } from '../src/_legacy_face_a/notice.ts'
import * as zcode from '../src/index.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-zcode.cjs')

const FAKE_ENV_KEYS = [
  'FAKE_ZCODE_BEHAVIOR',
  'FAKE_ZCODE_DELAY_MS',
  'FAKE_ZCODE_RESPONSE',
  'FAKE_ZCODE_SESSION_ID',
  'FAKE_ZCODE_STDERR',
  'FAKE_ZCODE_EXIT_CODE',
] as const

/** The fake parent session id every dispatch runs on behalf of. */
const PARENT_ID = brandString<SessionId>('parent')

function fakeBehavior(behavior: string, extra: Record<string, string> = {}): void {
  process.env.FAKE_ZCODE_BEHAVIOR = behavior
  for (const [key, value] of Object.entries(extra)) process.env[key] = value
}

function clearFakeEnv(): void {
  for (const key of FAKE_ENV_KEYS) {
    // The keys come from the fixture's runtime list; assigning `undefined`
    // would leak the string "undefined" into the child env.
    // oxlint-disable-next-line typescript/no-dynamic-delete
    delete process.env[key]
  }
}

/** A directory a test may fill with scratch files. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-subagent-zcode-'))
}

const GOOD_PROVIDER_ID = 'account:bigmodel-start-plan'

/** The billing database every composed test dispatches against: fresh, matching. */
const billingDb = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-subagent-zcode-billing-'))
  const path = join(dir, 'db.sqlite')
  writeBillingDb(path, GOOD_PROVIDER_ID)
  return path
})()

/** Create a fake zcode billing database with one newest-row provider id. */
function writeBillingDb(path: string, providerId: string | undefined, withTable = true): void {
  const db = new DatabaseSync(path)
  if (withTable) {
    db.exec('CREATE TABLE IF NOT EXISTS model_usage (id INTEGER PRIMARY KEY, provider_id TEXT)')
    if (providerId !== undefined) {
      db.prepare('INSERT INTO model_usage (provider_id) VALUES (?)').run(providerId)
    }
  }
  db.close()
}

/** A chmod-0755 regular file standing in for the CLI entry. */
function writeEntry(dir: string): string {
  const entry = join(dir, 'zcode-entry')
  writeFileSync(entry, '#!/bin/sh\nexit 0\n')
  chmodSync(entry, 0o755)
  return entry
}

/**
 * Lay out the App packaging shape: the CLI entry under `<root>/glm/` and the
 * builtin provider config under `<root>/config/provider/`.
 */
function writeAppLayout(root: string): { entry: string; config: string } {
  const glm = join(root, 'glm')
  const provider = join(root, 'config', 'provider')
  mkdirSync(glm, { recursive: true })
  mkdirSync(provider, { recursive: true })
  const entry = join(glm, 'zcode-entry')
  writeFileSync(entry, '#!/bin/sh\nexit 0\n')
  chmodSync(entry, 0o755)
  const config = join(provider, 'zcode-builtin.json')
  writeFileSync(config, '{}\n')
  return { entry, config }
}

function entryConfig(entry: string, rest: Partial<Config> = {}): Config {
  return { zcodeCliPath: entry, ...rest }
}

describe('resolveConfig', () => {
  it('fails loud without an absolute executable CLI entry', () => {
    expect(() => resolveConfig({ zcodeCliPath: 'zcode' })).toThrow('must be an absolute path')
    expect(() => resolveConfig({ zcodeCliPath: join(tmpdir(), 'dsh-subagent-zcode-missing-entry') }))
      .toThrow('not an executable file')
  })

  it('accepts an executable entry and fills every default', () => {
    const dir = scratch()
    try {
      const entry = writeEntry(dir)
      const resolved = resolveConfig(entryConfig(entry))
      expect(resolved).toEqual({
        zcodeCliPath: entry,
        builtinProviderConfigPath: undefined,
        taskRoots: [process.cwd()],
        maxConcurrent: 2,
        defaultMode: 'edit',
        disallowedTools: [],
        completionDelivery: 'followup',
        maxConsecutiveWakes: undefined,
        expectedProviderIds: [
          'account:bigmodel-start-plan',
          'account:bigmodel-individual-coding-plan',
          'new-provider',
        ],
        zcodeLogDir: defaultZcodeLogDir(),
        zcodeDbPath: defaultZcodeDbPath(),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives the App-layout builtin provider config and injects it only when it exists', () => {
    const app = scratch()
    try {
      const { entry, config } = writeAppLayout(app)
      expect(defaultBuiltinProviderConfigPath(entry)).toBe(config)
      expect(resolveConfig(entryConfig(entry)).builtinProviderConfigPath).toBe(config)
      // A layout whose own script-relative lookup succeeds forwards nothing.
      const plain = scratch()
      try {
        expect(resolveConfig(entryConfig(writeEntry(plain))).builtinProviderConfigPath).toBeUndefined()
      } finally {
        rmSync(plain, { recursive: true, force: true })
      }
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })

  it('accepts an explicit builtin provider config path and rejects an unreadable one', () => {
    const dir = scratch()
    try {
      const entry = writeEntry(dir)
      const explicit = join(dir, 'explicit-builtin.json')
      writeFileSync(explicit, '{}\n')
      expect(resolveConfig(entryConfig(entry, { builtinProviderConfigPath: explicit })).builtinProviderConfigPath)
        .toBe(explicit)
      expect(() => resolveConfig(entryConfig(entry, { builtinProviderConfigPath: join(dir, 'missing.json') })))
        .toThrow('builtinProviderConfigPath is not a readable file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty whitelist and validates every root', () => {
    const dir = scratch()
    try {
      const entry = writeEntry(dir)
      expect(() => resolveConfig(entryConfig(entry, { taskRoots: [] }))).toThrow('must not be empty')
      expect(() => resolveConfig(entryConfig(entry, { taskRoots: [join(dir, 'missing')] })))
        .toThrow('not an accessible directory')
      const nested = join(dir, 'workspace')
      mkdirSync(nested)
      const resolved = resolveConfig(entryConfig(entry, { taskRoots: [nested] }))
      expect(resolved.taskRoots).toEqual([nested])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects out-of-range numbers, bogus enums, and an empty expected provider', () => {
    const dir = scratch()
    try {
      const entry = writeEntry(dir)
      for (const maxConcurrent of [0, -1, 1.5, Number.NaN]) {
        expect(() => resolveConfig(entryConfig(entry, { maxConcurrent })))
          .toThrow('maxConcurrent')
      }
      // A loader-forged enum value that the schema would reject: keep it a
      // plain string so the test simulates a hostile direct apply.
      const bogusMode: string = 'bogus'
      const bogusDelivery: string = 'bogus'
      expect(() => resolveConfig(entryConfig(entry, { defaultMode: bogusMode as ZcodeMode })))
        .toThrow('defaultMode must be one of')
      expect(() => resolveConfig(entryConfig(entry, { completionDelivery: bogusDelivery as CompletionDelivery })))
        .toThrow("completionDelivery must be 'followup' or 'quiet'")
      expect(() => resolveConfig(entryConfig(entry, { maxConsecutiveWakes: 1.5 })))
        .toThrow('maxConsecutiveWakes')
      expect(() => resolveConfig(entryConfig(entry, { expectedProviderIds: [] })))
        .toThrow('expectedProviderIds must not be empty')
      expect(() => resolveConfig(entryConfig(entry, { expectedProviderIds: ['ok', ''] })))
        .toThrow('must not contain an empty provider id')
      expect(() => resolveConfig(entryConfig(entry, { zcodeLogDir: 'relative/logs' })))
        .toThrow('zcodeLogDir must be an absolute path')
      const resolved = resolveConfig(entryConfig(entry, {
        maxConcurrent: 3,
        defaultMode: 'yolo',
        completionDelivery: 'quiet',
        maxConsecutiveWakes: 4,
        expectedProviderIds: ['other:plan', 'new-provider'],
      }))
      expect(resolved.maxConcurrent).toBe(3)
      expect(resolved.defaultMode).toBe('yolo')
      expect(resolved.completionDelivery).toBe('quiet')
      expect(resolved.maxConsecutiveWakes).toBe(4)
      expect(resolved.expectedProviderIds).toEqual(['other:plan', 'new-provider'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('assertInsideTaskRoots', () => {
  it('accepts a root itself and paths inside one, and rejects everything else', () => {
    const root = scratch()
    try {
      const roots = [root]
      expect(() => { assertInsideTaskRoots(root, roots) }).not.toThrow()
      expect(() => { assertInsideTaskRoots(join(root, 'nested', 'dir'), roots) }).not.toThrow()
      expect(() => { assertInsideTaskRoots(`${root}-sibling`, roots) }).toThrow('outside every configured taskRoot')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('joinPromptText', () => {
  it('joins text blocks and rejects non-text or empty tasks', () => {
    expect(joinPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(() => joinPromptText([])).toThrow('only text blocks')
    expect(() => joinPromptText([{ type: 'reasoning', text: 'x' }])).toThrow('only text blocks')
    expect(() => joinPromptText([{ type: 'text', text: ' \n ' }])).toThrow('must not be empty')
  })
})

describe('buildZcodeCommand', () => {
  it('assembles the headless argv with resume first and comma-joined removals', () => {
    const base = {
      cliPath: '/cli/zcode.cjs',
      prompt: 'do it',
      cwd: '/ws',
      mode: 'edit' as const,
      disallowedTools: [] as const,
    }
    expect(buildZcodeCommand(base)).toEqual([
      '/cli/zcode.cjs', '-p', 'do it', '--json', '--cwd', '/ws', '--mode', 'edit',
    ])
    expect(buildZcodeCommand({ ...base, resume: ZcodeSessionId('sess_r') })).toEqual([
      '/cli/zcode.cjs', '--resume', 'sess_r', '-p', 'do it', '--json', '--cwd', '/ws', '--mode', 'edit',
    ])
    expect(buildZcodeCommand({ ...base, disallowedTools: ['WebFetch', 'Bash'] })).toEqual([
      '/cli/zcode.cjs', '-p', 'do it', '--json', '--cwd', '/ws', '--mode', 'edit', '--disallowed-tools', 'WebFetch,Bash',
    ])
  })
})

describe('parseZcodeHeadlessOutput', () => {
  const valid = {
    sessionId: 'sess_1',
    traceId: 't1',
    turnId: 'u1',
    response: 'done',
    usage: { source: 'provider', modelRequestCount: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    eventCount: 3,
    projection: { status: 'idle' },
  }

  it('parses the verified keys and keeps the raw stdout', () => {
    const raw = JSON.stringify(valid)
    const parsed = parseZcodeHeadlessOutput(raw)
    expect(parsed.zcodeSessionId).toBe('sess_1')
    expect(parsed.traceId).toBe('t1')
    expect(parsed.response).toBe('done')
    expect(parsed.usage).toMatchObject({ inputTokens: 10, totalTokens: 12 })
    expect(parsed.usage?.cacheReadTokens).toBeUndefined()
    expect(parsed.rawStdout).toBe(raw)
  })

  it('tolerates a missing traceId and usage', () => {
    const parsed = parseZcodeHeadlessOutput(JSON.stringify({ sessionId: 'sess_2', response: '' }))
    expect(parsed.traceId).toBeUndefined()
    expect(parsed.usage).toBeUndefined()
    expect(parsed.response).toBe('')
  })

  it('rejects non-JSON, non-object, and malformed payloads', () => {
    expect(() => parseZcodeHeadlessOutput('nope')).toThrow(ZcodeOutputError)
    expect(() => parseZcodeHeadlessOutput('[1]')).toThrow('not an object')
    expect(() => parseZcodeHeadlessOutput(JSON.stringify({ response: 'x' }))).toThrow('sessionId')
    expect(() => parseZcodeHeadlessOutput(JSON.stringify({ sessionId: '', response: 'x' }))).toThrow('sessionId')
    expect(() => parseZcodeHeadlessOutput(JSON.stringify({ sessionId: 's' }))).toThrow('response')
  })
})

describe('asZcodeHeadlessOutput', () => {
  it('narrows well-formed facts and rejects everything else', () => {
    const facts = {
      zcodeSessionId: 'sess_9',
      response: 'ok',
      rawStdout: '{}',
      traceId: 't',
      usage: { totalTokens: 5 },
    }
    expect(asZcodeHeadlessOutput(facts)).toMatchObject({ zcodeSessionId: 'sess_9', usage: { totalTokens: 5 } })
    expect(asZcodeHeadlessOutput(undefined)).toBeUndefined()
    expect(asZcodeHeadlessOutput('nope')).toBeUndefined()
    expect(asZcodeHeadlessOutput({ response: 'ok', rawStdout: '{}' })).toBeUndefined()
    expect(asZcodeHeadlessOutput({ zcodeSessionId: 'sess_9', response: 'ok' })).toBeUndefined()
  })
})

describe('subprocessSources', () => {
  it('reads empty before spawn and the collected streams after', () => {
    const state: { handle: SubprocessHandle | undefined } = { handle: undefined }
    const sources = subprocessSources(() => state.handle)
    expect(sources).toHaveLength(2)
    expect(sources[0]?.channel).toBe('stdout')
    expect(sources[0]?.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    state.handle = {
      collected: {
        stdout: { readFrom: () => ({ text: 'out', nextOffset: 3, lossy: false }) },
        stderr: { readFrom: () => ({ text: 'err', nextOffset: 3, lossy: false }) },
      },
    } as unknown as SubprocessHandle
    expect(sources[0]?.read(0)).toEqual({ text: 'out', nextOffset: 3, lossy: false })
    expect(sources[1]?.read(0)).toEqual({ text: 'err', nextOffset: 3, lossy: false })
  })
})

describe('startZcodeRun', () => {
  async function runner(entry: string) {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    let spawnError: Error | undefined
    let lastArgv: readonly string[] | undefined
    let lastEnv: NodeJS.ProcessEnv | undefined
    const run = (prompt: string, signal: AbortSignal, options: { resume?: string; builtinProviderConfigPath?: string } = {}) =>
      startZcodeRun([{ type: 'text', text: prompt }], signal, {
        cwd: process.cwd(),
        mode: 'edit',
        disallowedTools: [],
        cliPath: entry,
        ...(options.resume !== undefined ? { resume: ZcodeSessionId(options.resume) } : {}),
        ...(options.builtinProviderConfigPath !== undefined
          ? { builtinProviderConfigPath: options.builtinProviderConfigPath }
          : {}),
        spawn: (spec) => {
          if (spawnError !== undefined) throw spawnError
          lastArgv = spec.argv
          lastEnv = spec.env
          return ctx.subprocess.spawn(spec)
        },
      })
    return {
      run,
      failNextSpawn: (error: Error) => { spawnError = error },
      lastArgv: () => lastArgv,
      lastEnv: () => lastEnv,
    }
  }

  it('completes with parsed facts for a zero exit carrying valid JSON', async () => {
    fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'all done' })
    const r = await runner(FIXTURE)
    try {
      const run = await r.run('hello task', new AbortController().signal)
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(result.output).toEqual([{ type: 'text', text: 'all done' }])
      const facts = asZcodeHeadlessOutput(result.structured)
      expect(facts?.zcodeSessionId).toBe('sess_fake-00000000-0000-4000-8000-000000000000')
      expect(facts?.usage?.totalTokens).toBe(120)
      expect(facts?.rawStdout).toContain('"sessionId"')
      expect(r.lastArgv()).toContain('--json')
    } finally {
      clearFakeEnv()
    }
  })

  it('injects the builtin provider config path into the child environment', async () => {
    fakeBehavior('ok')
    const r = await runner(FIXTURE)
    try {
      const builtin = join(scratch(), 'zcode-builtin.json')
      writeFileSync(builtin, '{}\n')
      const run = await r.run('hello task', new AbortController().signal, { builtinProviderConfigPath: builtin })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(r.lastEnv()).toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin })
      rmSync(dirname(builtin), { recursive: true, force: true })
    } finally {
      clearFakeEnv()
    }
  })

  it('forwards no child environment when the CLI resolves its own provider config', async () => {
    fakeBehavior('ok')
    const r = await runner(FIXTURE)
    try {
      const run = await r.run('hello task', new AbortController().signal)
      await run.result
      expect(r.lastEnv()).toBeUndefined()
    } finally {
      clearFakeEnv()
    }
  })

  it('resumes an existing zcode session by passing its id', async () => {
    fakeBehavior('ok')
    const r = await runner(FIXTURE)
    try {
      const run = await r.run('again', new AbortController().signal, { resume: 'sess_prev' })
      const result = await run.result
      expect(asZcodeHeadlessOutput(result.structured)?.zcodeSessionId).toBe('sess_prev')
      expect(r.lastArgv()).toContain('--resume')
    } finally {
      clearFakeEnv()
    }
  })

  it('fails with the exit code and bounded stderr tail on a non-zero exit', async () => {
    fakeBehavior('fail-exit', { FAKE_ZCODE_STDERR: `${'quota exhausted '.repeat(200)}\n`, FAKE_ZCODE_EXIT_CODE: '7' })
    const r = await runner(FIXTURE)
    try {
      const run = await r.run('boom', new AbortController().signal)
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toContain('exit code 7')
      expect(result.diagnostic).toContain('quota exhausted')
      expect(result.diagnostic).toContain('…')
    } finally {
      clearFakeEnv()
    }
  })

  it('attaches the stderr tail to an output-parse failure', async () => {
    fakeBehavior('bad-json', { FAKE_ZCODE_STDERR: 'warning: degraded mode\n' })
    const r = await runner(FIXTURE)
    try {
      const run = await r.run('x', new AbortController().signal)
      const result = await run.result
      expect(result.diagnostic).toContain('not a valid headless result')
      expect(result.diagnostic).toContain('warning: degraded mode')
    } finally {
      clearFakeEnv()
    }
  })

  it('treats missing collected readers as empty streams', async () => {
    const blank: SubprocessHandle = {
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    } as unknown as SubprocessHandle
    const run = await startZcodeRun([{ type: 'text', text: 'x' }], new AbortController().signal, {
      cwd: process.cwd(),
      mode: 'edit',
      disallowedTools: [],
      cliPath: FIXTURE,
      spawn: () => blank,
    })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('not a valid headless result')
  })

  it('fails loud when stdout is not a valid headless result', async () => {
    for (const behavior of ['bad-json', 'not-object', 'missing-session', 'bad-response', 'empty-stdout'] as const) {
      fakeBehavior(behavior)
      const r = await runner(FIXTURE)
      try {
        const run = await r.run('x', new AbortController().signal)
        const result = await run.result
        expect(result.stopReason).toBe('error')
        expect(result.diagnostic).toContain('not a valid headless result')
      } finally {
        clearFakeEnv()
      }
    }
  })

  it('rejects before publication when spawn fails and still removes the abort listener', async () => {
    const r = await runner(FIXTURE)
    r.failNextSpawn(new Error('spawn refused'))
    const controller = new AbortController()
    await expect(r.run('x', controller.signal)).rejects.toThrow('spawn refused')
    expect(() => { controller.abort() }).not.toThrow()
  })

  it('rejects an empty or aborted start without spawning', async () => {
    const r = await runner(FIXTURE)
    await expect(r.run('', new AbortController().signal)).rejects.toThrow('must not be empty')
    const controller = new AbortController()
    controller.abort()
    await expect(r.run('late', controller.signal)).rejects.toThrow('aborted before CLI startup')
  })

  it('settles aborted when disposed mid-run and terminates the child', async () => {
    fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '30000' })
    const r = await runner(FIXTURE)
    try {
      const run = await r.run('long', new AbortController().signal)
      const settled = run.result
      await run.dispose()
      const result = await settled
      expect(result.stopReason).toBe('aborted')
    } finally {
      clearFakeEnv()
    }
  })

  it('skips re-cancellation when disposal follows an external abort', async () => {
    fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '30000' })
    const r = await runner(FIXTURE)
    try {
      const controller = new AbortController()
      const run = await r.run('long', controller.signal)
      const settled = run.result
      controller.abort()
      expect(await settled).toMatchObject({ stopReason: 'aborted' })
      await expect(run.dispose()).resolves.toBeUndefined()
    } finally {
      clearFakeEnv()
    }
  })

  it('flattens a rejected child done into an error result with a diagnostic', async () => {
    const result = await (async () => {
      const broken: SubprocessHandle = {
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.reject(new Error('wire broke')),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      } as unknown as SubprocessHandle
      return startZcodeRun([{ type: 'text', text: 'x' }], new AbortController().signal, {
        cwd: process.cwd(),
        mode: 'edit',
        disallowedTools: [],
        cliPath: FIXTURE,
        spawn: () => broken,
      }).then(handle => handle.result)
    })()
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('wire broke')
  })

  it('throws a teardown failure when the quiescence wait rejects', async () => {
    const broken: SubprocessHandle = {
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.reject(new Error('range lost')),
    } as unknown as SubprocessHandle
    await expect(disposeZcodeChild(broken)).rejects.toThrow(ZcodeProcessFailure)
    await expect(disposeZcodeChild(broken)).rejects.toThrow('teardown failed')
  })

  it('resolves a clean teardown and swallows a rejected child outcome', async () => {
    const clean: SubprocessHandle = {
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    } as unknown as SubprocessHandle
    await expect(disposeZcodeChild(clean)).resolves.toBeUndefined()
    const lateRejection: SubprocessHandle = {
      collected: {},
      done: Promise.reject(new Error('late provider crash')),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    } as unknown as SubprocessHandle
    await expect(disposeZcodeChild(lateRejection)).resolves.toBeUndefined()
  })

  it('bounds a non-Error teardown rejection', async () => {
    const broken: SubprocessHandle = {
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      // The rejection reason IS a non-Error string; that is the case under test.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the rejection reason is deliberately a non-Error
      waitForExit: () => Promise.reject('range lost plainly'),
    } as unknown as SubprocessHandle
    await expect(disposeZcodeChild(broken)).rejects.toThrow('range lost plainly')
  })
})

function fakeRun(result: SubagentResult | Error, disposeError?: Error): SubagentRun {
  return {
    id: brandString<SessionId>('run-1'),
    localAgent: undefined,
    result: result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    dispose: () => (disposeError === undefined ? Promise.resolve() : Promise.reject(disposeError)),
  }
}

const completedResult = (facts: unknown, diagnostic?: string): SubagentResult => ({
  output: [{ type: 'text', text: 'final' }],
  structured: facts,
  ...(diagnostic !== undefined ? { diagnostic } : {}),
  stopReason: 'completed',
})

describe('settleForegroundRun', () => {
  const facts = { zcodeSessionId: 'sess_f', response: 'final', rawStdout: '{}' }

  it('returns the foreground dispatch and disposes the run', async () => {
    const run = fakeRun(completedResult(facts))
    const value = await settleForegroundRun(run)
    expect(value).toEqual({ kind: 'foreground', zcodeSessionId: 'sess_f', response: 'final' })
  })

  it('throws headline plus diagnostic for an abnormal stop reason', async () => {
    for (const [stopReason, diagnostic, headline] of [
      ['aborted', 'diagnostic line', 'was cancelled'],
      ['error', 'diagnostic line', 'zcode run failed'],
      ['max-tokens', 'diagnostic line', 'token limit'],
      ['refusal', 'diagnostic line', 'declined the task'],
      ['refusal', undefined, 'declined the task'],
    ] as const) {
      const result: SubagentResult = {
        output: [],
        ...(diagnostic !== undefined ? { diagnostic } : {}),
        stopReason,
      }
      await expect(settleForegroundRun(fakeRun(result))).rejects.toThrow(headline)
    }
    // A merge-extensible union may grow terminal reasons; an unknown one must
    // still read as an abnormal end.
    const futureReason: string = 'exhausted'
    await expect(settleForegroundRun(fakeRun({ output: [], stopReason: futureReason as SubagentResult['stopReason'] })))
      .rejects.toThrow('ended abnormally')
  })

  it('rejects malformed structured facts and propagates disposal failures', async () => {
    await expect(settleForegroundRun(fakeRun(completedResult(undefined))))
      .rejects.toThrow('no parsable headless facts')
    await expect(settleForegroundRun(fakeRun(completedResult(facts), new Error('dispose boom'))))
      .rejects.toThrow('dispose boom')
    await expect(settleForegroundRun(fakeRun(new AggregateError([new Error('run boom')], 'run'), new Error('dispose boom'))))
      .rejects.toThrow('dispose failed')
    await expect(settleForegroundRun(fakeRun(new Error('result boom'))))
      .rejects.toThrow('result boom')
  })
})

describe('settleZcodeJob', () => {
  const jobId = JobId('zcode-99')

  function makeIndex(maxConcurrent = 2): ZcodeJobIndex {
    return new ZcodeJobIndex(new Context(), maxConcurrent)
  }

  function registered(index: ZcodeJobIndex, id: JobId = jobId): void {
    index.claim()
    index.register({ jobId: id, label: 'task', cwd: '/ws', mode: 'edit', round: 'dispatch', promptExcerpt: 'p', startedAt: 0 })
  }

  it('records completed facts, hands out the raw stdout, and releases the slot', async () => {
    const index = makeIndex()
    registered(index)
    const facts = {
      zcodeSessionId: 'sess_c',
      traceId: 't',
      response: 'done',
      usage: { totalTokens: 9 },
      rawStdout: '{"sessionId":"sess_c"}',
    }
    const run = fakeRun(completedResult(facts))
    const outcome = await settleZcodeJob(Promise.resolve(run), new AbortController().signal, jobId, index)
    expect(outcome).toEqual({ status: 'completed', result: '{"sessionId":"sess_c"}' })
    expect(index.get(jobId)?.settlement).toMatchObject({
      status: 'completed',
      zcodeSessionId: 'sess_c',
      traceId: 't',
    })
    expect(index.activeCount).toBe(0)

    const minimalId = JobId('zcode-103')
    registered(index, minimalId)
    await settleZcodeJob(
      Promise.resolve(fakeRun(completedResult({ zcodeSessionId: 'sess_m', response: 'ok', rawStdout: '{}' }))),
      new AbortController().signal,
      minimalId,
      index,
    )
    const minimal = index.get(minimalId)?.settlement
    expect(minimal).toMatchObject({ status: 'completed', zcodeSessionId: 'sess_m' })
    expect(minimal?.traceId).toBeUndefined()
    expect(minimal?.usage).toBeUndefined()
  })

  it('maps aborted to killed without detail and failed to the failure text', async () => {
    const index = makeIndex()
    registered(index)
    const aborted = await settleZcodeJob(
      Promise.resolve(fakeRun({ output: [], stopReason: 'aborted' })),
      new AbortController().signal,
      jobId,
      index,
    )
    expect(aborted).toEqual({ status: 'killed' })
    expect(index.get(jobId)?.settlement).toMatchObject({ status: 'killed' })

    const failedId = JobId('zcode-100')
    registered(index, failedId)
    const failed = await settleZcodeJob(
      Promise.resolve(fakeRun({ output: [], diagnostic: 'exit code 3', stopReason: 'error' })),
      new AbortController().signal,
      failedId,
      index,
    )
    expect(failed).toMatchObject({ status: 'failed' })
    expect(failed.detail).toContain('exit code 3')
    expect(index.activeCount).toBe(0)
  })

  it('maps a rejected startup through the cancellation discipline', async () => {
    const index = makeIndex()
    registered(index)
    const failed = await settleZcodeJob(Promise.reject(new Error('spawn refused')), new AbortController().signal, jobId, index)
    expect(failed).toEqual({ status: 'failed', detail: 'spawn refused' })
    expect(index.get(jobId)?.settlement).toMatchObject({ status: 'failed' })

    const killedId = JobId('zcode-101')
    registered(index, killedId)
    const abortedSignal = new AbortController()
    abortedSignal.abort()
    const killed = await settleZcodeJob(Promise.reject(new Error('late boom')), abortedSignal.signal, killedId, index)
    expect(killed).toEqual({ status: 'killed' })

    const aggregateId = JobId('zcode-102')
    registered(index, aggregateId)
    const aggregateSignal = new AbortController()
    aggregateSignal.abort()
    const aggregated = await settleZcodeJob(
      Promise.reject(new AggregateError([new Error('a')], 'startup')),
      aggregateSignal.signal,
      aggregateId,
      index,
    )
    expect(aggregated).toEqual({ status: 'failed', detail: 'startup' })
    expect(index.activeCount).toBe(0)

    const plainId = JobId('zcode-104')
    registered(index, plainId)
    // The rejection reason IS a non-Error string; that is the case under test.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the rejection reason is deliberately a non-Error
    const plain = await settleZcodeJob(Promise.reject('not an error'), new AbortController().signal, plainId, index)
    expect(plain).toEqual({ status: 'failed', detail: 'not an error' })
  })
})

describe('ZcodeJobIndex', () => {
  it('claims up to the cap and releases idempotently', () => {
    const ledger = new ZcodeJobIndex(new Context(), 2)
    expect(ledger.claim()).toBe(true)
    expect(ledger.claim()).toBe(true)
    expect(ledger.claim()).toBe(false)
    expect(ledger.activeCount).toBe(2)
    ledger.release()
    expect(ledger.activeCount).toBe(1)
    ledger.release()
    ledger.release()
    expect(ledger.activeCount).toBe(0)
  })

  it('ignores foreground records without a job id and warns on untracked settlement', () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const ledger = new ZcodeJobIndex(ctx, 2)
    ledger.register({ label: 'fg', cwd: '/ws', mode: 'edit', round: 'dispatch', promptExcerpt: 'p', startedAt: 0 })
    expect(ledger.list()).toHaveLength(0)
    ledger.settle(JobId('zcode-404'), { status: 'completed', finishedAt: 1 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('zcode-404'))
  })

  it('keeps the first settlement and lists records in registration order', () => {
    const ctx = new Context()
    const ledger = new ZcodeJobIndex(ctx, 1)
    const first = JobId('zcode-7')
    const second = JobId('zcode-8')
    ledger.register({ jobId: first, label: 't', cwd: '/ws', mode: 'edit', round: 'dispatch', promptExcerpt: 'p', startedAt: 0 })
    ledger.register({ jobId: second, label: 'u', cwd: '/ws', mode: 'edit', round: 'dispatch', promptExcerpt: 'q', startedAt: 1 })
    ledger.settle(first, { status: 'killed', finishedAt: 1 })
    ledger.settle(first, { status: 'completed', finishedAt: 2 })
    expect(ledger.get(first)?.settlement?.status).toBe('killed')
    expect(ledger.list().map(record => record.label)).toEqual(['t', 'u'])
  })
})


describe('subagent-zcode plugin', () => {
  /** The delivery surface a completion notice may reach on the fake owner. */
  interface FakeDelivery {
    inject?: (...args: unknown[]) => void
    followup?: (...args: unknown[]) => void
    /** Defaults to `running`, the lane that never wakes. */
    status?: 'idle' | 'running'
  }

  const ownerDisposers = new WeakMap<Agent, () => Promise<void>>()

  /**
   * A live fake owner registered in `ctx.agents` (the job registry requires a
   * live agent for owned jobs), carrying the delegating session's cwd.
   */
  async function fakeOwner(ctx: Context, cwd: string, delivery: FakeDelivery = {}): Promise<Agent> {
    const scopeFiber = ctx.plugin(() => {})
    const agent = {
      id: PARENT_ID,
      ctx: scopeFiber.ctx,
      inject: delivery.inject ?? (() => {}),
      followup: delivery.followup ?? (() => {}),
      status: delivery.status ?? 'running',
      session: { id: PARENT_ID, header: { version: 0, id: PARENT_ID, createdAt: 0, cwd } },
    } as unknown as Agent
    ownerDisposers.set(agent, await ctx.agents.register(agent))
    return agent
  }

  async function setup(config: Config) {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const effective: Config = Object.assign({}, config, { zcodeDbPath: config.zcodeDbPath ?? billingDb })
    const fiber = await ctx.plugin(zcode, effective)
    return { ctx, fiber }
  }

  let callCounter = 0

  function dispatch(ctx: Context, args: Record<string, unknown>, agent: Agent, signal = new AbortController().signal) {
    return ctx.tools.execute({
      signal,
      callId: brandString<ToolCallId>(`call-${++callCounter}`),
      name: 'zcode_dispatch',
      arguments: args,
      agent,
    })
  }

  it('registers provider, tools, and the index; disposal unregisters them', async () => {
    const dir = scratch()
    try {
      const { ctx, fiber } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      expect(ctx.subagents.list()).toEqual(['zcode'])
      const provider = ctx.subagents.getProvider('zcode')
      expect(provider?.capabilities).toMatchObject({ depthLimit: false, persona: false })
      expect(provider?.inheritsParentContext).toBe(false)
      expect(ctx.tools.get('zcode_dispatch')).toBeDefined()
      expect(ctx.tools.get('zcode_followup')).toBeDefined()
      expect(ctx.tools.get('zcode_roster')).toBeDefined()
      expect(ctx.zcodeJobs.list()).toEqual([])
      await fiber.dispose()
      expect(ctx.subagents.list()).toEqual([])
      expect(ctx.tools.get('zcode_dispatch')).toBeUndefined()
      expect(ctx.tools.get('zcode_roster')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails loud at load on an invalid config without registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(zcode, { zcodeCliPath: '/missing/zcode.cjs' }))
      .rejects.toThrow('not an executable file')
    expect(ctx.subagents.list()).toEqual([])
  })

  it('dispatches in the background, settles with facts, and feeds job_output', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'bg done' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const longPrompt = `refactor the module ${'with great care '.repeat(12)}`
      const result = await dispatch(ctx, { description: 'refactor', prompt: longPrompt, run_in_background: true, ticket: 'T1' }, owner)
      const raw: unknown = result.value
      const value = raw as { kind: string; jobId: string }
      expect(value).toMatchObject({ kind: 'background' })
      expect(value.jobId).toMatch(/^zcode-\d+$/)
      const jobId = JobId(value.jobId)
      const view = await ctx.jobs.wait(jobId, 10_000, PARENT_ID)
      expect(view.status).toBe('completed')
      expect(view.kind).toBe('zcode')
      const record = ctx.zcodeJobs.get(jobId)
      expect(record?.settlement).toMatchObject({ status: 'completed', zcodeSessionId: 'sess_fake-00000000-0000-4000-8000-000000000000' })
      expect(record?.ticket).toBe('T1')
      expect(record?.label).toBe('refactor')
      expect(record?.cwd).toBe(dir)
      expect(record?.promptExcerpt.length).toBeLessThanOrEqual(120)
      expect(record?.promptExcerpt.endsWith('…')).toBe(true)
      const read = ctx.jobs.read(jobId, PARENT_ID)
      expect(read.result).toContain('"sessionId"')
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rosters every task with ticket ids, sessions, and terminal status', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'done' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const first = await dispatch(ctx, { description: 'one', prompt: 'first task', run_in_background: true, ticket: 'T1' }, owner)
      const second = await dispatch(ctx, { description: 'two', prompt: 'second task', run_in_background: true, ticket: 'T2' }, owner)
      await ctx.jobs.wait(JobId((first.value as { jobId: string }).jobId), 10_000, PARENT_ID)
      await ctx.jobs.wait(JobId((second.value as { jobId: string }).jobId), 10_000, PARENT_ID)
      const roster = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: brandString<ToolCallId>(`call-${++callCounter}`),
        name: 'zcode_roster',
        arguments: {},
        agent: owner,
      })
      expect(roster.isError).toBe(false)
      const rows = roster.value as Array<Record<string, unknown>>
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        ticket: 'T1',
        label: 'one',
        round: 'dispatch',
        status: 'completed',
        zcodeSessionId: 'sess_fake-00000000-0000-4000-8000-000000000000',
      })
      expect(rows[1]).toMatchObject({ ticket: 'T2', label: 'two', status: 'completed' })
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a ticket identifier beyond the one-line budget', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok')
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const refused = await dispatch(ctx, { description: 'd', prompt: 'p', ticket: 'x'.repeat(65) }, owner)
      expect(refused.isError).toBe(true)
      expect(String(refused.content?.[0]?.type === 'text' && refused.content[0].text))
        .toContain('at most 64 characters')
      expect(ctx.zcodeJobs.activeCount).toBe(0)
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dispatches in the foreground and returns the response with the session id', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'fg done' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const result = await dispatch(ctx, { description: 'quick', prompt: 'quick task' }, owner)
      expect(result.isError).toBe(false)
      const raw: unknown = result.value
      const value = raw as { kind: string; response: string; zcodeSessionId: string }
      expect(value).toEqual({ kind: 'foreground', zcodeSessionId: 'sess_fake-00000000-0000-4000-8000-000000000000', response: 'fg done' })
      expect(ctx.zcodeJobs.activeCount).toBe(0)
      expect(ctx.zcodeJobs.list()).toEqual([])
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a task directory outside every taskRoot before any process starts', async () => {
    const dir = scratch()
    const outside = scratch()
    try {
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, outside)
      for (const background of [false, true]) {
        const result = await dispatch(ctx, background
          ? { description: 'd', prompt: 'p', run_in_background: true }
          : { description: 'd', prompt: 'p' }, owner)
        expect(result.isError).toBe(true)
        expect(result.content).toMatchObject([{ type: 'text' }])
        expect(String(result.content?.[0]?.type === 'text' && result.content[0].text)).toContain('outside every configured taskRoot')
      }
      expect(ctx.zcodeJobs.activeCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects dispatch beyond the process-level cap without queueing', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '1500' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], maxConcurrent: 1 }))
      const owner = await fakeOwner(ctx, dir)
      const first = await dispatch(ctx, { description: 'one', prompt: 'p', run_in_background: true }, owner)
      const raw: unknown = first.value
      const firstValue = raw as { jobId: string }
      const second = await dispatch(ctx, { description: 'two', prompt: 'p' }, owner)
      expect(second.isError).toBe(true)
      expect(String(second.content?.[0]?.type === 'text' && second.content[0].text))
        .toContain('concurrent zcode task limit reached (active 1, cap 1)')
      await ctx.jobs.wait(JobId(firstValue.jobId), 10_000, PARENT_ID)
      const third = await dispatch(ctx, { description: 'three', prompt: 'p' }, owner)
      expect(third.isError).toBe(false)
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a failed CLI run in the job record and keeps the slot released', async () => {
    const dir = scratch()
    try {
      fakeBehavior('fail-exit', { FAKE_ZCODE_STDERR: 'quota exhausted\n' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const result = await dispatch(ctx, { description: 'bad', prompt: 'p', run_in_background: true }, owner)
      const raw: unknown = result.value
      const value = raw as { jobId: string }
      const view = await ctx.jobs.wait(JobId(value.jobId), 10_000, PARENT_ID)
      expect(view.status).toBe('failed')
      expect(view.detail).toContain('quota exhausted')
      expect(ctx.zcodeJobs.get(JobId(value.jobId))?.settlement).toMatchObject({ status: 'failed' })
      expect(ctx.zcodeJobs.activeCount).toBe(0)
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills running background dispatches and records the killed settlements', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '30000' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const withReason = await dispatch(ctx, { description: 'slow', prompt: 'p', run_in_background: true }, owner)
      const withoutReason = await dispatch(ctx, { description: 'slow two', prompt: 'p', run_in_background: true }, owner)
      const rawFirst: unknown = withReason.value
      const firstId = JobId((rawFirst as { jobId: string }).jobId)
      const rawSecond: unknown = withoutReason.value
      const secondId = JobId((rawSecond as { jobId: string }).jobId)
      expect(ctx.jobs.kill(firstId, PARENT_ID, 'no longer needed')).toBe('requested')
      expect(ctx.jobs.kill(secondId, PARENT_ID)).toBe('requested')
      expect((await ctx.jobs.wait(firstId, 10_000, PARENT_ID)).status).toBe('killed')
      expect((await ctx.jobs.wait(secondId, 10_000, PARENT_ID)).status).toBe('killed')
      expect(ctx.zcodeJobs.get(firstId)?.settlement).toMatchObject({ status: 'killed' })
      expect(ctx.zcodeJobs.get(secondId)?.settlement).toMatchObject({ status: 'killed' })
      expect(ctx.zcodeJobs.activeCount).toBe(0)
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('releases the claimed slot when the job registry rejects the start', async () => {
    const dir = scratch()
    try {
      fakeBehavior('ok')
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      for (const args of [
        { description: 'd', prompt: 'p', run_in_background: true },
        { zcode_session_id: 'sess_x', prompt: 'p' },
      ]) {
        const name = 'zcode_session_id' in args ? 'zcode_followup' : 'zcode_dispatch'
        vi.spyOn(ctx.jobs, 'start').mockImplementationOnce(() => {
          throw new Error('registry admission refused')
        })
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`call-${++callCounter}`),
          name,
          arguments: args,
          agent: owner,
        })
        expect(result.isError).toBe(true)
        expect(String(result.content?.[0]?.type === 'text' && result.content[0].text)).toContain('registry admission refused')
        expect(ctx.zcodeJobs.activeCount).toBe(0)
      }
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps a spawn failure inside the job to a failed record with a released slot', async () => {
    const dir = scratch()
    try {
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementationOnce(() => {
        throw new Error('spawn refused')
      })
      const result = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
      const raw: unknown = result.value
      const value = raw as { jobId: string }
      const view = await ctx.jobs.wait(JobId(value.jobId), 10_000, PARENT_ID)
      expect(view.status).toBe('failed')
      expect(view.detail).toContain('spawn refused')
      expect(ctx.zcodeJobs.activeCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves the provider face end to end and re-checks the whitelist at the seam', async () => {
    const dir = scratch()
    const elsewhere = scratch()
    try {
      fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'provider done' })
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const owner = await fakeOwner(ctx, dir)
      const warn = vi.spyOn(ctx.logger, 'warn')
      const run = await ctx.subagents.start('zcode', {
        label: 'via provider',
        prompt: [{ type: 'text', text: 'p' }],
        parent: owner,
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(asZcodeHeadlessOutput(result.structured)?.response).toBe('provider done')
      await expect(ctx.subagents.start('zcode', {
        label: 'outside',
        prompt: [{ type: 'text', text: 'p' }],
        parent: { id: PARENT_ID, session: { header: { cwd: elsewhere } } } as unknown as Agent,
        signal: new AbortController().signal,
      })).rejects.toThrow('outside every configured taskRoot')
      expect(warn.mock.calls.filter(([message]) => String(message).includes('child run failed'))).toHaveLength(0)
      fakeBehavior('fail-exit', { FAKE_ZCODE_STDERR: 'provider boom\n' })
      const failed = await ctx.subagents.start('zcode', {
        label: 'fails',
        prompt: [{ type: 'text', text: 'p' }],
        parent: owner,
        signal: new AbortController().signal,
      })
      expect((await failed.result).stopReason).toBe('error')
      expect(warn.mock.calls.some(([message]) => String(message).includes('child run failed'))).toBe(true)
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('passes the resolved builtin provider config through the tool path into the child env', async () => {
    const dir = scratch()
    const app = scratch()
    try {
      fakeBehavior('ok')
      const builtin = writeAppLayout(app).config
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], builtinProviderConfigPath: builtin }))
      const owner = await fakeOwner(ctx, dir)
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await dispatch(ctx, { description: 'd', prompt: 'p' }, owner)
      expect(result.isError).toBe(false)
      expect(spawn.mock.calls[0]?.[0].env).toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin })
    } finally {
      clearFakeEnv()
      rmSync(dir, { recursive: true, force: true })
      rmSync(app, { recursive: true, force: true })
    }
  })

  it('exposes the tool surface facts and rejects agentless calls', async () => {
    const dir = scratch()
    try {
      const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
      const tool = ctx.tools.get('zcode_dispatch')
      expect(tool?.isConcurrencySafe?.({ description: 'd', prompt: 'p' })).toBe(true)
      expect(ctx.tools.get('zcode_followup')?.isConcurrencySafe?.({ zcode_session_id: 'sess_x', prompt: 'p' })).toBe(true)
      expect(ctx.tools.get('zcode_followup')?.presentCall?.({ zcode_session_id: 'sess_x', prompt: 'p' }))
        .toMatchObject({ card: 'generic', title: 'Resume zcode session sess_x' })
      expect(tool?.presentCall?.({ description: 'refactor', prompt: 'p' }))
        .toMatchObject({ card: 'generic', title: 'Dispatch zcode subagent: refactor' })
      const result = await dispatch(ctx, { description: 'd', prompt: 'p' }, undefined as never)
      expect(result.isError).toBe(true)
      expect(String(result.content?.[0]?.type === 'text' && result.content[0].text))
        .toContain('requires a calling agent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('zcode completion notices', () => {
    function fakeJobView(overrides: Partial<JobView> = {}): JobView {
      return {
        id: JobId('zcode-1'),
        kind: 'zcode',
        label: 'refactor',
        owner: PARENT_ID,
        status: 'completed',
        startedAt: 0,
        output: { total: 0, earliest: 0 },
        ...overrides,
      }
    }

    const settled = {
      status: 'completed' as const,
      zcodeSessionId: ZcodeSessionId('sess_n'),
      traceId: 't',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      finishedAt: 1,
    }

    /** A registered task whose notice-visible facts the case overrides. */
    function record(overrides: Partial<ZcodeJobRecord> = {}): ZcodeJobRecord {
      return {
        jobId: JobId('zcode-1'),
        label: 'refactor',
        cwd: process.cwd(),
        mode: 'edit',
        round: 'dispatch',
        promptExcerpt: 'p',
        startedAt: 0,
        ...overrides,
      }
    }

    it('composes the notice body from the projection and recorded facts', () => {
      const text = noticeText(fakeJobView(), record({ settlement: settled }))
      expect(text).toContain('zcode task zcode-1 (refactor) finished completed.')
      expect(text).toContain('zcode session sess_n, tokens 100 in / 20 out (120 total).')
      expect(text).toContain('Full output: job_output.')
      const minimal = noticeText(fakeJobView(), record({ settlement: { status: 'completed', finishedAt: 1 } }))
      expect(minimal).not.toContain('zcode session')
      const untracked = noticeText(fakeJobView(), undefined)
      expect(untracked).toContain('finished completed.')
      expect(untracked).not.toContain('zcode session')
    })

    it('names the ticket in the notice when the dispatch carried one', () => {
      const text = noticeText(fakeJobView(), record({ ticket: 'T3', settlement: settled }))
      expect(text).toContain('zcode ticket T3 — task zcode-1 (refactor) finished completed.')
      expect(noticeSummary(fakeJobView(), record({ ticket: 'T3', settlement: settled }))).toContain('ticket T3')
      expect(noticeSummary(fakeJobView(), record({ settlement: settled }))).not.toContain('ticket')
    })

    it('omits the token clause without usage and pads unknown counters', () => {
      const text = noticeText(fakeJobView(), record({
        settlement: { status: 'completed', zcodeSessionId: ZcodeSessionId('sess_u'), finishedAt: 1 },
      }))
      expect(text).toContain('zcode session sess_u.')
      expect(text).not.toContain('tokens')
      const partial = noticeText(fakeJobView(), record({
        settlement: {
          status: 'completed',
          zcodeSessionId: ZcodeSessionId('sess_p'),
          usage: {},
          finishedAt: 1,
        },
      }))
      expect(partial).toContain('tokens ? in / ? out (? total)')
    })

    it('ignores zcode-kind jobs with no live owning agent', async () => {
      const dir = scratch()
      try {
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const followup = vi.fn()
        await fakeOwner(ctx, dir, { followup, status: 'idle' })
        // A foreign producer may mint kind-'zcode' jobs this package never
        // registered; without a live owning agent there is nothing to notify.
        const unowned = ctx.jobs.start({
          kind: 'zcode',
          label: 'rogue unowned',
          run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' as const }) }),
        })
        await vi.waitFor(() => { expect(ctx.jobs.get(unowned).status).toBe('completed') })
        expect(followup).not.toHaveBeenCalled()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('ignores non-zcode settlements and notice-shaped claims', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '400' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], maxConsecutiveWakes: 1 }))
        const followup = vi.fn()
        const owner = await fakeOwner(ctx, dir, { followup, status: 'idle' })
        // A foreign-kind producer on the shared registry must not be reported here.
        ctx.jobs.start({
          kind: 'bash',
          label: 'not mine',
          owner: PARENT_ID,
          run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' as const }) }),
        })
        // A notice this plugin queued claims an inbox step without refilling the budget.
        emitAgentEvent(ctx, owner, 'agent/inbox/claimed', {
          message: createUserMessage({
            content: [{ type: 'text', text: 'zcode task zcode-9 finished' }],
            source: { kind: 'zcode-jobs', form: 'notice', summary: 'zcode' },
          }),
          turn: 1,
        })
        const dispatched = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
        const raw: unknown = dispatched.value
        await vi.waitFor(() => { expect(ctx.zcodeJobs.get(JobId((raw as { jobId: string }).jobId))?.settlement).toBeDefined() })
        expect(followup).toHaveBeenCalledTimes(1)
        expect(followup.mock.calls.every(([,]) => true)).toBe(true)
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('bounds the status reason and the summary', () => {
      const detail = `${'x'.repeat(300)}\nsecond line`
      const text = noticeText(fakeJobView({ status: 'failed', detail }), record({ settlement: settled }))
      expect(text).toContain(`failed (${'x'.repeat(119)}…)`)
      expect(noticeSummary(fakeJobView({ label: 'l'.repeat(300) }), undefined)).toContain('zcode')
    })

    it('wakes an idle owner with the full notice payload', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok')
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const followup = vi.fn()
        const inject = vi.fn()
        const owner = await fakeOwner(ctx, dir, { followup, inject, status: 'idle' })
        const dispatched = await dispatch(ctx, { description: 'refactor', prompt: 'p', run_in_background: true }, owner)
        const raw: unknown = dispatched.value
        const jobId = JobId((raw as { jobId: string }).jobId)
        await vi.waitFor(() => { expect(ctx.zcodeJobs.get(jobId)?.settlement).toBeDefined() })
        expect(followup).toHaveBeenCalledTimes(1)
        expect(inject).not.toHaveBeenCalled()
        const rawMessage: unknown = followup.mock.calls[0]?.[0]
        const message = rawMessage as {
          source: { kind: string; form: string; summary: string }
          content: readonly { type: string; text: string }[]
        }
        expect(message.source).toMatchObject({ kind: 'zcode-jobs', form: 'notice' })
        expect(message.source.summary).toContain('refactor')
        expect(message.content[0]?.text).toContain('zcode session sess_fake-00000000-0000-4000-8000-000000000000')
        expect(message.content[0]?.text).toContain('tokens 100 in / 20 out (120 total)')
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('injects a busy owner and stays silent under quiet delivery', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok')
        for (const [config, status, woken] of [
          [{}, 'running', 'inject'],
          [{ completionDelivery: 'quiet' as const }, 'idle', 'inject'],
          [{}, 'idle', 'followup'],
        ] as const) {
          const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], ...config }))
          const followup = vi.fn()
          const inject = vi.fn()
          const owner = await fakeOwner(ctx, dir, { followup, inject, status })
          const dispatched = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
          const raw: unknown = dispatched.value
          await vi.waitFor(() => { expect(ctx.zcodeJobs.get(JobId((raw as { jobId: string }).jobId))?.settlement).toBeDefined() })
          expect(woken === 'inject' ? inject : followup).toHaveBeenCalledTimes(1)
          expect(woken === 'inject' ? followup : inject).not.toHaveBeenCalled()
          await ctx.fiber.dispose()
        }
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('degrades repeated wakes past the budget and refills on user input', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok')
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], maxConsecutiveWakes: 1 }))
        const followup = vi.fn()
        const inject = vi.fn()
        const owner = await fakeOwner(ctx, dir, { followup, inject, status: 'idle' })
        for (const _ of [1, 2] as const) {
          const dispatched = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
          const raw: unknown = dispatched.value
          await vi.waitFor(() => { expect(ctx.zcodeJobs.get(JobId((raw as { jobId: string }).jobId))?.settlement).toBeDefined() })
        }
        expect(followup).toHaveBeenCalledTimes(1)
        expect(inject).toHaveBeenCalledTimes(1)
        emitAgentEvent(ctx, owner, 'agent/inbox/claimed', {
          message: createUserMessage({ content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } }),
          turn: 1,
        })
        const dispatched = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
        const raw: unknown = dispatched.value
        await vi.waitFor(() => { expect(ctx.zcodeJobs.get(JobId((raw as { jobId: string }).jobId))?.settlement).toBeDefined() })
        expect(followup).toHaveBeenCalledTimes(2)
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('notifies a killed settlement with the recorded kill reason', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '30000' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const followup = vi.fn()
        const owner = await fakeOwner(ctx, dir, { followup, status: 'idle' })
        const dispatched = await dispatch(ctx, { description: 'slow', prompt: 'p', run_in_background: true }, owner)
        const raw: unknown = dispatched.value
        const jobId = JobId((raw as { jobId: string }).jobId)
        ctx.jobs.kill(jobId, PARENT_ID, 'no longer needed')
        await vi.waitFor(() => { expect(ctx.zcodeJobs.get(jobId)?.settlement).toBeDefined() })
        expect(followup).toHaveBeenCalledTimes(1)
        const message = followup.mock.calls[0]?.[0] as { content: readonly { type: string; text: string }[] }
        expect(message.content[0]?.text).toContain('finished killed (no longer needed)')
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('skips settlements a live wait already collected and teardown settlements', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '800' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const followup = vi.fn()
        const owner = await fakeOwner(ctx, dir, { followup, status: 'idle' })
        const dispatched = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
        const raw: unknown = dispatched.value
        const jobId = JobId((raw as { jobId: string }).jobId)
        const wait = ctx.jobs.wait(jobId, 30_000, PARENT_ID)
        await wait
        expect(followup).not.toHaveBeenCalled()

        const zombie = await dispatch(ctx, { description: 'zombie', prompt: 'p', run_in_background: true }, owner)
        const zombieRaw: unknown = zombie.value
        const zombieId = JobId((zombieRaw as { jobId: string }).jobId)
        await ownerDisposers.get(owner)?.()
        await ctx.jobs.wait(zombieId, 10_000, PARENT_ID)
        expect(followup).not.toHaveBeenCalled()
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('zcode_followup', () => {
    function followup(ctx: Context, args: Record<string, unknown>, agent: Agent, signal = new AbortController().signal) {
      return ctx.tools.execute({
        signal,
        callId: ToolCallId(`call-${++callCounter}`),
        name: 'zcode_followup',
        arguments: args,
        agent,
      })
    }

    it('resumes an existing zcode session as a new background round', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'round two' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const owner = await fakeOwner(ctx, dir)
        const result = await followup(ctx, { zcode_session_id: 'sess_prev', prompt: 'continue the refactor' }, owner)
        expect(result.isError).toBe(false)
        const raw: unknown = result.value
        const value = raw as { kind: string; jobId: string; zcodeSessionId: string }
        expect(value.kind).toBe('background')
        expect(value.jobId).toMatch(/^zcode-\d+$/)
        expect(value.zcodeSessionId).toBe('sess_prev')
        const jobId = JobId(value.jobId)
        await vi.waitFor(() => { expect(ctx.zcodeJobs.get(jobId)?.settlement).toBeDefined() })
        const record = ctx.zcodeJobs.get(jobId)
        expect(record?.round).toBe('resume')
        expect(record?.zcodeSessionId).toBe('sess_prev')
        expect(record?.settlement).toMatchObject({ status: 'completed' })
        expect(record?.settlement?.zcodeSessionId).toBe('sess_prev')
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('counts follow-up rounds against the process-level cap', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '1200' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], maxConcurrent: 1 }))
        const owner = await fakeOwner(ctx, dir)
        const first = await dispatch(ctx, { description: 'one', prompt: 'p', run_in_background: true }, owner)
        const rawFirst: unknown = first.value
        const second = await followup(ctx, { zcode_session_id: 'sess_x', prompt: 'p' }, owner)
        expect(second.isError).toBe(true)
        expect(String(second.content?.[0]?.type === 'text' && second.content[0].text))
          .toContain('concurrent zcode task limit reached (active 1, cap 1)')
        const jobId = JobId((rawFirst as { jobId: string }).jobId)
        await ctx.jobs.wait(jobId, 10_000, PARENT_ID)
        const third = await followup(ctx, { zcode_session_id: 'sess_x', prompt: 'p' }, owner)
        expect(third.isError).toBe(false)
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('kills running follow-up rounds with and without a reason', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_DELAY_MS: '30000' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const owner = await fakeOwner(ctx, dir, { status: 'running' })
        const withReason = await followup(ctx, { zcode_session_id: 'sess_a', prompt: 'p' }, owner)
        const withoutReason = await followup(ctx, { zcode_session_id: 'sess_b', prompt: 'p' }, owner)
        const rawWith: unknown = withReason.value
        const rawWithout: unknown = withoutReason.value
        const firstId = JobId((rawWith as { jobId: string }).jobId)
        const secondId = JobId((rawWithout as { jobId: string }).jobId)
        expect(ctx.jobs.kill(firstId, PARENT_ID, 'not needed')).toBe('requested')
        expect(ctx.jobs.kill(secondId, PARENT_ID)).toBe('requested')
        await vi.waitFor(() => {
          expect(ctx.zcodeJobs.get(firstId)?.settlement).toMatchObject({ status: 'killed' })
          expect(ctx.zcodeJobs.get(secondId)?.settlement).toMatchObject({ status: 'killed' })
        })
        expect(ctx.zcodeJobs.activeCount).toBe(0)
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses a follow-up outside every taskRoot and without a calling agent', async () => {
      const dir = scratch()
      const outside = scratch()
      try {
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const owner = await fakeOwner(ctx, outside)
        const refused = await followup(ctx, { zcode_session_id: 'sess_x', prompt: 'p' }, owner)
        expect(refused.isError).toBe(true)
        expect(String(refused.content?.[0]?.type === 'text' && refused.content[0].text))
          .toContain('outside every configured taskRoot')
        const agentless = await followup(ctx, { zcode_session_id: 'sess_x', prompt: 'p' }, undefined as never)
        expect(agentless.isError).toBe(true)
        expect(String(agentless.content?.[0]?.type === 'text' && agentless.content[0].text))
          .toContain('requires a calling agent')
      } finally {
        rmSync(dir, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('keeps the resume handle usable from a fresh process (restart resilience)', async () => {
      const dir = scratch()
      try {
        fakeBehavior('ok', { FAKE_ZCODE_RESPONSE: 'after restart' })
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir] }))
        const owner = await fakeOwner(ctx, dir)
        expect(ctx.zcodeJobs.list()).toEqual([])
        const result = await followup(ctx, { zcode_session_id: 'sess_from-log', prompt: 'keep going' }, owner)
        const raw: unknown = result.value
        const value = raw as { jobId: string; zcodeSessionId: string }
        expect(value.zcodeSessionId).toBe('sess_from-log')
        const jobId = JobId(value.jobId)
        await vi.waitFor(() => { expect(ctx.zcodeJobs.get(jobId)?.settlement).toBeDefined() })
        const read = ctx.jobs.read(jobId, PARENT_ID)
        expect(read.result).toContain('"sessionId":"sess_from-log"')
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
  describe('billing self-check', () => {
    it('passes when the newest row matches and memoizes the success', () => {
      const dir = scratch()
      try {
        const path = join(dir, 'db.sqlite')
        writeBillingDb(path, GOOD_PROVIDER_ID)
        const guard = createBillingGuard(path, [GOOD_PROVIDER_ID])
        guard.ensureChecked()
        rmSync(path)
        guard.ensureChecked()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('accepts every provider in the expected set — the CLI switches providers as plan pools drain', () => {
      const dir = scratch()
      try {
        const expected = [GOOD_PROVIDER_ID, 'account:bigmodel-individual-coding-plan', 'new-provider']
        const poolFull = join(dir, 'full.sqlite')
        writeBillingDb(poolFull, GOOD_PROVIDER_ID)
        createBillingGuard(poolFull, expected).ensureChecked()
        const codingPlan = join(dir, 'coding-plan.sqlite')
        writeBillingDb(codingPlan, 'account:bigmodel-individual-coding-plan')
        createBillingGuard(codingPlan, expected).ensureChecked()
        const poolDrained = join(dir, 'drained.sqlite')
        writeBillingDb(poolDrained, 'new-provider')
        createBillingGuard(poolDrained, expected).ensureChecked()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses drift, a missing database, an empty table, and a foreign schema', () => {
      const dir = scratch()
      try {
        const driftPath = join(dir, 'drift.sqlite')
        writeBillingDb(driftPath, 'other:plan')
        expect(() => { createBillingGuard(driftPath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow(BillingSelfCheckError)
        expect(() => { createBillingGuard(driftPath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow(/provider_id "other:plan" .* none of the expected providers .* probe closure/s)

        const nullPath = join(dir, 'null-id.sqlite')
        writeBillingDb(nullPath, undefined)
        {
          const db = new DatabaseSync(nullPath)
          db.prepare('INSERT INTO model_usage (provider_id) VALUES (?)').run(null)
          db.close()
        }
        expect(() => { createBillingGuard(nullPath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow('provider_id undefined')

        expect(() => {
          createBillingGuard(join(dir, 'missing.sqlite'), [GOOD_PROVIDER_ID]).ensureChecked()
        }).toThrow('billing database not found')

        const emptyPath = join(dir, 'empty.sqlite')
        writeBillingDb(emptyPath, undefined)
        expect(() => { createBillingGuard(emptyPath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow('no model_usage rows')

        const noTablePath = join(dir, 'no-table.sqlite')
        writeBillingDb(noTablePath, 'account:bigmodel-start-plan', false)
        expect(() => { createBillingGuard(noTablePath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow('cannot be read')
        expect(() => { createBillingGuard(noTablePath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow('no such table')

        const garbagePath = join(dir, 'garbage.sqlite')
        writeFileSync(garbagePath, 'this is not a database')
        expect(() => { createBillingGuard(garbagePath, [GOOD_PROVIDER_ID]).ensureChecked() })
          .toThrow('file is not a database')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses every dispatch until the billing check passes', async () => {
      const dir = scratch()
      try {
        const driftPath = join(dir, 'drift.sqlite')
        writeBillingDb(driftPath, 'other:plan')
        const { ctx } = await setup(entryConfig(FIXTURE, { taskRoots: [dir], zcodeDbPath: driftPath }))
        const owner = await fakeOwner(ctx, dir, { status: 'running' })
        const refused = await dispatch(ctx, { description: 'd', prompt: 'p', run_in_background: true }, owner)
        expect(refused.isError).toBe(true)
        expect(String(refused.content?.[0]?.type === 'text' && refused.content[0].text))
          .toContain('billing self-check failed')
        expect(ctx.zcodeJobs.activeCount).toBe(0)
        expect(ctx.subagents.getProvider('zcode')).toBeDefined()
        fakeBehavior('ok')
        writeBillingDb(driftPath, GOOD_PROVIDER_ID)
        const repaired = await dispatch(ctx, { description: 'd', prompt: 'p' }, owner)
        expect(repaired.isError).toBe(false)
      } finally {
        clearFakeEnv()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
describe('zcodeLogTailSource', () => {
  function dayStamp(timestamp: number): string {
    const date = new Date(timestamp)
    const month = `${date.getMonth() + 1}`.padStart(2, '0')
    const day = `${date.getDate()}`.padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}.jsonl`
  }

  it('reads an empty state for a missing log directory or empty file', () => {
    const dir = join(scratch(), 'missing-log-dir')
    const source = zcodeLogTailSource(dir, 0)
    expect(source.channel).toBe('log')
    expect(source.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    const emptyDir = scratch()
    writeFileSync(join(emptyDir, '2026-09-05.jsonl'), '')
    expect(zcodeLogTailSource(emptyDir, new Date(2026, 8, 5).getTime()).read(0))
      .toEqual({ text: '', nextOffset: 0, lossy: false })
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('streams the tail with lossy clamping and incremental deltas', () => {
    const dir = scratch()
    try {
      const file = join(dir, dayStamp(new Date(2026, 8, 5).getTime()))
      writeFileSync(file, '{"event":"a"}\n', { flag: 'w' })
      const source = zcodeLogTailSource(dir, new Date(2026, 8, 5).getTime())
      const first = source.read(0)
      expect(first).toEqual({ text: '{"event":"a"}\n', nextOffset: 14, lossy: false })
      expect(source.read(14)).toEqual({ text: '', nextOffset: 14, lossy: false })
      appendFileSync(file, '{"event":"b"}\n')
      expect(source.read(14)).toEqual({ text: '{"event":"b"}\n', nextOffset: 28, lossy: false })
      const big = `${'x'.repeat(20_000)}\n`
      writeFileSync(file, big, { flag: 'w' })
      const clamped = source.read(0)
      expect(clamped.lossy).toBe(true)
      expect(clamped.text.length).toBe(16 * 1024)
      expect(clamped.nextOffset).toBe(20_001)
      expect(clamped.text.startsWith('x')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
