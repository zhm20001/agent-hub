---
description: "Agent Hub — dispatch local agents, observe execution, and keep lightweight project handovers."
kind: "package-bundle"
---

# Agent Hub

English | [中文](README.zh.md)

Agent Hub helps a lead agent delegate work to ZCode, Codex or Bash, and helps you pick up a project after time away. It provides detached execution, a local task board, project goals and append-only handover notes.

**Process completion and agent claims are not proof that the work meets your requirements.** Hub records execution facts and attributed reports; you or the lead agent decide what to accept and do next.

## Quick start

Requires **Node.js 22.13+**.

```bash
npm install
export ZCODE_CLI_PATH=/path/to/zcode.cjs  # when using ZCode
npm run start                           # http://127.0.0.1:3000
```

The server binds to localhost by default. Optional environment variables include `AGENT_HUB_TASK_ROOTS`, `AGENT_HUB_MAX_CONCURRENT`, `AGENT_HUB_DEFAULT_TIMEOUT` and `PORT`. See [DEMO.md](DEMO.md) for setup and [DISPATCH.md](DISPATCH.md) for dispatch details.

## What it does

- Dispatch through the board, HTTP, registered `swarm_*` tools or ticket files. Local CLI processes continue when the parent board closes.
- Inspect task state, output, conversations, reports and version changes; cancel or let the watchdog enforce the time budget.
- Register a project goal and default directory. Leave sourced handover notes, review changes since your last acknowledged visit, then open related tasks.
- Use a stable `request_key` to recover the original dispatch after an uncertain response. Changed input with the same key conflicts.
- Request a structured agent handoff and pass bounded upstream context to text agents. Bash commands remain literal commands.

Project notes remain separate from goals and execution facts. There is no automatic project planning, semantic acceptance or progress percentage. Completion callbacks require an explicit host connection; persistent replay additionally requires a stable `consumerId`.

## Embedding

`createHub({ runsDir })` assembles one store, task engine, query view and project notebook. Pass that Hub to `startServer(port, { hub })` and `registerSwarmTools(context, activeAgentGetter, hub)` so every entry uses the same instance. Use distinct directories for independent instances; close an externally supplied Hub when its owner is finished.

SQLite at `.swarm-runs/hub.sqlite` owns registered task state, request identities, events and progress. Task directories retain readable metadata copies, logs, reports and process evidence. Existing JSON task records are imported when read. Editing or deleting a metadata copy does not edit or delete a registered database task. Preserve the entire run directory when backing up.

## Development

| Command | Purpose |
| --- | --- |
| `npm run start` / `npm run dev` | Start the board |
| `npm run restart` | Restart after backend changes |
| `npm test` | Discover all specs and run each in an isolated temporary working directory |
| `npm run build` | Compile backend to `lib` and frontend to `dist` |
| `npm run dispatch-tickets -- <dir> --dry-run` | Preview against the selected board without posting tasks |

Vite refreshes frontend changes; backend changes require a restart. Agents use their own local credential configuration; do not put credentials in prompts or tickets.

## Documentation

- [Architecture and execution sequence](docs/ARCHITECTURE.md)
- [HTTP, tools, handoffs and ticket dispatch](DISPATCH.md)
- [Startup and operating guide](DEMO.md)
- [Product purpose](PRODUCT.md), [vocabulary](CONTEXT.md), [documentation index](docs/README.md)
- [Why the platform does not judge success](docs/adr/0002-platform-does-not-judge.md)
