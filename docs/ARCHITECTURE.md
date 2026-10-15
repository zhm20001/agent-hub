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
传统的 `child_process.exec` 或 `spawn` 默认与父进程共享 stdio 管道，父进程关闭将触发 `SIGPIPE` 或子进程强制退出。

在 `src/runner/detached.ts` 中，我们实现了 DispatchDock 的核心模式：
```typescript
const logFd = openSync(path.join(taskDir, 'raw.log'), 'a');

const child = spawn(commandSpec.cmd, commandSpec.args, {
  detached: true,
  stdio: ['ignore', logFd, logFd], // 彻底脱离父进程管道
  cwd: taskCwd,
  env: commandSpec.env || process.env,
});

// 解除父事件循环对子进程的引用计数，允许父进程或主服务在子进程运行期间随时退出/重启
child.unref();
```

### 2.2 双保险状态流转与看门狗 (Watchdog & Watcher)
为防止任务失控，系统设置了双层防护网：

1. **实时文件监听 (`src/watcher.ts`)**：
   - 基于 `chokidar` 监听 `.swarm-runs/*/meta.json`。
   - 捕捉 `RUNNING -> COMPLETED / FAILED / KILLED` 状态流转。
   - 读取伴随生成的 `report.md`，通过 `apply()` 中注册的回调自动将结果注入活跃的 DSH Master Agent 会话。
2. **主动超时看门狗 (`src/runner/ttl.ts`)**：
   - 定时巡检（默认 10 秒周期）所有活跃任务的 `meta.json`。
   - 若 `Date.now() - startTime > timeout * 1000`，立即触发进程终止，避免死循环造成服务器资源枯竭。

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
