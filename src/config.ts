/**
 * @deprecated Face A deployment config (DSH plugin / zcode_dispatch).
 * Live Face B hub settings are plain env vars — see DEMO.md / DISPATCH.md:
 *   AGENT_HUB_TASK_ROOTS, AGENT_HUB_MAX_CONCURRENT, ZCODE_CLI_PATH, PORT.
 * Do not extend this module for the board; keep changes minimal.
 *
 * Deployment-owned configuration of the zcode subagent seam: the CLI entry,
 * the cwd whitelist, the process-level concurrency cap, and the default
 * authority posture. Every field is a validated Config value — nothing that
 * varies by deployment is hardcoded in the runtime.
 * @module @deepseek-ai/dsh-subagent-zcode/config
 */

import { accessSync, constants } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import { defaultZcodeDbPath } from './_legacy_face_a/billing.ts'
import { defaultZcodeLogDir } from './_legacy_face_a/log-tail.ts'
import {
  BUILTIN_PROVIDER_CONFIG_ENV,
  defaultBuiltinProviderConfigPath,
  resolveProviderConfigEnv,
} from './adapters/preconditions.ts'

// The provider-config rule and its neutral precondition name live in
// `adapters/preconditions.ts` — one implementation shared by every dispatch
// path. These re-exports keep the deployment-facing import surface unchanged.
export { BUILTIN_PROVIDER_CONFIG_ENV, defaultBuiltinProviderConfigPath }

/** Diagnostic prefix used by every fail-loud message of this package. */
export const PLUGIN_NAME = 'subagent-zcode'

/** zcode CLI permission modes accepted by `--mode` (its `-p` default is `yolo`). */
export const ZCODE_MODES = ['build', 'edit', 'plan', 'yolo'] as const

/** Profile-selectable zcode CLI permission mode. */
export type ZcodeMode = typeof ZCODE_MODES[number]

/**
 * How a settled zcode completion reaches the owning agent: `followup` opens a
 * turn on an idle owner (a busy owner is injected either way), `quiet` leaves
 * the notice pending until something else wakes the owner.
 */
export type CompletionDelivery = 'followup' | 'quiet'

/** Default process-level cap on concurrent zcode CLI child processes. */
export const DEFAULT_MAX_CONCURRENT = 2

/**
 * Provider ids the billing self-check accepts. The CLI bills the plan the
 * operator's account holds — `account:bigmodel-start-plan` on the Start-plan
 * day pool, `account:bigmodel-individual-coding-plan` on the coding plan
 * measured 2026-10-08 — and falls back to `new-provider` (GLM step-5-preview)
 * once a pool drains, so the default set covers every measured steady state; a
 * drift outside the set means the CLI default model moved and dispatch is
 * refused until the probe closure in ZCODE-CLI-DELEGATION.md re-pins it.
 */
export const DEFAULT_EXPECTED_PROVIDER_IDS = [
  'account:bigmodel-start-plan',
  'account:bigmodel-individual-coding-plan',
  'new-provider',
] as const

/** Deployment-owned settings; see each field's contract. */
export interface Config {
  /**
   * Absolute path of the zcode CLI entry script (the executable `zcode.cjs`
   * with a node shebang). A non-interactive shell cannot rely on PATH or
   * aliases, so there is no default and load fails without it.
   */
  zcodeCliPath: string
  /**
   * Path of the CLI's builtin provider config, injected into every child
   * environment as `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`. Omission derives the
   * App packaging path from {@link zcodeCliPath} (see
   * {@link defaultBuiltinProviderConfigPath}) and injects it only when that
   * file exists, so a layout whose own script-relative lookup succeeds forwards
   * nothing. A configured path that is not a readable file fails at load.
   */
  builtinProviderConfigPath?: string
  /**
   * cwd whitelist roots: the resolved task directory of every dispatch must
   * be one of these roots or inside one. Empty would fence nothing, so it is
   * rejected; omission defaults to the harness process working directory.
   */
  taskRoots?: string[]
  /** Process-level cap on concurrent zcode child processes, follow-up rounds included (default 2). */
  maxConcurrent?: number
  /** Permission mode passed as `--mode` on every dispatch (default `edit`; the CLI's `-p` default is `yolo`). */
  defaultMode?: ZcodeMode
  /** Whole tools removed from the child via `--disallowed-tools` (comma-joined; command patterns do not match). */
  disallowedTools?: string[]
  /** Completion-notice delivery for zcode jobs (default `followup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by zcode completion wakes before the next
   * notice degrades to injection, reset by any user-authored input. Absent by
   * default: every idle completion wakes its owner.
   */
  maxConsecutiveWakes?: number
  /** Expected billing `provider_id`; dispatch refuses on drift (see {@link DEFAULT_EXPECTED_PROVIDER_IDS}). */
  expectedProviderIds?: string[]
  /**
   * Directory of the zcode CLI's own day logs (`YYYY-MM-DD.jsonl`); the
   * observer-facing progress tail reads it. Defaults to the CLI's storage
   * contract under the home directory.
   */
  zcodeLogDir?: string
  /** Path of the zcode billing database the weak self-check reads. Defaults to the CLI's storage contract. */
  zcodeDbPath?: string
}

