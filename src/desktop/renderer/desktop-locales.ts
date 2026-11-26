/**
 * Desktop renderer bilingual dictionaries (`zh` / `en`) extending `src/client/locales.ts`,
 * plus unified error localization and IPC envelope unwrapping helpers.
 * @module memloom/desktop/renderer/desktop-locales
 */
import type { LocaleDict } from '../../client/context.ts'
import { errorText, remoteErrorCode } from '../../client/errors.ts'
import { en as baseEn, setTranslate, t, zh as baseZh } from '../../client/locales.ts'
import type { IpcError, IpcResult } from '../ipc-contract.ts'

export type DesktopLocale = 'zh' | 'en'

const desktopExtraZh: LocaleDict = {
  'desktop.brand': 'Memloom',
  'desktop.brandSub': '长期记忆工作台',
  'desktop.allClients': '全部客户端',
  'desktop.addClient': '+ 添加库',
  'desktop.refreshClients': '刷新所有库',
  'desktop.migrateQuick': '跨库迁移',
  'desktop.langToggle': '中 / EN',
  'desktop.themeLight': '亮色',
  'desktop.themeDark': '暗色',
  'desktop.themeSystem': '跟随系统',
  'desktop.themeSwitchToLight': '切换亮色',
  'desktop.themeSwitchToDark': '切换暗色',
  'desktop.clientManage': '管理库',
  'desktop.sidebar.overview': '总览',
  'desktop.sidebar.platforms': '平台与记忆库',
  'desktop.sidebar.platformListLabel': '平台与记忆库导航',
  'desktop.sidebar.storeCount': '{count} 个库',
  'desktop.sidebar.manageClient': '管理 {name}',

  'desktop.status.writable': '可写',
  'desktop.status.readonly': '只读',
  'desktop.status.forceUnlocked': '强制可写',
  'desktop.status.missing': '未初始化',
  'desktop.status.corrupted': '已损坏',
  'desktop.status.unreadable': '不可读',
  'desktop.status.disabled': '已停用',

  'desktop.kind.dsh': 'DSH',
  'desktop.kind.agy': 'AGY',
  'desktop.kind.custom': '自定义',

  'desktop.legacy.banner': '检测到旧版 dsh-memory AGY 记忆库：{path}',
  'desktop.legacy.quickAdd': '一键添加',
  'desktop.legacy.dismiss': '忽略',
  'desktop.legacy.defaultName': '旧版 dsh-memory',

  'desktop.guard.runningBanner': 'DSH 正在运行，已对受保护 DSH 库启用只读保护。写操作已禁用。',
  'desktop.guard.uncertainBanner': '未能确认 DSH 是否关闭，已默认启用只读保护（fail-closed）。',
  'desktop.guard.forceUnlockedBanner':
    '当前处于会话级强制解锁状态（写前仍强校验磁盘哈希并自动备份）。使用完毕请重新锁定。',
  'desktop.guard.recheck': '重新检测',
  'desktop.guard.forceUnlock': '强制解锁',
  'desktop.guard.relock': '重新锁定',
  'desktop.guard.unlockTitle': '确认强制解锁 DSH 写保护',
  'desktop.guard.unlockWarning':
    '检测到 DSH 可能仍在运行或状态未知。强制解锁将在本次桌面会话中允许写入 DSH 记忆库；每次写前仍会校验磁盘哈希并自动备份，但请勿与 DSH 同时写入同一批记录。',
  'desktop.guard.unlockConfirm': '确认强制解锁',

  'desktop.externalChange.banner':
    '磁盘上的 DSH 记忆库已被外部修改，当前编辑草稿已保留。请先刷新最新数据后再重新提交。',
  'desktop.externalChange.refresh': '立即刷新',

  'desktop.tab.dreamAudit': '整理与审计',
  'desktop.tab.transfer': '导入导出 / 跨库迁移',

  'desktop.client.missingDshTitle': 'DSH 记忆库尚未创建',
  'desktop.client.missingDshDesc':
    '该路径下尚未生成 memory.json。请先在 DSH 中启用并使用记忆插件，桌面端不会越权替 DSH 从零初始化库文件。',
  'desktop.client.missingInitTitle': '记忆库尚未初始化',
  'desktop.client.missingInitDesc':
    '该文件尚未创建，您可以直接“新建记忆”或通过“跨库迁移”写入第一批记忆。',
  'desktop.client.corruptTitle': '无法读取该记忆库',
  'desktop.client.disabledTitle': '该客户端已在桌面端停用',
  'desktop.client.disabledDesc': '可在“管理库”中重新启用该客户端。',

  'desktop.detail.permanentDelete': '永久删除',
  'desktop.detail.permanentDeleteConfirm': '永久删除后无法恢复且无法撤回，确认永久删除这条记忆？',
  'desktop.detail.openMigration': '复制到其他客户端…',
  'desktop.detail.readonlyNotice': '当前处于只读保护模式，仅可浏览、导出或复制到其他库。',

  'desktop.create.pickWorkspace': '选择本机目录…',
  'desktop.create.workspaceHint': '当前作用域：{scope}',

  'desktop.review.readonlyNotice': '当前处于只读保护模式，无法接受、拒绝或编辑提案。',

  'desktop.transfer.readonlyImportNotice':
    '当前库处于只读保护模式，仅支持只读导出，导入功能已禁用。',
  'desktop.transfer.openWizard': '打开跨库迁移向导',
  'desktop.transfer.wizardDesc':
    '直接从其他客户端或向其他客户端迁移记忆，支持工作区映射与安全预览。',
  'desktop.transfer.exportSaved': '已导出到 {path}',
  'desktop.transfer.importFromFile': '从本机文件选择…',

  'desktop.aggregate.title': '全部客户端聚合检索',
  'desktop.aggregate.subtitle': '跨所有已启用且健康的客户端执行只读 BM25 检索与浏览。',
  'desktop.aggregate.readonlyBadge': '只读聚合视图',
  'desktop.aggregate.clientFilter': '客户端',
  'desktop.aggregate.allClients': '全部启用客户端',
  'desktop.aggregate.skippedWarning': '以下客户端状态异常，本次聚合已跳过：{details}',
  'desktop.aggregate.openInClient': '在所属客户端中打开',
  'desktop.aggregate.copyToOther': '复制到其他客户端…',
  'desktop.aggregate.sourceClient': '来源客户端',
  'desktop.aggregate.score': '相关度 {score}',
  'desktop.aggregate.noClients': '暂无可检索的健康客户端。',
  'desktop.aggregate.typeCategories': '记忆分类',

  'desktop.dream.hostHint':
    'Dream 整理由宿主（DSH / AGY）在会话空闲或触发时执行；桌面端不直接发起 LLM 整理，提供历史记录查看与按批撤销。',
  'desktop.dream.historyTitle': '整理历史记录（Dream Runs）',
  'desktop.dream.empty': '暂无整理记录。',
  'desktop.dream.trigger': '触发方式',
  'desktop.dream.scope': '作用域',
  'desktop.dream.undoConfirm': '确认撤销本次整理（{id}）产生的所有可回退记忆变更？',
  'desktop.dream.readonlyUndoHint': '只读模式下不可撤销整理。',

  'desktop.audit.title': '只读审计时间线',
  'desktop.audit.empty': '暂无匹配的审计记录。',
  'desktop.audit.filterAction': '操作类型',
  'desktop.audit.allActions': '全部操作',
  'desktop.audit.filterMemoryId': '按 memoryId 过滤…',
  'desktop.audit.filterDreamId': '按 dreamId 过滤…',
  'desktop.audit.actor': '执行者',
  'desktop.audit.before': '变更前',
  'desktop.audit.after': '变更后',
  'desktop.audit.showDiff': '查看差异',
  'desktop.audit.hideDiff': '收起差异',

  'desktop.migrate.title': '跨客户端迁移向导',
  'desktop.migrate.singleTitle': '复制记忆到其他客户端',
  'desktop.migrate.sourceClient': '源客户端',
  'desktop.migrate.targetClient': '目标客户端',
  'desktop.migrate.sourceScope': '源范围',
  'desktop.migrate.scopeAll': '全部范围',
  'desktop.migrate.scopeGlobal': '仅全局偏好',
  'desktop.migrate.scopeWorkspace': '指定工作区',
  'desktop.migrate.includeArchived': '包含已归档记忆',
  'desktop.migrate.includeEpisodes': '包含会话片段（Episodes）',
  'desktop.migrate.mode': '迁移模式',
  'desktop.migrate.modeMerge': '合并（Merge）',
  'desktop.migrate.modeReplace': '替换目标作用域（Replace）',
  'desktop.migrate.singleLockedMerge':
    '单条/多选直迁严格锁定为合并（Merge）模式，防止误清空目标库。',
  'desktop.migrate.preview': '下一步：预览与工作区映射',
  'desktop.migrate.back': '上一步',
  'desktop.migrate.execute': '执行迁移',
  'desktop.migrate.executing': '正在迁移…',
  'desktop.migrate.memoryCount': '待迁移记忆数',
  'desktop.migrate.episodeCount': '待迁移片段数',
  'desktop.migrate.targetReadonlyError': '目标客户端当前不可写（只读保护或状态异常），无法写入。',
  'desktop.migrate.sameClientError': '源客户端与目标客户端不能相同。',
  'desktop.migrate.targetScope': '目标库替换范围（targetScope）',
  'desktop.migrate.targetScopeAll': '整个目标库（all）',
  'desktop.migrate.targetScopeGlobal': '目标库全局层（global）',
  'desktop.migrate.targetScopeWorkspace': '单一目标工作区',
  'desktop.migrate.mappingTitle': '工作区路径映射',
  'desktop.migrate.mappingHint': '为源数据中的每个工作区选择目标工作区或本机目录。',
  'desktop.migrate.mappingSkip': '跳过不导入',
  'desktop.migrate.pickDir': '选择本机目录…',
  'desktop.migrate.replaceNoSkipError':
    'Replace 模式下禁止跳过任何源工作区，请为每个工作区指定明确目标。',
  'desktop.migrate.replaceScopeError':
    'Replace 模式下所有映射的目标工作区必须位于所选 targetScope 内。',
  'desktop.migrate.replaceConfirmWarning':
    '高危确认：Replace 模式将先清空目标库在所选 targetScope（{scope}）内的全部现有记忆与片段，再导入源数据。确认执行？',
  'desktop.migrate.confirmExecute': '确认清空并执行迁移',
  'desktop.migrate.reportTitle': '迁移完成报告',
  'desktop.migrate.redactedCount': '触发脱敏条目：{count}',
  'desktop.migrate.episodesImported': '已迁移会话片段：{count}',

  'desktop.clientModal.addTitle': '添加自定义记忆库',
  'desktop.clientModal.editTitle': '管理客户端：{name}',
  'desktop.clientModal.name': '显示名称',
  'desktop.clientModal.storePath': 'memory.json 文件路径',
  'desktop.clientModal.pickExisting': '选择已有文件…',
  'desktop.clientModal.pickNew': '新建文件位置…',
  'desktop.clientModal.createIfMissing': '若文件不存在则允许在首次写入时初始化',
  'desktop.clientModal.dshProtected': '启用 DSH 并发写保护',
  'desktop.clientModal.dshProtectedHint': '指向 DSH profile 的库应开启此项以避免并发覆盖。',
  'desktop.clientModal.enabled': '在桌面端启用此客户端',
  'desktop.clientModal.addSubmit': '添加',
  'desktop.clientModal.remove': '从列表移除',
  'desktop.clientModal.removeConfirm':
    '仅从桌面端注册列表移除，不会删除磁盘上的 memory.json 文件。确认移除？',
  'desktop.clientModal.health': '健康状态',
  'desktop.clientModal.format': '封装格式',
  'desktop.clientModal.builtinReadonlyPath': '内置客户端路径由平台自动发现。',

  'desktop.config.dshReadonlyTitle': 'DSH 配置由 DSH Profile 管理',
  'desktop.config.dshReadonlyDesc':
    'DSH 插件配置由 DSH Profile 统一管理，请在 DSH 设置页调整。Memloom Desktop 严禁改写 DSH Profile 文件。',
  'desktop.config.groupGeneral': '基础与捕获',
  'desktop.config.groupSearchWorklog': '检索与工作日志',
  'desktop.config.groupRetention': '保留、清理与重建',
  'desktop.config.enabled': '启用记忆插件',
  'desktop.config.enabledHint': '关闭后 AGY 插件暂停注入与自动捕获。',
  'desktop.config.autoCaptureEpisodes': '自动捕获会话片段',
  'desktop.config.autoCaptureEpisodesHint': '自动记录对话与工具恢复事件供后续整理。',
  'desktop.config.dreamMaxEpisodes': '单次整理最大片段数',
  'desktop.config.dreamLookbackDays': '整理回溯天数',
  'desktop.config.dreamProcessingTimeoutMs': '整理超时阈值（毫秒）',
  'desktop.config.refreshMinIntervalMs': '索引增量刷新最小间隔（毫秒）',
  'desktop.config.refreshMaxBytes': '单次增量刷新字节上限',
  'desktop.config.refreshResetBytes': '索引重置触发字节上限',
  'desktop.config.injectForSubagents': '向子代理注入记忆',
  'desktop.config.injectForSubagentsHint': '允许子代理会话读取工作区记忆索引。',
  'desktop.config.searchLimit': '默认检索返回上限',
  'desktop.config.worklogCapture': '工作日志捕获模式',
  'desktop.config.worklogSignificant': '仅重要变更（significant）',
  'desktop.config.worklogOff': '关闭（off）',
  'desktop.config.archivePurgePolicy': '归档清理策略',
  'desktop.config.purgeManual': '手动（manual）',
  'desktop.config.purgeAfterExport': '导出后清理（after-export）',
  'desktop.config.purgeAge': '按保留天数自动清理（age）',
  'desktop.config.archiveRetentionDays': '归档保留天数',
  'desktop.config.rebuildLookbackDays': '重建索引回溯天数',
  'desktop.config.riskConfirmTitle': '安全与自动化风险确认',
  'desktop.config.confirmAutoAccept':
    '开启“自动接受提案”后，整理生成的记忆将跳过人工审阅直接生效。',
  'desktop.config.confirmInjectSubagents':
    '开启“向子代理注入记忆”后，子代理也将接收当前工作区的记忆上下文。',

  'desktop.error.readonlyGuard': '当前库处于 DSH 只读保护状态，无法执行写入操作。',
  'desktop.error.externalChange': '磁盘文件已被外部进程修改，请先刷新后再试。',
  'desktop.error.storeCorrupt': '记忆库文件已损坏或无法解析，请检查文件完整性。',
  'desktop.error.unsupported': '当前客户端不支持此操作。',
  'desktop.error.invalidArgs': '请求参数无效，请检查输入后重试。',
  'desktop.error.internal': '桌面服务发生内部错误，请稍后重试。',
}

