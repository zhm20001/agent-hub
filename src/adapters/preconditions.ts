/**
 * zcode launch preconditions in neutral terms: what has to hold *before* a
 * dispatch may start, and what environment that start requires.
 *
 * This module exists so the rule lives in exactly one place. It was previously
 * duplicated in spirit: `src/run.ts` injected the builtin provider config while
 * `src/adapters/zcode.ts` injected nothing, so the same dispatch succeeded on
 * one path and produced an empty stdout (exit 0) on the other. See
 * `.scratch/agent-hub/issues/11a-zcode-precondition-env.md`.
 *
 * Deliberately self-contained: node builtins only, no knowledge of the CLI's
 * argv, of any cordis config surface, or of the engine that consumes it.
 * @module
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Child environment entry that pins the CLI's builtin provider config. The CLI
 * reads it at startup to materialize its active provider registry; without it
 * the CLI exits 0 with a zero-byte stdout.
 */
export const BUILTIN_PROVIDER_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';

/**
 * Neutral name of the precondition declared by the zcode adapter. The platform
 * does not parse it; it only records which requirement was unmet.
 */
export const PROVIDER_CONFIG_PRECONDITION = 'builtin-provider-config';

/**
 * Diagnostic prefix used by every fail-loud message of this package. Duplicated
 * from `src/config.ts` so this module stays free of that module's heavier
 * imports (its dependency graph is not loadable standalone).
 */
const PLUGIN_NAME = 'subagent-zcode';

/**
 * Candidate path of the CLI's builtin provider config in the App packaging
 * layout: the entry lives under `<Resources>/glm/` while the config lives under
 * `<Resources>/config/provider/`, where the CLI's own script-relative
 * candidates both miss.
 * @param zcodeCliPath - absolute path of the CLI entry script.
 * @returns the derived candidate path; whether it exists is the caller's check.
 */
export function defaultBuiltinProviderConfigPath(zcodeCliPath: string): string {
  return resolve(dirname(zcodeCliPath), '..', 'config', 'provider', 'zcode-builtin.json');
}

/**
 * Outcome of resolving the provider-config precondition.
 * - `inject`: the dispatch may start, and these environment entries must reach
 *   the child (empty entries = the CLI resolves its own copy).
 * - `blocked`: the dispatch must not start; `reason` is the mechanical fact.
 */
export type ProviderConfigResolution =
  | { readonly status: 'inject'; readonly env: Readonly<Record<string, string>>; readonly source: 'override' | 'derived' | 'none' }
  | { readonly status: 'blocked'; readonly reason: string };

/**
 * Decide whether the CLI can be started with a usable builtin provider config.
 *
 * The priority mirrors the operator's intent: an explicit path wins; otherwise
 * the CLI's own environment entry is respected; otherwise the App packaging
 * path is derived from the CLI entry. In the last case the derived path must
 * actually exist — the CLI's own script-relative lookup is known to miss it, so
 * a missing file is a precondition failure rather than a "let it try".
 * @param zcodeCliPath - absolute path of the CLI entry script.
 * @param override - operator-configured path, when one was declared.
 * @returns what to inject, or why the dispatch is refused.
 */
export function resolveProviderConfigEnv(
  zcodeCliPath: string,
  override?: string,
): ProviderConfigResolution {
  if (override !== undefined) {
    const declared = resolve(override);
    if (isReadableFile(declared)) {
      return { status: 'inject', env: { [BUILTIN_PROVIDER_CONFIG_ENV]: declared }, source: 'override' };
    }
    return {
      status: 'blocked',
      reason: `declared builtin provider config is not a readable file: ${declared}`,
    };
  }

  const inherited = process.env[BUILTIN_PROVIDER_CONFIG_ENV];
  if (inherited !== undefined && inherited.length > 0) {
    return {
      status: 'inject',
      env: { [BUILTIN_PROVIDER_CONFIG_ENV]: inherited },
      source: 'override',
    };
  }

  const derived = defaultBuiltinProviderConfigPath(zcodeCliPath);
  if (isReadableFile(derived)) {
    return { status: 'inject', env: { [BUILTIN_PROVIDER_CONFIG_ENV]: derived }, source: 'derived' };
  }

  return {
    status: 'blocked',
    reason: `no usable builtin provider config: ${derived} does not exist and no explicit path was declared;`
      + ' the CLI resolves none of its own candidates in this layout, so starting it would exit 0 with an empty stdout',
  };
}

/**
 * A precondition declared by an adapter was not met, so the dispatch never
 * started. The name is the neutral `PreconditionRequirement` name; `reason` is
 * the mechanical fact, safe to show a human.
 */
export class PreconditionUnmetError extends Error {
  /** Neutral precondition name, e.g. `builtin-provider-config`. */
  readonly precondition: string;
  /** Why the precondition failed, in one sentence. */
  readonly reason: string;

  constructor(precondition: string, reason: string) {
    super(`${PLUGIN_NAME}: precondition unmet (${precondition}): ${reason}`);
    this.name = 'PreconditionUnmetError';
    this.precondition = precondition;
    this.reason = reason;
  }
}

/** Whether `path` is an existing, readable regular file. */
function isReadableFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
