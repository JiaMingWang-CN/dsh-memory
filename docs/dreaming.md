# Dreaming

Dreaming 是 memloom 的离线记忆整理引擎，输入是 `episodes` 队列和（可选）最近的冷会话，输出是 `pending` 记忆或 wiki 更新。0.1.0 的 dreaming 仍是单次模型调用、无工具调用、不读取会话转录原文；本文描述已实现的触发方式、启动恢复、失败处理、prompt 规则、pending 语义、`proposalKey` 去重与撤销。

## 触发方式

- **手动**：`/memory dream` 命令或 `memory_dream` 工具，立即入队并返回 dream id；可处理当前工作区中 `status` 为 `new`、`failed-retryable` 或 `skipped` 的 episode，`since` 可选，且只按 episode 创建时间过滤（`createdAt >= since`）。
- **自动（代码存在，默认关闭）**：只有当用户显式设置 `autoDream = true` 时才启用。在 DSH 中，`turn/end` 后 `dreamIdleDelayMs`（默认 30 秒）防抖，期间有新 `turn/start` 则取消并重新计时；每个工作区额外受 `autoDreamMinIntervalMs`（默认 5 分钟）限制；队列全局并发 1。在 AGY 中，`Stop` 捕获到新片段后标记待整理状态，并在满足 `autoDreamMinIntervalMs` 后于下次 `PreInvocation` 注入提醒，由主代理按 `dreamSubagentModel`（默认 `flash`）派生后台子代理执行两阶段整理。
- **冷会话回填（随 autoDream 开启）**：`sessionCursors` 按 `sessionId` 记录 `lastProcessedSeq`，只扫描最近 `dreamLookbackDays`（默认 7 天）内、属于本工作区的会话，从游标之后读取以避免重复提炼，每次最多 `dreamMaxSessionsPerRun`（默认 10）个会话。

无论手动还是自动，Dreaming 生成的提案默认先进入 `pending`，等待人工审阅（除非用户显式开启 `autoAcceptProposals`）。

## 整理已有记忆（organize）

`/memory organize` 或 `memory_organize` 是独立于 episode 队列的手动整理：它读取当前作用域（工作区 + 全局 `preference`）最多 60 条 active 记忆，按 importance 降序、同 importance 按更新时间升序选取，把 id、类型、作用域、importance、标题与最多 512 字节正文送进模型。

- 模型输出仍为 `{"memories":[...]}`；每条必须带非空 `supersedes`，引用本次输入中真实存在的记忆 id；`sourceEpisodeIds` 可为空。
- 产物一律 `pending`、`origin='dream'`、`ownership='derived'`；`proposalKey` 仍按 type、scope、规范化标题、正文 hash 与排序后的来源计算（来源为空）。
- 接受一条 organize 提案时，服务端先把它 `supersedes` 中所有仍为 active 的记录逐条归档（每条走独立的 `memory.archive` 操作并留审计），再在 `memory.accept` 中激活新记录；不会出现两条 active。
- 被归档的旧记录不属于 dream run 的撤销范围（归档以用户身份记录），需要恢复时用管理页 Restore。
- 作用域内没有 active 记忆时，organize 直接以 `completed` 结束、不调用模型。

## 启动恢复与冷会话对账

- 服务启动时先打开存储并完成 `operations.recover()`；该步骤失败会使服务不 ready。随后执行 dreamer 的 `failInterruptedRuns()` 与 `resumeQueued()`，这两个恢复步骤失败只记录警告，不阻断服务 ready；最后才构建检索索引与注册工具。
- **`queued` dream 恢复**：持久化的 `queued` dream 会按原 dream id 重新排队，不新建 dream；排序上手动请求优先于自动请求，自动请求优先于 rebuild；已在调度队列中的 id 会跳过，因此重复调用恢复不会生成重复 dream 或重复提案。该恢复不受 `autoDream` 影响，显式排队的手动 dream 在默认关闭自动整理时也会恢复。
- **运行中断处理**：没有留下可恢复 operation 的 `running` dream 会被标记为 `failed`，错误信息说明运行被重启中断；其名下仍为 `processing` 的 episode 会回到 `failed-retryable`，`attempts` 加 1。
- **冷会话启动对账**：仅当 `autoDream = true` 且冷会话数据源可用时执行。启动会列出会话并按规范化工作区分组，只处理 `createdAt` 在最近 `dreamLookbackDays`（默认 7 天）内的冷会话，逐个工作区串行回填，避免并发写同一存储域；某工作区失败只记录警告，不影响其他工作区。对账异步执行，不阻塞插件加载。`autoDream = false` 时启动既不读取冷会话，也不因冷回填调用 LLM。
- `sessionCursors` 只在对应 dream `completed` 后推进；`failed` / `cancelled` 不推进，避免下次启动跳过未整理的内容。

