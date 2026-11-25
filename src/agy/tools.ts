/**
 * Tiered AGY MCP memory tools (12 regular + 8 sensitive management tools).
 *
 * Enforces disk/config synchronization before reads, cross-process write locking
 * around mutations, strict global-only degradation without a workspace, explicit
 * approval gates for cross-workspace/export-write operations, and AGY-only hot
 * configuration updates.
 * @module dsh-memory/agy/tools
 */
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  AGY_EDITABLE_CONFIG_FIELDS,
  validateMemoryConfigPatch,
  type MemoryConfig,
} from '../core/config.ts'
import type { MemoryEngine, RawDreamProposalInput } from '../core/engine.ts'
import type { ExportScope, ImportOptions, MemoryExport } from '../core/exchange.ts'
import { OperationError, type OperationErrorCode } from '../core/operations.ts'
import { normalizeWorkspaceKey } from '../core/workspace.ts'
import { DreamId, memoryStatusSchema, memoryTypeSchema, type MemoryScope } from '../shared/types.ts'
import type { AgyConfigStore } from './config-store.ts'
import type { AgySessionStateStore } from './session-state.ts'
import { readFileWithRetry, type FileMemoryDomain } from './storage.ts'
import { HOST_CONTEXT_ARG_KEY, type ResolvedCallContext } from './workspace-resolver.ts'

/** 12 regular model-facing memory tools (no mandatory confirmation unless scope-escalated). */
export const REGULAR_TOOL_NAMES = [
  'memory_search',
  'memory_read',
  'memory_write',
  'memory_forget',
  'memory_list',
  'memory_status',
  'memory_audit',
  'memory_export',
  'memory_dream_prepare',
  'memory_dream_commit',
  'memory_organize_prepare',
  'memory_organize_commit',
] as const

/** 8 sensitive management tools (always gated by `PreToolUse` `decision: "force_ask"`). */
export const SENSITIVE_TOOL_NAMES = [
  'memory_review',
  'memory_restore',
  'memory_delete',
  'memory_undo_dream',
  'memory_import',
  'memory_rebuild',
  'memory_purge',
  'memory_config',
] as const

/** MCP tool definition registered by the AGY adapter. */
export interface AgyToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly sensitive: boolean
  execute(rawArgs: Record<string, unknown>, ctx: ResolvedCallContext): Promise<unknown>
}

export interface CreateAgyToolsDeps {
  domain: FileMemoryDomain
  engine: MemoryEngine
  configStore: AgyConfigStore
  sessionStore: AgySessionStateStore
  dataDir: string
}

const EDITABLE_CONFIG_KEY_SET = new Set<string>(AGY_EDITABLE_CONFIG_FIELDS)

const MEMORY_WRITE_DESCRIPTION =
  'Create or update one long-term memory. Write only durable knowledge the environment cannot give back: reusable rules, verified approaches, pitfalls and stable user preferences. Do not write task progress, completed actions, code or file contents, current config values, git history or command output. Never copy, paraphrase or summarize already auto-loaded project instructions or docs (such as AGENTS.md, CLAUDE.md, README or the injected skills list). When given a broad request to perform memory operations and the current session has no new discoveries, pitfalls, decisions or user corrections, do not copy existing docs to fill the store. Keep each memory concise and focused on a single independent topic with a searchable title; never bundle unrelated modules or constraints into one long note. Search first and update an existing memory (id + expectedContentRevision) instead of duplicating it. Explicit writes are active immediately. Literal \\n sequences in title or body are normalized to real newlines when the text has no real newlines. Strong secrets (private keys, API keys, tokens) are refused; record where the credential is configured instead.'

const naturalInt = () => z.number().int().nonnegative()

const memorySearchSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        'Search keywords. Omit or leave empty to list visible active memories by priority.',
      ),
    type: memoryTypeSchema.optional().describe('Restrict results to one memory type.'),
    tags: z.array(z.string().min(1)).optional().describe('Require every listed tag to match.'),
    scope: z
      .enum(['auto', 'workspace', 'global'])
      .optional()
      .describe(
        'auto: current workspace + global (default); workspace: current workspace only; global: global preferences only.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of hits (1-50, default 20).'),
  })
  .strict()

const memoryReadSchema = z
  .object({
    id: z.string().min(1).describe('Memory id to read in full.'),
    includeNonActive: z
      .boolean()
      .optional()
      .describe(
        'Set true to inspect pending or archived memories for review/audit without incrementing useCount.',
      ),
  })
  .strict()

const memoryWriteSchema = z
  .object({
    id: z.string().min(1).optional().describe('Existing memory id to update; omit to create.'),
    type: memoryTypeSchema.describe('Memory type.'),
    title: z.string().min(1).describe('Short title (1-200 characters).'),
    body: z.string().min(1).describe('Markdown body (1-65536 bytes).'),
    scope: z
      .enum(['workspace', 'global'])
      .optional()
      .describe('workspace (default when a workspace exists) or global (preferences only).'),
    tags: z.array(z.string()).optional().describe('Optional tags.'),
    importance: z.number().min(0).max(1).optional().describe('Importance in [0, 1].'),
    expectedContentRevision: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Required when updating: the contentRevision last read by the caller.'),
  })
  .strict()

