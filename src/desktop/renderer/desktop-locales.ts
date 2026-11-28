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
  'desktop.allClients': '全部记忆',
  'desktop.allHosts': '全部宿主',
  'desktop.addClient': '+ 添加库',
  'desktop.refreshClients': '刷新所有库',
  'desktop.migrateQuick': '跨端迁移',
  'desktop.langToggle': '中 / EN',
  'desktop.themeLight': '浅色',
  'desktop.themeDark': '深色',
  'desktop.themeSystem': '跟随系统',
  'desktop.themeSwitchToLight': '切换浅色',
  'desktop.themeSwitchToDark': '切换深色',
  'desktop.clientManage': '宿主状态',
  'desktop.sidebar.overview': '工作台',
  'desktop.sidebar.platforms': '已连接宿主',
  'desktop.sidebar.maintenance': '维护与配置',
  'desktop.sidebar.platformListLabel': '工作台与宿主导航',
  'desktop.sidebar.storeCount': '{count} 个宿主',
  'desktop.sidebar.manageClient': '管理 {name}',
  'desktop.sidebar.allShort': '全部',
  'desktop.sidebar.commandPalette': '命令面板',
  'desktop.nav.memories': '全部记忆',
  'desktop.nav.review': '待审阅提案',
  'desktop.nav.migrate': '跨端迁移',
  'desktop.nav.audit': '整理与审计',
  'desktop.nav.config': '宿主配置',

  'desktop.status.writable': '可写',
  'desktop.status.readonly': '只读',
  'desktop.status.forceUnlocked': '临时可写',
  'desktop.status.missing': '未初始化',
  'desktop.status.corrupted': '已损坏',
  'desktop.status.unreadable': '不可读',
  'desktop.status.disabled': '已停用',

  'desktop.plugin.enabled': '已启用',
  'desktop.plugin.disabled': '已禁用',
  'desktop.plugin.notInstalled': '未安装',
  'desktop.plugin.unknown': '未知',
  'desktop.plugin.cardTitle': '宿主插件状态',
  'desktop.plugin.installPathLabel': '安装路径',
  'desktop.plugin.versionLabel': '插件版本',
  'desktop.plugin.storeHealthLabel': '存储状态',
  'desktop.plugin.notInstalledHintDsh': '未在 DSH profile 中检测到 memloom / dsh-memory 插件。',
  'desktop.plugin.notInstalledHintAgy': '未在 ~/.gemini/config/plugins 下检测到 memloom 插件。',

  'desktop.kind.dsh': 'DSH',
  'desktop.kind.agy': 'AGY',
  'desktop.kind.custom': '本地库',

  'desktop.filter.hostPrefix': '宿主',
  'desktop.filter.workspacePrefix': '工作区',
  'desktop.filter.statusPrefix': '状态',
  'desktop.filter.ownerAll': '全部所有权',
  'desktop.filter.ownerUser': '用户拥有',
  'desktop.filter.ownerDerived': '派生缓存',
  'desktop.filter.allWorkspaces': '全部工作区',

  'desktop.inspector.selectHint': '从左侧选择一条记忆查看完整正文与来源溯源',
  'desktop.inspector.pin': '置顶',
  'desktop.inspector.pinned': '已置顶',
  'desktop.inspector.scope': '作用域',
  'desktop.inspector.ownership': '所有权与来源',
  'desktop.inspector.ownerUserDesc': '用户拥有（Rebuild 永不删除）',
  'desktop.inspector.ownerDerivedDesc': '派生缓存（可由会话日志重建）',
  'desktop.inspector.revisionConf': '版本与置信度',
  'desktop.inspector.stats': '检索召回统计',
  'desktop.inspector.statsVal': '命中 {match} 次 / 读取 {use} 次',
  'desktop.inspector.tags': '标签',
  'desktop.inspector.sources': '会话来源溯源',
  'desktop.inspector.noSources': '由用户显式创建或导入，无自动捕获会话片段。',
  'desktop.inspector.softForget': '软遗忘',
  'desktop.inspector.migrate': '跨端迁移',
  'desktop.inspector.selectedBatch': '已选择 {count} 条记忆',
  'desktop.inspector.batchMigrate': '迁移至另一宿主',
  'desktop.inspector.batchForget': '批量软遗忘',

  'desktop.review.subtitle': 'Dream 后台整理产生的提案会先在此等待确认，不会未经审阅污染检索索引。',
  'desktop.review.pendingCount': '{count} 条待处理',
  'desktop.review.typeReplace': '纠错替代',
  'desktop.review.typeNew': '新增提案',
  'desktop.review.shortcuts': '快捷键：A 批准入库 / E 编辑后批准 / R 拒绝提案',
  'desktop.review.approveAndKeep': '批准并转为永久记忆',
  'desktop.review.backToMemories': '返回全部记忆',
  'desktop.review.diffBanner': '版本替代对比：批准后自动归档旧条目并激活新版本',

  'desktop.cmd.placeholder': '搜索页面、宿主或快捷操作…',
  'desktop.cmd.empty': '未找到匹配的命令',
  'desktop.cmd.groupNav': '工作台',
  'desktop.cmd.groupHost': '聚焦宿主',
  'desktop.cmd.groupTheme': '外观',
  'desktop.cmd.toggleTheme': '切换浅色 / 深色主题',
  'desktop.cmd.toggleLang': '切换语言（中文 / English）',

  'desktop.dshGuard.cardTitle': 'DSH 并发写保护状态机',
  'desktop.dshGuard.lockedDesc':
    '检测到 {procs} 正在运行或状态待确认，所有 DSH 记忆库已自动锁定为只读保护。',
  'desktop.dshGuard.unlockedDesc':
    '当前已临时解除只读限制。每次写入前仍将校验磁盘 SHA-256 哈希并在同目录生成快照备份。',
  'desktop.dshGuard.snapshotTitle': '写前自动快照与外部变更保护',
  'desktop.dshGuard.snapshotPathLabel': '快照存放目录',
  'desktop.dshGuard.snapshotRuleLabel': '保留上限与校验机制',
  'desktop.dshGuard.snapshotRuleDesc':
    '同目录自动轮转保留最近 20 份桌面快照；写入前校验 SHA-256，若被外部改动立即中止。',
  'desktop.config.subtitle': '分别管理 Antigravity (AGY) 的运行参数与 DSH 的只读防护状态。',
  'desktop.config.maintenanceTitle': '数据备份与缓存重建',
  'desktop.config.maintenanceDesc':
    'Rebuild 仅重建由会话日志派生的未确认条目与索引；用户创建、编辑或审阅确认的记忆绝不会被删除。',
  'desktop.config.rebuildBtn': '重建派生缓存',
  'desktop.config.rebuildConfirm':
    '将清理未审阅的派生条目并重放近期会话日志重新生成；所有用户拥有及置顶条目完整保留。确认开始？',
  'desktop.config.rebuildDone': '已完成派生缓存与检索索引重建。',
  'desktop.config.purgeBtn': '清空当前库',
  'desktop.config.purgeConfirm':
    '高风险操作：将永久清除当前库中的全部记忆与归档记录，操作无法撤销。确认继续？',
  'desktop.config.purgeDone': '已清空当前记忆库。',
  'desktop.config.unsavedCount': '已修改 {count} 项配置',
  'desktop.config.agyStoreMeta': 'agy-flat · 文件锁并发保护',
  'desktop.config.dshStoreMeta': 'dsh-unit · DSH Profile 托管',

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
  'desktop.aggregate.openInClient': '在所属宿主中打开',
  'desktop.aggregate.copyToOther': '复制到其他宿主…',
  'desktop.aggregate.sourceClient': '来源宿主',
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
  'desktop.config.dreamSubagentModel': '整理子代理模型档位',
  'desktop.config.dreamSubagentModelHint':
    'AGY 执行 memory-dream / autoDream 派生后台子代理时使用的 Model 档位。',
  'desktop.config.subagentModel.flash_lite': 'Flash Lite',
  'desktop.config.subagentModel.flash': 'Flash（推荐）',
  'desktop.config.subagentModel.pro': 'Pro',
  'desktop.config.subagentModel.inherit': '跟随主会话',
  'config.autoDreamHint':
    'Stop 捕获新片段且满足冷却时间后，由 PreInvocation 提醒主代理派生后台子代理自动整理（也可配合 /automation 定时触发）。',
  'config.autoDreamMinIntervalHint': 'AGY 两次自动触发整理提醒之间的最小冷却间隔（秒）。',
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
  'desktop.error.busy': '当前已有插件变更或更新任务正在执行，请等待完成后重试。',
  'desktop.error.dshRunning': '检测到 DSH 正在运行或状态未知，请先完全关闭 DSH 后再操作插件。',
  'desktop.error.dshCliMissing':
    '未找到 dsh CLI 可执行文件，请在宿主配置中手动选择 dsh / dsh.cmd / dsh.exe。',
  'desktop.error.updateNetwork': '无法连接 GitHub Releases 获取更新信息，请检查网络后重试。',
  'desktop.error.updateChecksumFailed':
    '下载产物 SHA-256 校验失败或缺少 SHA256SUMS.txt，已中止并删除临时文件。',
  'desktop.error.pluginOpFailed': '宿主插件操作失败，请关闭对应宿主后重试。',

  'desktop.plugin.installBtn': '一键安装',
  'desktop.plugin.syncBtn': '同步到 v{version}',
  'desktop.plugin.uninstallBtn': '卸载插件',
  'desktop.plugin.confirmInstallTitle': '确认安装 / 同步插件',
  'desktop.plugin.confirmUninstallTitle': '确认卸载插件',
  'desktop.plugin.confirmInstallBody':
    '将把 Memloom 插件安装或同步至 {target}。此操作不会删除或覆写任何记忆数据（memory.json）与用户配置。完成后需重启对应宿主生效。',
  'desktop.plugin.confirmUninstallBody':
    '将从 {target} 移除 Memloom 插件文件。此操作不会删除您的记忆数据（memory.json）与备份。完成后需重启对应宿主生效。',
  'desktop.plugin.confirmInstallAction': '确认安装',
  'desktop.plugin.confirmUninstallAction': '确认卸载',
  'desktop.plugin.installSuccess': '插件已安装 / 同步，请重启对应宿主生效。',
  'desktop.plugin.uninstallSuccess': '插件已卸载，记忆数据已完整保留，请重启对应宿主生效。',
  'desktop.plugin.dshProfileLabel': '目标 DSH Profile',
  'desktop.plugin.noDshProfiles': '未检测到本机 DSH profile，请先运行一次 DSH 初始化环境。',
  'desktop.plugin.dshRunningBlock':
    'DSH 正在运行或状态待确认，请先关闭 DSH 后再安装或卸载 DSH 插件。',
  'desktop.plugin.dshCliLabel': 'DSH CLI 路径',
  'desktop.plugin.dshCliAuto': '自动从 PATH 探测',
  'desktop.plugin.dshCliPick': '选择 dsh CLI…',
  'desktop.plugin.dshCliClear': '清除',
  'desktop.plugin.dshCliSaved': '已保存自定义 DSH CLI 路径。',
  'desktop.plugin.dshCliCleared': '已恢复自动探测 DSH CLI。',

  'desktop.updater.checkBtn': '检查更新',
  'desktop.updater.title': '应用更新与插件同步',
  'desktop.updater.currentVersion': '当前版本',
  'desktop.updater.latestVersion': '最新版本',
  'desktop.updater.upToDate': '当前已是最新版本。',
  'desktop.updater.updateAvailable': '发现新版本 v{version}',
  'desktop.updater.recheck': '重新检查',
  'desktop.updater.updateNow': '立即更新',
  'desktop.updater.updateOnlinePlugins': '更新已安装端插件',
  'desktop.updater.cancelDownload': '取消下载',
  'desktop.updater.openRelease': '前往 GitHub Release',
  'desktop.updater.releaseNotes': '发布说明',
  'desktop.updater.syncTargetsTitle': '更新后将自动同步的已安装端',
  'desktop.updater.noInstalledTargets': '当前没有需要联动同步的已启用宿主插件。',
  'desktop.updater.localBridgeHint':
    '当前为免签名本地运行模式（start:desktop）。应用本体请通过源码重建或前往 GitHub 下载安装包，下方可直接在线更新各已安装宿主端插件。',
  'desktop.updater.syncBannerRunning': '正在将内置插件同步到已安装宿主端…',
  'desktop.updater.syncBannerFailed': '部分宿主插件同步未完成（{details}），请关闭 DSH 后重试。',
  'desktop.updater.retrySync': '重试同步',
  'desktop.updater.dismissSync': '忽略',
}

