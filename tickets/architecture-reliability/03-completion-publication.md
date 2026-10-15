---
ticket: 03-completion-publication
type: task
status: ready-for-agent
blockedBy: ['02-task-storage']
parallel: false
---

# 产物准备好后再通知

**背景：** 2026-10-15 架构复评后，用户授权自主设计、依次修正五项，每完成一项单独 jj 提交。平台只记录机械事实，不判定任务内容是否成功。

## 方案

- 保留先记录停止意图的恢复行为，报告与收尾记录完成后写就绪标记。
- 监听就绪标记而非猜测状态变化；启动时已有记录作为基线；不承诺重启跨进程恰好一次投递。
- 同一 watcher 生命周期每任务通知一次；短任务未观察到 RUNNING 也能通知；旧任务恢复路径补发布。

## 修改范围

- `src/runner/detached.ts`
- `src/watcher.ts`
- `tests/completion-publication.spec.ts`

## 验收

- [ ] 只有终态没有完整产物时不通知。
- [ ] 未观察到 RUNNING 的快速任务也收到完整报告。
- [ ] 重复完成/晚到 close 不重复通知；停止 watcher 后不再通知。

## 执行步骤

- [ ] 先添加能复现问题的行为测试并确认失败。
- [ ] 完成实现，运行针对性测试。
- [ ] 运行 `npm test` 和 `npm run build`，检查改动范围。
- [ ] 更新此文档的状态、验证结果，使用 `jj commit <本项文件> -m "..."` 单独提交。

## 约束

- 保留原有其他工单，不纳入本次提交。
- 沿用现有目录和 HTTP 返回格式；不引入消息队列、通用插件框架或数据库。
- 测试使用假 CLI 和临时数据，不调用付费 Agent，不执行真实编码任务。
