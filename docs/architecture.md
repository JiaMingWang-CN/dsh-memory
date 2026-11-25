# 架构

memloom（原 `dsh-memory`）采用同仓共享内核的双宿主分层架构：由零宿主依赖的 `src/core/` 提供统一记忆引擎，分别由 `src/host/` + `src/client/` 构成 DSH bundle，并由 `src/agy/` 构成 Antigravity（AGY）原生插件。本文描述已实现并验证的内核分层、DSH Host/Client 分层、AGY 适配层、存储 schema、operations 状态机与索引注入协议。

## 双宿主分层架构（Core / DSH / AGY）

```text
src/
├── shared/   # 共享数据模型、zod schema 与基础类型（无宿主运行时绑定）
├── core/     # 宿主无关共享记忆内核（零 @deepseek-ai/* 依赖）
├── host/     # DSH Host 适配层（Cordis MemoryService、storageDomain、DSH 工具/命令/@Remote）
├── client/   # DSH React 管理面板（Settings → Memory）
└── agy/      # Antigravity（AGY）原生插件适配层（文件锁 JSON 存储、Stdio MCP Server、Hooks、Assets）
```

- **共享内核（`src/core/`）**：沉淀抽象存储契约（`storage-contract.ts`）、共享配置默认值与校验（`config.ts`）、`MemoryStore`、`OperationRunner` 状态机、本地 BM25 检索、纯索引组合与折叠协议（`indexing.ts` / `index-protocol.ts`）、脱敏与容量控制、审计、导入导出、提案去重、工作日志规则，以及宿主无关的 `MemoryEngine` 门面（含两阶段 Dreaming / Organize 状态机）。
- **DSH 适配层（`src/host/` + `src/client/`）**：复用 `src/core/` 与 DSH `storageDomain`、会话事件、模型运行时和管理页集成，对外导出接口与 `pnpm pack` DSH bundle 清单保持向后兼容。
- **AGY 适配层（`src/agy/`）**：复用 `src/core/`，以跨进程文件锁 JSON 存储（`${PLUGIN_DATA}/memory.json` + `.memory.lock` + 原子写入 + 读前变更重载）、零外部依赖 Stdio MCP Server（20 个分级工具）、统一 Hook CLI（`PreInvocation` / `Stop` / `PreToolUse`）与内置 Rules/Skills 构建为自包含目录 `dist/agy-plugin/`。详见 [`docs/agy.md`](agy.md)。
- **隔离边界**：ESLint 导入规则禁止 `src/shared/`、`src/core/` 与 `src/agy/` 引入 `@deepseek-ai/*`；`pnpm pack:check` 与 `pnpm pack:agy:check` 分别校验 DSH `.tgz` bundle 与 AGY `dist/agy-plugin/` 产物边界，避免相互混入。

## Host / Client 分层（DSH）

- **Host（`src/host`）**：以单一 `MemoryService`（`TypertRemoteService`，`super(ctx, 'memory')`）注册 `memory` 服务，对外提供 `ctx.memory`（Host 内）与 `ctx.remote.memory`（Client Remote）。Host 负责存储、检索、捕获、整理、注入、工具与命令。
- **Client（`src/client`）**：注册 `settings.section` 与 `settings.section.icon`（Settings → Memory 管理页与图标），并在 `conversation.chat.assistant-actions` 里以小字显示记忆用量；记忆工具不注册 `tool.call.toolview` 自定义卡片，沿用 DSH 原生工具调用行。Client 通过 `ctx.remote.memory.*` 读写，文案走 zh/en locale，样式只用主题 token。
- **存储**：Host 通过 `storageDomain` 打开 JSON KV 域持久化，默认路径 `$DSH_HOME/storages/memory.json`；Client 不直接接触存储。

Host 内部主要模块：

