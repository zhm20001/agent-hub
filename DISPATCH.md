# Dispatching tickets → Agent Hub

Matt-style tickets in, HTTP dispatch out. No LLM in the batch path.

Live endpoint: `POST /api/tasks/dispatch` on the board (`npm run start` → `:3000`).

> **ADR-0002:** platform does **not** judge success. `COMPLETED` ≠ semantic success.
> Read `closingRecord` + `lastTurn` / transcript yourself.

## Field contract (`POST /api/tasks/dispatch`)

| Body field | Required | Notes |
| --- | --- | --- |
| `prompt` | **yes** | Full instruction for the worker (string). |
| `ticket` | no | Issue / ticket id (e.g. `T-12`, `feat-login`). |
| `label` | no | Short headline; defaults to prompt prefix. |
| `adapter` | no | `zcode` (default), `codex`, or `bash`. Unknown names are refused (no silent ZCode fallback). |
| `mode` | no | `edit` (default), `build`, `plan`, `yolo`. |
| `cwd` | no | Absolute path; **must** be under `AGENT_HUB_TASK_ROOTS` (or default allowlist). HTTP **400** if outside. |
| `workspaceAccess` | no | `write` by default; `read` permits shared readers. Scheduling declaration, not a permission sandbox. Same-workspace writer conflicts return 409. |
| `timeout` | no | Seconds before watchdog kill (default `7200` / `AGENT_HUB_DEFAULT_TIMEOUT`). |
| `resumeSessionId` | no | Start a new execution using an existing CLI session/thread handle after its previous execution has ended; not a live-message channel. |
| `request_key` | no | Stable identity for one request. Same key/input returns the original task; changed input returns 409. |
| `projectId` | no | Existing project notebook. Its directory is the default unless `cwd` is explicit. Text agents also receive goal/latest-note/checkpoint context. |
| `parentTaskId` | no | Related task in the same project; records a relationship, does not create an automatic planner. |
| `dependsOn` | no | Up to 32 distinct, already-ended task IDs, in the same project (or all unassociated). Their bounded handoffs become context; running upstream tasks are refused rather than queued. Text agents only. |
| `handoff` | no | `true` asks ZCode/Codex for a structured agent self-report; it is not verification. Unsupported for Bash. |

Response **201** → task `meta` (`taskId`, `status`, `pid`, …), including when an identical keyed retry returns the original task.

Errors:

| Status | When |
| --- | --- |
| 400 | invalid input, unsupported context injection, or `cwd` outside allowlist |
| 404 | referenced project not found |
| 409 | request key/content conflict, task ID conflict, or reserved request requiring recovery, or occupied workspace |
| 429 | concurrent RUNNING tasks at `AGENT_HUB_MAX_CONCURRENT` (`concurrent_cap`) |
| 500 | unexpected |

## Launch and verification facts

`POST /api/tasks/preflight` / `swarm_preflight` inspect launch readiness without starting an Agent. Task details include bounded `activity` facts; silence is not a stalled verdict.

`POST /api/projects/:id/checkpoints` / `swarm_project_checkpoint` record caller-authored current state and acceptance with sequence CAS, revision, explicit checks and optional retained artifacts. These remain distinct from process status and history notes.

See [operations](docs/OPERATIONS.md) for contracts, limits and the explicit verification matrix runner.

## 重试、接续和通知的约定

### 重试同一次请求

上游 Agent 应在首次派发前生成 `request_key`，保存它，并在网络不确定时使用相同 key 和相同输入重试。不要每次重试都生成新 key。同 key 改内容会返回 409；故意再执行一次才使用新 key。

请求身份预留与启动进程不可能构成一个事务。若 key 已预留但任务登记尚不可读，接口会返回需要恢复的冲突和原任务编号，**不会自动重复启动**。检查并恢复该编号，再读取原请求；不要把未知启动结果当作安全重试新执行的依据。

### 项目与接续记录

| HTTP | 用途 | 对应工具 |
| --- | --- | --- |
| `GET /api/projects` | 项目列表、最新说明及任务数量 | `swarm_projects` |
| `POST /api/projects` | 显式登记或更新 `{id,name,goal,cwd?}` | `swarm_project_set` |
| `GET /api/projects/:id/context` | 目标、接续历史、相关任务与上次确认后变化 | `swarm_project_context` |
| `POST /api/projects/:id/notes` | 追加 `{body,author?,sourceTaskIds?,request_key?}` | `swarm_project_note` |
| `POST /api/projects/:id/seen` | 确认 `{viewerId?,through}` | `swarm_project_seen` |

`context` 接受 `viewerId`、`after`、`limit`；默认最新 20 条接续记录，最大 100。返回 `changesSinceVisit.after/through` 序号。读取不推进进度；确认时传实际读到的 `through`，不能跳到未来。不同阅读者使用不同 `viewerId`。

