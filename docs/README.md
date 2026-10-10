# Agent Hub 文档中心 / Documentation Center

欢迎来到 **Agent Hub**（原 `dsh-subagent-zcode` 升级版）文档中心。
> **⚠️ Face A deprecated.** Live path = Face B swarm board (`npm run start`, [DEMO.md](../DEMO.md), [DISPATCH.md](../DISPATCH.md)). `cordis.patch.yml` / DSH plugin install notes below are archaeology; do not follow them for new work. Verdict / event-log / MCP are parked (ADR-0002 / `.scratch/agent-hub/issues/01d-…`).


本系统以 DeepSeek Harness (DSH) 微内核架构为底座骨架，深度融合 **DispatchDock** 的轻量文件流脱钩理念与沉浸式工作台前端，实现了生产级、高可控、不阻塞的子 Agent 协作生态。

---

## 📚 文档导航

| 文档名称 | 目标受众 | 核心内容 |
| :--- | :--- | :--- |
| **[用户使用指南 (USER_GUIDE.md)](./USER_GUIDE.md)** | 人类开发者 / 运维操作人员 | Web 监控台操作、任务派发、实时日志终端流、Git Diff 对比、双语切换 |
| **[Agent 工具接入指南 (AGENT_GUIDE.md)](./AGENT_GUIDE.md)** | AI Master Agent / LLM 调度系统 | `swarm_dispatch` 等 Tool 规范、异步调度循环、状态判断与错误自愈 |
| **[系统架构与内核原理 (ARCHITECTURE.md)](./ARCHITECTURE.md)** | 架构师 / 核心开发人员 | 脱钩进程 `spawn({ detached: true })`、`.swarm-runs/` 文件规范、TTL 看门狗、SSE 协议 |

---

## ⚡ 极速概览 (Quick Summary)

- **为什么脱离原版 subprocess 管道？**  
  原生 DSH 的内存管道在父进程退出或重载时容易丢失日志甚至使子进程变成僵尸。本项目将每个任务的标准输入输出彻底重定向到物理文件 `.swarm-runs/<task_id>/raw.log`，并通过 `child.unref()` 让子 Agent 在系统后台稳定运行。
- **全链路双语工作台**：  
  顶部导航栏配备一键切换中英文按钮（`中文` / `English`），状态自适应持久化。
- **开箱即用双模式**：  
  既可作为 DSH 官方插件 (`cordis.patch.yml`) 注入微内核，也可作为独立的 Web 工作台运行在 `0.0.0.0:3000`。
