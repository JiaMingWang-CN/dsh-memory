/**
 * Multi-client orchestration service for Memloom Desktop.
 *
 * Provides a unified per-client management facade backed by {@link MemoryEngine},
 * concurrent read-only aggregate search across healthy clients, per-store config
 * management (`AgyConfigStore` for AGY/agy-flat, read-only refusal for DSH), and
 * guarded direct client-to-client migration.
 * @module memloom/desktop/multi-service
 */
import path from 'node:path'
import { AgyConfigStore } from '../agy/config-store.ts'
import type { AuditListResult } from '../core/audit.ts'
import {
  AGY_EDITABLE_CONFIG_FIELDS,
  validateMemoryConfigPatch,
  type MemoryConfig,
  type ResolvedMemoryConfig,
} from '../core/config.ts'
import {
  MemoryEngine,
  type ManageCreateInput,
  type ManageDeleteInput,
  type ManageUpdateInput,
  type MemoryAuditQuery,
  type MemoryOverviewResult,
  type WorkspaceSummary,
} from '../core/engine.ts'
import type {
  ExportRequest,
  ExportScope,
  ImportOptions,
  ImportReport,
  MemoryExport,
  PurgeReport,
  PurgeRequest,
  RebuildReport,
  RebuildRequest,
  WorkspaceMapping,
} from '../core/exchange.ts'
import { OperationError } from '../core/operations.ts'
import type { ListRequest, ListResult } from '../core/store.ts'
import type {
  DreamRun,
  MemoryRecord,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
} from '../shared/types.ts'
import type { DreamUndoReport } from '../core/operations.ts'
import type {
  AddCustomClientInput,
  ClientHealth,
  ClientKind,
  ClientRegistry,
  DesktopPreferences,
  RegisteredClient,
  UpdateClientInput,
} from './registry.ts'
import type { StoreEnvelopeFormat } from './storage/envelope.ts'
import { openDesktopStore, type DesktopStoreHandle } from './storage/open-store.ts'
import type { WriteGuard, WriteGuardSnapshot } from './write-guard.ts'

/** Error thrown when opening or reading a corrupted or unreadable memory store. */
export class DesktopStoreCorruptError extends Error {
  readonly code = 'desktop/store-corrupt'
  readonly clientId: string
  readonly storePath: string

  constructor(clientId: string, storePath: string, detail?: string) {
    super(
      detail !== undefined && detail !== ''
        ? `Memory store "${clientId}" at ${storePath} is corrupted or unreadable: ${detail}`
        : `Memory store "${clientId}" at ${storePath} is corrupted or unreadable.`,
    )
    this.name = 'DesktopStoreCorruptError'
    this.clientId = clientId
    this.storePath = storePath
  }
}

/** Error thrown when an operation is unsupported for the target client type. */
export class DesktopUnsupportedError extends Error {
  readonly code = 'desktop/unsupported'

  constructor(message: string) {
    super(message)
    this.name = 'DesktopUnsupportedError'
  }
}

export interface DesktopClientInfo extends RegisteredClient {
  readonly writable: boolean
  readonly configEditable: boolean
}

export interface DesktopClientConfigResult {
  readonly editable: boolean
  readonly reason?: string
  readonly config?: ResolvedMemoryConfig
  readonly editableFields?: readonly (keyof MemoryConfig)[]
}

export interface AggregateSearchRequest {
  readonly query?: string
  readonly clientIds?: readonly string[]
  readonly workspaceKey?: string | 'all' | null
  readonly types?: readonly MemoryType[]
  readonly statuses?: readonly MemoryStatus[]
  readonly limit?: number
  readonly offset?: number
}

export interface AggregateSearchItem {
  readonly clientId: string
  readonly clientName: string
  readonly clientKind: ClientKind
  readonly writable: boolean
  readonly record: MemoryRecord
  readonly score: number
  readonly normalizedScore: number
  readonly snippet: string
}

export interface AggregateSearchResult {
  readonly items: AggregateSearchItem[]
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly truncated: boolean
  readonly skippedClients: readonly {
    readonly id: string
    readonly name: string
    readonly health: ClientHealth
    readonly detail?: string
  }[]
}