## 失败分类、退避与暂停

Dream 失败会先归入 `fatal` / `transient` / `other` 三类，再决定重试与暂停策略：

- **`fatal`**：401 / 402 / 403、鉴权失败、无效或缺失凭据、额度与计费不足等。自动 dream 立即暂停，后续自动触发不再入队；手动 dream 仍可执行。错误信息会写成可读原因并脱敏。
- **`transient`**：408 / 425 / 429 / 5xx、限流、超时、网络连接失败、`fetch failed`、服务暂时不可用等。连续第 1 次失败后至少等待 60 秒，第 2 次后至少等待 180 秒，第 3 次起暂停自动 dream；成功运行会清零连续计数并清除退避。
- **`other`**：模型输出不是合法 JSON、条目字段非法等无法归类的失败。episode 保持 `failed-retryable`，不会标为 `processed`；同一个 episode 连续 3 次 `other` 失败后会被标记 `skipped`，dream 错误信息包含 `skipped after 3 attempts`，后续自动 dream 不再领取该 episode；手动 dream 仍可通过 `since` 或重试策略重新纳入。
- **暂停状态**：fatal 失败或手动 dream 失败都会暂停自动 dream；手动 dream 成功会清除暂停与退避。失败计数、退避截止时间与暂停原因只保存在当前进程内，不写入 storage；**重启后暂停与退避状态重置**，自动 dream 从正常状态重新开始。该机制没有新增配置字段，也不修改 `autoDream` 用户配置。

## 模型模式

`dreamModelMode = 'follow-session' | 'fixed'`，默认 `follow-session`：

- **`follow-session`**：自动 dream 使用该工作区最近活跃会话的 `modelSelection` 投影（`next ?? lastUsed`）；会话已冷时读取其日志中最后一个 `model/selection` 事件；手动 dream 使用发起命令/工具的 agent 当前选择；无会话上下文时退回 `agentDefaultModel.currentSelection()`。
- **`fixed`**：使用配置的 `dreamProvider` + `dreamModel`；缺失时退回默认模型并在 dream 状态中记录警告。
- `dreamReasoningEffort` 可选；设置后在两种模式下都覆盖思考强度。未设置时，`follow-session` 沿用会话的 reasoningEffort，`fixed` 使用模型适配器默认值。

调用使用 `ctx.llm.stream({ provider, model, reasoningEffort, system, messages, maxTokens, signal })`，受 `dreamMaxTokens`（默认 4096）与 `dreamMaxEpisodes`（默认 40）限制；输出 JSON 校验失败时追加一次修复提示重试，仍失败则按上述失败分类处理，领取的 episode 回到 `failed-retryable`（连续 `other` 失败达到阈值时标记 `skipped`）。

## 健康检查、证据分级与记录原则

### 健康检查

每次需要调用模型的 dream 前都会在代码中机械计算当前作用域的健康状态，并把有问题的项渲染成英文短句放进 prompt 的 `## Health checks already computed` 段落：

- 待处理 episode 数（`new` + `failed-retryable`）；
- 相同 `toolName + toolError` 签名的重复工具失败数；
- 待审阅提案数；
- 与 active 或 pending 记录重复的规范化标题；
- 当前工作区是否缺少 active `worklog(daily)`。

健康检查还会统计各类型 active 记忆数量供内部检查使用，但只有上述有问题的项进入 prompt。健康检查只输出计数与标题，不读取或输出正文全文，也不改变 dream 输出的 JSON 结构。它只是提示模型优先处理积压与重复，不替代人工审阅。

### 证据分级

- 只使用提供的 episode 事实，不引入外部知识，不编造细节。
- 用户明确说过的内容视为证据，按“用户陈述”记录并引用提供该内容的 episode id；不因为没有工具输出佐证而降级。
- 助手没有工具结果或用户陈述支持的断言标为 `unverified`，或在正文中省略。
- 每条输出必须带至少一个 `sourceEpisodeIds`，引用实际提供的 episode，不得缩短 episode id。

### 记录与噪声过滤原则

