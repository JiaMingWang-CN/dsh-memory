/**
 * Export, import, rebuild and purge over the memory tables.
 *
 * Import redacts every persistable text field before writing and preserves
 * status while forcing `origin='import'` / `ownership='user'`. Rebuild only
 * deletes `derived`, unreviewed, unpinned records; user-owned data survives.
 * Purge clears a scope after an exact confirmation phrase and keeps an audit
 * summary. All three batch operations persist their operation record before
 * touching rows, so a crash leaves an explicit `failed` marker instead of a
 * silent partial batch.
 * @module dsh-memory/core/exchange
 */
import { ZodError } from 'zod'
import {
  AuditId,
  episodeRecordSchema,
  memoryRecordSchema,
  type AuditActor,
  type EpisodeId,
  type EpisodeRecord,
  type MemoryId,
  type MemoryRecord,
  type MemoryScope,
  type MemorySourceRef,
  type OperationRecord,
} from '../shared/types.ts'
import { contentDigest, type MemoryDomainHandle } from './storage-contract.ts'
import { redactField } from './redact.ts'
import { OperationError, type OperationRunner } from './operations.ts'
import {
  auditCarriesMemory,
  type MemoryInput,
  type MemoryStore,
  type MemoryStoreBatch,
} from './store.ts'

/** Export scope selector. */
export type ExportScope = 'all' | 'global' | { workspaceKey: string }

export interface ExportRequest {
  scope: ExportScope
  includeArchived?: boolean
}

export interface MemoryExport {
  format: 'dsh-memory'
  version: 1
  exportedAt: string
  scope: ExportScope
  includeArchived: boolean
  memories: MemoryRecord[]
  episodes: EpisodeRecord[]
}

/** Source workspace key → local workspace target. */
export type WorkspaceMapping = Record<string, { key: string; root: string }>

export interface ImportOptions {
  mode?: 'merge' | 'replace'
  mapping?: WorkspaceMapping
  confirm?: boolean
  targetScope?: ExportScope
  redactSecrets?: boolean
}

export interface ImportReport {
  created: number
  skipped: number
  replaced: number
  episodesImported: number
  unmapped: string[]
  redacted: number
  errors: { id?: string; message: string }[]
  operationId: string
}

export interface RebuildRequest {
  scope: ExportScope
  since?: string
  confirm?: boolean
}

export interface RebuildReport {
  deleted: number
  retainedUser: number
  resetEpisodes: number
  resetCursors: number
  operationId: string
  errors: { memoryId?: string; message: string }[]
  /** Cold sessions re-captured after the reset (set by the service). */
  replayedSessions?: number
  /** Episodes captured by the post-reset replay (set by the service). */
  replayedEpisodes?: number
}

export interface PurgeRequest {
  scope: ExportScope
  confirmText: string
}

export interface PurgeReport {
  deleted: number
  deletedEpisodes: number
  operationId: string
  errors: { memoryId?: string; message: string }[]
}

const DEFAULT_NOW = (): Date => new Date()

/** Run one table-only maintenance batch inside a caller-provided write queue. */
type Serializer = <T>(work: () => Promise<T>) => Promise<T>

/** Default serializer for direct calls (tests, one-off tooling). */
const RUN_NOW: Serializer = (work) => work()

/** Canonical confirmation/scope text of one scope selector. */
function scopeKey(scope: ExportScope): string {
  return scope === 'all' ? 'all' : scope === 'global' ? 'global' : scope.workspaceKey
}

function memoryInScope(record: MemoryRecord, scope: ExportScope): boolean {
  if (scope === 'all') return true
  if (scope === 'global') return record.scope.kind === 'global'
  return record.scope.kind === 'workspace' && record.scope.key === scope.workspaceKey
}

function episodeInScope(episode: EpisodeRecord, scope: ExportScope): boolean {
  if (scope === 'all') return true
  if (scope === 'global') return false
  return episode.workspaceKey === scope.workspaceKey
}

/**
 * Build an export payload for one scope.
 * @param domain - Open memory domain.
 * @param request - Scope and archive inclusion.
 * @param now - Clock (tests inject one).
 * @returns The export document.
 */
