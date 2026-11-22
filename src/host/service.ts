import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MEMORY_REMOTE } from '../remote-spec.ts'
import { wrapRemoteBusinessErrors } from './remote-errors.ts'
import { CapacityPolicy } from './capacity.ts'
import { Config as MemoryConfigSchema, resolveMemoryConfig, type MemoryConfig } from './config.ts'
import { memoryDomain } from './domain.ts'
import {
  OperationError,
  OperationRunner,
  type RecoveryReport,
  type DreamUndoReport,
} from './operations.ts'
import {
  SearchIndex,
  DEFAULT_SEARCH_LIMIT,
  type SearchRequest,
  type SearchResult,
} from './search.ts'
import {
  MemoryStore,
  type ListRequest,
  type ListResult,
  type MemoryInput,
  type MemoryPatch,
  type StoreCounts,
} from './store.ts'
import { registerMemoryTools } from './tools/index.ts'
import { registerMemoryCommands } from './command.ts'
import { registerIndexInjection } from './inject.ts'
import { registerMemoryUsageProjection } from './projection.ts'
import { MemoryCapture } from './capture.ts'
import { createTurnWorklog } from './worklog.ts'
import { DreamScheduler, DomainSessionCursorStore } from './dream-scheduler.ts'
import type { BackfillReport, ColdSessionRecord, ColdSessionSnapshot } from './dream-scheduler.ts'
import {
  MemoryDreamer,
  type DreamLlm,
  type DreamModelSelection,
  type DreamQueueState,
  type DreamRequest,
  type MemoryDreamerOptions,
} from './dreamer.ts'
import {
  exportMemories,
  importMemories,
  purgeAll as purgeAllMemories,
  rebuild as rebuildMemories,
  type ExportScope,
  type ImportOptions,
  type ImportReport,
  type MemoryExport,
  type PurgeReport,
  type PurgeRequest,
  type RebuildReport,
  type RebuildRequest,
} from './exchange.ts'
import type { DreamRun } from '../shared/types.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { normalizeWorkspaceKey } from './workspace.ts'
import { redactSecrets, detectStrongSecret, normalizeEscapedNewlines } from './redact.ts'
import type { WorkspaceIdentity } from './workspace.ts'
import {
  MemoryId,
  type MemoryRecord,
  type MemoryScope,
  type MemorySourceRef,
  type MemoryType,
} from '../shared/types.ts'

/** Snapshot returned by {@link MemoryService.status}. */
export interface MemoryStatusSnapshot {
  ready: boolean
  counts: StoreCounts
  lastRecovery?: RecoveryReport
  dreamQueue: DreamQueueState
}

const EMPTY_COUNTS: StoreCounts = {
  active: 0,
  archived: 0,
  pending: 0,
  stored: 0,
  queuedEpisodes: 0,
  auditRecords: 0,
  operationRecords: 0,
}

/** Upper bound on how long dispose waits for a stuck startup reconciliation. */
const STARTUP_RECONCILE_DISPOSE_WAIT_MS = 500

