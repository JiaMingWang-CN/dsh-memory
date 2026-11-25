/**
 * Automatic dream scheduling and cold-session backfill.
 *
 * With `autoDream=true`, a `turn/end` starts a per-workspace debounce timer; a
 * new `turn/start` cancels and restarts it. Before enqueueing the scheduler
 * re-checks the workspace is idle and honours `autoDreamMinIntervalMs`. Every
 * workspace shares the dreamer's global serial queue, so at most one dream runs
 * at a time.
 * @module memloom/host/dream-scheduler
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MemoryConfig } from './config.ts'
import type { DreamRequest } from './dreamer.ts'
import type { memoryDomain } from './domain.ts'
import type { DreamRun, SessionCursor } from '../shared/types.ts'
import { normalizeWorkspaceKey } from './workspace.ts'

/** The dreamer surface the scheduler drives. */
export interface DreamerLike {
  enqueue(request: DreamRequest): Promise<DreamRun>
  flush(): Promise<void>
  status?(): DreamRun[]
  cancel?(dreamId: string): Promise<boolean>
  /** Whether the dreamer currently permits a new automatic run. */
  autoDreamAllowed?(): boolean
}

/** Durable session cursor access. */
export interface SessionCursorStore {
  get(sessionId: string): SessionCursor | undefined
  advance(cursor: SessionCursor): Promise<void>
}

/** `session_cursors` table backed cursor store. */
export class DomainSessionCursorStore implements SessionCursorStore {
  constructor(private readonly domain: Domain<typeof memoryDomain>) {}

  get(sessionId: string): SessionCursor | undefined {
    const record = this.domain.table('session_cursors').get(sessionId)
    return record === undefined ? undefined : structuredClone(record)
  }

  async advance(cursor: SessionCursor): Promise<void> {
    await this.domain.table('session_cursors').put(cursor.sessionId, cursor)
  }
}

/** Cold-session source the backfill scans. */
export interface ColdSessionRecord {
  /**
   * Session header subset. `SessionHeader` exposes `createdAt`, not `updatedAt`,
   * so the design §4.5 lookback filters on `createdAt`.
   */
  header: { id: string; cwd?: string; createdAt: number }
}

export interface ColdSessionSnapshot {
  events: SessionEvent[]
}

export interface ColdSessionSource {
  listSessions(): Promise<ColdSessionRecord[]>
  readSession(sessionId: string): Promise<ColdSessionSnapshot>
}

/** One backfilled session's raw events. */
export interface ColdSessionIngest {
  sessionId: string
  workspaceKey: string
  workspaceRoot: string
  events: SessionEvent[]
  lastProcessedSeq: number
}

/** Options for {@link DreamScheduler}. */
export interface DreamSchedulerOptions {
  dreamer: DreamerLike
  config: MemoryConfig
  cursorStore?: SessionCursorStore
  now?: () => Date
  /** Whether the workspace currently has no running agent (default: idle). */
  isWorkspaceIdle?: (workspaceKey: string) => boolean
  /** Whether a session is cold (not live) and therefore safe to replay (default: yes). */
  isSessionCold?: (sessionId: string) => boolean
  /** Resolve a recent agent for follow-session model selection, if any. */
  resolveAgent?: (workspaceKey: string) => unknown
  coldSource?: ColdSessionSource
  /** Turn raw events into whitelisted episodes; returns how many were created. */
  ingestSession?: (input: ColdSessionIngest) => Promise<number>
  /**
   * Highest event sequence already captured for one session. Used when no
   * session cursor exists so an existing store is not replayed from seq 0.
   */
  lastProcessedSeqFor?: (sessionId: string) => number | undefined
  /** Number of new/failed-retryable episodes in one workspace. */
  pendingEpisodeCount?: (workspaceKey: string) => number
  /** Original workspace root stored on an existing episode, for pending-only dreams. */
  workspaceRootFor?: (workspaceKey: string) => string | undefined
  /** Warning sink for per-workspace failure isolation. */
  logger?: { warn?: (message: string) => void }
}