const desktopExtraEn: LocaleDict = {
  'desktop.brand': 'Memloom',
  'desktop.brandSub': 'Memory Workspace',
  'desktop.allClients': 'All Memories',
  'desktop.allHosts': 'All Hosts',
  'desktop.addClient': '+ Add Store',
  'desktop.refreshClients': 'Refresh all stores',
  'desktop.migrateQuick': 'Migrate',
  'desktop.langToggle': '中 / EN',
  'desktop.themeLight': 'Light',
  'desktop.themeDark': 'Dark',
  'desktop.themeSystem': 'System',
  'desktop.themeSwitchToLight': 'Light mode',
  'desktop.themeSwitchToDark': 'Dark mode',
  'desktop.clientManage': 'Host status',
  'desktop.sidebar.overview': 'Workspace',
  'desktop.sidebar.platforms': 'Connected Hosts',
  'desktop.sidebar.maintenance': 'Maintenance',
  'desktop.sidebar.platformListLabel': 'Workspace and hosts navigation',
  'desktop.sidebar.storeCount': '{count} hosts',
  'desktop.sidebar.manageClient': 'Manage {name}',
  'desktop.sidebar.allShort': 'All',
  'desktop.sidebar.commandPalette': 'Command Palette',
  'desktop.nav.memories': 'All Memories',
  'desktop.nav.review': 'Review Inbox',
  'desktop.nav.migrate': 'Cross-Host Sync',
  'desktop.nav.audit': 'Dreams & Audit',
  'desktop.nav.config': 'Host Settings',

  'desktop.status.writable': 'Writable',
  'desktop.status.readonly': 'Read-only',
  'desktop.status.forceUnlocked': 'Unlocked',
  'desktop.status.missing': 'Missing',
  'desktop.status.corrupted': 'Corrupted',
  'desktop.status.unreadable': 'Unreadable',
  'desktop.status.disabled': 'Disabled',

  'desktop.plugin.enabled': 'Enabled',
  'desktop.plugin.disabled': 'Disabled',
  'desktop.plugin.notInstalled': 'Not installed',
  'desktop.plugin.unknown': 'Unknown',
  'desktop.plugin.cardTitle': 'Host Plugin Status',
  'desktop.plugin.installPathLabel': 'Install path',
  'desktop.plugin.versionLabel': 'Plugin version',
  'desktop.plugin.storeHealthLabel': 'Store health',
  'desktop.plugin.notInstalledHintDsh': 'memloom / dsh-memory was not found in this DSH profile.',
  'desktop.plugin.notInstalledHintAgy': 'memloom was not found under ~/.gemini/config/plugins.',

  'desktop.kind.dsh': 'DSH',
  'desktop.kind.agy': 'AGY',
  'desktop.kind.custom': 'Local Store',

  'desktop.filter.hostPrefix': 'Host',
  'desktop.filter.workspacePrefix': 'Workspace',
  'desktop.filter.statusPrefix': 'Status',
  'desktop.filter.ownerAll': 'All ownership',
  'desktop.filter.ownerUser': 'User owned',
  'desktop.filter.ownerDerived': 'Derived cache',
  'desktop.filter.allWorkspaces': 'All workspaces',

  'desktop.inspector.selectHint':
    'Select a memory from the list to inspect prose and session sources',
  'desktop.inspector.pin': 'Pin',
  'desktop.inspector.pinned': 'Pinned',
  'desktop.inspector.scope': 'Scope',
  'desktop.inspector.ownership': 'Ownership',
  'desktop.inspector.ownerUserDesc': 'User owned (never deleted on rebuild)',
  'desktop.inspector.ownerDerivedDesc': 'Derived cache (rebuildable from logs)',
  'desktop.inspector.revisionConf': 'Revision & confidence',
  'desktop.inspector.stats': 'Recall & read stats',
  'desktop.inspector.statsVal': '{match} matches / {use} reads',
  'desktop.inspector.tags': 'Tags',
  'desktop.inspector.sources': 'Session provenance',
  'desktop.inspector.noSources':
    'Explicitly created or imported by user; no auto-captured transcript quote.',
  'desktop.inspector.softForget': 'Archive',
  'desktop.inspector.migrate': 'Migrate',
  'desktop.inspector.selectedBatch': '{count} memories selected',
  'desktop.inspector.batchMigrate': 'Migrate to host',
  'desktop.inspector.batchForget': 'Archive selected',

  'desktop.review.subtitle':
    'Proposals synthesized by background Dreaming wait here for approval before entering retrieval.',
  'desktop.review.pendingCount': '{count} pending',
  'desktop.review.typeReplace': 'Supersedes',
  'desktop.review.typeNew': 'New proposal',
  'desktop.review.shortcuts': 'Shortcuts: A Approve / E Edit & approve / R Reject',
  'desktop.review.approveAndKeep': 'Approve & keep permanently',
  'desktop.review.backToMemories': 'Back to memories',
  'desktop.review.diffBanner':
    'Revision diff: approving archives the superseded memory and activates the proposal',

  'desktop.cmd.placeholder': 'Search views, hosts, or quick actions…',
  'desktop.cmd.empty': 'No matching commands',
  'desktop.cmd.groupNav': 'Workspace',
  'desktop.cmd.groupHost': 'Focus Host',
  'desktop.cmd.groupTheme': 'Appearance',
  'desktop.cmd.toggleTheme': 'Toggle Light / Dark theme',
  'desktop.cmd.toggleLang': 'Switch language (中文 / English)',

  'desktop.dshGuard.cardTitle': 'DSH Concurrent Write-Guard',
  'desktop.dshGuard.lockedDesc':
    'Detected {procs} running or uncertain state. All DSH stores are automatically locked to read-only.',
  'desktop.dshGuard.unlockedDesc':
    'Session write-unlock is active. Every write verifies disk SHA-256 and creates an automatic backup snapshot.',
  'desktop.dshGuard.snapshotTitle': 'Pre-Write Snapshots & External-Change Guard',
  'desktop.dshGuard.snapshotPathLabel': 'Snapshot directory',
  'desktop.dshGuard.snapshotRuleLabel': 'Retention & integrity check',
  'desktop.dshGuard.snapshotRuleDesc':
    'Keeps up to 20 rotating desktop snapshots; aborts immediately if disk SHA-256 changed externally.',
  'desktop.config.subtitle':
    'Configure Antigravity (AGY) parameters and inspect DSH write-guard protections.',
  'desktop.config.maintenanceTitle': 'Backup & Cache Rebuild',
  'desktop.config.maintenanceDesc':
    'Rebuild recreates unreviewed derived memories and indexes from session logs; user-owned memories are always preserved.',
  'desktop.config.rebuildBtn': 'Rebuild derived cache',
  'desktop.config.rebuildConfirm':
    'Clear unreviewed derived records and replay session logs? User-owned and pinned memories stay untouched.',
  'desktop.config.rebuildDone': 'Derived cache and search index rebuilt.',
  'desktop.config.purgeBtn': 'Purge store',
  'desktop.config.purgeConfirm':
    'High risk: permanently delete all memories and archives in this store. This cannot be undone.',
  'desktop.config.purgeDone': 'Store purged.',
  'desktop.config.unsavedCount': '{count} unsaved change(s)',
  'desktop.config.agyStoreMeta': 'agy-flat · File-lock guarded',
  'desktop.config.dshStoreMeta': 'dsh-unit · Managed by DSH Profile',

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
  'desktop.aggregate.openInClient': 'Open in host',
  'desktop.aggregate.copyToOther': 'Copy to another host…',
  'desktop.aggregate.sourceClient': 'Source host',
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
  'desktop.config.dreamSubagentModel': 'Dream subagent model tier',
  'desktop.config.dreamSubagentModelHint':
    'Model tier passed to invoke_subagent when running memory-dream or autoDream in AGY.',
  'desktop.config.subagentModel.flash_lite': 'Flash Lite',
  'desktop.config.subagentModel.flash': 'Flash (Recommended)',
  'desktop.config.subagentModel.pro': 'Pro',
  'desktop.config.subagentModel.inherit': 'Inherit session',
  'config.autoDreamHint':
    'When Stop captures new episodes and cooldown elapses, PreInvocation reminds AGY to spawn a background subagent for dreaming (or pair with /automation).',
  'config.autoDreamMinIntervalHint':
    'Minimum cooldown between AGY automatic dream reminders (seconds).',
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
  'desktop.error.busy': 'Another plugin or update task is already in progress. Please wait.',
  'desktop.error.dshRunning':
    'DSH is currently running or uncertain. Please close DSH completely before modifying DSH plugins.',
  'desktop.error.dshCliMissing':
    'Could not locate the dsh CLI. Please select dsh / dsh.cmd / dsh.exe in Host Settings.',
  'desktop.error.updateNetwork':
    'Failed to reach GitHub Releases. Please check your network and retry.',
  'desktop.error.updateChecksumFailed':
    'SHA-256 verification failed or SHA256SUMS.txt is missing. Temporary files have been removed.',
  'desktop.error.pluginOpFailed':
    'Host plugin operation failed. Close the target host application and retry.',

  'desktop.plugin.installBtn': 'Install Plugin',
  'desktop.plugin.syncBtn': 'Sync to v{version}',
  'desktop.plugin.uninstallBtn': 'Uninstall Plugin',
  'desktop.plugin.confirmInstallTitle': 'Confirm Plugin Install / Sync',
  'desktop.plugin.confirmUninstallTitle': 'Confirm Plugin Uninstall',
  'desktop.plugin.confirmInstallBody':
    'Install or synchronize the Memloom plugin for {target}. This never deletes or overwrites your memory data (memory.json) or user settings. Restart the host to take effect.',
  'desktop.plugin.confirmUninstallBody':
    'Remove the Memloom plugin files from {target}. Your memory data (memory.json) and backups are preserved untouched. Restart the host to take effect.',
  'desktop.plugin.confirmInstallAction': 'Confirm Install',
  'desktop.plugin.confirmUninstallAction': 'Confirm Uninstall',
  'desktop.plugin.installSuccess': 'Plugin installed / synced. Restart the host app to apply.',
  'desktop.plugin.uninstallSuccess':
    'Plugin uninstalled. Memory data was preserved. Restart the host app to apply.',
  'desktop.plugin.dshProfileLabel': 'Target DSH Profile',
  'desktop.plugin.noDshProfiles':
    'No local DSH profile detected. Launch DSH once to initialize your profile.',
  'desktop.plugin.dshRunningBlock':
    'DSH is running or uncertain. Close DSH before installing or uninstalling DSH plugins.',
  'desktop.plugin.dshCliLabel': 'DSH CLI Path',
  'desktop.plugin.dshCliAuto': 'Auto-detect from PATH',
  'desktop.plugin.dshCliPick': 'Select dsh CLI…',
  'desktop.plugin.dshCliClear': 'Clear',
  'desktop.plugin.dshCliSaved': 'Saved custom DSH CLI path.',
  'desktop.plugin.dshCliCleared': 'Restored automatic DSH CLI detection.',

  'desktop.updater.checkBtn': 'Check Updates',
  'desktop.updater.title': 'App Updates & Plugin Sync',
  'desktop.updater.currentVersion': 'Current version',
  'desktop.updater.latestVersion': 'Latest version',
  'desktop.updater.upToDate': 'You are on the latest version.',
  'desktop.updater.updateAvailable': 'New version v{version} available',
  'desktop.updater.recheck': 'Check Again',
  'desktop.updater.updateNow': 'Update Now',
  'desktop.updater.updateOnlinePlugins': 'Update Installed Plugins',
  'desktop.updater.cancelDownload': 'Cancel Download',
  'desktop.updater.openRelease': 'Open GitHub Release',
  'desktop.updater.releaseNotes': 'Release Notes',
  'desktop.updater.syncTargetsTitle': 'Installed hosts to sync after restart',
  'desktop.updater.noInstalledTargets': 'No enabled host plugins to sync.',
  'desktop.updater.localBridgeHint':
    'Running in unsigned local mode (start:desktop). Rebuild from source or download the installer on GitHub for the app itself; you can update installed host plugins online below.',
  'desktop.updater.syncBannerRunning': 'Synchronizing bundled plugins to installed hosts…',
  'desktop.updater.syncBannerFailed':
    'Some host plugins failed to sync ({details}). Close DSH and retry.',
  'desktop.updater.retrySync': 'Retry Sync',
  'desktop.updater.dismissSync': 'Dismiss',
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
  'desktop/busy': 'desktop.error.busy',
  'desktop/dsh-running': 'desktop.error.dshRunning',
  'desktop/dsh-cli-missing': 'desktop.error.dshCliMissing',
  'desktop/update-network': 'desktop.error.updateNetwork',
  'desktop/update-checksum-failed': 'desktop.error.updateChecksumFailed',
  'desktop/plugin-op-failed': 'desktop.error.pluginOpFailed',
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
      (code === 'desktop/store-corrupt' ||
        code === 'desktop/internal' ||
        code === 'desktop/update-network') &&
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
