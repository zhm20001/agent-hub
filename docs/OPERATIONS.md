# AgentHub：安全派发、当前状态与验证证据

适用于 2026-10-20 高优先级修复。设计与实施步骤见 [设计](superpowers/specs/2026-10-20-operational-hardening-design.md)、[计划](superpowers/plans/2026-10-20-operational-hardening.md)。原始事故记录见 [Markview 复盘](reports/2026-10-20-markview-ofm-agenthub-retrospective.md)。

## 先确认能启动，再派发

`POST /api/tasks/preflight` 和 `swarm_preflight` 接收 prompt、adapter、cwd、projectId、mode、workspaceAccess 等派发参数，返回：

```json
{
  "ready": false,
  "cwd": "/projects/reader",
  "workspaceAccess": "write",
  "checks": [{"name":"cwd-allowed","ok":false,"reason":"outside the task-root allowlist"}]
}
```

该示例是响应结构，不代表真实机器路径。预检不启动 Agent、不创建 Task、不绑定 request_key。它复用 adapter 条件和命令检查；真实派发仍重查，因为文件、配置和占用可能在预检后变化。涉及 project/dependency 的只读准备可能正常打开登记库、导入既有任务；不应将预检理解为“绝不产生任何数据库读取/兼容导入”。

`ready=true` 只表明当时本机条件满足，**不证明登录有效、提供商额度充足、网络可达或任务必能完成**。health 的职责仍是服务健康，不混入代理任务判定。

## 工作区读写声明

派发参数 `workspaceAccess` 默认为 `write`。同工作区的写者与任何活跃读者/写者互斥，冲突返回 HTTP 409 `WorkspaceBusyError`；显式 `read` 可以和其他 read 共存。示例：

```json
{"prompt":"Inspect the implementation without editing files","adapter":"codex","mode":"plan","cwd":"/projects/reader","workspaceAccess":"read","request_key":"reader-audit-01"}
```

`read` 是调度声明，**不是权限沙箱**。调用者仍须为具体 Agent 选择适当权限模式、明确不写入；谎报 read 无法被平台可靠识别。

身份使用真实路径和最近 `.git`/`.jj` 根；同仓库子目录及 symlink 别名共享占用，独立 worktree 分开。普通目录的父子路径也互斥。占用检查、请求绑定和任务预留位于同一个跨进程派发锁内。相同 request_key 的重放先返回原任务，不会因原任务自己占用而失败；故意再执行需要新 key。

取消是记录终止意图，不等于操作系统进程已完全消失。取消/超时任务的进程仍活着时保留占用；历史 RUNNING 记录保守阻止进入，先通过现有任务查询/recovery 回收它。不要为了派发新任务手改 meta 状态、删除 PID 文件或清理仓库。

保护仅覆盖**共享同一 runsDir 登记库**的 Hub 实例，不覆盖其他 runsDir、Hub 外进程或一个 Agent 自行启动且脱离其进程组的程序。平台不自动归档/回滚目标仓库；调用者保存补丁时仍需包含其拥有的未跟踪文件，或用下述显式 artifact 留存。

## 活动事实与无输出

GET task detail / `swarm_status` 的 `activity` 包含：

- `observedAt`：本次观察时间。
- `supervisorAlive` / `launchOwnerAlive`：进程存在性事实；不等于模型正在有效工作。
- `log` / `transcript`：available/missing/unlocated、bytes、modifiedAt。
- `agent` / `agentSource`：adapter 能从最多 64 KiB 尾部识别的最近协议事件；缺失表示无法观察，不表示没有活动。事件来自执行器，不是平台对内容的判断。

没有 stalled 字段，不会通过安静时间自动取消。mtime 是文件变化事实，不是 token 进度；64 KiB 之外的事件也可能不可见。原始 transcript 仍由执行器拥有，平台不为活动查询另跑 CLI、调用模型或复制整份 transcript。

## 当前检查点与显式验收

历史 notes 继续 append-only；`latestNote` 只是最近一条笔记，不能代表已验收。`GET /api/projects/:id/context` / `swarm_project_context` 另外返回 `checkpoint` 和 `notesPage: {total,truncated}`。读取不会标记已读。

`POST /api/projects/:id/checkpoints` / `swarm_project_checkpoint` 写入显式当前状态：

```json
{
  "expectedSequence": 0,
  "author": "lead-agent",
  "summary": "Parser patch validated locally; cross-platform CI still pending",
  "nextStep": "Collect CI results for the same revision",
  "revision": "abc123",
  "pullRequest": "https://github.com/owner/repo/pull/1",
  "decision": "pending",
  "sourceTaskIds": ["task-example"],
  "checks": [
    {"name":"local-tests","status":"passed","required":true},
    {"name":"linux-golden","status":"not-run","required":true}
  ],
  "artifacts": [{"path":"/projects/reader/checks/report.json","retain":true}]
}
```

首次 expectedSequence 为 0，之后必须使用最近 checkpoint.sequence，旧写者收到 409，需先读最新状态再决定如何合并。普通 note 不覆盖 checkpoint；goal 仍是项目目标，不被新说明重写。不同项目的 sourceTaskIds 被拒绝。

