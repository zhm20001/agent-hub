# Seam（接缝）结构调查报告

> 只读调查产物。调查范围：本仓库 `/Users/zhm20001/dsh/dsh-subagent-zcode`，覆盖（A）它作为消费者接入的 DSH 宿主 seam，与（B）它自建的 seam 与边界；宿主侧契约以 `/Users/zhm20001/deepseek-harness` 中的定义文件为准核对。全文所有结论均带 `file:line` 证据；未能确认处明确标注「未找到证据」。未运行任何 build / dev server / 真实 `zcode` CLI。

---

## 0. 结论摘要（TL;DR）

1. **本仓库当前实际存在两套互不相交的面（face）**，而不是「一套架构加一套外壳」：
   - **Face A（DSH provider 面）**：`src/provider.ts`、`src/run.ts`、`src/cli.ts`、`src/notice.ts`、`src/job-index.ts`、`src/billing.ts`、`src/log-tail.ts`、`src/config.ts`、`src/brand.ts`。它完整、严谨地消费宿主 seam（subprocess / subagent / jobs / tools），并有 1774 行行为测试覆盖。
   - **Face B（swarm 微内核 + Web 面）**：`src/index.ts`、`src/tools.ts`、`src/runner/detached.ts`、`src/runner/ttl.ts`、`src/watcher.ts`、`src/server.ts`、`src/adapters/*`、`src/web/*`。它绕过全部宿主 seam，自建进程管理、落盘契约与 HTTP 面，**测试覆盖为零**。
2. **两套面之间没有一道干净的缝**：唯一的汇合点 `src/index.ts` 只加载 Face B（`src/index.ts:23`、`:40`），Face A 的文件没有任何生产调用者（见 §4.6）。而 `README.md`、`README.zh.md`、`cordis.patch.yml` 与 `tests/subagent-zcode.spec.ts` 四方全部还在描述 Face A——**文档、契约、测试、实现四者不一致**。
3. **最危险的单项发现**：`tests/subagent-zcode.spec.ts:36` 从 `../src/tools.ts` 导入的 `settleForegroundRun` / `settleZcodeJob` 在当前源码中已不存在（`src/tools.ts` 仅导出 `registerSwarmTools`，见 `src/tools.ts:15`），且 `tests/subagent-zcode.spec.ts:872`、`tests/real-zcode.e2e.ts:44` 的 `ctx.plugin(zcode, config)` 无法对一个 module namespace 对象生效——**现有测试套件在当前源码上不可能通过**。
4. **真 seam 共 6 条**（A1 subprocess、A2 subagent、A3 jobs、A5 zcodeJobs 服务、B6 validated Config、B8 zcode CLI headless 契约），全部集中在 Face A；Face B 的 5 处「边界」中，只有 B1 WorkerAdapter 具备三角色结构，其余是**单实现边界（不可替换）或隐式文件契约**。
5. **生产代码内嵌测试替身**：`src/adapters/zcode.ts:8,21-22` 在没有真实 CLI 时把 `tests/fixtures/fake-zcode.cjs` 当默认 CLI，`src/adapters/zcode.ts:49-53` 还会向子进程注入 `FAKE_ZCODE_*` 环境变量——测试替身出现在生产默认路径上，是最需要立刻拆除的一处。

---

## 1. 判定标准

本报告采用任务给定定义：

> **seam** = 一个「调用方不必改动就能替换其实现」的边界，由三角色构成：**Definition**（契约）/ **Provider**（实现）/ **Consumer**（调用方）。缺一角不成其为真 seam。

与宿主 `docs/glossary.md:7-9` 的定义一致（「a *swappable capability* with three roles: a Service Definition … one or more Service Providers, and one or more Consumers that inject the service」），并遵循其边界规则：「The seam is the complete capability, never one role」。

据此，本报告把边界分四档：

| 档位 | 含义 |
| --- | --- |
| **真 seam** | 三角色齐全、有替换实现或测试替身、契约被测试钉住 |
| **边界（非 seam）** | 有 Definition/Consumer，但实现写死、无可替换槽位 |
| **死 seam** | 契约与实现都在，但当前没有任何 Consumer 接线 |
| **假 seam / 漏缝** | 只是普通函数调用，或契约从实现细节泄露，或只换皮不换契约 |

---

## 2. 全局事实：迁移把仓库切成了两半

`git show 53e5413`（`refactor: migrate to swarm agent architecture`）是一次整体替换而非增量叠加：

- 迁移前 `src/index.ts` 是标准 cordis 插件：`inject = ['subagents', 'subprocess', 'tools', 'jobs']`，`apply()` 内依次接线 `ctx.jobs.attachController('subagent-zcode')`、`new ZcodeJobIndex(ctx, …)`、`createBillingGuard(...)`、`ctx.subagents.registerProvider(new ZcodeProvider(ctx, resolved))`、`registerZcodeNoticeListener(...)`、`registerZcodeTools(...)`（`git show 8f6164e:src/index.ts` 第 19–56 行区域；`registerZcodeTools` 定义于 `git show 8f6164e:src/tools.ts:203`，内部用宿主 `defineTool` 注册工具、`ctx.jobs.start` 启动任务，import 见 `git show 8f6164e:src/tools.ts:14`）。
- 迁移后 `src/index.ts` 改为 `inject = ['tools']`（`src/index.ts:13`），`apply()` 只做三件事：注册 4 个 swarm 工具（`src/index.ts:23`）、订阅 watcher 注入通知（`src/index.ts:26-37`）、启动 HTTP 服务器（`src/index.ts:40`）。第一个入参 `_config` 被完全忽略（`src/index.ts:21`）。