export const Config: z<Config> = z.object({
  zcodeCliPath: z.string().required(),
  builtinProviderConfigPath: z.string().min(1),
  taskRoots: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  maxConcurrent: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT),
  defaultMode: z.union([...ZCODE_MODES]).default('edit'),
  disallowedTools: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  completionDelivery: z.union(['followup', 'quiet'] as const).default('followup'),
  maxConsecutiveWakes: z.number().step(1).min(1),
  expectedProviderIds: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  zcodeLogDir: z.string().min(1).default(defaultZcodeLogDir()),
  zcodeDbPath: z.string().min(1).default(defaultZcodeDbPath()),
})

/** Validated {@link Config} with every omission resolved; immutable after load. */
export interface ResolvedConfig {
  readonly zcodeCliPath: string
  /**
   * Builtin provider config injected into every child environment, or
   * `undefined` when the CLI resolves its own copy (see
   * {@link Config.builtinProviderConfigPath}).
   */
  readonly builtinProviderConfigPath: string | undefined
  readonly taskRoots: readonly string[]
  readonly maxConcurrent: number
  readonly defaultMode: ZcodeMode
  readonly disallowedTools: readonly string[]
  readonly completionDelivery: CompletionDelivery
  readonly maxConsecutiveWakes: number | undefined
  readonly expectedProviderIds: readonly string[]
  readonly zcodeLogDir: string
  readonly zcodeDbPath: string
}

/**
 * Resolve the builtin provider config path injected into every child. An
 * omitted value derives the App packaging path and stays `undefined` when that
 * file is absent (the CLI's own lookup then applies); an explicitly configured
 * path must be readable, because injecting a missing path would surface as an
 * unreadable registry inside the child instead of at load.
 *
 * The rule itself lives in `adapters/preconditions.ts` so the load-time path and
 * every dispatch-time path agree; this wrapper only turns its two outcomes into
 * the deployment-facing contract (a value, or a fail-loud load error).
 * @param config - the raw loader/direct-apply config.
 * @param zcodeCliPath - the already validated CLI entry path.
 * @returns the path to inject, or `undefined`.
 */
function resolveBuiltinProviderConfigPath(config: Config, zcodeCliPath: string): string | undefined {
  const resolution = resolveProviderConfigEnv(
    zcodeCliPath,
    config.builtinProviderConfigPath === undefined ? undefined : resolve(config.builtinProviderConfigPath),
  )
  if (resolution.status === 'blocked') {
    // An explicit path is the operator's declaration, so a bad one fails load.
    if (config.builtinProviderConfigPath === undefined) return undefined
    throw new Error(`${PLUGIN_NAME}: builtinProviderConfigPath is not a readable file: ${resolve(config.builtinProviderConfigPath)}`)
  }
  return resolution.env[BUILTIN_PROVIDER_CONFIG_ENV]
}