/** Options for one cold-backfill pass. */
export interface BackfillPassOptions {
  /** Preloaded session list, shared by one startup reconciliation sweep. */
  sessions?: readonly ColdSessionRecord[]
  signal?: AbortSignal
  /**
   * Enqueue a dream when the workspace already has pending episodes even
   * though this pass captured none (startup right after autoDream is enabled).
   */
  includePendingEpisodes?: boolean
  /**
   * Run even when `autoDream` is off. A rebuild is an explicit user action, so
   * its replay must not depend on the automatic-dreaming preference.
   */
  force?: boolean
  /** Override the session lookback window (days) for this pass. */
  lookbackDays?: number
  /** Enqueue the resulting dream with this trigger (default `auto`). */
  trigger?: DreamRequest['trigger']
}

/** Result of one cold-backfill pass. */
export interface BackfillReport {
  sessions: number
  episodes: number
}

/**
 * Per-workspace debounce and cold-session backfill driver.
 */
export class DreamScheduler {
  private readonly dreamer: DreamerLike
  private readonly autoDream: boolean
  private readonly idleDelayMs: number
  private readonly minIntervalMs: number
  private readonly lookbackDays: number
  private readonly maxSessions: number
  private readonly now: () => Date
  private readonly isWorkspaceIdle: (workspaceKey: string) => boolean
  private readonly isSessionCold: ((sessionId: string) => boolean) | undefined
  private readonly resolveAgent: ((workspaceKey: string) => unknown) | undefined
  private readonly coldSource: ColdSessionSource | undefined
  private readonly ingestSession: ((input: ColdSessionIngest) => Promise<number>) | undefined
  private readonly cursorStore: SessionCursorStore | undefined
  private readonly lastProcessedSeqFor: ((sessionId: string) => number | undefined) | undefined
  private readonly pendingEpisodeCount: ((workspaceKey: string) => number) | undefined
  private readonly workspaceRootFor: ((workspaceKey: string) => string | undefined) | undefined
  private readonly logger: { warn?: (message: string) => void }
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastEnqueue = new Map<string, number>()
  /** Dreams this scheduler enqueued that may still be queued or running. */
  private readonly activeDreamIds = new Set<string>()
  /** Scopes with a cold-backfill pass currently in flight. */
  private readonly backfillScopes = new Set<string>()
  private disposed = false

  constructor(options: DreamSchedulerOptions) {
    this.dreamer = options.dreamer
    this.autoDream = options.config.autoDream === true
    this.idleDelayMs = options.config.dreamIdleDelayMs ?? 30_000
    this.minIntervalMs = options.config.autoDreamMinIntervalMs ?? 300_000
    this.lookbackDays = options.config.dreamLookbackDays ?? 7
    this.maxSessions = options.config.dreamMaxSessionsPerRun ?? 10
    this.now = options.now ?? (() => new Date())
    this.isWorkspaceIdle = options.isWorkspaceIdle ?? (() => true)
    this.isSessionCold = options.isSessionCold
    this.resolveAgent = options.resolveAgent
    this.coldSource = options.coldSource
    this.ingestSession = options.ingestSession
    this.cursorStore = options.cursorStore
    this.lastProcessedSeqFor = options.lastProcessedSeqFor
    this.pendingEpisodeCount = options.pendingEpisodeCount
    this.workspaceRootFor = options.workspaceRootFor
    this.logger = options.logger ?? {}
  }

  /** Cancel a pending debounce because a new turn started. */
  onTurnStart(workspaceKey: string): void {
    const timer = this.timers.get(workspaceKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(workspaceKey)
    }
  }

