# Agent Hub 智能体接入指南 (Agent Guide)

本指南面向 AI Master Agent（如 DeepSeek Harness 主控智能体、Claude Code、Cursor 或自研多智能体编排器），详细介绍如何调用 Swarm 提供的工具能力进行子任务委托。

---

## 1. 为什么采用脱钩文件流模型？

传统的 Subagent 方案通常要求 Master Agent 保持同步长连接等待子进程返回。但在复杂编码任务中，这存在严重隐患：
1. **主会话阻塞**：子任务耗时 10-30 分钟时，主会话无法响应用户新输入。
2. **连接断裂不可逆**：父进程重启或会话刷新，运行中的子进程管道直接断裂，执行现场丢失。
3. **资源无限泄露**：子进程卡死时缺乏进程级别的主动守护机制。

**Agent Hub 的破局方案**：
- Master Agent 仅需发起轻量的异步派发，立即获得 `taskId`。
- 子任务在独立的操作系统进程中脱钩运行，所有输出直接落盘于物理文件 `.swarm-runs/<taskId>/raw.log`。
- 任务结束时通过文件监听器（Watcher）将执行简报交给已配置的接收方；这不保证任意桌面聊天自动唤醒。

---

## 运行保护与验收

派发前可用 `swarm_preflight`，写入任务默认独占工作区；仅只读任务显式声明 `workspaceAccess=read`。`swarm_status.activity` 提供事实，不因无输出判卡死。用 `swarm_project_checkpoint` 将当前 revision/PR、逐项检查和调用者验收决定与历史 note/机械状态分开；记录前先读取 checkpoint.sequence，避免旧会话覆盖新进展。

完整参数、限制与验证清单见 [运行指南](OPERATIONS.md)。

## 2. 工具定义与契约 (Tool Specifications)

在 DSH 插件激活后，主 Agent 的工具链中会自动注入以下标准工具：

### 2.1 `swarm_dispatch` (派发子 Agent 任务)
启动一个后台脱钩运行的子 Agent 任务。

**参数列表**：
```json
{
  "prompt": {
    "type": "string",
    "required": true,
    "description": "自包含的完整任务要求，包含背景、目标文件及预期修改。"
  },
  "ticket": {
    "type": "string",
    "description": "可选的关联工单号，如 'T1', 'BUG-12'。"
  },
  "description": {
    "type": "string",
    "description": "任务的简短一句话标题。"
  },
  "adapter": {
    "type": "string",
    "enum": ["zcode", "bash"],
    "description": "使用的子 Agent 适配器，默认为 'zcode'。"
  },
  "mode": {
    "type": "string",
    "enum": ["edit", "build", "plan", "yolo"],
    "description": "运行权限模式，默认为 'edit'。"
  },
  "timeout": {
    "type": "number",
    "description": "最大运行超时秒数，超时看门狗将强行杀除进程。默认 1800 秒。"
  }
}
```

**返回结构**：
```json
{
  "taskId": "task-mv0f3msb-2hq5",
  "ticket": "T1",
  "status": "RUNNING",
  "pid": 1024,
  "logPath": ".swarm-runs/task-mv0f3msb-2hq5/raw.log",
  "reportPath": ".swarm-runs/task-mv0f3msb-2hq5/report.md"
}
```

---

### 2.2 `swarm_status` (查询特定任务详情)
获取任务的最新元数据和执行状态。

**参数列表**：
```json
{
  "taskId": {
    "type": "string",
    "required": true,
    "description": "需要查询的任务 ID。"
  }
}
```

**返回结构**：
```json
{
  "taskId": "task-mv0f3msb-2hq5",
  "ticket": "T1",
  "label": "编写用户登录测试",
  "status": "COMPLETED", // RUNNING | COMPLETED | FAILED | KILLED | TIMEOUT_KILLED
  "pid": 1024,
  "startTime": 1728400000000,
  "endTime": 1728400045000,
  "exitCode": 0,
  "adapter": "zcode",
  "cwd": "/workspace/project"
}
```

---

### 2.3 `swarm_roster` (查看任务花名册)
列出当前工作区所有已记录的子 Agent 任务状态一览。

**参数列表**：无参数。

**返回结构**：
返回按开始时间倒序排列的 `TaskMeta` 数组。

---

### 2.4 `swarm_kill` (强杀异常子任务)
如果发现子任务方向错误或主控规划发生变化，强行杀除子 Agent 进程。

**参数列表**：
```json
{
  "taskId": {
    "type": "string",
    "required": true,
    "description": "目标任务 ID。"
  }
}
```

**返回结构**：
```json
{
  "taskId": "task-mv0f3msb-2hq5",
  "status": "KILLED"
}
```

---

## 3. Master Agent 标准工作流设计

AI Master Agent 推荐遵循如下三步循环（Dispatch -> Observe -> Synthesize）：

### Step 1: 精准任务切分与派发
在拆解需求后，Master Agent 针对具体模块调用 `swarm_dispatch`：
```text
[Master Agent 思考]: 我需要修改前端的鉴权组件，这是一个独立的单据任务。
[Tool Call]: swarm_dispatch({
  ticket: "T1",
  description: "实现 OAuth 回调处理函数",
  prompt: "请在 src/auth/callback.ts 中补全 handleCallback 函数，妥善处理 state 校验与 token 提取，完成后运行 npm test 验证。",
  adapter: "zcode",
  mode: "edit"
})
```

### Step 2: 上下文让渡与异步监听
派发成功后，Master Agent 应当向用户汇报派发结果并转入等待态：
```text
[Master Agent 回复]: 已成功派发任务 [T1] 至后台子 Agent (TaskID: task-mv0f3msb-2hq5)。子进程正在脱钩执行中，完成后系统将自动唤醒汇报。
```

### Step 3: 自动唤醒与结果整合
当子任务结束（生成 `.swarm-runs/<taskId>/report.md`），`watcher.ts` 会将结果作为系统消息注入主会话：
```text
[系统唤醒消息]: [Swarm Notice] Task task-mv0f3msb-2hq5 (T1) finished with status: COMPLETED.
[执行简报]:
- Duration: 24s
- Exit Code: 0
- Modified files: src/auth/callback.ts
...
```
Master Agent 收到该 Turn 唤醒后，自动审查修改、继续下一阶段或向用户汇报最终成果。
