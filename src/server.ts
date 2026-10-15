import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createServer as createHttpServer } from 'node:http';
import { readdirSync, existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execSync } from 'node:child_process';
import {
  SWARM_RUNS_DIR,
  ensureRunsDir,
  spawnDetachedTask,
  readTaskMeta,
  readResolution,
  updateTaskMeta,
  terminateTask,
  getTaskDir,
  type TaskMeta,
  filterBoardTasks,
} from './runner/detached.ts';
import { harvestTask, repairTaskTranscript, resolutionJsonPath } from './runner/harvest.ts';
import { reconcileOrphanRunningTasks, reconcileOrphanTask } from './runner/reconcile.ts';
import { summarizeTranscript } from './web/lib/board-ux.ts';
import { resolveModelInfo } from './runner/model-info.ts';
import { TtlWatchdog } from './runner/ttl.ts';
import { defaultWatcher } from './watcher.ts';
import { CwdNotAllowedError } from './runner/task-roots.ts';
import { ConcurrentCapError, countRunningTasks, resolveMaxConcurrent } from './runner/concurrency.ts';
import { resolveDefaultTimeout } from './runner/timeout-policy.ts';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

// Initialize background watchdog and file watcher
const watchdog = new TtlWatchdog(10_000);
watchdog.start();
defaultWatcher.start();

// API Routes

/**
 * GET /api/tasks - list all tasks
 */
