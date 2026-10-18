import { parseCodexTranscript } from './transcript-format.ts';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { WorkerAdapter, AdapterCommandSpec, AdapterCommandResult } from './base.ts';
import type { AdapterRawOutput, AdapterTranslation, AdapterUsage, FinalText } from './contract.ts';
import { PreconditionUnmetError } from './preconditions.ts';

/** Named precondition: a real CLI binary must be resolvable before spawn. */
export const CLI_PATH_PRECONDITION = 'cli-path';

/** Named precondition: Codex auth file must exist (existence only; never read). */
export const AUTH_FILE_PRECONDITION = 'auth-file';

/** ChatGPT.app-bundled Codex CLI (prefer when CODEX_CLI_PATH is unset). */
export const CHATGPT_CODEX_CLI_PATH =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/**
 * Whether `path` looks usable as a CLI entry: exists, and is executable (or a
 * readable `.js`/`.cjs` that we launch via `node`). Auth stays existence-only.
 */
function isUsableCliPath(path: string): boolean {
  if (!existsSync(path)) return false;
  const mode = path.endsWith('.cjs') || path.endsWith('.js')
    ? constants.R_OK
    : constants.X_OK;
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

const KNOWN_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

/**
 * Resolve the Codex CLI binary for a real dispatch.
 * Order: explicit path → `CODEX_CLI_PATH` → ChatGPT.app bundle → `codex` on PATH.
 * Never falls back to `tests/fixtures` — missing path fails loud.
 */
export function resolveCodexCliPath(explicit?: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (explicit !== undefined && explicit.length > 0) {
    if (isUsableCliPath(explicit)) return { ok: true, path: resolve(explicit) };
    return {
      ok: false,
      reason: `declared Codex CLI path is not a usable executable (or readable .js/.cjs): ${explicit}`,
    };
  }
  const fromEnv = process.env.CODEX_CLI_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (isUsableCliPath(fromEnv)) return { ok: true, path: resolve(fromEnv) };
    return {
      ok: false,
      reason: `CODEX_CLI_PATH is set but not a usable executable (or readable .js/.cjs): ${fromEnv}`,
    };
  }
  if (isUsableCliPath(CHATGPT_CODEX_CLI_PATH)) {
    return { ok: true, path: CHATGPT_CODEX_CLI_PATH };
  }
  const fromPath = findOnPath('codex');
  if (fromPath !== null) return { ok: true, path: fromPath };
  return {
    ok: false,
    reason: 'Codex CLI not found: set CODEX_CLI_PATH to an absolute binary path '
      + `(prefer ≥0.162), or install ChatGPT.app's bundled CLI at ${CHATGPT_CODEX_CLI_PATH}, `
      + 'or put `codex` on PATH. Production/dispatch paths do not fall back to tests/fixtures.',
  };
}

/** Absolute path of the auth file whose existence we require (never read). */
export function resolveCodexAuthPath(): string {
  const home = process.env.CODEX_HOME;
  if (home !== undefined && home.length > 0) return join(home, 'auth.json');
  return join(homedir(), '.codex', 'auth.json');
}

/**
 * Map Hub mode → Codex `-s` sandbox. Raw sandbox names pass through.
 * `yolo` also requires `--dangerously-bypass-approvals-and-sandbox` (see buildCommand).
 */
export function mapModeToSandbox(mode: string | undefined): {
  sandbox: string;
  bypassApprovalsAndSandbox: boolean;
} {
  const raw = (mode ?? 'edit').trim();
  if (raw === 'yolo') {
    return { sandbox: 'danger-full-access', bypassApprovalsAndSandbox: true };
  }
  if (raw === 'plan') {
    return { sandbox: 'read-only', bypassApprovalsAndSandbox: false };
  }
  if (raw === 'edit' || raw === 'build' || raw === 'default' || raw.length === 0) {
    return { sandbox: 'workspace-write', bypassApprovalsAndSandbox: false };
  }
  if (KNOWN_SANDBOXES.has(raw)) {
    return { sandbox: raw, bypassApprovalsAndSandbox: false };
  }
  // Unknown mode string: treat as raw sandbox name passthrough (CLI will reject if invalid).
  return { sandbox: raw, bypassApprovalsAndSandbox: false };
}

