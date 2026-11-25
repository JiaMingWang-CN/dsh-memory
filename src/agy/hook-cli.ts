/**
 * Unified AGY Hook CLI entrypoint handling `PreInvocation`, `PreToolUse`, and `Stop`.
 *
 * Verified AGY PreToolUse / `overwrite` / `transcript.jsonl` contract (Spec §5.3):
 * - Common stdin camelCase fields: `conversationId`, `workspacePaths`, `transcriptPath`,
 *   `artifactDirectoryPath`, `modelName`, `lastUserInput`, `hookEventName`, `cwd`,
 *   plus `toolCall: { id, name, args }` and `stepIdx` on `PreToolUse`.
 * - Direct/eager MCP calls arrive as `toolCall.name = "mcp_<server>_<tool>"` (or
 *   `dsh-memory_memory_*` / `memory_*`) with top-level parameters in `toolCall.args`.
 *   `overwrite: { __agyHostContext: ... }` shallow-merges into `toolCall.args`.
 * - Wrapped/lazy `call_mcp_tool` calls arrive as `toolCall.name = "call_mcp_tool"`
 *   with `toolCall.args = { ServerName, ToolName, Arguments }` (or lowercase variants).
 *   Because AGY `overwrite` performs a top-level shallow merge on `toolCall.args`
 *   (nested objects are replaced wholesale, not deep-merged), injecting host context
 *   for `call_mcp_tool` MUST replace the entire wrapper arguments key:
 *   `overwrite: { [wrapperArgsKey]: { ...innerArgs, __agyHostContext } }`.
 * - `hooks.json` `PreToolUse` matcher `".*memory_.*|call_mcp_tool"` matches both forms.
 *
 * Failure policy (Spec §5.7):
 * - `PreInvocation` & `Stop`: fail-open (`{}`), logging redacted diagnostics to
 *   `${PLUGIN_DATA}/logs/hook-errors.log` (size-rotated). `Stop` NEVER returns `continue`.
 * - `PreToolUse` on any memory tool: fail-closed (`decision: "force_ask"`).
 * @module dsh-memory/agy/hook-cli
 */
import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryEngine } from '../core/engine.ts'
import {
  foldIndexSources,
  foldRawIndexSources,
  planIndexRefresh,
  resetInvalidations,
} from '../core/index-protocol.ts'
import {
  PROTOCOL_VERSION,
  baselineIdOf,
  composeMemoryIndex,
  renderBaseline,
  renderReset,
  type MemoryIndexSourceService,
} from '../core/indexing.ts'
import { OperationError } from '../core/operations.ts'
import { redactSecrets } from '../core/redact.ts'
import { normalizeWorkspaceKey } from '../core/workspace.ts'
import { MemoryId, type MemoryIndexSource } from '../shared/types.ts'
import { AgyConfigStore } from './config-store.ts'
import { resolveAgyDataPaths } from './paths.ts'
import { AgySessionStateStore } from './session-state.ts'
import { FileMemoryDomain } from './storage.ts'
import { REGULAR_TOOL_NAMES, SENSITIVE_TOOL_NAMES } from './tools.ts'
import { captureAgyTranscript, extractUserRequestText } from './transcript-capture.ts'
import {
  HOST_CONTEXT_ARG_KEY,
  createHostContextNonce,
  type HostContextPayload,
} from './workspace-resolver.ts'

const MAX_LOG_BYTES = 256 * 1024

const REGULAR_TOOL_SET = new Set<string>(REGULAR_TOOL_NAMES)
const SENSITIVE_TOOL_SET = new Set<string>(SENSITIVE_TOOL_NAMES)
const ALL_KNOWN_TOOLS: readonly string[] = [...REGULAR_TOOL_NAMES, ...SENSITIVE_TOOL_NAMES].sort(
  (left, right) => right.length - left.length,
)

