export type TaskStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'KILLED' | 'TIMEOUT_KILLED';

/** Mechanical closing facts from resolution.json — not a semantic verdict (ADR-0002). */
export interface ClosingRecord {
  taskId: string;
  resolution: {
    taskId: string;
    finalText?: { kind: string; value?: string };
    stopCause?: string;
    usage?: unknown;
    sessionRef?: { provenance: string; handle: string };
    transcriptRef?: { provenance: string; handle: string };
  };
  observation?: {
    producedOutput?: boolean;
    unmetPreconditions?: Array<{ name: string }>;
  };
}

export interface Task {
  taskId: string;
  ticket?: string;
  label: string;
  prompt: string;
  pid?: number;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
  timeout: number;
  adapter: string;
  cwd: string;
  exitCode?: number | null;
  error?: string;
  timeoutExtended?: boolean;
  modelId?: string;
  providerId?: string;
  closingRecord?: ClosingRecord | null;
}

/** Mechanical last-turn harvest from the API — not a semantic verdict (ADR-0002). */
export interface LastTurn {
  text: string;
  truncated: boolean;
  fullLength: number;
  source: 'transcript' | 'finalText';
  cap: number;
  /** Full untruncated source for copy; equals text when not truncated. */
  fullText?: string;
}

export interface TaskDetailData extends Task {
  report?: string;
  rawLogTail?: string;
  lastTurn?: LastTurn | null;
  /** Absolute path of on-disk conversation JSON/JSONL when resolved without live CLI. */
  transcriptPath?: string | null;
  /** Absolute path of resolution.json when present. */
  resolutionPath?: string | null;
}

/** VCS tab payload — prefer Jujutsu (`jj`); git is fallback only. */
export interface VcsData {
  engine: 'jj' | 'git' | 'none';
  /** Primary: `jj log` (or git log fallback). */
  log: string;
  status: string;
  /** Optional `jj diff` / `git diff` body. */
  diff?: string;
  cwd: string;
  error?: string;
}

/** @deprecated Use VcsData */
export type DiffData = VcsData;
