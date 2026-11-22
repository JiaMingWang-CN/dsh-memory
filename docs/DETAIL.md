# dsh-memory 插件详情

dsh-memory 是一个深度适配 DSH 的原生长期记忆插件，为 DSH 提供可安装、可审阅、可遗忘的长期记忆能力。本页描述 0.1.0 开发版本已实现并验证的行为。

## 功能

- **四类记忆**：`lesson`、`worklog`、`wiki`、`preference`，以工作区为主、仅 `preference` 可进入全局层。
- **结构化存储与审计**：记忆领域六表存储、`contentRevision` 乐观并发、结构化审计、操作日志与崩溃恢复、容量与保留、秘密脱敏、导出/导入、`rebuild` 与 `PURGE`。
- **本地检索**：内建分词器（拉丁词 + 中文 unigram/bigram）与 BM25 索引，只检索 `active`、未过期、当前工作区或全局 `preference` 的记录。同等相关度下按类型加权：`preference` > `lesson`/`wiki` > `worklog`，避免流水账压过长期规则。
- **六个显式模型工具**：`memory_search`（命中只递增 `matchCount`）、`memory_read`（读取正文才递增 `useCount`）、`memory_write`（持久化前脱敏，`scope='global'` 仅允许 `preference`；同 scope + type + 规范化标题的 active 记录视为同一条，返回已有记录并标记 `duplicate`；创建时自动记录调用会话作为 `sourceRefs`，更新时保留原来源；工具描述内含“只写环境给不回来的持久知识、不写一次性进展/代码/配置、先搜索再更新”的写入准则）、`memory_forget`（仅软遗忘）、`memory_dream`（手动整理 episode 队列）、`memory_organize`（手动整理已有 active 记忆）。
- **新会话索引注入**：新会话首次请求注入一份可回放的小型记忆索引；`refreshIndexOnChange=true` 时按基线 + `add` / `replace` / `remove` / `reset` 差异协议刷新。
- **Episode 捕获**：字段白名单 + 先脱敏后持久化；满足条件的完成 turn 确定性生成 `worklog(turn)`。子代理 turn 仍写 episode，但不生成 `worklog(turn)`；`error` turn 额外保存脱敏后的 `failureCode` / `failureMessage`。
- **口头记住**：用户消息含“记住/以后都/不要忘记”等明确要求、且模型没有在本 turn 调用 `memory_write` 时，直接生成一条 `active` 记忆（含“以后/总是/习惯/偏好”等词为 `preference`，否则为 `lesson`；`origin='system'`、`ownership='user'`）；同标题 active 记录已存在时复用，否定句（“不要记住…”）不写入。
- **worklog 质量**：标题优先取助手结论的第一句有效内容，其次取用户请求第一行；问句与明显低信息片段不会成为标题，最长 80 字符；标题仍可能偏短，需人工审阅。正文按结论优先分配 4096 字节：`## Result` 最多 2048 字节且不会被长请求挤掉，`## Request` 最多 1024 字节，文件清单与工具失败使用剩余预算，截断段落带 `…[truncated]` 标记。
- **写入卫生**：显式 `memory_write` 仅在正文没有真实换行、包含至少 3 个字面量 `\n`、至少 2 个 `## ` 标题，且不含盘符路径、代码围栏或其余反斜杠上下文时，才把字面量 `\n` 还原为真实换行；不满足时原样保留。命中私钥、常见 API key 或 token 等强密钥特征时拒绝写入，并提示记录凭据的配置位置。
- **Dreaming 整理**：从 episode 队列取批，按 `follow-session` 或 `fixed` 选择模型，严格校验 JSON；相关记忆按这批 episode 的 BM25 相关度选取（最多 20 条，带 id 与 importance），`lesson` / `wiki` / `worklog(daily)` 产物一律 `pending`。
- **全库整理（organize）**：`memory_organize` 或 `/memory organize` 读取当前作用域最多 60 条 active 记忆，让模型输出合并/替换提案；每条提案必须用 `supersedes` 引用被替换的记忆 id，产物一律 `pending`。接受提案时先归档其 `supersedes` 中所有 active 记录（每条归档独立审计），再激活新记录；`supersedes` 为空的状态非法。
- **Dream 启动恢复与失败处理**：启动时重新调度持久化的 `queued` dream，并将中断的 `running` dream 终结为失败、释放已领取的 episode；`autoDream=true` 时启动还对最近 7 天冷会话做一次对账。失败分类按 `fatal` / `transient` / `other` 处理：fatal 立即暂停自动 dream，transient 采用 60 秒、180 秒退避并在连续三次后暂停，other 在单个 episode 连续三次失败后标记 `skipped`。
- **Dream 健康检查与证据规则**：每次需要调用模型的 dream 前在本地计算待处理 episode、重复工具失败、待审阅提案、重复标题与缺失日汇总；模型只依据 episode 事实，区分用户陈述与未验证断言，一条记忆只讲一个主题，只记录环境给不回来的经验，不写代码、文件内容、配置值、git 历史或命令输出。
- **索引兜底**：最近工作优先取 active `worklog(daily)`；不足 3 条时使用当前工作区内最近 7 天创建的 active `worklog(turn)` 补足，最多 3 条，只取标题与日期，不注入正文摘要；归档、过期与其他工作区记录不进入。
- **Settings → Memory 管理页与审阅**：采用顶部 4 个 Tab 分区（`记忆库`、`待审阅`、`导入与导出`、`设置`），顶栏提供固定操作按钮、可点击统计概览与索引容量进度条；`记忆库` 支持服务端关键词搜索（标题/正文/标签）、类型与状态分片筛选、用户标签展示与条件分页；详情/编辑/新建统一采用居中 Modal 弹窗（去重标题、固定底栏、标签胶囊、重要度滑块、正文与来源会话复制、内置未保存确认条），已归档记录仅提供恢复并隐藏归档按钮；`待审阅` 集中展示最近 Dream 运行详情（模型、片段数、产出计数、取消/撤销）与提案队列，提案弹窗支持行级 Diff / 并排 / 仅看提案对比、上一条/下一条连续审阅及「保存并接受」闭环；`导入与导出` 拆分为独立导出卡与拖拽/预览导入卡（支持逐工作区映射与结果报告）；`设置` 按 4 组横排呈现（空闲等待与自动整理最小间隔均使用秒单位、索引上限带 KB 换算、提供默认关闭且需二次确认的「自动接受提案」开关、未保存变更提示与放弃修改），文案支持 zh/en。默认工作区优先取上次显式选择，其次最近活跃会话的工作区（当前项目），最后才用注册表最近更新的工作区。
- **记忆用量小字**：`memoryUsage` 只读 projection 在回答下方的助手动作行（用量/时间旁）以一行小字仅显示非零的本会话累计注入/写入/搜索计数；记忆工具沿用 DSH 原生工具调用行，不注入自定义 `tool.call.toolview` 卡片。
- **命令与撤销**：`/memory status | search | dream | organize | forget | export`；管理页的 dream 状态卡片可按运行批次撤销，跳过用户后续编辑过或仅统计变化的记录。`/memory export` 只返回导出摘要，完整 JSON 导出在管理页完成。

