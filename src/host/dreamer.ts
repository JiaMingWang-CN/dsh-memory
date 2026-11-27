/**
 * `MemoryDreamer` — the dream queue, model call, JSON validation and pending
 * proposal writer.
 *
 * A running dream is a single model call and is never resumed mid-flight:
 * `operations.recover()` finalizes it, while `resumeQueued()` only restarts
 * dreams that never began. Every output is written as `pending`,
 * `ownership='derived'`, `origin='dream'`, and only after exact `proposalKey`
 * and semantic duplicate checks. Episodes are marked `processed` only when a
 * proposal referenced them.
 * @module memloom/host/dreamer
 */
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { MemoryConfig } from './config.ts'
import { checkDreamHealth } from './dream-health.ts'
import {
  buildDreamPrompt,
  buildDreamSystemPrompt,
  buildOrganizePrompt,
  mergeRelatedMemories,
  ORGANIZE_RECORD_LIMIT,
  ORGANIZE_SYSTEM_PROMPT,
  RELATED_MEMORY_LIMIT,
} from './dream-prompt.ts'
import {
  applyDuplicatePolicy,
  computeProposalKey,
  normalizeTitle,
  type DreamProposalOutput,
} from './proposal.ts'
import { OperationRunner } from './operations.ts'
import { redactSecrets } from './redact.ts'
import type { MemoryStore } from './store.ts'
import {
  newDreamId,
  type DreamRun,
  type DreamTrigger,
  type EpisodeRecord,
  type EpisodeStatus,
  type MemoryRecord,
  type MemoryScope,
  type MemoryType,
  type WorklogKind,
} from '../shared/types.ts'

const MEMORY_TYPES: ReadonlySet<MemoryType> = new Set(['lesson', 'worklog', 'wiki', 'preference'])
const MAX_TITLE_CHARS = 200
const MAX_BODY_BYTES = 65_536
/** Maximum characters retained in one persisted dream/episode error message. */
const MAX_PERSISTED_ERROR_CHARS = 500

/** Error classes used to decide retry, backoff and pause behaviour. */
export type DreamErrorClass = 'fatal' | 'transient' | 'other'

/** Process-local automatic dream queue state for read-only display. */
export interface DreamQueueState {
  paused: boolean
  reason?: string
  retryAt?: number
}

/** Structured failure facts understood by {@link classifyDreamError}. */
export interface DreamFailureFacts {
  readonly message?: string
  readonly code?: string
  readonly status?: number
  readonly failure?: DreamFailureFacts
}

const FATAL_ERROR_PATTERN =
  /\bHTTP_(?:401|402|403)\b|\b(?:AUTH|ACCOUNT_QUOTA|QUOTA|INVALID_CREDENTIAL|MISSING_CREDENTIAL|ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID)\b|\b(?:401|402|403)\b|unauthorized|forbidden|invalid[ _-]*(?:api[ _-]*)?(?:key|token|credential)|token[ _-]*invalid|sign[ _-]*in[ _-]*required|missing[ _-]*credential|authentication|insufficient|quota|billing|credit/i
const TRANSIENT_ERROR_PATTERN =
  /\bHTTP_(?:408|425|429|5\d{2})\b|\b(?:RATE_LIMIT|SERVER|TIMEOUT|TRANSPORT|STREAM_CLOSED|EMPTY_RESPONSE)\b|\b(?:408|425|429|5\d{2})\b|rate[ _-]?limit|timeout|timed[ _-]?out|etimedout|econn|enotfound|eai_again|socket|fetch failed|temporary|unavailable/i

/** Read one failure value's text and HTTP status without trusting accessors beyond direct reads. */
function failureFactsOf(value: unknown): { text: string; status: number | undefined } {
  if (typeof value === 'string') return { text: value, status: undefined }
  const parts: string[] = []
  let status: number | undefined
  let current: unknown = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== 'object') break
    const record = current as Record<string, unknown>
    if (typeof record.message === 'string') parts.push(record.message)
    if (typeof record.code === 'string') parts.push(record.code)
    if (typeof record.status === 'number') {
      parts.push(String(record.status))
      status ??= record.status
    }
    current = record.failure
  }
  return { text: parts.join(' '), status }
}

/**
 * Classify one dream failure from a message or an error carrying DSH failure facts.
 *
 * DSH's `LlmRuntime` reports adapter failures as terminal `finish(error)` chunks
 * whose `failure` carries a provider-neutral code (`AUTH`, `RATE_LIMIT`,
 * `HTTP_429`, `HTTP_500`, …) and HTTP status. Checking those structured fields
 * is authoritative; the textual fallbacks keep legacy messages classifiable.
 * @param input - Message string, Error, LlmFailure, or a wrapper with `failure`.
 * @returns The error class.
 */
export function classifyDreamError(input: unknown): DreamErrorClass {
  const { text, status } = failureFactsOf(input)
  // Explicit fatal facts win over a generic HTTP status: providers commonly
  // report exhausted quota as 429 with `QUOTA`/`ACCOUNT_QUOTA`.
  if (FATAL_ERROR_PATTERN.test(text)) return 'fatal'
  if (status !== undefined) {
    if (status === 401 || status === 402 || status === 403) return 'fatal'
    if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
      return 'transient'
    }
  }
  if (TRANSIENT_ERROR_PATTERN.test(text)) return 'transient'
  return 'other'
}

/** Error carrying the structured failure facts from a terminal finish chunk. */
interface DreamModelCallFailure extends Error {
  code: string
  status: number | undefined
  failure: LlmFailure
}

