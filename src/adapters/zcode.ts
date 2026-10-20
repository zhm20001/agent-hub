import { parseZcodeTranscript } from './transcript-format.ts';
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkerAdapter, AdapterCommandSpec, AdapterCommandResult, AdapterEnvDelta } from './base.ts';
import type { AdapterRawOutput, AdapterTranslation, AdapterUsage, FinalText } from './contract.ts';
import { locateZcodeTranscript } from './zcode-transcript.ts';
import {
  PROVIDER_CONFIG_PRECONDITION,
  PreconditionUnmetError,
  resolveProviderConfigEnv,
} from './preconditions.ts';

/** Named precondition: a real CLI entry must be resolvable before spawn. */
export const CLI_PATH_PRECONDITION = 'cli-path';

/**
 * Resolve the zcode CLI entry for a real dispatch.
 * Accepts an explicit path (tests inject fixtures this way) or `ZCODE_CLI_PATH`.
 * Never falls back to `tests/fixtures/fake-zcode.cjs` — missing path fails loud.
 */
function isCliFile(path: string): boolean {
  try { if (!statSync(path).isFile()) return false; accessSync(path, /\.c?js$/.test(path) ? constants.R_OK : constants.X_OK); return true; } catch { return false; }
}

export function resolveZcodeCliPath(explicit?: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (explicit !== undefined && explicit.length > 0) {
    if (isCliFile(explicit)) return { ok: true, path: resolve(explicit) };
    return {
      ok: false,
      reason: `declared zcode CLI path is not a readable file: ${explicit}`,
    };
  }
  const fromEnv = process.env.ZCODE_CLI_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (isCliFile(fromEnv)) return { ok: true, path: resolve(fromEnv) };
    return {
      ok: false,
      reason: `ZCODE_CLI_PATH is set but not a readable file: ${fromEnv}`,
    };
  }
  return {
    ok: false,
    reason: 'ZCODE_CLI_PATH is missing; set it to the absolute path of the zcode CLI entry '
      + '(e.g. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs). '
      + 'Production/dispatch paths do not fall back to tests/fixtures.',
  };
}

export class ZCodeAdapter implements WorkerAdapter {
  readonly parseTranscript = parseZcodeTranscript;
  readonly name = 'zcode';
  readonly description = 'ZCode headless CLI subagent with structured json and resume rounds';
  readonly locateTranscript = locateZcodeTranscript;

  /**
   * The CLI cannot start without its provider config: without one it exits 0
   * with a zero-byte stdout, which downstream reads as "the output is not
   * JSON" instead of "the run never started". Declaring it here makes the
   * failure a named precondition, and `checkPreconditions()` answers whether
   * this particular dispatch can start.
   *
   * `cli-path` is checked first: without a resolvable CLI entry nothing may spawn.
   */
  readonly preconditions = [CLI_PATH_PRECONDITION, PROVIDER_CONFIG_PRECONDITION] as const;

  private cliPath: string;
  private cliPathError: string | null;

  constructor(cliPath?: string) {
    const resolved = resolveZcodeCliPath(cliPath);
    if (resolved.ok === true) {
      this.cliPath = resolved.path;
      this.cliPathError = null;
    } else {
      this.cliPath = '';
      this.cliPathError = resolved.reason;
    }
  }

  /**
   * Environment the CLI needs on top of the inherited one. This is the entry
   * that Face A injected while this path injected nothing — the drift that made
   * every dispatch here produce an empty stdout.
   */
  adapterEnv(): readonly AdapterEnvDelta[] {
    if (this.cliPathError !== null || !this.cliPath) return [];
    const resolution = resolveProviderConfigEnv(this.cliPath);
    if (resolution.status === 'blocked') return [];
    return Object.entries(resolution.env).map(([key, value]) => ({ key, value }));
  }

  checkPreconditions(): void {
    if (this.cliPathError !== null) {
      throw new PreconditionUnmetError(CLI_PATH_PRECONDITION, this.cliPathError);
    }
    if (!isCliFile(this.cliPath)) throw new PreconditionUnmetError(CLI_PATH_PRECONDITION, `ZCode CLI path is no longer usable: ${this.cliPath}`);
    const resolution = resolveProviderConfigEnv(this.cliPath);
    if (resolution.status === 'blocked') {
      throw new PreconditionUnmetError(PROVIDER_CONFIG_PRECONDITION, resolution.reason);
    }
  }

  buildCommand(spec: AdapterCommandSpec): AdapterCommandResult {
    const isNodeScript = this.cliPath.endsWith('.cjs') || this.cliPath.endsWith('.js');
    const cmd = isNodeScript ? 'node' : this.cliPath;
    const baseArgs: string[] = isNodeScript ? [this.cliPath] : [];

    const args: string[] = [...baseArgs];

    if (spec.resumeSessionId) {
      args.push('--resume', spec.resumeSessionId);
    }

    args.push('-p', spec.prompt);
    args.push('--json');
    args.push('--cwd', spec.cwd);
    args.push('--mode', spec.mode || 'edit');

    if (spec.disallowedTools && spec.disallowedTools.length > 0) {
      args.push('--disallowed-tools', spec.disallowedTools.join(','));
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const { key, value } of this.adapterEnv()) {
      env[key] = value;
    }
    // Tests may inject the fixture path explicitly; never auto-selected in prod.
    if (this.cliPath.endsWith('fake-zcode.cjs') || this.cliPath.endsWith('fake-faceb-zcode.cjs')) {
      env.FAKE_ZCODE_BEHAVIOR = env.FAKE_ZCODE_BEHAVIOR || 'ok';
      env.FAKE_ZCODE_DELAY_MS = process.env.FAKE_ZCODE_DELAY_MS || '2500';
      env.FAKE_ZCODE_RESPONSE = env.FAKE_ZCODE_RESPONSE
        || `ZCode task processed: "${spec.prompt.slice(0, 50)}..."`;
    }

    return { cmd, args, env };
  }

