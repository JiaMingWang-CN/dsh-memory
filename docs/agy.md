# Antigravity（AGY）原生插件指南

`memloom`（原 `dsh-memory`）在同一仓库内抽离了零宿主依赖的共享记忆内核（`src/core/`），并在 `src/agy/` 提供 **Antigravity（AGY）原生插件适配层**，让 AGY 能够以原生 MCP 工具、Hooks、Rules 与 Skills 的形式使用与 DSH 对等的长期记忆能力（`lesson` / `worklog` / `wiki` / `preference`、工作区隔离、本地 BM25 检索、操作日志状态机与崩溃恢复、脱敏与容量控制）。

> [!NOTE]
> **开发状态说明**：`memloom` 当前仍处于 **0.x 开发版本**，尚未发布稳定版。AGY 适配层的工具参数、Hook 协议与配置仍可能随迭代调整；AGY 产物不混入 DSH `.tgz` bundle，也不发布 npm 包。

---

## 构建与本地安装

### 环境要求

- **运行时**：Node.js `>= 24.9.0`（构建出的自包含插件目录仅依赖本机 Node，无需安装 `node_modules`）
- **源码构建**：`pnpm`

### 从源码构建与校验

```bash
git clone https://github.com/JiaMingWang-CN/memloom.git
cd memloom
pnpm install
pnpm build:agy        # 使用 esbuild 构建自包含插件目录 dist/agy-plugin/
pnpm pack:agy:check   # 校验插件清单、字段合法性、脚本路径与零外部依赖隔离
```

`dist/agy-plugin/` 产物结构：

```text
dist/agy-plugin/
├── plugin.json             # 插件清单（name: "memloom", displayName: "Memloom"）
├── mcp_config.json         # Stdio MCP Server 配置（服务名 memory -> 命名空间 memloom_memory；6 个高频工具标记为 eager，敏感/整理/导出工具按需加载）
├── hooks.json              # PreInvocation / Stop / PreToolUse 钩子定义
├── assets/logo.svg         # 插件图标
├── bin/
│   ├── mcp-server.mjs      # 单文件 ESM Stdio MCP Server（零外部运行依赖）
│   └── hook.mjs            # 单文件 ESM 统一 Hook CLI（零外部运行依赖）
├── rules/                  # 插件启用时常驻生效的精简规则
└── skills/
    ├── memory/SKILL.md         # 对话式记忆管理工作流
    ├── memory-dream/SKILL.md   # 两阶段片段整理与全库整理工作流
    └── memory-review/SKILL.md  # 待审阅提案逐条审阅与确认工作流
```

### 本地安装到 AGY

可采用以下任一方式挂载已构建的 `dist/agy-plugin/`：

1. **复制到 AGY 插件目录**：将整个 `dist/agy-plugin/` 目录复制到 `~/.gemini/config/plugins/memloom`。
2. **通过 `plugins.json` 引用**：在 AGY 的 `plugins.json` 中登记指向本地 `dist/agy-plugin/` 目录的插件路径。

完成后重启或重新加载 AGY 插件即可生效。禁用或卸载插件后，Hooks、MCP Server、Rules 与 Skills 会停止加载；`${PLUGIN_DATA}/memory.json` 中由用户拥有的数据会继续保留，不会被卸载流程删除。

---

## 存储布局与环境变量

### 路径解析优先级

AGY 适配层按以下顺序解析数据存储路径（优先取第一个非空环境变量）：

1. `MEMLOOM_STORE_PATH`（向后兼容旧变量 `DSH_MEMORY_STORE_PATH`）：直接指定主存储 JSON 文件路径（其所在目录同时作为数据目录）。
2. `MEMLOOM_DATA_DIR`（向后兼容旧变量 `DSH_MEMORY_DATA_DIR`）：指定插件数据目录（使用 `<dir>/memory.json`）。
3. `PLUGIN_DATA`：AGY 宿主自动注入的插件数据目录（使用 `${PLUGIN_DATA}/memory.json`）。
4. 兜底目录（未设置上述环境变量时）：`~/.gemini/config/plugin-data/memloom/memory.json`。

### `${PLUGIN_DATA}` 目录结构

