import { createHub, defaultHub, type Hub } from './hub.ts';
import { LogReader } from './runner/log-stream.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execFileSync } from 'node:child_process';
import { TtlWatchdog } from './runner/ttl.ts';
import { SwarmRunsWatcher, type TaskCompletionCallback } from './watcher.ts';
import { CwdNotAllowedError } from './runner/task-roots.ts';
import { ConcurrentCapError, countRunningTasks, resolveMaxConcurrent } from './runner/concurrency.ts';
import { RequestConflictError, DispatchRecoveryRequiredError } from './runner/detached.ts';
import { UnknownAdapterError } from './adapters/registry.ts';

export function createApp(hub: Hub = defaultHub) {
  const { getTaskDetail, getTaskConversation, getTaskTranscript, listTasks } = hub.queries;
  const { spawnDetachedTask, readTaskMeta, updateTaskMeta, terminateTask, getTaskDir } = hub.engine;
  const app = express();
  // Browser requests stay on the local Hub origin; agent clients need no Origin header.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    next();
  });
  app.use(express.json());

  // API Routes

  /**
   * GET /api/tasks - list all tasks
   */
  app.get('/api/tasks', (req: Request, res: Response) => {
    try {
      res.json(listTasks({ includeArchived: req.query.includeArchived === '1' || req.query.includeArchived === 'true' }));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  /**
   * POST /api/tasks/dispatch - spawn a new detached task
   */
  app.post('/api/tasks/preflight', (req, res) => {
    try { res.json(hub.engine.preflight(req.body ?? {})); } catch (error) { sendError(error, res); }
  });

  app.post('/api/tasks/dispatch', (req: Request, res: Response) => {
    try {
      const { prompt, ticket, label, adapter, mode, cwd, timeout, resumeSessionId,
        request_key, projectId, parentTaskId, dependsOn, handoff, workspaceAccess } = req.body ?? {};
      const meta = spawnDetachedTask({ prompt, ticket, label, adapter, mode, cwd, timeout,
        resumeSessionId, request_key, projectId, parentTaskId, dependsOn, handoff, workspaceAccess });

      res.status(201).json(meta);
    } catch (error) { sendError(error, res); }
  });

  /**
   * GET /api/tasks/:id - get task details, meta and report
   */
  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    const detail = getTaskDetail(String(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Task not found' });
    res.json(detail);
  });

  /**
   * POST /api/tasks/:id/kill - kill running process
   */
  app.post('/api/tasks/:id/kill', (req: Request, res: Response) => {
    const id = String(req.params.id);
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
    const id = String(req.params.id);
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
    const id = String(req.params.id);
    const reader = new LogReader(join(getTaskDir(id), 'raw.log'), String(req.get('last-event-id') ?? req.query.after ?? 0));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => { stopped = true; clearTimeout(timer); };
    const tick = () => {
      if (stopped) return;
      try {
        const meta = readTaskMeta(id);
        const ended = Boolean(meta && meta.status !== 'RUNNING');
        const chunk = reader.read(ended);
        let writable = true;
        if (chunk.text || chunk.reset) writable = res.write(`id: ${reader.eventId}\ndata: ${JSON.stringify(chunk)}\n\n`);
        if (ended && chunk.caughtUp) {
          res.write(`data: ${JSON.stringify({ status: meta!.status, done: true })}\n\n`);
          stop(); res.end(); return;
        }
        if (!writable) res.once('drain', () => { if (!stopped) timer = setTimeout(tick, 0); });
        else timer = setTimeout(tick, chunk.caughtUp ? 500 : 0);
      } catch { stop(); res.end(); }
    };
    req.on('close', stop);
    tick();
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
        const errCode = err ? (err as unknown as { code?: string | number }).code : undefined;
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
    const id = String(req.params.id);
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
    const id = String(req.params.id);
    res.redirect(307, `/api/tasks/${id}/vcs`);
  });

  /**
   * POST /api/tasks/:id/reveal-transcript — reveal the conversation JSON in the OS
   * file manager (Finder on macOS). Local demo helper; does not call the live CLI.
   */
  app.post('/api/tasks/:id/reveal-transcript', (req: Request, res: Response) => {
    const transcript = getTaskTranscript(String(req.params.id));
    if (!transcript) return res.status(404).json({ error: 'Task not found' });
    const target = transcript.transcriptPath ?? transcript.resolutionPath;

    if (target === null) {
      return res.status(404).json({
        error: 'No on-disk transcript or resolution JSON to reveal',
        transcriptPath: null,
        resolutionPath: null,
      });
    }

    const revealed = revealInFileManager(target);
    if (revealed.ok === false) {
      return res.status(500).json({ error: revealed.error, path: target });
    }
    res.json({
      success: true,
      path: target,
      kind: transcript.transcriptPath === target ? 'transcript' : 'resolution',
    });
  });

  /**
   * GET /api/tasks/:id/conversation — summarized turns for the Conversation tab.
   * Runs discovery/repair when TIMEOUT left no transcriptRef, then summarizes on
   * the server so the browser never downloads a multi‑MB model-io JSONL.
   */
  app.get('/api/tasks/:id/conversation', (req: Request, res: Response) => {
    const conversation = getTaskConversation(String(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'Task not found' });
    res.json(conversation);
  });

  /**
   * GET /api/tasks/:id/transcript-file — serve the conversation JSON/JSONL for
   * in-browser download/view when Finder reveal is unavailable.
   */
  app.get('/api/tasks/:id/transcript-file', (req: Request, res: Response) => {
    const transcript = getTaskTranscript(String(req.params.id));
    if (!transcript) return res.status(404).json({ error: 'Task not found' });
    const target = transcript.transcriptPath ?? transcript.resolutionPath;
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
      runsDir: hub.store.runsDir,
      concurrent: {
        running: countRunningTasks(hub.store.runsDir),
        max: resolveMaxConcurrent(hub.engine.env),
      },
    });
  });

  app.get('/api/projects', (_req, res) => res.json(hub.projects.list()));
  app.post('/api/projects', (req, res) => res.status(201).json(hub.projects.upsert(req.body ?? {})));
  app.get('/api/projects/:id/context', (req, res) => res.json(hub.projects.context(String(req.params.id), {
    ...(req.query.after !== undefined ? { after: Number(req.query.after) } : {}),
    ...(req.query.limit !== undefined ? { limit: Number(req.query.limit) } : {}),
    ...(req.query.viewerId !== undefined ? { viewerId: String(req.query.viewerId) } : {}),
  })));
  app.post('/api/projects/:id/notes', (req, res) => res.status(201).json(hub.projects.appendNote(String(req.params.id), req.body ?? {})));
  app.post('/api/projects/:id/seen', (req, res) => res.json(hub.projects.markSeen(String(req.params.id), req.body ?? {})));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(error, res));
  return app;
}