export function exportMemories(
  domain: MemoryDomainHandle,
  request: ExportRequest,
  now: () => Date = DEFAULT_NOW,
): MemoryExport {
  const includeArchived = request.includeArchived ?? true
  const memories = [...domain.table('memories').entries()]
    .map(([, record]) => structuredClone(record))
    .filter((record) => memoryInScope(record, request.scope))
    .filter((record) => includeArchived || record.status !== 'archived')
  const episodes = [...domain.table('episodes').entries()]
    .map(([, episode]) => structuredClone(episode))
    .filter((episode) => episodeInScope(episode, request.scope))
  return {
    format: 'dsh-memory',
    version: 1,
    exportedAt: now().toISOString(),
    scope: request.scope,
    includeArchived,
    memories,
    episodes,
  }
}

function redactSourceRefs(refs: MemorySourceRef[]): { refs: MemorySourceRef[]; changed: boolean } {
  let changed = false
  const next = refs.map((ref) => {
    if (ref.quote === undefined) return ref
    const quote = redactField(ref.quote)
    if (quote.changed) changed = true
    return quote.changed ? { ...ref, quote: quote.value } : ref
  })
  return { refs: next, changed }
}

function mappedScope(scope: MemoryScope, mapping: WorkspaceMapping): MemoryScope | undefined {
  if (scope.kind === 'global') return { kind: 'global' }
  const target = mapping[scope.key]
  return target === undefined
    ? undefined
    : { kind: 'workspace', key: target.key, root: target.root }
}

/** Whether two stored scopes name the same global layer or the same workspace. */
function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === 'global' || right.kind === 'global') return left.kind === right.kind
  return left.key === right.key
}

/** Whether a resolved memory scope lies inside a selected replace/purge target. */
function scopeWithin(scope: MemoryScope, target: ExportScope): boolean {
  if (target === 'all') return true
  if (target === 'global') return scope.kind === 'global'
  return scope.kind === 'workspace' && scope.key === target.workspaceKey
}

/** Whether a mapped episode workspace lies inside a selected replace target. */
function episodeInTarget(workspaceKey: string, target: ExportScope): boolean {
  if (target === 'all') return true
  if (target === 'global') return false
  return workspaceKey === target.workspaceKey
}

/** Delete every audit snapshot that still carries content for one memory. */
async function scrubAudits(domain: MemoryDomainHandle, memoryId: string): Promise<void> {
  const ids = [...domain.table('audit').entries()]
    .filter(([, record]) => auditCarriesMemory(record, memoryId))
    .map(([id]) => id)
  if (ids.length > 0) await domain.table('audit').deleteMany(ids)
}

/**
 * Keep only supersede targets a review of this proposal may archive.
 *
 * A proposal replaces records in its own scope, so a foreign id (another
 * workspace, or a row a `replace` import is about to delete) is dropped:
 * accepting the proposal then archives nothing outside its own workspace.
 * @param memory - Imported record.
 * @param scope - Mapped target scope of that record.
 * @param imported - Scope of every record in this import batch.
 * @param surviving - Ids the import keeps, for a destructive replace.
 * @param domain - Open memory domain.
 * @returns The filtered supersede ids.
 */
function scopedSupersedes(
  memory: MemoryRecord,
  scope: MemoryScope,
  imported: ReadonlyMap<string, MemoryScope>,
  surviving: ReadonlySet<string> | undefined,
  domain: MemoryDomainHandle,
): string[] {
  const kept: string[] = []
  for (const id of memory.supersedes) {
    if (id === memory.id) continue
    const importedScope = imported.get(id)
    if (importedScope !== undefined) {
      if (sameScope(importedScope, scope)) kept.push(id)
      continue
    }
    const existing = domain.table('memories').get(id as MemoryRecord['id'])
    if (existing === undefined || !sameScope(existing.scope, scope)) continue
    if (surviving !== undefined && !surviving.has(id)) continue
    kept.push(id)
  }
  return [...new Set(kept)]
}

