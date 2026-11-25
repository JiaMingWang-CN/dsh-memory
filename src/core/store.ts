/**
 * `MemoryStore` — domain CRUD, scope filtering and audit over the memory tables.
 *
 * Every write is serialized as a whole logical operation through this store's
 * own promise chain and then persisted by {@link OperationRunner}. The class
 * enforces lifecycle rules (scope, revisions, ownership, soft vs. permanent
 * delete), capacity gates, retention and maintenance. The single
 * `MemoryService` owns one instance.
 * @module dsh-memory/core/store
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { ZodError } from 'zod'
import {
  AuditId,
  MemoryId,
  memoryRecordSchema,
  newAuditId,
  newEpisodeId,
  newMemoryId,
  type AuditActor,
  type AuditRecord,
  type DreamRun,
  type EpisodeId,
  type EpisodeKind,
  type EpisodeRecord,
  type EpisodeStatus,
  type MemoryOrigin,
  type MemoryOwnership,
  type MemoryRecord,
  type MemoryScope,
  type MemorySourceRef,
  type MemoryStatus,
  type MemoryType,
  type OperationKind,
  type OperationRecord,
  type WorklogKind,
} from '../shared/types.ts'
import { contentDigest, type MemoryDomainHandle } from './storage-contract.ts'
import { tokenize } from './search.ts'
import { listAudit } from './audit.ts'
import type { AuditListRequest, AuditListResult } from './audit.ts'
import { OperationError, OperationRunner, type RecoveryReport } from './operations.ts'

/** Largest memory title, in characters. */
export const MAX_MEMORY_TITLE_LENGTH = 200
/** Largest memory body, in UTF-8 bytes. */
export const MAX_MEMORY_BODY_BYTES = 65_536
/** Largest tag list on one memory. */
export const MAX_MEMORY_TAGS = 32
/** Largest source-reference list on one memory. */
export const MAX_MEMORY_SOURCES = 32
/** Largest supersede list on one proposal. */
export const MAX_MEMORY_SUPERSEDES = 128

/** Input accepted by {@link MemoryStore.create}. */
export interface MemoryInput {
  type: MemoryType
  title: string
  body: string
  scope: MemoryScope
  tags?: string[]
  importance?: number
  confidence?: number
  pinned?: boolean
  status?: MemoryStatus
  origin?: MemoryOrigin
  ownership?: MemoryOwnership
  worklogKind?: WorklogKind
  sourceRefs?: MemorySourceRef[]
  sourceEpisodeIds?: string[]
  supersedes?: string[]
  proposalKey?: string
  reviewedByUserAt?: string
  expiresAt?: string
  actor?: AuditActor
  dreamId?: string
  id?: MemoryId
}

/** Patch accepted by {@link MemoryStore.update}. Statistics are never patched here. */
export interface MemoryPatch {
  expectedContentRevision: number
  type?: MemoryType
  title?: string
  body?: string
  tags?: string[]
  scope?: MemoryScope
  status?: MemoryStatus
  importance?: number
  confidence?: number
  pinned?: boolean
  /** Explicit write ownership change, without recording user review. */
  ownership?: MemoryOwnership
  /** Replacement source references (quotes are expected to be pre-redacted). */
  sourceRefs?: MemorySourceRef[]
  markReviewed?: boolean
  actor?: AuditActor
}

/** Page/filter request for {@link MemoryStore.list}. */
export interface ListRequest {
  workspaceKey?: string | 'all' | null
  scopeKind?: 'workspace' | 'global'
  type?: MemoryType
  status?: MemoryStatus
  tags?: string[]
  /** Case-insensitive keyword filter matched against title, body and tags. */
  query?: string
  limit?: number
  offset?: number
  /** Explicit management-page request; required for `workspaceKey: 'all'`. */
  management?: boolean
  /** Include expired active records (management pages only). */
  includeExpired?: boolean
}

/** Page result of {@link MemoryStore.list}. */
export interface ListResult {
  items: MemoryRecord[]
  total: number
  limit: number
  offset: number
  truncated: boolean
}

/** Counts used by capacity decisions. */
export interface StoreCounts {
  active: number
  archived: number
  pending: number
  stored: number
  queuedEpisodes: number
  auditRecords: number
  operationRecords: number
}

/** Structural capacity controller the store consults before creating. */
export interface CapacityController {
  checkCreate(counts: StoreCounts): void
  checkBatchTotals?(counts: StoreCounts, addedArchived: number): void
  onActiveOverflow(active: MemoryRecord[], incoming?: number): MemoryRecord[]
  checkEpisodeQueue?(counts: StoreCounts): void
  /** The configured active-record ceiling. */
  readonly activeLimit: number
  /** Throw when activation of one more record would exceed the ceiling. */
  assertActiveRoom(activeCount: number, freed?: number): void
}

/** Operations exposed inside {@link MemoryStore.runBatch} without re-entering the write queue. */
export interface MemoryStoreBatch {
  create(input: MemoryInput, requestId?: string): Promise<MemoryRecord>
  delete(id: MemoryId, options?: DeleteOptions): Promise<MemoryRecord | null>
  restoreSnapshot(record: MemoryRecord): Promise<void>
  removeRawMemory(id: MemoryId): Promise<void>
  findActiveByTitle(scope: MemoryScope, type: MemoryType, title: string): MemoryRecord | undefined
  findRequest(requestId: string): Promise<OperationRecord | undefined>
}

export interface DeleteOptions {
  permanent?: boolean
  actor?: AuditActor
  confirm?: boolean
  requestId?: string
}

export interface ArchiveOptions {
  actor?: AuditActor
  reason?: string
  requestId?: string
  dreamId?: string
}

/** Options accepted by {@link MemoryStore.acceptProposal}. */
export interface AcceptProposalOptions {
  requestId?: string
  actor?: AuditActor
  /**
   * When true (default, human review), ownership promotes to `user` and
   * `reviewedByUserAt` is stamped. When false (automatic opt-in acceptance),
   * ownership stays `derived` so rebuild/capacity rules continue to protect
   * user-owned memories.
   */
  markReviewed?: boolean
  dreamId?: string
}

/** One captured episode waiting in the dream queue. */
export interface EpisodeInput {
  sessionId: string
  workspaceKey: string
  workspaceRoot: string
  kind: EpisodeKind
  turn: number
  sourceSeqs: number[]
  prompt?: string
  assistantFinal?: string
  toolName?: string
  toolError?: string
  files?: string[]
  correctionText?: string
  outcome?: string
  failureCode?: string
  failureMessage?: string
}

/** Episode queue read filter. */
export interface EpisodeFilter {
  workspaceKey?: string
  statuses?: EpisodeStatus[]
  since?: string
  limit?: number
}

/** Field patch accepted by {@link MemoryStore.updateDreamProposal}. */
export interface DreamProposalPatch {
  title?: string
  body?: string
  tags?: string[]
  confidence?: number
  importance?: number
  sourceEpisodeIds?: string[]
  supersedes?: string[]
  proposalKey?: string
}

/** One store mutation observed by derived state such as the search index. */
export type MemoryStoreChange =
  { action: 'upsert'; record: MemoryRecord } | { action: 'remove'; id: string }

export type ArchivePurgePolicy = 'manual' | 'after-export' | 'age'

export interface MemoryStoreOptions {
  now?: () => Date
  defaultWorkspaceKey?: string
  capacity?: CapacityController
  searchLimit?: number
  worklogRetentionDays?: number
  episodeRetentionDays?: number
  archivePurgePolicy?: ArchivePurgePolicy
  archiveRetentionDays?: number
  /** Receives every committed memory mutation; derived indexes must not throw. */
  onChange?: (change: MemoryStoreChange) => void
  /** Host logger; a dropped capture is reported through it when present. */
  logger?: { warn?: (message: string) => void }
}