const memoryForgetSchema = z
  .object({
    id: z.string().min(1).describe('Memory id to archive.'),
    reason: z.string().optional().describe('Optional reason recorded for the audit trail.'),
  })
  .strict()

const memoryListSchema = z
  .object({
    scope: z
      .enum(['current', 'workspace', 'global', 'all'])
      .optional()
      .describe(
        'current (default: current workspace + global), workspace, global, or all (requires confirmation).',
      ),
    workspaceRoot: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Explicit workspace root to inspect (cross-workspace access requires confirmation).',
      ),
    status: memoryStatusSchema.optional().describe('Filter by lifecycle status.'),
    type: memoryTypeSchema.optional().describe('Filter by memory type.'),
    tags: z.array(z.string().min(1)).optional().describe('Filter by required tags.'),
    query: z.string().optional().describe('Case-insensitive substring filter.'),
    limit: z.number().int().min(1).max(200).optional().describe('Page size (1-200).'),
    offset: z.number().int().min(0).optional().describe('Pagination offset.'),
    includeExpired: z.boolean().optional().describe('Include expired active records.'),
  })
  .strict()

const memoryStatusToolSchema = z.object({}).strict()

const memoryAuditSchema = z
  .object({
    memoryId: z.string().min(1).optional().describe('Filter audit records by memory id.'),
    dreamId: z.string().min(1).optional().describe('Filter audit records by dream run id.'),
    limit: z.number().int().min(1).max(500).optional().describe('Maximum audit entries (1-500).'),
    offset: z.number().int().min(0).optional().describe('Pagination offset.'),
  })
  .strict()

const memoryExportSchema = z
  .object({
    scope: z
      .enum(['current', 'workspace', 'global', 'all'])
      .optional()
      .describe(
        'current (default: current workspace + global), workspace, global, or all (requires confirmation).',
      ),
    workspaceRoot: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Explicit workspace root to export (cross-workspace access requires confirmation).',
      ),
    includeArchived: z.boolean().optional().describe('Include archived records (default true).'),
    outputPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional destination file path (requires confirmation; never overwrites an existing file).',
      ),
  })
  .strict()

const memoryDreamPrepareSchema = z
  .object({
    scope: z
      .enum(['workspace', 'global'])
      .optional()
      .describe('Target scope for episode consolidation (defaults to workspace when available).'),
    maxEpisodes: z.number().int().min(1).optional().describe('Maximum episodes to claim.'),
    since: z.string().min(1).optional().describe('Only claim episodes at or after this ISO time.'),
    trigger: z.enum(['auto', 'manual', 'rebuild']).optional().describe('Dream trigger label.'),
  })
  .strict()

const dreamProposalSchema = z
  .object({
    type: memoryTypeSchema,
    title: z.string(),
    body: z.string(),
    confidence: z.number(),
    importance: z.number(),
    sourceEpisodeIds: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    supersedes: z.array(z.string()).optional(),
  })
  .strict()

const memoryDreamCommitSchema = z
  .object({
    dreamId: z.string().min(1).describe('Running dream id returned by memory_dream_prepare.'),
    memories: z
      .array(dreamProposalSchema)
      .describe(
        'Structured proposals to stage as pending (empty array marks claimed episodes skipped).',
      ),
  })
  .strict()

const memoryOrganizePrepareSchema = z
  .object({
    scope: z
      .enum(['workspace', 'global'])
      .optional()
      .describe('Target scope for full-store organization (defaults to workspace when available).'),
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe('Maximum active memories to include (1-60).'),
  })
  .strict()

const organizeProposalSchema = z
  .object({
    type: memoryTypeSchema,
    title: z.string(),
    body: z.string(),
    confidence: z.number(),
    importance: z.number(),
    supersedes: z.array(z.string()),
    tags: z.array(z.string()).optional(),
    sourceEpisodeIds: z.array(z.string()).optional(),
  })
  .strict()

const memoryOrganizeCommitSchema = z
  .object({
    dreamId: z
      .string()
      .min(1)
      .describe('Running organize dream id returned by memory_organize_prepare.'),
    memories: z
      .array(organizeProposalSchema)
      .describe('Consolidation proposals (each must list non-empty active supersedes ids).'),
  })
  .strict()

const reviewItemSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(['accept', 'reject']),
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().min(0).max(1).optional(),
  })
  .strict()

const memoryReviewSchema = z
  .object({
    id: z.string().min(1).optional().describe('Single pending proposal id to review.'),
    action: z.enum(['accept', 'reject']).optional().describe('Review decision for single id.'),
    title: z.string().min(1).optional().describe('Optional edited title before accepting.'),
    body: z.string().min(1).optional().describe('Optional edited body before accepting.'),
    tags: z.array(z.string()).optional().describe('Optional edited tags before accepting.'),
    importance: z.number().min(0).max(1).optional().describe('Optional edited importance.'),
    items: z
      .array(reviewItemSchema)
      .min(1)
      .optional()
      .describe('Batch review items when reviewing multiple proposals at once.'),
  })
  .strict()

