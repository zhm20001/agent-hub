# Agent Hub 最小可跑 Demo（Human Runbook）

> **Live path = Agent Hub swarm board**（`swarm_dispatch` / `npm run start` + board）。

## 一句话原则（ADR-0002）

**平台不判定活成没成。** `COMPLETED` / exit 0 只是机械事实；语义是否成功由人 / 上游 Agent 读 transcript 判断。收尾记录（`resolution.json`）不是 verdict。

## 前置

```bash
cd /Users/zhm20001/dsh/Agent-hub   # 真树（含 .jj / .swarm-runs）；不要用空的 agent-hub 别名路径
# 或：cd <repo-root>  — 文件夹改名后从新路径进入即可
export ZCODE_CLI_PATH=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
# 缺少或路径无效时，派发会 fail-loud（不再偷偷落到 tests/fixtures/fake-zcode.cjs）
# 可选 env：
#   export AGENT_HUB_TASK_ROOTS="$PWD:/path/to/other-workspace"
#   export AGENT_HUB_MAX_CONCURRENT=3          # 全局 RUNNING 上限；满员 → HTTP 429
#   export AGENT_HUB_DEFAULT_TIMEOUT=7200      # 默认 TTL（秒）；到期先探测进度再决定是否延长/杀掉
#   export PORT=3000
```

## 启动看板

```bash
npm run start
# board → http://127.0.0.1:3000
```

## cwd 白名单（派发护栏）

HTTP `POST /api/tasks/dispatch` 与 `swarm_dispatch` 都走 `spawnDetachedTask`；**cwd 不在白名单内会直接拒绝**（HTTP 400 / 工具抛错），清晰报错，不会悄悄落到任意目录。

| 来源 | 允许的 cwd |
| --- | --- |
| 环境变量 `AGENT_HUB_TASK_ROOTS` | 冒号分隔的**绝对路径**列表（设置后**替换**默认，不再附带 demo 前缀） |
| 未设置时（默认） | **进程 cwd**（从 repo root 启动看板时即仓库根）+ `/tmp/agent-hub*` 风格 demo 目录（`path.resolve` 后前缀匹配，含 `/tmp/agent-hub-demo-…`） |

```bash
# 例：只允许本仓库与另一个工作区
export AGENT_HUB_TASK_ROOTS="$PWD:/path/to/other-workspace"
```

Demo 临时目录建议：`mktemp -d /tmp/agent-hub-XXXXXX`（落在默认 demo 前缀下，无需改 env）。

## 并发上限

| 来源 | 含义 |
| --- | --- |
| `AGENT_HUB_MAX_CONCURRENT` | 全局同时 `RUNNING` 任务数上限（默认 **3**） |
| 计数 | 扫描 `.swarm-runs/*/meta.json` 且 `status === RUNNING` |
| 满员 | `POST /api/tasks/dispatch` → **HTTP 429**（`code: concurrent_cap`） |

```bash
export AGENT_HUB_MAX_CONCURRENT=3
curl -sS http://127.0.0.1:3000/api/health | jq .concurrent
```

## 批量派发（无 LLM）

见根目录 [DISPATCH.md](./DISPATCH.md)（含 **YAGNI 操作约定**：票批目录、Done-when 验证命令、并行 cwd/jj 隔离、上游 harvest 清单、换模型指针、非目标）与 `scripts/dispatch-tickets.mjs`：

```bash
node scripts/dispatch-tickets.mjs ./tickets --dry-run
npm run dispatch-tickets -- ./tickets --base-url http://127.0.0.1:3000
```

## ⚠️ 仓库文件夹改名

真树目录名现为 **`Agent-hub`**（含 `.jj` / `.swarm-runs`）。若本机还有空的 / 旧的 `agent-hub` 路径，以带 `.swarm-runs` 的那棵为准。DEMO / 文档优先写 **repo root**；改名后请从**新路径**再 `npm run start`（或 `npm run restart`）：`.swarm-runs` 锚在进程 cwd。`ZCODE_CLI_PATH` 与 `~/.zcode` 仍按本机约定。若曾把绝对路径写进脚本 / env，改名后一并更新。

