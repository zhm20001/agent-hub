# Codex adapter: small structure review

Source skim: 2026-10-15. This note records the current implementation and review
follow-ups; it does not change runtime behavior or establish live CLI compatibility.

## Repository map

- `src/index.ts`: DSH plugin entry; registers `swarm_*` tools from `tools.ts`,
  subscribes to completion notices, and starts the board server.
- `src/adapters/`: `base.ts` defines the current argv-based `WorkerAdapter` seam;
  `contract.ts` defines settlement/ref types. `zcode.ts`, `bash.ts`, and `codex.ts`
  build commands and translate output; `preconditions.ts` carries launch checks.
  The larger documented adapter contract is only partially implemented.
- `src/runner/detached.ts`: routes adapters, checks cwd/concurrency/preconditions,
  spawns detached children, and writes task metadata/logs/reports under
  `.swarm-runs/`. Nearby modules handle settlement, reconciliation, harvesting,
  TTL/timeouts, task roots, and transcript readback.
- `src/server.ts`: Express task dispatch/status/kill, log SSE, diff and transcript
  endpoints; serves the board with Vite/static assets. `src/watcher.ts` observes
  task metadata; `src/web/` contains the React board and task views.
- `tests/`: Node test-runner specs, including `faced-codex.spec.ts` for command
  construction, JSONL translation, preconditions, routing, and fixture dispatch.
  `tests/fixtures/` supplies fake CLIs; `package.json` lists the default test suite.
- `docs/`: user/agent guides, architecture, ADRs, and `agent-hub/` contract docs.
  Root `DEMO.md` and `DISPATCH.md` describe the live board/dispatch workflow.

## Codex path

HTTP dispatch or `swarm_dispatch` → `spawnDetachedTask()` → `getAdapter('codex')`
→ `CodexAdapter.checkPreconditions()` → `buildCommand()` → detached `spawn()`
→ combined `raw.log` → `translate()` → `resolution.json` and report.

Codex resolves an explicit CLI path, `CODEX_CLI_PATH`, the ChatGPT.app bundle,
then PATH. It requires an auth file at `CODEX_HOME/auth.json` or
`~/.codex/auth.json` (existence only). Fresh runs use `exec --json` with the
prompt after `--`; resume uses `exec … resume --json <id> -- <prompt>`.
`plan` maps to read-only, edit/build to workspace-write, and `yolo` enables
approval/sandbox bypass. JSONL supplies final text, thread refs, and token usage.

## Obvious footguns / follow-up checklist

- [x] **Routing:** `getAdapter()` rejects unknown names (`UnknownAdapterError`);
  dispatch refuses to start. Settlement of historical typo metas uses a stub
  (no silent ZCode fallback).
- [ ] **Spawn/stdin:** the runner uses `stdio: ['ignore', logFd, logFd]`.
  Codex receives its prompt through argv; there is no stdin prompt transport or
  interactive reply channel. Very large prompts can hit OS argument limits;
  stdout/stderr merging also makes JSONL translation best-effort.
  **Deferred:** separating stderr would change ZCode log shape; stdin stays
  `ignore` (do not hang). Documented only for now.
- [x] **Launch checks (light):** Codex CLI resolution / `checkPreconditions()`
  now require a usable path (`X_OK` for binaries, `R_OK` for `.js`/`.cjs`) and
  recheck at dispatch time. Auth-file check remains existence-only (never reads
  secrets; existence ≠ usable credentials).
- [x] **Resume `--`:** resume now uses `resume --json <id> -- <prompt>` like
  fresh runs (safe for leading-dash prompts).
- [ ] **`disallowedTools`:** still not forwarded — Codex has no clear `exec` CLI
  flag (tool deny lives in `config.toml`). Callers must not assume the shared
  option enforces restrictions here. **Skipped / documented.**
- [x] **Discoverability:** `src/tools.ts`, `DISPATCH.md`, DispatchModal /
  QuickDispatchBar advertise `codex`.
- [ ] **Readback:** `src/runner/readback.ts` still supports only ZCode. Codex
  emits `transcriptRef` (thread uuid) but there is no cheap Hub path to render
  that conversation on the board yet. **Deferred** (leave + note).

Scope: smoke follow-ups from this skim + harvest footguns. Fixture coverage is
useful but does not establish compatibility with an installed Codex release.