项目目标只能显式更新。接续记录追加保存，不能覆盖目标或历史；来源任务必须存在并属于同一项目。建议主 Agent 在阶段结束时记录“已确认 / 待验证 / 下一步”，下次开始先读取。平台不会自动生成摘要或认定项目完成。

### Agent 的结构化交接

设置 `handoff: true` 后，文字 Agent 的提示会包含输出约定。最终消息可包含：

````markdown
## Agent Hub Handoff
```json
{"schemaVersion":1,"status":"partial","summary":"完成修改，尚未运行完整测试","verification":["针对性测试通过"],"nextSteps":["执行完整测试"],"artifacts":["src/example.ts"]}
```
````

`status` 为 `success | partial | blocked`，`summary` 非空；三个数组选填。接口详情的 `handoff` 与任务目录 `handoff.json` 记录 `reported / missing / invalid / interrupted` 及来源。Agent 说通过不等于平台验证通过。Bash 的 prompt 是字面脚本，不能使用 handoff 或依赖文字注入；项目关联仅用于归类和默认目录。

### 完成通知

宿主必须通过 `onCompletion`，或插件的 `activeAgentGetter` 接上接收方。仅启动看板不保证通知当前聊天。需要跨重启补投时再提供稳定 `consumerId`。回调失败应抛错，平台保留处理位置并重试；成功后才确认。接收成功与确认之间若退出，可能重复投递，接收方应按任务编号去重。

## Ticket file shapes (batch script)

Put one file per ticket under a tickets dir. Either:

**Markdown** (`*.md`) — YAML front matter + body as prompt:

```md
---
ticket: T-12
label: wire login form
adapter: zcode
mode: edit
cwd: /absolute/path/under/task-roots
timeout: 7200
type: task
status: ready-for-agent
handoff: true
blockedBy: []          # ticket ids that must COMPLETE first
parallel: true         # eligible immediately if blockedBy empty/satisfied
---

Implement the login form per the design in docs/login.md.
Do not invent APIs.
```

**JSON** (`*.json`):

```json
{
  "ticket": "T-12",
  "label": "wire login form",
  "prompt": "Implement the login form…",
  "adapter": "zcode",
  "mode": "edit",
  "cwd": "/absolute/path/under/task-roots",
  "timeout": 7200,
  "type": "task",
  "status": "ready-for-agent",
  "handoff": true,
  "blockedBy": [],
  "parallel": true
}
```

### Whole-batch preflight

Before sending any task, the script reads every file and validates all supported execution fields. It then reads the selected board's roster and checks the complete local dependency graph. Invalid types, duplicate ticket identities in the same project, self-dependencies, unknown dependencies, and cycles abort the entire batch with exit code 1 and **zero dispatch POSTs**. Cycle errors include the path, for example `A -> B -> C -> A`. This validation also covers tickets that are not currently ready.

Dependencies may refer to another local ticket or to a ticket already present in the remote roster **in the same project**. An unknown dependency is an input error; a known but unfinished dependency simply keeps its downstream ticket blocked. Project-scoped identical ticket names are allowed. Explicit `ticket` wins; otherwise Markdown uses its filename stem and JSON uses its source filename, which is also recorded on the board.

`status` remains an open text field: values such as `pending` and `in_progress` remain valid and are skipped by the existing readiness filter. The preflight neither queues work nor invents a new scheduler. `request_key` in a file cannot override the stable key derived by this script; to request a genuinely new attempt, explicitly use a new ticket identity. Object conditions retain their mechanical/self-report meanings below.

### Parallel vs blocked-by

- **`blockedBy`**: list of other ticket ids. A ticket is eligible only when every listed ticket's latest attempt on the selected board has `status === 'COMPLETED'` (mechanical finish — **not** a semantic pass).
- **`parallel: true`** (default): eligible tickets are POSTed in one batch pass (still subject to `AGENT_HUB_MAX_CONCURRENT`).
- **`parallel: false`**: script posts at most one newly eligible ticket per pass (serial).

The batch script always reads the board selected by `--base-url`, including archived tasks, and separates ticket identities by project. It uses a stable request key derived from the absolute ticket directory, project ID, and ticket ID (or filename). Moving the directory changes that key. Existing dispatched ticket IDs are skipped; editing a ticket does not silently start another attempt.

JSON ticket `blockedBy` also accepts `{ "ticket": "T-11", "condition": "ended" }` or `condition: "self-report-success"`. `ended` accepts any terminal mechanical state. `self-report-success` requires a completed process and a valid handoff whose Agent claims success; **it is an explicit trust choice, not verified acceptance**. Legacy strings retain the completed gate. Prefer JSON for object conditions: the Markdown parser supports only flat fields and simple lists.