| 模块 | 职责 |
| --- | --- |
| `domain.ts` | Domain schema、类型与版本。 |
| `operations.ts` | 操作日志状态机、幂等键、启动恢复、中间状态。 |
| `service.ts` / `store.ts` | 领域打开/关闭、记录 CRUD、审计、串行化写队列。 |
| `search.ts` / `indexing.ts` | 分词、倒排索引、BM25、作用域过滤、match/use 统计分离。 |
| `capture.ts` / `worklog.ts` | 监听 `session/event` 与工具结果，生成 episode 与条件 `worklog(turn)`。 |
| `dreamer.ts` / `dream-scheduler.ts` | 队列、LLM 调用、JSON 解析、去重、pending 入库、自动触发调度；同时承载已有记忆的全库整理（`trigger='organize'`）。 |
| `inject.ts` / `index-refresh.ts` / `index-state.ts` | `agent/pre-step` 索引注入与基线 + 差异协议。 |
| `tools/*` / `command.ts` | 六个模型工具与 `/memory` 命令。 |
| `redact.ts` / `capacity.ts` | 秘密脱敏与容量、保留、清理。 |
| `projection.ts` | `memoryUsage` 只读 session projection。 |
| `remote-spec.ts`（`src/remote-spec.ts`） | 21 个 `@Remote` 方法契约，Host 与 Client 共用。 |
| `remote-errors.ts` | 把 `OperationError` 映射为 `memory/*` Remote 失败码。 |

## 存储 schema

Domain `memory`，`version: 1`，JSON 后端默认 `$DSH_HOME/storages/memory.json`。六张表：

- `memories`：`MemoryId -> MemoryRecord`
- `episodes`：`EpisodeId -> EpisodeRecord`
- `dreams`：`DreamId -> DreamRun`
- `audit`：`AuditId -> AuditRecord`
- `operations`：`OperationId -> OperationRecord`
- `session_cursors`：`SessionId -> SessionCursor`（设计中的 `sessionCursors`；存储域表名只允许小写与下划线）

`OperationRecord` 关键字段：`id`、可选的 `requestId` / `requestExpiresAt`（请求级去重）、`kind`（`memory.create` / `memory.update` / `memory.archive` / `memory.restore` / `memory.delete` / `memory.accept` / `memory.reject` / `dream.run` / `dream.undo` / `rebuild` / `import` / `purge`）、`status`（`planned` / `applying` / `committed` / `failed`）、`step` / `totalSteps` / `stepName`、`payload`、`before` / `after` 快照、`attempts`、时间戳与 `error`。

`AuditRecord` 关键字段：`id`、`operationId`、可选 `dreamId`、`action`、可选 `memoryId`、`actor`、`before` / `after` 快照、`status`（`applied` / `undone`）、可选 `undoOf` 与 `at`。

**没有跨表事务。** 所有多表变更都经 `operations` 做成可恢复状态机。

## operations 状态机

1. 先写 `operations`（`status='planned'`，含 payload、请求去重键与步骤信息）。
2. 更新为 `applying`，按固定顺序执行单表写入。
3. 全部写入完成后写 `audit`，最后更新为 `committed`。
4. 任一步失败：保留 `applying` 或标记 `failed`；启动时 `recover()` 重放 `planned` / `applying` 操作。
5. 重放使用 `operation.step` 与当前记录 `contentRevision` 判断：已完成的写入跳过；版本不匹配的标记 `failed` 并提示人工处理，绝不覆盖用户后续编辑。

固定写入顺序保证崩溃窗口不产生“新旧都 active”：

- **Accept dream proposal**：先逐条 `archive` 该提案 `supersedes` 中所有仍为 active 的旧条目（每条独立操作与审计），再激活新条目，最后写 audit。崩溃在中间 → 部分旧条目 archived、新 pending；恢复继续激活，绝不出现两条 active。
- **Create/update**：先写 `memories`，再写 `audit`。
- **Delete**：先写 `audit`（含 before 快照），再删除 `memories`，最后幂等清除本操作及历史操作中的正文快照。
- **Dream run**：先 `dreams(status='running')`，再逐条写 `pending` 记忆与 audit，最后 `dreams(status='completed')`。崩溃时 `dream.run` 是唯一“不续跑、只收尾”的例外：恢复把 `running` 标记 `failed`，已写 pending 保留，未写的不补写，`proposalKey` 阻止重复创建。
- **Rebuild/Purge/Import**：按 scope 先写 operation，再逐条处理，每条独立审计；整体失败不回滚已完成部分，UI 报告完成条数并要求重试。