/** Build an Error that preserves the finish chunk's message, code and status. */
function modelCallFailure(failure: LlmFailure): DreamModelCallFailure {
  const suffix = ` (${failure.code}${failure.status === undefined ? '' : ` status=${failure.status}`})`
  const error = new Error(
    `dream model call failed: ${failure.message}${suffix}`,
  ) as DreamModelCallFailure
  error.name = 'DreamModelCallError'
  error.code = failure.code
  error.status = failure.status
  error.failure = failure
  return error
}

/** Startup resume order: manual requests first, then automatic, then rebuild. */
function triggerPriority(trigger: DreamTrigger): number {
  if (trigger === 'manual' || trigger === 'organize') return 0
  if (trigger === 'auto') return 1
  return 2
}

/** Structural model selection (matches the Host `ModelSelection`). */
export interface DreamModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** LLM surface used by the dreamer. */
export interface DreamLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** One related-memory lookup for a dream batch. */
export interface RelatedSearchInput {
  /** Batch text used as the query. */
  query: string
  /** Caller's workspace key, or null for a global-only dream. */
  workspaceKey: string | null
  scope: 'auto' | 'global'
  limit: number
}

/** One enqueue request. */
export interface DreamRequest {
  scopeKey: string
  scopeKind?: 'workspace' | 'global'
  scopeRoot?: string
  trigger: DreamTrigger
  since?: string
  maxEpisodes?: number
  modelSelection?: DreamModelSelection
  agent?: unknown
}

/** Parsed model output before persistence. */
export interface DreamOutput {
  memories: DreamProposalOutput[]
}

/** Options for {@link MemoryDreamer}. */
export interface MemoryDreamerOptions {
  store: MemoryStore
  runner: OperationRunner
  config: MemoryConfig
  llm?: DreamLlm | undefined
  /** Resolve a follow-session selection (service-provided). */
  resolveSelection?: (request: DreamRequest) => Promise<DreamModelSelection | undefined>
  /** Default selection when no session context exists. */
  defaultSelection?: () => DreamModelSelection | undefined
  /**
   * Rank the already-active memories related to one dream batch. The service
   * supplies BM25 search; without it the dreamer falls back to every active
   * record visible in the scope (in creation order).
   */
  relatedSearch?: (input: RelatedSearchInput) => MemoryRecord[]
  now?: () => Date
  logger?: { warn?: (message: string) => void }
}

interface WriteSummary {
  created: number
  updated: number
  accepted: number
  skipped: number
  usedEpisodeIds: string[]
}

/** Strip optional Markdown code fences around a JSON document. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[a-zA-Z0-9]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim()
}

/**
 * Dream queue and runner. One instance is owned by the memory service; `enqueue`
 * schedules `run` on a process-local serial queue so a global concurrency of one
 * dream holds across every workspace.
 */
export class MemoryDreamer {
  private readonly store: MemoryStore
  private readonly runner: OperationRunner
  private readonly config: MemoryConfig
  private readonly llm: DreamLlm | undefined
  private readonly resolveSelectionHook:
    ((request: DreamRequest) => Promise<DreamModelSelection | undefined>) | undefined
  private readonly defaultSelection: (() => DreamModelSelection | undefined) | undefined
  private readonly relatedSearch: ((input: RelatedSearchInput) => MemoryRecord[]) | undefined
  private readonly now: () => Date
  private readonly logger: { warn?: (message: string) => void }
  private readonly requests = new Map<string, DreamRequest>()
  private readonly abortByDream = new Map<string, AbortController>()
  private queue: Promise<void> = Promise.resolve()
  private readonly scheduled = new Set<string>()
  /** Consecutive transient failures; reset by the next successful run. */
  private transientStreak = 0
  /** Earliest time at which automatic dreaming may try again. */
  private backoffUntil: number | undefined
  /** Why automatic dreaming is paused; process-local and cleared manually. */
  private autoPausedReason: string | undefined
  /** Consecutive `other` failures per episode, cleared by success or another class. */
  private readonly otherFailures = new Map<string, number>()