`decision` 是调用者声明（source=caller），可为 pending/accepted/rejected。平台不会从 COMPLETED、exit0、通过的 checks 推导 accepted；accepted 声明须指定 revision，但平台不替调用者验真 Git SHA、PR、姓名或测试自述。即使调用者接受有未执行检查的版本，failed/not-run 明细也保留，不能拿 accepted 当自动签名或平台背书。应把实际验证报告作为 artifact 绑定；不可仅填一串 passed 后宣称独立验收。

checks 可省略；省略表示没有提供逐项检查，不是“全部通过”。每个状态都须显式为 passed/failed/not-run，required 须为布尔值。

## 显式证据留存

artifacts 需要绝对路径，realpath 必须在项目目录或 runsDir 内；最多 20 项，每项限普通文件 8 MiB。摘要保存 path/sha256/bytes。`retain=true` 才将指定文件写入 runsDir/project-evidence/<project>/<sha256>，不覆盖已有不同内容。不扫描仓库、不自动拷贝原始 Agent transcript，不读取密钥配置内容来判断登录。

当前 context 检查 `sourceState` 和 `retainedState`：available、changed、missing 或 not-retained。源日志变化不改写历史 hash；原文件删除而 retainedState=available 时，可从 retainedPath 读取当时内容。原文件可能持续写入；应等检查结束后再留存，读取中变化会拒绝归档。

保留文件仍属于本机 runsDir。soft archive 不删除它，但机器损坏、手动删除或忽略目录未备份仍可丢失。数据库与 project-evidence 需要一起备份；hash 不是备份。检查点写入失败时可能留下未引用的内容寻址文件，平台不自动删除它，避免误删共享证据。使用验证工具产生的大日志可拆分，不能把超限文件视为已留存。

## 将 CI 转为可执行验证清单

工具独立于 Agent 执行，不增加 Hub 自动裁决能力：

```text
node scripts/verify.mjs --inventory /projects/reader
node scripts/verify.mjs /projects/reader/verification.json /tmp/reader-checks-new
npm run verify -- /tmp/agenthub-checks-new
```

manifest v1 示例：

```json
{
  "version": 1,
  "root": ".",
  "checks": [
    {"name":"workspace tests","argv":["cargo","test","--workspace","--locked","--all-targets"],"required":true},
    {"name":"standalone fuzz","argv":["cargo","check","--manifest-path","fuzz/Cargo.toml","--locked","--bins"],"required":true},
    {"name":"linux goldens","argv":["cargo","test","--test","golden"],"platforms":["linux"],"required":true}
  ]
}
```

此例仅说明结构，命令必须按目标仓库真实 CI 校对。CI 作者/调用者负责将 workflow、脚本、feature、独立 workspace、平台条件和 artifact 检查逐项映射。**`--inventory` 发现 package.json、Cargo.toml、.github/workflows 的路径和 hash，不会解析任意 CI 脚本或证明清单已经完整。** 它跳过 node_modules/target/vendor/lib/dist、版本目录和本地 runs/scratch，不展开 symlink 目录。

将 `--inventory` 的数组填入 manifest.inventory，可检测新增/删除/修改的 workflow 和独立 workspace。额外 scripts 放入 `sources: [{path,sha256}]`；source 路径相对 root。来源在运行前或运行中变化，报告均不再表示本轮矩阵匹配，需要人工核对更新 pins。只填写 sources 而省略 inventory 时，无法检查新发现的独立 workspace；两者都省略时只验证所列命令，不能声称已覆盖 CI。

检查按 argv 直接启动（无 shell 插值），cwd 相对 root，也可显式设为绝对路径，默认每项 15 分钟、最大 1 小时。命令本身仍可以修改仓库，清单应只包含已授权检查；不要运行不可信仓库中的清单。Windows 的 .cmd 工具可用 node 脚本入口替代，原生可执行程序按 argv 调用。

report 目录必须不存在且父目录已存在；不会覆盖旧报告。每项产生日志及 status/exitCode/signal/timedOut。前项失败后仍记录后项；required 未通过（包括平台不匹配 not-run）或来源变化，整体退出 1；SIGINT/SIGTERM 中断退出 130，剩余检查标 not-run。在 POSIX 上终止本检查的进程组；Windows 仅终止直接子进程，复杂子树须由具体工具自身清理，不能据此宣称通用进程树回收。

`report.json.requiredChecksPassed` 只是所声明矩阵的机械结果，**不是业务验收**。初始和进行中报告该字段为 false，最终 completedAt 和逐项结果可供核对；将报告及必要日志显式留存到项目检查点。提供的 AgentHub 自身 verification.json 覆盖隔离测试、类型检查和发布构建；本仓库当前没有 .github/workflows，不编造远程 CI 已运行。

## 升级与运维边界

新功能通过已有 HTTP/工具入口提供；不会自动启用桌面 heartbeat、重试额度失败或重启服务。升级服务前检查活跃任务并按既有运维流程重启，保留同一 runsDir。新表为 additive SQLite 表，不改旧 TaskStatus、resolution/handoff 或事件含义。已有请求键不主动迁移或删除。