/** Resolved memory tool target from an AGY `PreToolUse` `toolCall` payload. */
export interface ResolvedHookTargetTool {
  toolName: string
  toolArgs: Record<string, unknown>
  wrapped: boolean
  wrapperArgsKey?: 'Arguments' | 'arguments'
}

interface InternalTargetResolution {
  target?: ResolvedHookTargetTool
  isMemoryTool: boolean
  memoryToolName?: string
  malformedArgs: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAbsoluteWorkspacePath(rawPath: string): boolean {
  return path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath)
}

function canonicalMemoryToolName(rawName: string): string | undefined {
  const trimmed = rawName.trim()
  for (const known of ALL_KNOWN_TOOLS) {
    if (
      trimmed === known ||
      trimmed.endsWith(`_${known}`) ||
      trimmed.endsWith(`:${known}`) ||
      trimmed.endsWith(`/${known}`) ||
      trimmed.endsWith(`.${known}`)
    ) {
      return known
    }
  }
  return undefined
}

function parseObjectOrJson(raw: unknown): {
  ok: boolean
  value: Record<string, unknown>
} {
  if (raw === undefined) return { ok: true, value: {} }
  if (isPlainObject(raw)) return { ok: true, value: raw }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return { ok: true, value: {} }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isPlainObject(parsed)) return { ok: true, value: parsed }
    } catch {
      return { ok: false, value: {} }
    }
  }
  return { ok: false, value: {} }
}

function unwrapToolNameString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      return parsed.trim()
    }
  } catch {
    // Plain string value.
  }
  return trimmed
}

function isMemoryServerName(serverName: string | undefined): boolean {
  if (serverName === undefined) return true
  const trimmed = serverName.trim()
  if (trimmed.length === 0) return true
  return /^(?:dsh-memory[_:-])?memory$/i.test(trimmed) || /dsh-memory/i.test(trimmed)
}

function resolveTargetDetailed(
  toolCall: { name?: unknown; args?: unknown } | undefined,
): InternalTargetResolution {
  if (toolCall === undefined || typeof toolCall.name !== 'string') {
    return { isMemoryTool: false, malformedArgs: false }
  }
  const rawName = toolCall.name.trim()
  if (rawName.length === 0) {
    return { isMemoryTool: false, malformedArgs: false }
  }

  // Direct MCP memory tool call
  const directCanonical = canonicalMemoryToolName(rawName)
  if (directCanonical !== undefined) {
    const parsedArgs = parseObjectOrJson(toolCall.args)
    return {
      isMemoryTool: true,
      memoryToolName: directCanonical,
      malformedArgs: !parsedArgs.ok,
      target: {
        toolName: directCanonical,
        toolArgs: parsedArgs.value,
        wrapped: false,
      },
    }
  }

  // Wrapped lazy `call_mcp_tool`
  if (rawName === 'call_mcp_tool' || rawName.endsWith('_call_mcp_tool')) {
    const outerParsed = parseObjectOrJson(toolCall.args)
    if (!outerParsed.ok) {
      const rawHint = typeof toolCall.args === 'string' ? toolCall.args : ''
      if (/memory_/i.test(rawHint) && !/ServerName/i.test(rawHint)) {
        return { isMemoryTool: true, memoryToolName: 'call_mcp_tool', malformedArgs: true }
      }
      if (/dsh-memory/i.test(rawHint)) {
        return { isMemoryTool: true, memoryToolName: 'call_mcp_tool', malformedArgs: true }
      }
      return { isMemoryTool: false, malformedArgs: false }
    }

    const outer = outerParsed.value
    const serverName =
      unwrapToolNameString(outer.ServerName) ?? unwrapToolNameString(outer.serverName)
    if (!isMemoryServerName(serverName)) {
      return { isMemoryTool: false, malformedArgs: false }
    }
    const innerRawName =
      unwrapToolNameString(outer.ToolName) ?? unwrapToolNameString(outer.toolName)
    if (innerRawName === undefined) {
      return { isMemoryTool: false, malformedArgs: false }
    }

    const wrappedCanonical = canonicalMemoryToolName(innerRawName)
    if (wrappedCanonical === undefined) {
      return { isMemoryTool: false, malformedArgs: false }
    }

    const wrapperArgsKey: 'Arguments' | 'arguments' =
      'Arguments' in outer ? 'Arguments' : 'arguments' in outer ? 'arguments' : 'Arguments'
    const innerParsed = parseObjectOrJson(outer[wrapperArgsKey])

    return {
      isMemoryTool: true,
      memoryToolName: wrappedCanonical,
      malformedArgs: !innerParsed.ok,
      target: {
        toolName: wrappedCanonical,
        toolArgs: innerParsed.value,
        wrapped: true,
        wrapperArgsKey,
      },
    }
  }

  return { isMemoryTool: false, malformedArgs: false }
}

