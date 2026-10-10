---
ticket: 02-footer-abspath-verify
label: footer abspath verify cargo ready-for-agent
adapter: zcode
mode: yolo
cwd: /Users/zhm20001/markview
timeout: 7200
blockedBy: []
parallel: true
type: task
status: ready-for-agent
---

# 02: Verify footer absolute-path (fmt / clippy / tests)

**Type:** task

**Status:** ready-for-agent

## Context

Repo: `/Users/zhm20001/markview` (Rust, jj colocated). Bookmark already on WC: **`feat/footer-abspath`**.

Prior Hub work implemented idle footer absolute path + click-to-copy. WC is **dirty** with those changes — continue from them; do **not** discard.

Design / acceptance: `.scratch/show-doc-abspath/CONTEXT.md` and related issues under `.scratch/show-doc-abspath/`.

## Your job (verification + fix)

1. Confirm WC state (`jj status` / `jj bookmark list`) — expect dirty on `feat/footer-abspath`.
2. Run **`cargo fmt`** (check or format touched code as appropriate).
3. Run **`cargo clippy`** (workspace / touched crates; fix warnings that fail CI or are clear regressions from this feature).
4. Run **`cargo test`** focusing on footer / abspath tests (e.g. names containing `footer`, `abspath`, `idle_footer`, `an_idle_footer_names_the_document`). Expand to related chrome/interaction tests if failures point there. Fix compile/test failures.
5. Leave the working copy **ready** (fmt/clippy/tests clean for this feature). Prefer leave WC **dirty** for upstream `jj` commit/bookmark polish.
6. **Do NOT push.** Upstream will `jj push` later. Do not invent remotes or force-push.

## Constraints

- No unrelated refactors.
- Title bar stays basename-only; path only in idle footer secondary; click copies full absolute path.
- Use maximum tool permissions already granted for this run (`--mode yolo` + workspace bash allowlist including `cargo`). Prefer running cargo directly; do not skip tests because of permission prompts.
- Model for this run should be **GLM-5.3** (default pinned for headless). If you can see your model id, note it in the summary.

## Done when

- `cargo fmt` / clippy / focused tests pass (or you fixed what failed).
- Short summary: commands run, results, files changed (if any), how to visually verify, remaining gaps.
- WC left ready; **no push**.
