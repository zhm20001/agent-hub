---
ticket: 01-footer-abspath
label: footer absolute path ready-for-agent
adapter: zcode
mode: edit
timeout: 1800
blockedBy: []
parallel: true
type: task
status: done-parked
---

# 01: Show absolute path of open document in footer secondary

**Type:** task

**What to build:** When a document is open and the status bar is idle (no link/image hover hint and no timed status message), the footer secondary slot shows that document's absolute path, middle-ellipsized to fit. Clicking the path copies the full absolute path to the clipboard. An empty tab (no path) shows nothing in that slot. The window/title bar stays basename-only.

**Blocked by:** None (can start immediately).

**Status:** done-parked (superseded by 02-footer-abspath-verify)

- [ ] Open a file → absolute path appears in the footer secondary slot when idle
- [ ] Path is middle-ellipsized when the footer is too narrow; click copies the **full** absolute path
- [ ] Empty / no-document tab hides the path (no placeholder)
- [ ] Hover URL / timed status still preempt the path in the secondary slot
- [ ] Title bar basename-only unchanged; no tab-strip clutter; no unrelated refactors

## Context for the agent

Repo: markview (Rust, winit+wgpu markdown reader). jj colocated git. Work in the main working copy `/Users/zhm20001/markview`. Design notes: `.scratch/show-doc-abspath/CONTEXT.md`.

### Files to touch (expected)

1. `src/app/chrome.rs` (~526–533) — the `draw_footer(…)` call currently passes timed `self.status` or `self.hover_hint.unwrap_or("")` as `secondary`. Extend idle case: when there is no timed status and no hover hint, pass the active session absolute path string (or `""` if `self.session.path` is `None`). Do **not** put the path in the tab strip or title bar (title already uses basename around the toolbar name drawing).
2. `src/app/chrome/footer.rs` — secondary already renders via `right_label` → `TextShaper::fit` (middle-ellipsis keeping start+end with `…`). Keep that. Add click-to-copy support for the secondary path region (hit target / `Button` or existing chrome hit pattern). Only the path (not hover/status text) needs to be clickable for copy.
3. Clipboard: reuse `Clipboard::write` (`src/platform.rs`) the same way selection copy does in `src/app/interaction.rs` (`copy_selection` / `clipboard.write` + short status notify). Prefer existing status/lang strings; add a minimal string only if none fit.
4. Path source: `ReaderSession.path: Option<PathBuf>` (`src/state.rs`) — already absolute for open documents. Active session only (multi-tab: the session currently drawn).

### Constraints

- No unrelated refactors.
- Prefer leave the working copy dirty; do **not** require a commit or push. If you do commit, use jj (colocated); Conventional Commits style; still do not push.
- Keep changes minimal and focused on the acceptance checks above.
- Run targeted tests / `cargo fmt` / clippy on touched code if practical; full suite if cheap.

### Done when

Acceptance checkboxes above are met. Summarize files changed and how to verify visually (open file → see path → click → paste elsewhere; empty tab hides path).

