# 配置参考

memloom 的全部可调项都在 `src/host/config.ts` 的 `Config` schema 中定义，并由 `resolveMemoryConfig()` 解析：用户 patch 未提供的字段使用下列默认值，显式提供的值优先；未知字段会被拒绝。本文与代码逐项对齐（0.1.0 开发版本）。

配置通常通过 DSH 插件 patch（`cordis.patch.yml`）或 Settings → Memory 的配置子页写入；普通字段保存后插件会重启。

## 默认值表

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用插件。 |
| `indexMaxBytes` | `4096` | 新会话记忆索引的字节预算，范围 1024–32768。 |
| `autoCaptureEpisodes` | `true` | 自动捕获 episode（不直接生成可检索知识）。 |
| `autoDream` | `false` | 是否自动调用模型整理；默认关闭，手动运行不受影响。 |
| `autoAcceptProposals` | `false` | 是否自动接受 dream / organize 生成的提案；默认关闭，自动生效条目保留 `ownership='derived'` 且可按运行批次撤销。 |
| `dreamIdleDelayMs` | `30000` | 自动 dream 的 turn/end 防抖延迟（毫秒，设置页按秒编辑）。 |
| `autoDreamMinIntervalMs` | `300000` | 每个工作区自动 dream 的最小间隔（毫秒，设置页按秒编辑）。 |
| `dreamModelMode` | `follow-session` | dream 模型选择：`follow-session` 或 `fixed`。 |
| `dreamProvider` | —（未设置） | `fixed` 模式使用的 provider；为空则退回默认模型。 |
| `dreamModel` | —（未设置） | `fixed` 模式使用的 model；为空则退回默认模型。 |
| `dreamReasoningEffort` | —（未设置） | 可选，覆盖思考强度。 |
| `dreamSubagentModel` | `flash` | AGY 两阶段整理与原生 `autoDream` 派生后台子代理时建议使用的 Model 档位（`flash_lite` / `flash` / `pro` / `inherit`）。 |
| `dreamMaxEpisodes` | `40` | 单次 dream 最多处理的 episode 数。 |
| `dreamMaxSessionsPerRun` | `10` | 冷会话回填单次最多处理的会话数。 |
| `dreamMaxTokens` | `4096` | 单次 dream 输出的 token 上限。 |
| `dreamLookbackDays` | `7` | 冷会话回填的回看天数。 |
| `requestDedupeTtlMs` | `86400000` | 请求级去重 TTL（毫秒，约 24 小时）。 |
| `dreamProcessingTimeoutMs` | `600000` | 处理中 episode 的崩溃遗留超时（毫秒，10 分钟）。 |
| `refreshIndexOnChange` | `false` | 会话中记忆变化时是否增量刷新索引；默认关闭。 |
| `refreshMinIntervalMs` | `60000` | 非紧急索引增量的最小间隔（毫秒）。 |
| `refreshMaxBytes` | `2048` | 单条索引增量的字节预算。 |
| `refreshResetBytes` | `8192` | 同一基线周期累计增量达到后改用完整 reset 的字节阈值。 |
| `worklogCapture` | `significant` | worklog 捕获策略：`significant` 只在有文件变更、交付、用户纠正或明确完成结果时生成 `worklog(turn)`（子代理不生成）；`off` 同时停止 `worklog(turn)` 捕获与 Dream 阶段产出 `worklog` 提案。 |
| `worklogRetentionDays` | `90` | `worklog(turn)` 保留天数，到期转 `archived`。 |
| `episodeRetentionDays` | `30` | 已处理 episode 保留天数，之后物理删除。 |
| `maxActiveMemories` | `5000` | `active` 条目上限；溢出时只自动归档未审阅的 `derived` 记录，用户拥有或 pinned 的记录受保护，容量不足时拒绝新增。 |
| `maxArchivedMemories` | `20000` | `archived` 冷存储上限；达到后拒绝新增、恢复与接受提案（`MEMORY_CAPACITY`），自动 dream 的写入失败并按 dream 失败策略处理。 |
| `maxStoredMemories` | `25000` | `active + archived + pending` 的硬上限。 |
| `maxQueuedEpisodes` | `5000` | `new` / `failed-retryable` episode 的硬上限；达到后新捕获被丢弃并输出限流告警。 |
| `maxAuditRecords` | `20000` | 审计记录上限；只裁剪 30 天以前的 `applied` 记录，保留最近的 undo 窗口。 |
| `maxOperationRecords` | `10000` | 已完成 operation 记录上限；未完成操作永不清理。 |
| `archivePurgePolicy` | `manual` | 归档物理删除策略：`manual` / `after-export` / `age`。`after-export` 在一次成功导出后清理由该次导出覆盖的 scope 内归档记录（pinned 除外）。 |
| `archiveRetentionDays` | `365` | `age` 策略下归档保留天数。 |
| `rebuildLookbackDays` | `90` | `rebuild` 重置派生数据后重放冷会话的回看天数（`since` 可覆盖）。 |
| `injectForSubagents` | `false` | 是否向子代理注入固定记忆索引。 |
| `redactSecrets` | `true` | 显式写入、dream 输出与导入在持久化前执行秘密脱敏；捕获与 worklog 文本始终脱敏。 |
| `searchLimit` | `20` | 默认搜索结果上限。 |

## 关键默认值

- `autoDream` 默认 `false`：默认不自动调用模型整理。
- `refreshIndexOnChange` 默认 `false`：新会话只注入一次索引。
- `autoCaptureEpisodes` 默认 `true`：自动捕获 episode，但普通片段不直接成为可检索知识。
- `indexMaxBytes` 默认 `4096`：控制首次记忆索引的大小。

以上默认值与 `src/host/config.ts`、`src/core/config.ts` 保持一致；改动源码默认值时，必须同步更新本文与 README。

- `dreamSubagentModel` 默认 `flash`：控制 AGY 端 `memory-dream` 与原生 `autoDream` 派生后台子代理的模型档位（可选 `flash_lite` / `flash` / `pro` / `inherit`）。
- 失败分类、退避与自动 dream 暂停状态只保存在 DSH 进程内，进程重启后重置。