const desktopExtraEn: LocaleDict = {
  'desktop.brand': 'Memloom',
  'desktop.brandSub': 'Memory Workspace',
  'desktop.allClients': 'All Clients',
  'desktop.addClient': '+ Add Store',
  'desktop.refreshClients': 'Refresh all clients',
  'desktop.migrateQuick': 'Migrate',
  'desktop.langToggle': '中 / EN',
  'desktop.themeLight': 'Light',
  'desktop.themeDark': 'Dark',
  'desktop.themeSystem': 'System',
  'desktop.themeSwitchToLight': 'Switch to light',
  'desktop.themeSwitchToDark': 'Switch to dark',
  'desktop.clientManage': 'Manage store',
  'desktop.sidebar.overview': 'Overview',
  'desktop.sidebar.platforms': 'Platforms & Stores',
  'desktop.sidebar.platformListLabel': 'Platforms and stores navigation',
  'desktop.sidebar.storeCount': '{count} stores',
  'desktop.sidebar.manageClient': 'Manage {name}',

  'desktop.status.writable': 'Writable',
  'desktop.status.readonly': 'Read-only',
  'desktop.status.forceUnlocked': 'Force unlocked',
  'desktop.status.missing': 'Missing',
  'desktop.status.corrupted': 'Corrupted',
  'desktop.status.unreadable': 'Unreadable',
  'desktop.status.disabled': 'Disabled',

  'desktop.kind.dsh': 'DSH',
  'desktop.kind.agy': 'AGY',
  'desktop.kind.custom': 'Custom',

  'desktop.legacy.banner': 'Detected legacy dsh-memory AGY store: {path}',
  'desktop.legacy.quickAdd': 'Quick add',
  'desktop.legacy.dismiss': 'Dismiss',
  'desktop.legacy.defaultName': 'Legacy dsh-memory',

  'desktop.guard.runningBanner':
    'DSH is running; read-only protection is active for DSH stores. Write actions are disabled.',
  'desktop.guard.uncertainBanner':
    'Cannot verify whether DSH is closed; fail-closed read-only protection is active.',
  'desktop.guard.forceUnlockedBanner':
    'Session force-unlock is active (pre-write disk hash check and automatic backup still apply). Re-lock when finished.',
  'desktop.guard.recheck': 'Re-check',
  'desktop.guard.forceUnlock': 'Force unlock',
  'desktop.guard.relock': 'Re-lock',
  'desktop.guard.unlockTitle': 'Confirm force-unlocking DSH write protection',
  'desktop.guard.unlockWarning':
    'DSH may still be running or its status is uncertain. Force-unlocking allows writes to DSH stores for this session; disk hash checks and backups remain active before each write, but avoid editing the same records concurrently in DSH.',
  'desktop.guard.unlockConfirm': 'Confirm force unlock',

  'desktop.externalChange.banner':
    'The DSH store on disk changed externally. Your unsaved draft has been preserved—refresh before submitting again.',
  'desktop.externalChange.refresh': 'Refresh now',

  'desktop.tab.dreamAudit': 'Dreams & Audit',
  'desktop.tab.transfer': 'Import, Export & Migration',

  'desktop.client.missingDshTitle': 'DSH store has not been created yet',
  'desktop.client.missingDshDesc':
    'No memory.json exists at this path yet. Enable and use the memory plugin inside DSH first; Desktop will not initialize DSH stores from scratch.',
  'desktop.client.missingInitTitle': 'Memory store not initialized yet',
  'desktop.client.missingInitDesc':
    'This file does not exist yet. Create a first memory or migrate records into it to initialize it.',
  'desktop.client.corruptTitle': 'Unable to open this memory store',
  'desktop.client.disabledTitle': 'Client is disabled in Desktop',
  'desktop.client.disabledDesc': 'Enable this client in "Manage store" to inspect it.',

  'desktop.detail.permanentDelete': 'Delete permanently',
  'desktop.detail.permanentDeleteConfirm':
    'Permanent deletion cannot be undone or restored. Delete this memory permanently?',
  'desktop.detail.openMigration': 'Copy to another client…',
  'desktop.detail.readonlyNotice':
    'Read-only protection is active. You can browse, export, or copy memories to another store.',

  'desktop.create.pickWorkspace': 'Choose folder…',
  'desktop.create.workspaceHint': 'Target scope: {scope}',

  'desktop.review.readonlyNotice':
    'Read-only protection is active; proposals cannot be accepted, rejected, or edited.',

  'desktop.transfer.readonlyImportNotice':
    'Read-only protection is active. Export remains available, while importing into this store is disabled.',
  'desktop.transfer.openWizard': 'Open cross-client migration wizard',
  'desktop.transfer.wizardDesc':
    'Migrate memories directly between registered clients with workspace mapping and safety preview.',
  'desktop.transfer.exportSaved': 'Exported to {path}',
  'desktop.transfer.importFromFile': 'Choose file from disk…',

  'desktop.aggregate.title': 'All Clients Search',
  'desktop.aggregate.subtitle':
    'Read-only federated BM25 search across all enabled healthy clients.',
  'desktop.aggregate.readonlyBadge': 'Read-only aggregate view',
  'desktop.aggregate.clientFilter': 'Clients',
  'desktop.aggregate.allClients': 'All enabled clients',
  'desktop.aggregate.skippedWarning': 'Skipped unhealthy or missing clients: {details}',
  'desktop.aggregate.openInClient': 'Open in client',
  'desktop.aggregate.copyToOther': 'Copy to another client…',
  'desktop.aggregate.sourceClient': 'Source client',
  'desktop.aggregate.score': 'Score {score}',
  'desktop.aggregate.noClients': 'No enabled healthy clients available.',
  'desktop.aggregate.typeCategories': 'Memory categories',

  'desktop.dream.hostHint':
    'Dreaming is triggered by the host (DSH / AGY). Desktop lets you inspect historical runs and undo completed runs by batch.',
  'desktop.dream.historyTitle': 'Dream Run History',
  'desktop.dream.empty': 'No dream runs recorded yet.',
  'desktop.dream.trigger': 'Trigger',
  'desktop.dream.scope': 'Scope',
  'desktop.dream.undoConfirm': 'Undo all reversible changes created by dream run {id}?',
  'desktop.dream.readonlyUndoHint': 'Cannot undo dream runs in read-only mode.',

  'desktop.audit.title': 'Read-only Audit Timeline',
  'desktop.audit.empty': 'No audit records match the current filter.',
  'desktop.audit.filterAction': 'Action',
  'desktop.audit.allActions': 'All actions',
  'desktop.audit.filterMemoryId': 'Filter by memoryId…',
  'desktop.audit.filterDreamId': 'Filter by dreamId…',
  'desktop.audit.actor': 'Actor',
  'desktop.audit.before': 'Before',
  'desktop.audit.after': 'After',
  'desktop.audit.showDiff': 'Show diff',
  'desktop.audit.hideDiff': 'Hide diff',

  'desktop.migrate.title': 'Cross-Client Migration Wizard',
  'desktop.migrate.singleTitle': 'Copy memory to another client',
  'desktop.migrate.sourceClient': 'Source client',
  'desktop.migrate.targetClient': 'Target client',
  'desktop.migrate.sourceScope': 'Source scope',
  'desktop.migrate.scopeAll': 'All scopes',
  'desktop.migrate.scopeGlobal': 'Global preferences only',
  'desktop.migrate.scopeWorkspace': 'Specific workspace',
  'desktop.migrate.includeArchived': 'Include archived memories',
  'desktop.migrate.includeEpisodes': 'Include episodes',
  'desktop.migrate.mode': 'Migration mode',
  'desktop.migrate.modeMerge': 'Merge',
  'desktop.migrate.modeReplace': 'Replace target scope',
  'desktop.migrate.singleLockedMerge':
    'Single/multi-record migration is strictly locked to Merge mode to prevent wiping the target store.',
  'desktop.migrate.preview': 'Next: Preview & workspace mapping',
  'desktop.migrate.back': 'Back',
  'desktop.migrate.execute': 'Execute migration',
  'desktop.migrate.executing': 'Migrating…',
  'desktop.migrate.memoryCount': 'Memories to migrate',
  'desktop.migrate.episodeCount': 'Episodes to migrate',
  'desktop.migrate.targetReadonlyError':
    'Target client is not writable (read-only guard or unhealthy store).',
  'desktop.migrate.sameClientError': 'Source and target clients must be different.',
  'desktop.migrate.targetScope': 'Target replace scope (targetScope)',
  'desktop.migrate.targetScopeAll': 'Entire target store (all)',
  'desktop.migrate.targetScopeGlobal': 'Target global scope (global)',
  'desktop.migrate.targetScopeWorkspace': 'Single target workspace',
  'desktop.migrate.mappingTitle': 'Workspace mapping',
  'desktop.migrate.mappingHint':
    'Choose a target workspace or local folder for each source workspace.',
  'desktop.migrate.mappingSkip': 'Skip (do not import)',
  'desktop.migrate.pickDir': 'Pick folder…',
  'desktop.migrate.replaceNoSkipError':
    'Replace mode forbids skipping any source workspace; assign a target for every workspace.',
  'desktop.migrate.replaceScopeError':
    'In replace mode, every mapped workspace must fall within the chosen targetScope.',
  'desktop.migrate.replaceConfirmWarning':
    'Danger: Replace mode will delete all existing memories and episodes in targetScope ({scope}) before importing. Continue?',
  'desktop.migrate.confirmExecute': 'Confirm wipe & migrate',
  'desktop.migrate.reportTitle': 'Migration report',
  'desktop.migrate.redactedCount': 'Redacted items: {count}',
  'desktop.migrate.episodesImported': 'Episodes imported: {count}',

  'desktop.clientModal.addTitle': 'Add custom memory store',
  'desktop.clientModal.editTitle': 'Manage client: {name}',
  'desktop.clientModal.name': 'Display name',
  'desktop.clientModal.storePath': 'memory.json file path',
  'desktop.clientModal.pickExisting': 'Choose existing…',
  'desktop.clientModal.pickNew': 'Create new…',
  'desktop.clientModal.createIfMissing': 'Allow initializing on first write if missing',
  'desktop.clientModal.dshProtected': 'Enable DSH concurrent write protection',
  'desktop.clientModal.dshProtectedHint':
    'Keep enabled for stores belonging to a DSH profile to avoid concurrent overwrites.',
  'desktop.clientModal.enabled': 'Enable this client in Desktop',
  'desktop.clientModal.addSubmit': 'Add store',
  'desktop.clientModal.remove': 'Remove from list',
  'desktop.clientModal.removeConfirm':
    'Removes only from Desktop registry; your memory.json file on disk is untouched. Remove?',
  'desktop.clientModal.health': 'Health',
  'desktop.clientModal.format': 'Format',
  'desktop.clientModal.builtinReadonlyPath': 'Built-in client paths are auto-discovered.',

  'desktop.config.dshReadonlyTitle': 'Managed by DSH Profile',
  'desktop.config.dshReadonlyDesc':
    'DSH plugin configuration is managed by the DSH Profile and should be adjusted in DSH Settings. Memloom Desktop never modifies DSH Profile files.',
  'desktop.config.groupGeneral': 'General & Capture',
  'desktop.config.groupSearchWorklog': 'Search & Worklog',
  'desktop.config.groupRetention': 'Retention, Purge & Rebuild',
  'desktop.config.enabled': 'Enable memory plugin',
  'desktop.config.enabledHint': 'Disabling pauses AGY injection and automatic episode capture.',
  'desktop.config.autoCaptureEpisodes': 'Auto-capture episodes',
  'desktop.config.autoCaptureEpisodesHint':
    'Capture conversation turns and tool recoveries for dreaming.',
  'desktop.config.dreamMaxEpisodes': 'Max episodes per dream run',
  'desktop.config.dreamLookbackDays': 'Dream lookback window (days)',
  'desktop.config.dreamProcessingTimeoutMs': 'Dream processing timeout (ms)',
  'desktop.config.refreshMinIntervalMs': 'Min index refresh interval (ms)',
  'desktop.config.refreshMaxBytes': 'Max index refresh delta (bytes)',
  'desktop.config.refreshResetBytes': 'Index reset threshold (bytes)',
  'desktop.config.injectForSubagents': 'Inject memories for subagents',
  'desktop.config.injectForSubagentsHint':
    'Allow subagent sessions to receive workspace memory index.',
  'desktop.config.searchLimit': 'Default search result limit',
  'desktop.config.worklogCapture': 'Worklog capture mode',
  'desktop.config.worklogSignificant': 'Significant changes only',
  'desktop.config.worklogOff': 'Off',
  'desktop.config.archivePurgePolicy': 'Archive purge policy',
  'desktop.config.purgeManual': 'Manual',
  'desktop.config.purgeAfterExport': 'After export',
  'desktop.config.purgeAge': 'By retention age',
  'desktop.config.archiveRetentionDays': 'Archive retention (days)',
  'desktop.config.rebuildLookbackDays': 'Rebuild lookback (days)',
  'desktop.config.riskConfirmTitle': 'Safety & automation confirmation',
  'desktop.config.confirmAutoAccept':
    'Enabling "Auto-accept proposals" commits dreamed memories directly without manual review.',
  'desktop.config.confirmInjectSubagents':
    'Enabling "Inject memories for subagents" exposes workspace memory context to subagent sessions.',

  'desktop.error.readonlyGuard':
    'This store is protected by the DSH read-only guard and cannot be modified right now.',
  'desktop.error.externalChange':
    'The store file changed externally on disk. Please refresh before retrying.',
  'desktop.error.storeCorrupt':
    'The memory store file is corrupted or unreadable. Inspect the file integrity.',
  'desktop.error.unsupported': 'This operation is not supported for the selected client.',
  'desktop.error.invalidArgs': 'Invalid request arguments. Please verify your input.',
  'desktop.error.internal': 'Unexpected internal desktop error. Please retry.',
}

