# Explicit server lifecycle

Goal: importing the server or plugin starts no resources. Each awaited start owns an independent Express app, HTTP listener, Vite instance, watchdog and watcher. Its idempotent async close waits for resource release, including open SSE connections. Failed starts clean up acquired resources and reject.

Design: keep routes in a private app factory; startServer(port, options) returns a running handle with address and close. Options select host, frontend and an optional completion callback. A standalone CLI owns process signal handling. Plugin apply/dispose owns a pending start and serializes shutdown before reload. Detached agent processes remain independent of server shutdown.

Alternatives: merely guarding direct execution leaves shared app/resource ownership; a general resource container adds unnecessary interface. Use a small concrete running handle instead.

Execution (inline, as authorized):
- [x] Write failing tests for side-effect-free imports, independent instances, listening errors, SSE shutdown, port reuse and plugin disposal during startup.
- [x] Move route registration into an app factory; implement start/rollback/close and await watcher shutdown.
- [x] Add CLI entry and update package scripts; make plugin startup/disposal share the runtime lifecycle.
- [x] Run targeted tests, full suite and build; inspect diff and commit only this task's files with jj.

Validation: six runtime regression tests pass (including real Vite and CLI processes); production Vite build passes. Full suite and whitespace checks run before the jj commit.
