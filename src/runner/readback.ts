/**
 * Transcript readback: open the original conversation of one run, given its
 * {@link TranscriptRef}.
 *
 * The contract promises **可定位**, never 能渲染 — so nothing here is allowed to
 * become a second copy of the transcript: the messages are passed through
 * untouched, and the joined text is a convenience for the human running the
 * readback, never persisted.
 *
 * The route (established by ticket 11b, zero model calls) is the agent's own
 * app-server over stdio as NDJSON:
 *   1. start `app-server --stdio`,
 *   2. `session/resume <id>` — **materializes state; it does not run the model**
 *      (this is not the CLI's `--resume`, which does),
 *   3. `session/messages <id>` — the transcript snapshot,
 *   4. answer the server's own `session/requestRuntimePreferences` callback; it
 *      stalls the RPC for 15s otherwise.
 *
 * @module
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TranscriptRef } from '../adapters/contract.ts';
import { resolveProviderConfigEnv } from '../adapters/preconditions.ts';

/** The result of opening one transcript. Shape only — the platform stores none of it. */
export interface TranscriptReadback {
  readonly ref: TranscriptRef;
  /** Messages exactly as the agent's app-server returned them. Not parsed, not summarized. */
  readonly messages: readonly unknown[];
  /** `text` parts in order — the human-facing projection. */
  readonly textParts: readonly string[];
  /** {@link textParts} joined by a blank line. */
  readonly text: string;
}

/** The transcript could not be opened. `reason` is mechanical, safe to show a human. */
export class TranscriptUnavailableError extends Error {
  /** JSON-RPC error code, when the agent answered with one. */
  readonly code: number | undefined;

  constructor(reason: string, code?: number) {
    super(`transcript unavailable: ${reason}`);
    this.name = 'TranscriptUnavailableError';
    this.code = code;
  }
}

/** Options for {@link readTranscript}. */
export interface ReadTranscriptOptions {
  /** Absolute path of the agent CLI entry. Defaults to `ZCODE_CLI_PATH`. */
  readonly cliPath?: string;
  /** Extra environment for the app-server (test seam and operator overrides). */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory of the app-server process. */
  readonly cwd?: string;
  /** Per-request timeout. The real resume of an archived session can take tens of seconds. */
  readonly timeoutMs?: number;
}

/** Default per-request timeout: 11b measured an archived-session resume at ~40s worst case. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** How much stderr to keep for error messages. */
const STDERR_KEEP = 4_000;

/**
 * Open the transcript behind `ref`.
 *
 * Returns `undefined` — not a failure — when this platform has no readback route
 * for that provenance, mirroring the contract's "取不到即缺省". Once the
 * provenance *is* supported, any failure to reach the original conversation
 * throws {@link TranscriptUnavailableError} with the mechanical reason: "取不到"
 * must be reported, never papered over with a plausible-looking empty result.
 * @param ref - the opaque transcript pointer recorded at settlement time.
 * @param options - CLI path, environment, cwd, timeout.
 * @returns the transcript, or `undefined` for an unsupported provenance.
 */
export async function readTranscript(
  ref: TranscriptRef,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptReadback | undefined> {
  if (ref.provenance !== 'zcode') return undefined;
  return readZcodeTranscript(ref, options);
}

async function readZcodeTranscript(
  ref: TranscriptRef,
  options: ReadTranscriptOptions,
): Promise<TranscriptReadback> {
  const cliPath = options.cliPath ?? process.env.ZCODE_CLI_PATH;
  if (cliPath === undefined || cliPath.length === 0) {
    throw new TranscriptUnavailableError(
      'no zcode CLI entry: set ZCODE_CLI_PATH or pass cliPath (the engine that dispatched this run knew it)',
    );
  }

  // The app-server needs the same provider config the CLI does; reuse the one
  // rule rather than restating it (ticket 11a).
  const provider = resolveProviderConfigEnv(cliPath);
  if (provider.status === 'blocked') {
    throw new TranscriptUnavailableError(`cannot start the app-server: ${provider.reason}`);
  }

  const child = spawn(process.execPath, [cliPath, 'app-server', '--stdio'], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env, ...provider.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const client = new AppServerClient(child, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    await client.request('session/resume', { sessionId: ref.handle });
    const result = await client.request('session/messages', { sessionId: ref.handle, limit: 200 });
    const messages = asMessages(result);
    const textParts = collectTextParts(messages);
    return { ref, messages, textParts, text: textParts.join('\n\n') };
  } finally {
    client.dispose();
  }
}

/** A `{messages: [...]}` result, or a refusal naming what came back instead. */
function asMessages(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new TranscriptUnavailableError('the agent returned no messages object');
  }
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    throw new TranscriptUnavailableError('the agent returned no messages array');
  }
  return messages;
}