/**
 * Resolve a `PreToolUse` `toolCall` into a canonical `dsh-memory` tool target.
 * Supports both direct MCP tool names (`*memory_<known>`) and wrapped
 * `call_mcp_tool` payloads (`ToolName`/`toolName` + `Arguments`/`arguments`).
 */
export function resolveHookTargetTool(
  toolCall: { name?: unknown; args?: unknown } | undefined,
): ResolvedHookTargetTool | undefined {
  const detail = resolveTargetDetailed(toolCall)
  if (!detail.isMemoryTool || detail.target === undefined) return undefined
  return detail.target
}

function extractWorkspaceRoot(payload: Record<string, unknown>): string | undefined {
  if (Array.isArray(payload.workspacePaths)) {
    for (const entry of payload.workspacePaths) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        return entry.trim()
      }
    }
  }
  if (typeof payload.cwd === 'string' && payload.cwd.trim().length > 0) {
    return payload.cwd.trim()
  }
  return undefined
}

function extractConversationId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.conversationId === 'string' && payload.conversationId.trim().length > 0) {
    return payload.conversationId.trim()
  }
  return undefined
}

function isSubagentPayload(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  if (payload.subagent === true || payload.isSubagent === true) return true
  if (typeof payload.delegationDepth === 'number' && payload.delegationDepth > 0) return true
  if (
    typeof payload.parentConversationId === 'string' &&
    payload.parentConversationId.trim().length > 0
  ) {
    return true
  }
  const envFlag = env.AGY_SUBAGENT?.trim().toLowerCase()
  return envFlag === '1' || envFlag === 'true'
}

function parseLockTimeoutOverride(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.DSH_MEMORY_LOCK_TIMEOUT_MS?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  return undefined
}

async function logHookError(logPath: string, eventName: string, error: unknown): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    const stat = await fs.stat(logPath).catch(() => null)
    if (stat !== null && stat.size >= MAX_LOG_BYTES) {
      await fs.rename(logPath, `${logPath}.1`).catch(() => {})
    }
    const rawMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const redacted = redactSecrets(rawMsg).replace(/\r?\n/g, ' ')
    const line = `[${new Date().toISOString()}] [${eventName}] ${redacted}\n`
    await fs.appendFile(logPath, line, 'utf8')
  } catch {
    // Diagnostic logging must never throw or block a hook.
  }
}

function describeScopeLabel(args: Record<string, unknown>): string {
  const scope = args.scope ?? args.targetScope
  const ws = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : undefined
  if (scope === 'all') return '全部工作区 (all)'
  if (ws !== undefined) return `工作区 ${ws}`
  if (scope === 'global') return '全局 (global)'
  if (scope === 'workspace') return '当前工作区 (workspace)'
  return '当前作用域'
}

