/**
 * ⚠️ DEPRECATED — Face A real-CLI e2e (legacy). Quarantined; NOT in `npm test`.
 * Live path = Face B swarm (tests/faced-*.spec.ts, harvest, task-roots,
 * concurrency-and-transcript). See DEMO.md / ADR-0002 / src/_legacy_face_a/.
 * Do not revive Face A assertions here; prefer Face B fixtures.
 */
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { asZcodeHeadlessOutput } from '../src/_legacy_face_a/cli.ts'
import * as zcode from '../src/index.ts'

/**
 * Real-CLI smoke: one tiny one-shot dispatch through the actual zcode binary.
 * Skipped wherever the CLI is not installed; it needs zcode's own logged-in
 * auth and burns one small model call, so it never runs as a unit test.
 */
const CLI_PATH = process.env.ZCODE_CLI_PATH
  ?? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'

function cliAvailable(): boolean {
  try {
    accessSync(CLI_PATH, constants.X_OK)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!cliAvailable())('real zcode CLI smoke', () => {
  it('dispatches one tiny one-shot task and parses the headless result', { timeout: 180_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-subagent-zcode-real-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(zcode, { zcodeCliPath: CLI_PATH, taskRoots: [cwd] })
      expect(ctx.subagents.list()).toContain('zcode')
      const parent = {
        id: brandString<SessionId>('parent'),
        session: { header: { cwd } },
      } as unknown as Agent
      const run = await ctx.subagents.start('zcode', {
        label: 'probe',
        prompt: [{ type: 'text', text: 'Reply with the single word ok and nothing else.' }],
        parent,
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      const facts = asZcodeHeadlessOutput(result.structured)
      expect(facts?.zcodeSessionId).toMatch(/^sess_/)
      expect(facts?.response.length).toBeGreaterThan(0)
      expect(facts?.rawStdout).toContain('"sessionId"')
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