幂等分三层：调用方 `requestId` 做请求去重（保留 `requestDedupeTtlMs`，默认 24 小时）；每次状态转换生成新的 `operationId`；单步靠 `operation.step` + `contentRevision` 判定。`contentRevision` 只随业务字段变化递增，`statsRevision` 只随统计字段变化递增，撤销与 CAS 只比较 `contentRevision`。工具调用把 `exec.callId` 作为 `requestId` 传入，因此同一次工具调用的重试会重放已提交结果；复用的 `requestId` 必须指向同一条记忆。

## Remote 失败码

Host 业务错误在 `attachRemoteMarkers` 之后由 `remote-errors.ts` 包装：`OperationError` 被转换为 Typert `RemoteError`，网关照原样传递 code、message 与 details，客户端据此本地化并识别并发编辑冲突。

| Remote code | 对应 `OperationError` |
| --- | --- |
| `memory/conflict` | `MEMORY_CONFLICT` |
| `memory/not-found` | `MEMORY_NOT_FOUND` |
| `memory/invalid` | `MEMORY_INVALID_CONTENT` / `MEMORY_INVALID_CONFIG` / `MEMORY_INVALID_QUERY` |
| `memory/forbidden` | `MEMORY_FORBIDDEN` / `MEMORY_FORBIDDEN_SCOPE` / `MEMORY_CONFIRM_REQUIRED` |
| `memory/capacity` | `MEMORY_CAPACITY` |
| `memory/unavailable` | `MEMORY_RECOVERING` / `MEMORY_STOPPED` / `MEMORY_UNAVAILABLE` |

`details.code` 保留原始 `OperationError` code；非业务异常仍折叠为 `gateway/internal`。

## 索引注入协议

`inject.ts` 监听 `agent/pre-step`：

- 子代理在 `delegationDepthOf(agent) > 0` 且 `injectForSubagents=false` 时跳过注入。
- 新会话首次注入一份 durable 基线；`refreshIndexOnChange=false`（默认）时后续不刷新。开启后，在每次即将产生模型请求的 pre-step 比较期望索引与可见状态，只注入差异；不主动唤醒 Agent，不调用 `followup()`。
- 计算 `scopeKey`（`ctx.workingDirectory.ensure(agent)` + Windows 大小写归一化），用第一条直接用户消息做 BM25 查询，组合高优先级规则（最多 5 条全局 preference + 3 条高重要度 lesson）、相关候选（最多 5 条）与最近日工作日志（最多 3 条）。
- 基线身份由 `scopeKey + protocolVersion + indexMaxBytes + 索引规则版本` 确定。
- 状态折叠：按时间顺序处理 session surface 与本轮 claimed 中 `source.kind='memloom'`（兼容旧会话 `'dsh-memory'`）的消息；`reset` 清空旧状态后写完整快照，`add` / `replace` 写对应 id 最新版本，`remove` 删除对应 id 并记录失效版本。未知协议、缺失基线或 scope 不一致时放弃折叠并 `reset`。
- 期望状态与折叠状态按 `memoryId + contentRevision + 渲染摘要 digest` 比较；统计字段与排序变化不产生注入。相关候选锚定基线时的第一条用户消息，不随每轮话题重算。

消息 source 结构（仅含恢复所需元数据，正文仍是模型可见的完整基线/差异/失效说明）：

```ts
type MemoryIndexChange =
  | { action: 'add' | 'replace'; memoryId: string; contentRevision: number; digest: string }
  | { action: 'remove'; memoryId: string; contentRevision: number }

interface MemoryIndexSource {
  kind: 'memloom' | 'dsh-memory'
  form: 'memory-index'
  mode: 'baseline' | 'delta' | 'reset'
  protocolVersion: 1
  baselineId: string
  scopeKey: string
  changes: MemoryIndexChange[]
  invalidations: { memoryId: string; contentRevision: number }[]
}
```

单条增量受 `refreshMaxBytes`（默认 2048）限制，失效通知优先；同一基线周期累计可见增量达到 `refreshResetBytes`（默认 8192）时改用完整 `reset`。`memoryUsage` projection 消费同一 source，不从正文猜测注入内容。