function requestsScopeOverride(
  toolArgs: Record<string, unknown>,
  currentWorkspaceKey: string | null,
): { escalated: boolean; reasons: string[] } {
  const reasons: string[] = []
  const scope = toolArgs.scope ?? toolArgs.targetScope
  if (scope === 'all') {
    reasons.push('跨全部工作区范围（scope="all"）')
  } else if (scope !== undefined && typeof scope !== 'string') {
    reasons.push('scope 参数格式异常')
  }

  if (toolArgs.workspaceRoot !== undefined) {
    if (typeof toolArgs.workspaceRoot !== 'string' || toolArgs.workspaceRoot.trim().length === 0) {
      reasons.push('workspaceRoot 参数格式异常')
    } else {
      const targetRoot = toolArgs.workspaceRoot.trim()
      const targetKey = isAbsoluteWorkspacePath(targetRoot)
        ? normalizeWorkspaceKey(targetRoot)
        : null
      if (targetKey === null || currentWorkspaceKey === null || targetKey !== currentWorkspaceKey) {
        reasons.push(`跨工作区访问（workspaceRoot="${targetRoot}"）`)
      }
    }
  }

  if (isPlainObject(toolArgs.mapping)) {
    for (const target of Object.values(toolArgs.mapping)) {
      if (isPlainObject(target) && typeof target.key === 'string') {
        const targetKey = normalizeWorkspaceKey(target.key)
        if (currentWorkspaceKey === null || targetKey !== currentWorkspaceKey) {
          reasons.push(`跨工作区导入映射（${target.key}）`)
          break
        }
      }
    }
  }

  return { escalated: reasons.length > 0, reasons }
}

function buildSensitiveReason(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'memory_review': {
      if (Array.isArray(args.items)) {
        const acceptCount = args.items.filter(
          (item) => isPlainObject(item) && item.action === 'accept',
        ).length
        const rejectCount = args.items.filter(
          (item) => isPlainObject(item) && item.action === 'reject',
        ).length
        return `批量审阅 ${args.items.length} 条待审核记忆提案（批准 ${acceptCount} 条，拒绝 ${rejectCount} 条）；批准后将归档被替代旧记忆并提升为用户拥有。`
      }
      const actionLabel = args.action === 'reject' ? '拒绝' : '批准'
      const idLabel = typeof args.id === 'string' ? args.id : '<未指定>'
      return `${actionLabel}待审核记忆提案 ${idLabel}；批准后将归档被替代旧记忆并提升为用户拥有。`
    }
    case 'memory_restore': {
      const idLabel = typeof args.id === 'string' ? args.id : '<未指定>'
      return `恢复已归档记忆 ${idLabel} 为活跃状态并提升为用户拥有。`
    }
    case 'memory_delete': {
      const idLabel = typeof args.id === 'string' ? args.id : '<未指定>'
      const revLabel =
        typeof args.expectedContentRevision === 'number'
          ? `（rev=${args.expectedContentRevision}）`
          : ''
      return `【高风险·不可逆】永久物理删除记忆 ${idLabel}${revLabel}，并清除历史审计正文快照。`
    }
    case 'memory_undo_dream': {
      const dreamId = typeof args.dreamId === 'string' ? args.dreamId : '<未指定>'
      return `撤销整理任务 ${dreamId} 提交的记忆变更。`
    }
    case 'memory_import': {
      const mode = args.mode === 'replace' ? 'replace' : 'merge'
      const scopeLabel = describeScopeLabel(args)
      const pathHint = typeof args.inputPath === 'string' ? `（文件：${args.inputPath}）` : ''
      if (mode === 'replace') {
        return `【高风险·清空覆盖】以 replace 模式导入记忆${pathHint}，目标作用域：${scopeLabel}，将清空该作用域内现有记忆！`
      }
      return `以 merge 模式导入记忆数据${pathHint}。`
    }
    case 'memory_rebuild': {
      return `重建${describeScopeLabel(args)}的派生记忆与缓存（保留用户拥有记忆，重置片段与会话游标）。`
    }
    case 'memory_purge': {
      const confirmHint =
        typeof args.confirmText === 'string' ? `，确认口令：${args.confirmText}` : ''
      return `【高风险·不可逆】永久清空${describeScopeLabel(args)}内的全部记忆、片段与会话游标${confirmHint}。`
    }
    case 'memory_config': {
      const keys = Object.keys(args).filter((k) => k !== HOST_CONTEXT_ARG_KEY)
      const risks: string[] = []
      if (args.redactSecrets === false) {
        risks.push('关闭密钥自动脱敏 redactSecrets')
      }
      if (args.autoAcceptProposals === true) {
        risks.push('开启自动批准提案 autoAcceptProposals（跳过人工审阅）')
      }
      if (args.injectForSubagents === true) {
        risks.push('开启子代理记忆注入 injectForSubagents')
      }
      if (keys.some((k) => k.startsWith('max'))) {
        risks.push('调整存储容量上限')
      }
      const keySummary = keys.length > 0 ? keys.join(', ') : '无字段'
      const riskPrefix = risks.length > 0 ? `【安全风险：${risks.join('；')}】` : ''
      return `${riskPrefix}修改记忆插件运行配置（${keySummary}）并立即热生效。`
    }
    default:
      return `执行敏感记忆管理操作 ${toolName}，请确认后放行。`
  }
}