For text agents, resolved blockers are also passed as `dependsOn` context. Bash uses the gate only and receives no added prose. Skipped tickets (still blocked / already dispatched) are reported; nothing is invented.

### Eligibility filter (batch script only)

Dispatch only POSTs tickets that are **both**:

1. **`Type: task`** — body line `Type:` / `**Type:**` (first token), or frontmatter `type: task`
2. **`ready-for-agent`** — body `Status:` / `**Status:**` contains `ready-for-agent`, **or** frontmatter `status` / `label` string contains it, **or** frontmatter `labels` array includes it

Grilling / parking-lot / research / etc. are skipped (`not-task:…`). Tasks not ready are skipped (`not-ready-for-agent`). Signal is documented here so the filter stays mechanical — no LLM.

### Directory defaults for `cwd` / `adapter`

Per-ticket frontmatter still wins. If omitted, the script fills from CLI or env:

| Source | `cwd` | `adapter` |
| --- | --- | --- |
| Ticket frontmatter / JSON | `cwd:` | `adapter:` |
| CLI | `--cwd PATH` | `--adapter NAME` |
| Env | `AGENT_HUB_DEFAULT_CWD` | `AGENT_HUB_DEFAULT_ADAPTER` |

Not required in every ticket file (directory-level defaults).


## Resume + model selection (ZCode)

- **Resume:** pass `resumeSessionId` on `POST /api/tasks/dispatch` (zcode adapter already passes `--resume`).
- **Model:** headless ZCode has **no** `--model` flag. Durable default + temp switch / restore: **[docs/zcode-default-model.md](./docs/zcode-default-model.md)** (`~/.zcode/v2/provider_config.json` → `config.defaultModelSelection`). Do not invent CLI flags; do not paste API keys into tickets or git.

## COMPLETED ≠ success

`meta.status = COMPLETED` is a mechanical completion state. Normally it accompanies exit 0; recovered records can lack an exit code. It does not establish content success. For meaning:

```bash
curl -sS http://127.0.0.1:3000/api/tasks/<taskId> \
  | jq '{status, exitCode, lastTurn, transcriptPath, closingRecord}'
```

Harvest `lastTurn` is mechanical (ADR-0002). Open `transcriptPath` when present.

## cwd must be under task roots

```bash
export AGENT_HUB_TASK_ROOTS="$PWD:/path/to/other-workspace"
```

See DEMO.md. Outside → HTTP 400 / tool error — no silent fallback.

## Batch script

```bash
# dry-run (read the selected board and print planned POSTs; no dispatch POST)
node scripts/dispatch-tickets.mjs ./tickets --dry-run --cwd "$PWD" --adapter zcode

# dispatch eligible tickets to local board
node scripts/dispatch-tickets.mjs ./tickets --base-url http://127.0.0.1:3000

# or
npm run dispatch-tickets -- ./tickets --dry-run
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Read board state and print payloads; do not POST tasks. Requires the board to be reachable. |
| `--base-url <url>` | Board origin (default `http://127.0.0.1:3000`). |
| `--passes <n>` | Repeat eligibility scan up to n times (default 1) so blockers that finish mid-run can unlock. |
| `--cwd <path>` | Default `cwd` when ticket omits it (else `AGENT_HUB_DEFAULT_CWD`). |
| `--adapter <name>` | Default `adapter` when ticket omits it (else `AGENT_HUB_DEFAULT_ADAPTER`). |

No LLM. Fixtures / curl only.

## Env vars

| Env | Default | Role |
| --- | --- | --- |
| `AGENT_HUB_TASK_ROOTS` | process cwd + `/tmp/agent-hub*` demo | cwd allowlist |
| `AGENT_HUB_MAX_CONCURRENT` | `3` | global RUNNING cap |
| `AGENT_HUB_DEFAULT_CWD` | (none) | batch script default `cwd` when ticket omits it |
| `AGENT_HUB_DEFAULT_ADAPTER` | (none) | batch script default `adapter` when ticket omits it |
| `ZCODE_CLI_PATH` | (required for zcode) | CLI entry; fail-loud if missing |
| `PORT` | `3000` | board listen port |

## Restart after server changes

Vite HMR does **not** reload Express. After API / runner edits:

```bash
npm run restart   # scripts/restart-board.sh
```

## YAGNI 操作约定（上游 Agent）

给**派发 / 收割**的人（或上游 Agent）用的最短清单。平台仍只做机械派发与收割（ADR-0002）。

### 1) 票批约定（ticket batch）