## 使用

1. **写入**：让 Agent 调用 `memory_write`，或在 Settings → Memory 新建/编辑一条记忆。显式写入直接 `active`。用户在对话里明确说“记住/以后都…”而模型没有调用工具时，也会直接生成一条 `active` 记忆（偏好类为 `preference`，否则 `lesson`）。
2. **召回**：新会话第一次请求会自动注入小型索引；需要细节时 Agent 用 `memory_search` 搜索摘要，再用 `memory_read` 读取正文与来源。
3. **整理**：运行 `/memory dream` 或 Settings → Memory 的 `Dream now`；手动 dream 可处理当前工作区中 `status` 为 `new`、`failed-retryable` 或 `skipped` 的 episode，`since` 只按创建时间过滤。已有记忆的重复/冲突用 `/memory organize` 或 `memory_organize`：它读取当前作用域最多 60 条 active 记忆，产出合并/替换提案（`pending`），每条必须 `supersedes` 被替换的 id。
4. **审阅**：整理产出的 `lesson` / `wiki` / `worklog(daily)` 进入 `pending`；在 Settings → Memory 的待审阅中接受、拒绝或修改后接受，接受后转为 `active` 且所有权归用户。
5. **遗忘与导出**：用 `memory_forget` 或管理页归档，之后可从管理页恢复；管理页导出完整 JSON，导入时逐工作区映射后按 scope 合并或替换。`/memory export` 只返回导出摘要，不写文件。
6. **配置**：在 Settings → Memory 配置子页调整自动整理、索引预算、模型、保留与脱敏；完整默认值见 `docs/configuration.md`。

