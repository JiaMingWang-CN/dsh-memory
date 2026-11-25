/**
 * Host-agnostic `MemoryEngine` facade and two-stage Dream/Organize state machine.
 *
 * Encapsulates startup recovery, CRUD, BM25 search, retention, import/export/
 * rebuild/purge, and the two-stage prepare/commit workflows for dreaming and
 * full-store organization without any dependency on a host runtime.
 * @module memloom/core/engine
 */
import { z } from 'zod'
import {
  MemoryId,
  memoryTypeSchema,
  newDreamId,
  newMemoryId,
  type AuditActor,
  type DreamRun,
  type DreamTrigger,
  type EpisodeId,
  type EpisodeRecord,
  type MemoryRecord,
  type MemoryScope,
  type MemoryType,
  type WorklogKind,
} from '../shared/types.ts'
import { listAudit, type AuditListRequest, type AuditListResult } from './audit.ts'
import { CapacityPolicy } from './capacity.ts'
import {
  resolveMemoryConfig,
  validateMemoryConfigPatch,
  type MemoryConfig,
  type ResolvedMemoryConfig,
} from './config.ts'
import { checkDreamHealth } from './dream-health.ts'
import {
  DREAM_SYSTEM_PROMPT,
  ORGANIZE_RECORD_LIMIT,
  ORGANIZE_SYSTEM_PROMPT,
  RELATED_MEMORY_LIMIT,
  buildDreamPrompt,
  buildOrganizePrompt,
} from './dream-prompt.ts'
import {
  exportMemories,
  importMemories,
  purgeAll as purgeAllMemories,
  rebuild as rebuildMemories,
  type ExportRequest,
  type ImportOptions,
  type ImportReport,
  type MemoryExport,
  type PurgeReport,
  type PurgeRequest,
  type RebuildReport,
  type RebuildRequest,
} from './exchange.ts'
import {
  OperationError,
  OperationRunner,
  type DreamUndoReport,
  type RecoveryReport,
} from './operations.ts'
import {
  applyDuplicatePolicy,
  computeProposalKey,
  normalizeTitle,
  type DreamProposalOutput,
} from './proposal.ts'
import { detectStrongSecret, normalizeEscapedNewlines, redactSecrets } from './redact.ts'
import { SearchIndex, type BrowseRequest, type SearchRequest, type SearchResult } from './search.ts'
import type { MemoryDomainHandle } from './storage-contract.ts'
import {
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_SUPERSEDES,
  MAX_MEMORY_TAGS,
  MAX_MEMORY_TITLE_LENGTH,
  MemoryStore,
  type CapacityController,
  type EpisodeInput,
  type ListRequest,
  type ListResult,
  type MemoryInput,
  type MemoryPatch,
  type StoreCounts,
} from './store.ts'
import type { WorkspaceIdentity } from './workspace.ts'

const STRONG_SECRET_WRITE_MESSAGE =
  'memory content looks like a secret (private key, API key or token); record where it is configured instead'

const MEMORY_TYPES: ReadonlySet<MemoryType> = new Set(['lesson', 'worklog', 'wiki', 'preference'])

const DREAM_OUTPUT_SCHEMA = z.toJSONSchema(
  z.object({
    memories: z.array(
      z.object({
        type: memoryTypeSchema,
        title: z.string().min(1),
        body: z.string().min(1),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1),
        sourceEpisodeIds: z.array(z.string().min(1)).min(1),
        tags: z.array(z.string()).optional(),
        supersedes: z.array(z.string().min(1)).optional(),
      }),
    ),
  }),
) as Record<string, unknown>

const ORGANIZE_OUTPUT_SCHEMA = z.toJSONSchema(
  z.object({
    memories: z.array(
      z.object({
        type: memoryTypeSchema,
        title: z.string().min(1),
        body: z.string().min(1),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1),
        supersedes: z.array(z.string().min(1)).min(1),
        tags: z.array(z.string()).optional(),
      }),
    ),
  }),
) as Record<string, unknown>

export interface MemoryEngineOptions {
  domain: MemoryDomainHandle
  config?: Partial<MemoryConfig> | null
  now?: () => Date
  logger?: { warn?: (message: string) => void }
}

export interface RawDreamProposalInput {
  type: MemoryType
  title: string
  body: string
  confidence: number
  importance: number
  sourceEpisodeIds?: readonly string[]
  tags?: readonly string[]
  supersedes?: readonly string[]
}

export interface PreparedDreamResult {
  dreamId: string
  scope: MemoryScope
  episodeIds: string[]
  recordIds?: string[]
  systemPrompt: string
  userPrompt: string
  outputSchema: Record<string, unknown>
}

export interface CommitDreamInput {
  dreamId: string
  memories: readonly RawDreamProposalInput[]
  actor?: AuditActor
}

export interface CommitDreamResult {
  dreamId: string
  status: 'completed'
  createdIds: string[]
  skippedDuplicates: number
  processedEpisodes: number
  skippedEpisodes: number
}

export interface PrepareDreamInput {
  scope: MemoryScope
  maxEpisodes?: number
  since?: string
  trigger?: Exclude<DreamTrigger, 'organize'>
}

export interface PrepareOrganizeInput {
  scope: MemoryScope
  maxRecords?: number
}

export interface MemoryWriteInput {
  id?: string
  type: MemoryType
  title: string
  body: string
  scope?: 'workspace' | 'global'
  tags?: string[]
  importance?: number
  expectedContentRevision?: number
  sourceRefs?: { sessionId: string; eventSeq?: number; turn?: number; quote?: string }[]
}

export interface MemoryWriteResult {
  record: MemoryRecord
  redactions: number
  duplicate?: boolean
}

export interface MemoryReviewInput {
  id: string
  action: 'accept' | 'reject'
  title?: string
  body?: string
  tags?: string[]
  importance?: number
  workspaceKey?: string | 'all' | null
}

export interface MemoryDeleteInput {
  id: string
  expectedContentRevision?: number
  permanent?: boolean
  confirm?: boolean
  workspaceKey?: string | 'all' | null
}

export interface MemoryAuditQuery extends AuditListRequest {
  dreamId?: string
  workspaceKey?: string | 'all' | null
}

export interface MemoryEngineStatus {
  ready: boolean
  counts: StoreCounts
  lastRecovery?: RecoveryReport
  recentDream: DreamRun | null
  config: ResolvedMemoryConfig
}

function isRecordVisible(record: MemoryRecord, workspaceKey: string | null): boolean {
  if (record.scope.kind === 'global') return true
  if (workspaceKey === null) return false
  return record.scope.key === workspaceKey
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === 'global' || right.kind === 'global') return left.kind === right.kind
  return left.key === right.key
}

function sameExactScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === 'global' || right.kind === 'global') return left.kind === right.kind
  return left.key === right.key && left.root === right.root
}