| 约定 | 做法 |
| --- | --- |
| 目录 | `tickets/<topic>/NN-slug.md`（一题一文件；示例：`tickets/markview-abspath/`） |
| 可派发信号 | 正文或 frontmatter 标明 `Type: task` **且** `ready-for-agent`（见上方 eligibility filter） |
| 依赖 | frontmatter `blockedBy: [id, …]`（YAML 数组）；脚本**只认**此键，须与正文 `Blocked by:` 对齐 |
| cwd / adapter | 可省略；目录级用 `--cwd` / `--adapter` 或 `AGENT_HUB_DEFAULT_*`（见上方 Directory defaults） |
| 一批装什么 | **只放彼此独立、且已 ready 的票**（`blockedBy` 已满足或为空）。未 ready / grilling / parking-lot / 仍被挡住的票不要塞进同一批「指望脚本替你挑」——先筛再跑 dry-run |

```bash
# 先看本批会 POST 谁
node scripts/dispatch-tickets.mjs ./tickets/<topic> --dry-run --cwd "$TARGET_WC" --adapter zcode
```

### 2) Done-when：必须带项目验证命令

票正文 `## Done when` / 验收清单**必须写出**该项目的验证命令（可复制），不要只写「看起来对」：

- 例（Rust）：`cargo fmt`、`cargo clippy`、`cargo test …`
- 例（本仓 Node）：`npm test`、针对性脚本

需要跑完整工具链 / 少权限弹窗时：frontmatter `mode: yolo`（ZCode 最大工具权限）。bash allowlist / workspace 信任仍走本机 **`.zcode` / ZCode 设置**，不要在票里塞密钥。验证失败 = 语义未完成——即使 `meta.status=COMPLETED`。

### 3) 并行隔离：分 cwd / jj workspace + TASK_ROOTS

并行票**不要**抢同一脏工作副本：

1. 每条并行任务一个**独立 cwd**（jj workspace / 独立 clone / `mktemp` demo 树）。
2. 看板进程启动前把所有 cwd 根放进白名单：

```bash
export AGENT_HUB_TASK_ROOTS="/path/ws-a:/path/ws-b:$PWD"
# 改 env 后须整进程重启看板
npm run restart
```

3. 票上写绝对 `cwd:`，或批处理统一 `--cwd`（仅当本批共一个根）。cwd 不在白名单 → HTTP **400**，无静默回落。
4. 仍受 `AGENT_HUB_MAX_CONCURRENT` 限制；满员 → **429**。

### 4) Harvest 清单（上游 Agent）

`COMPLETED` / exit 0 **不是**验收通过。上游按序自检：

1. `GET /api/tasks/<taskId>` → 看 `status`、`exitCode`、`lastTurn`、`transcriptPath`、`closingRecord`
2. 读 `lastTurn`（机械末轮）；不够再打开 `transcriptPath` / `npm run transcript -- <taskId>`
3. 在**该任务 cwd**核对：`jj status` / diff、票内写出的 verify 命令是否真的绿
4. 更新票状态（如 `ready-for-human` / `done-parked`）；决定是否再派、续跑（`resumeSessionId`）或人工收尾
5. **不要**把看板 `closingRecord` 当成 merge/PR 许可

```bash
curl -sS http://127.0.0.1:3000/api/tasks/<taskId> \
  | jq '{status, exitCode, lastTurn, transcriptPath, closingRecord}'
```

### 5) 换模型

指针：**[docs/zcode-default-model.md](./docs/zcode-default-model.md)**。改 `defaultModelSelection` 后新开会话 / 必要时 `npm run restart`；旧 session 仍继承上次模型。

### 6) 明确非目标（不做）

| 非目标 | 说明 |
| --- | --- |
| 平台语义判词 | 无 `verdict` / `outcome`；不因「看起来成功」自动标票完成（ADR-0002） |
| 自动语义规划 | 不根据 transcript 自动决定下一步；批处理按明确依赖条件选票，仍由人/上游启动或加 `--passes` |
| 自动上游 PR | 不自动 `jj git push` / `gh pr create`；PR 序见 [DEMO.md](./DEMO.md)#jj-fork--upstream-pr-reusable，由上游执行 |

历史延期讨论（其中事件登记现已实现，语义判词仍未实现）：`.scratch/agent-hub/issues/01d-deferred-state-and-verdict.md`。

## Related

- jj fork PR order (fetch → onto upstream main → push origin → gh pr): [DEMO.md](./DEMO.md)#jj-fork--upstream-pr-reusable
- [DEMO.md](./DEMO.md) — human runbook（含 harvest UI / TASK_ROOTS）
- ZCode 默认模型：[docs/zcode-default-model.md](./docs/zcode-default-model.md)
- [docs/adr/0002-platform-does-not-judge.md](./docs/adr/0002-platform-does-not-judge.md)
- Historical parking lot (event registration is now implemented; semantic verdicts are not): `.scratch/agent-hub/issues/01d-deferred-state-and-verdict.md`