后果：

| 资产 | 迁移后状态 | 证据 |
| --- | --- | --- |
| Face A 的 10 个模块 | 全部无生产调用者（孤儿代码） | 全文 §4.6 |
| `tests/subagent-zcode.spec.ts` | 测的是 Face A，且导入已删除的导出 | `tests/subagent-zcode.spec.ts:36` |
| `README.md` / `README.zh.md` / `cordis.patch.yml` | 描述 Face A 的 `zcode` provider、`zcodeJobs`、`zcode_dispatch` | `README.md:32,52,57,75`；`cordis.patch.yml:2` |
| Face B 自身 | 零测试 | `grep -n "swarm" tests/subagent-zcode.spec.ts` 无命中 |

---

## 3. Seam 清单

### 3.1 汇总表

| ID | 名称 | 类 | 判定 | Definition 位置 | Provider | Consumer | 测试覆盖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | subprocess seam（`ctx.subprocess`） | A | 真 seam | 宿主 `packages/subprocess/subprocess/src/index.ts:117,153`；`src/types.ts:77,169,142` | `LocalSubprocessRuntime`（宿主 `packages/subprocess/subprocess-local/src/index.ts:59`）；另有 `SshSubprocessRuntime`（`packages/ssh/subprocess-ssh/src/index.ts:229`） | 本包 `src/provider.ts:49`、`src/run.ts:26,88,105-108` | `tests/subagent-zcode.spec.ts:366-642`（16 例，真实驱动 fake CLI） |
| A2 | subagent seam（`ctx.subagents`） | A | 真 seam（本包任 Provider） | 宿主 `packages/subagent/subagent/src/index.ts:198,510,557`；`src/types.ts:344,308,271,252`；`src/out-of-process.ts:57,106,147,192,245` | 本包 `src/provider.ts:29` `ZcodeProvider`；注册表属宿主 | 宿主 `tool-subagent`（`packages/subagent/tool-subagent/src/index.ts:550,563`）；本包测试 `tests/subagent-zcode.spec.ts:1170-1199` | `tests/subagent-zcode.spec.ts:888-901,1162-1200` |
| A3 | jobs seam（`ctx.jobs`） | A | 真 seam | 宿主 `packages/jobs/jobs/src/index.ts:85,110,192`；`src/types.ts:34,55,243,200-226`；`src/view.ts:65` | `LocalJobRegistry`（宿主 `packages/jobs/jobs-local/src/index.ts:128`） | 本包 `src/notice.ts:98`、`src/run.ts:98`、`src/log-tail.ts:46` | `tests/subagent-zcode.spec.ts:1313-1504`（notice 阶梯）、`:699-792`（settle 映射） |
| A4 | tool registry seam（`ctx.tools`） | A | 假 seam（契约被绕过） | 宿主 `packages/core/tools/src/index.ts:807,1063,1230,1369`；`ToolDefinition` 在 `:223`（`output` 强制）；`ToolSchema` 在 dsh-llm `types.ts:473-484` | `ToolRuntime` 本身是具体类，**无替换实现**（宿主内 `extends ToolRuntime` 未找到） | 本包 `src/tools.ts:19,75,112,130` | 无（swarm 工具零覆盖） |
| A5 | `ctx.zcodeJobs` 自注册 Service | A | 死 seam | 本包 `src/job-index.ts:64,76`（`extends Service`，`super(ctx,'zcodeJobs')`）；宿主扩展点即 cordis `Service` | 本包 `ZcodeJobIndex` 实例 | 旧 `tools.ts`/`notice.ts`；现状**无人构造** | `tests/subagent-zcode.spec.ts:794-831` |
| A6 | Agent 投递面（`followup` / `inject`） | A | 死 seam + 影子实现 | 宿主 `@deepseek-ai/dsh-agent` 的 `Agent`（`status`/`followup`/`inject`） | 宿主 agent 实现 | 本包 `src/notice.ts:121-133`（正路，无调用者）；影子实现 `src/index.ts:26-37` | `tests/subagent-zcode.spec.ts:1241-1504`（notice 部分） |
| B1 | WorkerAdapter 端口 | B | 真 seam（契约薄） | 本包 `src/adapters/base.ts:21-25`（`name`/`description`/`buildCommand`） | `src/adapters/zcode.ts:11`、`src/adapters/bash.ts:3` | `src/runner/detached.ts:38-43`（`getAdapter`）、`:73` | 无 |
| B2 | detached spawn 进程边界 | B | 边界（非 seam，实现写死） | 隐式：`TaskMeta`（`src/runner/detached.ts:10-24`） | `src/runner/detached.ts:94-99`（`spawn` + `detached` + stdio 落盘）、`:160`（`unref`）、`:227-244`（进程组 SIGKILL） | `src/tools.ts:53`、`src/server.ts:65`、`src/runner/ttl.ts:53` | 无 |
| B3 | TTL 看门狗 | B | 边界（非 seam） | 隐式：`meta.json` 的 `timeout`/`status` 字段 | `src/runner/ttl.ts:29-66` | 无订阅者（纯副作用） | 无 |
| B4 | `.swarm-runs/` 存储契约 | B | 漏缝（隐式契约，无 schema） | `TaskMeta` 接口（`src/runner/detached.ts:10-24`），落盘无校验（`:165-173` 仅 `JSON.parse` try/catch） | 三个文件的生产者：`detached.ts:135,144,154`、`ttl.ts:56,62`、`tools.ts:98,103`、`server.ts:132,137` | `src/watcher.ts:17,54`、`src/server.ts:86,119,178`、`src/tools.ts:86,123`、`src/runner/ttl.ts:39` | 无 |
| B5 | REST + SSE 传输边界 | B | 浅 seam | HTTP 端点形状（`src/server.ts:38,58,84,117,147,196,215`），**无 schema、无类型共享**（前端 `src/web/types.ts:3-17` 手抄 `Task`） | `src/server.ts` | `src/web/App.tsx:37`、`QuickDispatchBar.tsx:33`、`TerminalView.tsx:23`（EventSource） | 无 |
| B6 | validated Config（部署契约） | B | 死 seam（契约+测试齐，无 Consumer） | `src/config.ts:118-130`（schemastery schema）、`:184-251`（`resolveConfig` fail-loud）、`:260-269`（`assertInsideTaskRoots`） | `resolveConfig` | 旧 `provider.ts`/`tools.ts`；现状无人调用（`src/index.ts:21` 忽略 config） | `tests/subagent-zcode.spec.ts:124-262`（10 例，密集） |
| B7 | Watcher 订阅边界 | B | 边界（单例 + 单订阅者） | `TaskCompletionCallback`（`src/watcher.ts:6`） | `SwarmRunsWatcher` 单例 `defaultWatcher`（`:73`），chokidar 监听 `meta.json`（`:17-24`） | `src/index.ts:26`（注入通知） | 无 |
| B8 | zcode CLI headless 契约 | B | 真 seam（本包最深之一） | 本包 `src/cli.ts:58-68`（argv 组装）、`:143-167`（严格解析）、`:81-92`（`ZcodeHeadlessOutput` 形状） | 真实 zcode CLI；测试替身 `tests/fixtures/fake-zcode.cjs` | `src/run.ts:203`、`src/provider.ts:43` | `tests/subagent-zcode.spec.ts:272-347,366-642` |
| B9 | billing 弱自检 | B | 死 seam（外部 SQLite 隐式契约） | `BillingGuard`（`src/billing.ts:36-39`） | `createBillingGuard`（`src/billing.ts:95-112`） | 旧 `tools.ts`（`git show 8f6164e:src/tools.ts:203` 签名含 `billing`）；现状无人调用 | `tests/subagent-zcode.spec.ts:1630-1731` |
| B10 | log-tail 观察源 | B | 死 seam | `zcodeLogTailSource`（`src/log-tail.ts:46-64`），形状服从 A3 的 `JobOutputSource` | 本包对 CLI day log 的尾读 | 旧 `tools.ts`（`git show 8f6164e:src/tools.ts` 的 `jobSources`）；现状无人调用 | `tests/subagent-zcode.spec.ts:1732+` |
| T1 | fake-zcode 测试替身 | 替身 | 双重身份（B8 的替身 / B1 的生产默认） | 替换 B8：argv 解析（`tests/fixtures/fake-zcode.cjs:20-28`）+ 7-key JSON stdout（`:68-77`） | fixture 本身 | B8 消费者；**以及生产路径 `src/adapters/zcode.ts:8,21-22,49-53`** | 自身即测试基础设施 |

