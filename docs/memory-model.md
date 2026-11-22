# 记忆模型

本文描述 0.1.0 已实现的四类记忆、作用域与所有权规则。

## 四类记忆

| 类型 | 内容 | 默认作用域 | 典型来源 |
| --- | --- | --- | --- |
| `lesson` | 触发条件、错误、正确做法、可复用规则 | 工作区 | 用户纠正、工具失败后改对、dreaming |
| `worklog` | 一次有实际产出或明确完成结果的工作摘要 | 工作区 | 满足条件的 turn、dreaming 日汇总 |
| `wiki` | 项目架构、约定、命令、关键决策，Markdown 正文可互链 | 工作区 | dreaming 归并、显式写入 |
| `preference` | 用户偏好、习惯、长期目标 | 全局（也可工作区） | 用户显式要求、dreaming 提取 |

`worklog` 有 `worklogKind`：

- `turn`：单个 turn 的轻量摘要，默认**不进入**常驻索引；当没有足够的 `worklog(daily)` 时，作为索引“最近工作”的兜底进入（最近 7 天窗口、总数不超过 3 条，只取标题与日期，不取正文摘要）；由满足条件的 `turn/end` 确定性生成（`origin='system'`、`ownership='derived'`、`active`），不调用 LLM。子代理（`delegationDepth > 0`）的 turn 仍写 episode，但不生成 `worklog(turn)`。
- `daily`：dreaming 将多个 turn episode 汇总成的日工作日志，是索引“最近工作”的首选来源，产物为 `pending`。

每条记忆包含：`id`、`type`、`worklogKind`、`scope`、`origin`、`ownership`、`pinned`、`title`、`body`（Markdown）、`tags`、`status`、`confidence`、`importance`、`contentRevision`、`statsRevision`、`sourceRefs`、`sourceEpisodeIds`、`supersedes`、`proposalKey`、`reviewedByUserAt`、`createdAt`、`updatedAt`、`lastMatchedAt`、`matchCount`、`lastUsedAt`、`useCount`、`contentHash`、可选 `expiresAt`。

状态 `status`：

- `active`：可检索、可注入。
- `pending`：dream 提案，等待人工审阅；不进入检索与索引，只在管理页“待审阅”可见。
- `archived`：软遗忘或过期归档；不参与检索与注入，可在管理页恢复。

## 作用域

- `global`：所有工作区可见；只允许 `preference` 类型。用于“回复用中文”“不要自动提交”等跨项目偏好。
- `workspace`：绑定一个工作区根目录，按规范化后的绝对路径计算稳定的 `workspaceKey`。教训、工作日志、项目知识默认都在这里。
- 未指定工作区（无 `cwd` 的会话）：只使用全局记忆，不写工作区记忆。
- 子代理：默认继承其 `cwd` 对应的工作区记忆；`injectForSubagents` 默认 `false`（不给每个子任务增加固定上下文），子代理的 episode 照常捕获，但不生成 `worklog(turn)`。
- 工作区隔离：检索、索引与管理页默认只显示当前工作区与全局偏好；只有显式切换到“所有可访问工作区”才会展示其他工作区的记忆。

`memory_write` 不能改变已有记忆的作用域；把工作区记忆扩大为全局必须通过显式用户管理动作。

## 所有权

- `ownership = 'user'`：显式创建/编辑/导入的记忆，以及用户执行 Accept、Edit before accept、Restore 后的提案。`rebuild` 永不删除。
- `ownership = 'derived'`：dreaming 生成、且从未经过人工确认或编辑的记忆。`rebuild` 可删除并按会话历史重放重建。
- `reviewedByUserAt`：用户执行 Accept / Edit before accept / Restore 时写入；即使 `origin = 'dream'`，`ownership` 也转为 `user`，并记录审核操作。这样用户审阅通过的长期知识不会在 rebuild 时消失。
- `pinned = true`：用户显式保护，任何自动清理、归档、rebuild 都不得删除；仍可由用户手动永久删除。

**Rebuild 不是备份恢复。**它删除并重建 `derived` 且未被用户确认、未置顶的记忆，随后在会话历史可用时重放最近 `rebuildLookbackDays` 天（或 `since`）的冷会话；`user` 拥有的记忆、导入内容与用户编辑过的条目一律保留，但不保证能从 session log 精确恢复。

**容量保护。**`maxActiveMemories` 溢出时只会自动归档未审阅的 `derived`、非 pinned 记录；用户拥有的记录与 pinned 记录不会被自动归档，容量不足时新增/恢复/接受提案会以 `MEMORY_CAPACITY` 拒绝。

## 统计与版本

- `matchCount` / `lastMatchedAt`：`memory_search` 命中时更新，仅用于诊断与排序辅助，不做自增强。
- `useCount` / `lastUsedAt`：只有当模型调用 `memory_read` 读取完整正文时更新；搜索命中不算使用。
- `contentRevision` 只随业务字段（标题、正文、标签、作用域、状态、importance、pinned 等）变化递增；`statsRevision` 只随统计字段变化递增。撤销与 CAS 只比较 `contentRevision`。
- `supersedes`：dreaming 纠错时在新版本中列出被替代的旧条目 id；新版本 `pending` 时旧条目保持 `active`，Accept 时按操作日志先归档旧条目再激活新条目，绝不出现新旧同时 `active`。
