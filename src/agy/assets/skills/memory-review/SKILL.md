---
name: memory-review
description: >-
  待审记忆提案（pending）审阅与撤销工作流。当用户需要查看、对比变更 Diff、编辑并批准或拒绝
  Dream/Organize 生成的 pending 提案，或按 dreamId 撤销既往整理时使用。
---

# 待审记忆审阅（Memory Review）

所有由 Dream 或 Organize 自动生成的记忆提案均处于 `pending` 状态，必须由用户通过确认门禁显式审阅后才能激活。

## 审阅步骤

1. **获取待审列表**：调用 `memory_list`（`status: "pending"`）列出当前作用域及全局下的待审提案（结果已包含提案的完整 `title`、`body`、`tags`、`importance`、`supersedes` 与 `sourceRefs`）。若无待审条目，直接告知用户。
2. **补充读取与来源证据**：如需按 ID 单独读取某条 `pending` 提案的完整字段，调用 `memory_read`（传入 `includeNonActive: true`，不会递增 `useCount`）。
3. **展示对比（Diff）**：
   - 若提案的 `supersedes` 非空，针对每个被替代的旧 ID 调用 `memory_read`（读取现有 `active` 记录），向用户并排展示：
     - 提案类型、作用域、标签与重要度；
     - **旧记忆 vs 新提案**的标题与正文差异；
     - 来源引用（`sourceRefs` / 关联 `dreamId`）。
   - 若提案为纯新增（`supersedes` 为空），清晰展示完整标题、正文与来源摘要。
4. **征求决策并提交**：
   - 根据用户指示（批准、编辑后批准或拒绝），调用 `memory_review`：
     - 批准：`action: "accept"`，若用户要求微调措辞，可同时传入修订后的 `title`、`body`、`tags` 或 `importance`；
     - 拒绝：`action: "reject"`。
   - **确认门禁**：每次调用 `memory_review` 都会触发 `PreToolUse` `force_ask` 弹窗确认；批准时系统会先归档 `supersedes` 中的旧 `active` 记忆，再激活新记忆并升级为 `ownership: "user"`。
5. **批量或单条处理**：若有多条提案，逐条或按用户明确指定的集合依次展示并调用 `memory_review`，禁止未经用户逐项/明确确认自行批量批准。

## 撤销已执行的整理

- 若用户希望回退某次 Dream/Organize 的影响：
  1. 先调用 `memory_status` 或 `memory_audit` 确认目标 `dreamId` 及影响范围；
  2. 调用 `memory_undo_dream`（触发确认弹窗），系统会校对 `contentRevision`，拒绝覆盖用户后续已手动编辑的记忆。