### 3.2 逐条要点

**A1 subprocess seam（真 seam，但 Consumer 链已断）。** 宿主把契约钉得很死：`spawn` 同步返回活句柄、`done` 解析出退出事实、collect 模式 reader 按字节偏移且非消耗式（宿主 `packages/subprocess/subprocess/src/index.ts:94-116`；`src/types.ts:142-151`「Offsets are whole-stream byte coordinates owned by the caller」）。本包的消费方式是模范式的：`src/run.ts:98-112` 把 `collected.stdout/stderr` 适配成 jobs 的 `JobOutputSource`；`src/run.ts:119-128` 的 `disposeZcodeChild` 用 `terminate()` + `waitForExit()` + `done` 三段等待静止；`src/run.ts:172-179` 显式声明 `graceMs`、`signal`、spill 上限。可替换性真实存在（宿主另有 ssh provider）。问题只在：`src/provider.ts` 无人调用，A1 的 Consumer 链整体悬空。

**A2 subagent seam（真 seam，本包任 Provider 角）。** 注册表支持多 provider 并存（宿主 `packages/subagent/subagent/src/index.ts:7-8,203`）。本包的 `ZcodeProvider`（`src/provider.ts:29-55`）正确使用 `NO_START_CAPABILITIES`（`:30`，声明「出进程子代无法 honoring 父侧强制特性」，语义见宿主 `out-of-process.ts:53-57`）、`resolveChildCwd`（`:41`）、`assertInsideTaskRoots`（`:42`）。`structured` 槽是这条 seam 上唯一的契约泄漏点：宿主把 `SubagentResult.structured` 类型为 `unknown`（宿主 `types.ts:271`，理由 `:285`「the seam is schema-agnostic」），于是本包必须自带窄化守卫 `asZcodeHeadlessOutput`（`src/cli.ts:177-192`），并在注释里自认「produced by this package's own provider across the subagent seam's `structured` slot」（`src/cli.ts:170-172`）。这是宿主设计使然，但意味着**任何跨 provider 消费 headless 事实的代码都要重复一遍守卫**。