function buildOverwrite(
  target: ResolvedHookTargetTool,
  hostContext: HostContextPayload,
): Record<string, unknown> {
  if (target.wrapped) {
    const key = target.wrapperArgsKey ?? 'Arguments'
    return {
      [key]: {
        ...target.toolArgs,
        [HOST_CONTEXT_ARG_KEY]: hostContext,
      },
    }
  }
  return {
    [HOST_CONTEXT_ARG_KEY]: hostContext,
  }
}

async function handlePreInvocation(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const paths = resolveAgyDataPaths(env)
  try {
    const configStore = new AgyConfigStore(paths.configPath)
    const config = await configStore.load()
    if (config.enabled === false) return {}
    if (isSubagentPayload(payload, env) && config.injectForSubagents !== true) return {}

    const conversationId = extractConversationId(payload)
    const workspaceRoot = extractWorkspaceRoot(payload)
    const workspaceKey =
      workspaceRoot !== undefined && isAbsoluteWorkspacePath(workspaceRoot)
        ? normalizeWorkspaceKey(workspaceRoot)
        : null
    const scopeKey = workspaceKey ?? ''
    const now = new Date()

    const sessionStore = new AgySessionStateStore(paths.sessionsDir)
    const existingState =
      conversationId !== undefined ? await sessionStore.read(conversationId) : undefined
    const expectedBaselineId = baselineIdOf(scopeKey, config.indexMaxBytes)
    const folded =
      existingState !== undefined
        ? foldIndexSources(existingState.indexSources, scopeKey, expectedBaselineId)
        : undefined

    // FAST-SKIP PATH (Review Focus #5): when a baseline for the same scopeKey &
    // baselineId is already recorded and refreshIndexOnChange is false, return {}
    // immediately WITHOUT opening or reading memory.json.
    if (folded !== undefined && config.refreshIndexOnChange !== true) {
      if (conversationId !== undefined && existingState !== undefined) {
        if (existingState.workspaceRoot !== workspaceRoot) {
          await sessionStore.write({
            ...existingState,
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
            scopeKey,
            updatedAt: now.toISOString(),
          })
        }
      }
      return {}
    }

    const lockTimeoutMs = parseLockTimeoutOverride(env)
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
      onWarn: (msg) => void logHookError(paths.logPath, 'storage', msg),
      ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    })
    const engine = new MemoryEngine({ domain, config, now: () => now })
    const readOnlyIndexService: MemoryIndexSourceService = {
      activeInScope: (targetWorkspaceKey) => engine.activeInScope(targetWorkspaceKey),
      search: (request) => engine.search(request),
      read: (id, targetWorkspaceKey) => {
        const record = domain.table('memories').get(MemoryId(id))
        if (record === undefined || record.status !== 'active') {
          throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
        }
        const visible =
          record.scope.kind === 'global'
            ? record.type === 'preference'
            : targetWorkspaceKey !== null && record.scope.key === targetWorkspaceKey
        if (!visible) {
          throw new OperationError(
            'MEMORY_FORBIDDEN_SCOPE',
            `memory '${id}' is not visible in the current scope`,
          )
        }
        return structuredClone(record)
      },
    }

    const rawUserInput = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : ''
    const queryText = rawUserInput.length > 0 ? extractUserRequestText(rawUserInput) : ''

    const snapshot = composeMemoryIndex({
      service: readOnlyIndexService,
      workspaceKey,
      queryText,
      indexMaxBytes: config.indexMaxBytes,
      now: () => now,
    })

    const saveState = async (indexSources: MemoryIndexSource[]): Promise<void> => {
      if (conversationId === undefined) return
      await sessionStore.write({
        conversationId,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        scopeKey,
        indexSources,
        captureTurn: existingState?.captureTurn ?? 0,
        ...(existingState?.previousAssistantText === undefined
          ? {}
          : { previousAssistantText: existingState.previousAssistantText }),
        updatedAt: now.toISOString(),
      })
    }

    // Case 1: First baseline injection for this conversation
    if (existingState === undefined || existingState.indexSources.length === 0) {
      const baselineSource: MemoryIndexSource = {
        kind: 'dsh-memory',
        form: 'memory-index',
        mode: 'baseline',
        protocolVersion: PROTOCOL_VERSION,
        baselineId: snapshot.baselineId,
        scopeKey: snapshot.scopeKey,
        changes: snapshot.entries.map((entry) => ({
          action: 'add' as const,
          memoryId: entry.memoryId,
          contentRevision: entry.contentRevision,
          digest: entry.digest,
        })),
        invalidations: [],
      }
      await saveState([baselineSource])
      if (snapshot.entries.length === 0) {
        return {}
      }
      const renderedText = renderBaseline(snapshot, config.indexMaxBytes)
      return {
        injectSteps: [{ systemMessage: { systemMessage: renderedText } }],
      }
    }

    // Case 2: Scope or baseline identity changed -> full reset
    if (folded === undefined) {
      const prevVisible = foldRawIndexSources(
        existingState.indexSources.map((source) => ({ source })),
      )
      const invalidations =
        prevVisible === undefined ? [] : resetInvalidations(prevVisible, snapshot)
      const renderedText = renderReset(snapshot, config.indexMaxBytes, invalidations)
      const resetSource: MemoryIndexSource = {
        kind: 'dsh-memory',
        form: 'memory-index',
        mode: 'reset',
        protocolVersion: PROTOCOL_VERSION,
        baselineId: snapshot.baselineId,
        scopeKey: snapshot.scopeKey,
        changes: snapshot.entries.map((entry) => ({
          action: 'add' as const,
          memoryId: entry.memoryId,
          contentRevision: entry.contentRevision,
          digest: entry.digest,
        })),
        invalidations,
        refreshBytes: 0,
        refreshedAt: now.toISOString(),
      }
      await saveState([resetSource])
      if (snapshot.entries.length === 0 && invalidations.length === 0) {
        return {}
      }
      return {
        injectSteps: [{ systemMessage: { systemMessage: renderedText } }],
      }
    }

    // Case 3: refreshIndexOnChange === true -> plan delta or reset
    const plan = planIndexRefresh({
      visible: folded,
      target: snapshot,
      budget: {
        refreshMaxBytes: config.refreshMaxBytes,
        refreshResetBytes: config.refreshResetBytes,
        refreshMinIntervalMs: config.refreshMinIntervalMs,
      },
      now,
    })

    if (
      plan.mode === 'none' ||
      plan.source === undefined ||
      (!plan.urgent && plan.withinInterval)
    ) {
      await saveState(existingState.indexSources)
      return {}
    }

    const nextSources =
      plan.mode === 'reset' ? [plan.source] : [...existingState.indexSources, plan.source]
    await saveState(nextSources)
    return {
      injectSteps: [{ systemMessage: { systemMessage: plan.renderedText } }],
    }
  } catch (error) {
    await logHookError(paths.logPath, 'PreInvocation', error)
    return {}
  }
}

