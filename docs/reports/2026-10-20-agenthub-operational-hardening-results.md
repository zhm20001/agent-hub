# AgentHub 高优先级修复交付记录

日期：2026-10-20。对应 [原始复盘](2026-10-20-markview-ofm-agenthub-retrospective.md) 的六个高优先级项目。授权范围为方案与实现，未修改 Markview、未推送、未重启当前服务。

[设计](../superpowers/specs/2026-10-20-operational-hardening-design.md) · [实施计划](../superpowers/plans/2026-10-20-operational-hardening.md) · [API 和使用边界](../OPERATIONS.md)

## 实现对照

| 高优先级项 | 已落地 | 主要边界 |
| --- | --- | --- |
| 派发前能力预检 | TaskEngine.preflight、HTTP 和 swarm 工具共用准备/检查逻辑；cwd、CLI、配置、命令、全局容量与工作区条件可见 | 不试用登录、网络或额度；真正派发仍重查 |
| 运行活动分层可观测 | task detail 的 activity：进程存在、日志/transcript 大小与 mtime、adapter 可识别的尾部事件 | 有界 64 KiB、可缺省；不产生 stalled 判断或自动取消 |
| 验收与机械状态分开 | caller-authored checkpoint 单独存 author/revision/PR/decision/checks/artifacts；不由 COMPLETED/exit0 推导 accepted | 调用者声明与实际报告需自行核对，不提供平台验收背书 |
| 工作区占用/所有权 | 默认 write、共享 read；realpath 与仓库根识别；同一派发锁内检查/预留，真实进程组未结束不放行 | 同 runsDir 范围；read 不等于权限沙箱；独立 worktree 不互相锁死 |
| 当前状态与证据留存 | append-only 检查点 + sequence CAS + 变化游标；保留 notes/goal；显式有界留存与 hash/缺失/变化状态 | 不自动接管 transcript，不自动备份整个忽略目录 |
| CI 验证矩阵与失败传播 | verify.mjs 显式 argv 清单、独立 workspace/平台项、输入清单 hash 与变更发现、完整报告/日志、失败汇总、超时/中断/后台子进程处理 | CI 语义由调用者映射，工具不声称能自动理解任意 workflow/脚本 |

最后一项采用“维护显式 CI 矩阵并检查来源漂移”的方案，而不是在 Hub 内新增通用 CI 解释器。inventory 默认发现 package.json、Cargo.toml、.github/workflows；额外生成目录排除必须显式声明并留在报告中。根 workspace 测试与独立 fuzz manifest 可列成不同 required 项，平台不匹配保持 not-run 并整体非零。AgentHub 自身目前没有 GitHub workflow，提供的 verification.json 实际覆盖本机测试、类型与发布构建，不伪称已运行远端跨平台 CI。

## 架构约束

- 沿用 `createHub → TaskEngine / TaskQueries / ProjectStore → TaskStore` 组装；HTTP/工具转发同一方法。
- 新 workspace/preflight/activity/evidence 模块各自承担事实或准入计算；协议事件解释留在 adapter。
- ProjectCheckpoints 使用现有 SQLite 的新表和项目事件；没有改写旧 TaskStatus、resolution/handoff 含义，没有新常驻进程、依赖或自动调度循环。
- 没有加入语义裁判。accepted 是显式调用者声明；failed/not-run 检查不会因该声明被抹掉。
- 默认 write 是有意的并发行为变更；真正只读并行任务须显式声明 read。旧默认 request_key 指纹保持兼容，幂等重放先于占用判断。
- 没有自动 reset/clean/回滚用户仓库。显式 artifact 留存可包含调用者拥有的未跟踪文件，但平台不猜测文件归属。

## 独立复核与返工

两份独立只读复核分别覆盖准入/活动和检查点/验证，发现并修复：