const memoryRestoreSchema = z
  .object({
    id: z.string().min(1).describe('Archived memory id to restore to active.'),
  })
  .strict()

const memoryDeleteSchema = z
  .object({
    id: z.string().min(1).describe('Memory id to permanently delete.'),
    expectedContentRevision: z
      .number()
      .int()
      .min(1)
      .describe('Required optimistic-concurrency revision of the record being deleted.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Explicit confirmation flag (default true after host gate).'),
  })
  .strict()

const memoryUndoDreamSchema = z
  .object({
    dreamId: z.string().min(1).describe('Dream run id whose committed changes should be reverted.'),
  })
  .strict()

const memoryImportSchema = z
  .object({
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('DSH/AGY compatible MemoryExport JSON object.'),
    inputPath: z
      .string()
      .min(1)
      .optional()
      .describe('Optional path to a JSON export file on disk.'),
    mode: z.enum(['merge', 'replace']).optional().describe('merge (default) or replace.'),
    mapping: z
      .record(
        z.string(),
        z
          .object({
            key: z.string().min(1),
            root: z.string().min(1),
          })
          .strict(),
      )
      .optional()
      .describe('Optional source workspaceKey to local workspace mapping.'),
    targetScope: z
      .enum(['current', 'workspace', 'global', 'all'])
      .optional()
      .describe('Target scope for replace mode.'),
    workspaceRoot: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Explicit workspace root for replace mode (cross-workspace requires confirmation).',
      ),
    confirm: z.boolean().optional().describe('Required true for replace mode.'),
  })
  .strict()

const memoryRebuildSchema = z
  .object({
    scope: z
      .enum(['current', 'workspace', 'global', 'all'])
      .optional()
      .describe('Scope to rebuild derived data for (all requires confirmation).'),
    workspaceRoot: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit workspace root to rebuild (cross-workspace requires confirmation).'),
    since: z
      .string()
      .min(1)
      .optional()
      .describe('Only rebuild derived records updated since ISO time.'),
    confirm: z.boolean().optional().describe('Explicit confirmation flag.'),
  })
  .strict()

const memoryPurgeSchema = z
  .object({
    scope: z
      .enum(['current', 'workspace', 'global', 'all'])
      .optional()
      .describe('Scope to permanently purge (all requires confirmation).'),
    workspaceRoot: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit workspace root to purge (cross-workspace requires confirmation).'),
    confirmText: z
      .string()
      .min(1)
      .describe('Exact confirmation phrase "PURGE <scopeKey>" required to proceed.'),
  })
  .strict()

const memoryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    indexMaxBytes: z.number().int().min(1024).max(32_768).optional(),
    autoCaptureEpisodes: z.boolean().optional(),
    autoDream: z.boolean().optional(),
    autoAcceptProposals: z.boolean().optional(),
    dreamIdleDelayMs: naturalInt().optional(),
    autoDreamMinIntervalMs: naturalInt().optional(),
    dreamMaxEpisodes: naturalInt().optional(),
    dreamLookbackDays: naturalInt().optional(),
    dreamProcessingTimeoutMs: naturalInt().optional(),
    refreshIndexOnChange: z.boolean().optional(),
    refreshMinIntervalMs: naturalInt().optional(),
    refreshMaxBytes: naturalInt().optional(),
    refreshResetBytes: naturalInt().optional(),
    worklogCapture: z.enum(['significant', 'off']).optional(),
    worklogRetentionDays: naturalInt().optional(),
    episodeRetentionDays: naturalInt().optional(),
    archivePurgePolicy: z.enum(['manual', 'after-export', 'age']).optional(),
    archiveRetentionDays: naturalInt().optional(),
    rebuildLookbackDays: naturalInt().optional(),
    injectForSubagents: z.boolean().optional(),
    redactSecrets: z.boolean().optional(),
    searchLimit: naturalInt().optional(),
  })
  .strict()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function isAbsoluteWorkspacePath(rawPath: string): boolean {
  return path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath)
}

function resolveToolFilePath(rawPath: string, ctx: ResolvedCallContext): string {
  if (path.isAbsolute(rawPath)) return path.resolve(rawPath)
  if (ctx.workspace !== null) return path.resolve(ctx.workspace.root, rawPath)
  return path.resolve(rawPath)
}

function stripHostContext(rawArgs: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(rawArgs)) {
    throw new OperationError('MEMORY_INVALID_QUERY', 'tool arguments must be a JSON object')
  }
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawArgs)) {
    if (key === HOST_CONTEXT_ARG_KEY) continue
    clean[key] = value
  }
  return clean
}

function parseArgs<T extends z.ZodTypeAny>(
  schema: T,
  rawArgs: Record<string, unknown>,
  errorCode: OperationErrorCode = 'MEMORY_INVALID_QUERY',
): z.infer<T> {
  const clean = stripHostContext(rawArgs)
  const parsed = schema.safeParse(clean)
  if (!parsed.success) {
    throw new OperationError(errorCode, parsed.error.issues[0]?.message ?? parsed.error.message)
  }
  return parsed.data
}

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}

