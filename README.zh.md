---
description: "面向要在本机把后台编码任务派发给 ZCode CLI 的用户与维护者的一次性 zcode CLI 子代理提供方，支持多轮续聊与进程级并发上限。"
kind: "package-bundle"
---

# Agent Hub（原 dsh-subagent-zcode）

> **⚠️ Face A 已弃用。** 当前唯一活路径是 **Face B swarm**（`swarm_*` 工具、`npm run start`、`:3000` 看板）。请跟 **[DEMO.md](./DEMO.md)**。本文中关于 `zcode_dispatch` / provider / `ctx.zcodeJobs` 的说明均为 Face A 考古材料。

**产品：** Agent Hub（npm：`agent-hub`）。活路径 = Face B swarm 看板（`npm run start` / `npm run restart`）。下文安装/provider 章节仍为 Face A 考古材料。


[English](README.md) | 中文

## 概述

当委派任务应以真实 ZCode CLI 进程运行时，把 `@deepseek-ai/dsh-subagent-zcode` 装进 Profile。每次派发都会在会话工作区内以 headless 方式拉起本地 `zcode` 二进制（`-p "<任务>" --json --cwd <目录>`），并把会话 id、trace 与 token 用量记录到 `ctx.zcodeJobs`。派发默认前台执行；`run_in_background` 把一次派发变成 kind-`zcode` 后台任务——模型用 `job_output` 收取、用 `job_kill` 终止、用 `zcode_followup`（`zcode --resume`）续聊。可选的 `ticket` 标识贯穿任务记录、完成通知与 `zcode_roster` 工具。cwd 白名单与并发上限为每次派发兜底；完成通知回到所属会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)
- [来源与构建上下文](#source-and-build-context)

-----

<a id="use-this-package"></a>
## 使用本包

当委派应以真实 ZCode CLI 进程、使用其独立模型账号与认证运行时挂载本提供方。zcode CLI 的凭据保存在 `~/.zcode` 之下；本包不经手任何凭据。

### 安装 Bundle

把本包的 patch 行加入 Profile 组合（或用 `dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-zcode` 安装）。该行注册 `zcode` 提供方、`zcodeJobs` 索引服务和 `zcode_dispatch` 工具。加载本包要求同一组合内已有 `@deepseek-ai/dsh-jobs`（如 `@deepseek-ai/dsh-jobs-local` 注册表实现）、subprocess 缝、工具注册表与 subagent 服务。

### 配置

部署相关的每个选择都是经过校验的 Config 字段；运行时没有任何隐藏默认。

| 字段 | 默认 | 契约 |
| --- | --- | --- |
| `zcodeCliPath` | 无 —— 必填 | zcode CLI 入口脚本的绝对路径。文件缺失或不可执行时加载即拒绝。 |
| `builtinProviderConfigPath` | 由 `zcodeCliPath` 推导 | CLI 内置 provider 配置的路径，以 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 注入每个子进程环境。省略时推导 App 打包路径（`<dirname(zcodeCliPath)>/../config/provider/zcode-builtin.json`）且仅在该文件存在时注入——CLI 自身按脚本相对路径能找到的布局不注入任何值。显式配置的路径必须是可读文件，否则加载即拒绝。 |
| `taskRoots` | `[process.cwd()]` | cwd 白名单：每次派发解析出的任务目录必须是某根本身或位于根内；空数组被拒绝。 |
| `maxConcurrent` | `2` | 存活 zcode 子进程的进程级上限，前台运行与续聊轮都计入；超限时工具报出当前活跃数并拒绝，不排队。 |
| `defaultMode` | `edit` | 每次派发透传 `--mode`。CLI 的 `-p` 默认是 `yolo`；此默认刻意收权。 |
| `disallowedTools` | `[]` | 从子代理移除的整工具列表，逗号拼接进 `--disallowed-tools`。 |
| `completionDelivery` | `followup` | `followup` 在空闲 owner 上开新回合；`quiet` 让通知静候。忙碌的 owner 一律 inject。 |
| `maxConsecutiveWakes` | 无上限 | 一个 owner 被 zcode 完成唤醒连续开回合的预算，超过后下一条通知降级为 inject；由用户输入重置。 |
| `expectedProviderIds` | `[account:bigmodel-start-plan, account:bigmodel-individual-coding-plan, new-provider]` | 计费库最新一行可接受的 `provider_id` 集合：CLI 按账号所属计划计费——日池有余量时记 Start 计划，实测（2026-10-08）的独立编程计划为 `account:bigmodel-individual-coding-plan`——池耗尽后回退 `new-provider`，默认集合覆盖已实测的每种常态；集合之外的取值拒绝派发（见失败与恢复）。 |

### 暴露工具

本包自行注册 `zcode_dispatch`——不需要再配独立的委派工具行。给模型配上 `@deepseek-ai/dsh-tool-jobs`（`job_output`、`job_list`、`job_kill`）即可收取后台结果并接收完成通知。仅前台使用的组合也可以配置一条指向 provider `zcode` 的 tool-subagent 行。

### 你会得到什么

- 一次性派发与解析后的 headless 事实：前台拿到最终回复；后台拿到 `{ kind: 'background', jobId }` 与携带 zcode 会话 id 和用量摘要的完成通知。
- `zcode_followup`（`zcode_session_id`、`prompt`）以新的 kind-`zcode` 任务派一轮 `--resume`；zcode 会话持久于 `~/.zcode`，`tool/result` 里的 id 跨 dsh 重启可用。
- `zcode_roster` 列出本进程派过的每个任务——工单号、轮次、状态、zcode 会话 id、token、时间——主脑一次调用即见全群名册。
- 派发与续聊都接受可选 `ticket` 标识（如 `T3`）；它进入任务记录、完成通知（`zcode ticket T3 — task <jobId> …`）与名册行。
- `ctx.zcodeJobs` —— 进程内任务记录与并发台账，供面板与观察者使用。
- 沉降后的完整 stdout 即该任务 `job_output` 的一次性结果；任务进行中 stderr 会流入任务的输出环。

### 失败与恢复

`zcodeCliPath` 缺失或不可执行、`builtinProviderConfigPath` 不可读、`taskRoots` 为空、数值字段越界，都会让加载立即失败。落在所有 `taskRoots` 之外或超过 `maxConcurrent` 的派发返回点名问题的工具错误。CLI 非零退出会让任务沉降为 `failed` 并附退出码与 stderr 尾部；被 kill 的任务记录 `killed` 且照常通知。当计费库最新行的 `provider_id` 落在 `expectedProviderIds` 集合之外时，派发拒绝并给出探针闭环指引（见[来源与构建上下文](#source-and-build-context)）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>设计与源码地图</summary>

`src/config.ts` 在加载时一次性校验部署契约。`src/run.ts` 拥有一个 CLI 生命周期：拼装 argv、经 `ctx.subprocess` 以收集式 stdout/stderr 拉起子进程、要求零退出加严格解析的 JSON 对象，并发布标准的永不 reject 的 run 句柄（subagent 缝的 `settleRunResult` + `subprocessRunHandle`）。`src/provider.ts` 把该生命周期暴露为 `zcode` SubagentProvider；`src/tools.ts` 注册 `zcode_dispatch`，把 kind-`zcode` 任务启动起来并把沉降结果映射为 job outcome 与 `ctx.zcodeJobs` 记录。`src/cli.ts` 是经过实测的 CLI 面：argv 组装（`--resume` 置前、工具移除逗号拼接以免变长旗标吞掉 `--cwd`）与严格的 stdout 解析。

不发布运行时不变式伴随物：被拥有的关系——每个已占用并发位对应一个存活子进程、每个后台 job 对应一条记录、每条记录只结算一次——都只在本包内断言，不存在能与之背离的独立观测。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 子请求

#### 模型看到什么

zcode 子代理在全新 CLI 进程中以一次 headless 回合收到拼接后的 `-p` 文本。其工作区是解析后的任务目录；本提供方实例固定 `--mode` 与 `--disallowed-tools`，而 zcode 自己的 `~/.zcode` 状态掌握认证、模型与其余产品设置。没有可续聊子代理。

#### Token 影响

子代理为独立的 zcode 上下文与回合付费。子代理 token 不进入父上下文。

#### KV Cache 影响

与父请求缓存无关。`--resume` 轮复用的是 zcode 自己的提供方前缀缓存，不是本 harness 的。

### 父会话调度与结果

#### 模型看到什么

前台 `zcode_dispatch` 返回最终回复与 zcode 会话 id，或对非正常结束返回携带 stop reason 与有界退出码/stderr 诊断的错误。后台调用返回 Job id；通用任务控制随后送达携带 zcode 会话 id 与用量摘要的完成通知，经 `job_output` 暴露完整 headless stdout，并可用 `job_kill` 请求取消。进行中的 CLI stderr/stdout 流入任务输出环；评论、工具活动与协议载荷不会经其他路径进入父会话。

#### Token 影响

前台输入增长为最终回复或错误。后台输入还包括启动应答、完成通知与历次 `job_output`/`job_kill` 结果；子代理 token 依旧不进入父上下文。

#### KV Cache 影响

只追加：前台在可复用父前缀后追加一条结果；后台追加应答、通知与后续收取结果。通知驱动的续聊回合只追加、不改写既有前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 任务只收文本；`--attach` 与派发级权限放开未接线。
- 前台派发占用并发名额但不产生任务记录；只有后台任务会进入列表。

<a id="dev-note"></a>
### 开发备注

行为测试通过可脚本化的 fake CLI（`tests/fixtures/fake-zcode.cjs`）驱动；真实 CLI 冒烟在 `tests/real-zcode.e2e.ts`，二进制缺失时自跳。完成通知路径、`zcode_followup`、计费自检与 web 面板的规格见源 harness 工作区内的实现笔记（见[来源与构建上下文](#source-and-build-context)）。

-----

<a id="source-and-build-context"></a>
## 来源与构建上下文

本仓库只发布插件包 `@deepseek-ai/dsh-subagent-zcode`，内容逐字取自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的工作克隆（分支 `zcode-subagent-v1`，提交 `21ab87c93e`；该提交在本地分支上，不在公开远端）。在源 monorepo 中本包位于 `packages/subagent/subagent-zcode`，以 pnpm workspace 成员的身份构建与测试——`peerDependencies`/`devDependencies` 使用 pnpm `workspace:` 协议，`tsconfig.json` 继承 monorepo 的项目引用——因此本仓库是源码发布，不是可独立安装的包。

包内对 `ZCODE-CLI-DELEGATION.md`（`expectedProviderIds` 背后的计费探针闭环流程）与 `.scratch/dsh-zcode-subagent-impl/` 实现笔记的引用在源仓库中解析，不在本仓库。挂载本提供方的 `zcode` profile bundle（`packages/bundle/zcode`）同样留在源 monorepo 中。