**A3 jobs seam（真 seam）。** 本包以两个姿势消费：产出侧 `subprocessSources`（`src/run.ts:98`）与 `zcodeLogTailSource`（`src/log-tail.ts:46`）都实现 `JobOutputSource`（宿主 `types.ts:55`「A pull source the registry pumps into the job's output ring」）；事件侧 `src/notice.ts:98` 订阅 `{ owners: 'scope' }`（宿主 `types.ts:235-237`），并严格遵守 `settled`/`awaited`/`teardown` 语义（`src/notice.ts:99-102`）。`ctx.jobs.start` 在当前 `src/` 中**未找到调用**（迁移前在 `git show 8f6164e:src/tools.ts:306,407`）。

**A4 tool registry seam（假 seam）。** 三处违约，且都被 `src/types/dsh.ts:7-10` 的 `tools?: { register: (tool: any) => void }` 掩护：
1. 缺 mandatory `output` 声明（宿主 `packages/core/tools/src/index.ts:225`「Mandatory canonical output declaration」；`src/tools.ts:19-72` 的注册对象只有 name/description/parameters/execute）；
2. `parameters` 是 `{ prompt: { type: 'string', required: true } }` 形式的简写映射（`src/tools.ts:23-47`），而 `ToolDefinition.parameters` 要求 JSON Schema 对象（dsh-llm `types.ts:482-483`）。简写形态只有经宿主 `defineTool` 才合法（`packages/core/tools/src/schema.ts:554,577,584` 会把它编译成 JSON Schema 并补全 `output`）——迁移前正是这么做的（`git show 8f6164e:src/tools.ts:14,231`），现在直接 `ctx.tools.register` 裸对象，编译步骤被跳过；
3. `execute(args)` 不收 `exec: ToolRunContext`（`src/tools.ts:49`），无法转发调用方取消信号（宿主契约见 `packages/core/tools/src/index.ts:227-235`）。

**A5 `ctx.zcodeJobs`（死 seam）。** 契约本身是包内最好的模块之一：register/settle 恰好一次、claim/release 同步原子（`src/job-index.ts:83-119`）。但 `new ZcodeJobIndex(...)` 在当前 `src/` 中**未找到任何调用点**，`ctx.zcodeJobs` 的类型声明（迁移前在 `git show 8f6164e:src/index.ts` 的 `declare module '@deepseek-ai/cordis'`）也已随之消失。

**A6 Agent 投递面（死 seam + 影子实现）。** 正路是 `src/notice.ts:121-133` 的 followup/inject 阶梯（含 `maxConsecutiveWakes` 预算与 `agent/inbox/claimed` 回填，`src/notice.ts:90-96`）——语义完整但无调用者。影子实现在 `src/index.ts:26-37`：直接 `currentAgent.inject({ type: 'text', text: '[Swarm Notice] …' })`，绕开 jobs 事件、绕开 `createUserMessage` 的 source kind 体系。且 `currentAgent` 声明后**永不被赋值**（`src/index.ts:16`；`grep currentAgent src/` 只有 `:16/:23/:27` 三处，无写入）——这条通知链路是死代码。

**B1 WorkerAdapter（真 seam，但契约最薄）。** `src/adapters/base.ts:21-25` 只有 `name`/`description`/`buildCommand` 三个成员；扩展一个新后端确实零成本（`src/adapters/bash.ts` 仅 14 行）。但契约薄到没有验证、没有健康检查、没有生命周期：`getAdapter` 对未知名**静默 fallback 到 ZCodeAdapter**（`src/runner/detached.ts:41-42`），拼错的 adapter 名不会报错。

**B2 detached spawn（边界，非 seam）。** `src/runner/detached.ts:94-99` 直接调 `node:child_process` 的 `spawn`，`detached: true` + `stdio: ['ignore', logFd, logFd]` + `child.unref()`（`:160`）。这是对 A1 subprocess seam 的**平行替代**而非其 provider：宿主 seam 提供的 collected readers、spill、graceMs 分级终止、managed-range 语义（宿主 `types.ts:182-195`）在这里全部不用，改用裸 `process.kill(-pid, 'SIGKILL')`（`src/runner/detached.ts:233`）。它不可替换（没有实现槽位），所以按判定标准是「边界」。设计理由在 `docs/README.md`「为什么脱离原版 subprocess 管道？」与 `docs/AGENT_GUIDE.md:9-13` 有陈述（父进程退出时管道断裂），但那是产品决策，不改变它不是 seam 的事实。

**B4 `.swarm-runs/` 存储契约（漏缝，全仓库最典型的隐式契约）。** 三个文件、五个写入方、至少四个读取方，靠 `TaskMeta` 接口（`src/runner/detached.ts:10-24`）口头约定：`readTaskMeta` 只做 `JSON.parse` + try/catch 返 null（`:165-173`），无 schema、无版本号、无必填校验。写得一方（人肉编辑、半截写入）就会让 watcher 静默跳过（`src/watcher.ts:49-50` 的 `if (!meta) return`）。写得正确的一方有防护：close handler 只在 `status === 'RUNNING'` 时覆盖（`src/runner/detached.ts:140`），使 TTL 看门狗抢先写 `TIMEOUT_KILLED`（`src/runner/ttl.ts:56`）后不会被迟到 的 close 事件改写——这个竞态防护是碰巧做对的，没有任何测试保护它。