export class CodexAdapter implements WorkerAdapter {
  readonly parseTranscript = parseCodexTranscript;
  readonly name = 'codex';
  readonly description = 'OpenAI Codex CLI (exec --json) with sandbox modes and resume';

  readonly preconditions = [CLI_PATH_PRECONDITION, AUTH_FILE_PRECONDITION] as const;

  private cliPath: string;
  private cliPathError: string | null;

  constructor(cliPath?: string) {
    const resolved = resolveCodexCliPath(cliPath);
    if (resolved.ok === true) {
      this.cliPath = resolved.path;
      this.cliPathError = null;
    } else {
      this.cliPath = '';
      this.cliPathError = resolved.reason;
    }
  }

  checkPreconditions(): void {
    if (this.cliPathError !== null) {
      throw new PreconditionUnmetError(CLI_PATH_PRECONDITION, this.cliPathError);
    }
    // Recheck at dispatch time — binary may have been removed after construction.
    if (!isUsableCliPath(this.cliPath)) {
      throw new PreconditionUnmetError(
        CLI_PATH_PRECONDITION,
        `Codex CLI path is no longer usable: ${this.cliPath}`,
      );
    }
    const authPath = resolveCodexAuthPath();
    if (!existsSync(authPath)) {
      throw new PreconditionUnmetError(
        AUTH_FILE_PRECONDITION,
        `Codex auth file does not exist: ${authPath} `
          + '(checked existence only; set CODEX_HOME or place auth at ~/.codex/auth.json)',
      );
    }
  }

