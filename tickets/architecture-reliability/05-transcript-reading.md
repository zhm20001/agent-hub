---
ticket: 05-transcript-reading
type: task
status: ready-for-agent
blockedBy: ['03-completion-publication']
parallel: false
---

# 统一解读对话记录

**背景：** 2026-10-15 架构复评后，用户授权自主设计、依次修正五项，每完成一项单独 jj 提交。平台只记录机械事实，不判定任务内容是否成功。

## 方案

- 先将各 Agent 的原始对话读成中立消息列表和模型信息，再生成摘要、最后回复。
- ZCode/Codex 的格式知识放入 adapter；通用展示只处理统一数据；保留已有可识别格式和原文复制。
- 文件读取按路径、大小、修改时间缓存，限制缓存数量；文件增长或替换时失效。

## 修改范围

- `src/adapters/transcript-format.ts`
- `src/runner/transcript-document.ts`
- `src/runner/harvest.ts`
- `src/runner/model-info.ts`
- `src/web/lib/board-ux.ts`
- `tests/transcript-document.spec.ts`

## 验收

- [ ] 报告最后回复与对话页最后 Agent 消息一致。
- [ ] 消息数组、ZCode 事件/model-io、Codex JSONL、坏行、工具调用均有覆盖。
- [ ] 模型信息来自同一次解析；文件变化更新结果；不同 adapter 不串读。

## 执行步骤

- [ ] 先添加能复现问题的行为测试并确认失败。
- [ ] 完成实现，运行针对性测试。
- [ ] 运行 `npm test` 和 `npm run build`，检查改动范围。
- [ ] 更新此文档的状态、验证结果，使用 `jj commit <本项文件> -m "..."` 单独提交。

## 约束

- 保留原有其他工单，不纳入本次提交。
- 沿用现有目录和 HTTP 返回格式；不引入消息队列、通用插件框架或数据库。
- 测试使用假 CLI 和临时数据，不调用付费 Agent，不执行真实编码任务。