/** Default page size of {@link MemoryStore.list}. */
export const DEFAULT_LIST_LIMIT = 20
/** Largest page size of one list request. */
export const MAX_LIST_LIMIT = 50

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

/** Distinct query terms of a text, for similarity checks. */
function termSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

/** Jaccard similarity of two term sets. */
function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const term of left) if (right.has(term)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** Whether two stored scopes name the same global layer or the same workspace. */
function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === 'global' || right.kind === 'global') return left.kind === right.kind
  return left.key === right.key
}

/** The memory CRUD and audit facade shared by later Remote, tools and commands. */
export class MemoryStore {
  private readonly domain: MemoryDomainHandle
  private readonly runner: OperationRunner
  private readonly now: () => Date
  private readonly defaultWorkspaceKey: string | undefined
  private readonly capacity: CapacityController | undefined
  private readonly searchLimit: number
  private readonly worklogRetentionDays: number
  private readonly episodeRetentionDays: number
  private readonly archivePurgePolicy: ArchivePurgePolicy
  private readonly archiveRetentionDays: number
  private readonly onChange: ((change: MemoryStoreChange) => void) | undefined
  private readonly logger: { warn?: (message: string) => void } | undefined
  private ready = false
  private stopped = false
  private lastRecoveryReport: RecoveryReport | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly inBatch = new AsyncLocalStorage<boolean>()
  private lastEpisodeOverflowWarnAt: number | undefined = undefined

  constructor(
    domain: MemoryDomainHandle,
    runner: OperationRunner,
    options: MemoryStoreOptions = {},
  ) {
    this.domain = domain
    this.runner = runner
    this.now = options.now ?? (() => new Date())
    this.defaultWorkspaceKey = options.defaultWorkspaceKey
    this.capacity = options.capacity
    this.searchLimit = options.searchLimit ?? DEFAULT_LIST_LIMIT
    this.worklogRetentionDays = options.worklogRetentionDays ?? 90
    this.episodeRetentionDays = options.episodeRetentionDays ?? 30
    this.archivePurgePolicy = options.archivePurgePolicy ?? 'manual'
    this.archiveRetentionDays = options.archiveRetentionDays ?? 365
    this.onChange = options.onChange
    this.logger = options.logger
  }

  /**
   * Run startup recovery, then open the store for reads and writes.
   * @returns The recovery report.
   */
  async initialize(): Promise<RecoveryReport> {
    return this.serialize(async () => {
      const report = await this.runner.recover()
      this.lastRecoveryReport = report
      this.ready = true
      return report
    })
  }

  /** Stop accepting new writes; in-flight work remains on the queue for {@link flush}. */
  stop(): void {
    this.stopped = true
  }

  /** Wait for every queued store operation and the operation runner to settle. */
  async flush(): Promise<void> {
    await this.chain
    await this.runner.flush()
  }

  /** Whether startup recovery has completed. */
  get isReady(): boolean {
    return this.ready
  }

  /** Operation runner used by batch maintenance entry points (import/rebuild/purge). */
  get operationRunner(): OperationRunner {
    return this.runner
  }

  /** Most recent recovery report, if recovery has run. */
  get lastRecovery(): RecoveryReport | undefined {
    return this.lastRecoveryReport
  }

  private get memories() {
    return this.domain.table('memories')
  }

  private get audit() {
    return this.domain.table('audit')
  }