export const desktopZh: LocaleDict = {
  ...baseZh,
  ...desktopExtraZh,
}

export const desktopEn: LocaleDict = {
  ...baseEn,
  ...desktopExtraEn,
}

/** Build a translator function bound to the given desktop locale. */
export function createTranslator(locale: DesktopLocale): (key: string) => string {
  const dict = locale === 'en' ? desktopEn : desktopZh
  return (key: string) => dict[key] ?? key
}

/** Synchronously apply the active desktop locale to `src/client/locales.ts`. */
export function applyDesktopLocale(locale: DesktopLocale): void {
  setTranslate(createTranslator(locale))
}

const DESKTOP_ERROR_KEYS: Record<string, string> = {
  'desktop/readonly-guard': 'desktop.error.readonlyGuard',
  'desktop/external-change': 'desktop.error.externalChange',
  'desktop/store-corrupt': 'desktop.error.storeCorrupt',
  'desktop/unsupported': 'desktop.error.unsupported',
  'desktop/invalid-args': 'desktop.error.invalidArgs',
  'desktop/internal': 'desktop.error.internal',
}

/** Localize desktop IPC errors (`desktop/*`) and fall back to `src/client/errors.ts` for `memory/*`. */
export function desktopErrorText(error: unknown): string {
  const code = remoteErrorCode(error)
  const key = code === undefined ? undefined : DESKTOP_ERROR_KEYS[code]
  if (key !== undefined) {
    const localized = t(key)
    const rawMessage =
      error !== null && typeof error === 'object' && 'message' in error
        ? (error as { message?: unknown }).message
        : undefined
    if (
      (code === 'desktop/store-corrupt' || code === 'desktop/internal') &&
      typeof rawMessage === 'string' &&
      rawMessage !== ''
    ) {
      return `${localized} (${rawMessage})`
    }
    return localized
  }
  return errorText(error)
}

/** Return whether an unknown error represents `desktop/external-change`. */
export function isExternalChangeError(error: unknown): boolean {
  return remoteErrorCode(error) === 'desktop/external-change'
}

/** Unwrap an {@link IpcResult}, throwing its {@link IpcError} when `!result.ok`. */
export function unwrapIpc<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    const err: IpcError = result.error
    throw err
  }
  return result.value
}