  /** Start the per-workspace debounce after a turn ends. */
  onTurnEnd(workspaceKey: string, workspaceRoot?: string): void {
    if (!this.autoDream || this.disposed) return
    this.onTurnStart(workspaceKey)
    const timer = setTimeout(() => {
      this.timers.delete(workspaceKey)
      void this.fire(workspaceKey, workspaceRoot)
    }, this.idleDelayMs)
    // Do not keep a CLI process alive just for a dream timer.
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.set(workspaceKey, timer)
  }

  private async fire(workspaceKey: string, workspaceRoot?: string): Promise<void> {
    if (!this.autoDream || this.disposed) return
    // A fatal error or an exhausted transient streak pauses automatic dreams
    // until the operator runs a successful manual dream.
    if (this.dreamer.autoDreamAllowed?.() === false) return
    if (!this.isWorkspaceIdle(workspaceKey)) {
      this.onTurnEnd(workspaceKey, workspaceRoot)
      return
    }
    const nowMs = this.now().getTime()
    const last = this.lastEnqueue.get(workspaceKey) ?? 0
    if (nowMs - last < this.minIntervalMs) return
    this.lastEnqueue.set(workspaceKey, nowMs)
    const agent = this.resolveAgent?.(workspaceKey)
    await this.enqueueDream({
      scopeKey: workspaceKey,
      scopeKind: 'workspace',
      ...(workspaceRoot === undefined ? {} : { scopeRoot: workspaceRoot }),
      ...(agent === undefined ? {} : { agent }),
      trigger: 'auto',
    })
  }

  /**
   * Enqueue one dream and remember its id so `dispose` can cancel it while it
   * is still queued or running.
   */
  private async enqueueDream(request: DreamRequest): Promise<DreamRun | undefined> {
    if (this.disposed) return undefined
    // Cold backfill also creates automatic dreams; never bypass a pause there.
    if (request.trigger === 'auto' && this.dreamer.autoDreamAllowed?.() === false) return undefined
    this.pruneActiveDreams()
    const dream = await this.dreamer.enqueue(request)
    this.activeDreamIds.add(dream.id)
    if (this.disposed && this.dreamer.cancel !== undefined) {
      await this.dreamer.cancel(dream.id)
    }
    return dream
  }

  /** Forget ids whose dream already reached a terminal state. */
  private pruneActiveDreams(): void {
    if (this.activeDreamIds.size === 0 || this.dreamer.status === undefined) return
    const statuses = new Map(this.dreamer.status().map((run) => [run.id, run.status]))
    for (const id of this.activeDreamIds) {
      const status = statuses.get(id as DreamRun['id'])
      if (status !== undefined && status !== 'queued' && status !== 'running') {
        this.activeDreamIds.delete(id)
      }
    }
  }