app.get('/api/tasks', (req: Request, res: Response) => {
  ensureRunsDir();
  try {
    // Board load: settle RUNNING metas whose child PID is already gone.
    reconcileOrphanRunningTasks();
    const includeArchived =
      req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const entries = readdirSync(SWARM_RUNS_DIR, { withFileTypes: true });
    const tasks: Array<TaskMeta & { closingRecord: ReturnType<typeof readResolution> }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = readTaskMeta(entry.name);
      if (meta) {
        tasks.push({ ...meta, closingRecord: readResolution(entry.name) });
      }
    }
    const visible = filterBoardTasks(tasks, { includeArchived });
    visible.sort((a, b) => b.startTime - a.startTime);
    res.json(visible);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tasks/dispatch - spawn a new detached task
 */
app.post('/api/tasks/dispatch', (req: Request, res: Response) => {
  try {
    const { prompt, ticket, label, adapter, mode, cwd, timeout, resumeSessionId } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const meta = spawnDetachedTask({
      prompt,
      ticket,
      label,
      adapter: adapter || 'zcode',
      mode: mode || 'edit',
      cwd: cwd || process.cwd(),
      timeout: timeout ? parseInt(timeout, 10) : resolveDefaultTimeout(),
      ...(typeof resumeSessionId === 'string' && resumeSessionId.length > 0
        ? { resumeSessionId }
        : {}),
    });

    res.status(201).json(meta);
  } catch (err: any) {
    let status = 500;
    if (err instanceof CwdNotAllowedError) status = 400;
    else if (err instanceof ConcurrentCapError) status = 429;
    res.status(status).json({
      error: err.message,
      ...(err instanceof ConcurrentCapError
        ? { running: err.running, max: err.max, code: 'concurrent_cap' }
        : {}),
    });
  }
});

/**
 * GET /api/tasks/:id - get task details, meta and report
 */
app.get('/api/tasks/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  // Detail fetch: repair this task if RUNNING but process gone.
  reconcileOrphanTask(id);
  const meta = readTaskMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const reportPath = join(getTaskDir(id), 'report.md');
  let report = '';
  if (existsSync(reportPath)) {
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {}
  }

  const rawLogPath = join(getTaskDir(id), 'raw.log');
  let rawLog = '';
  if (existsSync(rawLogPath)) {
    try {
      rawLog = readFileSync(rawLogPath, 'utf8');
    } catch {}
  }

  // Closing record = mechanical facts from resolution.json (ADR-0002: not a verdict).
  // Harvest = last-turn projection + on-disk transcript path (mechanical, not a verdict).
  let closingRecord = readResolution(id);
  const harvest = harvestTask(id, closingRecord);
  // Re-read resolution after harvest may have repaired transcriptPath/refs.
  closingRecord = readResolution(id) ?? closingRecord;

  // Backfill model/provider + sessionId for TIMEOUT cards when model-io is discoverable.
  let metaOut = meta;
  if (harvest.transcriptPath) {
    const patch: Partial<TaskMeta> = {};
    if (!meta.modelId && !meta.providerId) {
      const info = resolveModelInfo({ transcriptPath: harvest.transcriptPath });
      if (info?.modelId) patch.modelId = info.modelId;
      if (info?.providerId) patch.providerId = info.providerId;
    }
    const handle = closingRecord?.resolution.transcriptRef?.handle
      ?? closingRecord?.resolution.sessionRef?.handle;
    if (handle && !meta.sessionId) patch.sessionId = handle;
    if (Object.keys(patch).length > 0) {
      metaOut = updateTaskMeta(id, patch) ?? { ...meta, ...patch };
    }
  }

  res.json({
    ...metaOut,
    report,
    rawLogTail: rawLog.slice(-5000),
    closingRecord,
    lastTurn: harvest.lastTurn,
    transcriptPath: harvest.transcriptPath,
    resolutionPath: resolutionJsonPath(id),
  });
});

/**
 * POST /api/tasks/:id/kill - kill running process
 */
app.post('/api/tasks/:id/kill', (req: Request, res: Response) => {
  const { id } = req.params;
  const meta = readTaskMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (meta.status !== 'RUNNING') {
    return res.json({ message: `Task is already ${meta.status}`, meta });
  }

  const updated = terminateTask(id, 'cancelled');

  res.json({ success: true, meta: updated });
});

/**
 * POST /api/tasks/:id/archive — soft-archive (or unarchive) a task.
 * Sets meta.archived; does not delete `.swarm-runs/<id>`.
 * Body: { archived?: boolean } — default true.
 */
app.post('/api/tasks/:id/archive', (req: Request, res: Response) => {
  const { id } = req.params;
  const meta = readTaskMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const archived =
    req.body && typeof req.body.archived === 'boolean' ? req.body.archived : true;

  const updated = updateTaskMeta(id, { archived });
  res.json({ success: true, meta: updated });
});

/**
 * GET /api/tasks/:id/stream - SSE live log stream
 */
app.get('/api/tasks/:id/stream', (req: Request, res: Response) => {
  const { id } = req.params;
  const taskDir = getTaskDir(id);
  const logPath = join(taskDir, 'raw.log');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sentBytes = 0;

  const sendNewChunk = () => {
    if (!existsSync(logPath)) return;
    try {
      const stats = statSync(logPath);
      if (stats.size > sentBytes) {
        const stream = createReadStream(logPath, { start: sentBytes, end: stats.size });
        sentBytes = stats.size;
        stream.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });
      }
    } catch {}
  };

  // Send initial chunk
  sendNewChunk();

  const interval = setInterval(() => {
    sendNewChunk();
    const currentMeta = readTaskMeta(id);
    if (currentMeta && currentMeta.status !== 'RUNNING') {
      sendNewChunk();
      res.write(`data: ${JSON.stringify({ status: currentMeta.status, done: true })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
  });
});

/**
 * Run a shell command in cwd; never throws. `missing` = binary not on PATH.
 */
function execCapture(
  command: string,
  cwd: string
): Promise<{ ok: boolean; missing: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      const stderrText = String(stderr || '');
      const errCode = err ? (err as NodeJS.ErrnoException).code : undefined;
      // shell-wrapped exec yields exit 127 + "not found" rather than ENOENT
      const missing =
        errCode === 'ENOENT' ||
        errCode === 127 ||
        /not found|command not found/i.test(stderrText) ||
        /not found|command not found/i.test(String(err?.message || ''));
      resolve({
        ok: !err,
        missing,
        stdout: String(stdout || ''),
        stderr: stderrText || (err && !missing ? String(err.message) : '') || '',
      });
    });
  });
}

/**
 * GET /api/tasks/:id/vcs — prefer Jujutsu (`jj log` + status); git only as fallback.
 */
app.get('/api/tasks/:id/vcs', async (req: Request, res: Response) => {
  const { id } = req.params;
  const meta = readTaskMeta(id);
  const targetCwd = meta?.cwd || process.cwd();

  const jjRoot = await execCapture('jj root', targetCwd);
  if (!jjRoot.missing && jjRoot.ok) {
    const [jjLog, jjStatus, jjDiff] = await Promise.all([
      execCapture('jj log -n 30', targetCwd),
      execCapture('jj status', targetCwd),
      execCapture('jj diff', targetCwd),
    ]);
    return res.json({
      engine: 'jj',
      log: jjLog.stdout.trim() || jjLog.stderr.trim() || '(empty jj log)',
      status: jjStatus.stdout.trim() || jjStatus.stderr.trim() || '',
      diff: jjDiff.stdout.trim() || '',
      cwd: targetCwd,
    });
  }

  if (jjRoot.missing) {
    // jj not installed — try git as secondary so the tab is not blank
    const [gitLog, gitStatus, gitDiff] = await Promise.all([
      execCapture('git log --oneline -n 30', targetCwd),
      execCapture('git status --short', targetCwd),
      execCapture('git diff HEAD', targetCwd),
    ]);
    if (!gitLog.missing && (gitLog.ok || gitStatus.ok)) {
      return res.json({
        engine: 'git',
        log: gitLog.stdout.trim() || '(no commits)',
        status: gitStatus.stdout.trim() || '',
        diff: gitDiff.stdout.trim() || '',
        cwd: targetCwd,
        error:
          'jj not found on PATH — showing git log/status as fallback. Install Jujutsu (jj) for the primary VCS view.',
      });
    }
    return res.json({
      engine: 'none',
      log: '',
      status: '',
      diff: '',
      cwd: targetCwd,
      error: 'Neither jj nor git is available in this workspace PATH.',
    });
  }

  // jj installed but cwd is not a jj repo — try git, else explain
  const [gitLog, gitStatus, gitDiff] = await Promise.all([
    execCapture('git log --oneline -n 30', targetCwd),
    execCapture('git status --short', targetCwd),
    execCapture('git diff HEAD', targetCwd),
  ]);
  if (!gitLog.missing && (gitLog.ok || gitStatus.ok)) {
    return res.json({
      engine: 'git',
      log: gitLog.stdout.trim() || '(no commits)',
      status: gitStatus.stdout.trim() || '',
      diff: gitDiff.stdout.trim() || '',
      cwd: targetCwd,
      error: `Not a jj repository (${jjRoot.stderr.trim() || 'jj root failed'}). Showing git fallback.`,
    });
  }

  return res.json({
    engine: 'none',
    log: '',
    status: '',
    diff: '',
    cwd: targetCwd,
    error: jjRoot.stderr.trim() || 'jj root failed and no git fallback available.',
  });
});

/** @deprecated Prefer /vcs — kept for older clients. */
app.get('/api/tasks/:id/diff', (req: Request, res: Response) => {
  const { id } = req.params;
  res.redirect(307, `/api/tasks/${id}/vcs`);
});

/**
 * POST /api/tasks/:id/reveal-transcript — reveal the conversation JSON in the OS
 * file manager (Finder on macOS). Local demo helper; does not call the live CLI.
 */
app.post('/api/tasks/:id/reveal-transcript', (req: Request, res: Response) => {
  const { id } = req.params;
  const meta = readTaskMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const closingRecord = readResolution(id);
  const harvest = harvestTask(id, closingRecord);
  const target = harvest.transcriptPath
    ?? resolutionJsonPath(id)
    ?? null;

  if (target === null) {
    return res.status(404).json({
      error: 'No on-disk transcript or resolution JSON to reveal',
      transcriptPath: null,
      resolutionPath: null,
    });
  }

  const revealed = revealInFileManager(target);
  if (!revealed.ok) {
    return res.status(500).json({ error: revealed.error, path: target });
  }
  res.json({
    success: true,
    path: target,
    kind: harvest.transcriptPath === target ? 'transcript' : 'resolution',
  });
});

/**
 * GET /api/tasks/:id/conversation — summarized turns for the Conversation tab.
 * Runs discovery/repair when TIMEOUT left no transcriptRef, then summarizes on
 * the server so the browser never downloads a multi‑MB model-io JSONL.
 */
app.get('/api/tasks/:id/conversation', (req: Request, res: Response) => {
  const { id } = req.params;
  const meta = readTaskMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Task not found' });
  }

  let closingRecord = readResolution(id);
  const repaired = repairTaskTranscript(id, closingRecord);
  if (repaired.record !== null) closingRecord = repaired.record;
  if (repaired.sessionId && !meta.sessionId) {
    updateTaskMeta(id, { sessionId: repaired.sessionId });
  }

  const harvest = harvestTask(id, closingRecord);
  const transcriptPath = harvest.transcriptPath;

  // Backfill model/provider when still missing (TIMEOUT cards).
  if ((!meta.modelId && !meta.providerId) && typeof transcriptPath === 'string') {
    const info = resolveModelInfo({ transcriptPath });
    if (info !== null) {
      updateTaskMeta(id, {
        ...info.modelId ? { modelId: info.modelId } : {},
        ...info.providerId ? { providerId: info.providerId } : {},
      });
    }
  }

  if (transcriptPath === null || !existsSync(transcriptPath)) {
    return res.json({
      turns: [],
      transcriptPath: null,
      emptyReason: meta.status === 'TIMEOUT_KILLED'
        ? 'timeout-no-transcript'
        : 'no-transcript',
      sessionId: repaired.sessionId ?? meta.sessionId ?? null,
    });
  }

  let body: string;
  try {
    body = readFileSync(transcriptPath, 'utf8');
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? String(err) });
  }

  const turns = summarizeTranscript(body);
  res.json({
    turns,
    transcriptPath,
    emptyReason: turns.length === 0 ? 'empty-transcript' : null,
    sessionId: repaired.sessionId
      ?? closingRecord?.resolution.transcriptRef?.handle
      ?? meta.sessionId
      ?? null,
  });
});

/**
 * GET /api/tasks/:id/transcript-file — serve the conversation JSON/JSONL for
 * in-browser download/view when Finder reveal is unavailable.
 */
app.get('/api/tasks/:id/transcript-file', (req: Request, res: Response) => {
  const { id } = req.params;
  const meta = readTaskMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const closingRecord = readResolution(id);
  const harvest = harvestTask(id, closingRecord);
  const target = harvest.transcriptPath ?? resolutionJsonPath(id);
  if (target === null || !existsSync(target)) {
    return res.status(404).json({ error: 'No on-disk transcript or resolution JSON' });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${target.split('/').pop()}"`);
  createReadStream(target).pipe(res);
});

/**
 * GET /api/health - Swarm system status
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    runsDir: SWARM_RUNS_DIR,
    concurrent: {
      running: countRunningTasks(),
      max: resolveMaxConcurrent(),
    },
  });
});

/** Reveal `path` in the OS file manager. Local-demo helper for macOS Finder. */
function revealInFileManager(path: string): { ok: true } | { ok: false; error: string } {
  try {
    if (process.platform === 'darwin') {
      execSync(`open -R ${JSON.stringify(path)}`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync(`explorer /select,${JSON.stringify(path)}`, { stdio: 'ignore' });
    } else {
      // Linux: open the containing directory
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.';
      execSync(`xdg-open ${JSON.stringify(dir)}`, { stdio: 'ignore' });
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Setup Vite middleware or static file serving
export async function startServer(port: number = PORT): Promise<any> {
  const isProd = process.env.NODE_ENV === 'production';
  const distDir = resolve(process.cwd(), 'dist');

  if (isProd && existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(join(distDir, 'index.html'));
    });
  } else {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.warn('Vite middleware could not be loaded in this mode, falling back to static/API');
    }
  }

  const httpServer = createHttpServer(app);
  httpServer.listen(port, HOST, () => {
    let version = '?';
    let mtime = '?';
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      version = pkg.version || '?';
    } catch { /* ignore */ }
    try {
      mtime = statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
    } catch { /* ignore */ }
    console.log(`[Agent Hub] v${version} · server mtime ${mtime} · http://${HOST}:${port}`);
  });

  return httpServer;
}

// Start immediately when executed directly
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app };