**B5 REST+SSE（浅 seam）。** `src/server.ts` 定义 7 个端点，`src/web/**` 消费；契约同步完全靠人肉：`src/web/types.ts:3-17` 的 `Task` 是 `TaskMeta`（`src/runner/detached.ts:10-24`）的手抄副本，`rawLogTail` 截断 5000 字节（`src/server.ts:110`）这类事实只存在于服务端代码里。SSE 通道用 `setInterval` 500ms `statSync` 轮询文件（`src/server.ts:177-186`），而仓库里已有 chokidar 观察同一文件（`src/watcher.ts:17`）——两条观察机制、两套 cadence，无共享。

**B6 validated Config（死 seam，但是本包最深的模块）。** `src/config.ts:184-251` 一个入口做完全部 fail-loud：CLI 入口必须绝对路径且可执行（`:186-196`）、白名单非空且每个 root 可进入（`:197-206`）、数值/枚举/空串范围校验（`:207-232`）。README.md:36-48 把 12 个字段的契约写成了文档。**但 Face B 一个字段都不用**：mode 硬编码 `'edit'`（`src/tools.ts:58`）、timeout 硬编码 1800（`src/tools.ts:60`）、端口/HOST 硬编码（`src/server.ts:25-26`）、cwd 无白名单（`src/tools.ts:51`）、无并发上限、无计费自检。`src/index.ts:21` 的 `_config?: any` 是这一切的缩影。

**B8 zcode CLI headless 契约（真 seam，且被双实现）。** `src/cli.ts` 是经过实测的 CLI 面：`--resume` 置前、`--disallowed-tools` 逗号拼接以免变长旗标吞掉 `--cwd`（`src/cli.ts:52-56` 注释即契约说明）、`--mode` 永远显式（`:65`）、stdout 只读 4 个已验证 key、未知 key 明确忽略（`:134-137` 注释「they are diagnostics, not dispatch facts」）。**同一契约在 `src/adapters/zcode.ts:28-56` 被实现了第二遍**，且已经漂移：Face B 版会把 `.cjs/.js` 入口包一层 `node`（`src/adapters/zcode.ts:29-31`）、不注入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（对比 `src/run.ts:169-171`）、并在命中 fixture 时注入 `FAKE_ZCODE_*`（`src/adapters/zcode.ts:49-53`）。

**T1 fake-zcode（测试替身，替换点是 B8）。** `tests/fixtures/fake-zcode.cjs` 精确复刻 B8 的输入侧（解析 `--resume`/`-p`，`:20-28`）与输出侧（7-key JSON：sessionId/traceId/turnId/response/usage/eventCount/projection，`:68-77`），并用 7 种 `FAKE_ZCODE_BEHAVIOR` 覆盖失败面（`:31-54`）。它把 B8 钉得很死：`tests/subagent-zcode.spec.ts:273-291` 断言 argv、`:293-330` 断言解析的接受与拒绝。**问题不在替身本身，而在它同时是生产默认**：`src/adapters/zcode.ts:8` 把 fixture 路径编译期内嵌，`:21-22` 在无真实 CLI 时选中它，`:49-53` 再注入 fake 专用环境变量。也就是说，`swarm_dispatch` 在一台没装 ZCode 的机器上会「成功」跑完一个假 CLI 并回报假结果。

---

## 4. Seam 拓扑图

```
                        ┌────────────────────────────────────────────────┐
                        │        DSH 宿主（deepseek-harness）             │
                        │  ctx.subprocess   ctx.subagents   ctx.jobs      │
                        │  ctx.tools        ctx.agents      cordis Service│
                        └───▲──────────▲──────────▲──────────▲───────────┘
              A1 spawn │          A2 registerProvider   A3 events.subscribe │ A5 Service 注册
                      │          │                    │                    │
  ┌───────────────────┴──────────┴────────────────────┴────────────────────┴─┐
  │  Face A：DSH provider 面（契约完整、测试齐全、当前无生产接线 = 死代码）      │
  │                                                                          │
  │  provider.ts ──▶ run.ts ──▶ cli.ts (B8 契约)        notice.ts ──▶ A6     │
  │      │             │  └─▶ subprocessSources ──▶ A3                       │
  │      └─ A1 ctx.subprocess.spawn        job-index.ts ──▶ A5 (ctx.zcodeJobs)│
  │                                        billing.ts / log-tail.ts / config.ts│
  └──────────────────────────────────────────────────────────────────────────┘
                      │ B8：zcode CLI headless 契约（argv + stdout JSON）
                      ▼
        ┌───────────────────────────┐        ┌──────────────────────────────┐
        │  真实 zcode CLI 子进程      │        │  tests/fixtures/fake-zcode   │
        │  （A1 managed child）      │        │  （B8 的测试替身）            │
        └───────────────────────────┘        └───────────▲──────────────────┘
                                                        │ 也被 B1 的生产默认路径选中
  ┌────────────────────────────────────────────────────┴───────────────────┐
  │  Face B：swarm 微内核 + Web 面（唯一被 index.ts 加载的面，零测试）        │
  │                                                                        │
  │  index.ts ──▶ tools.ts (swarm_dispatch/kill/status/roster) ──┐          │
  │     │            │ A4（裸 register，违约）                    │ B2      │
  │     │            ▼                                           ▼          │
  │     │     runner/detached.ts ──▶ adapters/base.ts (B1) ──▶ zcode.ts/bash │
  │     │            │  spawn(detached) + unref + killTree                    │
  │     │            ▼                                                      │
  │     │     .swarm-runs/<taskId>/{meta.json, raw.log, report.md}  (B4)     │
  │     │            ▲                                    ▲                  │
  │     │     watcher.ts (B7) ──▶ 死代码注入 (A6 影子)     │ B5 REST/SSE      │
  │     │     runner/ttl.ts (B3)                            │                  │
  │     └─▶ server.ts ──▶ web/** (fetch + EventSource) ◀────┘                  │
  └──────────────────────────────────────────────────────────────────────────┘
```