/** Build the store input for one imported record, redacting its text fields when enabled. */
function importInput(
  memory: MemoryRecord,
  scope: MemoryScope,
  supersedes: readonly string[],
  redactSecrets: boolean,
): { input: MemoryInput; redacted: boolean } {
  const title = redactSecrets ? redactField(memory.title) : { value: memory.title, changed: false }
  const body = redactSecrets ? redactField(memory.body) : { value: memory.body, changed: false }
  const tags = redactSecrets
    ? memory.tags.map((tag) => redactField(tag))
    : memory.tags.map((tag) => ({ value: tag, changed: false }))
  const quotes = redactSecrets
    ? redactSourceRefs(memory.sourceRefs)
    : { refs: memory.sourceRefs, changed: false }
  const redacted =
    title.changed || body.changed || tags.some((tag) => tag.changed) || quotes.changed
  return {
    input: {
      id: memory.id,
      type: memory.type,
      title: title.value,
      body: body.value,
      scope,
      tags: tags.map((tag) => tag.value),
      importance: memory.importance,
      confidence: memory.confidence,
      pinned: memory.pinned,
      status: memory.status,
      origin: 'import',
      ownership: 'user',
      sourceRefs: quotes.refs,
      sourceEpisodeIds: memory.sourceEpisodeIds,
      supersedes: [...supersedes],
      actor: 'user',
      ...(memory.worklogKind === undefined ? {} : { worklogKind: memory.worklogKind }),
      ...(memory.proposalKey === undefined ? {} : { proposalKey: memory.proposalKey }),
      ...(memory.reviewedByUserAt === undefined
        ? {}
        : { reviewedByUserAt: memory.reviewedByUserAt }),
      ...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
    },
    redacted,
  }
}

/** Build one normalized imported episode record, redacting secrets and resetting stuck `processing` status. */
function buildImportedEpisode(
  episode: EpisodeRecord,
  target: { key: string; root: string },
  redactSecrets: boolean,
): EpisodeRecord {
  const redactText = (value: string): string => (redactSecrets ? redactField(value).value : value)
  const { dreamId: _droppedDreamId, ...rest } = episode
  const resetProcessing = episode.status === 'processing'
  return {
    ...(resetProcessing ? rest : episode),
    ...(resetProcessing ? { status: 'new' as const } : {}),
    sessionId: `import:${episode.id}`,
    sourceSeqs: [],
    workspaceKey: target.key,
    workspaceRoot: target.root,
    files: episode.files.map((file) => redactText(file)),
    ...(episode.prompt === undefined ? {} : { prompt: redactText(episode.prompt) }),
    ...(episode.assistantFinal === undefined
      ? {}
      : { assistantFinal: redactText(episode.assistantFinal) }),
    ...(episode.toolError === undefined ? {} : { toolError: redactText(episode.toolError) }),
    ...(episode.correctionText === undefined
      ? {}
      : { correctionText: redactText(episode.correctionText) }),
    ...(episode.outcome === undefined ? {} : { outcome: redactText(episode.outcome) }),
    ...(episode.failureMessage === undefined
      ? {}
      : { failureMessage: redactText(episode.failureMessage) }),
    ...(episode.lastError === undefined ? {} : { lastError: redactText(episode.lastError) }),
  }
}

/**
 * Import an export document into the store.
 * @param store - Target store.
 * @param domain - Open memory domain (for episode writes).
 * @param payload - Export document.
 * @param options - Mode, workspace mapping and confirmation.
 * @returns A per-item import report.
 */
