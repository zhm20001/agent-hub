/** ZCode-owned disk layout and interrupted-run discovery. Never starts a CLI. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptRef } from './contract.ts';
import type { TranscriptLookup, LocatedTranscript } from './base.ts';

export function locateZcodeTranscript(input: TranscriptLookup): LocatedTranscript | null {
  if ([input.transcriptRef, input.sessionRef].some(ref => ref && ref.provenance !== 'zcode')) return null;
  const found = discoverRolloutTranscript({
    home: input.home,
    sessionId: input.transcriptRef?.handle ?? input.sessionRef?.handle ?? input.sessionId,
    startTimeMs: input.interrupted?.startTimeMs,
    endTimeMs: input.interrupted?.endTimeMs,
  });
  if (found === null) return null;
  return {
    path: found.path,
    transcriptRef: { provenance: 'zcode', handle: found.sessionId },
    sessionRef: { provenance: 'zcode', handle: found.sessionId },
    via: found.via,
  };
}

/**
 * Resolve an on-disk conversation JSON/JSONL path from a transcriptRef, without
 * calling the live CLI. Returns `null` when nothing is on disk yet.
 */
function resolveTranscriptPath(
  ref: TranscriptRef | undefined,
  options: { readonly home?: string } = {},
): string | null {
  if (ref === undefined) return null;
  if (ref.provenance !== 'zcode') return null;

  const home = options.home ?? homedir();
  const handle = ref.handle;
  if (typeof handle !== 'string' || handle.length === 0) return null;

  const candidates: string[] = [
    join(home, '.zcode', 'cli', 'rollout', `model-io-${handle}.jsonl`),
    join(home, '.zcode', 'cli', 'agents', handle, 'transcript.jsonl'),
  ];

  for (const path of candidates) {
    if (existsSync(path) && statSync(path).isFile()) return path;
  }

  // Nested agent dirs: ~/.zcode/cli/agents/<parent>/agent_*/transcript.jsonl
  // where metadata.childSessionId === handle, or the parent dir is the handle.
  const agentsRoot = join(home, '.zcode', 'cli', 'agents');
  if (!existsSync(agentsRoot)) return null;

  const direct = join(agentsRoot, handle);
  const nested = findTranscriptUnder(direct);
  if (nested !== null) return nested;

  // Scan a shallow set of sess_* dirs for metadata.childSessionId match.
  try {
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('sess_')) continue;
      const sessDir = join(agentsRoot, entry.name);
      for (const child of readdirSync(sessDir, { withFileTypes: true })) {
        if (!child.isDirectory() || !child.name.startsWith('agent_')) continue;
        const agentDir = join(sessDir, child.name);
        const metaPath = join(agentDir, 'metadata.json');
        if (!existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { childSessionId?: unknown };
          if (meta.childSessionId === handle) {
            const transcript = join(agentDir, 'transcript.jsonl');
            if (existsSync(transcript)) return transcript;
          }
        } catch {
          // ignore unreadable metadata
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function findTranscriptUnder(dir: string): string | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const direct = join(dir, 'transcript.jsonl');
  if (existsSync(direct)) return direct;
  try {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = join(dir, child.name, 'transcript.jsonl');
      if (existsSync(nested)) return nested;
    }
  } catch {
    return null;
  }
  return null;
}

/** Filename pattern: model-io-sess_<uuid>.jsonl → sess_<uuid> */
const ROLLOUT_FILE_RE = /^model-io-(sess_[A-Za-z0-9_-]+)\.jsonl$/;

/** Default slack around task window when matching rollout mtime (45 minutes). */
const ROLLOUT_PROXIMITY_SLACK_MS = 45 * 60 * 1000;

interface DiscoverRolloutOptions {
  readonly home?: string;
  /** Explicit session id (meta.sessionId or transcriptRef.handle). */
  readonly sessionId?: string | null;
  /** Task start epoch-ms (meta.startTime). */
  readonly startTimeMs?: number | null;
  /** Task end epoch-ms (meta.endTime); falls back to start + timeout when absent. */
  readonly endTimeMs?: number | null;
  /** How far outside [start, end] mtime may fall (default {@link ROLLOUT_PROXIMITY_SLACK_MS}). */
  readonly slackMs?: number;
}

interface DiscoveredRollout {
  readonly path: string;
  readonly sessionId: string;
  /** How the path was chosen. */
  readonly via: 'sessionId' | 'time-proximity';
}

/**
 * Discover an on-disk model-io JSONL when transcriptRef is missing (common for
 * TIMEOUT_KILLED: the CLI never printed a result object with sessionId).
 *
 * Preference:
 *   1. `sessionId` → same paths as {@link resolveTranscriptPath}
 *   2. Scan `~/.zcode/cli/rollout/model-io-sess_*.jsonl` whose mtime falls near
 *      the task window; pick the closest to endTime (then startTime).
 */
function discoverRolloutTranscript(
  options: DiscoverRolloutOptions = {},
): DiscoveredRollout | null {
  const home = options.home ?? homedir();
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0
    ? options.sessionId
    : undefined;

  if (sessionId !== undefined) {
    const path = resolveTranscriptPath({ provenance: 'zcode', handle: sessionId }, { home });
    return path === null ? null : { path, sessionId, via: 'sessionId' };
  }

  const start = typeof options.startTimeMs === 'number' && Number.isFinite(options.startTimeMs)
    ? options.startTimeMs
    : null;
  const end = typeof options.endTimeMs === 'number' && Number.isFinite(options.endTimeMs)
    ? options.endTimeMs
    : start;
  if (start === null || end === null) return null;

  const slack = options.slackMs ?? ROLLOUT_PROXIMITY_SLACK_MS;
  const windowLo = start - slack;
  const windowHi = end + slack;
  const rolloutDir = join(home, '.zcode', 'cli', 'rollout');
  if (!existsSync(rolloutDir)) return null;

  type Cand = { path: string; sessionId: string; mtimeMs: number; dist: number };
  const cands: Cand[] = [];
  try {
    for (const name of readdirSync(rolloutDir)) {
      const match = ROLLOUT_FILE_RE.exec(name);
      if (match === null) continue;
      const full = join(rolloutDir, name);
      let mtimeMs: number;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < windowLo || mtimeMs > windowHi) continue;
      // Prefer files whose mtime is closest to the task end (kill often lands near last write).
      const dist = Math.abs(mtimeMs - end);
      cands.push({ path: full, sessionId: match[1], mtimeMs, dist });
    }
  } catch {
    return null;
  }

  if (cands.length === 0) return null;
  cands.sort((a, b) => a.dist - b.dist || b.mtimeMs - a.mtimeMs);
  const best = cands[0];
  return { path: best.path, sessionId: best.sessionId, via: 'time-proximity' };
}