  constructor(options: MemoryDreamerOptions) {
    this.store = options.store
    this.runner = options.runner
    this.config = options.config
    this.llm = options.llm
    this.resolveSelectionHook = options.resolveSelection
    this.defaultSelection = options.defaultSelection
    this.relatedSearch = options.relatedSearch
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? {}
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  /** Every dream run, newest first. */
  status(): DreamRun[] {
    return this.store.dreamList()
  }

  /**
   * Whether a new automatic dream may be enqueued now.
   *
   * Process-local only: a restart clears both the pause reason and backoff.
   * Manual dreams never consult this method.
   * @returns False while paused or inside the current transient backoff.
   */
  autoDreamAllowed(): boolean {
    if (this.autoPausedReason !== undefined) return false
    if (this.backoffUntil === undefined) return true
    return this.now().getTime() >= this.backoffUntil
  }

  /** Read-only view of the process-local automatic dream queue state. */
  dreamQueueState(): DreamQueueState {
    const nowMs = this.now().getTime()
    const retryAt =
      this.backoffUntil !== undefined && this.backoffUntil > nowMs ? this.backoffUntil : undefined
    return {
      paused: this.autoPausedReason !== undefined,
      ...(this.autoPausedReason === undefined ? {} : { reason: this.autoPausedReason }),
      ...(retryAt === undefined ? {} : { retryAt }),
    }
  }

  /**
   * Clear pause and transient backoff after a manual dream completed.
   *
   * A manual run is the explicit operator retry path, so its success is the
   * only event that lifts an automatic pause.
   */
  noteManualSuccess(): void {
    this.autoPausedReason = undefined
    this.transientStreak = 0
    this.backoffUntil = undefined
  }

  /**
   * Fail dreams left `running` by a restart that left no operation to recover.
   *
   * `operations.recover()` finalizes running dreams that still own a
   * `dream.run` operation. This sweep covers the residual case: a `running`
   * record whose operation is gone. Its claimed episodes return to the
   * retryable pool with one more attempt.
   * @returns How many dreams were failed.
   */
  async failInterruptedRuns(): Promise<number> {
    const error = 'dream run was interrupted by restart and was not resumed'
    let failed = 0
    for (const dream of this.store.dreamList()) {
      if (dream.status !== 'running') continue
      const terminal: DreamRun = {
        ...dream,
        status: 'failed',
        finishedAt: this.nowIso(),
        error,
      }
      const stored = await this.store.putDreamTerminal(terminal)
      if (stored === undefined) continue
      failed += 1
      this.requests.delete(dream.id)
      const claimed = this.store
        .episodeList({ statuses: ['processing'] })
        .filter((episode) => episode.dreamId === dream.id)
      for (const episode of claimed) {
        await this.store.updateEpisode(episode.id, { attempts: episode.attempts + 1 })
      }
      await this.store.releaseEpisodes(
        claimed.map((episode) => episode.id),
        dream.id,
        error,
      )
    }
    return failed
  }

  /**
   * Schedule every `queued` dream persisted by a previous process. The raw
   * request is reconstructed from the persisted scope and trigger, so the
   * original dream id is reused instead of creating a new run.
   * @returns How many dreams were newly scheduled.
   */
  async resumeQueued(): Promise<number> {
    let resumed = 0
    const queued = this.store
      .dreamList()
      .filter((dream) => dream.status === 'queued')
      .sort(
        (left, right) =>
          triggerPriority(left.trigger) - triggerPriority(right.trigger) ||
          left.startedAt.localeCompare(right.startedAt),
      )
    for (const dream of queued) {
      if (this.scheduled.has(dream.id)) continue
      this.schedule(dream.id)
      resumed += 1
    }
    return resumed
  }

  /**
   * Create a queued dream and start it on the serial queue.
   * @param request - Scope, trigger and optional bounds.
   * @returns The queued dream record (the run continues in the background).
   */
  async enqueue(request: DreamRequest): Promise<DreamRun> {
    const startedAt = this.nowIso()
    const dream: DreamRun = {
      id: newDreamId(),
      trigger: request.trigger,
      scopeKey: request.scopeKey,
      status: 'queued',
      startedAt,
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
    await this.store.putDream(dream)
    this.requests.set(dream.id, request)
    this.schedule(dream.id)
    return dream
  }

  /**
   * Run one dream by id (scheduled on the serial queue).
   * @param dreamId - Dream identity.
   * @returns The settled dream record.
   */
  async run(dreamId: string): Promise<DreamRun | undefined> {
    this.schedule(dreamId)
    await this.queue
    return this.store.getDream(dreamId)
  }

  /** Wait for every queued dream to settle (test and shutdown support). */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Cancel a queued or running dream: queued dreams are marked cancelled and a
   * running dream's model call is aborted.
   * @param dreamId - Dream identity.
   * @returns Whether a cancellation was applied.
   */
  async cancel(dreamId: string): Promise<boolean> {
    const cancelled = await this.store.cancelDream(dreamId)
    if (!cancelled) return false
    this.abortByDream.get(dreamId)?.abort()
    return true
  }

  private schedule(dreamId: string): void {
    if (this.scheduled.has(dreamId)) return
    this.scheduled.add(dreamId)
    this.queue = this.queue
      .then(() => this.runInternal(dreamId))
      .catch((error: unknown) => {
        this.logger.warn?.(`memloom: dream ${dreamId} scheduling failed: ${String(error)}`)
      })
      .finally(() => {
        this.scheduled.delete(dreamId)
      })
  }

  private async runInternal(dreamId: string): Promise<void> {
    const dream = this.store.getDream(dreamId)
    if (dream === undefined || dream.status !== 'queued') {
      this.requests.delete(dreamId)
      return
    }
    const request = this.requests.get(dreamId) ?? {
      scopeKey: dream.scopeKey,
      trigger: dream.trigger,
    }
    if (dream.trigger === 'auto' && !this.autoDreamAllowed()) {
      // This dream was queued before a fatal/backoff pause. Cancel it instead
      // of running it; its episodes stay new/retryable and a later automatic
      // enqueue will pick them up once the pause is lifted.
      await this.cancel(dreamId)
      this.requests.delete(dreamId)
      return
    }
    await this.reclaimStale(dream.scopeKey)
    if (dream.trigger === 'organize') {
      await this.runOrganize(dream)
      return
    }

    const maxEpisodes = Math.max(
      1,
      Math.min(
        request.maxEpisodes ?? this.config.dreamMaxEpisodes ?? 40,
        this.config.dreamMaxEpisodes ?? 40,
      ),
    )
    const statuses: EpisodeStatus[] =
      request.trigger === 'manual'
        ? ['new', 'failed-retryable', 'skipped']
        : ['new', 'failed-retryable']
    const episodes = this.store.episodeList({
      workspaceKey: dream.scopeKey,
      statuses,
      ...(request.since === undefined ? {} : { since: request.since }),
      limit: maxEpisodes,
    })

    let operation
    try {
      operation = await this.runner.begin('dream.run', { dreamId })
    } catch (error) {
      await this.failDream(dream, [], this.nowIso(), error)
      return
    }

    // The run owns a durable `dream.run` operation until it commits. Every
    // early return (cancellation included) and every thrown failure settles
    // that row here, so a failed run never leaves a permanent `planned` row
    // that a later restart would report as an interrupted process.
    let settled = false
    let failure: unknown
    let running: DreamRun = dream
    let claimed: EpisodeRecord[] = []
    try {
      const { selection, warning } = await this.resolveModel(request)
      if (this.store.getDream(dreamId)?.status === 'cancelled') {
        failure = new Error('dream was cancelled before it started')
        return
      }
      running = {
        ...dream,
        status: 'running',
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      }
      const started = await this.store.startDream(running)
      if (started === undefined) {
        failure = new Error('dream was cancelled before it started')
        return
      }

      if (episodes.length === 0) {
        if (this.store.getDream(dreamId)?.status === 'cancelled') {
          failure = new Error('dream was cancelled before it started')
          return
        }
        await this.completeDream(
          running,
          operation,
          0,
          { created: 0, updated: 0, skipped: 0 },
          warning,
        )
        settled = true
        return
      }

      claimed = await this.store.claimEpisodes(
        episodes.map((episode) => episode.id),
        dreamId,
      )
      const controller = new AbortController()
      this.abortByDream.set(dreamId, controller)
      try {
        if (this.isCancelled(dreamId, controller.signal)) {
          await this.releaseCancelled(dreamId, claimed)
          failure = new Error('dream was cancelled')
          return
        }
        const output = await this.invokeModel(
          request,
          running,
          claimed,
          selection,
          controller.signal,
        )
        if (this.isCancelled(dreamId, controller.signal)) {
          await this.releaseCancelled(dreamId, claimed)
          failure = new Error('dream was cancelled')
          return
        }
        const summary = await this.persistOutput(
          output,
          running,
          claimed,
          operation.id,
          controller.signal,
        )
        if (this.isCancelled(dreamId, controller.signal)) {
          await this.releaseCancelled(dreamId, claimed)
          failure = new Error('dream was cancelled')
          return
        }
        if (summary.usedEpisodeIds.length > 0) {
          await this.store.markEpisodesProcessed(
            summary.usedEpisodeIds as EpisodeRecord['id'][],
            dreamId,
          )
          this.clearOtherFailures(summary.usedEpisodeIds)
        }
        const used = new Set(summary.usedEpisodeIds)
        const unused = claimed
          .filter((episode) => !used.has(episode.id))
          .map((episode) => episode.id)
        if (unused.length > 0) {
          await this.store.markEpisodesSkipped(unused, dreamId)
          this.clearOtherFailures(unused)
        }
        if (this.isCancelled(dreamId, controller.signal)) {
          await this.releaseCancelled(dreamId, claimed)
          failure = new Error('dream was cancelled')
          return
        }
        const usage = this.lastUsage
        await this.completeDream(
          { ...running, ...(usage === undefined ? {} : { usage }) },
          operation,
          claimed.length,
          summary,
          warning,
        )
        settled = true
      } finally {
        this.abortByDream.delete(dreamId)
      }
    } catch (error) {
      failure = error
      if (this.store.getDream(dreamId)?.status === 'cancelled') {
        if (claimed.length > 0) await this.releaseCancelled(dreamId, claimed)
        return
      }
      await this.failDream(
        { ...running, error: this.messageOf(error) },
        claimed.map((episode) => episode.id),
        this.nowIso(),
        error,
      )
    } finally {
      this.requests.delete(dreamId)
      if (!settled) await this.settleOperation(operation, failure)
    }
  }

  /** Settle a started `dream.run` operation that will never commit. */
  private async settleOperation(
    operation: Awaited<ReturnType<OperationRunner['begin']>>,
    failure: unknown,
  ): Promise<void> {
    const error =
      failure instanceof Error ? failure : new Error(String(failure ?? 'dream run did not commit'))
    try {
      await this.runner.markFailed(operation, error)
    } catch (settleError) {
      this.logger.warn?.(
        `memloom: failed to settle dream operation ${operation.id}: ${String(settleError)}`,
      )
    }
  }

  /**
   * Run one full-store organize pass. It reads the active memories in the scope
   * and asks the model for merge/replacement proposals, each of which must cite
   * the ids it supersedes. Nothing is activated here; every output stays pending
   * and an Accept archives the superseded records in the same operation.
   */
  private async runOrganize(dream: DreamRun): Promise<void> {
    const dreamId = dream.id
    if (this.store.getDream(dreamId)?.status !== 'queued') {
      this.requests.delete(dreamId)
      return
    }
    const request =
      this.requests.get(dreamId) ??
      ({
        scopeKey: dream.scopeKey,
        trigger: 'organize' as const,
        ...(dream.scopeKey === 'global'
          ? { scopeKind: 'global' as const }
          : { scopeKind: 'workspace' as const, scopeRoot: dream.scopeKey }),
      } satisfies DreamRequest)
    let operation
    try {
      operation = await this.runner.begin('dream.run', { dreamId })
    } catch (error) {
      await this.failDream(dream, [], this.nowIso(), error)
      return
    }
    // Same settlement contract as a regular dream: an organize pass that ends
    // without committing must not leave a permanent `planned` operation row.
    let settled = false
    let failure: unknown
    let running: DreamRun = dream
    try {
      const { selection, warning } = await this.resolveModel(request)
      if (this.store.getDream(dreamId)?.status === 'cancelled') {
        failure = new Error('organize was cancelled before it started')
        return
      }
      running = {
        ...dream,
        status: 'running',
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      }
      const started = await this.store.startDream(running)
      if (started === undefined) {
        failure = new Error('organize was cancelled before it started')
        return
      }
      const records = this.organizeCandidates(request)
      if (this.store.getDream(dreamId)?.status === 'cancelled') {
        failure = new Error('organize was cancelled before it started')
        return
      }
      if (records.length === 0) {
        await this.completeDream(
          running,
          operation,
          0,
          { created: 0, updated: 0, skipped: 0 },
          warning,
        )
        settled = true
        return
      }
      const controller = new AbortController()
      this.abortByDream.set(dreamId, controller)
      try {
        if (this.isCancelled(dreamId, controller.signal)) {
          failure = new Error('organize was cancelled')
          return
        }
        const output = await this.invokeOrganizeModel(
          request,
          records,
          selection,
          controller.signal,
        )
        if (this.isCancelled(dreamId, controller.signal)) {
          failure = new Error('organize was cancelled')
          return
        }
        const summary = await this.persistOutput(
          output,
          running,
          [],
          operation.id,
          controller.signal,
        )
        if (this.isCancelled(dreamId, controller.signal)) {
          failure = new Error('organize was cancelled')
          return
        }
        const usage = this.lastUsage
        await this.completeDream(
          { ...running, ...(usage === undefined ? {} : { usage }) },
          operation,
          0,
          summary,
          warning,
        )
        settled = true
      } finally {
        this.abortByDream.delete(dreamId)
      }
    } catch (error) {
      failure = error
      if (this.store.getDream(dreamId)?.status === 'cancelled') return
      await this.failDream({ ...running, error: this.messageOf(error) }, [], this.nowIso(), error)
    } finally {
      this.requests.delete(dreamId)
      if (!settled) await this.settleOperation(operation, failure)
    }
  }

  /** Active memories one organize run may inspect, strictly within the target scope. */
  private organizeCandidates(request: DreamRequest): MemoryRecord[] {
    const scope = this.scopeOf(request, [])
    return this.store
      .activeRecords()
      .filter((record) =>
        scope.kind === 'global'
          ? record.scope.kind === 'global'
          : record.scope.kind === 'workspace' && record.scope.key === scope.key,
      )
      .sort(
        (left, right) =>
          right.importance - left.importance || left.updatedAt.localeCompare(right.updatedAt),
      )
      .slice(0, ORGANIZE_RECORD_LIMIT)
      .map((record) => ({
        ...record,
        title: this.redactText(record.title),
        body: this.redactText(record.body),
      }))
  }

  private async invokeOrganizeModel(
    request: DreamRequest,
    records: readonly MemoryRecord[],
    selection: DreamModelSelection,
    signal: AbortSignal,
  ): Promise<DreamOutput> {
    if (this.llm === undefined) throw new Error('dream model is unavailable')
    const scope = this.scopeOf(request, [])
    const messages: GenerateOptions['messages'] = [
      {
        role: 'user',
        content: [{ type: 'text', text: buildOrganizePrompt({ records: [...records] }) }],
      },
    ]
    const baseOptions: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      system: ORGANIZE_SYSTEM_PROMPT,
      messages,
      maxTokens: this.config.dreamMaxTokens ?? 4096,
      signal,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort as never }),
    }
    const first = await this.callModel(baseOptions)
    try {
      return this.parseOrganizeOutput(first, records, scope)
    } catch (error) {
      const repair: GenerateOptions = {
        ...baseOptions,
        messages: [
          ...messages,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Your previous answer (below) was not valid: ${this.messageOf(error)}. Return only the single JSON object described, with no prose. Every memory must include a non-empty supersedes array of supplied memory ids.\n\n${first}`,
              },
            ],
          },
        ],
      }
      const second = await this.callModel(repair)
      return this.parseOrganizeOutput(second, records, scope)
    }
  }

  /** Parse an organize output; an empty list means the store already needs no change. */
  private parseOrganizeOutput(
    text: string,
    records: readonly MemoryRecord[],
    scope: MemoryScope,
  ): DreamOutput {
    let parsed: unknown
    try {
      parsed = JSON.parse(stripFences(text))
    } catch {
      throw new Error('model output was not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('model output must be an object')
    }
    const doc = parsed as Record<string, unknown>
    if (!Array.isArray(doc.memories)) {
      throw new Error('model output must contain a memories array')
    }
    const raw = doc.memories
    const known = new Set(records.map((record) => record.id as string))
    return { memories: raw.map((entry) => this.normalizeOrganizeEntry(entry, scope, known)) }
  }

  /** Validate one organize memory: it must supersede at least one supplied id. */
  private normalizeOrganizeEntry(
    entry: unknown,
    scope: MemoryScope,
    known: ReadonlySet<string>,
  ): DreamProposalOutput {
    if (entry === null || typeof entry !== 'object')
      throw new Error('memory entry must be an object')
    const record = entry as Record<string, unknown>
    const type = record.type
    if (typeof type !== 'string' || !MEMORY_TYPES.has(type as MemoryType)) {
      throw new Error('memory entry has an invalid type')
    }
    if (scope.kind === 'global' && type !== 'preference') {
      throw new Error('only preference memories may be global')
    }
    const title = this.redactText(typeof record.title === 'string' ? record.title.trim() : '')
    if (title.length < 1 || [...title].length > MAX_TITLE_CHARS) {
      throw new Error('memory entry has an invalid title')
    }
    const body = this.redactText(typeof record.body === 'string' ? record.body : '')
    if (Buffer.byteLength(body, 'utf8') < 1 || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error('memory entry has an invalid body')
    }
    const confidence = this.ratio(record.confidence, 'confidence')
    const importance = this.ratio(record.importance, 'importance')
    const supersedes = Array.isArray(record.supersedes)
      ? record.supersedes.filter((id): id is string => typeof id === 'string')
      : []
    if (supersedes.length === 0) {
      throw new Error('an organize memory must supersede at least one memory')
    }
    for (const id of supersedes) {
      if (!known.has(id)) throw new Error(`memory entry supersedes an unknown memory: ${id}`)
    }
    const tags = Array.isArray(record.tags)
      ? record.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => this.redactText(tag))
      : undefined
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
      sourceEpisodeIds: [],
      supersedes,
    }
  }

  private lastUsage: DreamRun['usage'] | undefined

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Apply configurable secret redaction before any dream text is persisted or prompted. */
  private redactText(text: string): string {
    return this.config.redactSecrets === false ? text : redactSecrets(text)
  }

  /** Clone one claimed episode with every prompted text field redacted. */
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

  /** Whether the dream was cancelled or its in-flight model call was aborted. */
  private isCancelled(dreamId: string, signal: AbortSignal): boolean {
    return signal.aborted || this.store.getDream(dreamId)?.status === 'cancelled'
  }

  /** Return claimed episodes to the retryable pool after a cancellation. */
  private async releaseCancelled(
    dreamId: string,
    claimed: readonly EpisodeRecord[],
  ): Promise<void> {
    if (claimed.length === 0) return
    await this.store.releaseEpisodes(
      claimed.map((episode) => episode.id),
      dreamId,
      'dream cancelled',
    )
  }

  private async completeDream(
    dream: DreamRun,
    operation: Awaited<ReturnType<OperationRunner['begin']>>,
    episodeCount: number,
    summary: { created: number; updated: number; accepted?: number; skipped: number },
    warning?: string,
  ): Promise<void> {
    if (this.store.getDream(dream.id)?.status === 'cancelled') return
    const accepted = summary.accepted ?? 0
    const finished: DreamRun = {
      ...dream,
      status: 'completed',
      finishedAt: this.nowIso(),
      episodes: episodeCount,
      committed: summary.created,
      pending: Math.max(0, summary.created + summary.updated - accepted),
      ...(warning === undefined ? {} : { error: warning }),
    }
    const stored = await this.store.putDreamTerminal(finished)
    if (stored === undefined) return
    if (dream.trigger === 'manual') this.noteManualSuccess()
    else {
      // A successful run breaks the consecutive transient-failure streak.
      this.transientStreak = 0
      this.backoffUntil = undefined
    }
    await this.runner.commit(operation)
  }

  /** Redact and shorten one error message before persisting it. */
  private safeErrorText(message: string): string {
    const redacted = redactSecrets(message).replace(/\s+/g, ' ').trim()
    return redacted.length > MAX_PERSISTED_ERROR_CHARS
      ? `${redacted.slice(0, MAX_PERSISTED_ERROR_CHARS - 1)}…`
      : redacted
  }

  /** Redact and shorten one error message before storing it as a pause reason. */
  private safeErrorDetail(message: string): string {
    return this.safeErrorText(message).slice(0, 160)
  }

  /** Count one consecutive `other` failure per episode and return the poisoned batch. */
  private noteOtherFailures(batch: readonly EpisodeRecord[]): EpisodeRecord[] {
    const poisoned: EpisodeRecord[] = []
    for (const episode of batch) {
      const count = (this.otherFailures.get(episode.id) ?? 0) + 1
      this.otherFailures.set(episode.id, count)
      if (count >= 3) poisoned.push(episode)
    }
    return poisoned
  }

  /** Clear consecutive `other` counters after a non-other failure or a success. */
  private clearOtherFailures(ids: readonly string[]): void {
    for (const id of ids) this.otherFailures.delete(id)
  }

  /** Apply fatal, manual-failure, transient-backoff or other policy. */
  private applyFailurePolicy(dream: DreamRun, kind: DreamErrorClass, message: string): void {
    const detail = this.safeErrorDetail(message)
    if (kind !== 'transient' || dream.trigger === 'manual') {
      // Only a consecutive transient streak accumulates; `other` and fatal
      // failures break it.
      this.transientStreak = 0
      this.backoffUntil = undefined
    }
    if (kind === 'fatal') {
      this.autoPausedReason = `automatic dreaming paused after a fatal error: ${detail}`
      return
    }
    if (dream.trigger === 'manual') {
      this.autoPausedReason = `automatic dreaming paused after a manual dream failed: ${detail}`
      return
    }
    if (kind !== 'transient') return
    this.transientStreak += 1
    if (this.transientStreak >= 3) {
      this.autoPausedReason = `automatic dreaming paused after 3 consecutive transient failures: ${detail}`
      this.backoffUntil = undefined
      return
    }
    const delay = this.transientStreak === 1 ? 60_000 : 180_000
    this.backoffUntil = this.now().getTime() + delay
  }

  private async failDream(
    dream: DreamRun,
    episodeIds: readonly EpisodeRecord['id'][],
    _at: string,
    error: unknown,
  ): Promise<void> {
    const message = this.safeErrorText(this.messageOf(error))
    const kind = classifyDreamError(error)
    const batch = episodeIds
      .map((id) => this.store.getEpisode(id))
      .filter((episode): episode is EpisodeRecord => episode !== undefined)
    const poisoned = kind === 'other' ? this.noteOtherFailures(batch) : []
    if (kind !== 'other') this.clearOtherFailures(episodeIds)
    const poison = poisoned.length > 0
    const failureMessage = poison
      ? this.safeErrorText(`skipped after 3 attempts: ${message}`)
      : message
    const failed: DreamRun = {
      ...dream,
      status: 'failed',
      finishedAt: this.nowIso(),
      error: failureMessage,
    }
    const stored = await this.store.putDreamTerminal(failed)
    if (stored === undefined) {
      if (episodeIds.length > 0) {
        await this.store.releaseEpisodes(episodeIds, dream.id, 'dream cancelled')
      }
      return
    }
    this.applyFailurePolicy(dream, kind, message)
    if (poison) {
      const poisonedIds = new Set(poisoned.map((episode) => episode.id))
      for (const episode of poisoned) {
        this.otherFailures.delete(episode.id)
        await this.store.updateEpisode(episode.id, {
          status: 'skipped',
          lastError: failureMessage,
        })
      }
      const retryable = episodeIds.filter((id) => !poisonedIds.has(id))
      if (retryable.length > 0) {
        await this.store.releaseEpisodes(retryable, dream.id, message)
      }
      return
    }
    if (episodeIds.length > 0) {
      await this.store.releaseEpisodes(episodeIds, dream.id, failureMessage)
    }
  }

  /** Reset `processing` episodes whose owning dream is gone, failed or timed out. */
  private async reclaimStale(scopeKey: string): Promise<void> {
    const timeout = this.config.dreamProcessingTimeoutMs ?? 600_000
    const nowMs = this.now().getTime()
    for (const episode of this.store.episodeList({
      workspaceKey: scopeKey,
      statuses: ['processing'],
    })) {
      const dream = episode.dreamId === undefined ? undefined : this.store.getDream(episode.dreamId)
      const stale =
        dream === undefined ||
        dream.status !== 'running' ||
        nowMs - Date.parse(dream.startedAt) > timeout
      if (stale) {
        await this.store.updateEpisode(episode.id, {
          status: 'failed-retryable',
          lastError: 'processing timed out or owning dream is gone',
        })
      }
    }
  }

  /** Resolve the model route for one run, applying the fixed/follow-session mode. */
  private async resolveModel(
    request: DreamRequest,
  ): Promise<{ selection: DreamModelSelection; warning?: string }> {
    let selection: DreamModelSelection | undefined
    let warning: string | undefined
    if (this.config.dreamModelMode === 'fixed') {
      if (this.config.dreamProvider && this.config.dreamModel) {
        selection = { provider: this.config.dreamProvider, model: this.config.dreamModel }
      } else {
        selection = this.defaultSelection?.()
        warning = 'dream provider/model not configured; fell back to the default model'
      }
    } else {
      selection =
        request.modelSelection ??
        (await this.resolveSelectionHook?.(request)) ??
        this.defaultSelection?.()
    }
    const base = selection ?? { provider: 'default', model: 'default' }
    const effort = this.config.dreamReasoningEffort
    return {
      selection: effort === undefined ? base : { ...base, reasoningEffort: effort },
      ...(warning === undefined ? {} : { warning }),
    }
  }

  /**
   * Rank the active and pending memories related to one batch so the model avoids
   * proposing duplicates of already queued or active knowledge.
   */
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
    const active: MemoryRecord[] =
      this.relatedSearch !== undefined && query !== ''
        ? this.relatedSearch({
            query,
            workspaceKey: scope.kind === 'workspace' ? scope.key : null,
            scope: scope.kind === 'global' ? 'global' : 'auto',
            limit: RELATED_MEMORY_LIMIT,
          })
        : this.store.activeRecords().filter((record) => this.visibleInScope(record, scope))
    const pending = this.store
      .pendingRecords()
      .filter((record) => this.visibleInScope(record, scope))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return mergeRelatedMemories(
      active,
      pending,
      (title) => this.redactText(title),
      RELATED_MEMORY_LIMIT,
    )
  }

  /** Build prompt and call the model, retrying once on invalid JSON. */
  private async invokeModel(
    request: DreamRequest,
    dream: DreamRun,
    claimed: readonly EpisodeRecord[],
    selection: DreamModelSelection,
    signal: AbortSignal,
  ): Promise<DreamOutput> {
    if (this.llm === undefined) throw new Error('dream model is unavailable')
    const scope = this.scopeOf(request, claimed)
    const related = this.collectRelated(scope, claimed)
    const prompt = buildDreamPrompt({
      episodes: claimed.map((episode) => this.redactEpisode(episode)),
      related,
      health: checkDreamHealth(this.store, scope),
    })
    const messages: GenerateOptions['messages'] = [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ]
    const baseOptions: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      system: buildDreamSystemPrompt({ allowWorklog: this.config.worklogCapture !== 'off' }),
      messages,
      maxTokens: this.config.dreamMaxTokens ?? 4096,
      signal,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort as never }),
    }
    const first = await this.callModel(baseOptions)
    try {
      return this.parseOutput(first, claimed, scope)
    } catch (error) {
      const repair: GenerateOptions = {
        ...baseOptions,
        messages: [
          ...messages,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Your previous answer (below) was not valid: ${this.messageOf(error)}. Return only the single JSON object described, with no prose.\n\n${first}`,
              },
            ],
          },
        ],
      }
      const second = await this.callModel(repair)
      return this.parseOutput(second, claimed, scope)
    }
  }

  private async callModel(options: GenerateOptions): Promise<string> {
    let text = ''
    this.lastUsage = undefined
    for await (const chunk of this.llm!.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') {
        this.lastUsage = {
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
        }
      } else if (
        chunk.type === 'finish' &&
        (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
      ) {
        throw modelCallFailure(chunk.reason.failure)
      }
    }
    return text
  }

  /** Derive the memory scope a run writes into. */
  private scopeOf(request: DreamRequest, claimed: readonly EpisodeRecord[]): MemoryScope {
    if (request.scopeKind === 'global' || request.scopeKey === 'global') return { kind: 'global' }
    const root = request.scopeRoot ?? claimed[0]?.workspaceRoot ?? request.scopeKey
    return { kind: 'workspace', key: request.scopeKey, root }
  }

  private visibleInScope(record: MemoryRecord, scope: MemoryScope): boolean {
    if (record.scope.kind === 'global') return record.type === 'preference'
    if (scope.kind === 'global') return false
    return record.scope.key === scope.key
  }

  private parseOutput(
    text: string,
    claimed: readonly EpisodeRecord[],
    scope: MemoryScope,
  ): DreamOutput {
    let parsed: unknown
    try {
      parsed = JSON.parse(stripFences(text))
    } catch {
      throw new Error('model output was not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object')
      throw new Error('model output must be an object')
    const record = parsed as Record<string, unknown>
    const memoriesRaw = Array.isArray(record.memories) ? record.memories : []
    const wikiRaw = Array.isArray(record.wikiUpdates) ? record.wikiUpdates : []
    const raw = [
      ...memoriesRaw.map((entry) => ({ entry, forced: undefined as MemoryType | undefined })),
      ...wikiRaw.map((entry) => ({ entry, forced: 'wiki' as MemoryType })),
    ]
    if (raw.length === 0) return { memories: [] }
    const allowWorklog = this.config.worklogCapture !== 'off'
    const knownEpisodes = new Set(claimed.map((episode) => episode.id as string))
    const memories = raw
      .filter(({ entry, forced }) => {
        if (allowWorklog) return true
        const candidateType =
          forced ??
          (entry !== null && typeof entry === 'object'
            ? (entry as Record<string, unknown>).type
            : undefined)
        return candidateType !== 'worklog'
      })
      .map(({ entry, forced }) => this.normalizeEntry(entry, forced, scope, knownEpisodes))
    return { memories }
  }

  private normalizeEntry(
    entry: unknown,
    forcedType: MemoryType | undefined,
    scope: MemoryScope,
    knownEpisodes: ReadonlySet<string>,
  ): DreamProposalOutput {
    if (entry === null || typeof entry !== 'object')
      throw new Error('memory entry must be an object')
    const record = entry as Record<string, unknown>
    const type = forcedType ?? record.type
    if (typeof type !== 'string' || !MEMORY_TYPES.has(type as MemoryType)) {
      throw new Error('memory entry has an invalid type')
    }
    if (scope.kind === 'global' && type !== 'preference') {
      throw new Error('only preference memories may be global')
    }
    const title = this.redactText(typeof record.title === 'string' ? record.title.trim() : '')
    if (title.length < 1 || [...title].length > MAX_TITLE_CHARS) {
      throw new Error('memory entry has an invalid title')
    }
    const body = this.redactText(typeof record.body === 'string' ? record.body : '')
    if (Buffer.byteLength(body, 'utf8') < 1 || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error('memory entry has an invalid body')
    }
    const confidence = this.ratio(record.confidence, 'confidence')
    const importance = this.ratio(record.importance, 'importance')
    const sourceEpisodeIds = Array.isArray(record.sourceEpisodeIds)
      ? record.sourceEpisodeIds.filter((id): id is string => typeof id === 'string')
      : []
    if (sourceEpisodeIds.length === 0)
      throw new Error('memory entry must reference a source episode')
    for (const id of sourceEpisodeIds) {
      if (!knownEpisodes.has(id)) throw new Error(`memory entry cites unknown episode ${id}`)
    }
    const tags = Array.isArray(record.tags)
      ? record.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => this.redactText(tag))
      : undefined
    const supersedes = Array.isArray(record.supersedes)
      ? record.supersedes.filter((id): id is string => typeof id === 'string')
      : undefined
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

  private ratio(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`memory entry has an invalid ${field}`)
    }
    return value
  }

  /** Write each validated proposal with exact + semantic duplicate handling. */
  private async persistOutput(
    output: DreamOutput,
    dream: DreamRun,
    claimed: readonly EpisodeRecord[],
    operationId: string,
    signal: AbortSignal,
  ): Promise<WriteSummary> {
    const summary: WriteSummary = {
      created: 0,
      updated: 0,
      accepted: 0,
      skipped: 0,
      usedEpisodeIds: [],
    }
    const autoAccept = this.config.autoAcceptProposals === true
    const tryAutoAccept = async (id: MemoryRecord['id']): Promise<void> => {
      if (!autoAccept) return
      try {
        await this.store.acceptProposal(id, {
          actor: 'system',
          markReviewed: false,
          dreamId: dream.id,
        })
        summary.accepted += 1
      } catch (error) {
        this.logger.warn?.(
          `memloom: auto-accept left proposal ${id} pending: ${this.messageOf(error)}`,
        )
      }
    }
    const used = new Set<string>()
    const byId = new Map(claimed.map((episode) => [episode.id as string, episode]))
    for (const proposal of output.memories) {
      if (signal.aborted) throw new Error('dream cancelled')
      for (const id of proposal.sourceEpisodeIds) used.add(id)
      const key = computeProposalKey(proposal)
      const exact = this.store.findMemoryByProposalKey(key)
      if (exact !== undefined) {
        summary.skipped += 1
        continue
      }
      const existing =
        this.store.findSemanticProposal(
          proposal.scope,
          proposal.type,
          normalizeTitle(proposal.title),
          proposal.sourceEpisodeIds,
        ) ?? this.store.findSimilarProposal(proposal.scope, proposal.type, proposal.body)
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
          summary.updated += 1
          await tryAutoAccept(existing.id)
        } else {
          summary.skipped += 1
          this.logger.warn?.(`memloom: duplicate dream proposal skipped for ${existing.id}`)
        }
        continue
      }
      const record = this.buildRecord(proposal, dream, key, byId)
      await this.store.writeDreamProposal(record, dream.id, operationId)
      summary.created += 1
      await tryAutoAccept(record.id)
    }
    summary.usedEpisodeIds = [...used]
    return summary
  }

  private buildRecord(
    proposal: DreamProposalOutput,
    dream: DreamRun,
    key: string,
    episodes: ReadonlyMap<string, EpisodeRecord>,
  ): MemoryRecord {
    const nowIso = this.nowIso()
    const sourceRefs = proposal.sourceEpisodeIds
      .map((id) => episodes.get(id))
      .filter((episode): episode is EpisodeRecord => episode !== undefined)
      .map((episode) => ({
        sessionId: episode.sessionId,
        turn: episode.turn,
        ...(episode.sourceSeqs[0] === undefined ? {} : { eventSeq: episode.sourceSeqs[0] }),
      }))
    return {
      id: globalThis.crypto.randomUUID() as MemoryRecord['id'],
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
      sourceEpisodeIds: proposal.sourceEpisodeIds,
      supersedes: proposal.supersedes ?? [],
      proposalKey: key,
      contentHash: '',
    }
  }
}