  /**
   * Translate the finished run. The hard case is that this CLI is not required
   * to say anything: with no usable provider config it exits 0 with an empty
   * stdout, and a dead `--resume` handle exits 1 with an empty stdout plus a
   * stderr line. Both were previously reported downstream as "the output is not
   * JSON"; here they become two different mechanical facts:
   *   - exited non-zero           → `process-exited-nonzero (exit=N)`
   *   - exited 0, nothing on stdout → `no-output`
   * An unmet precondition never reaches this method at all: the engine refuses
   * the dispatch before spawning (see `preconditions.ts`).
   */
  translate(raw: AdapterRawOutput): AdapterTranslation {
    const result = extractResultObject(raw.output);

    if (result === undefined) {
      return {
        producedOutput: false,
        finalText: { kind: 'empty' },
        stopCause: raw.exitCode !== null && raw.exitCode !== 0
          ? `process-exited-nonzero (exit=${raw.exitCode})`
          : visibleLength(raw.output) > 0 ? 'output-not-translatable' : 'no-output',
      };
    }

    const sessionId = typeof result['sessionId'] === 'string' && result['sessionId'].length > 0
      ? result['sessionId']
      : undefined;
    const response = result['response'];

    // Raw output exists (the CLI reported a result), so `producedOutput` is true
    // even when the message itself is empty — the two empties are told apart in
    // `RunObservation`, never here (contract §5).
    const translation: {
      producedOutput: boolean;
      finalText: FinalText;
      stopCause?: string;
      sessionRef?: { provenance: string; handle: string };
      transcriptRef?: { provenance: string; handle: string };
      usage?: AdapterUsage;
    } = {
      producedOutput: true,
      finalText: typeof response === 'string' && response.length > 0
        ? { kind: 'text', value: response }
        : { kind: 'empty' },
    };

    if (typeof response !== 'string') {
      translation.stopCause = 'output-not-translatable';
    }
    if (sessionId !== undefined) {
      // Same value for both refs is an implementation fact, not a shared type:
      // SessionRef answers "how do I continue", TranscriptRef "where is the原文".
      translation.sessionRef = { provenance: this.name, handle: sessionId };
      translation.transcriptRef = { provenance: this.name, handle: sessionId };
    }

    const usage = parseUsage(result['usage']);
    if (usage !== undefined) translation.usage = usage;

    return translation;
  }
}

/** Characters in `text` that are not whitespace. */
function visibleLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/**
 * Find the CLI's result object in the combined process output.
 *
 * Two measured shapes make this more than a `JSON.parse`:
 *   - the result is **pretty-printed across ~26 lines**, not one line (verified
 *     against the real CLI on 2026-10-11, ticket 11c);
 *   - stdout and stderr share one log here, and the CLI writes warnings to
 *     stderr (`ZCode Built-in missing`) that may land before the result.
 * So every brace-balanced object in the text is considered, and the result is
 * the last one carrying a non-empty string `sessionId`; failing that, the last
 * object at all (a result missing its handle is still raw output).
 *
 * This heuristic is a Face B implementation detail — the CLI-dialect convergence
 * that would let both faces share one parser is ticket #07's work, not this
 * function's.
 */
function extractResultObject(output: string): Record<string, unknown> | undefined {
  const candidates = findJsonObjects(output);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const sessionId = candidates[index]['sessionId'];
    if (typeof sessionId === 'string' && sessionId.length > 0) return candidates[index];
  }
  return candidates.length === 0 ? undefined : candidates[candidates.length - 1];
}

/** Every brace-balanced JSON object embedded in `text`, in order of appearance. */
function findJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let at = text.indexOf('{');
  while (at >= 0) {
    const end = matchingBrace(text, at);
    if (end > at) {
      try {
        const parsed: unknown = JSON.parse(text.slice(at, end + 1));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          objects.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Not JSON after all (a stray brace in a log line); keep scanning.
      }
    }
    at = text.indexOf('{', at + 1);
  }
  return objects;
}

/**
 * Index of the `}` matching the `{` at `start`, ignoring braces inside string
 * literals. Returns -1 when the braces never balance.
 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Token accounting, when the CLI reported a usable total. */
function parseUsage(value: unknown): AdapterUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const total = (value as Record<string, unknown>)['totalTokens'];
  if (typeof total !== 'number' || !Number.isFinite(total)) return undefined;
  return { tokens: { total, completeness: 'exact' } };
}