  /**
   * Scan recent cold sessions in one scope and dream their unseen events.
   *
   * When no cursor exists, the highest `sourceSeqs` value already stored for the
   * session is used as the baseline: enabling autoDream on an existing store
   * must not replay events that were already captured. Cursors advance only
   * when the resulting dream completed; a failed dream leaves every cursor
   * untouched so nothing is skipped.
   * @param scopeKey - Normalized workspace key.
   * @param options - Preloaded sessions, abort signal and pending-dream policy.
   * @returns How many sessions with unseen events were processed, and how many
   * episodes were captured.
   */
  async backfillColdSessions(
    scopeKey: string,
    options: BackfillPassOptions = {},
  ): Promise<BackfillReport> {
    if (
      (!this.autoDream && options.force !== true) ||
      this.disposed ||
      this.isAborted(options.signal)
    ) {
      return { sessions: 0, episodes: 0 }
    }
    const trigger = options.trigger ?? 'auto'
    if (
      trigger === 'auto' &&
      options.force !== true &&
      this.dreamer.autoDreamAllowed?.() === false
    ) {
      return { sessions: 0, episodes: 0 }
    }
    if (this.coldSource === undefined || this.ingestSession === undefined) {
      return { sessions: 0, episodes: 0 }
    }
    // One scan per scope at a time: a turn ending while the previous pass is
    // still reading sessions must not start a second concurrent sweep.
    if (this.backfillScopes.has(scopeKey)) return { sessions: 0, episodes: 0 }
    this.backfillScopes.add(scopeKey)
    try {
      const lookbackDays = options.lookbackDays ?? this.lookbackDays
      const cutoff = this.now().getTime() - lookbackDays * 86_400_000
      // `SessionHeader` exposes `createdAt`, not `updatedAt`; the lookback
      // window therefore filters on `createdAt`.
      const allSessions = options.sessions ?? (await this.coldSource.listSessions())
      if (this.disposed || this.isAborted(options.signal)) return { sessions: 0, episodes: 0 }
      const candidates = allSessions
        .filter((record) => {
          const cwd = record.header.cwd
          if (cwd === undefined || cwd === '') return false
          if (normalizeWorkspaceKey(cwd) !== scopeKey) return false
          if (this.isSessionCold !== undefined && !this.isSessionCold(record.header.id))
            return false
          return record.header.createdAt >= cutoff
        })
        .sort((left, right) => right.header.createdAt - left.header.createdAt)

      // Read every candidate before applying maxSessions: an older session with
      // unseen events must not be starved by newer sessions that are already
      // fully processed.
      const unseen: {
        record: ColdSessionRecord
        events: SessionEvent[]
        lastProcessedSeq: number
      }[] = []
      for (const record of candidates) {
        if (this.disposed || this.isAborted(options.signal)) {
          return { sessions: 0, episodes: 0 }
        }
        const lastProcessedSeq = this.lastProcessedSeqOf(record.header.id)
        const snapshot = await this.coldSource.readSession(record.header.id)
        if (this.disposed || this.isAborted(options.signal)) return { sessions: 0, episodes: 0 }
        const events = snapshot.events.filter((event) => event.seq > lastProcessedSeq)
        if (events.length === 0) continue
        unseen.push({ record, events, lastProcessedSeq })
      }
      const selected = unseen.slice(0, this.maxSessions)

      let episodes = 0
      const advanced: { sessionId: string; seq: number; root: string }[] = []
      let scopeRoot = this.workspaceRootFor?.(scopeKey) ?? scopeKey
      for (const item of selected) {
        const { record } = item
        const root = record.header.cwd ?? scopeKey
        scopeRoot = root
        const created = await this.ingestSession({
          sessionId: record.header.id,
          workspaceKey: scopeKey,
          workspaceRoot: root,
          events: item.events,
          lastProcessedSeq: item.lastProcessedSeq,
        })
        episodes += created
        const maxSeq = item.events.reduce(
          (max, event) => Math.max(max, event.seq),
          item.lastProcessedSeq,
        )
        advanced.push({ sessionId: record.header.id, seq: maxSeq, root })
        if (this.disposed || this.isAborted(options.signal)) break
      }

      const pendingEpisodes =
        options.includePendingEpisodes === true ? (this.pendingEpisodeCount?.(scopeKey) ?? 0) : 0
      if (
        (episodes > 0 || pendingEpisodes > 0) &&
        !this.hasActiveDream(scopeKey) &&
        !this.disposed &&
        !this.isAborted(options.signal)
      ) {
        const dream = await this.enqueueDream({
          scopeKey,
          scopeKind: 'workspace',
          scopeRoot,
          trigger,
        })
        await this.dreamer.flush()
        const settled =
          dream === undefined
            ? undefined
            : this.dreamer.status?.().find((run) => run.id === dream.id)?.status
        if (settled === 'completed' && this.cursorStore !== undefined) {
          const at = this.now().toISOString()
          for (const item of advanced) {
            await this.cursorStore.advance({
              sessionId: item.sessionId,
              workspaceKey: scopeKey,
              lastProcessedSeq: item.seq,
              lastProcessedAt: at,
            })
          }
        }
      } else if (
        episodes === 0 &&
        pendingEpisodes === 0 &&
        advanced.length > 0 &&
        !this.disposed &&
        !this.isAborted(options.signal) &&
        this.cursorStore !== undefined
      ) {
        // Sessions scanned with unseen events that yielded zero episodes do not
        // need a dream; advance their cursors so future turns do not re-read them.
        const at = this.now().toISOString()
        for (const item of advanced) {
          await this.cursorStore.advance({
            sessionId: item.sessionId,
            workspaceKey: scopeKey,
            lastProcessedSeq: item.seq,
            lastProcessedAt: at,
          })
        }
      }
      return { sessions: selected.length, episodes }
    } finally {
      this.backfillScopes.delete(scopeKey)
    }
  }