## 限制

- **默认不自动 dream**：`autoDream=false`，默认不调用 LLM 整理；`autoCaptureEpisodes=true` 只生成 episode 与条件 `worklog(turn)`，不直接生成可检索知识。即使开启自动 dream，产物仍需人工审阅。
- **暂停状态进程内有效**：dream 的失败退避与自动暂停只保存在当前进程，重启后重置；冷会话启动对账只在 `autoDream=true` 时执行。
- **Dream 输入有限**：每次 dream 是一次模型调用，只读取脱敏后的 episode 摘要，相关记忆按这批 episode 的 BM25 相关度最多取 20 条；organize 只读取当前作用域最多 60 条 active 记忆的标题与 512 字节正文；两者都不读取会话转录原文，也不提供转录检索工具。
- **保留在运行中执行**：启动时执行一次 retention，服务运行期间每 6 小时再执行一次；`worklog(turn)` 超过 `worklogRetentionDays` 转归档，`processed` episode 超过 `episodeRetentionDays` 物理删除，`new` / `failed-retryable` episode 不按天数清理。
- **episode 队列满会告警**：达到 `maxQueuedEpisodes` 后新捕获被丢弃（不写入），并向日志输出限流告警，不静默丢弃。
- **active 溢出只归档派生记录**：`maxActiveMemories` 满时优先归档 importance 最低的非 pinned `derived` 记录，importance 相同再按 `updatedAt` 从旧到新；用户拥有或 pinned 的记录不会被自动归档，此时新增、恢复或接受提案会被拒绝并返回 `MEMORY_CAPACITY`。
- **Dream 产物待人工审阅**：所有 dream 生成的 `lesson` / `wiki` / `worklog(daily)` 一律 `pending`，不会自动转为 `active`，也不进入检索与索引；organize 的提案同样如此。
- **索引默认只注入一次**：`refreshIndexOnChange=false`，会话中记忆变化不追加消息，需由模型用 `memory_search` 按需获取；开启后也只在下一次真实 pre-step 合入，不主动唤醒 Agent。
- **无向量检索**：检索使用本地 BM25 + 过滤，不使用外部 embedding 或向量数据库，不做语义相似度搜索。
- **无跨设备同步**：数据默认只在本机 `$DSH_HOME`，没有云端账户或跨设备同步。
- **工作区隔离**：记忆按规范化 `workspaceKey` 过滤，默认只显示当前工作区与全局偏好；只有显式切换到“所有可访问工作区”才展示其他工作区。
- **破坏性操作需确认**：永久删除、`Purge all`、全量 `rebuild`、导入 `replace`、扩大作用域与关闭安全保护，仍需用户明确确认；替换导入要求文件中的每个工作区都有映射，缺失时整次替换被拒绝；`rebuild` 删除派生记录并重置 episode/游标，随后在会话历史可用时重放最近 `rebuildLookbackDays` 天的会话，不保证恢复用户拥有的记忆。
- **开发版本与分发渠道**：0.1.0 为 0.x 开发版本，仅以 GitHub 插件形式通过 GitHub Releases 分发，不发布 npm 包。

## 数据与隐私

- 数据默认只写入本机 `$DSH_HOME`，不上传。
- 捕获使用字段白名单，先脱敏后持久化；捕获与 worklog 文本始终脱敏，`redactSecrets=false` 只关闭显式写入、dream 与导入的脱敏。不记录密钥与凭据，导入文本在持久化前统一脱敏。
- 记忆内容按不可信内容处理；会话日志是会话事实的唯一来源，记忆是派生知识库。

## 兼容性

- 基线：DSH `0.2.2-rc.5`（`engines.dsh: ^0.2.2-rc.5`），Node.js `>=24.9.0`。