| 路径 | 用途与生命周期 |
| --- | --- |
| `memory.json` | 主存储文件（`name: "memory"`、`version: 1`），包含与 DSH 一致的 6 张表：`memories`、`episodes`、`dreams`、`audit`、`operations`、`session_cursors`。 |
| `.memory.lock` | 跨进程排他写锁（默认等待上限 5000ms，陈旧锁阈值 30 秒，持锁进程已退出或超过硬上限时安全接管），配合临时文件 `fsync` + 原子 `rename` 与读前变更检测，保障常驻 MCP Server 与短进程 Hooks 并发写安全与立即可见。 |
| `config.json` | AGY 运行时配置（默认值与 [`docs/configuration.md`](configuration.md) 一致），经 `memory_config` 修改后即时热生效，无需重启 MCP Server。其中包含 AGY 适用的 `dreamSubagentModel`（默认 `flash`，可选 `flash_lite` / `flash` / `pro` / `inherit`）；DSH 专有的模型选择字段（`dreamModelMode` / `dreamProvider` / `dreamModel` / `dreamReasoningEffort`）在 AGY 中不生效。 |
| `sessions/<conversationId>.json` | 可重建的会话缓存（索引折叠态、会话工作区锚点与跨 `Stop` 捕获状态）；超过 30 天未更新时随保留清理自动回收。 |
| `backups/` | 存储表校验发现损坏时的原始文件快照备份目录。 |
| `logs/hook-errors.log` | 脱敏、按大小轮转的 Hook 诊断日志。 |
| `.runtime-nonce` | Hook CLI 与 MCP Server 间用于校验宿主注入上下文的运行态防伪令牌。 |

### 按表分级的损坏保护

- **核心用户表 `memories`**：若任一条记录 schema 校验失败，插件会先将原始文件完整备份到 `${PLUGIN_DATA}/backups/`，随即**拒写阻断**并返回 `MEMORY_UNAVAILABLE` 及损坏记录 ID 与修复指引，绝不跳过损坏项后覆写在线文件。
- **派生/过程表（`episodes`、`dreams`、`audit`、`operations`、`session_cursors`）**：单条记录损坏时先备份原始文件，再隔离跳过异常记录并输出诊断告警，保障服务继续可用。
- **整文件 JSON 损坏**：拒绝覆写原文件，返回 `MEMORY_UNAVAILABLE` 及修复指引。

---

## 工作区隔离与 20 个分级 MCP 工具

### 权威工作区解析与降级

AGY 常驻 MCP Server 不信任模型自由传入的相对路径或跨项目路径，而是按以下优先级确定本次调用的工作区：

1. **Hook 注入宿主上下文（最高优先级）**：`PreToolUse` Hook 从宿主 `workspacePaths[0] ?? cwd` 与 `conversationId` 生成受信任上下文，并附带经 `.runtime-nonce` 校验的令牌。
2. **MCP `roots/list` 协议**：当客户端声明并响应 `roots/list` 时，从返回的 `file://` URI 中选择最具体的工作区路径。
3. **会话工作区锚点**：读取 `PreInvocation` 写入 `sessions/` 的近期会话工作区锚点。
4. **安全降级**：若上述渠道均无法确定有效工作区，所有读写操作严格降级为**仅 `global` 偏好可见/可写**；尝试写入 `workspace` 记忆或操作归属某工作区的记忆 ID 时返回 `MEMORY_FORBIDDEN_SCOPE`。

路径统一经规范化处理（正斜杠转换、去尾斜杠、Windows 盘符与 UNC 小写归一化）生成 `scope.key`。

### 常规工具（12 个）

常规工具受工作区隔离与脱敏规则约束，默认调用无需弹窗确认：