  /** Whether an optional shutdown signal has been aborted. */
  private isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true
  }

  /** Start sequence for a session: its cursor, or the highest stored episode seq. */
  private lastProcessedSeqOf(sessionId: string): number {
    const cursor = this.cursorStore?.get(sessionId)?.lastProcessedSeq ?? 0
    const stored = this.lastProcessedSeqFor?.(sessionId) ?? 0
    return Math.max(cursor, stored)
  }

  /** Whether this scheduler already has a queued or running dream for one workspace. */
  private hasActiveDream(scopeKey: string): boolean {
    const runs = this.dreamer.status?.()
    return (
      runs?.some(
        (run) => run.scopeKey === scopeKey && (run.status === 'queued' || run.status === 'running'),
      ) ?? false
    )
  }

  /**
   * Reconcile every workspace with recent cold sessions on startup.
   *
   * Lists sessions once, groups them by normalized workspace key, and runs one
   * backfill pass per workspace serially so concurrent passes never write the
   * same domain. A workspace failure is logged and does not stop the others.
   * No-op unless `autoDream` and a cold source are available.
   * @param signal - Optional abort signal observed at every await boundary.
   * @returns Aggregated session and episode counts.
   */
  async reconcileRecentSessions(signal?: AbortSignal): Promise<BackfillReport> {
    if (!this.autoDream || this.disposed || this.isAborted(signal)) {
      return { sessions: 0, episodes: 0 }
    }
    if (this.coldSource === undefined || this.ingestSession === undefined) {
      return { sessions: 0, episodes: 0 }
    }
    // `SessionHeader` exposes `createdAt`; the lookback filters on `createdAt`.
    const allSessions = await this.coldSource.listSessions()
    if (this.disposed || this.isAborted(signal)) return { sessions: 0, episodes: 0 }
    const cutoff = this.now().getTime() - this.lookbackDays * 86_400_000
    const workspaceKeys = new Set<string>()
    for (const record of allSessions) {
      if (record.header.createdAt < cutoff) continue
      const cwd = record.header.cwd
      if (cwd !== undefined && cwd !== '') workspaceKeys.add(normalizeWorkspaceKey(cwd))
    }
    const totals: BackfillReport = { sessions: 0, episodes: 0 }
    for (const workspaceKey of workspaceKeys) {
      if (this.disposed || this.isAborted(signal)) break
      try {
        const report = await this.backfillColdSessions(workspaceKey, {
          sessions: allSessions,
          includePendingEpisodes: true,
          ...(signal === undefined ? {} : { signal }),
        })
        totals.sessions += report.sessions
        totals.episodes += report.episodes
      } catch (error) {
        this.logger.warn?.(
          `memloom: cold session backfill failed for ${workspaceKey}: ${String(error)}`,
        )
      }
    }
    return totals
  }

  /**
   * Stop accepting new dreams, clear timers, cancel every dream this scheduler
   * enqueued that is still queued or running, then drain the queue.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.dreamer.cancel !== undefined) {
      for (const dreamId of [...this.activeDreamIds]) {
        await this.dreamer.cancel(dreamId)
      }
    }
    await this.dreamer.flush()
    this.activeDreamIds.clear()
  }
}
