# 平台不判定活成没成

Status: accepted（取代 [ADR-0001](0001-settlement-raw-output-existence.md) 中「判 `failed`」的归属；[#01c](../../.scratch/agent-hub/issues/01c-classification-slimming.md) 与 [#01b](../../.scratch/agent-hub/issues/01b-settlement-empty-stdout.md) 的产出）

2026-10-10，[#01c](../../.scratch/agent-hub/issues/01c-classification-slimming.md) 决定：**判「活成没成」的生产者只有人与上游 AI**（自动发任务的那个 LLM）。平台**无智能、无权判断**，它的职责是把对话开起来、把运行事实记下来、把原文与把手交出去。

据此，`Resolution` 去掉 `outcome`（三值判词），`needs_review` 整套判定也一并从契约移除；`Resolution` 的性质从「归一结论」改为**收尾记录**：这次运行**结束了没有**、**为什么停**（`stopCause`）、把手与原文指针在哪。同时新增 `TranscriptRef`（原文指针）与 `transcriptRef?()`，让「人可以自己去看原文」从意图变成契约义务。

**为什么**：平台能可靠观测的只有机械事实（有没有产出、有没有结束证据、起跑条件是否满足）。语义判断既不可靠、也不该由平台承担 —— 而且一旦写进契约，每个 adapter 作者都会以为自己该填它。**判词不是消失，是搬到平台侧的领域记录里：人是判官，平台是书记员。**

**顺带解决的诚实问题**：超时与取消是**平台自己发的动作**，此前被写成两个终态判词，等于平台给自己发判决书，事后无法区分「活没干成」与「我不让干了」。现在它们只出现在 `stopCause` 里，判词空着 = 如实地说「没有人判过」。

**代价（明确接受）**：v0 没有判词字段，因此**链的自动推进与重试暂时不能以语义结果为闸门**。这是有意的取舍：先把口搭起来、真跑几个任务，等撞到足够多的"事件依赖结束/状态"再回来管。延后项见 [#01d](../../.scratch/agent-hub/issues/01d-deferred-state-and-verdict.md)。