async function handlePreToolUse(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const rawToolCall = isPlainObject(payload.toolCall)
    ? (payload.toolCall as { name?: unknown; args?: unknown })
    : undefined

  const detail = resolveTargetDetailed(rawToolCall)
  if (!detail.isMemoryTool) {
    return {}
  }

  const paths = resolveAgyDataPaths(env)
  try {
    if (detail.malformedArgs || detail.target === undefined) {
      return {
        decision: 'force_ask',
        reason: `记忆工具 ${detail.memoryToolName ?? 'memory'} 参数格式异常，已按安全默认触发人工确认，请核对调用参数。`,
      }
    }

    const target = detail.target
    const workspaceRoot = extractWorkspaceRoot(payload)
    const currentWorkspaceKey =
      workspaceRoot !== undefined ? normalizeWorkspaceKey(workspaceRoot) : null
    const conversationId = extractConversationId(payload)
    const nonce = await createHostContextNonce(paths.dataDir)

    const scopeCheck = requestsScopeOverride(target.toolArgs, currentWorkspaceKey)

    // 8 sensitive management tools: ALWAYS force_ask
    if (SENSITIVE_TOOL_SET.has(target.toolName)) {
      const hostContext: HostContextPayload = {
        nonce,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(scopeCheck.escalated ? { approvedScopeOverride: true } : {}),
      }
      return {
        decision: 'force_ask',
        reason: buildSensitiveReason(target.toolName, target.toolArgs),
        overwrite: buildOverwrite(target, hostContext),
      }
    }

    // 12 regular tools: conditional escalation on memory_list / memory_export
    if (REGULAR_TOOL_SET.has(target.toolName)) {
      const escalationReasons: string[] = []
      if (target.toolName === 'memory_list' || target.toolName === 'memory_export') {
        escalationReasons.push(...scopeCheck.reasons)
      }
      if (target.toolName === 'memory_export' && target.toolArgs.outputPath !== undefined) {
        const outStr =
          typeof target.toolArgs.outputPath === 'string'
            ? target.toolArgs.outputPath
            : String(target.toolArgs.outputPath)
        escalationReasons.push(`导出写入本地文件（outputPath="${outStr}"）`)
      }

      const escalated = escalationReasons.length > 0
      const hostContext: HostContextPayload = {
        nonce,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(escalated ? { approvedScopeOverride: true } : {}),
      }
      const overwrite = buildOverwrite(target, hostContext)

      if (escalated) {
        return {
          decision: 'force_ask',
          reason: `调用 ${target.toolName} 触发安全升级：${escalationReasons.join('；')}，请确认后放行。`,
          overwrite,
        }
      }

      return {
        decision: 'allow',
        overwrite,
      }
    }

    // Unknown memory-prefixed tool -> fail-closed
    return {
      decision: 'force_ask',
      reason: `未知记忆工具 ${target.toolName}，已按 fail-closed 策略触发人工确认。`,
    }
  } catch (error) {
    await logHookError(paths.logPath, 'PreToolUse', error)
    return {
      decision: 'force_ask',
      reason: `记忆工具 ${detail.memoryToolName ?? 'memory'} 安全门禁校验异常，已按 fail-closed 策略触发人工确认。`,
    }
  }
}