边与 seam 的对应：A1/A2/A3/A4/A5/A6 为宿主注入边；B1 为包内端口边；B2/B3/B4/B7 为包内文件与进程边；B5 为传输边；B8 为跨出进程的 CLI 契约边（两条实现：`cli.ts` 与 `adapters/zcode.ts`）。注意图中 **Face A 与 Face B 之间没有任何边**——这是本次调查最重要的结构性事实。

---

## 5. 深度评估：哪些缝深，哪些漏

### 5.1 深模块（接口窄、内部厚、调用方无需知情）

| 模块 | 为什么深 | 证据 |
| --- | --- | --- |
| `src/run.ts` 的 `startZcodeRun` | 对外只有 `(prompt, signal, spec) => SubagentRun`；内部处理了取消升级（`:148-155`）、spawn 前失败即 reject 且摘监听（`:180-183`）、stderr tail 附加（`:187-190`）、诊断只留一条（`:209-218`）、teardown 等待静止（`:119-128`）。`src/provider.ts:43-53` 的调用方对这些一无所知 | `src/run.ts:139-236` |
| 宿主的 `settleRunResult` + `subprocessRunHandle`（经 A2 使用） | 把退出码/stderr/解析失败全部压成 `stopReason`，result 永不 reject；本包只需填 attempt/collectOutput/cancelled/onError | `src/run.ts:191-226,228-235`；宿主契约 `out-of-process.ts:183-190,238-243` |
| `src/cli.ts` 解析面 | `parseZcodeHeadlessOutput` 只读已验证 key，未知 key 显式忽略；`ZcodeHeadlessOutput` 形状稳定，消费方（run.ts、notice、测试）无需知道 CLI 的全部输出 | `src/cli.ts:134-167` |
| `src/config.ts` | 一个 `resolveConfig` 入口，内部 12 字段 fail-loud；部署方只看 README 表格 | `src/config.ts:184-251`、`README.md:36-48` |
| `src/job-index.ts` | register/settle 恰好一次 + 同步原子 claim；并发纪律全在内部 | `src/job-index.ts:83-119` |

### 5.2 浅模块与漏缝（调用方被迫知道内部细节）

| # | 问题 | 证据 |
| --- | --- | --- |
| L1 | **影子 Context 类型抹平契约**：`DshContext`/`DshAgent` 是宿主 Context/Agent 的手抄子集，`register: (tool: any) => void`、`inject?: (message: any) => void` 把两个 seam 的契约抹成 `any`，编译期无法发现 A4 的三处违约 | `src/types/dsh.ts:6-26,28-40` |
| L2 | **部署契约旁路**：Face B 不用 Config 的任何一个字段，mode/timeout/端口/cwd 策略全部硬编码，README 承诺的 12 字段护栏在 swarm 路径上为 0 | `src/index.ts:21`、`src/tools.ts:51,58,60`、`src/server.ts:25-26` |
| L3 | **cwd 无白名单**：`swarm_dispatch` 直接信 `activeAgent.session.header.cwd`，HTTP 派发直接信 `req.body.cwd`——`assertInsideTaskRoots`（`src/config.ts:260`）在 Face B 无调用者 | `src/tools.ts:51`、`src/server.ts:71` |
| L4 | **meta.json 隐式契约**：无 schema、无版本、五写四读，读侧失败即静默 | `src/runner/detached.ts:165-173`、`src/watcher.ts:49-50` |
| L5 | **前端契约手抄**：`src/web/types.ts` 复制 `TaskMeta`，服务端截断策略（5000 字节）等事实不同步 | `src/web/types.ts:3-17`、`src/server.ts:110` |
| L6 | **argv 契约双实现**：`cli.ts` 与 `adapters/zcode.ts` 各拼一遍，已漂移（node 包装、env 注入、fixture fallback） | `src/cli.ts:58-68` vs `src/adapters/zcode.ts:28-56` |
| L7 | **观察机制双轨**：chokidar（watcher）与 500ms stat 轮询（SSE）观察同一文件，无共享 cadence | `src/watcher.ts:17`、`src/server.ts:177-186` |
| L8 | **模块导入即副作用**：`server.ts` 在 import 时就启动 watchdog 与 watcher（`:29-31`）并在 `NODE_ENV !== 'test'` 时 listen（`:256-258`），`index.ts:40` 的 apply 再 listen 一次 3000；`:247-248` 没有 `'error'` 监听器。静态分析上，同一端口第二次 listen 的 `EADDRINUSE` 会成为未处理 `'error'` 事件（本次未运行验证） | `src/server.ts:29-31,247-248,256-258`、`src/index.ts:40` |
| L9 | **通知死代码**：`currentAgent` 永不被赋值，「任务完成→唤醒主脑」在 Face B 实际不发生 | `src/index.ts:16,23,27-37` |
| L10 | **`structured` 槽的类型泄漏**（宿主设计使然）：跨 seam 的 headless 事实是 `unknown`，每个消费者都要自带窄化守卫 | 宿主 `packages/subagent/subagent/src/types.ts:271,285`；本包 `src/cli.ts:170-192` |

### 5.3 两套架构的关系：没有干净的缝，职责重叠四处

