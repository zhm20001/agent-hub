# Agent Hub 系统架构与设计文档 (Architecture)

本文档面向核心开发人员与架构师，深入阐述 **Agent Hub** 的微内核整合模式、脱钩进程架构及 DispatchDock 前后端通信规范。

---

## 1. 总体架构分层

系统遵循高内聚、弱耦合的分层原则：

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        前端呈现层 (Web UI)                             │
│       React 19 + Tailwind CSS + Lucide Icons (DispatchDock 移植)       │
│  [任务时间线 / 状态卡片]   [实时 SSE 日志终端]   [Git Diff 视图]  [多语言切换] │
└────────────────────────────────────▲───────────────────────────────────┘
                                     │ HTTP REST + SSE Stream
┌────────────────────────────────────▼───────────────────────────────────┐
│                        服务调度层 (Server)                             │
│                  Express 4 + Vite 中间件 (port 3000)                   │
│      /api/tasks          /api/tasks/:id/stream       /api/tasks/:id/diff│
└──────▲─────────────────────────────▲─────────────────────────────▲─────┘
       │                             │                             │
┌──────┴───────────────┐  ┌──────────┴──────────┐  ┌───────────────┴─────┐
│  DSH Cordis 微内核   │  │    执行器与守护     │  │    多 Agent 适配    │
│  - tools.ts 工具暴露 │  │  - runner/detached  │  │  - adapters/base.ts │
│  - Turn 自动唤醒注入 │  │  - runner/ttl.ts    │  │  - adapters/zcode.ts│
│  - watcher.ts 监听器 │  │  - 跨平台 Kill 树   │  │  - adapters/bash.ts │
└──────────────────────┘  └─────────────────────┘  └─────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────┐
│                      存储与落盘层 (.swarm-runs/)                        │
│   .swarm-runs/<task_id>/meta.json   -> 元数据、状态、PID、耗时         │
│   .swarm-runs/<task_id>/raw.log     -> 标准输出/标准错误物理文件       │
│   .swarm-runs/<task_id>/report.md   -> 执行简报与 Tail 摘要            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 关键核心机制

### 2.1 彻底脱钩的后台执行 (Detached Spawning)
派发先在文件存储中登记 `RUNNING`，占用并发名额，再启动独立的 Node 启动进程。启动进程先记录自己的 PID，才启动真实 Agent；两者处于同一个进程组，标准输出和错误直接写入 `raw.log`。父进程调用 `unref()`，因此平台关闭后任务仍可继续。

看板中的 PID 指向这个启动进程。它等待 Agent 结束，将实际退出码、信号或启动错误写入 `process-exit.json` 后退出。`meta.json` 来不及保存 PID 时，恢复逻辑可从 `process.pid` 补回；没有退出记录的旧任务仍按“进程已结束，退出码未知”收尾。

恢复或取消也可抢先将 `process.pid` 记为 `0`。身份登记采用同目录硬链接的独占创建：启动进程和恢复只能有一方取得登记位置。恢复先取得位置时，迟到的启动进程退出，不会再启动 Agent。

### 2.2 收尾发布与看门狗

任务结束时先记停止事实，随后写收尾记录和报告，最后原子发布 `completion.json`。`watcher.ts` 监听实际目录中的这个发布文件，读取完整报告后通知订阅者。短任务不需要先被观察到 `RUNNING`；同一个 watcher 生命周期内，每任务通知一次。启动前已有的终态任务作为历史基线，不承诺重启后的持久化通知投递。

`ttl.ts` 默认每 10 秒巡检。先恢复已退出的任务，再检查超时；进程仍存活且最近有输出时可延长一次，否则统一调用任务终止逻辑。

任务文件由 `TaskStore` 保管，元数据、收尾记录和报告写好后再原子替换。跨进程更新按任务排队，派发名额检查与启动在同一个锁内进行。每位等待者使用带 PID 和随机标识的独立票据，清理已退出进程的票据不会删除新进程的票据。

任务查询统一由 `task-queries.ts` 整理，HTTP 与工具入口共用。Agent 对话格式在 adapter 中解析为同一份消息列表；报告、对话和模型信息据此生成。文件没变时复用解析结果，变化后重新读取；详情日志最多读取末尾 20KB 后返回 5000 字符。

### 2.3 跨平台进程树杀除 (Cross-Platform Process Termination)
子 Agent 执行复杂脚本时可能衍生孙子进程（例如 Node CLI 启动了一个 Python 脚本或 Bash 编译器）：
- **POSIX 环境**：优先采用 `process.kill(-pid, 'SIGKILL')` 杀死该进程组；失败时降级为 `process.kill(pid, 'SIGKILL')`。
- **Windows 环境**：自动执行 `taskkill /pid ${pid} /T /F`，强制杀死整棵进程树，防止僵尸进程驻留。

### 2.4 Server-Sent Events (SSE) 日志管道
在 `src/server.ts` 中，`/api/tasks/:id/stream` 路由采用原生 SSE 协议：
```typescript
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
```
服务端使用 `createReadStream(logPath, { start: sentBytes, end: stats.size })` 动态拉取增量文件偏移量（Offset），实现了低内存开销的高性能流式日志回放与实时追随。

---

## 3. 多 Agent 适配器体系 (Multi-Agent Adapters)

通过统一的 `WorkerAdapter` 接口，系统具备极强的扩展性：
- `ZCodeAdapter`: 适配百亿/千亿级代码模型的 ZCode CLI，支持 `--resume <sessionId>` 连续轮次以及 `--mode <mode>` 权限管控。
- `BashAdapter`: 适配标准 POSIX Shell，便于执行单元测试套件、构建指令和系统探针。
- `CodexAdapter`: OpenAI Codex CLI（`exec --json`），支持 sandbox 映射与 `resume`；后续可扩展 `ClaudeCodeAdapter` 等。