async function handleStop(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const paths = resolveAgyDataPaths(env)
  try {
    const configStore = new AgyConfigStore(paths.configPath)
    const config = await configStore.load()
    if (config.enabled === false || config.autoCaptureEpisodes === false) {
      return {}
    }

    const transcriptPath =
      typeof payload.transcriptPath === 'string' ? payload.transcriptPath.trim() : ''
    const conversationId = extractConversationId(payload)
    const workspaceRoot = extractWorkspaceRoot(payload)

    if (
      transcriptPath.length === 0 ||
      conversationId === undefined ||
      workspaceRoot === undefined
    ) {
      return {}
    }

    const lockTimeoutMs = parseLockTimeoutOverride(env)
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
      onWarn: (msg) => void logHookError(paths.logPath, 'storage', msg),
      ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    })

    const engine = new MemoryEngine({ domain, config })
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)
    const terminationReason =
      typeof payload.terminationReason === 'string' ? payload.terminationReason : undefined
    const error = typeof payload.error === 'string' ? payload.error : undefined
    const subagent = isSubagentPayload(payload, env)

    await domain.withWriteLock(async () => {
      await captureAgyTranscript({
        transcriptPath,
        conversationId,
        workspaceRoot,
        ...(terminationReason === undefined ? {} : { terminationReason }),
        ...(error === undefined ? {} : { error }),
        ...(subagent ? { subagent: true } : {}),
        domain,
        engine,
        sessionStore,
        config,
      })
    })
    return {}
  } catch (error) {
    await logHookError(paths.logPath, 'Stop', error)
    return {}
  }
}