## ⚠️ 改了 API / server 必须整进程重启

Vite HMR **只热更新前端**；Express 路由与 `src/server.ts` **不会**随保存重载。改 API、runner、adapter 后请：

```bash
npm run restart   # 杀掉 :$PORT（默认 3000）监听进程，再 npm run start
# 等价：bash scripts/restart-board.sh
```

启动日志会打印 `[Agent Hub] v… · server mtime …`，用来确认你连的是新进程而不是旧的。

## 派发一个任务

```bash
curl -sS -X POST http://127.0.0.1:3000/api/tasks/dispatch \
  -H 'content-type: application/json' \
  -d '{"prompt":"用一句话说明当前仓库是做什么的","label":"demo-ping","adapter":"zcode","mode":"plan"}'
```

记下返回的 `taskId`。详情（含 closing record）：

```bash
curl -sS http://127.0.0.1:3000/api/tasks/<taskId> | jq '{taskId,status,exitCode,closingRecord}'
```

Board 的「执行简报」页也会展示 **Closing record（机械事实）**，并标明这不是语义判词。

## 读回 transcript（可选，会碰真实 CLI）

```bash
npm run transcript -- <taskId> --cli "$ZCODE_CLI_PATH"
```

## ⚠️ Token 费用提醒

真实 ZCode 一次短跑大约 **~20k tokens**（见 11c 实测）。日常开发请优先：

```bash
npm test   # fixtures only，不烧真实 token
```

除非你明确要 field probe，否则不要把 e2e 对着真 CLI 连打。

## 你会看到什么

| 字段 | 含义 |
| --- | --- |
| `meta.status = COMPLETED` | 进程 exit 0 结束（机械） |
| `closingRecord.resolution.stopCause` | 为何停（若有）；无则常为正常结束 |
| `closingRecord.resolution.finalText` | adapter 抽出的文本（可空） |
| `sessionRef` / `transcriptRef` | 续跑 / 原文句柄 |
| **没有** `outcome` / `verdict` | 平台不做语义成功判定（ADR-0002） |


## Harvest：末轮回复（机械收割）

看板 Task 详情 → **执行简报** 会展示派发任务对话的 **last turn**（执行 Agent 的最终回复文本），以及「在访达中显示 / 打开完整 JSON」按钮。

- **不是语义判词**（ADR-0002）：标签为 mechanical harvest / 机械收割。
- **来源优先**：磁盘上已有的 transcript JSON/JSONL（如 `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl`）→ 否则 `closingRecord.resolution.finalText`。
- **截断常量**：默认 `LAST_TURN_CAP = 8000`（`src/runner/harvest.ts`，可用 env `AGENT_HUB_LAST_TURN_CAP` 覆盖）。对话摘要 list 仍可短截断；末轮 / closing 展示优先在新 cap 下显示全文，仍超长则省略并注明；「复制此次回复」复制完整 markdown 源（`fullText`，不截断）。
- **Markdown**：执行简报末轮与对话摘要助手气泡用 GFM（`react-markdown` + `remark-gfm`）渲染表格/标题，不再纯 `<pre>`。
- **JSON 路径**：API 字段 `transcriptPath`（已知时）；若仅有 `transcriptRef` 句柄、文件尚未落盘，路径为空——需 readback / 等 Agent 会话文件。`resolutionPath` 指向本任务的 `resolution.json`（收尾记录，不是完整对话）。

```bash
curl -sS http://127.0.0.1:3000/api/tasks/<taskId> | jq '{lastTurn, transcriptPath, resolutionPath}'
```

改了 `LAST_TURN_CAP` / markdown UI / 依赖后请 **整进程重启**看板：

```bash
npm run restart
```


## Board UX（YAGNI）

Kanban 卡片额外展示：

