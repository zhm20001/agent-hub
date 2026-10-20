# AgentHub 高优先级运行修复设计

授权：用户要求按复盘高优先级清单拟定方案并实施，同时保持架构健康。原有 7 个 intent-to-add 票不在提交范围。实现不修改 Markview，不推送，不重启现有服务。

## 取舍

只补操作手册不能阻止并发写入或错误检查汇总；加入自动语义裁判/调度中心会违背 ADR-0002。采用现有边界内的事实查询、原子准入、显式记录和通用检查工具。HTTP 和工具共享同一实现，无新常驻进程，无新外部依赖。

## 六个增量

1. **预检**：TaskEngine.preflight 使用与派发相同的输入准备、cwd 准入、adapter preconditions、命令可用性检查；返回各检查项事实，不启动 Agent、不保留 taskId/request_key。派发重查瞬时条件。已有 adapter precondition 拒绝的 FAILED 收尾语义保留，cwd 准入拒绝仍不建任务。修复将目录误认成可读文件的现有检查。
2. **工作区准入**：DispatchOptions.workspaceAccess = read | write，默认 write；规范化 realpath，并寻找最近 .git/.jj 根，子目录和 symlink 统一身份。读可共存，写与同工作区任何活跃占用互斥。沿用 runsDir 的跨进程 dispatch lock；幂等重放先于占用检查。取消后 supervisor/进程组仍存活时不放行；旧 RUNNING 记录保守占用，先由既有 recovery 回收。独立 worktree 为独立工作区。跨 runsDir 和 Hub 外进程不受此锁保护；read 是调度声明，不是权限沙箱。先记录归属后启动，不自动清理目标仓库文件。
3. **活动事实**：TaskQuery 返回 processAlive、raw.log 字节/mtime、transcript 可用性/mtime、adapter 能识别的最近事件。仅有界读取；不通过安静时间推断卡死，不自动取消，不修改 TaskStatus。原始内容/CLI 事件的解释留在 adapter。
4. **项目检查点与验收**：独立 ProjectCheckpoints 模块在现有 SQLite 中保存 append-only 记录；包含 author、summary、nextStep、revision、pullRequest、sourceTaskIds、显式 decision(pending/accepted/rejected)、逐项 checks 和 artifacts。expectedSequence 做 compare-and-set，旧写者收到409；最新 checkpoint 与 latestNote 分开返回，不覆盖项目 goal/history。decision 是调用者声明，不能由任务退出码生成。非通过/未执行检查保持可见，不自动替人作验收决定。
5. **证据留存**：调用者提交特定 artifact 路径，限项目目录和 runsDir，hash/大小/可用性可核查；按显式 retain 选择存入项目 evidence 内容寻址目录，限制数量和文件大小，路径按 realpath 防逃逸。原始 agent transcript 仍由 adapter 拥有，平台不自动复制。context 提示丢失/变更；notes 返回总数/截断信息。留存不承诺忽略目录自动备份。
6. **验证清单**：scripts/verify.mjs 接受 JSON manifest，逐项 argv（无 shell 插值）、cwd、platform、required、source 文件 hash；检查独立 workspace 由清单显式列出。报告必须保留 failed/not-run/source-changed，不将 skip 计作 pass；任一 required 未通过或来源变化整体非零，完整日志落报告目录。manifest 作者负责从 CI 维护映射；不伪称通用 YAML/脚本解析器能自动证明覆盖完整。提供 AgentHub 自身清单与 fixtures，报告可作为 checkpoint artifact。

## API

- POST /api/tasks/preflight，swarm_preflight：DispatchOptions → ready/checks/conflicts，无任务创建。
- 原 dispatch 增加 workspaceAccess；GET task detail 增加 activity。
- POST /api/projects/:id/checkpoints，swarm_project_checkpoint：提交显式记录，GET context 返回 checkpoint、artifact 状态、notesPage。
- node scripts/verify.mjs <manifest.json> <report-directory>：输出 report.json 和逐项日志；报告目录必须不存在，避免覆盖旧证据。

## 验证与回归

测试使用临时目录、假 adapter 和真实短 shell；不消费真实 Agent 额度。每项先红后绿，分别提交。覆盖 symlink/子目录互斥、并发进程抢占、幂等重放、取消窗口、无副作用预检、CLI/配置目录拒绝、安静活进程、CAS/重开数据库、证据逃逸/丢失/修改、失败传播/平台不执行/来源变化。最终跑隔离全套 npm test、typecheck、build 与自身验证清单。只在全部检查通过后报告完成。