| 工具名 | 职责与核心约束 |
| --- | --- |
| `memory_search` | BM25 检索当前工作区与全局 `active` 记忆（仅递增 `matchCount`；省略 `query` 按优先级列出可见记忆）。 |
| `memory_read` | 按 `id` 读取完整记忆正文、来源引用、`supersedes`、`sourceEpisodeIds` 与版本号（默认仅读取 `active` 记录并递增 `useCount`；传入 `includeNonActive: true` 可在审阅时读取 `pending`/`archived` 提案且不计入 `useCount`），禁止越权跨工作区读取。 |
| `memory_write` | 创建或更新（需 `id` + `expectedContentRevision`）记忆，立即 `active`（`ownership='user'`）；含强密钥拒写、自动脱敏与同 scope/type/规范化标题去重。 |
| `memory_forget` | 软遗忘（将 `active` 归档为 `archived`，可恢复）。 |
| `memory_list` | 只读分页浏览记忆（默认 `current` 返回当前工作区 + 全局；`scope: 'workspace'` 严格仅返回当前工作区且不含全局；`scope: 'global'` 仅返回全局）；传入 `scope: 'all'` 或跨工作区 `workspaceRoot` 时条件升级为 `PreToolUse` `force_ask`。 |
| `memory_status` | 只读查看各状态记忆/片段/审计/操作计数、最近恢复状态、最近 Dream 运行记录与配置摘要。 |
| `memory_audit` | 只读查询当前工作区与全局可见的审计记录（可按 `memoryId`、`dreamId`、`limit` 过滤）。 |
| `memory_export` | 纯只读导出兼容 JSON 快照（**不会在导出时自动触发 `archivePurgePolicy: 'after-export'` 清空归档**）；传入 `scope: 'all'`、跨工作区 `workspaceRoot` 或 `outputPath` 写盘时条件升级为 `PreToolUse` `force_ask`（相对 `outputPath` 基于当前工作区根目录解析，写盘默认拒绝覆盖既有文件）。 |
| `memory_dream_prepare` | 两阶段片段整理（第 1 步）：认领待处理 `episodes` 并创建 `running` 整理任务，返回 `dreamId`、提示词、输出 schema 与 `recommendedSubagentModel`（支持可选 `model` 标记整理所用子代理档位）。 |
| `memory_dream_commit` | 两阶段片段整理（第 2 步）：整批校验并提交整理提案至 `pending`，收尾整理任务并将引用片段标为 `processed`、空输出或未引用片段标为 `skipped`。 |
| `memory_organize_prepare` | 两阶段全库整理（第 1 步）：选取当前作用域最多 60 条 `active` 记忆，创建 `organize` 整理任务并返回 `recommendedSubagentModel`。 |
| `memory_organize_commit` | 两阶段全库整理（第 2 步）：校验非空且归属当前作用域的 `supersedes` 引用，将合并/替换提案写入 `pending`。 |

### 敏感管理工具（8 个）

以下 8 个工具涉及人工审阅、永久删除、导入覆盖、全量重建或安全策略变更，**每次调用均由 `PreToolUse` Hook 返回 `decision: "force_ask"` 强制弹窗确认**：

| 工具名 | 职责与安全红线 |
| --- | --- |
| `memory_review` | 批准（`accept`，可选先修改标题/正文）或拒绝（`reject`）`pending` 提案；批准时先逐条归档 `supersedes` 旧条目再激活新条目，并将 `ownership` 升级为 `user`。 |
| `memory_restore` | 将 `archived` 记忆恢复为 `active`（升级 `ownership='user'`）。 |
| `memory_delete` | 永久物理删除记忆并清除历史快照正文（需提供 `id` 与 `expectedContentRevision`）。 |
| `memory_undo_dream` | 按 `dreamId` 撤销该次整理变更（校验 `contentRevision`，跳过已被用户后续编辑的条目）。 |
| `memory_import` | 导入 DSH/AGY 兼容 JSON（`merge` 或 `replace`）；相对 `inputPath` 基于当前工作区根目录解析，`replace` 模式在确认提示中醒目标注清空当前作用域的风险。 |
| `memory_rebuild` | 仅清除并重建 `ownership='derived'` 派生数据，保护 `ownership='user'` 用户记忆不被删除。 |
| `memory_purge` | 永久清空指定作用域或全部记忆（确认提示中明示不可逆警告）。 |
| `memory_config` | 更新 `${PLUGIN_DATA}/config.json` 中 24 项 AGY 适用运行配置（含 `dreamSubagentModel`）并即时热生效；关闭 `redactSecrets`、开启 `autoAcceptProposals` 或开启 `injectForSubagents` 时，在确认提示中特别高亮风险。 |

### `PreToolUse` 确认门禁（Fail-Closed）