/**
 * Dispatch an AGY Hook JSON payload to `PreInvocation`, `PreToolUse`, or `Stop`.
 */
export async function handleHookEvent(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const eventName = typeof payload.hookEventName === 'string' ? payload.hookEventName : undefined

  if (eventName === 'PreInvocation') {
    return await handlePreInvocation(payload, env)
  }
  if (eventName === 'PreToolUse') {
    return await handlePreToolUse(payload, env)
  }
  if (eventName === 'Stop') {
    return await handleStop(payload, env)
  }

  // Fallback shape detection when hookEventName is absent
  if (payload.toolCall !== undefined) {
    return await handlePreToolUse(payload, env)
  }
  if ('terminationReason' in payload || 'continuationActive' in payload || 'fullyIdle' in payload) {
    return await handleStop(payload, env)
  }
  if ('lastUserInput' in payload || 'workspacePaths' in payload) {
    return await handlePreInvocation(payload, env)
  }

  return {}
}

async function readAllUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Execute the Hook CLI over stdin/stdout streams: reads full JSON from `input`
 * and emits a single-line JSON decision to `output`.
 */
export async function runHookCli(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const raw = await readAllUtf8(input)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const paths = resolveAgyDataPaths(env)
    await logHookError(paths.logPath, 'stdin', error)
    const isPreToolUseMemory =
      /"hookEventName"\s*:\s*"PreToolUse"/i.test(raw) && /(?:memory_|call_mcp_tool)/i.test(raw)
    const fallback = isPreToolUseMemory
      ? {
          decision: 'force_ask',
          reason: 'PreToolUse Hook 输入 JSON 解析失败，已按 fail-closed 策略触发人工确认。',
        }
      : {}
    output.write(`${JSON.stringify(fallback)}\n`)
    return
  }

  if (!isPlainObject(parsed)) {
    output.write('{}\n')
    return
  }

  const response = await handleHookEvent(parsed, env)
  output.write(`${JSON.stringify(response)}\n`)
}

function sameFileUrl(candidatePath: string, moduleUrl: string): boolean {
  const candidateUrl = pathToFileURL(candidatePath).href
  if (candidateUrl === moduleUrl) return true
  if (process.platform === 'win32' && candidateUrl.toLowerCase() === moduleUrl.toLowerCase()) {
    return true
  }
  return false
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try {
    const resolved = path.resolve(entry)
    if (sameFileUrl(resolved, import.meta.url)) return true
    const real = realpathSync(resolved)
    return sameFileUrl(real, import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  void runHookCli().catch(() => {
    process.stdout.write('{}\n')
  })
}
