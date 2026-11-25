---
name: memory
description: >-
  长期记忆对话式管理入口。当用户需要查看记忆状态、搜索或浏览记忆、显式记录或更新规则偏好、
  软遗忘或恢复条目、查询审计日志、导出或导入记忆快照、调整插件配置或重建派生数据时使用。
---

# 长期记忆管理（Memory）

本技能提供与 `dsh-memory` MCP 工具（在插件命名空间下通常呈现为 `memory_*` 或 `dsh-memory_memory_*`）配合使用的标准管理流程。

## 1. 常用操作路由

| 用户意图 | 对应工具 | 说明 |
| :--- | :--- | :--- |
| 查看计数、最近恢复与配置 | `memory_status` | 只读概览，可先定位问题与统计 |
| 按关键词检索记忆 | `memory_search` → `memory_read` | `search` 仅返回摘要并计入匹配次数；按需 `read` 才读取正文与引用 |
| 分页浏览记忆 | `memory_list` | 支持按 `status`、`type`、`tags`、`query` 筛选；`scope: "all"` 或跨工作区需弹窗确认 |
| 新增或更新长期记忆 | `memory_write` | 立即 `active`（`ownership: "user"`）；更新时必传 `id` 与 `expectedContentRevision` |
| 软遗忘（归档） | `memory_forget` | 将 `active` 转为 `archived`，可恢复 |
| 恢复已归档记忆 | `memory_restore` | 敏感操作，触发 `PreToolUse` 强制确认 |
| 永久物理删除 | `memory_delete` | 敏感操作，需 `id` 与 `expectedContentRevision`，不可恢复 |
| 查看审计历史 | `memory_audit` | 可按 `memoryId`、`dreamId`、`limit` 过滤 |
| 导出记忆快照 | `memory_export` | 纯只读，绝不自动清空归档；指定 `outputPath` 或跨工作区时触发确认弹窗，且不覆盖既有文件 |
| 导入记忆快照 | `memory_import` | 敏感操作；支持 `merge` / `replace`，`replace` 会覆盖作用域内已有记录 |
| 修改运行配置 | `memory_config` | 敏感操作；修改后即时热生效，不支持 DSH 专有或未知字段 |
| 重建派生记忆 | `memory_rebuild` | 敏感操作；仅清理并重建 `derived` 数据，保留 `user` 记忆 |
| 清空存储 | `memory_purge` | 敏感操作；不可逆清空指定作用域或全部记忆 |

## 2. 执行规范

1. **写入前先检索**：创建前先用 `memory_search` 确认无重复；发现旧记录需修正时，先 `memory_read` 读取最新 `contentRevision` 再调用 `memory_write` 更新。
2. **严守内容边界**：不写入密钥、文件源码、命令输出或已自动加载的仓库文档；若遇密钥，仅记录配置位置。
3. **尊重作用域与门禁**：未绑定有效工作区时，仅允许读写 `global` 类型的 `preference`；切勿伪造路径或尝试绕过 `PreToolUse` 弹窗确认。
4. **整理与审阅跳转**：若用户希望从近期会话提炼提案或合并重复记忆，切换至 `memory-dream` 技能；若要逐条审阅 `pending` 提案，切换至 `memory-review` 技能。