function sendError(error: unknown, res: Response) {
  const err = error as Error & { statusCode?: number; status?: number; running?: number; max?: number };
  const status = err instanceof RequestConflictError || err instanceof DispatchRecoveryRequiredError ? 409
    : err instanceof ConcurrentCapError ? 429
    : err instanceof CwdNotAllowedError || err instanceof UnknownAdapterError ? 400
    : err.statusCode ?? err.status ?? (/^Invalid (dispatch|task id)/.test(err.message ?? '') ? 400 : 500);
  res.status(status).json({ error: err.message ?? String(error),
    ...(err instanceof ConcurrentCapError ? { code: 'concurrent_cap', running: err.running, max: err.max } : {}) });
}

/** Reveal `path` in the OS file manager. Local-demo helper for macOS Finder. */
function revealInFileManager(path: string): { ok: true } | { ok: false; error: string } {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', ['-R', path], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execFileSync('explorer', [`/select,${path}`], { stdio: 'ignore' });
    } else {
      // Linux: open the containing directory
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.';
      execFileSync('xdg-open', [dir], { stdio: 'ignore' });
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Resources owned by one running hub. close() is awaitable and idempotent. */
export interface RunningServer {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export interface ServerOptions {
  host?: string;
  hub?: Hub;
  /** Stable identity of the notification destination; enables restart replay. */
  consumerId?: string;
  /** Disable frontend hosting when embedding only the HTTP task interface. */
  frontend?: boolean;
  onCompletion?: TaskCompletionCallback;
}

/** Start an independent hub; resolve only once listening, roll back on failure. */
export async function startServer(
  port: number = Number(process.env.PORT || 3000),
  options: ServerOptions = {},
): Promise<RunningServer> {
  const hub = options.hub ?? createHub();
  const app = createApp(hub);
  const httpServer = createHttpServer(app);
  const watchdog = new TtlWatchdog(10_000, hub.engine);
  const watcher = new SwarmRunsWatcher(hub.store, { consumerId: options.consumerId, onError: error => console.warn('[Agent Hub] Completion delivery pending:', error) });
  const unsubscribe = options.onCompletion ? watcher.subscribe(options.onCompletion) : undefined;
  let vite: import('vite').ViteDevServer | undefined;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => closing ??= (async () => {
    watchdog.stop();
    unsubscribe?.();
    const results = await Promise.allSettled([
      watcher.stop(),
      vite?.close(),
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        // SSE connections otherwise keep close() waiting indefinitely.
        httpServer.closeAllConnections();
      }),
    ]);
    if (!options.hub) hub.close();
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Failed to close hub resources');
  })();

  try {
    if (options.frontend !== false) {
      const appRoot = fileURLToPath(new URL('../', import.meta.url));
      const distDir = resolve(appRoot, 'dist');
      const packaged = fileURLToPath(import.meta.url).endsWith('/lib/server.js');
      if ((packaged || process.env.NODE_ENV === 'production') && existsSync(distDir)) {
        app.use(express.static(distDir));
        app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')));
      } else {
        const { createServer: createViteServer } = await import('vite');
        vite = await createViteServer({
          root: appRoot,
          // Share this runtime's listener, including HMR; no global Vite port.
          server: { middlewareMode: true, hmr: { server: httpServer } },
          appType: 'spa',
        });
        app.use(vite.middlewares);
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once('error', onError);
      httpServer.listen(port, options.host ?? '127.0.0.1', () => {
        httpServer.off('error', onError);
        resolve();
      });
    });
    watchdog.start();
    await watcher.start();
    return { address: httpServer.address() as AddressInfo, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Hub startup and cleanup failed');
    }
    throw error;
  }
}