- **绝对开始时间**（`meta.startTime` → Asia/Shanghai `YYYY-MM-DD HH:mm:ss CST`）+ 相对时长
- **模型/供应商**（`meta.modelId` / `meta.providerId`，结算时从 model-io JSONL 或结果文本尽力提取）

任务详情：

- **实时终端**：过滤 `ZCode Built-in missing` / `ZCode Built-in skipped (…)` 等噪声行，并显示「已隐藏 N 条」
- **对话摘要** tab：有 `transcriptPath` 时通过 `/api/tasks/:id/conversation` 拉轻量时序（role + 截断 list 文本）；助手气泡按 GFM 渲染（展示可用至 last-turn cap），「复制此次回复」复制完整源。TIMEOUT 且无 `transcriptRef` 时提示 `~/.zcode/cli/rollout/` 可能仍有会话但看板无句柄

## 默认超时与进度探测

| 来源 | 含义 |
| --- | --- |
| `AGENT_HUB_DEFAULT_TIMEOUT` | 默认 TTL 秒数（**默认 7200**；此前 1800） |
| `AGENT_HUB_TIMEOUT_EXTEND_SEC` | 探测到仍在推进时**一次性**延长的秒数（默认 = 任务 timeout，至少 600） |
| `AGENT_HUB_PROGRESS_FRESH_MS` | raw.log / transcript 的 mtime 视为「仍有进度」的窗口（默认 120000） |
| `AGENT_HUB_LAST_TURN_CAP` | 末轮展示字符上限（**默认 8000**；此前 2000） |

Watchdog 到期时：**不立刻杀**——先探测 PID 是否存活，以及 `raw.log`（或已知 transcript）mtime 是否新鲜。若仍存活且有近期进度，则 `timeoutExtended=true` 并延长一次；已延长过或无进度才 `TIMEOUT_KILLED`。

```bash
export AGENT_HUB_DEFAULT_TIMEOUT=7200
# 改了 server / TTL 策略后必须整进程重启：
npm run restart
```


## Orphan RUNNING reconcile

If the board process restarts (or the spawn close handler never fires), a task can stay `meta.status=RUNNING` after the child PID is gone. That lies on the Kanban and can fill the concurrent cap.

On board queries and watchdog ticks, Hub first restores a missing supervisor PID from `process.pid`. A live dispatcher may still be preparing a launch, so a missing PID alone does not end that task. If the dispatcher is gone and no supervisor has registered, recovery atomically prevents a late launch. Once the supervisor is gone, `process-exit.json` supplies the actual exit facts when available; otherwise legacy tasks become **COMPLETED** with unknown exit code. Recovery fills missing closing artifacts and publishes `completion.json` only after the report is ready. These are mechanical facts, not a verdict (ADR-0002).

```bash
# After restart, list once (or wait ≤ watchdog interval) to clear orphans:
curl -sS http://127.0.0.1:3000/api/tasks | jq '[.[] | select(.status=="RUNNING") | {taskId,pid,status}]'
```

## jj fork → upstream PR (reusable)

For colocated jj repos with `origin` (fork) + `upstream` (canonical), open PRs in this order:

1. `jj git fetch upstream`
2. `jj rebase -b <bookmark> -o main@upstream` (fix conflicts; tip bookmark if needed)
3. **Only then** `jj git push --remote origin --bookmark <bookmark>`
4. `gh pr create --repo <upstream-owner/name> --head <fork-owner>:<bookmark> --base main`

**Gotcha:** push after onto-latest-upstream, not before — otherwise CI runs against a stale base. Markview details: `/Users/zhm20001/markview/AGENTS.md` § Opening a PR to upstream.

## 相关

- ZCode 默认模型（headless 无 `--model`）：[docs/zcode-default-model.md](./docs/zcode-default-model.md)
- 活路径细节：`docs/agent-hub/`、`CONTEXT.md`
- 批量派发：[DISPATCH.md](./DISPATCH.md)
