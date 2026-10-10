# 结算判据是原始产出的存在性，不是内容

Status: **部分被 [ADR-0002](0002-platform-does-not-judge.md) 取代**。「判据 = 原始产出的存在性，不是内容」**仍然有效**；其中「所以判 `failed`」的**归属已被推翻** —— 平台不判活成没成（[01c](../../.scratch/agent-hub/issues/01c-classification-slimming.md)）。「没有产出」现在只是一个**被如实记录的事实**，要不要算失败由人与上游 AI 定。

2026-10-10，zcode 的运行证据（[#10](../../.scratch/agent-hub/research/10-headless-field-probe.md) §4）暴露出 `adapter-contract.md` §5 结算表缺一格：**进程 exit 0、stdout 零字节**（缺 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 时的真实形态）。旧词表 `finalText: text | empty` 只能表达「纸上有字 / 纸上没字」，无法表达「**压根没交纸**」——于是这一格在 `JSON.parse("")` 处坍缩成一个无法归类的失败（[01b](../../.scratch/agent-hub/issues/01b-settlement-empty-stdout.md)）。

决定：**区分点建立在「原始产出的存在性」上，而不是「内容空不空」。**「没有任何原始产出」（含不可解读的空白）→ `failed` + `reason='no-output'`，不落 `needs_review`；「有原始产出但内容为空」→ 维持原判 `succeeded` + `finalText.kind='empty'`。为此在契约里新增两类中立事实：引擎观测 `RunObservation`（`producedOutput` / `unmetPreconditions`），与 Adapter 静态声明的 `preconditions`（引擎**逐次派发前**就地核对，`available()` 仍只注册时探一次并缓存）。

**为什么不选另外两条**：判 `succeeded` 会让「进程从未走到产出阶段」伪装成「干完了没话说」，看板分不出该补配置还是该重派；判 `needs_review` 会把确定性失败塞进「看不出成没成」，违反 `needs_review` 的唯一用途，让人为看不出名堂的事加班。

**那处遗留冲突已处理**：`map.md` 的 v1 预置边界原写「解析不出落 `needs_review`」，与本 ADR 字面相反。现已在该条上标注**适用范围**（仅「有输出但看不出成没成」），并由 [ADR-0002](0002-platform-does-not-judge.md) 进一步**取消平台的一切判词** —— `needs_review` 在 v0 不再由任何组件产生。
