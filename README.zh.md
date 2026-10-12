---
description: "Agent Hub — 跨适配器派发编码 Agent；通过 swarm 看板观察与干预。"
kind: "package-bundle"
---

# Agent Hub

**产品：** Agent Hub（npm：`agent-hub`）。活路径 = swarm 看板（`npm run start` / `npm run restart`，`:3000`）。请跟 **[DEMO.md](./DEMO.md)** 与 **[DISPATCH.md](./DISPATCH.md)**。

[English](README.md) | 中文

## 摘要

Agent Hub 处于任意两个编码 Agent 之间：路由派发、把进度落盘，并用看板让人类观察与干预。它本身**不执行**编码任务——适配器把本地 CLI Agent（ZCode、bash 等）以脱钩进程拉起，状态落在 `.swarm-runs/<taskId>/`。

- **看板：** `http://127.0.0.1:3000` 的 Kanban + Inspector（Express + Vite）。
- **派发：** 看板 QuickDispatch / 弹窗、`POST /api/tasks/dispatch`、`swarm_dispatch` 工具，或 `npm run dispatch-tickets`。
- **护栏：** cwd 白名单（`AGENT_HUB_TASK_ROOTS`）、并发上限（`AGENT_HUB_MAX_CONCURRENT`）、TTL 看门狗（`AGENT_HUB_DEFAULT_TIMEOUT`）。
- **ADR-0002：** 平台只记机械事实（`COMPLETED` / exit 0 ≠ 语义成功）。人与上游 Agent 读 transcript 自行判断。

## 快速开始

```bash
cd <repo-root>
export ZCODE_CLI_PATH=/path/to/zcode.cjs   # zcode 适配器必需
npm run start                              # 看板 → http://127.0.0.1:3000
```

可选环境变量：`AGENT_HUB_TASK_ROOTS`、`AGENT_HUB_MAX_CONCURRENT`、`AGENT_HUB_DEFAULT_TIMEOUT`、`PORT`。

改了 server / runner / adapter 后：

```bash
npm run restart   # 杀掉 :$PORT 监听进程再启动
```

批量工单（无 LLM）：见 [DISPATCH.md](./DISPATCH.md) 与 `scripts/dispatch-tickets.mjs`。

## 文档

| 文档 | 受众 |
| --- | --- |
| [DEMO.md](./DEMO.md) | 人类 runbook — 启动看板、护栏、冒烟 |
| [DISPATCH.md](./DISPATCH.md) | 工单 → HTTP 派发契约 |
| [PRODUCT.md](./PRODUCT.md) | 产品目的与约束 |
| [CONTEXT.md](./CONTEXT.md) | 术语 glossary |
| [docs/README.md](./docs/README.md) | 文档中心 — USER_GUIDE / AGENT_GUIDE / ARCHITECTURE |
| [DESIGN.md](./DESIGN.md) | Operate 看板视觉体系 |

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `npm run start` / `npm run dev` | 看板服务（默认 `:3000`） |
| `npm run restart` | API 变更后重启看板 |
| `npm test` | 规格测试 |
| `npm run build` | Vite 生产构建 |
| `npm run dispatch-tickets` | 批量派发工单文件 |

## 原则

- 平台**不判定**活成没成（ADR-0002）。
- 凭据留在 Agent 侧（ZCode 用 `~/.zcode`）；Hub 不保管。
- 状态真相源：`.swarm-runs/*/meta.json`（及 `raw.log`、`report.md`、`resolution.json`）。