function resolveWriteScope(
  type: MemoryType,
  requested: 'workspace' | 'global' | undefined,
  workspace: WorkspaceIdentity | null,
): MemoryScope {
  const desired = requested ?? (workspace === null ? 'global' : 'workspace')
  if (desired === 'global') {
    if (type !== 'preference') {
      throw new OperationError('MEMORY_FORBIDDEN_SCOPE', 'only preference memories may be global')
    }
    return { kind: 'global' }
  }
  if (workspace === null) {
    throw new OperationError(
      'MEMORY_FORBIDDEN_SCOPE',
      'workspace memory requires a working directory',
    )
  }
  return { kind: 'workspace', key: workspace.key, root: workspace.root }
}

function stripUndefined(config: ResolvedMemoryConfig): Partial<MemoryConfig> {
  const out: Partial<MemoryConfig> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      ;(out as Record<string, unknown>)[key] = value
    }
  }
  return out
}

function buildCapacityPolicy(config: ResolvedMemoryConfig): CapacityPolicy {
  return new CapacityPolicy({
    maxActiveMemories: config.maxActiveMemories,
    maxArchivedMemories: config.maxArchivedMemories,
    maxStoredMemories: config.maxStoredMemories,
    maxQueuedEpisodes: config.maxQueuedEpisodes,
  })
}

/** Host-agnostic memory engine coordinating store, search, recovery and two-stage dreaming. */
export class MemoryEngine {
  private readonly domain: MemoryDomainHandle
  private readonly now: () => Date
  private readonly logger: { warn?: (message: string) => void } | undefined
  private readonly runner: OperationRunner
  private readonly store: MemoryStore
  private readonly preparedScopes = new Map<string, MemoryScope>()
  private resolvedConfig: ResolvedMemoryConfig
  private capacityPolicy: CapacityPolicy
  private searchIndex: SearchIndex

  constructor(options: MemoryEngineOptions) {
    this.domain = options.domain
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
    this.resolvedConfig = resolveMemoryConfig(options.config)
    this.capacityPolicy = buildCapacityPolicy(this.resolvedConfig)
    this.searchIndex = new SearchIndex({ defaultLimit: this.resolvedConfig.searchLimit })

    const capacityDelegate: CapacityController = {
      checkCreate: (counts) => this.capacityPolicy.checkCreate(counts),
      checkBatchTotals: (counts, addedArchived) =>
        this.capacityPolicy.checkBatchTotals(counts, addedArchived),
      onActiveOverflow: (active, incoming) =>
        this.capacityPolicy.onActiveOverflow(active, incoming),
      checkEpisodeQueue: (counts) => this.capacityPolicy.checkEpisodeQueue(counts),
      get activeLimit() {
        return capacityPolicyRef().activeLimit
      },
      assertActiveRoom: (activeCount, freed) =>
        this.capacityPolicy.assertActiveRoom(activeCount, freed),
    }
    const capacityPolicyRef = () => this.capacityPolicy

    this.runner = new OperationRunner(this.domain, {
      now: this.now,
      requestDedupeTtlMs: this.resolvedConfig.requestDedupeTtlMs,
      maxOperationRecords: this.resolvedConfig.maxOperationRecords,
      maxAuditRecords: this.resolvedConfig.maxAuditRecords,
    })

    this.store = new MemoryStore(this.domain, this.runner, {
      now: this.now,
      capacity: capacityDelegate,
      searchLimit: this.resolvedConfig.searchLimit,
      worklogRetentionDays: this.resolvedConfig.worklogRetentionDays,
      episodeRetentionDays: this.resolvedConfig.episodeRetentionDays,
      archivePurgePolicy: this.resolvedConfig.archivePurgePolicy,
      archiveRetentionDays: this.resolvedConfig.archiveRetentionDays,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      onChange: (change) => {
        if (change.action === 'upsert') this.searchIndex.update(change.record)
        else this.searchIndex.remove(change.id)
      },
    })

    this.syncSearchIndex()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private async ensureReady(): Promise<void> {
    if (!this.store.isReady) {
      await this.store.initialize()
      this.syncSearchIndex()
    }
  }

  private redactText(text: string): string {
    return this.resolvedConfig.redactSecrets === false ? text : redactSecrets(text)
  }

  /**
   * Run operation-log crash recovery, expire timed-out two-stage dreams and
   * synchronize the in-memory BM25 index.
   */
  async recover(): Promise<{ recovery: RecoveryReport; expiredDreams: number }> {
    const recovery = await this.store.initialize()
    const expiredDreams = await this.failExpiredDreams()
    this.syncSearchIndex()
    return { recovery, expiredDreams }
  }

  /**
   * Fail only `running` dreams whose duration exceeded `dreamProcessingTimeoutMs`
   * and return their `processing` episodes to `failed-retryable`.
   */
  async failExpiredDreams(): Promise<number> {
    await this.ensureReady()
    const timeoutMs = this.resolvedConfig.dreamProcessingTimeoutMs
    const nowMs = this.now().getTime()
    const error = 'dream processing timed out'
    let expired = 0

    for (const dream of this.store.dreamList()) {
      if (dream.status !== 'running') continue
      const startedMs = Date.parse(dream.startedAt)
      if (!Number.isNaN(startedMs) && nowMs - startedMs <= timeoutMs) continue

      const terminal: DreamRun = {
        ...dream,
        status: 'failed',
        finishedAt: this.nowIso(),
        error,
      }
      const stored = await this.store.putDreamTerminal(terminal)
      if (stored === undefined) continue
      expired += 1
      this.preparedScopes.delete(dream.id)

      const processingIds = this.store
        .episodeList({ statuses: ['processing'] })
        .filter((episode) => episode.dreamId === dream.id)
        .map((episode) => episode.id)
      if (processingIds.length > 0) {
        await this.store.releaseEpisodes(processingIds, dream.id, error)
      }
    }
    return expired
  }

  /** Validate and hot-apply a configuration patch without restarting. */
  updateConfig(patch: Partial<MemoryConfig>): ResolvedMemoryConfig {
    const validated = validateMemoryConfigPatch(patch)
    const next = resolveMemoryConfig({
      ...stripUndefined(this.resolvedConfig),
      ...validated,
    })
    this.resolvedConfig = next
    this.capacityPolicy = buildCapacityPolicy(next)
    if (this.searchIndex !== undefined) {
      this.searchIndex = new SearchIndex({ defaultLimit: next.searchLimit })
      this.syncSearchIndex()
    }
    return structuredClone(next)
  }

  /** Return a snapshot of the active resolved configuration. */
  getConfig(): ResolvedMemoryConfig {
    return structuredClone(this.resolvedConfig)
  }

  /** Rebuild the in-memory BM25 index from `memories` table entries. */
  syncSearchIndex(): void {
    const active = [...this.domain.table('memories').entries()]
      .map(([, record]) => record)
      .filter((record) => record.status === 'active')
    this.searchIndex.rebuild(active)
  }

  /** Rank active memories matching a search query. */
  search(request: SearchRequest): SearchResult {
    return this.searchIndex.search({
      ...request,
      now: request.now ?? this.now(),
    })
  }

  /** List visible active memories ordered by pinned, importance and recency. */
  browse(request: BrowseRequest): SearchResult {
    return this.searchIndex.browse({
      ...request,
      now: request.now ?? this.now(),
    })
  }

  /** List every active record visible in one workspace (or global-only when null). */
  activeInScope(workspaceKey: string | null): MemoryRecord[] {
    return this.store
      .activeRecords()
      .filter((record) => isRecordVisible(record, workspaceKey))
      .filter((record) => record.scope.kind !== 'global' || record.type === 'preference')
      .map((record) => structuredClone(record))
  }

  /** Read one visible memory in full. */
  read(id: string, workspaceKey: string | null): MemoryRecord {
    const record = this.store.get(MemoryId(id))
    if (record === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (!isRecordVisible(record, workspaceKey)) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        `memory '${id}' is not visible in the current scope`,
      )
    }
    return record
  }

