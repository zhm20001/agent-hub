# Agent Hub 文档中心 / Documentation Center

欢迎来到 **Agent Hub** 文档中心。

Live path = swarm board（`npm run start`，[DEMO.md](../DEMO.md)，[DISPATCH.md](../DISPATCH.md)）。Verdict / event-log / MCP 暂缓（ADR-0002 / `.scratch/agent-hub/issues/01d-…`）。

本系统以脱钩子进程 + `.swarm-runs/` 物理状态为底座，融合轻量文件流派发理念与沉浸式 Operate 工作台前端，实现高可控、不阻塞的子 Agent 协作。

---

## 📚 文档导航

| 文档名称 | 目标受众 | 核心内容 |
| :--- | :--- | :--- |
| **[用户使用指南 (USER_GUIDE.md)](./USER_GUIDE.md)** | 人类开发者 / 运维操作人员 | Web 监控台操作、任务派发、实时日志终端流、Git Diff 对比、双语切换 |
| **[Agent 工具接入指南 (AGENT_GUIDE.md)](./AGENT_GUIDE.md)** | AI Master Agent / LLM 调度系统 | `swarm_dispatch` 等 Tool 规范、异步调度循环、状态判断与错误自愈 |
| **[系统架构与内核原理 (ARCHITECTURE.md)](./ARCHITECTURE.md)** | 架构师 / 核心开发人员 | 模块与 seam 全景、派发/查询/恢复 Mermaid 时序、文件交接与代码索引 |

---

## 运行修复

- [派发预检、工作区占用、当前检查点和验证证据](OPERATIONS.md)。
- [高优先级修复交付与验证结果](reports/2026-10-20-agenthub-operational-hardening-results.md)。

## 实跑复盘

- [Markview OFM lite：AgentHub 实跑复盘（2026-10-20）](reports/2026-10-20-markview-ofm-agenthub-retrospective.md)：任务失败、误操作、审查返工、额度阻塞、接续与 CI 的证据记录。

---

## ⚡ 极速概览 (Quick Summary)

- **为什么用脱钩文件流？**
  内存管道在父进程退出或重载时容易丢日志甚至让子进程变僵尸。每个任务的 stdio 重定向到 `.swarm-runs/<task_id>/raw.log`，并通过 `child.unref()` 让子 Agent 在系统后台稳定运行。
- **全链路双语工作台**：
  顶部导航栏一键切换中英文（`中文` / `English`），设置持久化到 `localStorage`。
- **独立 Web 工作台**：
  `npm run start` → `0.0.0.0:3000`（Express + Vite）；也可用 `swarm_*` 工具从上游 Agent 派发。
