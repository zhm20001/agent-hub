---
ticket: 01-board-refresh
type: task
status: ready-for-agent
blockedBy: []
parallel: false
---

# 统一看板刷新，隔离过期请求

**背景：** 2026-10-15 架构复评后，用户授权自主设计、依次修正五项，每完成一项单独 jj 提交。平台只记录机械事实，不判定任务内容是否成功。

## 方案

- 新增可取消、串行的轮询器；一次请求结束后才安排下一次。
- 列表、详情、对话使用同一套读取规则；切换任务和卸载后忽略旧响应；终态对话补刷新。
- 保留当前 HTTP 路径、页面布局与手动刷新。

## 修改范围

- `src/web/lib/task-data.ts`
- `src/web/hooks/use-task-data.ts`
- `src/web/App.tsx`
- `src/web/components/TaskDetail.tsx`
- `src/web/components/ConversationView.tsx`
- `tests/task-data.spec.ts`

## 验收

- [ ] 首次加载一次；完成请求不会立刻再次请求；刷新不重叠。
- [ ] 切换任务后旧响应不覆盖新任务；清理后不再更新；请求失败后能重试。
- [ ] 运行中的对话持续刷新；终态至少重新读取一次。

## 执行步骤

- [ ] 先添加能复现问题的行为测试并确认失败。
- [ ] 完成实现，运行针对性测试。
- [ ] 运行 `npm test` 和 `npm run build`，检查改动范围。
- [ ] 更新此文档的状态、验证结果，使用 `jj commit <本项文件> -m "..."` 单独提交。

## 约束

- 保留原有其他工单，不纳入本次提交。
- 沿用现有目录和 HTTP 返回格式；不引入消息队列、通用插件框架或数据库。
- 测试使用假 CLI 和临时数据，不调用付费 Agent，不执行真实编码任务。