**结论先行：`src/run.ts` 与 `src/runner/detached.ts` 都在管生命周期，`src/tools.ts` 与 `src/server.ts` 都在派发任务，且没有共享任何域函数。缝应该收在「一个进程边界 + 一个派发域函数」上，而不是像现在这样两条栈平行。**

1. **进程生命周期双管。** Face A 经 subprocess seam：`spec.spawn`（`src/run.ts:159-179`）+ `graceMs` 分级终止（`:177`）+ `disposeZcodeChild` 的 terminate/waitForExit/done 三段（`:119-128`）。Face B 经裸 spawn：`detached: true`、stdio 落盘、`unref`（`src/runner/detached.ts:94-99,160`），终止是 `process.kill(-pid, 'SIGKILL')` 进程组杀（`:233`），TTL 看门狗独立巡检（`src/runner/ttl.ts:45-63`）。**两条取消语义、两套资源模型，互不知情。**
2. **任务派发双入口。** `swarm_dispatch`（`src/tools.ts:53`）与 `POST /api/tasks/dispatch`（`src/server.ts:65`）打的是同一个 `spawnDetachedTask`，但约束不同：工具路径至少要求一个 active agent 并取其 cwd，HTTP 路径的 cwd 直接来自请求体、且服务绑定 `0.0.0.0`（`src/server.ts:26`）。Face A 的第三条路（`ctx.jobs.start` + 并发槽 + 白名单 + 计费自检，`git show 8f6164e:src/tools.ts:306,407`）已不存在。**正确的收口是提出一个 `dispatchTask(spec)` 域函数，三处（工具、HTTP、未来的 jobs）都过它，白名单/并发/计费在域函数内强制。**
3. **完成通知双路。** `src/notice.ts:98-135`（jobs 事件 + followup/inject 阶梯 + wake 预算，语义完整、无调用者）vs `src/index.ts:26-37`（watcher + 裸文本 inject，且 `currentAgent` 恒 undefined）。**应收口到 notice.ts 的投递阶梯，watcher 只当触发器。**
4. **并发与计费双标。** Face A 有 `maxConcurrent` + `ZcodeJobIndex.claim()`（`src/config.ts:122`、`src/job-index.ts:110-119`）与 billing 弱自检（`src/billing.ts:95`）；Face B 两者皆无——同时跑 N 个 `swarm_dispatch` 没有任何上限，也不检查 CLI 计费 provider 是否漂移。

---

## 6. 风险与建议（按重要性排序）

### R1（最高）：文档/契约/测试/实现四者不一致，测试套件当前不可能通过

证据：`tests/subagent-zcode.spec.ts:36` 导入 `settleForegroundRun, settleZcodeJob`，而 `src/tools.ts` 仅导出 `registerSwarmTools`（`src/tools.ts:15`）；`tests/subagent-zcode.spec.ts:872` 与 `tests/real-zcode.e2e.ts:44` 的 `ctx.plugin(zcode, effective)` 传入的是 module namespace（`import * as zcode`，`tests/subagent-zcode.spec.ts:38`），不是 cordis 插件函数；`README.md:32,75` 与 `cordis.patch.yml:2` 承诺的 `zcode` provider / `zcodeJobs` / `zcode_dispatch` 在 `src/index.ts` 中均无注册。

建议：**先做一次「留哪套面」的决策并落到代码**。若留 Face A：恢复 `apply(ctx, config)` 的 cordis 插件形状与 `inject` 列表（参照 `git show 8f6164e:src/index.ts`），Face B 降级为独立 Web 工作台模式（`npm run dev`，不经插件加载）；若留 Face B：把 `settleForegroundRun/settleZcodeJob` 等导入从 spec 中删除或重建，重写 `README`/`cordis.patch.yml` 描述 `swarm_*` 工具与 `.swarm-runs` 契约，并承认 provider 面已废弃。**不要维持现状**——现在的状态是任何一方都无法验证。

### R2（高）：生产默认路径内嵌测试替身

证据：`src/adapters/zcode.ts:8` 编译期内嵌 fixture 路径，`:21-22` 在无真实 CLI 时选中它，`:49-53` 注入 `FAKE_ZCODE_BEHAVIOR`/`FAKE_ZCODE_RESPONSE` 等环境变量。`tests/fixtures/fake-zcode.cjs` 因此从「替换 B8 契约的替身」变成「B1 的生产默认实现」。

建议：删除 `src/adapters/zcode.ts:8` 与构造器中的 `FIXTURE_ZCODE` 分支（`:21-22`）和 `:49-53` 的 fake env 注入；缺失 CLI 时 fail loud，对齐 `src/config.ts:186-196` 的哲学。替身只应经显式注入点（测试里的 `FIXTURE` 常量或 `ZCODE_CLI_PATH`）进入。这一处同时是「契约泄露最危险」的答案：它让「派发成功」与「真的跑了一个编码 agent」在无 CLI 的机器上不可区分。

### R3（高）：swarm 工具绕过 `defineTool`，违反 ToolDefinition 契约且编译期不可见

证据：`src/tools.ts:19-72` 等四处 `ctx.tools.register` 的对象缺 mandatory `output`（宿主 `packages/core/tools/src/index.ts:225`）、`parameters` 是未经编译的简写映射（宿主 `packages/core/tools/src/schema.ts:577` 才是编译点）、`execute(args)` 不收 `exec` 因而无法转发取消信号（宿主 `:227-235`）；`src/types/dsh.ts:7-10` 的 `(tool: any) => void` 使 TypeScript 无法拦截。

