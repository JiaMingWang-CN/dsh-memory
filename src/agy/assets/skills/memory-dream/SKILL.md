---
name: memory-dream
description: >-
  两阶段记忆整理工作流。当用户要求执行 Dream 整理（将近期捕获的工作片段 episodes 提炼为待审提案）、
  执行 Organize 全库整理（合并重复或冲突的 active 记忆），或收到 PreInvocation autoDream 提醒时使用。
---

# 两阶段记忆整理（Dream & Organize）

AGY 端采用 `prepare → 子代理提炼 → commit` 两阶段整理，无需额外 API Key，所有产出一律先写入 `pending` 等待人工审阅。

## 后台子代理模型档位选择

- AGY 配置项 `dreamSubagentModel`（默认 `"flash"`，可选 `"flash_lite"` / `"flash"` / `"pro"` / `"inherit"`）决定建议派生子代理时使用的 `Model` 档位。
- 主代理可通过 `memory_status` 或 `memory_dream_prepare` / `memory_organize_prepare` 返回的 `recommendedSubagentModel` 查看当前配置的档位，在调用 `invoke_subagent` 派生后台整理子代理时传入对应 `Model`（如 `Model: "flash"`），避免无谓消耗主模型额度或阻塞主会话任务。
- **注意**：`invoke_subagent` 默认继承主代理记忆工具能力，且需在调用 `memory_dream_prepare` 时传入 `model` 参数（如 `model: "subagent:flash"`）以在审计记录中标明本次整理所用的模型档位。

## 流程 A：片段整理（Dreaming）

1. **准备阶段**：调用 `memory_dream_prepare`（可按需传 `maxEpisodes`、`since`、`trigger`、`model`）。工具会认领待处理 `episodes` 并返回 `dreamId`、`systemPrompt`、`userPrompt`、`outputSchema` 与 `recommendedSubagentModel`。
2. **严格按高门槛证据规则提炼提案**：
   - 仔细阅读返回的 `systemPrompt` 与 `userPrompt`，仅依据本次提供的 `episodes` 提炼长期知识，严禁引入外部臆测或未验证细节。
   - **宁缺毋滥**：若片段仅包含常规执行、一次性状态快照、瞬时工具报错/重试（`UNKNOWN`、`FS_NOT_FOUND`、`FS_EDIT_NOT_FOUND`、`SEARCH_FAILED`、`WEB_PROVIDER_ERROR` 等）、已中止/未完成任务、未验证猜想，或与 `## Related memories`（含 `pending` 提案）重复，直接输出空数组 `memories: []`。
   - 当配置 `worklogCapture: "off"` 时，`systemPrompt` 与 `outputSchema` 会禁止 `worklog` 类型，严禁输出 `worklog` 提案。
   - 每条提案必须包含 `type`（允许集合内）、简短 `title`、精炼 Markdown `body`、`confidence`（0–1）、`importance`（0–1）以及完整的 `sourceEpisodeIds`（不可截断 ID）。
   - 严禁输出密钥、密码、Token、源码大段粘贴或已自动加载的 `AGENTS.md` / `README` 内容。
3. **提交阶段**：调用 `memory_dream_commit` 传入 `dreamId` 与 `memories`：
   - 若返回强密钥或字段校验错误，`dreamId` 仍保持 `running` 状态，可修正脱敏后原地重新调用 `memory_dream_commit` 重试。
   - 传入 `memories: []` 时，任务正常完成，已认领片段会被标记为 `skipped`，避免下轮重复认领。
4. **后续引导**：若有新生成 `pending` 提案，提示用户可通过 `memory-review` 技能或 Memloom Desktop 逐条查看并批准或拒绝。

## 流程 B：全库整理（Organize）

1. **准备阶段**：调用 `memory_organize_prepare`（可传 `maxRecords`、`model`），获取 `dreamId`、`systemPrompt`、`recommendedSubagentModel` 与当前作用域最多 60 条 `active` 记忆。
2. **合并与去重**：仅针对存在明显重复、重叠或相互冲突的记录输出精炼合并后的提案；每条提案**必须**包含非空的 `supersedes` 数组，准确列出将被替代的旧 `active` 记忆 ID；无需改动的记忆保持原样，无可合并项时传入 `memories: []`。
3. **提交阶段**：调用 `memory_organize_commit` 传入 `dreamId` 与 `memories`。提案写入 `pending`，在用户批准前不会改动任何现有 `active` 记录。

## 原生自动整理（`autoDream`）与定时自动化

- 当 `autoDream: true` 时，`Stop` Hook 捕获到新片段后会标记待整理状态；满足冷却间隔 `autoDreamMinIntervalMs` 后，下次 `PreInvocation` 会注入 `<system-reminder>` 提醒主代理派生指定 `dreamSubagentModel` 档位的后台子代理运行流程 A。
- 若希望按固定时间表定期整理，也可结合 AGY 原生 `/automation` 定时触发本技能。

## 撤销提示

- 如需撤销某次已完成的整理，可记录 `dreamId` 并提示用户通过 `memory_undo_dream` 执行（受 `PreToolUse` 强制确认门禁保护，且不会覆盖用户后续已手动编辑的记忆）。