export type MigrationSourceSelection =
  | {
      readonly kind: 'scope'
      readonly scope: ExportScope
      readonly includeArchived?: boolean
      readonly includeEpisodes?: boolean
    }
  | {
      readonly kind: 'records'
      readonly memoryIds: readonly string[]
    }

export interface MigrationPreviewRequest {
  readonly sourceClientId: string
  readonly targetClientId: string
  readonly selection: MigrationSourceSelection
}

export interface MigrationPreviewResult {
  readonly sourceClientId: string
  readonly targetClientId: string
  readonly targetWritable: boolean
  readonly memoryCount: number
  readonly episodeCount: number
  readonly allowReplace: boolean
  readonly sourceWorkspaces: readonly {
    readonly key: string
    readonly root: string
    readonly count: number
  }[]
  readonly suggestedMapping: WorkspaceMapping
  readonly targetWorkspaces: readonly WorkspaceSummary[]
}

export interface MigrationExecuteRequest {
  readonly sourceClientId: string
  readonly targetClientId: string
  readonly selection: MigrationSourceSelection
  readonly mode: 'merge' | 'replace'
  readonly mapping: WorkspaceMapping
  readonly targetScope?: ExportScope
  readonly confirm?: boolean
}

export interface MultiClientServiceOptions {
  readonly registry: ClientRegistry
  readonly writeGuard: WriteGuard
  readonly now?: () => Date
  readonly logger?: { warn?: (message: string) => void }
}

interface CachedEngineEntry {
  readonly clientId: string
  readonly format: StoreEnvelopeFormat
  readonly handle: DesktopStoreHandle
  readonly engine: MemoryEngine
  readonly configStore: AgyConfigStore | undefined
  recovered: boolean
}

const EDITABLE_CONFIG_KEY_SET = new Set<string>(AGY_EDITABLE_CONFIG_FIELDS)
const DEFAULT_AGGREGATE_LIMIT = 20

function isClientConfigEditable(client: RegisteredClient): boolean {
  return client.kind !== 'dsh' && client.format !== 'dsh-unit'
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function inferCorruptHealth(error: unknown): ClientHealth {
  if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
    return 'missing'
  }
  if (
    error instanceof DesktopStoreCorruptError ||
    (error instanceof OperationError && error.code === 'MEMORY_UNAVAILABLE') ||
    error instanceof SyntaxError
  ) {
    return 'corrupted'
  }
  return 'unreadable'
}

