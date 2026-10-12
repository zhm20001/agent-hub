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
| `adapter` | no | `zcode` (default) or `bash`. |
| `mode` | no | `edit` (default), `build`, `plan`, `yolo`. |
| `cwd` | no | Absolute path; **must** be under `AGENT_HUB_TASK_ROOTS` (or default allowlist). HTTP **400** if outside. |
| `timeout` | no | Seconds before watchdog kill (default `7200` / `AGENT_HUB_DEFAULT_TIMEOUT`). |
| `resumeSessionId` | no | ZCode `--resume <sess_…>` handle. Hub adapter wires it when set. |

Response **201** → task `meta` (`taskId`, `status`, `pid`, …).

Errors:

| Status | When |
| --- | --- |
| 400 | missing `prompt`, or `cwd` outside allowlist (`CwdNotAllowedError`) |
| 429 | concurrent RUNNING tasks at `AGENT_HUB_MAX_CONCURRENT` (`concurrent_cap`) |
| 500 | unexpected |

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
  "blockedBy": [],
  "parallel": true
}
```

### Parallel vs blocked-by

- **`blockedBy`**: list of other ticket ids. A ticket is eligible only when every listed ticket already has a task in `.swarm-runs` with `status === 'COMPLETED'` (mechanical finish — **not** a semantic pass).
- **`parallel: true`** (default): eligible tickets are POSTed in one batch pass (still subject to `AGENT_HUB_MAX_CONCURRENT`).
- **`parallel: false`**: script posts at most one newly eligible ticket per pass (serial).

Skipped tickets (still blocked / already dispatched) are reported; nothing is invented.

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

`meta.status = COMPLETED` only means the process exited 0. For meaning:

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
# dry-run (print planned POSTs, no network)
node scripts/dispatch-tickets.mjs ./tickets --dry-run --cwd "$PWD" --adapter zcode

# dispatch eligible tickets to local board
node scripts/dispatch-tickets.mjs ./tickets --base-url http://127.0.0.1:3000

# or
npm run dispatch-tickets -- ./tickets --dry-run
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Print payloads; do not POST. |
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
| 自动链式派发 | 不根据 transcript / closing 自动派下一张；`blockedBy` 只认机械 `COMPLETED`，仍由人/上游跑 batch 或加 `--passes` |
| 自动上游 PR | 不自动 `jj git push` / `gh pr create`；PR 序见 [DEMO.md](./DEMO.md)#jj-fork--upstream-pr-reusable，由上游执行 |

Parking lot（verdict / event-log / MCP）：`.scratch/agent-hub/issues/01d-deferred-state-and-verdict.md`。

## Related

- jj fork PR order (fetch → onto upstream main → push origin → gh pr): [DEMO.md](./DEMO.md)#jj-fork--upstream-pr-reusable
- [DEMO.md](./DEMO.md) — human runbook（含 harvest UI / TASK_ROOTS）
- ZCode 默认模型：[docs/zcode-default-model.md](./docs/zcode-default-model.md)
- [docs/adr/0002-platform-does-not-judge.md](./docs/adr/0002-platform-does-not-judge.md)
- Parking lot for verdict / event-log / MCP: `.scratch/agent-hub/issues/01d-deferred-state-and-verdict.md`