function resolveCrossWorkspaceRoot(rawRoot: string, ctx: ResolvedCallContext): string {
  const trimmed = rawRoot.trim()
  if (trimmed.length === 0 || !isAbsoluteWorkspacePath(trimmed)) {
    throw new OperationError(
      'MEMORY_FORBIDDEN_SCOPE',
      'workspaceRoot must be an absolute workspace path',
    )
  }
  const targetKey = normalizeWorkspaceKey(trimmed)
  const isCrossWorkspace = ctx.workspace === null || targetKey !== ctx.workspace.key
  if (isCrossWorkspace && !ctx.approvedScopeOverride) {
    throw new OperationError(
      'MEMORY_FORBIDDEN_SCOPE',
      'accessing another workspace requires explicit user confirmation',
    )
  }
  return targetKey
}

function resolveExportLikeScope(
  scope: 'current' | 'workspace' | 'global' | 'all' | undefined,
  workspaceRoot: string | undefined,
  ctx: ResolvedCallContext,
): ExportScope {
  if (scope === 'all') {
    if (!ctx.approvedScopeOverride) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'scope "all" requires explicit user confirmation',
      )
    }
    return 'all'
  }
  if (workspaceRoot !== undefined) {
    return { workspaceKey: resolveCrossWorkspaceRoot(workspaceRoot, ctx) }
  }
  if (scope === 'global') {
    return 'global'
  }
  if (scope === 'workspace') {
    if (ctx.workspace === null) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'workspace scope requires a working directory',
      )
    }
    return { workspaceKey: ctx.workspace.key }
  }
  if (ctx.workspace === null) {
    return 'global'
  }
  return { workspaceKey: ctx.workspace.key }
}

function toRawProposal(item: {
  type: RawDreamProposalInput['type']
  title: string
  body: string
  confidence: number
  importance: number
  sourceEpisodeIds?: readonly string[] | undefined
  tags?: readonly string[] | undefined
  supersedes?: readonly string[] | undefined
}): RawDreamProposalInput {
  return {
    type: item.type,
    title: item.title,
    body: item.body,
    confidence: item.confidence,
    importance: item.importance,
    ...(item.sourceEpisodeIds === undefined ? {} : { sourceEpisodeIds: item.sourceEpisodeIds }),
    ...(item.tags === undefined ? {} : { tags: item.tags }),
    ...(item.supersedes === undefined ? {} : { supersedes: item.supersedes }),
  }
}

function resolveDreamMemoryScope(
  requested: 'workspace' | 'global' | undefined,
  ctx: ResolvedCallContext,
): MemoryScope {
  const desired = requested ?? (ctx.workspace === null ? 'global' : 'workspace')
  if (desired === 'global') {
    return { kind: 'global' }
  }
  if (ctx.workspace === null) {
    throw new OperationError(
      'MEMORY_FORBIDDEN_SCOPE',
      'workspace operation requires a working directory',
    )
  }
  return { kind: 'workspace', key: ctx.workspace.key, root: ctx.workspace.root }
}

/**
 * Create the 20 tiered MCP tools (12 regular + 8 sensitive) wired to the shared
 * {@link MemoryEngine}, {@link FileMemoryDomain}, and {@link AgyConfigStore}.
 */
