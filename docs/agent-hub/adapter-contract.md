# Adapter 契约 v1

> 票 [#01](../../.scratch/agent-hub/issues/01-adapter-contract.md) 的产出物。
> 本文是 **Platform 与 Agent 之间那道接口的正式契约**（authoritative）。白话版见 [adapter-contract-primer.md](./adapter-contract-primer.md)。
> 领域词汇以 [`CONTEXT.md`](../../CONTEXT.md) 为准。本文档不改写它。

## 0. 这份契约在解决什么

一句话：

> **平台说自己的语言，Adapter 负责跟某一个 Agent 对话。换一个 Agent，平台一行不改。**

契约只是一层**翻译层**。它不含进程、不含命令行、不含磁盘、不含任何一个具体 CLI 的口音。凡是「某个 Agent 特有的东西」，都允许存在，但必须待在 Adapter 内部，不许爬到接口上。

反面教材就在本仓库现有代码里，本文第 6 节逐条点出（`src/adapters/base.ts:9,12`、`src/adapters/zcode.ts:21-22,49-53`）。

## 1. 形状：混合契约

契约不是「纯对象接口」，也不是「纯声明式描述 + 通用执行器」，而是**混合**，分界线只有一条：

| 归属 | 负责什么 |
| --- | --- |
| **平台引擎** | 起进程、收日志、归一事件、结算 Task、执行时间预算、取消升级、保管 resume 句柄 |
| **Adapter** | 把活单翻译成一次调用、把该 Agent 的输出翻译成归一事件、声明能力、探测可用性 |

**声明式的那一半只描述「任务载荷与输出形状」，绝不描述「命令行」。** 一旦 Adapter 开始声明 argv 模板，它就变成了第二种 CLI 方言，契约作废。

配套的三条纪律：

1. **Adapter 是纯翻译。** 它不自己起进程、不自己写日志、不自己碰磁盘。一切 I/O 由引擎独占。
2. **Adapter 不许持有跨 Dispatch 的全局资源。** 若将来要复用常驻服务，复用池绑定在引擎的会话生命周期上，不散落在 Adapter 的模块级变量里。
3. **Adapter 可以有很多实现细节，但接口上只露出下面这些成员。**

## 2. 接口形态（TypeScript）

```ts
/** 契约版本。破坏性变更换类型名（AdapterContract.v2），由编译期强制。 */
export const ADAPTER_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// 句柄与输入
// ---------------------------------------------------------------------------

/**
 * Session 的续跑句柄。句柄本体对平台不透明：平台不解析、不假设前缀、不假设它等于某个文件名。
 * provenance 记录它由哪个 Adapter 产出 —— 跨 Adapter 复用句柄必须被拒绝。
 */
export interface SessionRef {
  readonly provenance: string;   // = 产出它的 Adapter 的 name
  readonly handle: string;       // 不透明
}

/**
 * 原文指针。指向「这次运行的对话原文」在哪，供人与上游 AI 自己去查看。
 * 与 SessionRef 并列但语义不同：SessionRef 答「怎么接着聊」，TranscriptRef 答「原文在哪」。
 * 同样不透明：平台不解析、不复制正文、不承诺自己会渲染它。
 * 取不到就返回 undefined —— 那不是任务失败，是「这次没得看」。
 */
export interface TranscriptRef {
  readonly provenance: string;   // = 产出它的 Adapter 的 name
  readonly handle: string;       // 不透明
}

/** 权限需求。全部是语义维度，不是任何一个 CLI 的模式名。语义映射见第 4 节。 */
export interface PermissionRequirement {
  readonly fileWrite: 'allow' | 'deny';
  readonly shellExec: 'allow' | 'deny';
  readonly network: 'allow' | 'deny' | 'unspecified';
  /** 一次 Dispatch 是一进程一任务：运行期没有人类可问。'allow' = 不打断直接做；'deny' = 停下来交人。 */
  readonly onApprovalRequired: 'allow' | 'deny';
}

/** 一次派发的输入。注意这里没有的东西，和有的东西一样重要。 */
export interface DispatchSpec {
  /** 平台生成。Adapter 不负责命名，也就无从把自己的 ID 形态带进契约。 */
  readonly taskId: string;
  /** 要做什么。中立词，不用 "prompt"。 */
  readonly instructions: string;
  /** 在哪个目录执行。平台已按 taskRoots 白名单校验过；Adapter 不自行推断当前目录。 */
  readonly workspace: string;
  /** 缺省 = 新建会话；有值 = 续跑该会话。 */
  readonly sessionRef?: SessionRef;
  /** 缺省 = 平台默认档（conservative）。 */
  readonly permission?: PermissionRequirement;
  /** 基线环境之上合并的增量。Adapter 不许替换整个环境。 */
  readonly adapterEnv?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 归一程度。raw = 原样转发，绝不冒充 progress；fact = 看板可直接显示的结构化事实。 */
export type NormalizationLevel = 'raw' | 'fact';

/** payload 的具体形状由事件词表（票 #02）定义，本文不冻结。 */
export interface NormalizedEvent {
  readonly kind: string;
  readonly at: string;
  readonly level: NormalizationLevel;
  readonly payload: unknown;
}

/**
 * 一次 Task 的收尾记录。必须是事件序列的最后一条，且恰好一条。
 *
 * **它不是判决书。** 平台无权判断活干成没成 —— 那是人与上游 AI 的事（见第 5 节）。
 * 本记录只答三件事：这次运行结束了、为什么停、把柄在哪。
 */
export interface Resolution {
  readonly taskId: string;
  /**
   * 字段必须存在。空输出要显式表达为空，不许用空串冒充有意义的结果。
   * 'empty' 不是失败 —— 判成功还是失败由翻译层决定。
   *
   * 注意 'empty' 有两个来源，它们在 Resolution 上同形、在运行事实上不同形：
   *   - 有原始产出、内容为空
   *   - 没有任何原始产出（见 RunObservation.producedOutput）
   * 仅凭本字段无法区分，这不是缺陷 —— 判决所需的观测不在结论里。
   */
  readonly finalText: { readonly kind: 'text'; readonly value: string }
                       | { readonly kind: 'empty' };
  /**
   * 为什么这次运行不跑了。平台自己发起的停止（如预算耗尽、被取消）由平台填，
   * 其余情况可缺省。v0 用自由字符串，不枚举取值 —— 等真撞到需要机器判读的场景再收紧。
   */
  readonly stopCause?: string;
  /** best-effort。bash 拿不到，所以不进必填。 */
  readonly usage?: AdapterUsage;
  readonly sessionRef?: SessionRef;
  /** 原文指针。取不到即缺省，见 5.1 的同类纪律。 */
  readonly transcriptRef?: TranscriptRef;
}

export interface AdapterUsage {
  readonly tokens?: { readonly total: number; readonly completeness: 'exact' | 'estimated' };
  readonly cost?: { readonly amount: number; readonly currency: string };
}

/**
 * 起跑条件。与 capabilities 的区别：capabilities 答「我会不会」，它答「我这次能不能开工」。
 * 前者是静态属性，后者随每次派发的环境与工作区变化。
 * Adapter 只负责声明要什么，核对由引擎执行 —— 只有引擎掌握当次生效的环境。
 */
export interface PreconditionRequirement {
  /** Adapter 自己的标识符。中立、不含任何 CLI 方言。 */
  readonly name: string;
  /** 人类可读的一句说明，用于看板与日志。 */
  readonly description: string;
}

/** 一次派发里被引擎观测到「未满足」的起跑条件。 */
export interface PreconditionUnmet {
  /** 原样回传 PreconditionRequirement.name。平台不解析它的含义。 */
  readonly name: string;
}

/**
 * 平台在一次运行里直接观测到的中立事实。
 *
 * 它与 Resolution 是两类事实，不是同一个东西的两半：
 * Resolution 是收尾记录，本类型只答「这台机器看到了什么」。
 * 之所以必须存在，是因为有两格在 Resolution 上同形、在事实上不同形：
 *   - 运行正常结束、但从未产出任何原始内容（不可解读的空白也算）
 *   - 有原始产出、但翻译后内容为空
 * 这两格的 finalText.kind 都是 'empty'，能区分它们的唯一事实是 producedOutput。
 * 判决仍归翻译层：观测由引擎给，结论由 Adapter 出。
 */
export interface RunObservation {
  /** 本次运行是否产出了任何可解读的原始内容。空白一律算「没有」。 */
  readonly producedOutput: boolean;
  /** 引擎每次派发前核对过的起跑条件。仅列出状态为「未满足」的那些。 */
  readonly unmetPreconditions: readonly PreconditionUnmet[];
}

export interface NormalizedEventStream extends AsyncIterable<NormalizedEvent> {
  /** 引擎用尽预算时调用。默认实现 = 丢弃尚未翻译的输入，保证序列仍以收尾记录收尾。 */
  destroy(reason: 'timeout' | 'cancelled'): void;
}

/** dispatch 的返回值。cancel 绑在这一次 Dispatch 上，不靠 taskId 回查全局表。 */
export interface RunHandle {
  readonly taskId: string;
  readonly events: NormalizedEventStream;
  /** 引擎唯一的取消动词：无参数、无分级。温和中断还是强杀由引擎自己决定。 */
  cancel(): void;
  /** 结论的 promise。让结算与事件流解耦：事件流还开着时也能先拿到终态。 */
  readonly done: Promise<Resolution>;
  /** 句柄可能很晚才出现，所以是方法不是属性。永远返回 undefined 是合法实现。 */
  sessionRef(): SessionRef | undefined;
}

// ---------------------------------------------------------------------------
// 能力
// ---------------------------------------------------------------------------

export type PermissionDimension = 'fileWrite' | 'shellExec' | 'network';

export interface AdapterCapabilities {
  readonly resume: boolean;
  /** 取消是「杀进程组」还是「向常驻连接发中断」——平台不需要知道，故只报杀得干净不干净。 */
  readonly termination: 'tree' | 'process-only' | 'none';
  readonly streaming: boolean;
  /** v1 只登记，不进必填集。 */
  readonly sessionReadback: boolean;
  /** Adapter 能强制哪些权限维度。要求超出这个集合 = dispatch 必须拒绝。 */
  readonly enforceable: readonly PermissionDimension[];
}

export interface Availability {
  readonly ok: boolean;
  /** 探不到（没装）与探到了但坏了（凭据缺失、配置损坏）必须可区分。 */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 契约本体
// ---------------------------------------------------------------------------

export interface AdapterContractV1 {
  /** 稳定标识。平台用它派发，Session 的 provenance 也用它。 */
  readonly name: string;
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  /** 静态声明。平台不向 Adapter 问「你支持什么」，一切在加载时可知。 */
  readonly capabilities: AdapterCapabilities;
  /** 部分替代：这里列出的维度以 dispatch 时的要求为准。 */
  readonly defaultPermission: PermissionRequirement;

  /** 中档探测：可执行文件 + 凭据路径（只判路径存在与可读，绝不读内容）。注册时探一次并缓存。 */
  available(): Availability;

  /**
   * 静态声明：开工需要哪些条件。空数组 = 无额外条件。
   * 与 available() 的分工：
   *   available() 判「能不能用」—— 注册时探一次、可缓存；
   *   本项判「这次能不能开工」—— 引擎在每次 dispatch 前就地核对，禁止缓存，
   *   因为当次生效的环境与工作区可能与注册时不同。
   */
  readonly preconditions: readonly PreconditionRequirement[];

  /**
   * 派发。返回运行句柄。
   * 返回前必须完成「可 dispatch」的全部检查：能力、权限可强制范围、会话句柄归属。
   * 拒绝时必须给出带命名的原因；禁止静默降级、禁止回落替代实现。
   */
  dispatch(spec: DispatchSpec): RunHandle;

  /**
   * 从原始输出中提取 resume 句柄。纯函数，与归一投影并列，不接触进程。
   * 返回 undefined = 该次运行拿不到句柄（合法，见第 5 节结算规则）。
   */
  sessionRefOf(raw: readonly NormalizedEvent[]): SessionRef | undefined;

  /**
   * 本次运行的原文指针。与 sessionRef() 并列，语义不同：它答「原文在哪」而非「怎么续跑」。
   * 永远返回 undefined 是合法实现（bash 就没有可查的原文）。
   * 平台不解析它、不复制正文、不承诺会渲染它 —— 只负责把它交给人与上游 AI。
   */
  transcriptRef?(): TranscriptRef | undefined;

  /** 引擎在释放该 Adapter 时调用。禁止在此之外的跨 Dispatch 状态。 */
  dispose?(): void;
}
```

### 明确不在契约里的东西

`spawn` / `pid` / `child` / `kill` / `signal` / `stdout` / `exit code` / `timeout` / CLI 旗标名 / CLI 输出字段名 / 磁盘路径 / 权限模式字面量。

## 3. 成员语义契约

| 成员 | 语义 | 必须 | 禁止 |
| --- | --- | --- | --- |
| `name` | 稳定标识，也是 `SessionRef.provenance` 的取值 | 全局唯一、不随版本改名 | 用版本号或安装路径当名字 |
| `contractVersion` | 声明契约版本。平台**只记日志、不拒绝** | 声明已知版本 | 用版本协商聊天 |
| `capabilities` | 开放集合，平台按已知项消费、忽略未知项 | 诚实申报；做不到就报 false / 收窄 `enforceable` | 报「支持」然后在运行中抛错 |
| `defaultPermission` | 平台没给 `permission` 时的档位 | 明确的档位 | 依赖底层 CLI 自己的默认值 |
| `available()` | 注册时探一次并缓存 | 探不到时返回 `{ok:false, reason}` | 静默回落替代实现（测试替身尤其） |
| `preconditions` | 静态声明开工条件；引擎每次派发前就地核对 | 报全、名字中立、说明可读 | 把核对推给 `available()` 的注册缓存；在名字里夹带 CLI 方言 |
| `dispatch(spec)` | 返回 `RunHandle`；返回前做完全部可派发检查 | 拒绝时说明缺哪一条 | 静默降级；接受无法强制执行的权限要求 |
| `events` | 归一事件流 | 收尾记录恰好一次、且在最后 | 猜测无法识别的片段；合成看似合理的 progress |
| `sessionRef()` | 本次运行的句柄，可能晚到 | 永远 undefined 是合法实现 | 返回一个平台需要解析的格式 |
| `sessionRefOf(raw)` | 从原始输出提取句柄的纯函数 | 无副作用、可反复调用、同输入同输出 | 读磁盘、发起调用、缓存状态 |
| `transcriptRef()` | 本次运行的原文指针，供人与上游 AI 查看 | 取不到即返回 undefined；不解析、不复制 | 解析原文、缓存正文、把原文当自己的数据 |
| `done` | 结论 promise | 与事件流一致 | 在事件流未收尾时先 resolve |
| `cancel()` | 请求取消 | 幂等、立即返回 | 阻塞等待进程死掉；自己决定升级策略 |
| `dispose()` | 释放该 Adapter | 幂等 | 在别处持有跨 Dispatch 状态 |

## 4. 能力、权限与降级

### 4.1 能力是静态声明，不是运行期协商

平台在加载时就知道每个 Adapter 会什么。不存在「先跑跑看」。缺能力时，`dispatch` **当场拒绝并说清缺哪一条**，永不静默降级。

唯一允许的「降级」是**平台自己按能力改写任务形状**，且必须留痕。例：`resume: false` 的 Agent，其 Session 被显式标注为「无记忆」，第二次派发前需人工确认。

### 4.2 权限按维度表达，且「声明不了就等于做不到」

`PermissionRequirement` 是语义维度。各 CLI 的模式名映射**只允许存在于 Adapter 实现里**，例如（仅作示意，不构成契约条款）：

| 中立维度 | 某个 CLI 可能的落点 |
| --- | --- |
| `fileWrite: 'deny'` | 只读沙箱 / 计划模式 |
| `shellExec: 'deny'` | 整工具移除；或只读沙箱 |
| `onApprovalRequired: 'deny'` | 非交互失败策略 |

**强制拒绝条款**：若 `DispatchSpec.permission` 要求了 `capabilities.enforceable` 之外的维度，`dispatch` **必须拒绝**，绝不允许「假装限制了、实际放开跑」。

现实例子：某个 CLI 只能整体移除工具、不支持按命令模式匹配，而要求是 `shellExec: 'deny'` —— 它必须报 `enforceable: []`（就这一维而言做不到），而不是收下要求照跑。

### 4.3 默认档

已定边界：默认权限 mode = conservative 档，unrestricted 档需显式开启。这属于平台配置（票 #06），不属于本契约。

## 5. 结算边界

**平台不判定活成没成。** 判词的生产者只有两个：**人**与**上游 AI**（自动发任务的那个 LLM）。契约里没有判词字段 —— 之前版本的 `outcome` 与 `needs_review` 已就此移除，见 [ADR-0002](../../docs/adr/0002-platform-does-not-judge.md)。

契约只回答两件事：**这次运行结束了没有**，以及**为什么不跑了**。

| 情形（中立描述） | 这次运行 | 谁来判断它 |
| --- | --- | --- |
| 有原始产出，翻译后内容为空 | 正常结束 | 人与上游 AI（如果在意的话） |
| **本次运行没有产出任何原始内容**（不可解读的空白也算） | 正常结束 | 同上。**「没产出」是事实，不是失败判定** |
| 没有结束证据 | 未确认结束 | 平台按自己的运维规则处理（超时 / 接管 / 交人） |
| 本次运行被叫停 | 已停止，`Resolution.stopCause` 记明 | 平台自己发的动作由平台填，不是判词 |
| 起跑条件未满足 | 根本未开工 | 平台（修配置 / 重派） |

**三条纪律**：

- **区分点的位置**：区分第 1 行与第 2 行的事实是 `RunObservation.producedOutput`，**不在 `Resolution` 里**。收尾记录与观测是两类事实。
- **「没产出」不等于「失败」**：平台不得替人与上游 AI 下这个结论，它只如实记录「没有产出」。
- **没有 `needs_review` 这个状态判别**：平台不判，就没有「无法判定」这回事。需要人工介入时，触发条件只能是**机械事实**（没有结束证据、起跑条件未满足、超时），而不是「我看不懂结果」。

### 5.1 起跑条件未满足时的事件形态

这种情况下事件流**可以合法地只有最后一条收尾记录**：不得合成假 progress（见第 3 节纪律），引擎不尝试启动目标 Agent，且该次不产生 `SessionRef`、**不构成**「续跑能力降级」（会话压根没建立）。而**该次不产生 `SessionRef` 这件事本身必须记下来**。

### 5.2 resume 句柄取不到时

**不是任务失败。** 活干完了、答案拿到了，只是下次接不上话。所以：

- **Task 照常收尾**（成功就是成功）。
- **Session 被标记为「续跑能力降级」**，下一次派发前需人工确认。

反之，`resume: false` 的 Agent（能力里已知）不构成降级 —— 那是从建 Session 起就已知的属性。

### 5.2 句柄失效

Adapter 报 `resume: true` 但会话在 Agent 侧被删掉 → 下一次 dispatch 的续跑必然失败。平台只负责把这次失败记清楚，**不自动新建会话**（静默换会话会把「续跑失败」伪装成「正常续跑」）。

## 6. 禁用词表

这是「换 Agent 不改平台」的唯一执行手段。契约文本（接口、成员名、字段名、文档条款）里出现下列任何一项即判违规。

| 禁 | 为什么 | 中立替代 | 本仓库现存的违规示例 |
| --- | --- | --- | --- |
| 任何 CLI 的旗标名 | 那是某一个 Agent 的方言 | 语义字段（`permission`、`instructions`、`workspace`） | `src/adapters/zcode.ts:36-45` 里 `--resume` / `-p` / `--json` / `--cwd` / `--mode` / `--disallowed-tools` 全进了实现层——实现层允许，但一旦爬上接口即违规 |
| 任何 CLI 的 stdout 字段名 | 同上 | 中立事件与 `Resolution` | `src/cli.ts:81-92` 的 `ZcodeHeadlessOutput` 若跨接口复用即违规 |
| 磁盘路径、目录约定 | 平台不该知道 Agent 把会话存哪 | `SessionRef.handle`（不透明） | `src/adapters/zcode.ts:8,21-22` 把 fixture 路径内嵌并当生产默认 |
| 权限模式字面量（某个 CLI 的 `edit`/`yolo`/`build`/`plan`） | 比旗标名更隐蔽；是已经真实发生的一次泄露 | `PermissionRequirement` 的维度 | **`src/adapters/base.ts:9`** `mode?: 'build' \| 'edit' \| 'plan' \| 'yolo'` |
| 进程原语（`pid` / `child` / `spawn` / `kill` / `signal` / `exit code`） | 会把「一个 Task 一个进程」焊死成契约条款 | `dispatch` / `cancel` / `Resolution` / `RunHandle` | `src/adapters/base.ts:15-19` 的 `AdapterCommandResult { cmd, args, env }` —— 接口上直接暴露了命令行 |
| 时间预算（`timeout`） | 预算是平台的东西：只有平台知道队列、全局上限、重启接管窗口 | 无（预算不进 spec） | **`src/adapters/base.ts:12`** `timeout?: number` |

### 6.1 允许的词汇

`Task` / `Session` / `Dispatch` / `Chain` / `Actor` / `Platform` / `Agent` / `Board`，以及本文定义的中立成员名。#02 若恢复 `needs_review`，需先回改本章节。

## 7. `bash` Adapter 样例（验收手段）

用最笨的 Agent —— **没有会话、不会记忆、只能杀主进程、什么用量都拿不到** —— 来证明契约没被某个聪明 Agent 的特性污染。

```ts
import type {
  AdapterContractV1, Availability, DispatchSpec, NormalizedEvent,
  Resolution, RunHandle, SessionRef,
} from './contract.ts';

export const bashAdapter: AdapterContractV1 = {
  name: 'bash',
  contractVersion: 1,

  // 能力全报「做不到」——这就是契约要求的那份诚实。
  capabilities: {
    resume: false,
    termination: 'process-only',  // 杀了 shell，孙进程可能还在跑
    streaming: false,
    sessionReadback: false,
    enforceable: [],              // 既不能限制写文件，也不能限制执行命令
  },

  defaultPermission: {
    fileWrite: 'allow',
    shellExec: 'allow',
    network: 'unspecified',
    onApprovalRequired: 'allow',
  },

  available(): Availability {
    // 中档探测：可执行文件在不在。没有凭据概念，故不判凭据。
    return existsInPath('bash')
      ? { ok: true }
      : { ok: false, reason: 'executable not found: bash' };
  },

  dispatch(spec: DispatchSpec): RunHandle {
    // 会话不可续跑，却收到了句柄 —— 必拒绝，不许静默新建会话。
    if (spec.sessionRef) {
      throw new DispatchRefused('resume-not-supported', 'bash has no session concept');
    }
    // 权限要求超出可强制范围 —— 必拒绝，不许装模作样。
    const unsatisfiable = unmetDimensions(spec.permission, this.capabilities.enforceable);
    if (unsatisfiable.length > 0) {
      throw new DispatchRefused('permission-not-enforceable', unsatisfiable.join(','));
    }
    // 引擎独占 I/O：这里只交出调用意图与翻译规则，不 spawn、不写盘。
    return engine.runIsolatedProcess({
      taskId: spec.taskId,
      workspace: spec.workspace,
      invocation: { interpreter: 'bash', script: spec.instructions },
      envDelta: spec.adapterEnv ?? {},
      translate: translateBash,
    });
  },

  // bash 没有句柄可提取。返回 undefined 是合法实现，走第 5.1 节的降级路径。
  sessionRefOf(_raw: readonly NormalizedEvent[]): SessionRef | undefined {
    return undefined;
  },
};
```

### 7.1 样例必须自证的 9 条

| # | 要证明的 | 在样例里的位置 |
| --- | --- | --- |
| 1 | 契约里没有旗标名 / stdout 字段名 / 磁盘路径 | 全篇无 `--` 开头的字面量、无路径常量 |
| 2 | 翻译是纯函数、零副作用 | `translateBash` 是纯函数；`dispatch` 不 spawn、不写盘 |
| 3 | 能力能诚实表达「没有 resume、不能读回会话库」 | `capabilities.resume: false`、`sessionReadback: false` |
| 4 | 「做不到」的声明机制真的能被触发 | `termination: 'process-only'`、`enforceable: []` 各触发一条拒绝或能力降级 |
| 5 | `sessionRefOf` 返回 undefined 时降级路径走得到 | 第 5.2 节；Task 照常收尾，Session 标降级 |
| 6 | 新建与续跑在同一意图里走两条分支 | 有 `sessionRef` 即拒绝（因能力为 false）；无则新建 |
| 7 | 「有产出但内容为空」与「没有任何原始产出」在观测上不同形 | 第 5 节第 1、2 行：二者在 `RunObservation.producedOutput` 上取值不同；收尾记录层 `finalText.kind` 两者同形，区分点被显式定位到观测层 |
| 8 | Adapter 不替换整个环境，只返回增量 | `adapterEnv ?? {}` 是增量；基线由引擎合并 |
| 9 | `workspace` 由 spec 传入，Adapter 不自己推断 cwd | `workspace: spec.workspace`；样例里没有 `process.cwd()` |

## 8. 演进

- **版本就是类型名。** 破坏性变更换类型名（`AdapterContractV2`），由编译期强制。
- **`contractVersion` 只作声明与日志**，平台不拒绝。这样「Adapter 比 Platform 新」不会崩。
- **能力声明是开放集合。** Adapter 可以多报，平台按已知项消费、忽略未知项。
- **禁止运行时协商。** 平台不向 Adapter 问「你支持什么」。

## 9. 与其他票的边界

| 票 | 关系 |
| --- | --- |
| [#02 事件词表](../../.scratch/agent-hub/issues/02-event-vocabulary.md) | `NormalizedEvent.kind` 的取值集合由它定义；本文只冻结**包封**（kind / at / level / payload）与「Resolution 恰好一次且在最后」这条不变量 |
| [#04 排队与生命周期](../../.scratch/agent-hub/issues/04-queue-and-lifecycle.md) | 时间预算、取消升级策略、孤儿结算在平台侧，Agent 侧只管执行 |
| [#06 配置 schema](../../.scratch/agent-hub/issues/06-config-schema.md) | 默认权限档、taskRoots 白名单属于平台配置 |
| [#12 codex / claude 容纳性](../../.scratch/agent-hub/issues/12-codex-claude-fit.md) | 拿另外两个真 Agent 的契约来撞本契约，验证「不依赖特定 Agent」是被证明的而不是被声称的 |
