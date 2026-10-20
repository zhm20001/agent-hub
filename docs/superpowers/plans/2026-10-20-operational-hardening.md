# AgentHub Operational Hardening Implementation Plan

> Execution: inline, one writer; independent read-only final review. User explicitly authorized design and implementation in this conversation.

**Goal:** Implement the six high-priority retrospective improvements without adding a semantic verdict engine or changing Agent/adapter ownership.

**Architecture:** Keep admission in TaskEngine under TaskStore's existing cross-process lock, event interpretation in adapters, current-project/acceptance records in an additive SQLite module, and validation execution in a standalone argv-based tool. HTTP/tools only forward to shared services. See the committed design for exact data and boundary contracts.

**Tech Stack:** Node 22+, TypeScript, node:test, SQLite, existing Express/tools.

## 1. Shared preflight and workspace admission

Files: new `src/runner/workspace.ts`, `src/runner/preflight.ts`; edit detached.ts, task-types.ts, adapters/preconditions.ts, adapters/zcode.ts, server.ts, tools.ts. Tests `tests/operational-admission.spec.ts`, existing engine/cap tests.

- Add failing integration tests: preflight reports denied cwd and missing CLI without creating task artifacts; default write refuses an active nested/aliased workspace; read/read coexists; keyed retry returns same task; cancelled-but-alive owner retains slot. Run `node --import tsx --test tests/operational-admission.spec.ts` and inspect failures.
- Implement typed Check `{name,ok,reason?}` and workspace identity/occupants. Share checks with real dispatch, keeping existing precondition failed-task records and lock ordering. Validate workspaceAccess at the transport-independent boundary.
- Test actual two-process admission race with different request keys; only one writer can start. Preserve old cap semantics; intentional parallel fixtures declare read access.
- Run affected suites, typecheck, diff check; commit `feat: preflight dispatch and serialize workspace writers`.

## 2. Activity projection

Files: new `src/runner/activity.ts`; edit base.ts, transcript-format.ts, codex.ts/zcode.ts, task-queries.ts. Tests `tests/activity.spec.ts`.

- First test quiet alive process vs absent transcript, log mtime/size, bounded event observation and no task-status changes.
- Add optional pure adapter activity observer, neutral query projection, missing/available transcript facts. Do not infer stalled status.
- Run tests and typecheck; commit `feat: expose bounded task activity facts`.

## 3. Explicit current checkpoints and evidence

Files: new `src/project-checkpoints.ts`; edit projects.ts, hub.ts, server.ts, tools.ts. Tests `tests/project-checkpoints.spec.ts` plus existing projects/hub suites.

- Red tests for explicit accepted record with revision/checks, failed/omitted checks staying visible, CAS conflict, restart persistence, cross-project task rejection, artifact path escape and source-change detection, retained file surviving original deletion.
- Add checkpoint storage with sequence CAS and immutable history, referenced artifact metadata and explicit bounded retention. Include latest checkpoint in context and prompt alongside separate latestNote; no inference from TaskStatus.
- Add notes pagination metadata; preserve old response fields and notes behavior.
- Run project/API/tool tests, typecheck; commit `feat: record sourced project checkpoints and retained evidence`.

## 4. Verification manifest runner

Files: new `scripts/verify.mjs`, `tests/verification.spec.ts`, `verification.json`; edit package.json only to expose an optional verify command. No dependency changes.

- Red subprocess tests: failed inner command yields nonzero/report failure; all checks still recorded, unavailable platform required check yields not-run/nonzero, source hash drift prevents a passing report, existing report directory refused.
- Implement validated bounded manifest with argv/no shell, explicit cwd/platform/required, source hashes, per-check logs and report.json. Prevent self-overwriting source/manifests and keep report failures observable.
- Add CI-source review guidance. Self-manifest covers isolated tests/typecheck/build; external manifests can declare separate workspaces and platform gates.
- Run subprocess suite/typecheck/diff check; commit `feat: run explicit verification matrices with durable reports`.

## 5. Integration and final review

Files: docs/AGENT_GUIDE.md, DISPATCH.md, docs/ARCHITECTURE.md, docs/README.md, new operational guide.

- Document request/response examples, workspace read declaration limits, preflight TOCTOU, checkpoint compare-and-set, explicit decisions and evidence retention/backup, verification matrix author responsibility and failed/skipped distinctions.
- Run full `npm test`, `npm run typecheck`, `npm run build`; run `node scripts/verify.mjs verification.json <fresh-temp-dir>` to exercise the actual reporting path. Inspect reports.
- Request read-only architecture/correctness review using requesting-code-review; fix concrete findings with regressions and scoped commits.
- Record exact results and known limits in a completion document; commit only owned paths. No deployment/service restart/push or edits to the preexisting tickets.

## Completion

Completed 2026-10-20, including independent-review corrections. Final isolated matrix: 29 files / 235 passing tests, typecheck/build exit 0, source pins matched. See [delivery and limitations](../../reports/2026-10-20-agenthub-operational-hardening-results.md). Existing service was not restarted and changes were not pushed.