  buildCommand(spec: AdapterCommandSpec): AdapterCommandResult {
    const isNodeScript = this.cliPath.endsWith('.cjs') || this.cliPath.endsWith('.js');
    const cmd = isNodeScript ? 'node' : this.cliPath;
    const baseArgs: string[] = isNodeScript ? [this.cliPath] : [];

    const { sandbox, bypassApprovalsAndSandbox } = mapModeToSandbox(spec.mode);
    const args: string[] = [...baseArgs, 'exec'];

    // Shared exec options before subcommand / prompt. NEVER pass `-p` for prompt
    // (`-p` is --profile on Codex).
    args.push('-C', spec.cwd);
    args.push('-s', sandbox);
    args.push('--skip-git-repo-check');
    if (bypassApprovalsAndSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    // `disallowedTools` is intentionally not forwarded: Codex has no clear
    // `exec` CLI flag equivalent (tool allow/deny lives in config.toml).
    if (spec.resumeSessionId) {
      // resume: `codex exec … resume --json <id> -- <prompt>` (same `--` as fresh)
      args.push('resume', '--json', spec.resumeSessionId, '--', spec.prompt);
    } else {
      // fresh: `codex exec --json -C … -s … --skip-git-repo-check [--] <prompt>`
      args.push('--json', '--', spec.prompt);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.cliPath.endsWith('fake-codex.cjs')) {
      env.FAKE_CODEX_BEHAVIOR = env.FAKE_CODEX_BEHAVIOR || 'ok';
      env.FAKE_CODEX_DELAY_MS = process.env.FAKE_CODEX_DELAY_MS || '2500';
      env.FAKE_CODEX_RESPONSE = env.FAKE_CODEX_RESPONSE
        || `Codex task processed: "${spec.prompt.slice(0, 50)}..."`;
    }

    return { cmd, args, env };
  }

  /**
   * Translate Codex `exec --json` JSONL. Mechanical facts only — no verdict.
   * sessionRef from `thread.started.thread_id`; finalText from last
   * `item.completed` with `item.type==='agent_message'`; usage from
   * `turn.completed.usage` when present (exact only).
   */
  translate(raw: AdapterRawOutput): AdapterTranslation {
    const events = parseJsonlEvents(raw.output);

    if (events.length === 0) {
      return {
        producedOutput: false,
        finalText: { kind: 'empty' },
        stopCause: raw.exitCode !== null && raw.exitCode !== 0
          ? `process-exited-nonzero (exit=${raw.exitCode})`
          : visibleLength(raw.output) > 0 ? 'output-not-translatable' : 'no-output',
      };
    }

    let threadId: string | undefined;
    let lastAgentText: string | undefined;
    let usage: AdapterUsage | undefined;
    let turnFailed = false;
    let turnCompleted = false;

    for (const event of events) {
      const type = event['type'];
      if (type === 'thread.started') {
        const id = event['thread_id'];
        if (typeof id === 'string' && id.length > 0) threadId = id;
        continue;
      }
      if (type === 'item.completed') {
        const item = event['item'];
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const itemObj = item as Record<string, unknown>;
          if (itemObj['type'] === 'agent_message' && typeof itemObj['text'] === 'string') {
            lastAgentText = itemObj['text'];
          }
        }
        continue;
      }
      if (type === 'turn.completed') {
        turnCompleted = true;
        const parsed = parseCodexUsage(event['usage']);
        if (parsed !== undefined) usage = parsed;
        continue;
      }
      if (type === 'turn.failed') {
        turnFailed = true;
        continue;
      }
      // `error` reconnect messages and other transient lines are tolerated — ignored.
    }

    const finalText: FinalText = typeof lastAgentText === 'string' && lastAgentText.length > 0
      ? { kind: 'text', value: lastAgentText }
      : { kind: 'empty' };

    const translation: {
      producedOutput: boolean;
      finalText: FinalText;
      stopCause?: string;
      sessionRef?: { provenance: string; handle: string };
      transcriptRef?: { provenance: string; handle: string };
      usage?: AdapterUsage;
    } = {
      // Any parsed JSONL event means the CLI reported structured output.
      producedOutput: true,
      finalText,
    };

    if (threadId !== undefined) {
      translation.sessionRef = { provenance: this.name, handle: threadId };
      translation.transcriptRef = { provenance: this.name, handle: threadId };
    }

    if (usage !== undefined) translation.usage = usage;

    if (turnFailed) {
      translation.stopCause = 'failed';
    } else if (raw.exitCode !== null && raw.exitCode !== 0) {
      translation.stopCause = `process-exited-nonzero (exit=${raw.exitCode})`;
    } else if (!(turnCompleted && typeof lastAgentText === 'string' && lastAgentText.length > 0)) {
      // Structured output without a completed agent turn — mechanical, not a verdict.
      if (!turnCompleted && !turnFailed) {
        translation.stopCause = 'output-not-translatable';
      }
    }

    return translation;
  }
}

/** Characters in `text` that are not whitespace. */
function visibleLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** Parse combined stdout/stderr as JSONL events; skip non-JSON lines. */
function parseJsonlEvents(output: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== '{') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // stray brace / partial line — keep scanning
    }
  }
  return events;
}

/**
 * Exact token total from `turn.completed.usage` when input/output counts are present.
 * cached_* is not added separately (typically a subset of input_tokens).
 */
function parseCodexUsage(value: unknown): AdapterUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const u = value as Record<string, unknown>;
  const input = u['input_tokens'];
  const output = u['output_tokens'];
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined;
  if (typeof output !== 'number' || !Number.isFinite(output)) return undefined;
  let total = input + output;
  const reasoning = u['reasoning_output_tokens'];
  if (typeof reasoning === 'number' && Number.isFinite(reasoning)) total += reasoning;
  return { tokens: { total, completeness: 'exact' } };
}

/** First matching executable named `name` on PATH, or null. */
function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH;
  if (pathEnv === undefined || pathEnv.length === 0) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    if (isUsableCliPath(candidate)) return candidate;
  }
  return null;
}
