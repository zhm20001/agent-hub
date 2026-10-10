# Agent Hub 设计文档

本目录是 Agent 集散平台（Agent Hub）的设计产物。**本 effort 的每张票产出决策与契约，不产出功能代码**；实现由后续 effort 认领。

## 阅读顺序

| 文件 | 是什么 | 读者 |
| --- | --- | --- |
| [adapter-contract.md](./adapter-contract.md) | Platform 与 Agent 之间那道接口的**正式契约**（票 #01） | 写 adapter 的人、审接口的人 |
| [adapter-contract-primer.md](./adapter-contract-primer.md) | 同一份契约的**白话版**：一张图 + 讲清每个决定为什么这么定 | 第一次接触这个平台的人、需要向别人解释的人 |

正式契约是权威（authoritative）。白话版里的任何说法与它冲突，以正式契约为准。

## 术语

领域词汇以仓库根目录 [`CONTEXT.md`](../../CONTEXT.md) 为准。本目录的文档只消费它，不改写它。

## 事实来源

- 三个 Agent CLI 的真实 headless 契约（已侦察，勿重复侦察）：`/tmp/agent-cli-contracts.md`
- 现存代码的两面结构与病理：`../SEAMS.md`
- 本 effort 的地图与票：`.scratch/agent-hub/map.md`、`.scratch/agent-hub/issues/`