/** How often the long-running service re-applies time-based retention. */
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Settle a promise without letting a stuck external read block shutdown. */
async function settleWithin(
  promise: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<void> {
  if (promise === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Longest accepted memory title, in characters. */
export const MAX_TITLE_LENGTH = 200
/** Largest accepted memory body, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 65_536

/** Error message used when an explicit write contains a strong secret. */
const STRONG_SECRET_WRITE_MESSAGE =
  'memory content looks like a secret (private key, API key or token); record where it is configured instead'

/** Input accepted by {@link MemoryService.write} from the explicit write tool. */
export interface MemoryWriteInput {
  id?: string
  type: MemoryType
  title: string
  body: string
  scope?: 'workspace' | 'global'
  tags?: string[]
  importance?: number
  expectedContentRevision?: number
  sourceRefs?: MemorySourceRef[]
}

/** Result of {@link MemoryService.write}. */
export interface MemoryWriteResult {
  record: MemoryRecord
  redactions: number
  /** True when an active record with the same scope, type and title already existed. */
  duplicate?: boolean
}

/** Management overview returned to the Settings page. */
export interface MemoryOverview {
  workspaceKey: string | 'all' | null
  counts: { active: number; pending: number; archived: number; stored: number }
  pendingReview: number
  recentDream: DreamRun | null
  index: { entries: number; bytes: number }
}

/** Fields accepted by the user-facing {@link MemoryService.create} Remote method. */
export interface RemoteCreateInput {
  type: MemoryType
  title: string
  body: string
  scope?: 'workspace' | 'global'
  workspaceKey?: string
  workspaceRoot?: string
  tags?: string[]
  importance?: number
  confidence?: number
  pinned?: boolean
  status?: 'active' | 'pending'
}

/** Fields accepted by the user-facing {@link MemoryService.update} Remote method. */
export interface RemoteUpdateInput {
  id: string
  expectedContentRevision: number
  type?: MemoryType
  title?: string
  body?: string
  tags?: string[]
  importance?: number
  confidence?: number
  pinned?: boolean
  status?: 'active' | 'archived'
  scope?: 'workspace' | 'global'
  workspaceKey?: string
  workspaceRoot?: string
}

/** User management delete request. Permanent deletion demands an explicit confirmation. */
export interface RemoteDeleteRequest {
  id: string
  permanent?: boolean
  confirm?: boolean
  actor?: 'user' | 'model'
}

/** Review action on one pending proposal. */
export interface RemoteReviewRequest {
  id: string
  action: 'accept' | 'reject'
}

/** Manual dream request from the Settings page. */
export interface RemoteDreamRequest {
  scope: 'workspace' | 'global'
  workspaceKey?: string
  workspaceRoot?: string
  maxEpisodes?: number
  since?: string
}

/** Configuration fields the Settings page may write in 0.1.0 (design §8). */
export const EDITABLE_CONFIG_FIELDS = [
  'autoDream',
  'autoAcceptProposals',
  'dreamIdleDelayMs',
  'autoDreamMinIntervalMs',
  'indexMaxBytes',
  'refreshIndexOnChange',
  'dreamModelMode',
  'dreamProvider',
  'dreamModel',
  'dreamReasoningEffort',
  'episodeRetentionDays',
  'worklogRetentionDays',
  'redactSecrets',
] as const

/**
 * Whether a stored memory is visible to one workspace caller. Global memories
 * are visible everywhere; workspace memories only inside their exact workspace.
 */
function isRecordVisible(record: MemoryRecord, workspaceKey: string | null): boolean {
  if (record.scope.kind === 'global') return true
  if (workspaceKey === null) return false
  return record.scope.key === workspaceKey
}

/** Whether two scopes are the same storage location. */
function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === 'global' || right.kind === 'global') return left.kind === right.kind
  return left.key === right.key && left.root === right.root
}

/** Resolve a write request's scope, enforcing the global-implies-preference rule. */
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

/** Read a session's `modelSelection` projection (`next ?? lastUsed`). */
function sessionSelection(ctx: Context, request: DreamRequest): DreamModelSelection | undefined {
  const agent = request.agent as { session?: unknown } | undefined
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const projections =
    get === undefined
      ? undefined
      : (get('sessionProjections') as
          | {
              snapshot?: (
                session: unknown,
                keys: readonly string[],
              ) => {
                values?: {
                  modelSelection?: {
                    next?: DreamModelSelection | null
                    lastUsed?: DreamModelSelection | null
                  }
                }
              }
            }
          | undefined)
  if (agent?.session === undefined || projections?.snapshot === undefined) return undefined
  try {
    const snapshot = projections.snapshot(agent.session, ['modelSelection'])
    const value = snapshot.values?.modelSelection
    const selected = value?.next ?? value?.lastUsed
    if (selected !== null && selected !== undefined) {
      return {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort }),
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** The configured default model selection, when available. */
function defaultSelectionOf(ctx: Context): DreamModelSelection | undefined {
  const service = (
    ctx as unknown as {
      agentDefaultModel?: { currentSelection?: () => DreamModelSelection | undefined }
    }
  ).agentDefaultModel
  if (service?.currentSelection === undefined) return undefined
  try {
    const selection = service.currentSelection()
    return selection === undefined
      ? undefined
      : { provider: selection.provider, model: selection.model }
  } catch {
    return undefined
  }
}

/**
 * Host-wide memory service — the single service the bundle registers under the
 * `memory` key. It opens the domain, runs startup recovery through
 * {@link MemoryStore.initialize}, owns the store, maintains the in-memory search
 * index and registers the explicit memory tools. Recall injection and the
 * Settings UI are delivered by later plans.
 */
export class MemoryService extends TypertRemoteService {
  static inject = [
    'agents',
    'tools',
    'commands',
    'workingDirectory',
    'storageDomain',
    'llm',
    'sessionQuery',
    'agentDefaultModel',
    // The Remote descriptor registry; declaring it makes the registration
    // ordering explicit instead of silently skipping a not-yet-provided
    // service and leaving the Client without any endpoint definition.
    'typert',
  ]

  static Config = MemoryConfigSchema

  private store: MemoryStore | undefined
  private domain: Domain<typeof memoryDomain> | undefined
  private searchIndex: SearchIndex | undefined
  private retentionTimer: ReturnType<typeof setInterval> | undefined
  /** Workspace key of the most recent session event; used by the Settings page. */
  private recentWorkspaceKey: string | undefined
  private capture: MemoryCapture | undefined
  private dreamer: MemoryDreamer | undefined
  private scheduler: DreamScheduler | undefined
  private startupReconcile: Promise<BackfillReport> | undefined
  private startupReconcileAbort: AbortController | undefined
  private readonly resolvedConfig: MemoryConfig
  private readonly redactWrites: boolean
  private stopped = false
  private readonly initialized: PromiseLike<unknown>

  constructor(ctx: Context, config?: Partial<MemoryConfig> | null) {
    super(ctx, 'memory')
    const resolved = resolveMemoryConfig(config)
    this.resolvedConfig = resolved
    this.redactWrites = resolved.redactSecrets !== false
    this.registerRemoteContribution()
    if (resolved.enabled === false) {
      this.initialized = Promise.resolve()
      return
    }
    this.initialized = ctx.effect(async () => {
      const domain = await ctx.storageDomain.open(memoryDomain)
      this.domain = domain
      let store: MemoryStore | undefined
      let disposeTools: (() => void) | undefined
      let disposeInject: (() => void) | undefined
      let disposeCapture: (() => void) | undefined
      let disposeCommands: (() => void) | undefined
      let disposeScheduler: (() => void) | undefined
      const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
      try {
        const runner = new OperationRunner(domain, {
          ...(resolved.requestDedupeTtlMs === undefined
            ? {}
            : { requestDedupeTtlMs: resolved.requestDedupeTtlMs }),
          ...(resolved.maxOperationRecords === undefined
            ? {}
            : { maxOperationRecords: resolved.maxOperationRecords }),
          ...(resolved.maxAuditRecords === undefined
            ? {}
            : { maxAuditRecords: resolved.maxAuditRecords }),
        })
        const capacity = new CapacityPolicy({
          maxActiveMemories: resolved.maxActiveMemories ?? 5000,
          maxArchivedMemories: resolved.maxArchivedMemories ?? 20_000,
          maxStoredMemories: resolved.maxStoredMemories ?? 25_000,
          ...(resolved.maxQueuedEpisodes === undefined
            ? {}
            : { maxQueuedEpisodes: resolved.maxQueuedEpisodes }),
        })
        const searchIndex = new SearchIndex({
          defaultLimit: resolved.searchLimit ?? DEFAULT_SEARCH_LIMIT,
        })
        const memoryStore = new MemoryStore(domain, runner, {
          capacity,
          ...(logger === undefined ? {} : { logger }),
          ...(resolved.searchLimit === undefined ? {} : { searchLimit: resolved.searchLimit }),
          ...(resolved.worklogRetentionDays === undefined
            ? {}
            : { worklogRetentionDays: resolved.worklogRetentionDays }),
          ...(resolved.episodeRetentionDays === undefined
            ? {}
            : { episodeRetentionDays: resolved.episodeRetentionDays }),
          ...(resolved.archivePurgePolicy === undefined
            ? {}
            : { archivePurgePolicy: resolved.archivePurgePolicy }),
          ...(resolved.archiveRetentionDays === undefined
            ? {}
            : { archiveRetentionDays: resolved.archiveRetentionDays }),
          onChange: (change) => {
            if (change.action === 'upsert') searchIndex.update(change.record)
            else searchIndex.remove(change.id)
          },
        })
        await memoryStore.initialize()
        await memoryStore.applyRetention()
        const llmService = (ctx as unknown as { llm?: DreamLlm }).llm
        const dreamerOptions: MemoryDreamerOptions = {
          store: memoryStore,
          runner,
          config: resolved,
          resolveSelection: async (request: DreamRequest) => sessionSelection(ctx, request),
          defaultSelection: () => defaultSelectionOf(ctx),
          relatedSearch: (input) => {
            const hits = this.search({
              query: input.query,
              workspaceKey: input.workspaceKey,
              scope: input.scope,
              limit: input.limit,
            }).results
            const records: MemoryRecord[] = []
            for (const hit of hits) {
              try {
                records.push(this.read(hit.id, input.workspaceKey))
              } catch {
                continue
              }
              if (records.length >= input.limit) break
            }
            return records
          },
          ...(llmService === undefined ? {} : { llm: llmService }),
          ...(logger === undefined ? {} : { logger }),
        }
        const dreamer = new MemoryDreamer(dreamerOptions)
        this.dreamer = dreamer
        // Recovery must never block the service from becoming ready.
        try {
          await dreamer.failInterruptedRuns()
        } catch (error) {
          logger?.warn?.(`dsh-memory: failed to finalize interrupted dreams: ${String(error)}`)
        }
        try {
          await dreamer.resumeQueued()
        } catch (error) {
          logger?.warn?.(`dsh-memory: failed to resume queued dreams: ${String(error)}`)
        }
        searchIndex.rebuild(memoryStore.activeRecords())
        this.searchIndex = searchIndex
        this.retentionTimer = setInterval(() => {
          void memoryStore.applyRetention().catch((error: unknown) => {
            logger?.warn?.(`dsh-memory: periodic retention failed: ${String(error)}`)
          })
        }, RETENTION_INTERVAL_MS)
        this.retentionTimer.unref?.()
        store = memoryStore
        this.store = memoryStore
        disposeTools = registerMemoryTools(ctx, this)
        disposeInject = registerIndexInjection(ctx, this, resolved)
        // UI-only projection of memory activity; optional and fiber-owned.
        registerMemoryUsageProjection(ctx)
        const capture = new MemoryCapture({
          store: memoryStore,
          config: resolved,
          ...(logger === undefined ? {} : { logger }),
          onTurnEnd: async (input, record) => {
            await createTurnWorklog(memoryStore, resolved, input, record, logger)
          },
        })
        this.capture = capture
        const offSessionEvent = ctx.on('session/event', (session, event) => {
          const cwd = session.header.cwd
          if (cwd !== undefined && cwd !== '') this.recentWorkspaceKey = normalizeWorkspaceKey(cwd)
          try {
            capture.onSessionEvent(session, event)
          } catch {
            // Capturing must never break a session event.
          }
        })
        const offToolResult = ctx.on('tools/result', (exec, result) => {
          try {
            capture.onToolResult(exec, result)
          } catch {
            // Capturing must never break a tool result.
          }
        })
        disposeCapture = () => {
          offSessionEvent()
          offToolResult()
        }
        disposeCommands = registerMemoryCommands(ctx, this)
        const cursorStore = new DomainSessionCursorStore(domain)
        const sessionQuery = (
          ctx as unknown as {
            sessionQuery?: {
              listSessions?: () => Promise<ColdSessionRecord[]>
              readSession?: (id: string) => Promise<ColdSessionSnapshot>
            }
          }
        ).sessionQuery
        const scheduler = new DreamScheduler({
          dreamer,
          config: resolved,
          cursorStore,
          ...(logger === undefined ? {} : { logger }),
          lastProcessedSeqFor: (sessionId: string) => memoryStore.maxEpisodeSourceSeq(sessionId),
          pendingEpisodeCount: (workspaceKey: string) =>
            memoryStore.episodeList({
              workspaceKey,
              statuses: ['new', 'failed-retryable'],
            }).length,
          workspaceRootFor: (workspaceKey: string) =>
            memoryStore.episodeWorkspaceRoot(workspaceKey),
          isWorkspaceIdle: (workspaceKey: string) => {
            const agents = (ctx as unknown as { agents?: { list?: () => unknown[] } }).agents
            if (agents?.list === undefined) return true
            try {
              return !agents.list().some((candidate) => {
                const agent = candidate as {
                  status?: string
                  session?: { header?: { cwd?: string } }
                }
                const cwd = agent.session?.header?.cwd
                return (
                  cwd !== undefined &&
                  cwd !== '' &&
                  normalizeWorkspaceKey(cwd) === workspaceKey &&
                  agent.status === 'running'
                )
              })
            } catch {
              return true
            }
          },
          isSessionCold: (sessionId: string) => {
            const get = (ctx as unknown as { get?: (name: string) => unknown }).get
            const sessions =
              get === undefined
                ? undefined
                : (get('sessions') as { get?: (id: string) => unknown } | undefined)
            if (sessions?.get !== undefined) {
              try {
                return sessions.get(sessionId) === undefined
              } catch {
                return true
              }
            }
            const agents = (ctx as unknown as { agents?: { list?: () => unknown[] } }).agents
            if (agents?.list === undefined) return true
            try {
              return !agents.list().some((candidate) => {
                const session = (candidate as { session?: { id?: string } }).session
                return session?.id === sessionId
              })
            } catch {
              return true
            }
          },
          resolveAgent: (workspaceKey: string) => {
            const agents = (ctx as unknown as { agents?: { list?: () => unknown[] } }).agents
            if (agents?.list === undefined) return undefined
            try {
              return agents.list().find((candidate) => {
                const cwd = (candidate as { session?: { header?: { cwd?: string } } }).session
                  ?.header?.cwd
                return cwd !== undefined && normalizeWorkspaceKey(cwd) === workspaceKey
              })
            } catch {
              return undefined
            }
          },
          ...(sessionQuery?.listSessions === undefined || sessionQuery?.readSession === undefined
            ? {}
            : {
                coldSource: {
                  listSessions: () => sessionQuery.listSessions!(),
                  readSession: (id: string) => sessionQuery.readSession!(id),
                },
              }),
          ingestSession: async (input) => {
            const before = memoryStore.episodeList({ workspaceKey: input.workspaceKey }).length
            const replay = new MemoryCapture({
              store: memoryStore,
              config: resolved,
              ...(logger === undefined ? {} : { logger }),
            })
            const session = {
              id: input.sessionId,
              header: { cwd: input.workspaceRoot },
            } as unknown as Session
            for (const event of input.events) replay.onSessionEvent(session, event)
            await replay.flush()
            return memoryStore.episodeList({ workspaceKey: input.workspaceKey }).length - before
          },
        })
        this.scheduler = scheduler
        const startupReconcileAbort = new AbortController()
        this.startupReconcileAbort = startupReconcileAbort
        this.startupReconcile = scheduler
          .reconcileRecentSessions(startupReconcileAbort.signal)
          .catch((error: unknown) => {
            logger?.warn?.(`dsh-memory: startup cold session reconcile failed: ${String(error)}`)
            return { sessions: 0, episodes: 0 }
          })
        if (resolved.autoDream === true) {
          const offStart = ctx.on('session/event', (session, event) => {
            if (event.type !== 'turn/start') return
            const cwd = session.header.cwd
            if (cwd === undefined || cwd === '') return
            const workspaceKey = normalizeWorkspaceKey(cwd)
            scheduler.onTurnStart(workspaceKey)
            // Cold backfill is part of autoDream, not a separate opt-in: it
            // catches sessions that ended while the plugin was not running.
            void scheduler.backfillColdSessions(workspaceKey).catch((error: unknown) => {
              logger?.warn?.(`dsh-memory: cold session backfill failed: ${String(error)}`)
            })
          })
          const offEnd = ctx.on('session/event', (session, event) => {
            if (event.type !== 'turn/end') return
            const cwd = session.header.cwd
            if (cwd !== undefined && cwd !== '')
              scheduler.onTurnEnd(normalizeWorkspaceKey(cwd), cwd)
          })
          disposeScheduler = () => {
            offStart()
            offEnd()
          }
        }
      } catch (error) {
        if (this.retentionTimer !== undefined) {
          clearInterval(this.retentionTimer)
          this.retentionTimer = undefined
        }
        this.startupReconcileAbort?.abort()
        this.startupReconcileAbort = undefined
        disposeScheduler?.()
        disposeCommands?.()
        disposeCapture?.()
        disposeInject?.()
        disposeTools?.()
        this.capture = undefined
        this.scheduler = undefined
        this.dreamer = undefined
        this.searchIndex = undefined
        store?.stop()
        this.store = undefined
        this.domain = undefined
        await domain.close()
        throw error
      }
      return async () => {
        // Stop accepting new external work immediately, drain in-flight
        // capture/dream work, then release the store and backend unit.
        this.stopped = true
        if (this.retentionTimer !== undefined) {
          clearInterval(this.retentionTimer)
          this.retentionTimer = undefined
        }
        disposeCommands?.()
        disposeInject?.()
        disposeTools?.()
        disposeScheduler?.()
        this.startupReconcileAbort?.abort()
        this.startupReconcileAbort = undefined
        // Stop accepting session events, then drain the capture queue: a write
        // that is already queued must land before the store closes, otherwise
        // shutdown silently loses the last captured episode.
        const capture = this.capture
        disposeCapture?.()
        this.capture = undefined
        await settleWithin(capture?.flush(), STARTUP_RECONCILE_DISPOSE_WAIT_MS)
        // Resumed dreams are not in scheduler.activeDreamIds; cancel every
        // queued/running run before asking the scheduler to drain, so a model
        // call that ignores its abort signal cannot hang unload.
        const activeDreamer = this.dreamer
        if (activeDreamer !== undefined) {
          for (const run of activeDreamer.status()) {
            if (run.status !== 'queued' && run.status !== 'running') continue
            try {
              await activeDreamer.cancel(run.id)
            } catch (error) {
              logger?.warn?.(`dsh-memory: failed to cancel dream ${run.id}: ${String(error)}`)
            }
          }
        }
        await settleWithin(this.scheduler?.dispose(), STARTUP_RECONCILE_DISPOSE_WAIT_MS)
        await settleWithin(this.startupReconcile, STARTUP_RECONCILE_DISPOSE_WAIT_MS)
        this.startupReconcile = undefined
        this.scheduler = undefined
        this.dreamer = undefined
        this.searchIndex = undefined
        store?.stop()
        await store?.flush()
        await domain.close()
      }
    })
  }

  /**
   * Register the management endpoints as strict Typert definitions.
   *
   * The plugin ships no generator-produced `/remote` artifact, so without this
   * the Gateway only sees conservative source-mode markers and cannot safely
   * dispatch the management calls (nor may it claim endpoints derived from
   * defaulted signatures). Registering the same descriptors the Client mounts
   * gives the Gateway an exact definition, exact argument names and the correct
   * Host implementation member for each endpoint.
   */
  private registerRemoteContribution(): void {
    const ctx = this.ctx as unknown as {
      get?: (name: string) => unknown
      effect?: (callback: () => unknown) => unknown
    }
    let typert: unknown
    try {
      typert = typeof ctx.get === 'function' ? ctx.get('typert') : undefined
    } catch {
      return
    }
    if (typert === undefined || typert === null) return
    const register = (typert as { register?: (contribution: unknown) => unknown }).register
    if (typeof register !== 'function') return
    const contribution = {
      package: 'dsh-memory',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: MEMORY_REMOTE.descriptors,
    }
    const install = (): unknown => register.call(typert, contribution)
    try {
      if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    } catch {
      // A missing or rejecting registry must never stop the memory service from
      // starting; the Settings page then reports the call failure it observes.
    }
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Readiness and counters for the Settings surface.
   * @returns Whether recovery finished, current counts, and the last recovery report.
   */
  status(): MemoryStatusSnapshot {
    if (this.stopped) {
      return { ready: false, counts: EMPTY_COUNTS, dreamQueue: { paused: false } }
    }
    const store = this.store
    return {
      ready: store !== undefined && store.isReady,
      counts: store?.counts() ?? EMPTY_COUNTS,
      ...(store?.lastRecovery === undefined ? {} : { lastRecovery: store.lastRecovery }),
      dreamQueue: this.dreamQueueState(),
    }
  }

  private requireStore(): MemoryStore {
    if (this.stopped) {
      throw new OperationError('MEMORY_STOPPED', 'memory service is stopping')
    }
    const store = this.store
    if (store === undefined || !store.isReady) {
      throw new OperationError('MEMORY_RECOVERING', 'memory service is not ready')
    }
    return store
  }

  private requireDomain() {
    if (this.stopped) {
      throw new OperationError('MEMORY_STOPPED', 'memory service is stopping')
    }
    const domain = this.domain
    if (domain === undefined) {
      throw new OperationError('MEMORY_RECOVERING', 'memory service is not ready')
    }
    return domain
  }

  /** Reject null or non-object RPC payloads as `MEMORY_INVALID_CONTENT` instead of `TypeError`. */
  private requireObject<T extends object>(value: unknown, label: string): T {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationError('MEMORY_INVALID_CONTENT', `${label} must be an object`)
    }
    return value as T
  }

  /** Redact one user-supplied text field before persistence when redaction is on. */
  private redactValue(value: string): string {
    return this.redactWrites ? redactSecrets(value) : value
  }

  /** Resolve a Remote create/update scope from the client-supplied selectors. */
  private remoteScope(input: {
    type: MemoryType
    scope?: 'workspace' | 'global'
    workspaceKey?: string
    workspaceRoot?: string
  }): MemoryScope {
    const desired = input.scope ?? 'workspace'
    if (desired === 'global') {
      if (input.type !== 'preference') {
        throw new OperationError('MEMORY_FORBIDDEN_SCOPE', 'only preference memories may be global')
      }
      return { kind: 'global' }
    }
    if (
      input.workspaceKey === undefined ||
      input.workspaceKey === '' ||
      input.workspaceRoot === undefined ||
      input.workspaceRoot === ''
    ) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'a workspace memory requires workspaceKey and workspaceRoot',
      )
    }
    return { kind: 'workspace', key: input.workspaceKey, root: input.workspaceRoot }
  }

  /**
   * Notify the Settings page that memory state changed (forwarded to the Client).
   */
  private emitChanged(): void {
    try {
      const emit = (this.ctx as unknown as { emit?: (name: string, payload?: unknown) => void })
        .emit
      emit?.call(this.ctx, 'memory/changed', { at: new Date().toISOString() })
    } catch {
      // A listener must never break a completed management mutation.
    }
  }

  /**
   * Workspace key of the most recent session event.
   *
   * The Settings page has no session context of its own; this hint is more
   * reliable than the workspace registry's `updatedAt`. Null before any session
   * event has been observed.
   */
  async activeWorkspace(): Promise<string | null> {
    return this.recentWorkspaceKey ?? null
  }

  /**
   * Counts, pending-review count, latest dream and index footprint for one
   * workspace selector. `workspaceKey` is explicit; this never silently spans
   * every workspace unless the caller passes `'all'`.
   */
  async overview(request: { workspaceKey: string | 'all' | null }): Promise<MemoryOverview> {
    const req = this.requireObject<{ workspaceKey: string | 'all' | null }>(request, 'request')
    const store = this.requireStore()
    const workspaceKey = req.workspaceKey
    const counts = store.scopedCounts(workspaceKey)
    const visibleActive = store.activeRecords().filter((record) => {
      if (workspaceKey === 'all') return true
      if (record.scope.kind === 'global') return true
      return workspaceKey !== null && record.scope.key === workspaceKey
    })
    const bytes = visibleActive.reduce(
      (total, record) => total + Buffer.byteLength(`${record.title}${record.body}`, 'utf8'),
      0,
    )
    return {
      workspaceKey,
      counts,
      pendingReview: counts.pending,
      recentDream: store.dreamList(1)[0] ?? null,
      index: { entries: visibleActive.length, bytes },
    }
  }

  /**
   * Management list used by the Settings page. Unlike the model-facing tools it
   * explicitly allows `workspaceKey: 'all'`.
   */
  remoteList(request: ListRequest = {}): ListResult {
    const req =
      request === undefined ? {} : this.requireObject<ListRequest>(request, 'list request')
    return this.requireStore().list({ ...req, management: true })
  }

  /** Read one memory in full plus its source session references. */
  view(request: { id: string }): { record: MemoryRecord; sources: MemorySourceRef[] } {
    const req = this.requireObject<{ id: string }>(request, 'view request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memory id must be a non-empty string')
    }
    const store = this.requireStore()
    const record = store.get(MemoryId(req.id))
    if (record === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${req.id}' not found`)
    }
    return { record, sources: structuredClone(record.sourceRefs) }
  }

  /** Create one user-owned memory from the Settings page. */
  async create(input: RemoteCreateInput): Promise<MemoryRecord> {
    const req = this.requireObject<RemoteCreateInput>(input, 'create request')
    if (typeof req.title !== 'string' || typeof req.body !== 'string') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'title and body must be strings')
    }
    const store = this.requireStore()
    const scope = this.remoteScope(req)
    const title = this.redactValue(req.title)
    const body = this.redactValue(req.body)
    const tags = req.tags?.map((tag) => this.redactValue(tag))
    const created = await store.create({
      type: req.type,
      title,
      body,
      scope,
      ...(tags === undefined ? {} : { tags }),
      ...(req.importance === undefined ? {} : { importance: req.importance }),
      ...(req.confidence === undefined ? {} : { confidence: req.confidence }),
      ...(req.pinned === undefined ? {} : { pinned: req.pinned }),
      status: req.status ?? 'active',
      origin: 'user',
      ownership: 'user',
      actor: 'user',
    })
    this.emitChanged()
    return created
  }

  /**
   * Update one memory with optimistic concurrency. A user edit marks the record
   * user-owned and reviewed so a later rebuild never removes it.
   */
  async update(input: RemoteUpdateInput): Promise<MemoryRecord> {
    const req = this.requireObject<RemoteUpdateInput>(input, 'update request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memory id must be a non-empty string')
    }
    const store = this.requireStore()
    const current = store.get(MemoryId(req.id))
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${req.id}' not found`)
    }
    const nextType = req.type ?? current.type
    const scope =
      req.scope === undefined
        ? undefined
        : this.remoteScope({
            type: nextType,
            scope: req.scope,
            ...(req.workspaceKey === undefined ? {} : { workspaceKey: req.workspaceKey }),
            ...(req.workspaceRoot === undefined ? {} : { workspaceRoot: req.workspaceRoot }),
          })
    const tags = req.tags?.map((tag) => this.redactValue(tag))
    const updated = await store.update(current.id, {
      expectedContentRevision: req.expectedContentRevision,
      ...(req.type === undefined ? {} : { type: req.type }),
      ...(req.title === undefined ? {} : { title: this.redactValue(req.title) }),
      ...(req.body === undefined ? {} : { body: this.redactValue(req.body) }),
      ...(tags === undefined ? {} : { tags }),
      ...(req.importance === undefined ? {} : { importance: req.importance }),
      ...(req.confidence === undefined ? {} : { confidence: req.confidence }),
      ...(req.pinned === undefined ? {} : { pinned: req.pinned }),
      ...(req.status === undefined ? {} : { status: req.status }),
      ...(scope === undefined ? {} : { scope }),
      markReviewed: true,
      actor: 'user',
    })
    this.emitChanged()
    return updated
  }

  /**
   * Delete one memory: soft (archive) by default. Permanent deletion is a
   * confirmed user action only; an `actor: 'model'` request is refused even
   * when it claims `confirm: true`.
   */
  async delete(
    request: RemoteDeleteRequest,
  ): Promise<{ deleted: boolean; record: MemoryRecord | null }> {
    const req = this.requireObject<RemoteDeleteRequest>(request, 'delete request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memory id must be a non-empty string')
    }
    const store = this.requireStore()
    const id = MemoryId(req.id)
    const current = store.get(id)
    if (current === undefined) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${req.id}' not found`)
    }
    if (req.permanent === true) {
      if (req.actor === 'model') {
        throw new OperationError(
          'MEMORY_FORBIDDEN',
          'permanent delete is unavailable to model actors',
        )
      }
      if (req.actor !== 'user' || req.confirm !== true) {
        throw new OperationError(
          'MEMORY_CONFIRM_REQUIRED',
          'permanent delete requires a confirmed user action',
        )
      }
      await store.delete(id, { permanent: true, actor: 'user', confirm: true })
      this.emitChanged()
      return { deleted: true, record: null }
    }
    const record = await store.delete(id, { actor: 'user' })
    this.emitChanged()
    return { deleted: false, record }
  }

  /** Restore one archived memory to `active` from the Settings page. */
  async remoteRestore(request: { id: string }): Promise<MemoryRecord> {
    const req = this.requireObject<{ id: string }>(request, 'restore request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memory id must be a non-empty string')
    }
    const restored = await this.requireStore().restore(MemoryId(req.id), { actor: 'user' })
    this.emitChanged()
    return restored
  }

  /** Accept or reject one pending proposal. */
  async review(request: RemoteReviewRequest): Promise<MemoryRecord> {
    const req = this.requireObject<RemoteReviewRequest>(request, 'review request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'memory id must be a non-empty string')
    }
    const store = this.requireStore()
    const id = MemoryId(req.id)
    let result: MemoryRecord
    if (req.action === 'accept') {
      result = await store.acceptProposal(id)
    } else if (req.action === 'reject') {
      result = await store.rejectProposal(id)
    } else {
      throw new OperationError(
        'MEMORY_INVALID_QUERY',
        `unknown review action '${String(req.action)}'`,
      )
    }
    this.emitChanged()
    return result
  }

  /** Queue one manual dream for a workspace or the global preference scope. */
  async dream(request: RemoteDreamRequest): Promise<DreamRun> {
    const req = this.requireObject<RemoteDreamRequest>(request, 'dream request')
    if (req.scope === 'global') {
      const run = await this.enqueueDream({
        scope: 'global',
        workspace: null,
        ...(req.maxEpisodes === undefined ? {} : { maxEpisodes: req.maxEpisodes }),
        ...(req.since === undefined ? {} : { since: req.since }),
      })
      this.emitChanged()
      return run
    }
    if (
      req.workspaceKey === undefined ||
      req.workspaceKey === '' ||
      req.workspaceRoot === undefined ||
      req.workspaceRoot === ''
    ) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'a workspace dream requires workspaceKey and workspaceRoot',
      )
    }
    const run = await this.enqueueDream({
      scope: 'workspace',
      workspace: { key: req.workspaceKey, root: req.workspaceRoot },
      ...(req.maxEpisodes === undefined ? {} : { maxEpisodes: req.maxEpisodes }),
      ...(req.since === undefined ? {} : { since: req.since }),
    })
    this.emitChanged()
    return run
  }

  /** Latest dream run with its model, reasoning effort, tokens and error. */
  dreamStatus(): DreamRun | null {
    return this.requireStore().dreamList(1)[0] ?? null
  }

  /**
   * Read-only, process-local automatic dream queue state for Settings and
   * `/memory status`. Nothing here is persisted; a restart resets it.
   */
  dreamQueueState(): DreamQueueState {
    return this.dreamer?.dreamQueueState() ?? { paused: false }
  }

  /** Cancel one queued or running dream. */
  async remoteCancelDream(request: { id: string }): Promise<boolean> {
    const req = this.requireObject<{ id: string }>(request, 'cancelDream request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'dream id must be a non-empty string')
    }
    return this.cancelDream(req.id)
  }

  /** Undo every dream-committed change of one run (Remote management entry). */
  async remoteUndoDream(request: { id: string }): Promise<DreamUndoReport> {
    const req = this.requireObject<{ id: string }>(request, 'undoDream request')
    if (typeof req.id !== 'string' || req.id === '') {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'dream id must be a non-empty string')
    }
    return this.undoDream(req.id)
  }

  /**
   * Build an export payload for one scope (no file I/O) and apply the
   * `after-export` archive purge to that same scope once the payload exists.
   */
  async remoteExport(request: {
    scope: ExportScope
    includeArchived?: boolean
  }): Promise<MemoryExport> {
    const req = this.requireObject<{ scope: ExportScope; includeArchived?: boolean }>(
      request,
      'export request',
    )
    const exported = exportMemories(this.requireDomain(), {
      scope: req.scope,
      ...(req.includeArchived === undefined ? {} : { includeArchived: req.includeArchived }),
    })
    await this.requireStore().purgeArchivedAfterExport(req.scope)
    return exported
  }

  /** Import an export payload from the Settings page. */
  async remoteImport(request: {
    payload: MemoryExport
    options?: ImportOptions
  }): Promise<ImportReport> {
    const req = this.requireObject<{ payload: MemoryExport; options?: ImportOptions }>(
      request,
      'import request',
    )
    const store = this.requireStore()
    const options: ImportOptions = {
      ...(req.options ?? {}),
      redactSecrets: req.options?.redactSecrets ?? this.redactWrites,
    }
    try {
      const report = await importMemories(store, this.requireDomain(), req.payload, options)
      this.emitChanged()
      return report
    } finally {
      this.searchIndex?.rebuild(store.activeRecords())
    }
  }

  /**
   * Delete and rebuild derived memories for one scope (confirmed user action).
   *
   * The reset deletes derived records and clears the scope's episodes and
   * session cursors; the scope's cold sessions are then re-captured within
   * `rebuildLookbackDays` (or `since`) and a `rebuild` dream is enqueued when
   * anything was captured. Replay needs session history: without a
   * `sessionQuery` cold source the reset still completes and reports zero
   * replayed rows.
   */
  async rebuild(request: RebuildRequest): Promise<RebuildReport> {
    const req = this.requireObject<RebuildRequest>(request, 'rebuild request')
    const store = this.requireStore()
    const workspaceKeys = this.rebuildWorkspaceKeys(req.scope)
    const report = await rebuildMemories(
      this.requireDomain(),
      store.operationRunner,
      req,
      () => new Date(),
      (work) => store.runSerialized(work),
    )
    this.searchIndex?.rebuild(store.activeRecords())
    this.emitChanged()
    const replayed = await this.replayRebuiltScope(workspaceKeys, req.since)
    return {
      ...report,
      replayedSessions: replayed.sessions,
      replayedEpisodes: replayed.episodes,
    }
  }

  /** Workspace keys a rebuild of one scope should replay. */
  private rebuildWorkspaceKeys(scope: ExportScope): string[] {
    if (scope === 'global') return []
    if (scope !== 'all') return [scope.workspaceKey]
    const keys = new Set<string>()
    for (const [, record] of this.requireDomain().table('memories').entries()) {
      if (record.scope.kind === 'workspace') keys.add(record.scope.key)
    }
    for (const [, episode] of this.requireDomain().table('episodes').entries()) {
      keys.add(episode.workspaceKey)
    }
    return [...keys]
  }

  /** Re-capture recent cold sessions for rebuilt workspaces and queue a dream. */
  private async replayRebuiltScope(
    workspaceKeys: readonly string[],
    since: string | undefined,
  ): Promise<BackfillReport> {
    const scheduler = this.scheduler
    const total: BackfillReport = { sessions: 0, episodes: 0 }
    if (scheduler === undefined) return total
    const lookbackDays =
      since === undefined
        ? (this.resolvedConfig.rebuildLookbackDays ?? 90)
        : Math.max(0, Math.ceil((Date.now() - Date.parse(since)) / 86_400_000))
    for (const key of workspaceKeys) {
      try {
        const pass = await scheduler.backfillColdSessions(key, {
          force: true,
          includePendingEpisodes: true,
          lookbackDays,
          trigger: 'rebuild',
        })
        total.sessions += pass.sessions
        total.episodes += pass.episodes
      } catch (error) {
        const logger = (this.ctx as unknown as { logger?: { warn?: (message: string) => void } })
          .logger
        logger?.warn?.(`dsh-memory: rebuild replay failed for ${key}: ${String(error)}`)
      }
    }
    return total
  }

  /** Clear one scope after an exact confirmation phrase (confirmed user action). */
  async purgeAll(request: PurgeRequest): Promise<PurgeReport> {
    const req = this.requireObject<PurgeRequest>(request, 'purgeAll request')
    const store = this.requireStore()
    const report = await purgeAllMemories(
      this.requireDomain(),
      store.operationRunner,
      req,
      () => new Date(),
      (work) => store.runSerialized(work),
    )
    this.searchIndex?.rebuild(store.activeRecords())
    this.emitChanged()
    return report
  }

  private configEditorService():
    | {
        configuration?: () => Array<{
          entry: unknown
          inherited: Record<string, unknown>
          override: Record<string, unknown>
        }>
        edit?: (
          entry: unknown,
          change: (
            current: Record<string, unknown>,
            inherited: Record<string, unknown>,
          ) => Record<string, unknown>,
        ) => Promise<void>
      }
    | undefined {
    const ctx = this.ctx as unknown as { get?: (name: string) => unknown }
    try {
      const service = ctx.get?.('configEditor')
      return service as
        | {
            configuration?: () => Array<{
              entry: unknown
              inherited: Record<string, unknown>
              override: Record<string, unknown>
            }>
            edit?: (
              entry: unknown,
              change: (
                current: Record<string, unknown>,
                inherited: Record<string, unknown>,
              ) => Record<string, unknown>,
            ) => Promise<void>
          }
        | undefined
    } catch {
      return undefined
    }
  }

  private configEntry(): unknown {
    try {
      return (this.ctx as unknown as { fiber?: { entry?: unknown } }).fiber?.entry
    } catch {
      return undefined
    }
  }

  /** Current plugin configuration, read from the Loader entry when available. */
  getConfig(): MemoryConfig {
    const editor = this.configEditorService()
    const entry = this.configEntry()
    if (editor?.configuration !== undefined && entry !== undefined) {
      try {
        const rows = editor.configuration()
        const row = rows.find(
          (candidate) =>
            candidate.entry === entry ||
            (candidate.entry as { id?: string } | undefined)?.id ===
              (entry as { id?: string } | undefined)?.id,
        )
        if (row !== undefined) {
          return resolveMemoryConfig({ ...row.inherited, ...row.override })
        }
      } catch {
        // Fall back to the config resolved at construction time.
      }
    }
    return { ...this.resolvedConfig }
  }

  /**
   * Providers and their advertised models, for the dream-model picker.
   *
   * The management page runs outside any Session, so it cannot use the
   * per-session model directory; it reads the Host `llm` adapter registry
   * instead. A provider whose catalog read fails contributes an empty list
   * rather than failing the whole page.
   */
  async modelCatalog(): Promise<{
    providers: Array<{ id: string; name: string }>
    models: Record<string, Array<{ id: string; name: string }>>
    defaultSelection?: { provider: string; model: string; reasoningEffort?: string }
  }> {
    const llm = (
      this.ctx as unknown as {
        llm?: {
          listProviders?: () => Array<{ id: string; name: string }>
          listModels?: (provider: string) => Promise<Array<{ id: string; name?: string }>>
        }
      }
    ).llm
    const defaultSelection = (() => {
      const service = (
        this.ctx as unknown as {
          agentDefaultModel?: {
            currentSelection?: () => {
              provider: string
              model: string
              reasoningEffort?: string
            }
          }
        }
      ).agentDefaultModel
      try {
        const selection = service?.currentSelection?.()
        if (selection === undefined) return undefined
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.reasoningEffort }),
        }
      } catch {
        return undefined
      }
    })()
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      return {
        providers: [],
        models: {},
        ...(defaultSelection === undefined ? {} : { defaultSelection }),
      }
    }
    const providers = llm.listProviders().map((provider) => ({
      id: provider.id,
      name: provider.name === '' ? provider.id : provider.name,
    }))
    const models: Record<string, Array<{ id: string; name: string }>> = {}
    await Promise.all(
      providers.map(async (provider) => {
        if (typeof llm.listModels !== 'function') {
          models[provider.id] = []
          return
        }
        try {
          const list = await llm.listModels(provider.id)
          models[provider.id] = list.map((model) => ({
            id: model.id,
            name: model.name === undefined || model.name === '' ? model.id : model.name,
          }))
        } catch {
          models[provider.id] = []
        }
      }),
    )
    return { providers, models, ...(defaultSelection === undefined ? {} : { defaultSelection }) }
  }

  /**
   * Reasoning efforts advertised by one exact provider/model route.
   *
   * Resolved lazily when the user picks a model, because adapter-side metadata
   * lookup can be slower than listing the catalog. An unknown route or an
   * adapter without reasoning metadata yields an empty list, letting the page
   * fall back to the free-text effort field.
   */
  async modelEfforts(request: {
    provider: string
    model: string
  }): Promise<{ efforts: Array<{ id: string; name: string }>; defaultEffort?: string }> {
    const req = this.requireObject<{ provider: string; model: string }>(
      request,
      'modelEfforts request',
    )
    const llm = (
      this.ctx as unknown as {
        llm?: {
          resolveModelInfo?: (
            provider: string,
            model: string,
          ) => Promise<{
            reasoning?: {
              efforts: Array<{ id: string; name: string }>
              defaultEffort?: string
            }
          }>
        }
      }
    ).llm
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return { efforts: [] }
    try {
      const info = await llm.resolveModelInfo(req.provider, req.model)
      const efforts = (info.reasoning?.efforts ?? []).map((effort) => ({
        id: effort.id,
        name: effort.name === undefined || effort.name === '' ? effort.id : effort.name,
      }))
      const { defaultEffort } = info.reasoning ?? {}
      return {
        efforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
      }
    } catch {
      return { efforts: [] }
    }
  }

  /**
   * Persist a Settings configuration patch through the Loader's config editor.
   * Only design §8 fields exposed in 0.1.0 are writable, and a fixed dream model
   * mode must name both its provider and model.
   */
  async updateConfig(
    request: Partial<MemoryConfig>,
  ): Promise<{ restartRequired: boolean; config: MemoryConfig }> {
    const patch =
      request === undefined
        ? {}
        : this.requireObject<Partial<MemoryConfig>>(request, 'config patch')
    const editable = new Set<string>(EDITABLE_CONFIG_FIELDS)
    const unknown = Object.keys(patch).filter((key) => !editable.has(key))
    if (unknown.length > 0) {
      throw new OperationError(
        'MEMORY_INVALID_CONFIG',
        `config field(s) not editable from Settings: ${unknown.join(', ')}`,
      )
    }
    const current = this.getConfig()
    const merged = { ...current, ...patch }
    if (
      merged.dreamModelMode === 'fixed' &&
      (merged.dreamProvider === undefined ||
        merged.dreamProvider === '' ||
        merged.dreamModel === undefined ||
        merged.dreamModel === '')
    ) {
      throw new OperationError(
        'MEMORY_INVALID_CONFIG',
        'dreamModelMode "fixed" requires both dreamProvider and dreamModel',
      )
    }
    try {
      resolveMemoryConfig(merged)
    } catch (error) {
      throw new OperationError(
        'MEMORY_INVALID_CONFIG',
        error instanceof Error ? error.message : String(error),
      )
    }
    const editor = this.configEditorService()
    const entry = this.configEntry()
    if (editor?.edit === undefined || entry === undefined) {
      throw new OperationError(
        'MEMORY_INVALID_CONFIG',
        'configuration editor is unavailable in this runtime',
      )
    }
    await editor.edit(entry, (currentRaw) => ({ ...currentRaw, ...patch }))
    this.emitChanged()
    return { restartRequired: true, config: merged }
  }

  /**
   * Rank active memories for one request. Statistics are not touched here; the
   * calling surface decides whether a hit counts as a match or a use.
   * @param request - Query, scope, filters and clock.
   * @returns The ranked page plus totals.
   */
  search(request: SearchRequest): SearchResult {
    this.requireStore()
    const index = this.searchIndex
    if (index === undefined) return { results: [], total: 0, truncated: false }
    return index.search(request)
  }

  /**
   * List every active record visible in one workspace, unwrapped and unpaged.
   *
   * Used by the recall indexer, which needs the complete high-priority and
   * recent-work candidate set rather than one page. Global records are limited
   * to preferences (the only legal global type), mirroring the search index.
   * @param workspaceKey - Caller's workspace key, or null for global-only.
   * @returns Cloned active visible records.
   */
  activeInScope(workspaceKey: string | null): MemoryRecord[] {
    return this.requireStore()
      .activeRecords()
      .filter((record) => isRecordVisible(record, workspaceKey))
      .filter((record) => record.scope.kind !== 'global' || record.type === 'preference')
      .map((record) => structuredClone(record))
  }

  /**
   * List memories visible in one scope (management and injection surfaces).
   * @param request - Workspace selector and filters.
   * @returns The requested page.
   */
  list(request: ListRequest = {}): ListResult {
    return this.requireStore().list(request)
  }

  /**
   * Read one visible memory in full.
   * @param id - Memory identity.
   * @param workspaceKey - Caller's workspace key, or null for global-only.
   * @returns The record.
   * @throws MEMORY_NOT_FOUND when absent or not visible to the caller.
   */
  read(id: string, workspaceKey: string | null): MemoryRecord {
    const store = this.requireStore()
    const record = store.get(MemoryId(id))
    if (record === undefined || !isRecordVisible(record, workspaceKey)) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    return record
  }

  /**
   * Read one memory through the model-facing surface. Archived, pending and
   * expired records remain visible to management APIs but are never recalled
   * by an agent that only holds a stale id.
   * @param id - Memory identity.
   * @param workspaceKey - Caller's workspace key, or null for global-only.
   * @returns The active, unexpired, visible record.
   */
  readForModel(id: string, workspaceKey: string | null): MemoryRecord {
    const record = this.read(id, workspaceKey)
    if (
      record.status !== 'active' ||
      (record.scope.kind === 'global' && record.type !== 'preference')
    ) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    return record
  }

  /**
   * Create or update one memory from an explicit write, redacting secrets first.
   * @param input - Memory fields plus optional expected revision for updates.
   * @param workspace - Caller's workspace identity, or null for global-only.
   * @returns The stored record and the number of redacted text fields.
   */
  async write(
    input: MemoryWriteInput,
    workspace: WorkspaceIdentity | null,
    requestId?: string,
  ): Promise<MemoryWriteResult> {
    const store = this.requireStore()
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
      if (!this.redactWrites) return text
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
    if ([...title].length < 1 || [...title].length > MAX_TITLE_LENGTH) {
      throw new OperationError(
        'MEMORY_INVALID_CONTENT',
        `title must be 1-${MAX_TITLE_LENGTH} characters`,
      )
    }
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes < 1 || bodyBytes > MAX_BODY_BYTES) {
      throw new OperationError('MEMORY_INVALID_CONTENT', `body must be 1-${MAX_BODY_BYTES} bytes`)
    }
    if (
      input.importance !== undefined &&
      (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)
    ) {
      throw new OperationError('MEMORY_INVALID_CONTENT', 'importance must be between 0 and 1')
    }
    if (input.id !== undefined) {
      const id = MemoryId(input.id)
      const current = store.get(id)
      if (current === undefined || !isRecordVisible(current, workspace?.key ?? null)) {
        throw new OperationError('MEMORY_NOT_FOUND', `memory '${input.id}' not found`)
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
      if (nextScope !== undefined && !sameScope(nextScope, current.scope)) {
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
      const next = await store.update(id, patch, requestId)
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
    return store.runBatch(async (batch) => {
      if (requestId !== undefined) {
        const replayed = await batch.findRequest(requestId)
        if (replayed !== undefined) {
          const record = await batch.create(createInput, requestId)
          return { record, redactions }
        }
      }
      const existing = batch.findActiveByTitle(scope, input.type, title)
      if (existing !== undefined) {
        // Keep explicit writes idempotent: the same scope/type/title is already a
        // user-owned active record, so return it instead of creating a twin. A
        // caller that really wants to change it must pass the id and revision.
        return { record: existing, redactions, duplicate: true }
      }
      const created = await batch.create(createInput, requestId)
      return { record: created, redactions }
    })
  }

  /**
   * Soft-forget one visible memory by archiving it.
   * @param id - Memory identity.
   * @param workspaceKey - Caller's workspace key, or null for global-only.
   * @param reason - Optional reason retained on the audit record.
   * @returns The archived record.
   * @throws MEMORY_NOT_FOUND when absent or not visible to the caller.
   */
  async forget(
    id: string,
    workspaceKey: string | null,
    reason?: string,
    requestId?: string,
  ): Promise<MemoryRecord> {
    const store = this.requireStore()
    const record = store.get(MemoryId(id))
    if (record === undefined || !isRecordVisible(record, workspaceKey)) {
      throw new OperationError('MEMORY_NOT_FOUND', `memory '${id}' not found`)
    }
    const rawReason = reason?.trim()
    const safeReason =
      rawReason === undefined || rawReason === ''
        ? undefined
        : this.redactWrites
          ? redactSecrets(rawReason)
          : rawReason
    return store.archive(record.id, {
      actor: 'model',
      ...(safeReason === undefined ? {} : { reason: safeReason }),
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  /**
   * Restore an archived memory to `active` (Host management entry). Marks the
   * record user-owned. The Remote layer added by a later plan must authenticate
   * the user-management channel before calling this method.
   * @param id - Memory identity.
   * @returns The restored record.
   */
  async restore(id: string): Promise<MemoryRecord> {
    return this.requireStore().restore(MemoryId(id), { actor: 'user' })
  }

  /**
   * Record one search hit (statistics only) for a tool result.
   * @param id - Memory identity.
   * @returns The updated record, or undefined when absent.
   */
  async recordMatch(id: string): Promise<MemoryRecord | undefined> {
    return this.requireStore().recordMatch(MemoryId(id))
  }

  /**
   * Record one full read (statistics only) for a tool result.
   * @param id - Memory identity.
   * @returns The updated record, or undefined when absent.
   */
  async recordUse(id: string): Promise<MemoryRecord | undefined> {
    return this.requireStore().recordUse(MemoryId(id))
  }

  /** Enqueue a manual dream for one scope (workspace or global preferences). */
  async enqueueDream(input: {
    scope: 'workspace' | 'global'
    workspace?: WorkspaceIdentity | null
    maxEpisodes?: number
    since?: string
    trigger?: 'manual' | 'auto' | 'rebuild' | 'organize'
    agent?: unknown
  }): Promise<DreamRun> {
    if (this.stopped) {
      throw new OperationError('MEMORY_STOPPED', 'memory service is stopping')
    }
    const dreamer = this.dreamer
    if (dreamer === undefined) {
      throw new OperationError('MEMORY_RECOVERING', 'memory service is not ready')
    }
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
    const trigger = input.trigger ?? 'manual'
    if (input.scope === 'global') {
      return dreamer.enqueue({
        scopeKey: 'global',
        scopeKind: 'global',
        trigger,
        ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
        ...(input.maxEpisodes === undefined ? {} : { maxEpisodes: input.maxEpisodes }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      })
    }
    const workspace = input.workspace
    if (workspace === undefined || workspace === null) {
      throw new OperationError(
        'MEMORY_FORBIDDEN_SCOPE',
        'a workspace dream requires a working directory',
      )
    }
    return dreamer.enqueue({
      scopeKey: workspace.key,
      scopeKind: 'workspace',
      scopeRoot: workspace.root,
      trigger,
      ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
      ...(input.maxEpisodes === undefined ? {} : { maxEpisodes: input.maxEpisodes }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    })
  }

  /** List dream runs newest first. */
  dreamRuns(): DreamRun[] {
    return this.dreamer?.status() ?? []
  }

  /** Cancel one queued or running dream. */
  async cancelDream(id: string): Promise<boolean> {
    return (await this.dreamer?.cancel(id)) ?? false
  }

  /** Undo every dream-committed change recorded for one dream run. */
  async undoDream(id: string): Promise<DreamUndoReport> {
    const store = this.requireStore()
    // Undo writes domain rows directly, so run it inside the store's write
    // queue to keep concurrent business writes out of the same rows.
    const report = await store.runSerialized(() => store.operationRunner.undoDream(id))
    // Rebuild the derived index from the current truth: no change notification
    // fires for these writes.
    this.searchIndex?.rebuild(store.activeRecords())
    this.emitChanged()
    return report
  }

  /** Build an export payload for one scope (no file I/O). */
  exportSnapshot(scope: ExportScope): MemoryExport {
    const domain = this.domain
    if (domain === undefined) {
      throw new OperationError('MEMORY_RECOVERING', 'memory service is not ready')
    }
    return exportMemories(domain, { scope })
  }

  /** Wait for queued business, capture and dream writes to settle (test and shutdown support). */
  async flush(): Promise<void> {
    await this.capture?.flush()
    await this.startupReconcile?.catch(() => {})
    await this.dreamer?.flush()
    await this.requireStore().flush()
  }
}

/**
 * Remote endpoints exposed to the Settings Client under the `memory` namespace.
 * Kept as data so markers can be attached without class-decorator syntax: the
 * project's esbuild-based test transform cannot lower TypeScript 5 standard
 * decorators, while `Remote` itself still owns the marker wire format.
 */
const REMOTE_METHOD_SPECS: ReadonlyArray<{ method: string; exportName?: string }> = [
  { method: 'overview' },
  { method: 'activeWorkspace' },
  { method: 'remoteList', exportName: 'list' },
  { method: 'view' },
  { method: 'create' },
  { method: 'update' },
  { method: 'delete' },
  { method: 'remoteRestore', exportName: 'restore' },
  { method: 'review' },
  { method: 'dream' },
  { method: 'dreamStatus' },
  { method: 'remoteUndoDream', exportName: 'undoDream' },
  { method: 'remoteCancelDream', exportName: 'cancelDream' },
  { method: 'remoteExport', exportName: 'export' },
  { method: 'remoteImport', exportName: 'import' },
  { method: 'rebuild' },
  { method: 'purgeAll' },
  { method: 'getConfig' },
  { method: 'updateConfig' },
  { method: 'modelCatalog' },
  { method: 'modelEfforts' },
]

/**
 * Attach the Typert `Remote` markers for one class by invoking the official
 * decorator against a detached instance, so the marker record is identical to
 * the decorated form.
 */
function attachRemoteMarkers(
  target: { prototype: object },
  specs: ReadonlyArray<{ method: string; exportName?: string }>,
): void {
  for (const spec of specs) {
    const prototype = target.prototype
    const methodFn = (prototype as Record<string, unknown>)[spec.method]
    if (typeof methodFn !== 'function') continue
    const decorator = spec.exportName === undefined ? Remote : Remote(spec.exportName)
    const instance = Object.create(prototype) as object
    ;(decorator as unknown as (method: unknown, context: unknown) => void)(methodFn, {
      private: false,
      static: false,
      name: spec.method,
      addInitializer(initializer: (this: unknown) => void) {
        initializer.call(instance)
      },
    })
  }
}

attachRemoteMarkers(MemoryService, REMOTE_METHOD_SPECS)
wrapRemoteBusinessErrors(
  MemoryService.prototype as unknown as Record<string, unknown>,
  REMOTE_METHOD_SPECS.map((spec) => spec.method),
)

export default MemoryService
