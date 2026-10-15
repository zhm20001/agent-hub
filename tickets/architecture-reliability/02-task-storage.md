---
ticket: 02-task-storage
type: task
status: ready-for-agent
blockedBy: ['01-board-refresh']
parallel: false
---

# 统一文件保管与更新

**背景：** 2026-10-15 架构复评后，用户授权自主设计、依次修正五项，每完成一项单独 jj 提交。平台只记录机械事实，不判定任务内容是否成功。

## 方案

- 建立具体文件存储类，运行目录作为构造参数；不引入数据库抽象。
- 原子替换 JSON/报告；任务编号校验、独占创建；跨进程更新加锁且读取最新数据后修改。
- 派发名额检查和预留在同一锁内；旧导出兼容；存储扫描统一。

## 修改范围

- `src/runner/task-store.ts`
- `src/runner/detached.ts`
- `src/runner/concurrency.ts`
- `src/runner/settlement.ts`
- `tests/task-store.spec.ts`

## 验收

- [ ] 临时目录相互隔离；重复 ID 和路径穿越被拒绝。
- [ ] 并发更新不同字段不丢失；终态不能被旧写入改回；读取完整 JSON。
- [ ] 多个派发进程不能突破名额；异常后锁和预留可恢复。

## 执行步骤

- [ ] 先添加能复现问题的行为测试并确认失败。
- [ ] 完成实现，运行针对性测试。
- [ ] 运行 `npm test` 和 `npm run build`，检查改动范围。
- [ ] 更新此文档的状态、验证结果，使用 `jj commit <本项文件> -m "..."` 单独提交。

## 约束

- 保留原有其他工单，不纳入本次提交。
- 沿用现有目录和 HTTP 返回格式；不引入消息队列、通用插件框架或数据库。
- 测试使用假 CLI 和临时数据，不调用付费 Agent，不执行真实编码任务。