- **捕获期过滤**：自动捕获阶段会跳过常见瞬时/通用工具失败（如 `UNKNOWN`、`UNKNOWN_TOOL`、`FS_NOT_FOUND`、`FS_EDIT_NOT_FOUND`、`SEARCH_FAILED`、`WEB_PROVIDER_ERROR`、`TIMEOUT` / `RATE_LIMIT` 等），以及未包含用户纠正的中止/取消轮次（`interrupted` / `cancelled` / `aborted`），避免低价值噪声进入 `episodes` 队列。
- **宁缺毋滥与空输出收敛**：当批次片段仅包含常规执行、一次性状态快照、未验证猜测或与现有记录重复的信息时，模型应直接返回空数组 `{"memories":[],"wikiUpdates":[]}`；空输出与本次未被任何提案引用的已认领片段会标记为 `skipped`（不再退回 `failed-retryable` 循环重跑）。
- **尊重 `worklogCapture: "off"`**：当关闭工作日志捕获时，Dream 系统提示词、输出 schema 与提交校验均会禁止输出 `worklog` 类型。
- **纳入已有 `pending` 去重上下文**：Assemble `## Related memories` 时同时纳入当前作用域的 `active` 与 `pending` 提案（标注 `|pending`），避免对未审阅队列中的同类主题重复提案。
- **一条一主题**：一条记忆只讲一个主题，混合主题时拆开。
- **记录持久规则**：记录长期有效的规则，而不是一次性事件。
- **只记环境给不回来的东西**：教训、做通的路子、验证过的规则、坑与进行中的计划值得记录；代码、文件内容、当前配置值、git 历史与命令输出不记录。
- 跳过工具定义已经写明的参数约束（必填参数、参数格式与返回结构）。
- 绝不写入 API key、token、密码或私钥等密钥，只记录凭据配置的位置。

## Pending 语义

- 所有 dreaming 生成的 `lesson` / `wiki` / `worklog(daily)` 一律 `status = 'pending'`、`ownership = 'derived'`、`origin = 'dream'`、`reviewedByUserAt` 为空；organize 的合并/替换提案同样如此。所有 dream 产物仍然 pending，不会自动 active。
- `pending` 不参与检索与索引，只在 Settings → Memory 的“待审阅”中可见。
- 用户在 Settings 审阅 Accept / Edit before accept 后才转为 `active`，同时 `ownership` 转为 `user` 并写入 `reviewedByUserAt`。
- 高置信度不等于事实：模型不会因为“很有把握”而绕过审阅，`confidence` 不作为自动置为 `active` 的依据。
- 例外：`worklog(turn)` 是确定性写入，不调用 LLM，即使 `autoDream = false` 也按条件生成。

## proposalKey 与重复提案

- 服务端为每条 dream 输出计算稳定 `proposalKey = sha256(type | scope | normalizedTitle | contentHash | sorted(sourceEpisodeIds))`，写入 `MemoryRecord.proposalKey`。
- **完全重复**：任何状态（`pending` / `active` / `archived`）命中同一 `proposalKey` 时跳过创建，并把对应 episode 标记 `processed`。
- **换措辞的重复提案**：`proposalKey` 只识别完全重复。对同 scope + type + 规范化标题且 `sourceEpisodeIds` 有交集的输出，不新建 pending：已有 pending 则把新正文、来源与 confidence 作为该 pending 的新候选版本（经 `memory.update` 留审计）；已有 active / archived 则只保留现有记录并记录“重复提案已跳过”，不静默覆盖。
- **普通归并**：内容 hash 相同直接跳过；高相似度（Jaccard ≥ 0.85）按既有规则合并；`wiki` 按标题 upsert。

## 撤销

- dream 产生的每个变更都写入审计表，审计保留变更前/后的结构化快照，并按 dream run 归组。
- Settings 页可按 dream run 撤销（`dream.undo`），管理页的最近运行动作卡直接调用 `memory/undoDream`。撤销只回滚该 run 产生的变更；若某条记忆在 run 之后被用户手工编辑过（`contentRevision` 已变化），跳过该条并报告“已被后续编辑，未回滚”。
- 统计字段（`matchCount` / `useCount`）的变化不会阻止撤销。
- 部分撤销如实报告“已撤销 N 条、跳过 M 条”，不假装全部成功。

## 当前限制

- 每次 dream 仍是一次模型调用，只读取脱敏后的 episode 摘要（每条不超过 2KB）与最多 20 条相关记忆标题；不读取会话转录原文，也不提供转录检索工具。
- organize 每次最多读取 60 条 active 记忆（标题 + 512 字节正文），只产 `pending`；只整理当前作用域，不跨工作区合并。
- 最近工作索引最多 3 条：优先 dream 产出的 active `worklog(daily)`，不足时用最近 7 天内 active `worklog(turn)` 补足，只取标题与日期。
- `dreamMaxEpisodes`（默认 40）、`dreamMaxTokens`（默认 4096）以及 episode 摘要预算与相关记忆条数都是默认预算；健康检查与证据分级不会扩大这些预算。
- 自动 dreaming 与冷会话回填默认关闭；即使开启，所有产物仍需人工审阅。