/** Every `text` part's text, in the order the agent returned them. */
function collectTextParts(messages: readonly unknown[]): string[] {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const messageParts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(messageParts)) continue;
    for (const part of messageParts) {
      if (typeof part !== 'object' || part === null) continue;
      const { type, text } = part as { type?: unknown; text?: unknown };
      if (type === 'text' && typeof text === 'string') parts.push(text);
    }
  }
  return parts;
}

/**
 * Minimal client for the agent's JSON-RPC-over-stdio server.
 *
 * Two measured protocol facts (11b §8.1) are load-bearing here:
 *   - the envelope is bare — a `jsonrpc` key is rejected by the server's schema;
 *   - the server makes requests of its own, which must be answered or the RPC
 *     that triggered them times out.
 */
class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private stderr = '';
  private nextId = 1;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP); });
    child.on('error', (error) => this.failAll(error));
    child.on('close', (code, signal) => {
      this.failAll(new TranscriptUnavailableError(
        `the agent exited before answering (code=${code ?? 'null'} signal=${signal ?? 'null'})`
          + (this.stderr.trim().length === 0 ? '' : `: ${lastLine(this.stderr)}`),
      ));
    });
  }

  /** Send one request and wait for its response. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new TranscriptUnavailableError('the app-server connection is closed'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TranscriptUnavailableError(`the agent did not answer ${method} within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  /** Stop the server. Idempotent; never throws. */
  dispose(): void {
    this.failAll(new TranscriptUnavailableError('the readback finished before the agent answered'));
    try { this.child.kill('SIGTERM'); } catch {}
    // The app-server may ignore SIGTERM while idle; do not hold the caller open.
    const force = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 1_500);
    force.unref?.();
  }

  private write(frame: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.failAll(new TranscriptUnavailableError(`could not write to the agent: ${(error as Error).message}`));
    }
  }

  /** Split the NDJSON stream and dispatch one frame at a time. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // stdout is protocol-only; an unparsable line is not ours to interpret
    }
    if (typeof frame !== 'object' || frame === null) return;
    const { id, method, result, error } = frame as {
      id?: unknown; method?: unknown; result?: unknown;
      error?: { code?: number; message?: string };
    };

    if (method !== undefined && id !== undefined) {
      this.answerServerRequest(id, String(method));
      return;
    }
    if (typeof id !== 'number') return;
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (error !== undefined) {
      waiter.reject(new TranscriptUnavailableError(error.message ?? 'the agent refused the request', error.code));
      return;
    }
    waiter.resolve(result);
  }

  /**
   * The server asks the client about runtime preferences while materializing a
   * session. Only `nativeSearchEnhancementsEnabled` has been proven to be
   * required, and the response schema is strict (extra keys are rejected); the
   * full schema for `scope: 'user-execution'` is still unproven (11b §11.2), so
   * every scope gets this same minimal body until something real contradicts it.
   */
  private answerServerRequest(id: unknown, method: string): void {
    if (method === 'session/requestRuntimePreferences') {
      this.write({ id, result: { nativeSearchEnhancementsEnabled: false } });
      return;
    }
    this.write({ id, error: { code: -32601, message: `client does not implement ${method}` } });
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

/** Last non-empty line of a diagnostic stream. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length === 0 ? '' : lines[lines.length - 1];
}
