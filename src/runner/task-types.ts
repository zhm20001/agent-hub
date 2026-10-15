export type TaskStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'KILLED' | 'TIMEOUT_KILLED';

export interface TaskMeta {
  taskId: string;
  ticket?: string;
  label: string;
  prompt: string;
  pid?: number;
  /** Dispatcher still assembling this launch; removed after supervisor PID is saved. */
  launchOwnerPid?: number;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
  timeout: number; // in seconds
  adapter: string;
  cwd: string;
  exitCode?: number | null;
  error?: string;
  /** One-shot TTL extension already granted by the progress probe. */
  timeoutExtended?: boolean;
  /** Best-effort model id from ZCode model-io / result (board card). */
  modelId?: string;
  /** Best-effort provider id from ZCode model-io / result (board card). */
  providerId?: string;
  /**
   * Adapter-owned session handle when known from output or transcript discovery.
   */
  sessionId?: string;
  /**
   * Undeclared-satisfiable preconditions the engine found unmet before dispatch,
   * by neutral name. Mirror of `RunObservation.unmetPreconditions` for readers
   * of `meta.json` (the authoritative pair lives in `resolution.json`).
   */
  unmetPreconditions?: string[];
  /**
   * Soft-archive: hide from the default board UI without deleting `.swarm-runs`.
   * Persist so restart keeps archived tasks hidden.
   */
  archived?: boolean;
}

