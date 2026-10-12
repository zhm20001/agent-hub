# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** 本机开发者 / 操作人员（人类），在真实工作区里把编码任务派发给本地 CLI Agent（如 ZCode、bash），并通过看板观察、干预（强杀、读日志 / diff / 简报）。

**Secondary:** 上游编码 Agent（通过 `swarm_*` 工具或 HTTP API 派发），把 Task 交给 Platform 保管进度与产物；它们读 closing record / transcript，自行做语义判断。

情境：本地/内网开发机上的 Agent Hub swarm 工作台（默认 `:3000`），不是面向公众的营销站，也不是多租户 SaaS 控制台。

## Product Purpose

**Agent Hub（集散平台）** 处于任意两个 Agent 之间：路由派发、保管进度、向人类呈现。它本身不执行编码任务。

活产品路径是 **Agent Hub swarm**：脱钩子进程 + `.swarm-runs/<taskId>/` 物理状态 + Web 看板（Kanban / Inspector）。成功标准：

1. 人类能快速派发、看清 Running / Completed / Terminated 泳道，并打开详情（终端流、简报、diff、对话）。
2. 派发护栏清晰 fail-loud（cwd 白名单、并发上限、超时看门狗），不悄悄落到错误目录或假 CLI。
3. 平台只记录**机械事实**（exit、stopCause、sessionRef、transcriptRef），不冒充语义 verdict（ADR-0002）。

## Positioning

不是通用 orchestrator / 中台 / 网关。差异点：

- **Adapter 边界**：把 Platform 的 Task 翻译成具体 Agent 的调用形态，再把输出翻译回事件。
- **看板是观察与干预面**，不是执行引擎；执行在独立 CLI 进程里。
- **平台不判定活成没成**——`COMPLETED` / exit 0 只是机械事实；判词只由人或上游 AI 读 transcript 产生。

## Operating Context

- 入口：`npm run start` / `npm run dev` / `npm run restart`（Express + Vite，默认 `http://0.0.0.0:3000`）。
- 状态源：`.swarm-runs/*/meta.json`；详情含 `raw.log`（SSE）、`report.md`、Git Diff、transcript。
- 派发：看板 QuickDispatch / DispatchModal，或 `POST /api/tasks/dispatch`，或 `scripts/dispatch-tickets.mjs`。
- 适配器：`zcode`（需 `ZCODE_CLI_PATH`）、`bash`。
- 护栏：`AGENT_HUB_TASK_ROOTS`、`AGENT_HUB_MAX_CONCURRENT`、`AGENT_HUB_DEFAULT_TIMEOUT`、`PORT`。
- 界面默认语言中文，可切 English（`localStorage`）。

## Capabilities and Constraints

- **能做：** 脱钩派发、Kanban + Inspector 双视图、实时时长、强杀进程树、双语、工单/标签追踪、closing record 展示。
- **不能做 / 不做：** 语义成功/失败判定；替 Agent 保管凭据（ZCode 用 `~/.zcode`）。
- **术语（须沿用 CONTEXT.md）：** Platform / Agent / Adapter / Session / Task / Dispatch / Chain / Board / Resolution·Closing record / SessionRef / Capability / PermissionRequirement。避免：中台、orchestrator、dashboard、verdict、job（对外产品语义）。
- **UI 约束（产品层）：** 看板是 Operate 型工作台；信息密度高、暗色、以进程/工单为中心。视觉方向：Night Yard（见 DESIGN.md）；访客模式 Operate。

## Brand Commitments / Voice

- **语气：** 工程直白、可操作、双语对等。中文为主文档语；UI 字符串中英切换。
- **三词个性：** 清晰、机械可证、可干预。
- **避免：** 营销口号、虚假「AI 成功」判词、把 exit 0 说成业务成功；避免用 dashboard/后台替代「看板」。

## Evidence on Hand

- `CONTEXT.md` — 术语 glossary（产品语言权威）。
- `DEMO.md` / `DISPATCH.md` — 活路径 runbook。
- `docs/USER_GUIDE.md` — 看板模块与派发/强杀说明。
- `README.md` / `README.zh.md` — 产品入口与快速开始。
- `docs/adr/0002-platform-does-not-judge.md` — 平台不判定。
- `src/web/` — Night Yard Operate 看板实现（原 DispatchDock 已替换）（substantial UI）。
- `package.json` — `dev`/`start`/`restart`/`build`/`dispatch-tickets`。

## Open decisions (not inventing)

1. **Board visitor mode：** ~~待确认~~ → **Operate**（2026-10-12 已锁定：任务密度、干预优先）。
2. **Visual direction：** ~~待确认~~ → **Replace** 为 Night Yard（沥青蓝黑 + 钠灯琥珀 + bay-mark；见 DESIGN.md）。旧 DispatchDock zinc+indigo 为 anti-reference。

## Accessibility & Inclusion

- 基线目标：键盘可达、对比度可辨（暗色 Night Yard 底上状态色 live/done/danger/warn）。
- 双语：中文 / English；默认 `zh`。
- 未正式声明 WCAG 级别；后续 UI 工作应补齐焦点态与 `prefers-reduced-motion`（running pulse / ping 动画）。
