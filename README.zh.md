---
description: "Agent Hub — 派发本地 Agent、观察执行，并保留轻量项目接续记录。"
kind: "package-bundle"
---

# Agent Hub

[English](README.md) | 中文

Agent Hub 帮助主 Agent 把工作交给 ZCode、Codex 或 Bash，也帮助你在离开一段时间后接上项目。它提供独立后台执行、本地任务看板、项目目标和追加式接续记录。

**进程结束、Agent 自述成功、需求验收通过，是三件事。** Hub 保存执行事实和有来源的陈述；由你或主 Agent 判断是否接受，以及接下来做什么。

## 快速开始

需要 **Node.js 22.13 或更新版本**。

```bash
npm install
export ZCODE_CLI_PATH=/path/to/zcode.cjs  # 使用 ZCode 时配置
npm run start                           # http://127.0.0.1:3000
```

服务默认只监听本机。可选环境变量包括 `AGENT_HUB_TASK_ROOTS`、`AGENT_HUB_MAX_CONCURRENT`、`AGENT_HUB_DEFAULT_TIMEOUT` 和 `PORT`。启动细节见 [DEMO.md](DEMO.md)，派发约定见 [DISPATCH.md](DISPATCH.md)。

## 可以怎样使用

- 通过看板、HTTP、已注册的 `swarm_*` 工具或工单文件派发任务。父看板关闭后，独立 CLI 任务仍继续运行。
- 查看任务状态、日志、对话、报告和版本变化；主动取消，或由巡查执行超时限制。
- 登记项目目标与默认目录，留下带来源的接续记录。回来后查看上次确认以来的变化，再打开相关任务。
- 给同一次派发一个稳定的 `request_key`。回复丢失时重试可找到原任务；同 key 换内容会冲突。
- 请求 Agent 提供约定格式的交接，把有限的上游资料传给下一位文字 Agent。Bash 脚本保持原样。

接续说明、项目目标和执行事实分别保留。平台不自动规划项目、不验收需求、不计算主观完成百分比。完成通知需要宿主明确接入接收方；跨重启补投还需要稳定的 `consumerId`。

## 在其他程序中使用

`createHub({ runsDir })` 统一创建存储、任务执行、查询和项目笔记本。把同一 Hub 交给 `startServer(port, { hub })` 与 `registerSwarmTools(context, activeAgentGetter, hub)`，入口就不会混用不同登记簿。独立实例使用不同运行目录；外部传入的 Hub 由拥有者负责关闭。

`.swarm-runs/hub.sqlite` 保存已登记任务的权威状态、请求身份、事件和进度。任务目录继续保存可读元数据副本、日志、报告与进程证据。旧 JSON 任务在读取时导入；直接编辑或删除副本不会修改或删除数据库里的任务。备份应保留整个运行目录。

## 开发

| 命令 | 用途 |
| --- | --- |
| `npm run start` / `npm run dev` | 启动看板 |
| `npm run restart` | 后端修改后重启 |
| `npm test` | 自动发现全部规格文件，各自在独立临时目录运行 |
| `npm run build` | 后端编译到 `lib`，前端构建到 `dist` |
| `npm run dispatch-tickets -- <目录> --dry-run` | 查询所选看板并预览，不提交任务 |

Vite 自动刷新前端；后端修改需要重启。Agent 使用自己的本地凭据配置，不要把密钥写入提示或工单。

## 文档

- [架构全景与执行时序](docs/ARCHITECTURE.md)
- [HTTP、工具、交接与批量工单](DISPATCH.md)
- [启动和操作指南](DEMO.md)
- [产品定位](PRODUCT.md)、[词汇](CONTEXT.md)、[文档中心](docs/README.md)
- [平台不判定活成没成](docs/adr/0002-platform-does-not-judge.md)