1. 主进程成功退出却留有后台写者：保留工作区占用；验证工具将残留子进程判为检查失败并清理进程组。
2. 嵌套独立 worktree 被父仓库误锁：两个明确仓库身份按相等比较，普通目录仍保护父子路径。
3. 无 cwd 的项目不应继承 runsDir 的父目录权限：证据范围收紧为 runsDir。
4. 不能静默跳过 lib/vendor/target/dist 下可能存在的独立工作区：改为显式排除清单。
5. 项目目录清理后仍应允许留存 runsDir 中的日志：独立检查各根的可用性。

主调度复核还修复了旧请求指纹兼容、preflight 容量/准备参数一致性、来源在命令执行中变化，以及检查点更新未进入 seen-cursor 变化集合。上述已确认场景均补回归。最终独立复核未发现剩余具体阻塞；这不等于证明不存在任何缺陷。

## 实际验证

最终执行：

```text
node scripts/verify.mjs verification.json /tmp/agenthub-hardening-acceptance-20261020
```

| 检查 | 实际结果 |
| --- | --- |
| npm 测试隔离入口 scripts/test.mjs | 29 个独立测试文件，235 项通过，0 失败 |
| 修复前同一隔离入口 | 25 文件，205 项通过；新增 30 项测试 |
| TypeScript 全部源码检查 | 退出 0 |
| Vite + 发布 server/declarations 构建 | 退出 0 |
| 验证来源 hash/inventory | matched，运行前后无漂移 |
| 最终 requiredChecksPassed | true；报告有 completedAt，三项 required 均 passed |
| diff 检查 | 无空白错误 |

完整报告和每项日志已复制到本机 `.swarm-runs/agenthub-hardening-evidence/20261020/acceptance/`；[报告](../../.swarm-runs/agenthub-hardening-evidence/20261020/acceptance/report.json)、[测试日志](../../.swarm-runs/agenthub-hardening-evidence/20261020/acceptance/1.log)。相邻 `index.json` 保存文件 hash，相关 red/green 日志保留。`.swarm-runs` 被 Git ignore，clone 不包含这些本机证据，需要按运行指南备份。

测试仅使用临时目录、fixture adapter 和短 shell/Node 命令，没有调用付费模型或重新派发 Markview 工作。已在 Mac mini 上实际执行；未宣称 Linux/Windows 原生运行验证。新的 native Agent 协议观测是 best effort，原 Markview ZCode transcript 路径已失效，未拿不存在的原文冒充重放验证。

## 本轮测试隔离疏漏与清理

我曾直接运行一个既有 legacy spec，绕过 scripts/test.mjs 的临时 cwd 隔离。测试清理了兼容 JSON 目录，但默认 SQLite 登记库保留了 6 条已导入的 fixture 行。这是主调度操作疏漏。

已把这 6 条自有 task/event 记录完整备份为 `own-legacy-test-fixtures-before-cleanup.json`，在事务中按确切 ID 和内容归属移除；确认无请求绑定、没有项目关联，Markview 项目原 9 个任务数不变。没有清除其他历史记录。其后完整运行均使用隔离入口。上述备份也在证据索引中。

## 提交与当前生效范围

实现和每次修正均已分项提交：

- `ee6a3e6`：共享预检与工作区写入准入。
- `10933f2`：有界活动事实。
- `8ee88a8`：显式检查点与证据留存。
- `cf884c4`：验证清单及持久报告。
- `b81317f`：旧请求兼容、真实进程组与嵌套 worktree 修复。
- `00dd82a` / `0359d76`：证据范围和已移除目录处理。
- `7a926f4`：验证子进程收尾与显式 inventory 排除。
- `f80c2c2`：检查点参与变化游标。

原有 7 个新增 ticket 文件未纳入任何提交，AGENTS.md、个人配置未改。源代码及构建产物已就绪；**当前运行服务没有重启，新 HTTP/工具方法需要服务下次按正常流程重新加载代码才生效**。未推送、未恢复旧 heartbeat，没有将本机验证报告当作生产发布。

POSIX 下会检查/终止已记录进程组，Windows 对后台子树处理仍有限；自行脱离进程组的程序、Hub 外进程和不同 runsDir 仍不在互斥保护范围。显式排除、可读声明和验收声明均需调用者负责，不能替代权限控制或人类判断。