export function createAgyTools(deps: CreateAgyToolsDeps): readonly AgyToolDefinition[] {
  const { domain, engine, configStore } = deps

  async function syncConfig(): Promise<void> {
    const cfg = await configStore.syncIfChanged()
    if (cfg.changed) {
      engine.updateConfig(cfg.config)
    }
  }

  async function syncForRead(): Promise<void> {
    const [diskChanged, cfg] = await Promise.all([
      domain.syncFromDiskIfChanged(),
      configStore.syncIfChanged(),
    ])
    if (cfg.changed) {
      engine.updateConfig(cfg.config)
    } else if (diskChanged) {
      engine.syncSearchIndex()
    }
    if (!engine.status().ready) {
      await domain.withWriteLock(async () => {
        await engine.recover()
      })
    }
  }

  async function runWrite<T>(fn: () => Promise<T>): Promise<T> {
    await syncConfig()
    return await domain.withWriteLock(async () => {
      engine.syncSearchIndex()
      return await fn()
    })
  }

  function assertDreamScopeVisible(dreamId: string, ctx: ResolvedCallContext): void {
    const dream = domain.table('dreams').get(DreamId(dreamId))
    if (dream === undefined) return
    if (dream.scopeKey === 'global') return
    if (ctx.approvedScopeOverride) return
    if (ctx.workspace === null || dream.scopeKey !== ctx.workspace.key) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        `dream '${dreamId}' is not visible in the current workspace scope`,
      )
    }
  }

  const tools: AgyToolDefinition[] = [
    /* ------------------------------------------------------------------ *
     * Regular Tools (12)
     * ------------------------------------------------------------------ */
    {
      name: 'memory_search',
      description:
        'Search active long-term memories in the current workspace and global scope using BM25, or omit query to browse by priority. Increments matchCount only (not useCount). Use memory_read for full body.',
      inputSchema: toJsonSchema(memorySearchSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memorySearchSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        await syncForRead()

        const scope = args.scope ?? 'auto'
        const workspace = scope === 'global' ? null : ctx.workspace
        if (scope === 'workspace' && workspace === null) {
          return { results: [], total: 0, truncated: false }
        }

        const query = args.query?.trim() ?? ''
        const filter = {
          workspaceKey: workspace?.key ?? null,
          scope,
          ...(args.type === undefined ? {} : { types: [args.type] }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        }

        if (query.length === 0) {
          return engine.browse(filter)
        }

        const result = engine.search({ query, ...filter })
        if (result.results.length > 0) {
          try {
            await domain.withWriteLock(async () => {
              for (const hit of result.results) {
                await engine.recordMatch(hit.id)
              }
            })
          } catch {
            // Statistics updates must never fail a search response.
          }
        }
        return {
          results: result.results,
          total: result.total,
          truncated: result.truncated,
        }
      },
    },

    {
      name: 'memory_read',
      description:
        'Read one memory in full, including body, tags, source references, supersedes, and revision metadata. Defaults to active unexpired memories (incrementing useCount); set includeNonActive=true to inspect pending or archived proposals during review.',
      inputSchema: toJsonSchema(memoryReadSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryReadSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        await syncForRead()

        const record =
          args.includeNonActive === true
            ? engine.read(args.id, ctx.workspace?.key ?? null)
            : engine.readForModel(args.id, ctx.workspace?.key ?? null)
        let latest = record
        if (record.status === 'active') {
          try {
            const updated = await domain.withWriteLock(() => engine.recordUse(record.id))
            if (updated !== undefined) latest = updated
          } catch {
            // Statistics updates must never fail a read response.
          }
        }

        return {
          id: latest.id,
          type: latest.type,
          title: latest.title,
          body: latest.body,
          tags: latest.tags,
          scope: latest.scope,
          sourceRefs: latest.sourceRefs,
          sourceEpisodeIds: latest.sourceEpisodeIds,
          supersedes: latest.supersedes,
          status: latest.status,
          ownership: latest.ownership,
          origin: latest.origin,
          confidence: latest.confidence,
          importance: latest.importance,
          updatedAt: latest.updatedAt,
          contentRevision: latest.contentRevision,
          matchCount: latest.matchCount,
          useCount: latest.useCount,
        }
      },
    },

    {
      name: 'memory_write',
      description: MEMORY_WRITE_DESCRIPTION,
      inputSchema: toJsonSchema(memoryWriteSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryWriteSchema, rawArgs, 'MEMORY_INVALID_CONTENT')
        return await runWrite(async () => {
          const result = await engine.write(
            {
              ...(args.id === undefined ? {} : { id: args.id }),
              type: args.type,
              title: args.title,
              body: args.body,
              ...(args.scope === undefined ? {} : { scope: args.scope }),
              ...(args.tags === undefined ? {} : { tags: args.tags }),
              ...(args.importance === undefined ? {} : { importance: args.importance }),
              ...(args.expectedContentRevision === undefined
                ? {}
                : { expectedContentRevision: args.expectedContentRevision }),
              ...(args.id === undefined && ctx.conversationId !== undefined
                ? { sourceRefs: [{ sessionId: ctx.conversationId }] }
                : {}),
            },
            ctx.workspace,
          )
          return {
            id: result.record.id,
            contentRevision: result.record.contentRevision,
            status: result.record.status,
            scope: result.record.scope,
            redactions: result.redactions,
            duplicate: result.duplicate ?? false,
          }
        })
      },
    },

    {
      name: 'memory_forget',
      description:
        'Soft-forget one visible memory by archiving it. The record stays recoverable via memory_restore; this tool never permanently deletes anything.',
      inputSchema: toJsonSchema(memoryForgetSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const stripped = stripHostContext(rawArgs)
        if ('permanent' in stripped || 'confirm' in stripped) {
          throw new OperationError(
            'MEMORY_FORBIDDEN',
            'permanent deletion is not available to model tools',
          )
        }
        const args = parseArgs(memoryForgetSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        return await runWrite(async () => {
          const archived = await engine.forget(args.id, ctx.workspace?.key ?? null, args.reason)
          return {
            id: archived.id,
            status: archived.status,
            contentRevision: archived.contentRevision,
            reason: args.reason ?? null,
          }
        })
      },
    },

    {
      name: 'memory_list',
      description:
        'Read-only paginated listing of memories. Defaults to current workspace plus global preferences; requesting scope="all" or another workspaceRoot requires explicit host confirmation.',
      inputSchema: toJsonSchema(memoryListSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryListSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        await syncForRead()

        let workspaceKey: string | 'all' | null
        let scopeKind: 'workspace' | 'global' | undefined
        let management = false
        if (args.scope === 'all') {
          if (!ctx.approvedScopeOverride) {
            throw new OperationError(
              'MEMORY_FORBIDDEN_SCOPE',
              'listing all workspaces requires explicit user confirmation',
            )
          }
          workspaceKey = 'all'
          management = true
        } else if (args.workspaceRoot !== undefined) {
          workspaceKey = resolveCrossWorkspaceRoot(args.workspaceRoot, ctx)
          if (args.scope === 'workspace') scopeKind = 'workspace'
          else if (args.scope === 'global') scopeKind = 'global'
        } else if (args.scope === 'global') {
          workspaceKey = null
          scopeKind = 'global'
        } else if (args.scope === 'workspace') {
          if (ctx.workspace === null) {
            throw new OperationError(
              'MEMORY_FORBIDDEN_SCOPE',
              'workspace scope requires a working directory',
            )
          }
          workspaceKey = ctx.workspace.key
          scopeKind = 'workspace'
        } else {
          workspaceKey = ctx.workspace?.key ?? null
        }

        return engine.list({
          workspaceKey,
          ...(scopeKind === undefined ? {} : { scopeKind }),
          ...(management ? { management: true } : {}),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.includeExpired === undefined ? {} : { includeExpired: args.includeExpired }),
        })
      },
    },

    {
      name: 'memory_status',
      description:
        'Read-only summary of memory store counters (active/pending/archived/episodes/audit/operations), latest recovery report, recent dream run, and active configuration.',
      inputSchema: toJsonSchema(memoryStatusToolSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        parseArgs(memoryStatusToolSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        await syncForRead()
        const status = engine.status()
        return {
          ...status,
          workspace: ctx.workspace,
          trustedHost: ctx.trustedHost,
        }
      },
    },

    {
      name: 'memory_audit',
      description:
        'Read-only query over the audit log scoped strictly to the current workspace and global records, newest first.',
      inputSchema: toJsonSchema(memoryAuditSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryAuditSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        await syncForRead()
        return engine.audit({
          workspaceKey: ctx.workspace?.key ?? null,
          ...(args.memoryId === undefined ? {} : { memoryId: args.memoryId }),
          ...(args.dreamId === undefined ? {} : { dreamId: args.dreamId }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
        })
      },
    },

    {
      name: 'memory_export',
      description:
        'Strictly read-only export of DSH/AGY-compatible memory JSON. Never purges archives even when archivePurgePolicy="after-export". Using scope="all", another workspaceRoot, or outputPath requires explicit host confirmation; outputPath never overwrites existing files.',
      inputSchema: toJsonSchema(memoryExportSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryExportSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        await syncForRead()

        if (args.outputPath !== undefined && !ctx.approvedScopeOverride) {
          throw new OperationError(
            'MEMORY_FORBIDDEN_SCOPE',
            'writing an export file requires explicit user confirmation',
          )
        }

        const includeArchived = args.includeArchived ?? true
        const targetScope = resolveExportLikeScope(args.scope, args.workspaceRoot, ctx)
        const basePayload = engine.export({ scope: targetScope, includeArchived })

        let payload: MemoryExport = basePayload
        // Default export (`scope` omitted or `'current'`) with a workspace includes
        // current workspace + global preferences while keeping DSH export format.
        if (
          (args.scope === undefined || args.scope === 'current') &&
          args.workspaceRoot === undefined &&
          ctx.workspace !== null &&
          typeof targetScope === 'object'
        ) {
          const globalExport = engine.export({ scope: 'global', includeArchived })
          const seen = new Set(basePayload.memories.map((record) => record.id))
          const mergedMemories = [
            ...basePayload.memories,
            ...globalExport.memories.filter((record) => !seen.has(record.id)),
          ]
          payload = {
            ...basePayload,
            memories: mergedMemories,
          }
        }

        if (args.outputPath !== undefined) {
          const resolvedOutput = resolveToolFilePath(args.outputPath, ctx)
          await fs.mkdir(path.dirname(resolvedOutput), { recursive: true })
          try {
            const fh = await fs.open(resolvedOutput, 'wx')
            try {
              await fh.writeFile(JSON.stringify(payload, null, 2), 'utf8')
              await fh.sync()
            } finally {
              await fh.close()
            }
          } catch (err) {
            if (isErrno(err, 'EEXIST')) {
              throw new OperationError(
                'MEMORY_CONFLICT',
                `export output file already exists and will not be overwritten: ${resolvedOutput}`,
              )
            }
            throw err
          }
          return {
            exportedAt: payload.exportedAt,
            scope: payload.scope,
            includeArchived: payload.includeArchived,
            memoryCount: payload.memories.length,
            episodeCount: payload.episodes.length,
            outputPath: resolvedOutput,
          }
        }

        return payload
      },
    },

    {
      name: 'memory_dream_prepare',
      description:
        'Stage 1 of two-stage dreaming: claim unprocessed episodes as processing, create a running DreamRun, and return prompts and output schema for consolidation.',
      inputSchema: toJsonSchema(memoryDreamPrepareSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryDreamPrepareSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scope = resolveDreamMemoryScope(args.scope, ctx)
        return await runWrite(() =>
          engine.prepareDream({
            scope,
            ...(args.maxEpisodes === undefined ? {} : { maxEpisodes: args.maxEpisodes }),
            ...(args.since === undefined ? {} : { since: args.since }),
            ...(args.trigger === undefined ? {} : { trigger: args.trigger }),
          }),
        )
      },
    },

    {
      name: 'memory_dream_commit',
      description:
        'Stage 2 of two-stage dreaming: validate and stage structured proposals as pending (derived/dream), settle claimed episodes, and finalize the DreamRun. Empty memories array marks claimed episodes skipped.',
      inputSchema: toJsonSchema(memoryDreamCommitSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryDreamCommitSchema, rawArgs, 'MEMORY_INVALID_CONTENT')
        return await runWrite(async () => {
          assertDreamScopeVisible(args.dreamId, ctx)
          return await engine.commitDream({
            dreamId: args.dreamId,
            memories: args.memories.map(toRawProposal),
            actor: 'model',
          })
        })
      },
    },

    {
      name: 'memory_organize_prepare',
      description:
        'Stage 1 of two-stage full-store organization: select up to 60 active memories in the current scope, create a running organize DreamRun, and return consolidation prompts and schema.',
      inputSchema: toJsonSchema(memoryOrganizePrepareSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryOrganizePrepareSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scope = resolveDreamMemoryScope(args.scope, ctx)
        return await runWrite(() =>
          engine.prepareOrganize({
            scope,
            ...(args.maxRecords === undefined ? {} : { maxRecords: args.maxRecords }),
          }),
        )
      },
    },

    {
      name: 'memory_organize_commit',
      description:
        'Stage 2 of two-stage full-store organization: validate proposals with non-empty active supersedes arrays and stage them as pending without mutating existing active memories.',
      inputSchema: toJsonSchema(memoryOrganizeCommitSchema),
      sensitive: false,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryOrganizeCommitSchema, rawArgs, 'MEMORY_INVALID_CONTENT')
        return await runWrite(async () => {
          assertDreamScopeVisible(args.dreamId, ctx)
          return await engine.commitOrganize({
            dreamId: args.dreamId,
            memories: args.memories.map(toRawProposal),
            actor: 'model',
          })
        })
      },
    },

    /* ------------------------------------------------------------------ *
     * Sensitive Management Tools (8)
     * ------------------------------------------------------------------ */
    {
      name: 'memory_review',
      description:
        'Approve (accept, optionally editing title/body/tags/importance first) or reject one or more pending dream proposals. Accepting archives superseded memories and promotes ownership to user.',
      inputSchema: toJsonSchema(memoryReviewSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryReviewSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scopeSelector: string | 'all' | null = ctx.approvedScopeOverride
          ? 'all'
          : (ctx.workspace?.key ?? null)

        if (args.items !== undefined) {
          return await runWrite(async () => {
            const results = []
            for (const item of args.items!) {
              const reviewed = await engine.review({
                id: item.id,
                action: item.action,
                workspaceKey: scopeSelector,
                ...(item.title === undefined ? {} : { title: item.title }),
                ...(item.body === undefined ? {} : { body: item.body }),
                ...(item.tags === undefined ? {} : { tags: item.tags }),
                ...(item.importance === undefined ? {} : { importance: item.importance }),
              })
              results.push(reviewed)
            }
            return { items: results }
          })
        }

        if (args.id === undefined || args.action === undefined) {
          throw new OperationError(
            'MEMORY_INVALID_QUERY',
            'provide either (id and action) or a non-empty items array',
          )
        }
        const singleId = args.id
        const singleAction = args.action
        return await runWrite(() =>
          engine.review({
            id: singleId,
            action: singleAction,
            workspaceKey: scopeSelector,
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.tags === undefined ? {} : { tags: args.tags }),
            ...(args.importance === undefined ? {} : { importance: args.importance }),
          }),
        )
      },
    },

    {
      name: 'memory_restore',
      description: 'Restore an archived memory to active status and promote ownership to user.',
      inputSchema: toJsonSchema(memoryRestoreSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryRestoreSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scopeSelector: string | 'all' | null = ctx.approvedScopeOverride
          ? 'all'
          : (ctx.workspace?.key ?? null)
        return await runWrite(() => engine.restore(args.id, scopeSelector))
      },
    },

    {
      name: 'memory_delete',
      description:
        'Permanently delete a memory and scrub historical audit snapshots. Requires id and expectedContentRevision.',
      inputSchema: toJsonSchema(memoryDeleteSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryDeleteSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scopeSelector: string | 'all' | null = ctx.approvedScopeOverride
          ? 'all'
          : (ctx.workspace?.key ?? null)
        return await runWrite(() =>
          engine.delete({
            id: args.id,
            expectedContentRevision: args.expectedContentRevision,
            permanent: true,
            confirm: args.confirm ?? true,
            workspaceKey: scopeSelector,
          }),
        )
      },
    },

    {
      name: 'memory_undo_dream',
      description:
        'Revert changes committed by a specific dream run while respecting optimistic contentRevision checks.',
      inputSchema: toJsonSchema(memoryUndoDreamSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryUndoDreamSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        return await runWrite(async () => {
          assertDreamScopeVisible(args.dreamId, ctx)
          return await engine.undoDream(args.dreamId)
        })
      },
    },

    {
      name: 'memory_import',
      description:
        'Import a DSH/AGY-compatible MemoryExport JSON payload (from inline payload or inputPath) in merge or replace mode.',
      inputSchema: toJsonSchema(memoryImportSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryImportSchema, rawArgs, 'MEMORY_INVALID_CONTENT')
        if (args.payload === undefined && args.inputPath === undefined) {
          throw new OperationError(
            'MEMORY_INVALID_CONTENT',
            'memory_import requires either payload or inputPath',
          )
        }

        let resolvedPayload: unknown = args.payload
        if (args.inputPath !== undefined) {
          const resolvedPath = resolveToolFilePath(args.inputPath, ctx)
          let raw: Buffer
          try {
            raw = await readFileWithRetry(resolvedPath)
          } catch (err) {
            throw new OperationError(
              'MEMORY_INVALID_CONTENT',
              `failed to read import file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          try {
            resolvedPayload = JSON.parse(raw.toString('utf8'))
          } catch (err) {
            throw new OperationError(
              'MEMORY_INVALID_CONTENT',
              `invalid JSON in import file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }

        let mapping = args.mapping
        if (mapping !== undefined) {
          for (const target of Object.values(mapping)) {
            const normalizedTargetKey = normalizeWorkspaceKey(target.key)
            if (
              !ctx.approvedScopeOverride &&
              (ctx.workspace === null || normalizedTargetKey !== ctx.workspace.key)
            ) {
              throw new OperationError(
                'MEMORY_FORBIDDEN_SCOPE',
                'importing into another workspace requires explicit user confirmation',
              )
            }
          }
        } else if (ctx.workspace !== null) {
          mapping = {
            [ctx.workspace.key]: { key: ctx.workspace.key, root: ctx.workspace.root },
          }
        }

        const mode = args.mode ?? 'merge'
        const targetScope =
          mode === 'replace' || args.targetScope !== undefined || args.workspaceRoot !== undefined
            ? resolveExportLikeScope(args.targetScope, args.workspaceRoot, ctx)
            : undefined

        const options: ImportOptions = {
          mode,
          ...(mapping === undefined ? {} : { mapping }),
          ...(targetScope === undefined ? {} : { targetScope }),
          ...(args.confirm === undefined ? {} : { confirm: args.confirm }),
        }

        return await runWrite(() => engine.import(resolvedPayload as MemoryExport, options))
      },
    },

    {
      name: 'memory_rebuild',
      description:
        'Delete derived, unreviewed, unpinned memories and reset episodes/session cursors in a scope while strictly preserving user-owned memories.',
      inputSchema: toJsonSchema(memoryRebuildSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryRebuildSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scope = resolveExportLikeScope(args.scope, args.workspaceRoot, ctx)
        return await runWrite(() =>
          engine.rebuild({
            scope,
            ...(args.since === undefined ? {} : { since: args.since }),
            confirm: args.confirm ?? true,
          }),
        )
      },
    },

    {
      name: 'memory_purge',
      description:
        'Permanently purge all memories, episodes, and session cursors in a scope. Requires exact confirmText "PURGE <scopeKey>".',
      inputSchema: toJsonSchema(memoryPurgeSchema),
      sensitive: true,
      async execute(rawArgs, ctx) {
        const args = parseArgs(memoryPurgeSchema, rawArgs, 'MEMORY_INVALID_QUERY')
        const scope = resolveExportLikeScope(args.scope, args.workspaceRoot, ctx)
        return await runWrite(() =>
          engine.purgeAll({
            scope,
            confirmText: args.confirmText,
          }),
        )
      },
    },

    {
      name: 'memory_config',
      description:
        'Update AGY runtime configuration fields persisted in config.json and hot-apply immediately without restarting. Rejects DSH-only, non-editable capacity, and unknown fields.',
      inputSchema: toJsonSchema(memoryConfigSchema),
      sensitive: true,
      async execute(rawArgs) {
        const stripped = stripHostContext(rawArgs)
        const disallowed = Object.keys(stripped).filter((key) => !EDITABLE_CONFIG_KEY_SET.has(key))
        if (disallowed.length > 0) {
          throw new OperationError(
            'MEMORY_INVALID_CONFIG',
            `config field(s) not editable in AGY: ${disallowed.join(', ')}`,
          )
        }
        const parsed = parseArgs(memoryConfigSchema, rawArgs, 'MEMORY_INVALID_CONFIG')
        const cleanPatch = validateMemoryConfigPatch(parsed as Partial<MemoryConfig>)
        return await runWrite(async () => {
          const saved = await configStore.savePatch(cleanPatch)
          const applied = engine.updateConfig(saved)
          return {
            updated: Object.keys(cleanPatch),
            config: applied,
          }
        })
      },
    },
  ]

  return tools
}