export async function importMemories(
  store: MemoryStore,
  domain: MemoryDomainHandle,
  payload: MemoryExport,
  options: ImportOptions = {},
): Promise<ImportReport> {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.format !== 'dsh-memory' ||
    payload.version !== 1
  ) {
    throw new OperationError('MEMORY_INVALID_CONTENT', 'unsupported import format or version')
  }
  if (!Array.isArray(payload.memories)) {
    throw new OperationError('MEMORY_INVALID_CONTENT', 'import payload.memories must be an array')
  }
  if (!Array.isArray(payload.episodes)) {
    throw new OperationError('MEMORY_INVALID_CONTENT', 'import payload.episodes must be an array')
  }
  // Validate every record before any destructive step: a malformed document
  // must never delete existing data and then fail.
  let importedMemories: MemoryRecord[]
  let importedEpisodes: EpisodeRecord[]
  try {
    importedMemories = payload.memories.map((memory) => memoryRecordSchema.parse(memory))
    importedEpisodes = payload.episodes.map((episode) => episodeRecordSchema.parse(episode))
  } catch (error) {
    if (error instanceof ZodError) {
      throw new OperationError('MEMORY_INVALID_CONTENT', error.issues[0]?.message ?? error.message)
    }
    throw error
  }
  const mode = options.mode ?? 'merge'
  const mapping = options.mapping ?? {}
  const redactSecrets = options.redactSecrets ?? true
  if (mode === 'replace' && (options.confirm !== true || options.targetScope === undefined)) {
    throw new OperationError(
      'MEMORY_FORBIDDEN',
      'replace import requires confirmation and a target scope',
    )
  }
  const replacementTarget = options.targetScope
  const report: ImportReport = {
    created: 0,
    skipped: 0,
    replaced: 0,
    episodesImported: 0,
    unmapped: [],
    redacted: 0,
    errors: [],
    operationId: '',
  } as ImportReport
  // Plan the import before mutating any row: resolve every scope, enforce the
  // replace target boundary, and collect unmapped/skipped entries up front.
  const planned: { memory: MemoryRecord; scope: MemoryScope }[] = []
  for (const memory of importedMemories) {
    const scope = mappedScope(memory.scope, mapping)
    if (scope === undefined) {
      report.unmapped.push(memory.id)
      continue
    }
    if (
      mode === 'replace' &&
      replacementTarget !== undefined &&
      !scopeWithin(scope, replacementTarget)
    ) {
      report.skipped += 1
      continue
    }
    planned.push({ memory, scope })
  }
  const plannedEpisodes: { episode: EpisodeRecord; target: { key: string; root: string } }[] = []
  for (const episode of importedEpisodes) {
    const target = mapping[episode.workspaceKey]
    if (target === undefined) {
      report.unmapped.push(episode.id)
      continue
    }
    if (
      mode === 'replace' &&
      replacementTarget !== undefined &&
      !episodeInTarget(target.key, replacementTarget)
    ) {
      report.skipped += 1
      continue
    }
    plannedEpisodes.push({ episode, target })
  }
  const importedScopeById = new Map<string, MemoryScope>()
  for (const { memory, scope } of planned) importedScopeById.set(memory.id, scope)
  const survivingIds =
    mode === 'replace' && replacementTarget !== undefined
      ? new Set(planned.map(({ memory }) => memory.id))
      : undefined
  const preparedInput = (
    memory: MemoryRecord,
    scope: MemoryScope,
  ): ReturnType<typeof importInput> =>
    importInput(
      memory,
      scope,
      scopedSupersedes(memory, scope, importedScopeById, survivingIds, domain),
      redactSecrets,
    )

  if (mode === 'replace' && replacementTarget !== undefined) {
    return runReplaceImport(
      store,
      domain,
      replacementTarget,
      planned,
      plannedEpisodes,
      preparedInput,
      redactSecrets,
      report,
    )
  }

  const operation = await beginComposite(store.operationRunner, 'import', {
    mode,
    scope: options.targetScope ?? payload.scope,
  })
  try {
    const digestKey = (record: MemoryRecord, scope: MemoryScope): string =>
      contentDigest({ ...record, scope, confidence: 1, sourceRefs: [] })
    const existingDigests = new Set(
      [...domain.table('memories').entries()].map(([, record]) => digestKey(record, record.scope)),
    )
    for (const { memory, scope: targetScope } of planned) {
      const prepared = preparedInput(memory, targetScope)
      const preparedKey = digestKey(
        {
          ...memory,
          title: prepared.input.title,
          body: prepared.input.body,
          tags: prepared.input.tags ?? [],
          sourceRefs: prepared.input.sourceRefs ?? [],
        },
        targetScope,
      )
      if (store.get(memory.id) !== undefined || existingDigests.has(preparedKey)) {
        report.skipped += 1
        continue
      }
      if (prepared.redacted) report.redacted += 1
      try {
        await store.create(prepared.input)
        report.created += 1
        existingDigests.add(preparedKey)
      } catch (error) {
        report.errors.push({
          id: memory.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    await store.runSerialized(async () => {
      for (const { episode, target } of plannedEpisodes) {
        if (domain.table('episodes').get(episode.id) !== undefined) continue
        const imported = buildImportedEpisode(episode, target, redactSecrets)
        await domain.table('episodes').put(imported.id, imported)
        report.episodesImported += 1
      }
    })
    const committed = await finishComposite(
      domain,
      store.operationRunner,
      operation,
      'import',
      'user',
      {
        created: report.created,
        skipped: report.skipped,
        replaced: report.replaced,
        episodesImported: report.episodesImported,
      },
      DEFAULT_NOW,
    )
    report.operationId = committed.id
    report.unmapped = [...new Set(report.unmapped)]
    return report
  } catch (error) {
    await failComposite(store.operationRunner, operation, error)
    throw error
  }
}

/**
 * Execute a destructive `replace` import atomically inside one serialized store
 * batch so preflight, deletion, creation and rollback cannot interleave with
 * concurrent writes.
 */
async function runReplaceImport(
  store: MemoryStore,
  domain: MemoryDomainHandle,
  replacementTarget: ExportScope,
  planned: readonly { memory: MemoryRecord; scope: MemoryScope }[],
  plannedEpisodes: readonly { episode: EpisodeRecord; target: { key: string; root: string } }[],
  preparedInput: (memory: MemoryRecord, scope: MemoryScope) => ReturnType<typeof importInput>,
  redactSecrets: boolean,
  report: ImportReport,
): Promise<ImportReport> {
  return store.runBatch(async (batch) => {
    const deleted = [...domain.table('memories').entries()]
      .map(([, record]) => record)
      .filter((record) => memoryInScope(record, replacementTarget))
    // A missing mapping or an empty document would otherwise delete the whole
    // target scope and import nothing in return. Refuse before any mutation.
    if (report.unmapped.length > 0) {
      throw new OperationError(
        'MEMORY_FORBIDDEN',
        `replace import requires a mapping for every workspace entry; ${report.unmapped.length} entr${
          report.unmapped.length === 1 ? 'y is' : 'ies are'
        } unmapped`,
      )
    }
    if (deleted.length > 0 && planned.length === 0) {
      throw new OperationError(
        'MEMORY_FORBIDDEN',
        'replace import would delete memories without importing a replacement; use PURGE to clear a scope',
      )
    }
    const seen = new Set<string>()
    const preparedList: { memory: MemoryRecord; prepared: ReturnType<typeof importInput> }[] = []
    const inputs: MemoryInput[] = []
    for (const { memory, scope } of planned) {
      const prepared = preparedInput(memory, scope)
      store.validateMemoryInput(prepared.input)
      inputs.push(prepared.input)
      preparedList.push({ memory, prepared })
      if (seen.has(memory.id)) {
        throw new OperationError('MEMORY_CONFLICT', `duplicate imported memory id '${memory.id}'`)
      }
      seen.add(memory.id)
      const existing = store.get(memory.id)
      if (existing !== undefined && !memoryInScope(existing, replacementTarget)) {
        throw new OperationError(
          'MEMORY_CONFLICT',
          `imported memory '${memory.id}' conflicts with a record outside the replace scope`,
        )
      }
    }
    store.validateCreateBatch(deleted, inputs)

    const deletedMemories: MemoryRecord[] = []
    const deletedEpisodes: EpisodeRecord[] = []
    const createdMemoryIds: MemoryId[] = []
    const createdEpisodeIds: EpisodeId[] = []
    const operation = await beginComposite(store.operationRunner, 'import', {
      mode: 'replace',
      scope: replacementTarget,
    })
    try {
      for (const record of deleted) {
        deletedMemories.push(structuredClone(record))
        await store.delete(record.id, { permanent: true, actor: 'user', confirm: true })
        report.replaced += 1
      }
      const staleEpisodes = [...domain.table('episodes').entries()]
        .filter(([, episode]) => episodeInScope(episode, replacementTarget))
        .map(([, episode]) => episode)
      for (const episode of staleEpisodes) deletedEpisodes.push(structuredClone(episode))
      if (staleEpisodes.length > 0) {
        await domain.table('episodes').deleteMany(staleEpisodes.map((episode) => episode.id))
      }
      for (const { memory, prepared } of preparedList) {
        if (prepared.redacted) report.redacted += 1
        const created = await store.create(prepared.input)
        createdMemoryIds.push(created.id)
        report.created += 1
        // Keep `memory` referenced cleanly for readability.
        void memory
      }
      for (const { episode, target } of plannedEpisodes) {
        if (domain.table('episodes').get(episode.id) !== undefined) continue
        const imported = buildImportedEpisode(episode, target, redactSecrets)
        await domain.table('episodes').put(imported.id, imported)
        createdEpisodeIds.push(imported.id)
        report.episodesImported += 1
      }
      const committed = await finishComposite(
        domain,
        store.operationRunner,
        operation,
        'import',
        'user',
        {
          created: report.created,
          skipped: report.skipped,
          replaced: report.replaced,
          episodesImported: report.episodesImported,
        },
        DEFAULT_NOW,
      )
      report.operationId = committed.id
      report.unmapped = [...new Set(report.unmapped)]
      return report
    } catch (error) {
      const restored = await restoreSnapshots(
        batch,
        domain,
        createdMemoryIds,
        createdEpisodeIds,
        deletedMemories,
        deletedEpisodes,
      )
      await failComposite(store.operationRunner, operation, error)
      if (restored === 0) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new OperationError(
        error instanceof OperationError ? error.code : 'MEMORY_CONFLICT',
        `${message}; restored ${restored} previously deleted record(s)`,
      )
    }
  })
}

/**
 * Best-effort restoration of rows a failed replace already mutated.
 *
 * Removes any partially inserted rows from the failed replace first, then
 * restores deleted snapshots directly (preserving revision, timestamps and
 * stats without triggering active-capacity eviction).
 */
async function restoreSnapshots(
  batch: MemoryStoreBatch,
  domain: MemoryDomainHandle,
  createdMemoryIds: readonly MemoryId[],
  createdEpisodeIds: readonly EpisodeId[],
  memories: readonly MemoryRecord[],
  episodes: readonly EpisodeRecord[],
): Promise<number> {
  for (const id of createdMemoryIds) {
    try {
      await batch.removeRawMemory(id)
    } catch {
      // Best effort only.
    }
  }
  if (createdEpisodeIds.length > 0) {
    try {
      await domain.table('episodes').deleteMany(createdEpisodeIds)
    } catch {
      // Best effort only.
    }
  }
  for (const episode of episodes) {
    try {
      await domain.table('episodes').put(episode.id, episode)
    } catch {
      // Best effort only.
    }
  }
  let restored = 0
  for (const memory of memories) {
    try {
      await batch.restoreSnapshot(memory)
      restored += 1
    } catch {
      // Best effort only.
    }
  }
  return restored
}

/** Begin a composite batch operation and persist its record before rows change. */
async function beginComposite(
  runner: OperationRunner,
  kind: 'import' | 'rebuild' | 'purge',
  payload: unknown,
): Promise<OperationRecord> {
  const operation = await runner.begin(kind, payload)
  if (operation.status === 'committed') {
    throw new OperationError('MEMORY_CONFLICT', `${kind} operation already completed`)
  }
  if (operation.status === 'failed') {
    throw new OperationError(
      'MEMORY_CONFLICT',
      operation.error ?? `${kind} operation previously failed`,
    )
  }
  return operation
}

/** Mark a composite operation `applying`, record its summary audit, then commit. */
async function finishComposite(
  domain: MemoryDomainHandle,
  runner: OperationRunner,
  operation: OperationRecord,
  action: 'import' | 'rebuild' | 'purge',
  actor: AuditActor,
  counts: Record<string, number>,
  now: () => Date,
): Promise<OperationRecord> {
  const applied = await runner.apply({
    ...operation,
    payload: { ...(operation.payload as Record<string, unknown>), counts },
  })
  // Audit before commit: a crash between the two steps leaves a summary row
  // for work that already happened, never an untraceable completed deletion.
  const id = AuditId(`audit-${applied.id}`)
  if (domain.table('audit').get(id) === undefined) {
    await domain.table('audit').put(id, {
      id,
      operationId: applied.id,
      action,
      actor,
      status: 'applied',
      at: now().toISOString(),
      before: null,
      after: null,
    })
  }
  return runner.commit(applied)
}

/** Mark a composite operation failed without throwing away its partial progress. */
async function failComposite(
  runner: OperationRunner,
  operation: OperationRecord,
  error: unknown,
): Promise<void> {
  try {
    await runner.markFailed(operation, error)
  } catch {
    // The original failure is the actionable error; a failed marker is best effort.
  }
}

/** Permanently delete one record with no content snapshots left in audit. */
async function hardDelete(
  domain: MemoryDomainHandle,
  runner: OperationRunner,
  record: MemoryRecord,
  actor: AuditActor,
): Promise<void> {
  await runner.scrubMemoryContent(record.id)
  await scrubAudits(domain, record.id)
  const operation = await runner.begin('memory.delete', {
    before: record,
    actor,
    minimalAudit: true,
  })
  if (operation.status === 'committed') return
  const applied = await runner.apply(operation)
  await runner.commit(applied)
}

function resetScopeRows<T extends { workspaceKey: string }>(
  table: {
    entries(): IterableIterator<[string, T]>
    deleteMany(keys: readonly string[]): Promise<number>
  },
  scope: ExportScope,
): Promise<number> {
  const ids = [...table.entries()]
    .filter(([, row]) =>
      scope === 'all' ? true : scope === 'global' ? false : row.workspaceKey === scope.workspaceKey,
    )
    .map(([id]) => id)
  return table.deleteMany(ids)
}

/**
 * Delete derived, unreviewed, unpinned memories in one scope and reset its
 * episodes and session cursors, then record a rebuild audit entry.
 * @param domain - Open memory domain.
 * @param runner - Operation runner.
 * @param request - Scope, optional `since`, and confirmation.
 * @param now - Clock override.
 * @returns Counts of deleted/retained/reset rows and per-item errors.
 */
export async function rebuild(
  domain: MemoryDomainHandle,
  runner: OperationRunner,
  request: RebuildRequest,
  now: () => Date = DEFAULT_NOW,
  serial: Serializer = RUN_NOW,
): Promise<RebuildReport> {
  if (request.confirm !== true) {
    throw new OperationError('MEMORY_FORBIDDEN', 'rebuild requires confirmation')
  }
  const operation = await beginComposite(runner, 'rebuild', {
    scope: request.scope,
    ...(request.since === undefined ? {} : { since: request.since }),
  })
  let deleted = 0
  let retainedUser = 0
  let resetEpisodes = 0
  let resetCursors = 0
  const errors: { memoryId?: string; message: string }[] = []
  // Table-only maintenance runs inside the store's write queue so a concurrent
  // capture or dream write cannot interleave with the reset.
  await serial(async () => {
    for (const [, record] of [...domain.table('memories').entries()]) {
      if (!memoryInScope(record, request.scope)) continue
      const derived =
        record.ownership === 'derived' && record.reviewedByUserAt === undefined && !record.pinned
      if (!derived) {
        retainedUser += 1
        continue
      }
      if (request.since !== undefined && record.updatedAt < request.since) continue
      try {
        await hardDelete(domain, runner, record, 'system')
        deleted += 1
      } catch (error) {
        errors.push({
          memoryId: record.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    resetEpisodes = await resetScopeRows(domain.table('episodes'), request.scope)
    resetCursors = await resetScopeRows(domain.table('session_cursors'), request.scope)
  })
  const committed = await finishComposite(
    domain,
    runner,
    operation,
    'rebuild',
    'user',
    { deleted, resetEpisodes, resetCursors },
    now,
  )
  return {
    deleted,
    retainedUser,
    resetEpisodes,
    resetCursors,
    operationId: committed.id,
    errors,
  }
}

/**
 * Clear one scope's memories and episodes after an exact confirmation phrase.
 * @param domain - Open memory domain.
 * @param runner - Operation runner.
 * @param request - Scope and confirmation text.
 * @param now - Clock override.
 * @returns Deleted counts and the audit operation id.
 */
export async function purgeAll(
  domain: MemoryDomainHandle,
  runner: OperationRunner,
  request: PurgeRequest,
  now: () => Date = DEFAULT_NOW,
  serial: Serializer = RUN_NOW,
): Promise<PurgeReport> {
  const expected = `PURGE ${scopeKey(request.scope)}`
  if (request.confirmText !== expected) {
    throw new OperationError('MEMORY_FORBIDDEN', `confirmation text must be exactly "${expected}"`)
  }
  const operation = await beginComposite(runner, 'purge', { scope: request.scope })
  let deleted = 0
  const errors: { memoryId?: string; message: string }[] = []
  let deletedEpisodes = 0
  let resetCursors = 0
  await serial(async () => {
    for (const [, record] of [...domain.table('memories').entries()]) {
      if (!memoryInScope(record, request.scope)) continue
      try {
        await hardDelete(domain, runner, record, 'user')
        deleted += 1
      } catch (error) {
        errors.push({
          memoryId: record.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    deletedEpisodes = await resetScopeRows(domain.table('episodes'), request.scope)
    // Reset the cold-backfill cursors too: leaving them behind would make the
    // cleared sessions look processed, so a later dream/backfill could never
    // regenerate derived knowledge from the surviving session log.
    resetCursors = await resetScopeRows(domain.table('session_cursors'), request.scope)
  })
  const committed = await finishComposite(
    domain,
    runner,
    operation,
    'purge',
    'user',
    { deleted, deletedEpisodes, resetCursors },
    now,
  )
  return { deleted, deletedEpisodes, operationId: committed.id, errors }
}