/**
 * Validate the deployment config at load: reject a missing or non-executable
 * CLI entry, an unreadable builtin provider config path, an empty whitelist,
 * and out-of-range numbers before anything registers (fail loud at the earliest
 * resolvable point).
 * @param config - the raw loader/direct-apply config.
 * @returns the resolved immutable config.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const zcodeCliPath = config.zcodeCliPath
  if (!isAbsolute(zcodeCliPath)) {
    throw new Error(`${PLUGIN_NAME}: zcodeCliPath must be an absolute path: ${zcodeCliPath}`)
  }
  try {
    accessSync(zcodeCliPath, constants.X_OK)
  } catch {
    throw new Error(
      `${PLUGIN_NAME}: zcodeCliPath is not an executable file: ${zcodeCliPath}`
        + ' — configure the full path to the zcode CLI entry (e.g. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs)',
    )
  }
  const taskRoots = (config.taskRoots ?? [process.cwd()]).map(root => resolve(root))
  if (taskRoots.length === 0) {
    throw new Error(
      `${PLUGIN_NAME}: taskRoots must not be empty — an empty whitelist fences nothing;`
        + ' omit the key to default to the harness working directory',
    )
  }
  for (const root of taskRoots) {
    assertUsableCwd(PLUGIN_NAME, 'taskRoot', root)
  }
  const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`${PLUGIN_NAME}: maxConcurrent (${maxConcurrent}) must be a whole number >= 1`)
  }
  const completionDelivery = config.completionDelivery ?? 'followup'
  // Direct apply bypasses the schema union, so the runtime check reads the
  // value as a plain string and rejects anything the union does not name.
  const delivery: string = completionDelivery
  if (delivery !== 'followup' && delivery !== 'quiet') {
    throw new Error(`${PLUGIN_NAME}: completionDelivery must be 'followup' or 'quiet'`)
  }
  const defaultMode = config.defaultMode ?? 'edit'
  if (!(ZCODE_MODES as readonly string[]).includes(defaultMode)) {
    throw new Error(`${PLUGIN_NAME}: defaultMode must be one of ${ZCODE_MODES.join(', ')}`)
  }
  const maxConsecutiveWakes = config.maxConsecutiveWakes
  if (maxConsecutiveWakes !== undefined && !Number.isSafeInteger(maxConsecutiveWakes)) {
    throw new Error(`${PLUGIN_NAME}: maxConsecutiveWakes (${maxConsecutiveWakes}) must be a whole number of turns`)
  }
  const expectedProviderIds = config.expectedProviderIds ?? DEFAULT_EXPECTED_PROVIDER_IDS
  if (expectedProviderIds.length === 0) {
    throw new Error(`${PLUGIN_NAME}: expectedProviderIds must not be empty — an empty set fences nothing`)
  }
  if (expectedProviderIds.some(id => id.length === 0)) {
    throw new Error(`${PLUGIN_NAME}: expectedProviderIds must not contain an empty provider id`)
  }
  const zcodeLogDir = config.zcodeLogDir ?? defaultZcodeLogDir()
  const zcodeDbPath = config.zcodeDbPath ?? defaultZcodeDbPath()
  if (!isAbsolute(zcodeLogDir)) {
    throw new Error(`${PLUGIN_NAME}: zcodeLogDir must be an absolute path: ${zcodeLogDir}`)
  }
  return {
    zcodeCliPath,
    builtinProviderConfigPath: resolveBuiltinProviderConfigPath(config, zcodeCliPath),
    taskRoots,
    maxConcurrent,
    defaultMode,
    disallowedTools: config.disallowedTools ?? [],
    completionDelivery,
    maxConsecutiveWakes,
    expectedProviderIds,
    zcodeLogDir,
    zcodeDbPath,
  }
}

/**
 * Assert a resolved task directory sits inside the configured whitelist.
 * @param cwd - the resolved absolute task directory.
 * @param roots - the load-resolved absolute whitelist roots.
 * @throws when the directory is neither a root nor inside one — the dispatch
 * must surface this as its own tool error, never as a silently widened cwd.
 */
export function assertInsideTaskRoots(cwd: string, roots: readonly string[]): void {
  const resolved = resolve(cwd)
  const inside = roots.some(root => resolved === root || resolved.startsWith(`${root}${sep}`))
  if (!inside) {
    throw new Error(
      `${PLUGIN_NAME}: task directory ${cwd} is outside every configured taskRoot (${roots.join(', ')})`
        + ' — add the directory (or a parent root) to taskRoots in cordis.yml',
    )
  }
}
