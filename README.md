---
description: "Agent Hub — dispatch coding agents across adapters; observe and intervene via the swarm board."
kind: "package-bundle"
---

# Agent Hub

**Product:** Agent Hub (`agent-hub`). Live path = swarm board (`npm run start` / `npm run restart`, board at `:3000`). Follow **[DEMO.md](./DEMO.md)** and **[DISPATCH.md](./DISPATCH.md)**.

English | [中文](README.zh.md)

## Summary

Agent Hub sits between any two coding agents: it routes dispatch, keeps progress on disk, and shows a board so humans can observe and intervene. It does **not** run the coding work itself — adapters spawn local CLI agents (ZCode, bash, …) as detached processes under `.swarm-runs/<taskId>/`.

- **Board:** Kanban + Inspector at `http://127.0.0.1:3000` (Express + Vite).
- **Dispatch:** QuickDispatch / modal on the board, `POST /api/tasks/dispatch`, `swarm_dispatch` tools, or `npm run dispatch-tickets`.
- **Guards:** cwd allowlist (`AGENT_HUB_TASK_ROOTS`), concurrency cap (`AGENT_HUB_MAX_CONCURRENT`), TTL watchdog (`AGENT_HUB_DEFAULT_TIMEOUT`).
- **ADR-0002:** the platform records mechanical facts only (`COMPLETED` / exit 0 ≠ semantic success). Humans and upstream agents read the transcript.

## Quick start

```bash
cd <repo-root>
export ZCODE_CLI_PATH=/path/to/zcode.cjs   # required for the zcode adapter
npm run start                              # board → http://127.0.0.1:3000
```

Optional env: `AGENT_HUB_TASK_ROOTS`, `AGENT_HUB_MAX_CONCURRENT`, `AGENT_HUB_DEFAULT_TIMEOUT`, `PORT`.

After changing server / runner / adapter code:

```bash
npm run restart   # kill :$PORT listener, then start again
```

Batch tickets (no LLM): see [DISPATCH.md](./DISPATCH.md) and `scripts/dispatch-tickets.mjs`.

## Docs

| Doc | Audience |
| --- | --- |
| [DEMO.md](./DEMO.md) | Human runbook — start board, guards, smoke |
| [DISPATCH.md](./DISPATCH.md) | Ticket → HTTP dispatch contract |
| [PRODUCT.md](./PRODUCT.md) | Product purpose and constraints |
| [CONTEXT.md](./CONTEXT.md) | Glossary (Platform / Agent / Adapter / Task / …) |
| [docs/README.md](./docs/README.md) | Doc hub — USER_GUIDE / AGENT_GUIDE / ARCHITECTURE |
| [DESIGN.md](./DESIGN.md) | Operate board visual system |

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run start` / `npm run dev` | Board server (default `:3000`) |
| `npm run restart` | Restart board after API changes |
| `npm test` | Spec suite |
| `npm run build` | Vite production build |
| `npm run dispatch-tickets` | Batch-dispatch ticket files |

## Principles

- Platform does **not** judge success (ADR-0002).
- Credentials stay with the agent (ZCode uses `~/.zcode`); Hub never holds them.
- State source of truth: `.swarm-runs/*/meta.json` (+ `raw.log`, `report.md`, `resolution.json`).