- Hook 同时兼容直接工具名与包装形态工具调用（如通过通用 MCP 调用包装器触发；包装形态下会校验 `ServerName` 属于本插件记忆服务，避免误拦截其他 MCP 插件同名工具）。
- 命中 8 个敏感工具，或 `memory_list` / `memory_export` 携带 `scope: 'all'`、跨工作区 `workspaceRoot`、`outputPath` 时，生成清晰的中文操作摘要并返回 `{ "decision": "force_ask", "reason": "..." }`，确保模型无法静默自批或误删。
- 若敏感门禁解析参数时发生异常，遵循安全默认（fail-closed）返回 `force_ask`，绝不静默放行。

---

## Hooks 生命周期

### `PreInvocation`：低延迟索引注入

- 更新 `${PLUGIN_DATA}/sessions/<conversationId>.json` 中的工作区锚点。
- **快速跳过路径**：若当前会话已注入相同 `scopeKey` 的基线且 `refreshIndexOnChange=false`（默认），Hook **直接返回 `{}`，不加载 `memory.json`**，避免拖慢后续每轮调用。
- **基线注入**：首次触发或工作区切换时，提取纯用户请求执行本地 BM25 查询，在 `indexMaxBytes`（默认 4096）预算内组合全局偏好（最多 5 条）、高重要度工作区规则（最多 3 条）、相关候选（最多 5 条）与最近工作（日汇总优先，不足 3 条由近 7 天 `worklog(turn)` 标题与日期兜底，最多 3 条），经 `<system-reminder>` 转义后通过 `injectSteps` 注入。
- **可选增量刷新**：开启 `refreshIndexOnChange=true` 后，按 `refreshMinIntervalMs`（默认 60 秒）、`refreshMaxBytes`（2048）与 `refreshResetBytes`（8192）预算计算差异并注入 `delta` 或 `reset`。
- 遇到锁超时或读写故障时记录脱敏日志并优雅降级返回 `{}`（fail-open），不阻断正常对话。

### `Stop`：白名单增量捕获

- 始终返回 `{}`（绝不返回 `continue` 阻塞对话结束）。
- 依据 `session_cursors` 表中的 `step_index` 游标，增量读取 AGY 会话日志 `transcript.jsonl` 的新增步骤；跨多轮的增量按 `USER_INPUT` 边界顺序切分，并借助会话缓存跨短进程保留纠错判定所需的上轮助手摘要。
- **白名单与脱敏**：仅提取 `<USER_REQUEST>` 内部纯用户文本、助手公开结论摘要、映射后的工具白名单元信息及同序 `GENERIC` 步骤的 `status` 与最多前 2 行错误头部摘要（用于识别 `tool-failure` / `tool-recovery`），**绝不读取或保存 `thinking` 文本、完整命令标准输出或文件内容正文**。
- 满足条件且非子代理且 `worklogCapture='significant'` 时生成确定性 `worklog(turn)`；检测到用户明确口头“记住/以后都…”（排除“不要记住”等否定句）且同轮未通过记忆写入工具保存时，直接生成 `active` 记忆（`origin='system'`、`ownership='user'`）并去重。
- 遇到损坏 JSONL 行会跳过并推进游标；遇到锁超时或路径缺失时写脱敏诊断日志并安全返回 `{}`。

---

## 两阶段整理与审阅工作流

由于 AGY 插件进程不直接调用宿主内置 LLM，也不要求配置外部 API Key，整理工作流通过 **两阶段 MCP 工具 + 内置 Skills** 由当前 AGY 代理协作完成：

### 1. 两阶段片段整理（Dreaming）与原生自动做梦（`autoDream`）

配合 `memory-dream` Skill 执行：