  private get episodes() {
    return this.domain.table('episodes')
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private emitChange(change: MemoryStoreChange): void {
    try {
      this.onChange?.(change)
    } catch {
      // A derived index must never be able to corrupt the durable store path.
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.inBatch.getStore() === true) return work()
    const pending = this.chain.then(work)
    this.chain = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  /**
   * Run one maintenance batch inside the same write queue as business writes.
   *
   * Composite import/rebuild/purge/undo batches touch domain tables directly;
   * without this they could delete rows while a serialized capture or dream
   * write is in flight.
   * @param work - Table-only maintenance work.
   * @returns The callback result.
   */
  runSerialized<T>(work: () => Promise<T>): Promise<T> {
    return this.serialize(work)
  }

  /**
   * Run a multi-step store batch inside a single serialized queue turn.
   *
   * Calls to `MemoryStore` write methods inside `work` re-enter the held queue
   * turn via `AsyncLocalStorage` instead of deadlocking, while external
   * concurrent writers still wait until the entire batch completes.
   */
  runBatch<T>(work: (batch: MemoryStoreBatch) => Promise<T>): Promise<T> {
    return this.serialize(() =>
      this.inBatch.run(true, async () => {
        this.assertReady()
        const batch: MemoryStoreBatch = {
          create: (input, requestId) => this.createUnlocked(input, requestId),
          delete: (id, options = {}) => this.deleteUnlocked(id, options),
          restoreSnapshot: async (record) => {
            const validated = this.stamp(record)
            await this.memories.put(validated.id, validated)
            this.emitChange({ action: 'upsert', record: validated })
          },
          removeRawMemory: async (id) => {
            if (this.memories.get(id) === undefined) return
            await this.memories.delete(id)
            this.emitChange({ action: 'remove', id })
          },
          findActiveByTitle: (scope, type, title) => this.findActiveByTitle(scope, type, title),
          findRequest: (requestId) => this.runner.findRequest(requestId),
        }
        return work(batch)
      }),
    )
  }

  private assertReady(): void {
    if (this.stopped) {
      throw new OperationError('MEMORY_STOPPED', 'memory service is stopping')
    }
    if (!this.ready) {
      throw new OperationError('MEMORY_RECOVERING', 'memory service is still recovering')
    }
  }

  /**
   * Refuse a change that would make one more record active when the active cap
   * is already reached. Restore and explicit status changes never archive
   * another record as a side effect.
   */
  private assertActiveRoom(): void {
    this.capacity?.assertActiveRoom(this.activeRecords().length)
  }

  private stamp(record: MemoryRecord): MemoryRecord {
    try {
      return memoryRecordSchema.parse({ ...record, contentHash: contentDigest(record) })
    } catch (error) {
      if (error instanceof ZodError) {
        throw new OperationError(
          'MEMORY_INVALID_CONTENT',
          error.issues[0]?.message ?? error.message,
        )
      }
      throw error
    }
  }

  private validateFieldBounds(fields: {
    title?: string
    body?: string
    importance?: number
    confidence?: number
    tags?: readonly string[]
    sourceRefs?: readonly MemorySourceRef[]
  }): void {
    if (
      fields.title !== undefined &&
      ([...fields.title].length < 1 || [...fields.title].length > MAX_MEMORY_TITLE_LENGTH)
    ) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `title must be 1-${MAX_MEMORY_TITLE_LENGTH} characters`,
      )
    }
    if (fields.body !== undefined) {
      const bodyBytes = Buffer.byteLength(fields.body, 'utf8')
      if (bodyBytes < 1 || bodyBytes > MAX_MEMORY_BODY_BYTES) {
        throw new OperationError(
          'MEMORY_INVALID_CONTENT',
          `body must be 1-${MAX_MEMORY_BODY_BYTES} bytes`,
        )
      }
    }
    if (
      fields.importance !== undefined &&
      (!Number.isFinite(fields.importance) || fields.importance < 0 || fields.importance > 1)
    ) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'importance must be between 0 and 1')
    }
    if (
      fields.confidence !== undefined &&
      (!Number.isFinite(fields.confidence) || fields.confidence < 0 || fields.confidence > 1)
    ) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'confidence must be between 0 and 1')
    }
    if ((fields.tags?.length ?? 0) > MAX_MEMORY_TAGS) {
      throw new OperationError('MEMORY_INVALID_CONTENT', `at most ${MAX_MEMORY_TAGS} tags`)
    }
    if ((fields.sourceRefs?.length ?? 0) > MAX_MEMORY_SOURCES) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `at most ${MAX_MEMORY_SOURCES} source references`,
      )
    }
  }

  private validateScope(type: MemoryType, scope: MemoryScope): void {
    if (scope.kind === 'global' && type !== 'preference') {
      throw new OperationError('MEMORY_FORBIDDEN_SCOPE', 'only preference memories may be global')
    }
  }

  /**
   * Validate one memory input against every business rule that is independent
   * of the current table contents. Import preflight uses this before any
   * destructive step so a schema-valid document cannot erase data and then be
   * rejected by the store.
   * @param input - Memory fields that would be passed to {@link create}.
   */
  validateMemoryInput(input: MemoryInput): void {
    this.validateScope(input.type, input.scope)
    this.validateFieldBounds({
      title: input.title,
      body: input.body,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }),
    })
    if ((input.sourceEpisodeIds?.length ?? 0) > MAX_MEMORY_SUPERSEDES) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `at most ${MAX_MEMORY_SUPERSEDES} source episodes`,
      )
    }
    if ((input.supersedes?.length ?? 0) > MAX_MEMORY_SUPERSEDES) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `at most ${MAX_MEMORY_SUPERSEDES} superseded memories`,
      )
    }
    // Validate the exact record shape (including the derived-source rule)
    // without writing it.
    this.materializeRecord(input)
  }

  /**
   * Check a batch create against the hard capacity caps after a planned
   * deletion, without changing any row.
   * @param deleted - Existing rows that will disappear before the creates.
   * @param inputs - Records about to be created.
   */
  validateCreateBatch(deleted: readonly MemoryRecord[], inputs: readonly MemoryInput[]): void {
    if (this.capacity === undefined) return
    const counts = this.counts()
    let stored = counts.stored - deleted.length
    let archived = counts.archived - deleted.filter((record) => record.status === 'archived').length
    let active = counts.active - deleted.filter((record) => record.status === 'active').length
    let addedArchived = 0
    for (const input of inputs) {
      stored += 1
      const status = input.status ?? 'active'
      if (status === 'archived') {
        archived += 1
        addedArchived += 1
      }
      if (status === 'active') active += 1
    }
    if (this.capacity.checkBatchTotals !== undefined) {
      this.capacity.checkBatchTotals({ ...counts, stored, archived }, addedArchived)
    } else if (stored > 0) {
      // Fallback for custom test CapacityController implementations without checkBatchTotals.
      this.capacity.checkCreate({
        ...counts,
        stored: Math.max(0, stored - 1),
        archived: addedArchived > 0 ? Math.max(0, archived - 1) : 0,
      })
    }
    if (active > this.capacity.activeLimit) {
      throw new OperationError('MEMORY_CAPACITY', 'active memory limit reached')
    }
  }

  /** Build the normalized record for one create input without persisting it. */
  private materializeRecord(input: MemoryInput): MemoryRecord {
    const nowIso = this.nowIso()
    const origin = input.origin ?? 'user'
    return this.stamp({
      id: input.id ?? newMemoryId(),
      type: input.type,
      ...(input.worklogKind === undefined ? {} : { worklogKind: input.worklogKind }),
      scope: input.scope,
      origin,
      ownership:
        input.ownership ??
        (origin === 'dream' || (origin === 'system' && input.type === 'worklog')
          ? 'derived'
          : 'user'),
      pinned: input.pinned ?? false,
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      status: input.status ?? 'active',
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.5,
      contentRevision: 1,
      statsRevision: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      matchCount: 0,
      useCount: 0,
      sourceRefs: input.sourceRefs ?? [],
      sourceEpisodeIds: input.sourceEpisodeIds ?? [],
      supersedes: input.supersedes ?? [],
      ...(input.proposalKey === undefined ? {} : { proposalKey: input.proposalKey }),
      ...(input.reviewedByUserAt === undefined ? {} : { reviewedByUserAt: input.reviewedByUserAt }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      contentHash: '',
    })
  }

  /**
   * Create one memory through the operation log.
   * @param input - Memory fields.
   * @param requestId - Optional caller request identity for dedupe.
   * @returns The stored record (or the original record for a deduped request).
   */
  async create(input: MemoryInput, requestId?: string): Promise<MemoryRecord> {
    return this.serialize(() => this.createUnlocked(input, requestId))
  }

  private async createUnlocked(input: MemoryInput, requestId?: string): Promise<MemoryRecord> {
    this.assertReady()
    if (requestId !== undefined) {
      const existing = await this.runner.findRequest(requestId)
      if (existing !== undefined) {
        if (existing.kind !== 'memory.create') {
          throw new OperationError(
            'MEMORY_CONFLICT',
            `requestId "${requestId}" belongs to a different operation`,
          )
        }
        if (existing.status === 'failed') {
          throw new OperationError(
            'MEMORY_CONFLICT',
            existing.error ?? 'operation previously failed',
          )
        }
        if (existing.status !== 'committed') {
          await this.runner.commit(await this.runner.apply(existing))
        }
        const after = existing.after as MemoryRecord | undefined
        if (after === undefined) {
          throw new OperationError(
            'MEMORY_CONFLICT',
            `requestId "${requestId}" refers to a permanently deleted memory`,
          )
        }
        const result = this.memories.get(after.id) ?? after
        this.emitChange({ action: 'upsert', record: result })
        return result
      }
    }
    this.validateMemoryInput(input)
    const record = this.materializeRecord(input)
    if (this.capacity !== undefined) {
      const counts = this.counts()
      this.capacity.checkCreate(counts)
      // A pending or archived create does not consume an active slot.
      const incoming = (input.status ?? 'active') === 'active' ? 1 : 0
      const active = this.activeRecords()
      const victims = incoming === 0 ? [] : this.capacity.onActiveOverflow(active, incoming)
      // Only derived, unpinned records may be demoted automatically. When the
      // active set is full of user-owned records, refuse the write instead of
      // silently archiving something the user owns.
      if (active.length - victims.length + incoming > this.capacity.activeLimit) {
        throw new OperationError(
          'MEMORY_CAPACITY',
          'active memory limit reached; no derived memory can be archived',
        )
      }
      for (const victim of victims) {
        await this.archiveUnlocked(victim.id, { actor: 'system' })
      }
    }
    const operation = await this.runOperationUnlocked(
      'memory.create',
      {
        record,
        actor: input.actor ?? 'user',
        ...(input.dreamId === undefined ? {} : { dreamId: input.dreamId }),
      },
      requestId,
    )
    const stored = operation.after as MemoryRecord | undefined
    const result = this.memories.get(stored?.id ?? record.id) ?? stored ?? record
    this.emitChange({ action: 'upsert', record: result })
    return result
  }

  /**
   * Update business fields with optimistic concurrency.
   * @param id - Memory identity.
   * @param patch - Fields to change plus the expected revision.
   * @returns The updated record (or the current record for a no-op patch).
   */
  async update(id: MemoryId, patch: MemoryPatch, requestId?: string): Promise<MemoryRecord> {
    return this.serialize(() => this.updateUnlocked(id, patch, requestId))
  }

  private async updateUnlocked(
    id: MemoryId,
    patch: MemoryPatch,
    requestId?: string,
  ): Promise<MemoryRecord> {
    this.assertReady()
    const replayed = await this.replayRequest(requestId, 'memory.update', id)
    if (replayed !== undefined) {
      this.emitChange({ action: 'upsert', record: replayed })
      return replayed
    }
    const current = this.memories.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (current.contentRevision !== patch.expectedContentRevision) {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `memory '${id}' is at revision ${current.contentRevision}`,
      )
    }
    const nextScope = patch.scope ?? current.scope
    const nextType = patch.type ?? current.type
    this.validateScope(nextType, nextScope)
    this.validateFieldBounds({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.importance === undefined ? {} : { importance: patch.importance }),
      ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
      ...(patch.sourceRefs === undefined ? {} : { sourceRefs: patch.sourceRefs }),
    })
    const reviewed = patch.markReviewed === true
    const businessChanged =
      (patch.type !== undefined && patch.type !== current.type) ||
      (patch.title !== undefined && patch.title !== current.title) ||
      (patch.body !== undefined && patch.body !== current.body) ||
      (patch.tags !== undefined && !sameJson(patch.tags, current.tags)) ||
      (patch.scope !== undefined && !sameJson(patch.scope, current.scope)) ||
      (patch.status !== undefined && patch.status !== current.status) ||
      (patch.importance !== undefined && patch.importance !== current.importance) ||
      (patch.confidence !== undefined && patch.confidence !== current.confidence) ||
      (patch.pinned !== undefined && patch.pinned !== current.pinned) ||
      (patch.ownership !== undefined && patch.ownership !== current.ownership) ||
      (patch.sourceRefs !== undefined && !sameJson(patch.sourceRefs, current.sourceRefs)) ||
      reviewed
    if (!businessChanged) return current
    const next: MemoryRecord = this.stamp({
      ...current,
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
      ...(patch.scope === undefined ? {} : { scope: patch.scope }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.importance === undefined ? {} : { importance: patch.importance }),
      ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      ...(patch.ownership === undefined ? {} : { ownership: patch.ownership }),
      ...(patch.sourceRefs === undefined ? {} : { sourceRefs: patch.sourceRefs }),
      ...(reviewed ? { ownership: 'user' as const, reviewedByUserAt: this.nowIso() } : {}),
      contentRevision: current.contentRevision + 1,
      updatedAt: this.nowIso(),
    })
    if (next.status === 'active' && current.status !== 'active') this.assertActiveRoom()
    await this.runOperationUnlocked(
      'memory.update',
      {
        before: current,
        after: next,
        actor: patch.actor ?? 'user',
        action: 'update',
      },
      requestId,
    )
    const result = this.memories.get(id) ?? next
    this.emitChange({ action: 'upsert', record: result })
    return result
  }

  /**
   * Soft-forget a memory by archiving it.
   * @param id - Memory identity.
   * @param options - Acting identity.
   * @returns The archived record.
   */
  async archive(id: MemoryId, options: ArchiveOptions = {}): Promise<MemoryRecord> {
    return this.serialize(() => this.archiveUnlocked(id, options))
  }

  private async archiveUnlocked(id: MemoryId, options: ArchiveOptions): Promise<MemoryRecord> {
    this.assertReady()
    const replayed = await this.replayRequest(options.requestId, 'memory.archive', id)
    if (replayed !== undefined) {
      this.emitChange({ action: 'upsert', record: replayed })
      return replayed
    }
    const current = this.memories.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (current.status === 'archived') {
      this.emitChange({ action: 'upsert', record: current })
      return current
    }
    const next = this.stamp({
      ...current,
      status: 'archived',
      contentRevision: current.contentRevision + 1,
      updatedAt: this.nowIso(),
    })
    await this.runOperationUnlocked(
      'memory.archive',
      {
        before: current,
        after: next,
        actor: options.actor ?? 'user',
        action: 'archive',
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.dreamId === undefined ? {} : { dreamId: options.dreamId }),
      },
      options.requestId,
    )
    const result = this.memories.get(id) ?? next
    this.emitChange({ action: 'upsert', record: result })
    return result
  }

  /**
   * Restore an archived memory to `active` and mark it user-owned.
   * @param id - Memory identity.
   * @param options - Acting identity.
   * @returns The restored record.
   */
  async restore(id: MemoryId, options: ArchiveOptions = {}): Promise<MemoryRecord> {
    return this.serialize(() => this.restoreUnlocked(id, options))
  }

  private async restoreUnlocked(id: MemoryId, options: ArchiveOptions): Promise<MemoryRecord> {
    this.assertReady()
    const replayed = await this.replayRequest(options.requestId, 'memory.restore', id)
    if (replayed !== undefined) {
      this.emitChange({ action: 'upsert', record: replayed })
      return replayed
    }
    const current = this.memories.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (current.status === 'active') return current
    this.assertActiveRoom()
    const next = this.stamp({
      ...current,
      status: 'active',
      ownership: 'user',
      reviewedByUserAt: this.nowIso(),
      contentRevision: current.contentRevision + 1,
      updatedAt: this.nowIso(),
    })
    await this.runOperationUnlocked(
      'memory.restore',
      {
        before: current,
        after: next,
        actor: options.actor ?? 'user',
        action: 'restore',
      },
      options.requestId,
    )
    const result = this.memories.get(id) ?? next
    this.emitChange({ action: 'upsert', record: result })
    return result
  }

  /**
   * Accept one pending dream proposal as a user management action. The proposal
   * becomes `active`, `ownership='user'` and `reviewedByUserAt` is stamped, and
   * the active memory it supersedes is archived inside the same
   * `memory.accept` operation (so a crash never leaves two active rows).
   * @param id - Pending proposal identity.
   * @param requestId - Optional caller request identity for dedupe.
   * @returns The activated record.
   */
  async acceptProposal(
    id: MemoryId,
    requestIdOrOptions?: string | AcceptProposalOptions,
  ): Promise<MemoryRecord> {
    const options: AcceptProposalOptions =
      typeof requestIdOrOptions === 'string'
        ? { requestId: requestIdOrOptions }
        : (requestIdOrOptions ?? {})
    return this.serialize(() => this.acceptProposalUnlocked(id, options))
  }

  private async acceptProposalUnlocked(
    id: MemoryId,
    options: AcceptProposalOptions,
  ): Promise<MemoryRecord> {
    this.assertReady()
    const requestId = options.requestId
    const actor = options.actor ?? 'user'
    const markReviewed = options.markReviewed !== false
    const replayed = await this.replayRequest(requestId, 'memory.accept', id)
    if (replayed !== undefined) {
      this.emitChange({ action: 'upsert', record: replayed })
      return replayed
    }
    const current = this.memories.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (current.status !== 'pending') {
      throw new OperationError('MEMORY_CONFLICT', `memory '${id}' is not a pending proposal`)
    }
    const nowIso = this.nowIso()
    // Archive every active record this proposal replaces. Each archive is its
    // own audited operation, so a crash mid-way leaves the already-archived
    // records archived and the new proposal still pending — never two active.
    // Only records in the proposal's own scope may be superseded: an imported
    // or edited `supersedes` list must not reach across workspaces.
    const targets = [...new Set(current.supersedes)]
      .map((targetId) => this.memories.get(targetId as MemoryRecord['id']))
      .filter(
        (candidate): candidate is MemoryRecord =>
          candidate !== undefined &&
          candidate.id !== current.id &&
          candidate.status === 'active' &&
          sameScope(candidate.scope, current.scope),
      )
    // Check capacity before archiving anything: an Accept that cannot fit must
    // not leave the superseded records archived while the proposal stays
    // pending.
    this.capacity?.assertActiveRoom(this.activeRecords().length, targets.length)
    for (const target of targets) {
      await this.archiveUnlocked(target.id, {
        actor,
        reason: `superseded by ${current.id}`,
        ...(options.dreamId === undefined ? {} : { dreamId: options.dreamId }),
      })
    }
    const after = this.stamp({
      ...current,
      status: 'active',
      ...(markReviewed ? { ownership: 'user' as const, reviewedByUserAt: nowIso } : {}),
      contentRevision: current.contentRevision + 1,
      updatedAt: nowIso,
    })
    await this.runOperationUnlocked(
      'memory.accept',
      {
        old: null,
        oldAfter: null,
        newBefore: current,
        after,
        actor,
        ...(options.dreamId === undefined ? {} : { dreamId: options.dreamId }),
      },
      requestId,
    )
    const result = this.memories.get(id) ?? after
    this.emitChange({ action: 'upsert', record: result })
    return result
  }

  /**
   * Reject one pending dream proposal: archive it without changing ownership and
   * without touching the record it would have replaced.
   * @param id - Pending proposal identity.
   * @param requestId - Optional caller request identity for dedupe.
   * @returns The archived proposal.
   */
  async rejectProposal(id: MemoryId, requestId?: string): Promise<MemoryRecord> {
    return this.serialize(async () => {
      this.assertReady()
      const replayed = await this.replayRequest(requestId, 'memory.reject', id)
      if (replayed !== undefined) {
        this.emitChange({ action: 'upsert', record: replayed })
        return replayed
      }
      const current = this.memories.get(id)
      if (current === undefined) {
        throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
      }
      if (current.status === 'archived') {
        this.emitChange({ action: 'upsert', record: current })
        return current
      }
      if (current.status !== 'pending') {
        throw new OperationError('MEMORY_CONFLICT', `memory '${id}' is not a pending proposal`)
      }
      const next = this.stamp({
        ...current,
        status: 'archived',
        contentRevision: current.contentRevision + 1,
        updatedAt: this.nowIso(),
      })
      await this.runOperationUnlocked(
        'memory.reject',
        { before: current, after: next, actor: 'user', action: 'reject' },
        requestId,
      )
      const result = this.memories.get(id) ?? next
      this.emitChange({ action: 'upsert', record: result })
      return result
    })
  }

  /**
   * Delete a memory: soft by default (archive), permanently only for a
   * confirmed user management request. A model actor can never delete
   * permanently, regardless of the `confirm` flag.
   * @param id - Memory identity.
   * @param options - Delete semantics and acting identity.
   * @returns The prior record (soft) or null (permanent).
   */
  async delete(id: MemoryId, options: DeleteOptions = {}): Promise<MemoryRecord | null> {
    return this.serialize(() => this.deleteUnlocked(id, options))
  }

  private async deleteUnlocked(id: MemoryId, options: DeleteOptions): Promise<MemoryRecord | null> {
    this.assertReady()
    if (options.permanent === true && options.requestId !== undefined) {
      const existing = await this.runner.findRequest(options.requestId)
      if (existing !== undefined) {
        if (existing.kind !== 'memory.delete') {
          throw new OperationError(
            'MEMORY_CONFLICT',
            `requestId "${options.requestId}" belongs to a different operation`,
          )
        }
        const target = this.operationMemoryId(existing)
        if (target !== undefined && target !== id) {
          throw new OperationError(
            'MEMORY_CONFLICT',
            `requestId "${options.requestId}" belongs to memory '${target}'`,
          )
        }
        if (existing.status === 'failed') {
          throw new OperationError(
            'MEMORY_CONFLICT',
            existing.error ?? 'operation previously failed',
          )
        }
        if (options.actor !== 'user' || options.confirm !== true) {
          throw new OperationError(
            'MEMORY_FORBIDDEN',
            'permanent delete requires a confirmed user management request',
          )
        }
        if (existing.status !== 'committed') {
          await this.runner.commit(await this.runner.apply(existing))
        }
        return null
      }
    }
    const current = this.memories.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (options.permanent !== true) {
      await this.archiveUnlocked(id, {
        actor: options.actor ?? 'user',
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      })
      return current
    }
    if (options.actor !== 'user' || options.confirm !== true) {
      throw new OperationError(
        'MEMORY_FORBIDDEN',
        'permanent delete requires a confirmed user management request',
      )
    }
    await this.removeRecordUnlocked(current, 'user', options.requestId)
    return null
  }

  /**
   * Read one memory.
   * @param id - Memory identity.
   * @returns The record or undefined.
   */
  get(id: MemoryId): MemoryRecord | undefined {
    this.assertReady()
    const record = this.memories.get(id)
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * List memories visible in one scope, newest first.
   * @param request - Workspace selector and filters.
   * @returns The requested page.
   */
  list(request: ListRequest = {}): ListResult {
    this.assertReady()
    const target = 'workspaceKey' in request ? request.workspaceKey : this.defaultWorkspaceKey
    if (target === 'all' && request.management !== true) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'workspaceKey "all" is only available to the management surface',
      )
    }
    const limit = Math.min(Math.max(request.limit ?? this.searchLimit, 1), MAX_LIST_LIMIT)
    const offset = Math.max(request.offset ?? 0, 0)
    const nowMs = this.now().getTime()
    const terms =
      typeof request.query === 'string'
        ? request.query
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter((term) => term !== '')
        : []
    const items = [...this.memories.entries()]
      .map(([, record]) => record)
      .filter((record) => this.isVisible(record, target))
      .filter(
        (record) => request.scopeKind === undefined || record.scope.kind === request.scopeKind,
      )
      .filter((record) => request.type === undefined || record.type === request.type)
      .filter((record) => request.status === undefined || record.status === request.status)
      .filter(
        (record) =>
          request.tags === undefined || request.tags.every((tag) => record.tags.includes(tag)),
      )
      .filter((record) => {
        if (terms.length === 0) return true
        const haystack = `${record.title}\n${record.body}\n${record.tags.join(' ')}`.toLowerCase()
        return terms.every((term) => haystack.includes(term))
      })
      .filter(
        (record) =>
          request.includeExpired === true ||
          record.status !== 'active' ||
          record.expiresAt === undefined ||
          Date.parse(record.expiresAt) > nowMs,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      items: items.slice(offset, offset + limit).map((record) => structuredClone(record)),
      total: items.length,
      limit,
      offset,
      truncated: offset + limit < items.length,
    }
  }

  /**
   * List audit records newest-first.
   * @param request - Optional memory filter and page bounds.
   * @returns The requested audit page.
   */
  auditList(request: AuditListRequest = {}): AuditListResult {
    this.assertReady()
    return listAudit(this.domain, request)
  }

  /**
   * Record one search hit: statistics only, never `contentRevision`.
   * @param id - Memory identity.
   * @returns The updated record, or undefined when absent.
   */
  async recordMatch(id: MemoryId): Promise<MemoryRecord | undefined> {
    this.assertReady()
    return this.serialize(() =>
      this.updateStats(id, (current) => ({
        ...current,
        matchCount: current.matchCount + 1,
        lastMatchedAt: this.nowIso(),
        statsRevision: current.statsRevision + 1,
      })),
    )
  }

  /**
   * Record one full read: statistics only, never `contentRevision`.
   * @param id - Memory identity.
   * @returns The updated record, or undefined when absent.
   */
  async recordUse(id: MemoryId): Promise<MemoryRecord | undefined> {
    this.assertReady()
    return this.serialize(() =>
      this.updateStats(id, (current) => ({
        ...current,
        useCount: current.useCount + 1,
        lastUsedAt: this.nowIso(),
        statsRevision: current.statsRevision + 1,
      })),
    )
  }

  private async updateStats(
    id: MemoryId,
    transform: (current: MemoryRecord) => MemoryRecord,
  ): Promise<MemoryRecord | undefined> {
    if (this.memories.get(id) === undefined) return undefined
    try {
      return await this.memories.update(id, transform)
    } catch {
      return undefined
    }
  }

  /** Current memory and related table counts. */
  counts(): StoreCounts {
    let active = 0
    let archived = 0
    let pending = 0
    for (const [, record] of this.memories.entries()) {
      if (record.status === 'active') active += 1
      else if (record.status === 'archived') archived += 1
      else pending += 1
    }
    let queuedEpisodes = 0
    for (const [, episode] of this.episodes.entries()) {
      if (episode.status === 'new' || episode.status === 'failed-retryable') queuedEpisodes += 1
    }
    return {
      active,
      archived,
      pending,
      stored: active + archived + pending,
      queuedEpisodes,
      auditRecords: this.audit.size,
      operationRecords: this.domain.table('operations').size,
    }
  }

  /**
   * Status counts restricted to one management selector. `all` counts every
   * workspace; global preferences are always included.
   * @param target - Workspace key, `'all'`, or `null` for global-only.
   * @returns Per-status counts for the selected scope.
   */
  scopedCounts(target: string | 'all' | null): {
    active: number
    pending: number
    archived: number
    stored: number
  } {
    this.assertReady()
    let active = 0
    let pending = 0
    let archived = 0
    for (const [, record] of this.memories.entries()) {
      if (!this.isVisible(record, target)) continue
      if (record.status === 'active') active += 1
      else if (record.status === 'pending') pending += 1
      else archived += 1
    }
    return { active, pending, archived, stored: active + pending + archived }
  }

  /** All currently active records. */
  activeRecords(): MemoryRecord[] {
    return [...this.memories.entries()]
      .map(([, record]) => record)
      .filter((record) => record.status === 'active')
  }

  /** Enforce the queued-episode capacity gate from the capture pipeline. */
  checkEpisodeCapacity(): void {
    this.capacity?.checkEpisodeQueue?.(this.counts())
  }

  /**
   * Report a dropped capture at most once per minute. The design requires the
   * plugin to alert instead of silently discarding episodes once the queue cap
   * is reached.
   */
  private warnEpisodeOverflow(error: unknown): void {
    const now = this.now().getTime()
    if (
      this.lastEpisodeOverflowWarnAt !== undefined &&
      now - this.lastEpisodeOverflowWarnAt < 60_000
    ) {
      return
    }
    this.lastEpisodeOverflowWarnAt = now
    const message = `[dsh-memory] episode queue is full; capture was dropped: ${
      error instanceof Error ? error.message : String(error)
    }`
    if (this.logger?.warn !== undefined) this.logger.warn(message)
    else console.warn(message)
  }

  /**
   * Apply time-based retention: archive old turn worklogs, delete old processed
   * episodes, and (for `archivePurgePolicy='age'`) permanently remove expired
   * archived memories. `after-export` purge is exposed separately through
   * {@link purgeArchivedAfterExport}.
   * @param now - Clock used for age comparisons.
   * @returns Counts of records archived/deleted/purged.
   */
  async applyRetention(now: Date = this.now()): Promise<{
    archivedWorklogs: number
    deletedEpisodes: number
    purgedArchives: number
  }> {
    return this.serialize(async () => {
      this.assertReady()
      let archivedWorklogs = 0
      const worklogCutoff = now.getTime() - this.worklogRetentionDays * 86_400_000
      for (const [, record] of [...this.memories.entries()]) {
        if (
          record.type === 'worklog' &&
          record.worklogKind === 'turn' &&
          record.status === 'active' &&
          !record.pinned &&
          Date.parse(record.updatedAt) <= worklogCutoff
        ) {
          await this.archiveUnlocked(record.id, { actor: 'system' })
          archivedWorklogs += 1
        }
      }
      const episodeCutoff = now.getTime() - this.episodeRetentionDays * 86_400_000
      const staleEpisodes = [...this.episodes.entries()]
        .filter(
          ([, episode]) =>
            episode.status === 'processed' &&
            episode.processedAt !== undefined &&
            Date.parse(episode.processedAt) <= episodeCutoff,
        )
        .map(([id]) => id)
      const deletedEpisodes =
        staleEpisodes.length === 0 ? 0 : await this.episodes.deleteMany(staleEpisodes)
      let purgedArchives = 0
      if (this.archivePurgePolicy === 'age') {
        const archiveCutoff = now.getTime() - this.archiveRetentionDays * 86_400_000
        for (const [, record] of [...this.memories.entries()]) {
          if (record.status !== 'archived') continue
          if (record.pinned) continue
          if (Date.parse(record.updatedAt) > archiveCutoff) continue
          await this.removeRecordUnlocked(record, 'system')
          purgedArchives += 1
        }
      }
      return { archivedWorklogs, deletedEpisodes, purgedArchives }
    })
  }

  /**
   * Permanently remove archived records inside one exported scope after an
   * explicit export, for the `after-export` purge policy. Pinned records and
   * other scopes are untouched.
   * @param scope - Scope that was just exported (default `all`).
   * @returns Number of purged records.
   */
  async purgeArchivedAfterExport(
    scope: 'all' | 'global' | { workspaceKey: string } = 'all',
  ): Promise<number> {
    return this.serialize(async () => {
      this.assertReady()
      if (this.archivePurgePolicy !== 'after-export') return 0
      let purged = 0
      for (const [, record] of [...this.memories.entries()]) {
        if (record.status !== 'archived') continue
        if (record.pinned) continue
        if (!this.inExportScope(record, scope)) continue
        await this.removeRecordUnlocked(record, 'system')
        purged += 1
      }
      return purged
    })
  }

  /** Whether one record lies inside an exported scope selector. */
  private inExportScope(
    record: MemoryRecord,
    scope: 'all' | 'global' | { workspaceKey: string },
  ): boolean {
    if (scope === 'all') return true
    if (scope === 'global') return record.scope.kind === 'global'
    return record.scope.kind === 'workspace' && record.scope.key === scope.workspaceKey
  }

  private isVisible(record: MemoryRecord, target: string | 'all' | null | undefined): boolean {
    if (target === 'all') return true
    if (record.scope.kind === 'global') return true
    if (target === null || target === undefined) return false
    return record.scope.key === target
  }

  /** Permanently remove one record and scrub every content snapshot from its audits. */
  private async removeRecordUnlocked(
    record: MemoryRecord,
    actor: AuditActor,
    requestId?: string,
  ): Promise<void> {
    // Scrub operations first: an unfinished operation must block the delete
    // before audit rows are touched, not after they are already gone.
    await this.runner.scrubMemoryContent(record.id)
    await this.scrubAudit(record.id)
    await this.runOperationUnlocked(
      'memory.delete',
      {
        before: record,
        actor,
        minimalAudit: true,
      },
      requestId,
    )
    // The delete operation's `scrub` step and commit redact its own persisted
    // snapshot as part of the recoverable state machine.
    this.emitChange({ action: 'remove', id: record.id })
  }

  /** Delete every audit row that still carries content for one memory id. */
  private async scrubAudit(memoryId: MemoryId): Promise<void> {
    const ids = [...this.audit.entries()]
      .filter(([, record]) => auditCarriesMemory(record, memoryId))
      .map(([id]) => id)
    if (ids.length > 0) await this.audit.deleteMany(ids)
  }

  /**
   * Replay a committed request for the same operation kind and return its
   * resulting record. This is the store-level half of request dedupe: callers
   * that repeat a request identity must observe the original result, not a new
   * edit or a record generated locally.
   */
  private async replayRequest(
    requestId: string | undefined,
    kind: OperationKind,
    memoryId: MemoryId,
  ): Promise<MemoryRecord | undefined> {
    if (requestId === undefined) return undefined
    const existing = await this.runner.findRequest(requestId)
    if (existing === undefined) return undefined
    if (existing.kind !== kind) {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `requestId "${requestId}" belongs to a different operation`,
      )
    }
    const target = this.operationMemoryId(existing)
    if (target !== undefined && target !== memoryId) {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `requestId "${requestId}" belongs to memory '${target}'`,
      )
    }
    if (existing.status === 'failed') {
      throw new OperationError('MEMORY_CONFLICT', existing.error ?? 'operation previously failed')
    }
    if (existing.status !== 'committed') {
      await this.runner.commit(await this.runner.apply(existing))
    }
    const after = existing.after as MemoryRecord | undefined
    return after === undefined
      ? this.memories.get(memoryId)
      : (this.memories.get(after.id) ?? after)
  }

  /** Memory identity an operation targets, read from its payload snapshots. */
  private operationMemoryId(operation: OperationRecord): string | undefined {
    const payload = operation.payload as
      | {
          memoryId?: string
          record?: MemoryRecord
          before?: MemoryRecord
          after?: MemoryRecord
          newBefore?: MemoryRecord
        }
      | undefined
    return (
      payload?.record?.id ??
      payload?.after?.id ??
      payload?.before?.id ??
      payload?.newBefore?.id ??
      payload?.memoryId
    )
  }

  private async runOperationUnlocked(
    kind: Parameters<OperationRunner['begin']>[0],
    payload: unknown,
    requestId?: string,
  ): Promise<OperationRecord> {
    const operation = await this.runner.begin(kind, payload, requestId)
    if (operation.kind !== kind) {
      throw new OperationError(
        'MEMORY_CONFLICT',
        `requestId "${requestId ?? ''}" belongs to a different operation`,
      )
    }
    if (operation.status === 'failed') {
      throw new OperationError('MEMORY_CONFLICT', operation.error ?? 'operation previously failed')
    }
    if (operation.status === 'committed') return operation
    const applied = await this.runner.apply(operation)
    return this.runner.commit(applied)
  }

  /* ------------------------------------------------------------------ *
   * Episode queue, dream runs and dream proposals (capture / dreaming)
   * ------------------------------------------------------------------ */

  private get dreams() {
    return this.domain.table('dreams')
  }

  /**
   * Persist one captured episode as `new`, unless the queued-episode capacity
   * gate rejects it (capture must pause, never drop silently and never block a
   * turn). Episodes carry only the whitelisted summary fields.
   * @param input - Whitelisted episode fields.
   * @returns The stored episode, or undefined when the queue is full.
   */
  async appendEpisode(input: EpisodeInput): Promise<EpisodeRecord | undefined> {
    return this.serialize(async () => {
      this.assertReady()
      try {
        this.checkEpisodeCapacity()
      } catch (error) {
        this.warnEpisodeOverflow(error)
        return undefined
      }
      const record: EpisodeRecord = {
        id: newEpisodeId(),
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        workspaceRoot: input.workspaceRoot,
        kind: input.kind,
        status: 'new',
        attempts: 0,
        turn: input.turn,
        sourceSeqs: [...input.sourceSeqs],
        files: [...(input.files ?? [])],
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.assistantFinal === undefined ? {} : { assistantFinal: input.assistantFinal }),
        ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
        ...(input.toolError === undefined ? {} : { toolError: input.toolError }),
        ...(input.correctionText === undefined ? {} : { correctionText: input.correctionText }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
        ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
        createdAt: this.nowIso(),
      }
      await this.episodes.put(record.id, record)
      return structuredClone(record)
    })
  }

  /** List episodes matching a workspace/status/since filter, oldest first. */
  episodeList(filter: EpisodeFilter = {}): EpisodeRecord[] {
    this.assertReady()
    const sinceMs = filter.since === undefined ? undefined : Date.parse(filter.since)
    const items = [...this.episodes.entries()]
      .map(([, episode]) => episode)
      .filter(
        (episode) =>
          filter.workspaceKey === undefined || episode.workspaceKey === filter.workspaceKey,
      )
      .filter(
        (episode) => filter.statuses === undefined || filter.statuses.includes(episode.status),
      )
      .filter((episode) => {
        if (filter.since === undefined) return true
        if (sinceMs !== undefined && !Number.isNaN(sinceMs)) {
          const createdMs = Date.parse(episode.createdAt)
          if (!Number.isNaN(createdMs)) return createdMs >= sinceMs
        }
        return episode.createdAt >= filter.since
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const limited =
      filter.limit === undefined ? items : items.slice(0, Math.max(0, Math.floor(filter.limit)))
    return limited.map((episode) => structuredClone(episode))
  }

  /** Read one episode. */
  getEpisode(id: EpisodeId): EpisodeRecord | undefined {
    this.assertReady()
    const record = this.episodes.get(id)
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * Highest event sequence already captured for one session, across every
   * episode kind and status. Cold backfill uses this as its starting point when
   * no `session_cursors` row exists, so enabling autoDream on an existing store
   * cannot capture the same events again.
   * @param sessionId - Session identity.
   * @returns The highest `sourceSeqs` value, or undefined when none exists.
   */
  maxEpisodeSourceSeq(sessionId: string): number | undefined {
    this.assertReady()
    let highest: number | undefined
    for (const [, episode] of this.episodes.entries()) {
      if (episode.sessionId !== sessionId) continue
      for (const seq of episode.sourceSeqs) {
        highest = highest === undefined ? seq : Math.max(highest, seq)
      }
    }
    return highest
  }

  /**
   * Original workspace root stored on the first episode of one workspace. Used
   * when a pending-only backfill has no captured session to supply the root.
   * @param workspaceKey - Normalized workspace key.
   * @returns The stored root, or undefined when the workspace has no episodes.
   */
  episodeWorkspaceRoot(workspaceKey: string): string | undefined {
    this.assertReady()
    for (const [, episode] of this.episodes.entries()) {
      if (episode.workspaceKey === workspaceKey) return episode.workspaceRoot
    }
    return undefined
  }

  /** Patch one episode (status transitions only). */
  async updateEpisode(
    id: EpisodeId,
    patch: Partial<EpisodeRecord>,
  ): Promise<EpisodeRecord | undefined> {
    return this.serialize(async () => {
      this.assertReady()
      const current = this.episodes.get(id)
      if (current === undefined) return undefined
      const next: EpisodeRecord = { ...current, ...patch }
      await this.episodes.put(id, next)
      return structuredClone(next)
    })
  }

  /**
   * Claim episodes for one dream run: mark them `processing`, record the
   * owning dream and increment their attempt count. Episodes already processing
   * or processed are never claimed twice.
   */
  async claimEpisodes(ids: readonly EpisodeId[], dreamId: string): Promise<EpisodeRecord[]> {
    return this.serialize(async () => {
      this.assertReady()
      const claimed: EpisodeRecord[] = []
      for (const id of ids) {
        const current = this.episodes.get(id)
        if (
          current === undefined ||
          current.status === 'processing' ||
          current.status === 'processed'
        ) {
          continue
        }
        const next: EpisodeRecord = {
          ...current,
          status: 'processing',
          dreamId,
          attempts: current.attempts + 1,
        }
        await this.episodes.put(id, next)
        claimed.push(structuredClone(next))
      }
      return claimed
    })
  }

  /** Mark claimed episodes `processed` after their proposals were written. */
  async markEpisodesProcessed(ids: readonly EpisodeId[], dreamId: string): Promise<void> {
    return this.serialize(async () => {
      this.assertReady()
      const nowIso = this.nowIso()
      for (const id of ids) {
        const current = this.episodes.get(id)
        if (current === undefined) continue
        await this.episodes.put(id, {
          ...current,
          status: 'processed',
          dreamId,
          processedAt: nowIso,
        })
      }
    })
  }

  /** Release claimed episodes back to `failed-retryable` after a failed run. */
  async releaseEpisodes(ids: readonly EpisodeId[], dreamId: string, error: string): Promise<void> {
    return this.serialize(async () => {
      this.assertReady()
      for (const id of ids) {
        const current = this.episodes.get(id)
        if (current === undefined || current.status !== 'processing') continue
        await this.episodes.put(id, {
          ...current,
          status: 'failed-retryable',
          dreamId,
          lastError: error,
        })
      }
    })
  }

  /** Create or replace one dream run record. */
  async putDream(record: DreamRun): Promise<DreamRun> {
    return this.serialize(async () => {
      this.assertReady()
      await this.dreams.put(record.id, record)
      return structuredClone(record)
    })
  }

  /**
   * Atomically move a `queued` dream to `running`.
   * @returns The stored running dream, or undefined if it was already cancelled or no longer queued.
   */
  async startDream(record: DreamRun): Promise<DreamRun | undefined> {
    return this.serialize(async () => {
      this.assertReady()
      const current = this.dreams.get(record.id)
      if (current?.status !== 'queued') return undefined
      await this.dreams.put(record.id, record)
      return structuredClone(record)
    })
  }

  /**
   * Atomically move a queued/running dream to `cancelled`.
   * @returns Whether the transition happened.
   */
  async cancelDream(id: string): Promise<boolean> {
    return this.serialize(async () => {
      this.assertReady()
      const current = this.dreams.get(id as DreamRun['id'])
      if (current === undefined || (current.status !== 'queued' && current.status !== 'running')) {
        return false
      }
      await this.dreams.put(current.id, {
        ...current,
        status: 'cancelled',
        finishedAt: this.nowIso(),
      })
      return true
    })
  }

  /**
   * Write a terminal dream only while it has not already been cancelled.
   * @returns The stored dream, or undefined when cancellation won the race.
   */
  async putDreamTerminal(record: DreamRun): Promise<DreamRun | undefined> {
    return this.serialize(async () => {
      this.assertReady()
      const current = this.dreams.get(record.id)
      if (current?.status === 'cancelled') return undefined
      await this.dreams.put(record.id, record)
      return structuredClone(record)
    })
  }

  /** Read one dream run. */
  getDream(id: string): DreamRun | undefined {
    this.assertReady()
    const record = this.dreams.get(id as DreamRun['id'])
    return record === undefined ? undefined : structuredClone(record)
  }

  /** List dream runs newest first. */
  dreamList(limit?: number): DreamRun[] {
    this.assertReady()
    const items = [...this.dreams.entries()]
      .map(([, record]) => record)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    const limited = limit === undefined ? items : items.slice(0, limit)
    return limited.map((record) => structuredClone(record))
  }

  /** Find one memory holding an exact proposal key, in any status. */
  findMemoryByProposalKey(key: string): MemoryRecord | undefined {
    this.assertReady()
    for (const [, record] of this.memories.entries()) {
      if (record.proposalKey === key) return structuredClone(record)
    }
    return undefined
  }

  /**
   * Find an active record with the same scope, type and normalized title. Used
   * by explicit writes so repeating the same write stays idempotent.
   */
  findActiveByTitle(scope: MemoryScope, type: MemoryType, title: string): MemoryRecord | undefined {
    this.assertReady()
    const normalized = title.trim().replace(/\s+/g, ' ')
    for (const [, record] of this.memories.entries()) {
      if (record.status !== 'active') continue
      if (record.type !== type) continue
      if (!sameScope(record.scope, scope)) continue
      if (record.title.trim().replace(/\s+/g, ' ') !== normalized) continue
      return structuredClone(record)
    }
    return undefined
  }

  /**
   * Find a semantic duplicate proposal: same scope, same type, same normalized
   * title and at least one shared source episode. A pending record is preferred
   * so a reworded retry updates it instead of creating an endless new pending.
   */
  findSemanticProposal(
    scope: MemoryScope,
    type: MemoryType,
    normalizedTitle: string,
    sourceEpisodeIds: readonly string[],
  ): MemoryRecord | undefined {
    this.assertReady()
    const sources = new Set(sourceEpisodeIds)
    const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')
    let match: MemoryRecord | undefined
    for (const [, record] of this.memories.entries()) {
      if (record.type !== type) continue
      if (!sameScope(record.scope, scope)) continue
      if (normalize(record.title) !== normalizedTitle) continue
      if (!record.sourceEpisodeIds.some((id) => sources.has(id))) continue
      if (record.status === 'pending') return structuredClone(record)
      match ??= record
    }
    return match === undefined ? undefined : structuredClone(match)
  }

  /**
   * Find a near-duplicate proposal by identical body or Jaccard similarity of
   * body terms ≥ 0.85 within the same scope and type. Used for ordinary merge.
   */
  findSimilarProposal(
    scope: MemoryScope,
    type: MemoryType,
    body: string,
  ): MemoryRecord | undefined {
    this.assertReady()
    const target = termSet(body)
    let match: MemoryRecord | undefined
    for (const [, record] of this.memories.entries()) {
      if (record.type !== type) continue
      if (!sameScope(record.scope, scope)) continue
      const similar = record.body === body || jaccard(termSet(record.body), target) >= 0.85
      if (!similar) continue
      if (record.status === 'pending') return structuredClone(record)
      match ??= record
    }
    return match === undefined ? undefined : structuredClone(match)
  }

  /**
   * Write one dream proposal as a `pending`, `derived`, `origin='dream'` memory
   * with a matching `dream-commit` audit row so the run can be undone.
   */
  async writeDreamProposal(
    record: MemoryRecord,
    dreamId: string,
    operationId: string,
  ): Promise<MemoryRecord> {
    return this.serialize(async () => {
      this.assertReady()
      this.validateScope(record.type, record.scope)
      if (this.capacity !== undefined) this.capacity.checkCreate(this.counts())
      const validated = this.stamp(record)
      // Audit first: a crash between the two writes leaves an audit row whose
      // `after` was never stored (undo skips it), never a pending proposal that
      // no audit can ever reverse.
      await this.writeDreamAudit(operationId, dreamId, null, validated)
      await this.memories.put(validated.id, validated)
      this.emitChange({ action: 'upsert', record: validated })
      return structuredClone(validated)
    })
  }

  /**
   * Update an existing pending proposal with a reworded candidate, recording an
   * audit `dream-commit` snapshot so undo restores the previous pending body.
   */
  async updateDreamProposal(
    id: MemoryId,
    patch: DreamProposalPatch,
    dreamId: string,
    operationId: string,
  ): Promise<MemoryRecord> {
    return this.serialize(async () => {
      this.assertReady()
      const current = this.memories.get(id)
      if (current === undefined) {
        throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
      }
      const next = this.stamp({
        ...current,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.body === undefined ? {} : { body: patch.body }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
        ...(patch.importance === undefined ? {} : { importance: patch.importance }),
        ...(patch.sourceEpisodeIds === undefined
          ? {}
          : { sourceEpisodeIds: patch.sourceEpisodeIds }),
        ...(patch.supersedes === undefined ? {} : { supersedes: patch.supersedes }),
        ...(patch.proposalKey === undefined ? {} : { proposalKey: patch.proposalKey }),
        contentRevision: current.contentRevision + 1,
        updatedAt: this.nowIso(),
      })
      await this.writeDreamAudit(operationId, dreamId, current, next)
      await this.memories.put(next.id, next)
      this.emitChange({ action: 'upsert', record: next })
      return structuredClone(next)
    })
  }

  /** Append one `dream-commit` audit row for a proposal create/update. */
  private async writeDreamAudit(
    operationId: string,
    dreamId: string,
    before: MemoryRecord | null,
    after: MemoryRecord,
  ): Promise<void> {
    const record: AuditRecord = {
      id: AuditId(newAuditId()),
      operationId,
      dreamId,
      action: 'dream-commit',
      memoryId: after.id,
      actor: 'dream',
      before,
      after,
      status: 'applied',
      at: this.nowIso(),
    }
    await this.audit.put(record.id, record)
  }
}

/** Whether an audit row carries a title/body snapshot of one memory. */
export function auditCarriesMemory(record: AuditRecord, memoryId: string): boolean {
  return (
    record.memoryId === memoryId || record.before?.id === memoryId || record.after?.id === memoryId
  )
}
