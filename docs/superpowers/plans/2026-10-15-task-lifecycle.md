# Task lifecycle design and execution plan

Goal: HTTP, swarm tools and TTL express termination intent through one runner interface. The runner owns terminal metadata, closing records and reports, including normal exit and orphan recovery.

Keep the existing detached runner as the module. A separate forwarding module would add an interface without hiding more knowledge. Keep adapter translation and settleRun unchanged. Do not change transcript discovery, server startup, task status vocabulary or transport response shapes.

Interface:
- terminateTask(taskId, cause: 'cancelled' | 'timeout') returns terminal metadata, or null for an unknown task. An already terminal task is returned without signalling or rewriting artifacts.
- completeTask(taskId, completion) handles process completion or recovery, preserves an existing terminal status/endTime and accepts actual exit facts from a late close. It persists terminal metadata first so the stop intent survives a settlement failure, then writes the closing record and report. Missing records can be rebuilt through readResolution. Recovery keeps an existing closing record.
- Spawn refusal, close/error callbacks and orphan reconciliation use completeTask. HTTP/tools/watchdog call terminateTask. The watchdog retains its progress decision and warning log.

Invariants: first terminal status wins; repeated termination is inert; a late close enriches output/exit facts without changing cancellation/timeout; reports and records retain the stop reason; missing tasks create no files. The metadata, record and report are not a filesystem transaction; metadata preserves stop intent if record/report generation fails.

Execution (inline, authorized by user):
1. Add lifecycle tests using real bash children and fixture metadata; run them and verify the missing termination interface fails.
2. Implement runner lifecycle operations and migrate all termination/completion paths together.
3. Run targeted lifecycle tests, the full suite and production build. Inspect the diff for leftover duplicated transitions and unrelated changes.
4. Commit only this plan, runner/entry-point changes, package test registration and lifecycle tests with jj. Preserve pre-existing ticket changes in the working copy.

Verification notes: lifecycle tests use an isolated temporary cwd before importing the runner. Existing test files share the repository run directory, so the npm test command runs files sequentially to avoid concurrent-cap fixture and orphan-recovery interference. A forced record-write failure verifies durable cancellation intent and subsequent readResolution recovery.