1. **子代理模型档位选择**：配置项 `dreamSubagentModel`（默认 `"flash"`，可选 `"flash_lite"` / `"flash"` / `"pro"` / `"inherit"`）决定主代理派生后台整理子代理时建议传入的 `Model` 档位，避免无谓占用主模型额度或阻塞主会话。
2. **原生 `autoDream` 联动**：开启 `autoDream: true` 后，当 `Stop` Hook 捕获到新片段时会在会话状态记录待整理标志；满足 `autoDreamMinIntervalMs` 冷却时间后，下次 `PreInvocation` 会注入 `[Memloom autoDream]` 系统提醒，引导主代理使用 `dreamSubagentModel` 派生后台子代理执行下列两阶段整理。
3. **准备阶段（`memory_dream_prepare`）**：按 `dreamMaxEpisodes` 与 `dreamLookbackDays` 认领待处理 `episodes`（标记 `processing`），创建 `DreamRun(status='running')`，返回 `dreamId`、整理提示词、JSON 输出 schema 与 `recommendedSubagentModel`。
4. **提炼阶段**：代理依据高门槛证据规则提炼结构化提案；若本批片段仅含常规过程、瞬时报错、已取消轮次或重复内容，应直接提交空提案数组（`memories: []`），此时任务正常完成并将认领的 `episodes` 标为 `skipped`，防止重复认领死循环。
5. **提交阶段（`memory_dream_commit`）**：先整批校验结构、长度与强密钥特征——任一条不合法则整批拒写并保持 `DreamRun` 为 `running`，便于修正后原地重试；校验通过后经去重与操作日志状态机全部以 `pending`（`ownership='derived'`、`origin='dream'`）入库。

进行中的两阶段 `running` 整理不会被常规崩溃恢复误杀；仅当持续时间超过 `dreamProcessingTimeoutMs`（默认 10 分钟）时，才由超时回收标记为 `failed` 并将仍为 `processing` 的 `episodes` 退回可重试状态。

### 2. 两阶段全库整理（Organize）

同样可由 `memory-dream` Skill 引导执行：

1. **准备阶段（`memory_organize_prepare`）**：读取当前作用域最多 60 条 `active` 记忆，创建 `DreamRun(trigger='organize', status='running')`。
2. **提交阶段（`memory_organize_commit`）**：强制校验每条提案的 `supersedes` 非空且全部为当前作用域真实存在的 `active` 记忆 ID；产物一律写入 `pending`，绝不直接覆盖或删除现有 `active` 记录。

### 3. 人工审阅（`memory-review`）

通过 `memory-review` Skill 获取 `pending` 提案详情（`memory_list` 传入 `status: "pending"` 已包含完整标题、正文、标签、重要度、`supersedes` 与来源引用；按 ID 单独读取待审条目时传入 `memory_read` 的 `includeNonActive: true`）并对比被替代的旧记忆，确认后调用 `memory_review`（经 `PreToolUse` `force_ask` 弹窗确认）执行批准、修改后批准或拒绝；必要时也可调用 `memory_undo_dream` 按 `dreamId` 撤销整批整理变更。

---

## 与 DSH 跨宿主互通

- **数据格式兼容**：AGY 与 DSH 共用同一套 6 张表 schema、记录字段与导入/导出 JSON 格式。
- **默认隔离存储**：DSH 默认写入 `$DSH_HOME/storages/memory.json`，AGY 默认写入 `${PLUGIN_DATA}/memory.json`。**默认不建议让两个宿主同时指向同一份在线磁盘文件**，以避免 DSH 单进程存储域与 AGY 多进程文件锁产生覆盖冲突。
- **无损迁移方式**：在源宿主执行 JSON 导出（DSH 在 Settings → Memory 导出；AGY 调用 `memory_export`），再到目标宿主按工作区路径映射执行 `merge` 或 `replace` 导入（AGY 通过 `memory_import` 完成，并经 `force_ask` 确认）。

---

## 已知限制

- **暂无 MCP App 图形界面**：当前版本不提供可视化管理页面，所有浏览、审阅、导入导出与配置修改均通过分级 MCP 工具与内置 Skills 在对话中完成。
- **无内置外部 LLM 后台自动 Dream 守护线程**：插件不在 AGY 会话之外维护独立后台定时器或外部模型客户端；`autoDream: true` 通过 `Stop` + `PreInvocation` 提醒主代理在会话内派生指定 `dreamSubagentModel` 档位的后台子代理完成整理，如需按固定时间表在空闲时定期整理，也可结合 AGY 原生 `/automation` 按计划触发 `memory-dream` Skill。
- **子代理识别保守限制**：当 AGY Hook 事件载荷未提供显式子代理层级字段时，插件仅依据已知上下文特征保守判断；无法确认时默认按主会话处理。
- **与核心一致的边界**：检索采用本地 BM25（无外部向量数据库或 Embedding 服务），数据默认本地保存（无云端账户与跨设备同步）。