  /** Read one active, unexpired memory through the model-facing surface. */
  readForModel(id: string, workspaceKey: string | null): MemoryRecord {
    const record = this.read(id, workspaceKey)
    if (
      record.status !== 'active' ||
      (record.scope.kind === 'global' && record.type !== 'preference')
    ) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    return record
  }

  /** Record one search hit (statistics only). */
  async recordMatch(id: string): Promise<MemoryRecord | undefined> {
    await this.ensureReady()
    return this.store.recordMatch(MemoryId(id))
  }

  /** Record one full read (statistics only). */
  async recordUse(id: string): Promise<MemoryRecord | undefined> {
    await this.ensureReady()
    return this.store.recordUse(MemoryId(id))
  }

  /** Persist one captured episode in the queue. */
  async appendEpisode(input: EpisodeInput): Promise<EpisodeRecord | undefined> {
    await this.ensureReady()
    return this.store.appendEpisode(input)
  }

  /** Create or update an explicit user-owned active memory. */
  async write(
    input: MemoryWriteInput,
    workspace: WorkspaceIdentity | null,
    requestId?: string,
  ): Promise<MemoryWriteResult> {
    await this.ensureReady()
    const normalizedTitle = normalizeEscapedNewlines(input.title)
    const normalizedBody = normalizeEscapedNewlines(input.body)
    if (
      detectStrongSecret(normalizedTitle) ||
      detectStrongSecret(normalizedBody) ||
      (input.tags?.some((tag) => detectStrongSecret(tag)) ?? false) ||
      (input.sourceRefs?.some((ref) => ref.quote !== undefined && detectStrongSecret(ref.quote)) ??
        false)
    ) {
      throw new OperationError('MEMORY_INVALID_CONTENT', STRONG_SECRET_WRITE_MESSAGE)
    }
    let redactions = 0
    const redact = (text: string): string => {
      if (!this.resolvedConfig.redactSecrets) return text
      const redacted = redactSecrets(text)
      if (redacted !== text) redactions += 1
      return redacted
    }
    const title = redact(normalizedTitle)
    const body = redact(normalizedBody)
    const tags = input.tags?.map((tag) => redact(tag))
    const sourceRefs = input.sourceRefs?.map((ref) =>
      ref.quote === undefined ? ref : { ...ref, quote: redact(ref.quote) },
    )
    if ([...title].length < 1 || [...title].length > MAX_MEMORY_TITLE_LENGTH) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `title must be 1-${MAX_MEMORY_TITLE_LENGTH} characters`,
      )
    }
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes < 1 || bodyBytes > MAX_MEMORY_BODY_BYTES) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `body must be 1-${MAX_MEMORY_BODY_BYTES} bytes`,
      )
    }
    if (
      input.importance !== undefined &&
      (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)
    ) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'importance must be between 0 and 1')
    }
    if (input.id !== undefined) {
      const id = MemoryId(input.id)
      const current = this.store.get(id)
      if (current === undefined) {
        throw new OperationError('MEMORY_NOT_FOUND', `memory '${input.id}' not found`)
      }
      if (!isRecordVisible(current, workspace?.key ?? null)) {
        throw new OperationError(
          'MEMORY_FORBIDDEN_SCOPE',
          `memory '${input.id}' is not visible in the current scope`,
        )
      }
      if (current.status !== 'active') {
        throw new OperationError(
          'MEMORY_CONFLICT',
          `memory '${input.id}' is ${current.status} and cannot be updated via memory_write`,
        )
      }
      if (input.expectedContentRevision === undefined) {
        throw new OperationError(
          'MEMORY_CONFLICT',
          'expectedContentRevision is required to update a memory',
        )
      }
      const nextScope =
        input.scope === undefined
          ? undefined
          : resolveWriteScope(input.type, input.scope, workspace)
      if (nextScope !== undefined && !sameExactScope(nextScope, current.scope)) {
        throw new OperationError(
          'MEMORY_FORBIDDEN_SCOPE',
          'changing an existing memory scope requires an explicit user management action',
        )
      }
      const patch: MemoryPatch = {
        expectedContentRevision: input.expectedContentRevision,
        type: input.type,
        title,
        body,
        ...(tags === undefined ? {} : { tags }),
        ...(nextScope === undefined ? {} : { scope: nextScope }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(sourceRefs === undefined ? {} : { sourceRefs }),
        ownership: 'user',
        actor: 'model',
      }
      const next = await this.store.update(id, patch, requestId)
      return { record: next, redactions }
    }
    const scope = resolveWriteScope(input.type, input.scope, workspace)
    const createInput: MemoryInput = {
      type: input.type,
      title,
      body,
      scope,
      ...(tags === undefined ? {} : { tags }),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(sourceRefs === undefined ? {} : { sourceRefs }),
      origin: 'model',
      ownership: 'user',
      status: 'active',
      actor: 'model',
    }
    return this.store.runBatch(async (batch) => {
      if (requestId !== undefined) {
        const replayed = await batch.findRequest(requestId)
        if (replayed !== undefined) {
          const record = await batch.create(createInput, requestId)
          return { record, redactions }
        }
      }
      const existing = batch.findActiveByTitle(scope, input.type, title)
      if (existing !== undefined) {
        return { record: existing, redactions, duplicate: true }
      }
      const created = await batch.create(createInput, requestId)
      return { record: created, redactions }
    })
  }

  /** Soft-forget one visible memory by archiving it. */
  async forget(
    id: string,
    workspaceKey: string | null,
    reason?: string,
    requestId?: string,
  ): Promise<MemoryRecord> {
    await this.ensureReady()
    const record = this.store.get(MemoryId(id))
    if (record === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (!isRecordVisible(record, workspaceKey)) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        `memory '${id}' is not visible in the current scope`,
      )
    }
    const rawReason = reason?.trim()
    const safeReason =
      rawReason === undefined || rawReason === ''
        ? undefined
        : this.resolvedConfig.redactSecrets
          ? redactSecrets(rawReason)
          : rawReason
    return this.store.archive(record.id, {
      actor: 'model',
      ...(safeReason === undefined ? {} : { reason: safeReason }),
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  /** List memories with scope and attribute filters. */
  list(request: ListRequest = {}): ListResult {
    return this.store.list({
      ...request,
      ...(request.limit === undefined ? { limit: this.resolvedConfig.searchLimit } : {}),
    })
  }

  /** Read-only storage counters, recovery state, latest dream and config summary. */
  status(): MemoryEngineStatus {
    const recentDream = this.store.isReady ? (this.store.dreamList(1)[0] ?? null) : null
    return {
      ready: this.store.isReady,
      counts: this.store.counts(),
      ...(this.store.lastRecovery === undefined ? {} : { lastRecovery: this.store.lastRecovery }),
      recentDream,
      config: this.getConfig(),
    }
  }

  /** List audit entries newest-first, optionally filtered by memory, dream or workspace scope. */
  audit(request: MemoryAuditQuery = {}): AuditListResult {
    if (
      request.dreamId === undefined &&
      (request.workspaceKey === undefined || request.workspaceKey === 'all')
    ) {
      return listAudit(this.domain, request)
    }
    const limit = Math.min(Math.max(request.limit ?? 100, 1), 500)
    const offset = Math.max(request.offset ?? 0, 0)
    const memories = this.domain.table('memories')
    const dreams = this.domain.table('dreams')
    const all = [...this.domain.table('audit').entries()]
      .map(([, record], index) => ({ record, index }))
      .filter(
        ({ record }) => request.memoryId === undefined || record.memoryId === request.memoryId,
      )
      .filter(({ record }) => request.dreamId === undefined || record.dreamId === request.dreamId)
      .filter(({ record }) => {
        if (request.workspaceKey === undefined || request.workspaceKey === 'all') return true
        const candidate =
          record.after ??
          record.before ??
          (record.memoryId === undefined ? undefined : memories.get(MemoryId(record.memoryId)))
        if (candidate !== undefined && candidate !== null) {
          return isRecordVisible(candidate, request.workspaceKey)
        }
        if (record.dreamId !== undefined) {
          const dream = dreams.get(record.dreamId as DreamRun['id'])
          if (dream !== undefined) {
            return (
              dream.scopeKey === 'global' ||
              (request.workspaceKey !== null && dream.scopeKey === request.workspaceKey)
            )
          }
        }
        return false
      })
      .sort(
        (left, right) => right.record.at.localeCompare(left.record.at) || right.index - left.index,
      )
      .map(({ record }) => structuredClone(record))
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }
  }

  /** Strictly read-only export (never triggers `after-export` archive purge). */
  export(request: ExportRequest): MemoryExport {
    return exportMemories(this.domain, request, this.now)
  }

  /** Accept (optionally editing first) or reject one pending dream proposal. */
  async review(request: MemoryReviewInput): Promise<MemoryRecord> {
    await this.ensureReady()
    const id = MemoryId(request.id)
    const current = this.store.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${request.id}' not found`)
    }
    if (
      request.workspaceKey !== undefined &&
      request.workspaceKey !== 'all' &&
      !isRecordVisible(current, request.workspaceKey)
    ) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        `memory '${request.id}' is not visible in the current scope`,
      )
    }
    if (request.action === 'reject') {
      return this.store.rejectProposal(id)
    }
    if (request.action !== 'accept') {
      throw new OperationError(
        'MEMORY_INVALID_QUERY',
        `unknown review action '${String(request.action)}'`,
      )
    }
    const hasEdits =
      request.title !== undefined ||
      request.body !== undefined ||
      request.tags !== undefined ||
      request.importance !== undefined
    if (hasEdits) {
      if (current.status !== 'pending') {
        throw new OperationError(
          'MEMORY_CONFLICT',
          `memory '${request.id}' is not a pending proposal`,
        )
      }
      const nextTitle =
        request.title === undefined ? undefined : normalizeEscapedNewlines(request.title)
      const nextBody =
        request.body === undefined ? undefined : normalizeEscapedNewlines(request.body)
      if (
        (nextTitle !== undefined && detectStrongSecret(nextTitle)) ||
        (nextBody !== undefined && detectStrongSecret(nextBody)) ||
        (request.tags?.some((tag) => detectStrongSecret(tag)) ?? false)
      ) {
        throw new OperationError('MEMORY_INVALID_CONTENT', STRONG_SECRET_WRITE_MESSAGE)
      }
      const patch: MemoryPatch = {
        expectedContentRevision: current.contentRevision,
        ...(nextTitle === undefined ? {} : { title: this.redactText(nextTitle) }),
        ...(nextBody === undefined ? {} : { body: this.redactText(nextBody) }),
        ...(request.tags === undefined
          ? {}
          : { tags: request.tags.map((tag) => this.redactText(tag)) }),
        ...(request.importance === undefined ? {} : { importance: request.importance }),
        markReviewed: true,
        actor: 'user',
      }
      await this.store.update(id, patch)
    }
    return this.store.acceptProposal(id, { actor: 'user', markReviewed: true })
  }

  /** Restore an archived memory to `active` as user-owned. */
  async restore(id: string, workspaceKey: string | 'all' | null = 'all'): Promise<MemoryRecord> {
    await this.ensureReady()
    const current = this.store.get(MemoryId(id))
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (workspaceKey !== 'all' && !isRecordVisible(current, workspaceKey)) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        `memory '${id}' is not visible in the current scope`,
      )
    }
    return this.store.restore(current.id, { actor: 'user' })
  }

  /** Soft or permanent user deletion with optional scope and revision guards. */
  async delete(
    request: MemoryDeleteInput,
  ): Promise<{ deleted: boolean; record: MemoryRecord | null }> {
    await this.ensureReady()
    const id = MemoryId(request.id)
    const current = this.store.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${request.id}' not found`)
    }
    if (
      request.workspaceKey !== undefined &&
      request.workspaceKey !== 'all' &&
      !isRecordVisible(current, request.workspaceKey)
    ) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        `memory '${request.id}' is not visible in the current scope`,
      )
    }
    if (
      request.expectedContentRevision !== undefined &&
      current.contentRevision !== request.expectedContentRevision
    ) {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `memory '${request.id}' is at revision ${current.contentRevision}`,
      )
    }
    if (request.permanent === true) {
      if (request.confirm !== true) {
        throw new OperationError(
          'MEMORY_CONFIRM_REQUIRED',
          'permanent delete requires confirmation',
        )
      }
      await this.store.delete(id, { permanent: true, actor: 'user', confirm: true })
      return { deleted: true, record: null }
    }
    const record = await this.store.delete(id, { actor: 'user' })
    return { deleted: false, record }
  }

  /** Undo every dream-committed change for a dream run and rebuild search index. */
  async undoDream(dreamId: string): Promise<DreamUndoReport> {
    await this.ensureReady()
    if (typeof dreamId !== 'string' || dreamId === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'dream id must be a non-empty string')
    }
    const report = await this.store.runSerialized(() => this.runner.undoDream(dreamId))
    this.syncSearchIndex()
    return report
  }

  /** Import an export snapshot (merge or replace) and rebuild search index. */
  async import(payload: MemoryExport, options: ImportOptions = {}): Promise<ImportReport> {
    await this.ensureReady()
    const resolvedOptions: ImportOptions = {
      ...options,
      redactSecrets: options.redactSecrets ?? this.resolvedConfig.redactSecrets,
    }
    try {
      return await importMemories(this.store, this.domain, payload, resolvedOptions)
    } finally {
      this.syncSearchIndex()
    }
  }

  /** Delete derived data and reset episodes/cursors in a scope, keeping user-owned data. */
  async rebuild(request: RebuildRequest): Promise<RebuildReport> {
    await this.ensureReady()
    const report = await rebuildMemories(this.domain, this.runner, request, this.now, (work) =>
      this.store.runSerialized(work),
    )
    this.syncSearchIndex()
    return report
  }

  /** Permanently clear all memories, episodes and cursors in a scope after confirmation. */
  async purgeAll(request: PurgeRequest): Promise<PurgeReport> {
    await this.ensureReady()
    const report = await purgeAllMemories(this.domain, this.runner, request, this.now, (work) =>
      this.store.runSerialized(work),
    )
    this.syncSearchIndex()
    return report
  }

  /** Apply time-based retention using the current hot configuration. */
  async runRetention(now: Date = this.now()): Promise<{
    archivedWorklogs: number
    deletedEpisodes: number
    purgedArchives: number
  }> {
    await this.ensureReady()
    let archivedWorklogs = 0
    const worklogCutoff = now.getTime() - this.resolvedConfig.worklogRetentionDays * 86_400_000
    for (const [, record] of [...this.domain.table('memories').entries()]) {
      if (
        record.type === 'worklog' &&
        record.worklogKind === 'turn' &&
        record.status === 'active' &&
        !record.pinned &&
        Date.parse(record.updatedAt) <= worklogCutoff
      ) {
        await this.store.archive(record.id, { actor: 'system' })
        archivedWorklogs += 1
      }
    }

    const episodeCutoff = now.getTime() - this.resolvedConfig.episodeRetentionDays * 86_400_000
    const staleEpisodes = [...this.domain.table('episodes').entries()]
      .filter(
        ([, episode]) =>
          episode.status === 'processed' &&
          episode.processedAt !== undefined &&
          Date.parse(episode.processedAt) <= episodeCutoff,
      )
      .map(([id]) => id)
    const deletedEpisodes =
      staleEpisodes.length === 0
        ? 0
        : await this.store.runSerialized(() =>
            this.domain.table('episodes').deleteMany(staleEpisodes),
          )

    let purgedArchives = 0
    if (this.resolvedConfig.archivePurgePolicy === 'age') {
      const archiveCutoff = now.getTime() - this.resolvedConfig.archiveRetentionDays * 86_400_000
      for (const [, record] of [...this.domain.table('memories').entries()]) {
        if (record.status !== 'archived') continue
        if (record.pinned) continue
        if (Date.parse(record.updatedAt) > archiveCutoff) continue
        await this.store.delete(record.id, { permanent: true, actor: 'user', confirm: true })
        purgedArchives += 1
      }
    }

    return { archivedWorklogs, deletedEpisodes, purgedArchives }
  }

  /** List dream runs newest first. */
  dreamList(limit?: number): DreamRun[] {
    return this.store.dreamList(limit)
  }

  /* ------------------------------------------------------------------ *
   * Two-stage Dream & Organize state machine
   * ------------------------------------------------------------------ */

  /**
   * Stage 1 of Dreaming: expire stale runs, claim `new`/`failed-retryable`
   * episodes as `processing`, persist a `running` `DreamRun` without creating a
   * `dream.run` operation, and assemble prompts + schema for the calling agent.
   */
  async prepareDream(input: PrepareDreamInput): Promise<PreparedDreamResult> {
    await this.ensureReady()
    await this.failExpiredDreams()

    this.validateScopeArg(input.scope)
    if (
      input.maxEpisodes !== undefined &&
      (!Number.isInteger(input.maxEpisodes) || input.maxEpisodes < 1)
    ) {
      throw new OperationError(
        'MEMORY_INVALID_QUERY',
        'maxEpisodes must be a positive integer (>= 1)',
      )
    }
    let normalizedSince: string | undefined
    if (input.since !== undefined) {
      const parsed = Date.parse(input.since)
      if (Number.isNaN(parsed)) {
        throw new OperationError('MEMORY_INVALID_QUERY', 'since must be a valid ISO timestamp')
      }
      normalizedSince = new Date(parsed).toISOString()
    }

    const configuredMax = Math.max(1, this.resolvedConfig.dreamMaxEpisodes)
    const limit =
      input.maxEpisodes === undefined ? configuredMax : Math.min(input.maxEpisodes, configuredMax)
    const since =
      normalizedSince ??
      new Date(
        this.now().getTime() - this.resolvedConfig.dreamLookbackDays * 86_400_000,
      ).toISOString()

    const scopeKey = input.scope.kind === 'global' ? 'global' : input.scope.key
    const candidates =
      input.scope.kind === 'global'
        ? []
        : this.store.episodeList({
            workspaceKey: scopeKey,
            statuses: ['new', 'failed-retryable'],
            since,
            limit,
          })

    const dreamId = newDreamId()
    const startedAt = this.nowIso()
    const initialRun: DreamRun = {
      id: dreamId,
      trigger: input.trigger ?? 'manual',
      scopeKey,
      status: 'running',
      startedAt,
      provider: 'agy',
      model: 'agent',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
    await this.store.putDream(initialRun)
    this.preparedScopes.set(dreamId, input.scope)

    const claimed =
      candidates.length === 0
        ? []
        : await this.store.claimEpisodes(
            candidates.map((episode) => episode.id),
            dreamId,
          )
    if (claimed.length > 0) {
      await this.store.putDream({ ...initialRun, episodes: claimed.length })
    }

    const related = this.collectRelated(input.scope, claimed)
    const userPrompt = buildDreamPrompt({
      episodes: claimed.map((episode) => this.redactEpisode(episode)),
      related,
      health: checkDreamHealth(this.store, input.scope),
    })

    return {
      dreamId,
      scope: input.scope,
      episodeIds: claimed.map((episode) => episode.id),
      systemPrompt: DREAM_SYSTEM_PROMPT,
      userPrompt,
      outputSchema: DREAM_OUTPUT_SCHEMA,
    }
  }

  /**
   * Stage 2 of Dreaming: atomically pre-validate the entire proposal batch,
   * write valid proposals as `pending` (`derived`/`dream`), settle claimed
   * episodes (`skipped` when `memories: []`, otherwise `processed` for cited
   * episodes and `failed-retryable` for uncited ones), and complete `DreamRun`.
   */
  async commitDream(input: CommitDreamInput): Promise<CommitDreamResult> {
    await this.ensureReady()
    const dream = this.requireRunningDream(input.dreamId, 'dream')
    if (!Array.isArray(input.memories)) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memories must be an array')
    }

    const claimed = this.claimedEpisodesFor(dream.id)
    const claimedIds = new Set<string>(claimed.map((episode) => episode.id))
    const episodesById = new Map<string, EpisodeRecord>(
      claimed.map((episode) => [episode.id, episode]),
    )
    const scope = this.resolveDreamScope(dream, claimed)

    const validated = input.memories.map((entry) =>
      this.validateDreamProposal(entry, scope, claimedIds, false),
    )
    if (validated.length > 0) {
      this.capacityPolicy.checkCreate(this.store.counts())
    }

    const operation = await this.runner.begin('dream.run', { dreamId: dream.id })
    try {
      if (validated.length === 0) {
        for (const episode of claimed) {
          await this.store.updateEpisode(episode.id, {
            status: 'skipped',
            dreamId: dream.id,
          })
        }
        const finished: DreamRun = {
          ...dream,
          status: 'completed',
          finishedAt: this.nowIso(),
          episodes: claimed.length,
          committed: 0,
          pending: 0,
        }
        await this.store.putDreamTerminal(finished)
        await this.runner.commit(operation)
        this.preparedScopes.delete(dream.id)
        return {
          dreamId: dream.id,
          status: 'completed',
          createdIds: [],
          skippedDuplicates: 0,
          processedEpisodes: 0,
          skippedEpisodes: claimed.length,
        }
      }

      const persisted = await this.persistValidatedProposals(
        validated,
        dream,
        episodesById,
        operation.id,
        this.resolvedConfig.autoAcceptProposals === true,
      )

      const usedIds = [...persisted.usedEpisodeIds] as EpisodeId[]
      if (usedIds.length > 0) {
        await this.store.markEpisodesProcessed(usedIds, dream.id)
      }
      const unusedIds = claimed
        .filter((episode) => !persisted.usedEpisodeIds.has(episode.id))
        .map((episode) => episode.id)
      if (unusedIds.length > 0) {
        await this.store.releaseEpisodes(
          unusedIds,
          dream.id,
          'proposal did not reference this episode',
        )
      }

      const finished: DreamRun = {
        ...dream,
        status: 'completed',
        finishedAt: this.nowIso(),
        episodes: claimed.length,
        committed: persisted.createdIds.length,
        pending: Math.max(
          0,
          persisted.createdIds.length + persisted.updatedCount - persisted.acceptedCount,
        ),
      }
      await this.store.putDreamTerminal(finished)
      await this.runner.commit(operation)
      this.preparedScopes.delete(dream.id)

      return {
        dreamId: dream.id,
        status: 'completed',
        createdIds: persisted.createdIds,
        skippedDuplicates: persisted.skippedDuplicates,
        processedEpisodes: usedIds.length,
        skippedEpisodes: 0,
      }
    } catch (error) {
      await this.runner.markFailed(operation, error)
      throw error
    }
  }

  /**
   * Stage 1 of Organize: expire stale runs, select up to 60 active memories in
   * the target scope, persist a `running` `DreamRun(trigger='organize')` without
   * a `dream.run` operation, and return the organize prompt + schema.
   */
  async prepareOrganize(input: PrepareOrganizeInput): Promise<PreparedDreamResult> {
    await this.ensureReady()
    await this.failExpiredDreams()

    this.validateScopeArg(input.scope)
    if (
      input.maxRecords !== undefined &&
      (!Number.isInteger(input.maxRecords) || input.maxRecords < 1)
    ) {
      throw new OperationError(
        'MEMORY_INVALID_QUERY',
        'maxRecords must be a positive integer (>= 1)',
      )
    }

    const limit = Math.max(
      1,
      Math.min(input.maxRecords ?? ORGANIZE_RECORD_LIMIT, ORGANIZE_RECORD_LIMIT),
    )
    const candidates = this.store
      .activeRecords()
      .filter((record) =>
        input.scope.kind === 'global'
          ? record.scope.kind === 'global'
          : record.scope.kind === 'workspace' && record.scope.key === input.scope.key,
      )
      .sort(
        (left, right) =>
          right.importance - left.importance || left.updatedAt.localeCompare(right.updatedAt),
      )
      .slice(0, limit)
      .map((record) => ({
        ...record,
        title: this.redactText(record.title),
        body: this.redactText(record.body),
      }))

    const dreamId = newDreamId()
    const scopeKey = input.scope.kind === 'global' ? 'global' : input.scope.key
    const initialRun: DreamRun = {
      id: dreamId,
      trigger: 'organize',
      scopeKey,
      status: 'running',
      startedAt: this.nowIso(),
      provider: 'agy',
      model: 'agent',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
    await this.store.putDream(initialRun)
    this.preparedScopes.set(dreamId, input.scope)

    return {
      dreamId,
      scope: input.scope,
      episodeIds: [],
      recordIds: candidates.map((record) => record.id),
      systemPrompt: ORGANIZE_SYSTEM_PROMPT,
      userPrompt: buildOrganizePrompt({ records: candidates }),
      outputSchema: ORGANIZE_OUTPUT_SCHEMA,
    }
  }

  /**
   * Stage 2 of Organize: pre-validate every proposal including non-empty
   * same-scope `active` `supersedes`, write all valid proposals as `pending`
   * (`derived`/`dream`) without mutating existing `active` records, and
   * complete `DreamRun`.
   */
  async commitOrganize(input: CommitDreamInput): Promise<CommitDreamResult> {
    await this.ensureReady()
    const dream = this.requireRunningDream(input.dreamId, 'organize')
    if (!Array.isArray(input.memories)) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memories must be an array')
    }

    const scope = this.resolveDreamScope(dream, [])
    const validated = input.memories.map((entry) =>
      this.validateDreamProposal(entry, scope, new Set<string>(), true),
    )
    if (validated.length > 0) {
      this.capacityPolicy.checkCreate(this.store.counts())
    }

    const operation = await this.runner.begin('dream.run', { dreamId: dream.id })
    try {
      if (validated.length === 0) {
        const finished: DreamRun = {
          ...dream,
          status: 'completed',
          finishedAt: this.nowIso(),
          episodes: 0,
          committed: 0,
          pending: 0,
        }
        await this.store.putDreamTerminal(finished)
        await this.runner.commit(operation)
        this.preparedScopes.delete(dream.id)
        return {
          dreamId: dream.id,
          status: 'completed',
          createdIds: [],
          skippedDuplicates: 0,
          processedEpisodes: 0,
          skippedEpisodes: 0,
        }
      }

      const persisted = await this.persistValidatedProposals(
        validated,
        dream,
        new Map<string, EpisodeRecord>(),
        operation.id,
        false,
      )

      const finished: DreamRun = {
        ...dream,
        status: 'completed',
        finishedAt: this.nowIso(),
        episodes: 0,
        committed: persisted.createdIds.length,
        pending: persisted.createdIds.length + persisted.updatedCount,
      }
      await this.store.putDreamTerminal(finished)
      await this.runner.commit(operation)
      this.preparedScopes.delete(dream.id)

      return {
        dreamId: dream.id,
        status: 'completed',
        createdIds: persisted.createdIds,
        skippedDuplicates: persisted.skippedDuplicates,
        processedEpisodes: 0,
        skippedEpisodes: 0,
      }
    } catch (error) {
      await this.runner.markFailed(operation, error)
      throw error
    }
  }

  /* ------------------------------------------------------------------ *
   * Private dream / proposal helpers
   * ------------------------------------------------------------------ */

  private validateScopeArg(scope: MemoryScope): void {
    if (scope.kind === 'workspace' && (scope.key.trim() === '' || scope.root.trim() === '')) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'workspace scope requires non-empty key and root',
      )
    }
  }

  private requireRunningDream(dreamId: string, expected: 'dream' | 'organize'): DreamRun {
    if (typeof dreamId !== 'string' || dreamId === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'dreamId must be a non-empty string')
    }
    const dream = this.store.getDream(dreamId)
    if (dream === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `dream '${dreamId}' not found`)
    }
    if (dream.status !== 'running') {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `dream '${dreamId}' is ${dream.status} and cannot be committed`,
      )
    }
    if (expected === 'organize' && dream.trigger !== 'organize') {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `dream '${dreamId}' is not an organize run; use commitDream`,
      )
    }
    if (expected === 'dream' && dream.trigger === 'organize') {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `dream '${dreamId}' is an organize run; use commitOrganize`,
      )
    }
    return dream
  }

  private claimedEpisodesFor(dreamId: string): EpisodeRecord[] {
    return [...this.domain.table('episodes').entries()]
      .map(([, episode]) => episode)
      .filter((episode) => episode.dreamId === dreamId && episode.status === 'processing')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  private resolveDreamScope(dream: DreamRun, claimed: readonly EpisodeRecord[]): MemoryScope {
    if (dream.scopeKey === 'global') return { kind: 'global' }
    const cached = this.preparedScopes.get(dream.id)
    if (cached !== undefined && cached.kind === 'workspace' && cached.key === dream.scopeKey) {
      return cached
    }
    const fromEpisode = claimed[0]?.workspaceRoot ?? this.store.episodeWorkspaceRoot(dream.scopeKey)
    if (fromEpisode !== undefined) {
      return { kind: 'workspace', key: dream.scopeKey, root: fromEpisode }
    }
    for (const [, record] of this.domain.table('memories').entries()) {
      if (record.scope.kind === 'workspace' && record.scope.key === dream.scopeKey) {
        return { kind: 'workspace', key: dream.scopeKey, root: record.scope.root }
      }
    }
    return { kind: 'workspace', key: dream.scopeKey, root: dream.scopeKey }
  }

  private validateDreamProposal(
    raw: unknown,
    scope: MemoryScope,
    claimedEpisodeIds: ReadonlySet<string>,
    isOrganize: boolean,
  ): DreamProposalOutput {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'proposal entry must be an object')
    }
    const entry = raw as Record<string, unknown>
    const type = entry.type
    if (typeof type !== 'string' || !MEMORY_TYPES.has(type as MemoryType)) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'proposal entry has an invalid type')
    }
    if (scope.kind === 'global' && type !== 'preference') {
      throw new OperationError('MEMORY_FORBIDDEN_SCOPE', 'only preference memories may be global')
    }
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        'proposal entry title and body must be strings',
      )
    }

    const rawTitle = entry.title.trim()
    const rawBody = entry.body
    const rawTags =
      entry.tags === undefined
        ? undefined
        : Array.isArray(entry.tags)
          ? entry.tags
          : (() => {
              throw new OperationError('MEMORY_INVALID_CONTENT', 'proposal tags must be an array')
            })()
    if (rawTags !== undefined) {
      for (const tag of rawTags) {
        if (typeof tag !== 'string') {
          throw new OperationError('MEMORY_INVALID_CONTENT', 'proposal tags must be strings')
        }
      }
    }

    if (
      detectStrongSecret(rawTitle) ||
      detectStrongSecret(rawBody) ||
      (rawTags?.some((tag) => detectStrongSecret(tag as string)) ?? false)
    ) {
      throw new OperationError('MEMORY_INVALID_CONTENT', STRONG_SECRET_WRITE_MESSAGE)
    }

    const title = this.redactText(rawTitle)
    const body = this.redactText(rawBody)
    const tags = rawTags?.map((tag) => this.redactText(tag as string))

    if ([...title].length < 1 || [...title].length > MAX_MEMORY_TITLE_LENGTH) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `title must be 1-${MAX_MEMORY_TITLE_LENGTH} characters`,
      )
    }
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes < 1 || bodyBytes > MAX_MEMORY_BODY_BYTES) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `body must be 1-${MAX_MEMORY_BODY_BYTES} bytes`,
      )
    }
    if (tags !== undefined && tags.length > MAX_MEMORY_TAGS) {
      throw new OperationError('MEMORY_INVALID_CONTENT', `at most ${MAX_MEMORY_TAGS} tags`)
    }

    const confidence = this.validateUnitRatio(entry.confidence, 'confidence')
    const importance = this.validateUnitRatio(entry.importance, 'importance')

    let sourceEpisodeIds: string[] = []
    if (!isOrganize) {
      if (!Array.isArray(entry.sourceEpisodeIds)) {
        throw new OperationError(
          'MEMORY_INVALID_CONTENT',
          'dream proposal must include sourceEpisodeIds',
        )
      }
      const uniqueIds: string[] = []
      const seen = new Set<string>()
      for (const id of entry.sourceEpisodeIds) {
        if (typeof id !== 'string' || id === '') {
          throw new OperationError(
            'MEMORY_INVALID_CONTENT',
            'sourceEpisodeIds must be non-empty strings',
          )
        }
        if (!claimedEpisodeIds.has(id)) {
          throw new OperationError(
            'MEMORY_INVALID_CONTENT',
            `proposal cites un-claimed episode '${id}'`,
          )
        }
        if (!seen.has(id)) {
          seen.add(id)
          uniqueIds.push(id)
        }
      }
      if (uniqueIds.length === 0) {
        throw new OperationError(
          'MEMORY_INVALID_CONTENT',
          'dream proposal must cite at least one claimed episode',
        )
      }
      if (uniqueIds.length > MAX_MEMORY_SUPERSEDES) {
        throw new OperationError(
          'MEMORY_INVALID_CONTENT',
          `at most ${MAX_MEMORY_SUPERSEDES} source episodes`,
        )
      }
      sourceEpisodeIds = uniqueIds
    }

    let supersedes: string[] | undefined
    if (entry.supersedes !== undefined) {
      if (!Array.isArray(entry.supersedes)) {
        throw new OperationError('MEMORY_INVALID_CONTENT', 'supersedes must be an array')
      }
      const uniqueSup: string[] = []
      const seenSup = new Set<string>()
      for (const supId of entry.supersedes) {
        if (typeof supId !== 'string' || supId === '') {
          throw new OperationError(
            'MEMORY_INVALID_CONTENT',
            'supersedes entries must be non-empty strings',
          )
        }
        if (!seenSup.has(supId)) {
          seenSup.add(supId)
          uniqueSup.push(supId)
        }
      }
      if (uniqueSup.length > MAX_MEMORY_SUPERSEDES) {
        throw new OperationError(
          'MEMORY_INVALID_CONTENT',
          `at most ${MAX_MEMORY_SUPERSEDES} superseded memories`,
        )
      }
      for (const supId of uniqueSup) {
        const target = this.store.get(MemoryId(supId))
        if (target === undefined) {
          throw new OperationError(
            'MEMORY_INVALID_CONTENT',
            `superseded memory '${supId}' does not exist`,
          )
        }
        if (!sameScope(target.scope, scope)) {
          throw new OperationError(
            'MEMORY_FORBIDDEN_SCOPE',
            `superseded memory '${supId}' belongs to a different scope`,
          )
        }
        if (target.status !== 'active') {
          throw new OperationError(
            'MEMORY_INVALID_CONTENT',
            `superseded memory '${supId}' is ${target.status}, not active`,
          )
        }
      }
      supersedes = uniqueSup
    }

    if (isOrganize && (supersedes === undefined || supersedes.length === 0)) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        'an organize proposal must include a non-empty supersedes array',
      )
    }

    const worklogKind: WorklogKind | undefined = type === 'worklog' ? 'daily' : undefined
    return {
      type: type as MemoryType,
      ...(worklogKind === undefined ? {} : { worklogKind }),
      scope,
      title,
      body,
      ...(tags === undefined ? {} : { tags }),
      confidence,
      importance,
      sourceEpisodeIds,
      ...(supersedes === undefined ? {} : { supersedes }),
    }
  }

  private validateUnitRatio(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new OperationError('MEMORY_INVALID_CONTENT', `${field} must be between 0 and 1`)
    }
    return value
  }

  private async persistValidatedProposals(
    proposals: readonly DreamProposalOutput[],
    dream: DreamRun,
    episodesById: ReadonlyMap<string, EpisodeRecord>,
    operationId: string,
    autoAccept: boolean,
  ): Promise<{
    createdIds: string[]
    updatedCount: number
    acceptedCount: number
    skippedDuplicates: number
    usedEpisodeIds: Set<string>
  }> {
    const createdIds: string[] = []
    let updatedCount = 0
    let acceptedCount = 0
    let skippedDuplicates = 0
    const usedEpisodeIds = new Set<string>()

    const tryAutoAccept = async (id: MemoryRecord['id']): Promise<void> => {
      if (!autoAccept) return
      try {
        await this.store.acceptProposal(id, {
          actor: 'system',
          markReviewed: false,
          dreamId: dream.id,
        })
        acceptedCount += 1
      } catch (error) {
        this.logger?.warn?.(
          `memloom: auto-accept left proposal ${id} pending: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    for (const proposal of proposals) {
      for (const episodeId of proposal.sourceEpisodeIds) usedEpisodeIds.add(episodeId)

      const key = computeProposalKey(proposal)
      const exact = this.store.findMemoryByProposalKey(key)
      if (exact !== undefined) {
        skippedDuplicates += 1
        continue
      }

      const semanticMatch =
        proposal.sourceEpisodeIds.length > 0
          ? this.store.findSemanticProposal(
              proposal.scope,
              proposal.type,
              normalizeTitle(proposal.title),
              proposal.sourceEpisodeIds,
            )
          : undefined
      const existing =
        semanticMatch ??
        this.store.findSimilarProposal(proposal.scope, proposal.type, proposal.body)

      if (existing !== undefined) {
        const policy = applyDuplicatePolicy(existing, proposal)
        if (policy === 'update-pending') {
          const mergedSupersedes =
            proposal.supersedes === undefined && existing.supersedes.length === 0
              ? undefined
              : [...new Set([...existing.supersedes, ...(proposal.supersedes ?? [])])]
          await this.store.updateDreamProposal(
            existing.id,
            {
              title: proposal.title,
              body: proposal.body,
              ...(proposal.tags === undefined ? {} : { tags: proposal.tags }),
              confidence: proposal.confidence,
              importance: proposal.importance,
              sourceEpisodeIds: [
                ...new Set([...existing.sourceEpisodeIds, ...proposal.sourceEpisodeIds]),
              ],
              ...(mergedSupersedes === undefined ? {} : { supersedes: mergedSupersedes }),
              proposalKey: key,
            },
            dream.id,
            operationId,
          )
          updatedCount += 1
          await tryAutoAccept(existing.id)
        } else {
          skippedDuplicates += 1
        }
        continue
      }

      const record = this.buildPendingProposalRecord(proposal, key, episodesById)
      await this.store.writeDreamProposal(record, dream.id, operationId)
      createdIds.push(record.id)
      await tryAutoAccept(record.id)
    }

    return {
      createdIds,
      updatedCount,
      acceptedCount,
      skippedDuplicates,
      usedEpisodeIds,
    }
  }

  private buildPendingProposalRecord(
    proposal: DreamProposalOutput,
    proposalKey: string,
    episodesById: ReadonlyMap<string, EpisodeRecord>,
  ): MemoryRecord {
    const nowIso = this.nowIso()
    const sourceRefs = proposal.sourceEpisodeIds
      .map((id) => episodesById.get(id))
      .filter((episode): episode is EpisodeRecord => episode !== undefined)
      .map((episode) => ({
        sessionId: episode.sessionId,
        turn: episode.turn,
        ...(episode.sourceSeqs[0] === undefined ? {} : { eventSeq: episode.sourceSeqs[0] }),
      }))

    return {
      id: newMemoryId(),
      type: proposal.type,
      ...(proposal.worklogKind === undefined ? {} : { worklogKind: proposal.worklogKind }),
      scope: proposal.scope,
      origin: 'dream',
      ownership: 'derived',
      pinned: false,
      title: proposal.title,
      body: proposal.body,
      tags: proposal.tags ?? [],
      status: 'pending',
      confidence: proposal.confidence,
      importance: proposal.importance,
      contentRevision: 1,
      statsRevision: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      matchCount: 0,
      useCount: 0,
      sourceRefs,
      sourceEpisodeIds: [...proposal.sourceEpisodeIds],
      supersedes: [...(proposal.supersedes ?? [])],
      proposalKey,
      contentHash: '',
    }
  }

  private collectRelated(scope: MemoryScope, claimed: readonly EpisodeRecord[]): MemoryRecord[] {
    const query = claimed
      .map((episode) =>
        [episode.prompt, episode.assistantFinal, episode.toolError]
          .filter((text): text is string => typeof text === 'string' && text !== '')
          .join(' '),
      )
      .join(' ')
      .slice(0, 800)
      .trim()

    const workspaceKey = scope.kind === 'workspace' ? scope.key : null
    if (query !== '') {
      const hits = this.search({
        query,
        workspaceKey,
        scope: scope.kind === 'global' ? 'global' : 'auto',
        limit: RELATED_MEMORY_LIMIT,
      }).results
      const records: MemoryRecord[] = []
      for (const hit of hits) {
        const record = this.store.get(MemoryId(hit.id))
        if (record !== undefined && isRecordVisible(record, workspaceKey)) {
          records.push({ ...record, title: this.redactText(record.title) })
        }
        if (records.length >= RELATED_MEMORY_LIMIT) break
      }
      return records
    }

    return this.store
      .activeRecords()
      .filter((record) => {
        if (record.scope.kind === 'global') return record.type === 'preference'
        if (scope.kind === 'global') return false
        return record.scope.key === scope.key
      })
      .slice(0, RELATED_MEMORY_LIMIT)
      .map((record) => ({ ...record, title: this.redactText(record.title) }))
  }

  private redactEpisode(episode: EpisodeRecord): EpisodeRecord {
    return {
      ...episode,
      files: episode.files.map((file) => this.redactText(file)),
      ...(episode.prompt === undefined ? {} : { prompt: this.redactText(episode.prompt) }),
      ...(episode.assistantFinal === undefined
        ? {}
        : { assistantFinal: this.redactText(episode.assistantFinal) }),
      ...(episode.correctionText === undefined
        ? {}
        : { correctionText: this.redactText(episode.correctionText) }),
      ...(episode.toolError === undefined ? {} : { toolError: this.redactText(episode.toolError) }),
    }
  }
}
