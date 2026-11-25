---
name: memory-dream
description: >-
  两阶段记忆整理工作流。当用户要求执行 Dream 整理（将近期捕获的工作片段 episodes 提炼为待审提案）
  或执行 Organize 全库整理（合并重复或冲突的 active 记忆）时使用。
---

# 两阶段记忆整理（Dream & Organize）

AGY 端采用 `prepare → 代理提炼 → commit` 两阶段整理，无需额外 API Key，所有产出一律先写入 `pending` 等待人工审阅。

## 流程 A：片段整理（Dreaming）

1. **准备阶段**：调用 `memory_dream_prepare`（可按需传 `maxEpisodes`、`since`）。工具会认领待处理 `episodes` 并返回 `dreamId`、`systemPrompt`、`userPrompt` 与 `outputSchema`。
2. **严格按证据提炼提案**：
   - 仔细阅读返回的 `systemPrompt` 与 `userPrompt`，仅依据本次提供的 `episodes` 提炼长期知识，严禁引入外部臆测或未验证细节。
   - 每条提案必须包含 `type`（`lesson` / `wiki` / `preference` / `worklog`）、简短 `title`、精炼 Markdown `body`、`confidence`（0–1）、`importance`（0–1）以及完整的 `sourceEpisodeIds`（不可截断 ID）。
   - 严禁输出密钥、密码、Token、源码大段粘贴或已自动加载的 `AGENTS.md` / `README` 内容。
   - **空提案允许**：若本批片段没有值得沉淀的长期知识，直接准备空数组 `memories: []`。
3. **提交阶段**：调用 `memory_dream_commit` 传入 `dreamId` 与 `memories`：
   - 若返回强密钥或字段校验错误，`dreamId` 仍保持 `running` 状态，可修正脱敏后原地重新调用 `memory_dream_commit` 重试。
   - 传入 `memories: []` 时，任务正常完成，已认领片段会被标记为 `skipped`，避免下轮重复认领。
4. **后续引导**：若有新生成 `pending` 提案，提示用户可通过 `memory-review` 技能逐条查看并批准或拒绝。

## 流程 B：全库整理（Organize）

1. **准备阶段**：调用 `memory_organize_prepare`，获取 `dreamId`、`systemPrompt` 与当前作用域最多 60 条 `active` 记忆。
2. **合并与去重**：仅针对存在明显重复、重叠或相互冲突的记录输出精炼合并后的提案；每条提案**必须**包含非空的 `supersedes` 数组，准确列出将被替代的旧 `active` 记忆 ID；无需改动的记忆保持原样，无可合并项时传入 `memories: []`。
3. **提交阶段**：调用 `memory_organize_commit` 传入 `dreamId` 与 `memories`。提案写入 `pending`，在用户批准前不会改动任何现有 `active` 记录。

## 撤销提示

- 如需撤销某次已完成的整理，可记录 `dreamId` 并提示用户通过 `memory_undo_dream` 执行（受 `PreToolUse` 强制确认门禁保护，且不会覆盖用户后续已手动编辑的记忆）。
