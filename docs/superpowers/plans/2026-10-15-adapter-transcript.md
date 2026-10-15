# Adapter-owned transcript lookup

The runner must never associate a task with another adapter's transcript.

Design: extend the existing WorkerAdapter interface with optional synchronous,
disk-only `locateTranscript`. Its input carries opaque refs, an optional session
handle, and an optional interrupted-run time window. It returns a path and
adapter-owned refs, or null. ZCode owns its directory layout and discovery rules;
adapters without this capability do not discover transcripts. A known but missing
session must not fall back to a different session by timestamp.

A shared runner module selects the adapter, checks provenance, reuses existing
paths and enriches records without writing them. Settlement and harvest persist
the result using their existing policies. Extract adapter registration from the
runner to avoid introducing a lookup → runner dependency cycle. Keep the first
lifecycle refactoring intact and leave live CLI readback unchanged.

Alternatives considered: an adapter-name guard alone leaves storage knowledge in
the runner; a separate transcript registry duplicates adapter selection. The
optional method uses the existing seam and does not require unsupported Codex or
Bash storage implementations.

Implementation and verification:

- [x] Add regression tests using temporary ZCode storage: interrupted Bash,
  Codex and unknown tasks cannot discover it; explicit missing refs do not guess.
  Run `node --import tsx --test tests/harvest.spec.ts` and confirm failures.
- [x] Move ZCode filesystem lookup into `src/adapters/zcode-transcript.ts`, add
  the optional adapter capability and extract `src/adapters/registry.ts`.
- [x] Centralize record enrichment in `src/runner/transcript.ts`; use it from
  settlement and harvest, and route watchdog lookup through the same selection.
- [x] Replace the old test that gives Bash a ZCode ref with a real ZCode adapter
  test; exercise the optional capability with another adapter implementation.
- [x] Run `npm test` and `npm run build`, inspect the diff.
- [x] Commit only this change with jj, leaving the pre-existing ticket additions
  in the working copy.

Compatibility: existing run records and harvest response shapes stay readable.
ZCode's timestamp discovery remains best effort for interrupted runs with no
handle; timestamp proximity alone cannot guarantee identity among concurrent
ZCode sessions. No new guarantee of semantic task success is introduced.

Validation: 139 tests passed; production build passed. Independent read-only
review found no blocking issues.