建议：二选一——(a) 改回 `defineTool`（迁移前形态，`git show 8f6164e:src/tools.ts:14,231`），并补 `output` 与 `exec.signal` 转发；(b) 若坚持 Web 工作台定位，就把 `DshContext` 换成真实 `Context` 类型，让违约在编译期暴露。同时 `swarm_dispatch` 应转发取消信号：目前模型取消一次 `swarm_dispatch` 调用无法触及已 detach 的子进程。

### R4（高）：HTTP 派发面无护栏

证据：`src/server.ts:26` 绑定 `0.0.0.0`、`:71` 的 `cwd` 直接取 `req.body.cwd`、无 `taskRoots` 校验、无并发上限、无计费自检；`src/tools.ts:51` 同样只信 agent 会话 cwd。

建议：提取公共 `dispatchTask(spec)` 域函数，把 `assertInsideTaskRoots`（`src/config.ts:260`）、`maxConcurrent`（`src/config.ts:122`）、`createBillingGuard`（`src/billing.ts:95`）收在域函数内；`swarm_dispatch` 与 `POST /api/tasks/dispatch` 都调它。默认 HOST 改 `127.0.0.1`，需要对外暴露时经 `Config` 显式开启（Config 加 `webHost`/`webPort` 字段，而不是 `process.env.PORT`）。

### R5（中）：`.swarm-runs/` 隐式契约无 schema；插件模式 import 副作用与死代码

证据：`src/runner/detached.ts:165-173` 读侧无校验；`src/server.ts:29-31,256-258` import 即起服务/监听，`src/index.ts:40` 二次 listen，`:247-248` 无 error handler；`src/index.ts:16` 的 `currentAgent` 永不被赋值。

建议：给 `meta.json` 加必填字段校验与 `schemaVersion` 字段（读侧失败时至少 warn 而非静默 return，参照 `src/job-index.ts:98` 的 warn 纪律）；把 `server.ts` 的 import 时副作用收敛进 `startServer()`，由 `index.ts` 的 `apply` 显式调用一次；删除或补全 `currentAgent` 注入链路（若要保留，应走 `notice.ts` 的 `createUserMessage` 契约而不是裸 text block）。

---

## 7. 附录

### 7.1 测试覆盖矩阵

| 面 | 测试文件 | 状态 |
| --- | --- | --- |
| Face A（provider/tools/notice/billing/log-tail/config/cli/run/job-index） | `tests/subagent-zcode.spec.ts`（1774 行，约 60 例） | 密集，但导入了已删除的导出，**当前不可运行** |
| 真实 CLI 冒烟 | `tests/real-zcode.e2e.ts`（67 行，CLI 缺失自跳） | 依赖 Face A 接线，同样不可运行 |
| Face B（swarm 工具 / detached / ttl / watcher / server / adapters / web） | 无 | **零覆盖**（`grep -n "swarm" tests/` 无命中） |

### 7.2 未找到证据的项（明确声明）

- `ctx.jobs.start` / `ctx.jobs.attachController` 在当前 `src/` 中的调用：未找到（仅 `src/types/dsh.ts:12-14` 的影子类型声明；迁移前的调用在 `git show 8f6164e:src/tools.ts:306,407`）。
- `ctx.tools.get` / `ctx.tools.execute` 在插件源码中的调用：未找到（仅测试中使用）。
- Face A 与 Face B 之间的任何显式接口（re-export、共享域模块、事件）：未找到。两面的唯一共享物是「zcode CLI headless 契约」，且该契约被实现了两遍（`src/cli.ts:58-68` 与 `src/adapters/zcode.ts:28-56`）。
- `.swarm-runs/` 三文件的 schema、版本字段、迁移策略：未找到。
- `ToolRuntime` 的替换实现（子类）：宿主内未找到——按 glossary 的定义（`docs/glossary.md:7-9`，concrete registry 也可构成 seam），A4 是「注册表型 seam」，但其可替换性仅体现在 `register` 扩展点，不在换掉注册表本身。
- `server.ts` 双 listen 是否真的触发 `EADDRINUSE`：未运行验证，结论为静态分析。

### 7.3 宿主侧契约速查（本报告引用的 Definition 位置）

| Seam | Definition | 关键语义条款 |
| --- | --- | --- |
| subprocess | 宿主 `packages/subprocess/subprocess/src/index.ts:117,153`；`src/types.ts:77,142,169,182-195` | spawn 同步返回活句柄；collect reader 按字节偏移非消耗；terminate 是唯一终止动词；服务销毁终止全部托管进程 |
| subagent | 宿主 `packages/subagent/subagent/src/index.ts:198,510,557`；`src/types.ts:344,308,271,252`；`src/out-of-process.ts:57,106,147,192,245` | 多 provider 并存；能力缺失即 typed reject；result 发布后永不 reject；dispose 幂等等待实际退出 |
| jobs | 宿主 `packages/jobs/jobs/src/index.ts:85,110,192`；`src/types.ts:34,55,243,200-226`；`src/view.ts:65` | 事件同步派发且首个为 registered；settled 在释放所有 waiter 后；`owners:'scope'` 按组合投递；契约为进程内 |
| tools | 宿主 `packages/core/tools/src/index.ts:807,1063,1230,1369`；`src/schema.ts:554`；dsh-llm `src/types.ts:473-484` | register 返回 disposer；execute 经 pre/guard/around/post 瀑布；ToolDefinition 强制 output；parameters 须为 JSON Schema |