function collectExportWorkspaces(
  payload: MemoryExport,
): readonly { readonly key: string; readonly root: string; readonly count: number }[] {
  const map = new Map<string, { key: string; root: string; count: number }>()
  for (const record of payload.memories) {
    if (record.scope.kind !== 'workspace') continue
    const existing = map.get(record.scope.key)
    if (existing === undefined) {
      map.set(record.scope.key, {
        key: record.scope.key,
        root: record.scope.root,
        count: 1,
      })
    } else {
      existing.count += 1
    }
  }
  for (const episode of payload.episodes) {
    if (!map.has(episode.workspaceKey)) {
      map.set(episode.workspaceKey, {
        key: episode.workspaceKey,
        root: episode.workspaceRoot,
        count: 0,
      })
    }
  }
  return [...map.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function workspaceTargetWithinScope(targetKey: string, targetScope: ExportScope): boolean {
  if (targetScope === 'all') return true
  if (targetScope === 'global') return false
  return targetKey === targetScope.workspaceKey
}

/**
 * Coordinates registered DSH, AGY, and custom memory stores for Memloom Desktop.
 */
export class MultiClientService {
  private readonly registry: ClientRegistry
  private readonly writeGuard: WriteGuard
  private readonly now: () => Date
  private readonly logger: { warn?: (message: string) => void } | undefined

  private readonly engines = new Map<string, CachedEngineEntry>()
  private readonly opening = new Map<string, Promise<CachedEngineEntry>>()
  private readonly configStores = new Map<string, AgyConfigStore>()

  constructor(options: MultiClientServiceOptions) {
    this.registry = options.registry
    this.writeGuard = options.writeGuard
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
  }

  /** Load persisted desktop state, discover built-in stores, and probe DSH process state. */
  async initialize(): Promise<void> {
    await this.registry.load()
    await this.registry.refreshDiscovery()
    await this.writeGuard.refresh()
  }

  private requireClient(clientId: string): RegisteredClient {
    const client = this.registry.getClient(clientId)
    if (client === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `Client "${clientId}" is not registered.`)
    }
    return client
  }

  private toClientInfo(client: RegisteredClient): DesktopClientInfo {
    return {
      ...client,
      writable: this.writeGuard.isClientWritable(client.dshProtected),
      configEditable: isClientConfigEditable(client),
    }
  }

  private getOrCreateConfigStore(client: RegisteredClient): AgyConfigStore {
    const configPath = path.join(path.dirname(client.storePath), 'config.json')
    let store = this.configStores.get(configPath)
    if (store === undefined) {
      store = new AgyConfigStore(configPath)
      this.configStores.set(configPath, store)
    }
    return store
  }

  private async openEntry(client: RegisteredClient): Promise<CachedEngineEntry> {
    const existing = this.engines.get(client.id)
    if (existing !== undefined) {
      return existing
    }

    const inflight = this.opening.get(client.id)
    if (inflight !== undefined) {
      return inflight
    }

    const task = (async (): Promise<CachedEngineEntry> => {
      const configStore = isClientConfigEditable(client)
        ? this.getOrCreateConfigStore(client)
        : undefined
      const initialConfig = configStore !== undefined ? await configStore.load() : undefined

      const expectedFormat: StoreEnvelopeFormat =
        client.format ?? (client.kind === 'dsh' ? 'dsh-unit' : 'agy-flat')

      let handle: DesktopStoreHandle
      try {
        handle = await openDesktopStore({
          storePath: client.storePath,
          expectedFormat,
          onReload: () => {
            this.engines.get(client.id)?.engine.syncSearchIndex()
          },
          ...(this.logger?.warn !== undefined ? { onWarn: this.logger.warn } : {}),
          now: this.now,
        })
      } catch (err) {
        if (err instanceof OperationError && err.code === 'MEMORY_UNAVAILABLE') {
          throw new DesktopStoreCorruptError(client.id, client.storePath, err.message)
        }
        if (err instanceof SyntaxError) {
          throw new DesktopStoreCorruptError(client.id, client.storePath, err.message)
        }
        throw err
      }

      const engine = new MemoryEngine({
        domain: handle.domain,
        ...(initialConfig !== undefined ? { config: initialConfig } : {}),
        now: this.now,
        ...(this.logger !== undefined ? { logger: this.logger } : {}),
      })

      const entry: CachedEngineEntry = {
        clientId: client.id,
        format: handle.format,
        handle,
        engine,
        configStore,
        recovered: false,
      }
      this.engines.set(client.id, entry)
      return entry
    })()

    this.opening.set(client.id, task)
    try {
      return await task
    } finally {
      this.opening.delete(client.id)
    }
  }

  private async evictClientEngine(clientId: string): Promise<void> {
    const inflight = this.opening.get(clientId)
    if (inflight !== undefined) {
      await inflight.catch(() => {})
    }
    const entry = this.engines.get(clientId)
    if (entry !== undefined) {
      this.engines.delete(clientId)
      await entry.handle.close().catch(() => {})
    }
  }

  private async ensureEngine(
    clientId: string,
    intent: 'read' | 'write',
  ): Promise<{ client: RegisteredClient; entry: CachedEngineEntry }> {
    const client = this.requireClient(clientId)

    if (client.health === 'corrupted' || client.health === 'unreadable') {
      throw new DesktopStoreCorruptError(client.id, client.storePath, client.healthDetail)
    }

    if (client.health === 'missing' && intent === 'write' && !client.allowInitializeWhenMissing) {
      throw new OperationError(
        'MEMORY_NOT_FOUND',
        `Memory store for "${client.name}" (${client.id}) does not exist at "${client.storePath}".`,
      )
    }

    if (intent === 'write') {
      this.writeGuard.assertClientWritable(client.dshProtected)
    }

    const wasCached = this.engines.has(client.id)
    const entry = await this.openEntry(client)

    if (wasCached) {
      if (intent === 'read') {
        await entry.handle.syncFromDiskIfChanged()
        if (entry.configStore !== undefined) {
          const { changed, config } = await entry.configStore.syncIfChanged()
          if (changed) {
            entry.engine.updateConfig(config)
          }
        }
      } else if (entry.format === 'agy-flat') {
        await entry.handle.syncFromDiskIfChanged()
        if (entry.configStore !== undefined) {
          const { changed, config } = await entry.configStore.syncIfChanged()
          if (changed) {
            entry.engine.updateConfig(config)
          }
        }
      }
    }

    if (intent === 'read') {
      const writable = this.writeGuard.isClientWritable(client.dshProtected)
      if (!writable || client.health === 'missing') {
        entry.engine.openReadOnly()
      } else if (!entry.recovered) {
        await entry.handle.runWrite(async () => {
          await entry.engine.recover()
          entry.recovered = true
        })
      }
    }

    return { client, entry }
  }

  private async runClientWrite<T>(
    clientId: string,
    work: (entry: CachedEngineEntry) => Promise<T>,
  ): Promise<T> {
    const { client, entry } = await this.ensureEngine(clientId, 'write')
    const wasMissing = client.health === 'missing'
    const wasRecovered = entry.recovered

    try {
      const result = await entry.handle.runWrite(async () => {
        if (!entry.recovered) {
          await entry.engine.recover()
          entry.recovered = true
        }
        return await work(entry)
      })
      if (wasMissing) {
        await this.registry.refreshDiscovery()
      }
      return result
    } catch (err) {
      if (!wasRecovered) {
        entry.recovered = false
      }
      throw err
    }
  }

  /** Return all registered clients annotated with live write and config editability flags. */
  listClients(): DesktopClientInfo[] {
    return this.registry.listClients().map((client) => this.toClientInfo(client))
  }

  /** Re-discover stores, refresh DSH process guard, and sync cached handles from disk. */
  async refreshAll(): Promise<DesktopClientInfo[]> {
    await Promise.all([this.registry.refreshDiscovery(), this.writeGuard.refresh()])

    for (const [clientId, entry] of [...this.engines.entries()]) {
      const current = this.registry.getClient(clientId)
      if (
        current === undefined ||
        current.health === 'corrupted' ||
        current.health === 'unreadable'
      ) {
        await this.evictClientEngine(clientId)
        continue
      }
      try {
        await entry.handle.syncFromDiskIfChanged()
        if (entry.configStore !== undefined) {
          const { changed, config } = await entry.configStore.syncIfChanged()
          if (changed) {
            entry.engine.updateConfig(config)
          }
        }
      } catch {
        await this.evictClientEngine(clientId)
      }
    }

    return this.listClients()
  }

  getGuardSnapshot(): WriteGuardSnapshot {
    return this.writeGuard.getSnapshot()
  }

  refreshDshGuard(): Promise<WriteGuardSnapshot> {
    return this.writeGuard.refresh()
  }

  forceUnlockDsh(confirmed: boolean): WriteGuardSnapshot {
    return this.writeGuard.forceUnlock(confirmed)
  }

  relockDsh(): WriteGuardSnapshot {
    return this.writeGuard.relock()
  }

  async addCustomClient(input: AddCustomClientInput): Promise<DesktopClientInfo> {
    const created = await this.registry.addCustomClient(input)
    return this.toClientInfo(created)
  }

  async updateClient(input: UpdateClientInput): Promise<DesktopClientInfo> {
    const updated = await this.registry.updateClient(input)
    return this.toClientInfo(updated)
  }

  async removeCustomClient(id: string): Promise<boolean> {
    const removed = await this.registry.removeCustomClient(id)
    if (removed) {
      await this.evictClientEngine(id)
    }
    return removed
  }

  getPreferences(): DesktopPreferences {
    return this.registry.getPreferences()
  }

  updatePreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences> {
    return this.registry.updatePreferences(patch)
  }

  getLegacyAgyCandidate(): string | undefined {
    return this.registry.getLegacyAgyCandidate()
  }

  async overview(
    clientId: string,
    workspaceKey: string | 'all' | null = 'all',
  ): Promise<MemoryOverviewResult> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.overview(workspaceKey)
  }

  async list(clientId: string, request: ListRequest = {}): Promise<ListResult> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.list({
      workspaceKey: 'all',
      ...request,
      management: true,
    })
  }

  async view(
    clientId: string,
    id: string,
  ): Promise<{ record: MemoryRecord; sources: MemorySourceRef[] }> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.view(id)
  }

  create(clientId: string, input: ManageCreateInput): Promise<MemoryRecord> {
    return this.runClientWrite(clientId, (entry) => entry.engine.manageCreate(input))
  }

  update(clientId: string, input: ManageUpdateInput): Promise<MemoryRecord> {
    return this.runClientWrite(clientId, (entry) => entry.engine.manageUpdate(input))
  }

  delete(
    clientId: string,
    input: ManageDeleteInput,
  ): Promise<{ deleted: boolean; record: MemoryRecord | null }> {
    return this.runClientWrite(clientId, (entry) => entry.engine.manageDelete(input))
  }

  restore(clientId: string, id: string): Promise<MemoryRecord> {
    return this.runClientWrite(clientId, (entry) => entry.engine.manageRestore(id))
  }

  review(
    clientId: string,
    input: { id: string; action: 'accept' | 'reject' },
  ): Promise<MemoryRecord> {
    return this.runClientWrite(clientId, (entry) => entry.engine.manageReview(input))
  }

  async listDreams(clientId: string, limit?: number): Promise<DreamRun[]> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.dreamList(limit)
  }

  undoDream(clientId: string, dreamId: string): Promise<DreamUndoReport> {
    return this.runClientWrite(clientId, (entry) => entry.engine.undoDream(dreamId))
  }

  async listAudit(clientId: string, query?: MemoryAuditQuery): Promise<AuditListResult> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.audit(query)
  }

  async listWorkspaces(clientId: string): Promise<WorkspaceSummary[]> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.listWorkspaces()
  }

  /** Strictly read-only export (never triggers `after-export` archive purge). */
  async export(clientId: string, request: ExportRequest): Promise<MemoryExport> {
    const { entry } = await this.ensureEngine(clientId, 'read')
    return entry.engine.export(request)
  }

  import(clientId: string, payload: MemoryExport, options?: ImportOptions): Promise<ImportReport> {
    return this.runClientWrite(clientId, (entry) => entry.engine.import(payload, options))
  }

  rebuild(clientId: string, request: RebuildRequest): Promise<RebuildReport> {
    return this.runClientWrite(clientId, (entry) => entry.engine.rebuild(request))
  }

  purgeAll(clientId: string, request: PurgeRequest): Promise<PurgeReport> {
    return this.runClientWrite(clientId, (entry) => entry.engine.purgeAll(request))
  }

  async getConfig(clientId: string): Promise<DesktopClientConfigResult> {
    const client = this.requireClient(clientId)
    if (!isClientConfigEditable(client)) {
      return {
        editable: false,
        reason: 'DSH plugin configuration is managed by the DSH Profile and cannot be edited here.',
      }
    }
    const configStore = this.getOrCreateConfigStore(client)
    const config = await configStore.load()
    return {
      editable: true,
      config,
      editableFields: AGY_EDITABLE_CONFIG_FIELDS,
    }
  }

  async updateConfig(
    clientId: string,
    patch: Partial<MemoryConfig>,
  ): Promise<DesktopClientConfigResult> {
    const client = this.requireClient(clientId)
    if (!isClientConfigEditable(client)) {
      throw new DesktopUnsupportedError(
        `Configuration for "${client.name}" (${client.id}) is managed by the DSH Profile and is read-only in Memloom Desktop.`,
      )
    }

    const cleanPatch = validateMemoryConfigPatch(patch)
    const disallowed = Object.keys(cleanPatch).filter((key) => !EDITABLE_CONFIG_KEY_SET.has(key))
    if (disallowed.length > 0) {
      throw new OperationError(
        'MEMORY_INVALID_CONFIG',
        `Config field(s) not editable for AGY/agy-flat stores: ${disallowed.join(', ')}`,
      )
    }

    const configStore = this.getOrCreateConfigStore(client)
    const saved = await configStore.savePatch(cleanPatch)

    const cached = this.engines.get(clientId)
    const effective = cached !== undefined ? cached.engine.updateConfig(saved) : saved
    if (cleanPatch.enabled !== undefined) {
      await this.registry.refreshDiscovery()
    }

    return {
      editable: true,
      config: effective,
      editableFields: AGY_EDITABLE_CONFIG_FIELDS,
    }
  }

  /**
   * Read-only federated search across all enabled healthy clients, skipping
   * missing/corrupted/unreadable stores with diagnostic reporting.
   */
  async aggregateSearch(request: AggregateSearchRequest = {}): Promise<AggregateSearchResult> {
    const limit = Math.max(1, Math.floor(request.limit ?? DEFAULT_AGGREGATE_LIMIT))
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const filterSet = request.clientIds !== undefined ? new Set(request.clientIds) : null

    const candidates = this.registry
      .listClients()
      .filter((client) => client.enabled && (filterSet === null || filterSet.has(client.id)))

    const skippedClients: {
      readonly id: string
      readonly name: string
      readonly health: ClientHealth
      readonly detail?: string
    }[] = []
    const healthyClients: RegisteredClient[] = []

    for (const client of candidates) {
      if (client.health !== 'ready') {
        skippedClients.push({
          id: client.id,
          name: client.name,
          health: client.health,
          ...(client.healthDetail !== undefined ? { detail: client.healthDetail } : {}),
        })
      } else {
        healthyClients.push(client)
      }
    }

    const perClientHits = await Promise.all(
      healthyClients.map(async (client): Promise<AggregateSearchItem[]> => {
        try {
          const { entry } = await this.ensureEngine(client.id, 'read')
          const writable = this.writeGuard.isClientWritable(client.dshProtected)
          const res = entry.engine.searchManagement({
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.workspaceKey !== undefined ? { workspaceKey: request.workspaceKey } : {}),
            ...(request.types !== undefined ? { types: request.types } : {}),
            ...(request.statuses !== undefined ? { statuses: request.statuses } : {}),
            limit: Number.MAX_SAFE_INTEGER,
            offset: 0,
          })
          return res.items.map((hit) => ({
            clientId: client.id,
            clientName: client.name,
            clientKind: client.kind,
            writable,
            record: hit.record,
            score: hit.score,
            normalizedScore: hit.normalizedScore,
            snippet: hit.snippet,
          }))
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          skippedClients.push({
            id: client.id,
            name: client.name,
            health: inferCorruptHealth(err),
            detail,
          })
          return []
        }
      }),
    )

    const allHits = perClientHits.flat()
    const hasQuery = (request.query?.trim() ?? '') !== ''

    allHits.sort((left, right) => {
      if (hasQuery) {
        if (right.normalizedScore !== left.normalizedScore) {
          return right.normalizedScore - left.normalizedScore
        }
        if (right.score !== left.score) {
          return right.score - left.score
        }
      }
      const updatedDiff = right.record.updatedAt.localeCompare(left.record.updatedAt)
      if (updatedDiff !== 0) return updatedDiff
      const clientDiff = left.clientId.localeCompare(right.clientId)
      if (clientDiff !== 0) return clientDiff
      return left.record.id.localeCompare(right.record.id)
    })

    const total = allHits.length
    const items = allHits.slice(offset, offset + limit)

    return {
      items,
      total,
      limit,
      offset,
      truncated: offset + limit < total,
      skippedClients,
    }
  }

  private async buildMigrationPayload(
    sourceClientId: string,
    selection: MigrationSourceSelection,
  ): Promise<MemoryExport> {
    const { entry: sourceEntry } = await this.ensureEngine(sourceClientId, 'read')

    if (selection.kind === 'scope') {
      const exported = sourceEntry.engine.export({
        scope: selection.scope,
        ...(selection.includeArchived !== undefined
          ? { includeArchived: selection.includeArchived }
          : {}),
      })
      if (selection.includeEpisodes === false) {
        return { ...exported, episodes: [] }
      }
      return exported
    }

    const uniqueIds = [...new Set(selection.memoryIds)]
    if (uniqueIds.length === 0) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        'At least one memory id must be selected for record migration.',
      )
    }

    const memories = uniqueIds.map((id) => structuredClone(sourceEntry.engine.view(id).record))
    return {
      format: 'memloom',
      version: 1,
      exportedAt: this.now().toISOString(),
      scope: 'all',
      includeArchived: true,
      memories,
      episodes: [],
    }
  }

  /** Preview workspaces, item counts, and target writability for a client-to-client migration. */
  async previewMigration(request: MigrationPreviewRequest): Promise<MigrationPreviewResult> {
    if (request.sourceClientId === request.targetClientId) {
      throw new OperationError(
        'MEMORY_INVALID_QUERY',
        'Source and target clients must be different for migration.',
      )
    }

    const payload = await this.buildMigrationPayload(request.sourceClientId, request.selection)
    const sourceWorkspaces = collectExportWorkspaces(payload)
    const suggestedMapping: WorkspaceMapping = {}
    for (const ws of sourceWorkspaces) {
      suggestedMapping[ws.key] = { key: ws.key, root: ws.root }
    }

    const targetClient = this.requireClient(request.targetClientId)
    const targetWritable =
      this.writeGuard.isClientWritable(targetClient.dshProtected) &&
      targetClient.health !== 'corrupted' &&
      targetClient.health !== 'unreadable' &&
      (targetClient.health !== 'missing' || targetClient.allowInitializeWhenMissing)

    let targetWorkspaces: WorkspaceSummary[] = []
    if (targetClient.health === 'ready') {
      const { entry: targetEntry } = await this.ensureEngine(targetClient.id, 'read')
      targetWorkspaces = targetEntry.engine.listWorkspaces()
    }

    return {
      sourceClientId: request.sourceClientId,
      targetClientId: request.targetClientId,
      targetWritable,
      memoryCount: payload.memories.length,
      episodeCount: payload.episodes.length,
      allowReplace: request.selection.kind === 'scope',
      sourceWorkspaces,
      suggestedMapping,
      targetWorkspaces,
    }
  }

  /**
   * Execute a direct client-to-client migration using read-only source export
   * and write-guarded target import.
   */
  async executeMigration(request: MigrationExecuteRequest): Promise<ImportReport> {
    if (request.sourceClientId === request.targetClientId) {
      throw new OperationError(
        'MEMORY_INVALID_QUERY',
        'Source and target clients must be different for migration.',
      )
    }

    if (request.selection.kind === 'records' && request.mode === 'replace') {
      throw new OperationError(
        'MEMORY_FORBIDDEN',
        'Replace mode is forbidden for individual record migration; only merge mode is allowed.',
      )
    }

    const targetClient = this.requireClient(request.targetClientId)
    if (targetClient.health === 'corrupted' || targetClient.health === 'unreadable') {
      throw new DesktopStoreCorruptError(
        targetClient.id,
        targetClient.storePath,
        targetClient.healthDetail,
      )
    }
    if (targetClient.health === 'missing' && !targetClient.allowInitializeWhenMissing) {
      throw new OperationError(
        'MEMORY_NOT_FOUND',
        `Memory store for "${targetClient.name}" (${targetClient.id}) does not exist at "${targetClient.storePath}".`,
      )
    }
    this.writeGuard.assertClientWritable(targetClient.dshProtected)

    const payload = await this.buildMigrationPayload(request.sourceClientId, request.selection)
    const sourceWorkspaces = collectExportWorkspaces(payload)

    if (request.mode === 'replace') {
      if (request.confirm !== true || request.targetScope === undefined) {
        throw new OperationError(
          'MEMORY_FORBIDDEN',
          'Replace migration requires explicit confirm=true and targetScope.',
        )
      }
      for (const ws of sourceWorkspaces) {
        const mapped = request.mapping[ws.key]
        if (mapped === undefined || mapped.key.trim() === '' || mapped.root.trim() === '') {
          throw new OperationError(
            'MEMORY_FORBIDDEN',
            `Replace migration requires an explicit mapping for every source workspace; missing "${ws.key}".`,
          )
        }
        if (!workspaceTargetWithinScope(mapped.key, request.targetScope)) {
          throw new OperationError(
            'MEMORY_FORBIDDEN',
            `Mapped workspace "${mapped.key}" for source "${ws.key}" lies outside targetScope.`,
          )
        }
      }
    }

    return this.runClientWrite(request.targetClientId, (targetEntry) =>
      targetEntry.engine.import(payload, {
        mode: request.mode,
        mapping: request.mapping,
        ...(request.confirm !== undefined ? { confirm: request.confirm } : {}),
        ...(request.targetScope !== undefined ? { targetScope: request.targetScope } : {}),
      }),
    )
  }

  /** Close all cached store handles and release in-memory state. */
  async closeAll(): Promise<void> {
    const inflight = [...this.opening.values()]
    if (inflight.length > 0) {
      await Promise.allSettled(inflight)
    }
    const entries = [...this.engines.values()]
    this.engines.clear()
    this.configStores.clear()
    await Promise.all(entries.map((entry) => entry.handle.close().catch(() => {})))
  }
}
