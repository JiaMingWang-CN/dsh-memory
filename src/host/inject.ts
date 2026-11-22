/**
 * Memory-index injection over the `agent/pre-step` waterfall.
 *
 * A new session receives one durable, replayable baseline as a synthetic
 * `user/message` carrying a {@link MemoryIndexSource}. With
 * `refreshIndexOnChange` enabled, later steps admit deltas or resets computed by
 * folding the durable surface. Injection always happens inside an
 * already-occurring pre-step: it never calls `followup()` or otherwise wakes an
 * agent, and a rejected step never becomes a durable message.
 * @module dsh-memory/host/inject
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryConfig } from './config.ts'
import {
  IndexComposer,
  PROTOCOL_VERSION,
  renderBaseline,
  renderReset,
  type MemoryIndexSnapshot,
  type MemoryIndexSourceService,
} from './indexing.ts'
import { foldVisibleState, type IndexVisibleState } from './index-state.ts'
import { IndexRefresher, resetInvalidations } from './index-refresh.ts'
import type { MemoryIndexSource } from '../shared/types.ts'

/** One synthetic memory-index user message and its source. */
export interface BuiltIndexMessage {
  message: UserMessage
  source: MemoryIndexSource
  snapshot: MemoryIndexSnapshot
}

/** Resolved knobs the injector reads; every value has the design default. */
export interface InjectSettings {
  indexMaxBytes: number
  injectForSubagents: boolean
  refreshIndexOnChange: boolean
  refreshMaxBytes: number
  refreshResetBytes: number
  refreshMinIntervalMs: number
}

/** Options for {@link MemoryIndexInjector}. */
export interface MemoryIndexInjectorOptions {
  ctx: Context
  service: MemoryIndexSourceService
  config?: Partial<MemoryConfig> | null
  now?: () => Date
}

/** Normalize the plugin config into the injector's resolved settings. */
export function resolveInjectSettings(config?: Partial<MemoryConfig> | null): InjectSettings {
  return {
    indexMaxBytes: config?.indexMaxBytes ?? 4096,
    injectForSubagents: config?.injectForSubagents === true,
    refreshIndexOnChange: config?.refreshIndexOnChange === true,
    refreshMaxBytes: config?.refreshMaxBytes ?? 2048,
    refreshResetBytes: config?.refreshResetBytes ?? 8192,
    refreshMinIntervalMs: config?.refreshMinIntervalMs ?? 60_000,
  }
}

/** Delegation depth recorded on an agent's durable session header. */
function delegationDepthOf(agent: Agent): number {
  return agent.session.header.delegationDepth ?? 0
}

/** Every durable user message currently on the agent's surface. */
function surfaceUserMessages(agent: Agent): UserMessage[] {
  return agent.session
    .deriveMessages()
    .filter((message): message is UserMessage => message.role === 'user')
}

/** Whether a session surface carries a compaction marker that may have shadowed prior memory baselines. */
function hasCompactionMarker(agent: Agent, surface: readonly UserMessage[]): boolean {
  if (
    surface.some((message) => {
      const kind = (message.source as { kind?: string } | undefined)?.kind
      return kind === 'compaction' || kind === 'compact'
    })
  ) {
    return true
  }
  const events = (agent.session as unknown as { events?: readonly { type?: string }[] }).events
  if (Array.isArray(events)) {
    return events.some(
      (event) =>
        event.type === 'compaction' ||
        event.type === 'context/compact' ||
        event.type === 'session/compact',
    )
  }
  return false
}

/**
 * Compose, render and admit the memory index for one agent session.
 *
 * The class is deliberately stateless about which sessions were injected: the
 * session surface (durable messages) is the fact source, so resume and
 * compaction recompute visibility instead of trusting process memory.
 */
export class MemoryIndexInjector {
  private readonly ctx: Context
  private readonly service: MemoryIndexSourceService
  private readonly settings: InjectSettings
  private readonly composer: IndexComposer
  private readonly refresher: IndexRefresher
  private readonly injectedSessions = new Set<string>()
  private readonly injectedSessionObjects = new WeakSet<object>()

  constructor(options: MemoryIndexInjectorOptions) {
    this.ctx = options.ctx
    this.service = options.service
    this.settings = resolveInjectSettings(options.config)
    const now = options.now ?? (() => new Date())
    this.composer = new IndexComposer({
      ctx: options.ctx,
      service: options.service,
      indexMaxBytes: this.settings.indexMaxBytes,
      now,
    })
    this.refresher = new IndexRefresher({
      budget: {
        refreshMaxBytes: this.settings.refreshMaxBytes,
        refreshResetBytes: this.settings.refreshResetBytes,
        refreshMinIntervalMs: this.settings.refreshMinIntervalMs,
      },
      now,
    })
  }

  /** Whether an agent should receive any memory-index messages. */
  shouldInject(agent: Agent | undefined): boolean {
    if (agent === undefined || agent === null) return false
    if (!this.settings.injectForSubagents && delegationDepthOf(agent) > 0) return false
    return true
  }

  /**
   * Build the durable baseline message for the first request of a session.
   * @param agent - Calling agent.
   * @param messages - Messages entering the proposed step.
   * @returns The message and source, or `undefined` when the index is empty or
   *   the agent is excluded from injection.
   */
  async buildBaselineMessage(
    agent: Agent,
    messages: readonly UserMessage[],
  ): Promise<BuiltIndexMessage | undefined> {
    if (!this.shouldInject(agent)) return undefined
    const snapshot = await this.composer.composeIndex(agent, messages)
    if (snapshot === undefined) return undefined
    const text = renderBaseline(snapshot)
    const source = this.baselineSource(snapshot)
    const message = createUserMessage({ content: [{ type: 'text', text }], source })
    return { message, source, snapshot }
  }

  /** Build a `baseline`-mode source whose changes add every snapshot entry. */
  private baselineSource(snapshot: MemoryIndexSnapshot): MemoryIndexSource {
    return {
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
  }

  /**
   * Handle one `agent/pre-step`: delegate to the next listener, then admit a
   * baseline, delta or reset only when the step is accepted.
   */
  async handlePreStep(
    payload: { agent: Agent; messages: UserMessage[]; step: number },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (!this.shouldInject(payload.agent)) return decision
    if (decision.kind === 'reject') return decision
    try {
      return await this.admit(payload.agent, payload.step, decision)
    } catch (error) {
      this.logFailure(error)
      return decision
    }
  }

  /** Decide and admit the baseline, reset or refresh for one accepted step. */
  private async admit(
    agent: Agent,
    step: number,
    decision: Extract<PreStepDecision, { kind: 'enter' }>,
  ): Promise<PreStepDecision> {
    // A downstream listener may have consumed or filtered every message. The
    // loop skips that request; appending an index would revive it.
    if (decision.messages.length === 0) return decision

    const surface = surfaceUserMessages(agent)
    const history = [...surface, ...decision.messages]
    const visible = foldVisibleState(history)
    const hasSurfaceMemory = surface.some((message) => message.source.kind === 'dsh-memory')
    const sessionObj = agent.session as object | undefined
    const sessionId = (agent.session as { id?: string } | undefined)?.id
    const rememberInjected = (): void => {
      if (sessionId !== undefined) this.injectedSessions.add(sessionId)
      if (sessionObj !== undefined) this.injectedSessionObjects.add(sessionObj)
    }
    const wasInjected =
      (sessionId !== undefined && this.injectedSessions.has(sessionId)) ||
      (sessionObj !== undefined && this.injectedSessionObjects.has(sessionObj))

    if (visible === undefined) {
      if (!hasSurfaceMemory && step === 1) {
        const built = await this.buildBaselineMessage(agent, history)
        if (built !== undefined) {
          rememberInjected()
          return { ...decision, messages: [...decision.messages, built.message] }
        }
        return decision
      }
      const compactedBaseline =
        !hasSurfaceMemory && (wasInjected || hasCompactionMarker(agent, surface))
      if (!hasSurfaceMemory && !compactedBaseline && !this.settings.refreshIndexOnChange) {
        return decision
      }
      // A surface carries memory messages we cannot fold, or compaction wiped
      // a previously injected baseline: never guess, reset.
      const expected = await this.composer.composeIndex(agent, history)
      if (!hasSurfaceMemory && expected === undefined) return decision
      if (expected !== undefined) rememberInjected()
      return this.injectReset(agent, decision, expected, undefined)
    }
    rememberInjected()

    // Scope and identity changes invalidate the old baseline even when ordinary
    // refresh is disabled; they are a workspace-isolation boundary, not a
    // freshness preference.
    const identity = await this.composer.emptySnapshot(agent)
    if (identity.scopeKey !== visible.scopeKey || identity.baselineId !== visible.baselineId) {
      const expected = await this.composer.composeIndex(agent, history)
      return this.injectReset(agent, decision, expected, visible)
    }

    if (!this.settings.refreshIndexOnChange) return decision
    const expected = await this.composer.composeIndex(agent, history)
    return this.refresh(decision, expected, visible)
  }

  /** Admit a due delta/reset; non-urgent changes inside the interval wait for a later request. */
  private refresh(
    decision: Extract<PreStepDecision, { kind: 'enter' }>,
    expected: MemoryIndexSnapshot | undefined,
    visible: IndexVisibleState,
  ): PreStepDecision {
    const outcome = this.refresher.plan(expected, visible)
    if (outcome.messages.length === 0) return decision
    if (!outcome.urgent && outcome.withinInterval) return decision
    return { ...decision, messages: [...decision.messages, ...outcome.messages] }
  }

  /** Build and admit a full reset, invalidating the previous cycle. */
  private async injectReset(
    agent: Agent,
    decision: Extract<PreStepDecision, { kind: 'enter' }>,
    expected: MemoryIndexSnapshot | undefined,
    visible: IndexVisibleState | undefined,
  ): Promise<PreStepDecision> {
    const target = expected ?? (await this.composer.emptySnapshot(agent))
    const invalidations = visible === undefined ? [] : resetInvalidations(visible, target)
    const text = renderReset(target, invalidations)
    const source: MemoryIndexSource = {
      kind: 'dsh-memory',
      form: 'memory-index',
      mode: 'reset',
      protocolVersion: PROTOCOL_VERSION,
      baselineId: target.baselineId,
      scopeKey: target.scopeKey,
      changes: target.entries.map((entry) => ({
        action: 'add' as const,
        memoryId: entry.memoryId,
        contentRevision: entry.contentRevision,
        digest: entry.digest,
      })),
      invalidations,
    }
    const message = createUserMessage({ content: [{ type: 'text', text }], source })
    return { ...decision, messages: [...decision.messages, message] }
  }

  /** Register the pre-step listener on the plugin context; returns a disposer. */
  register(): () => void {
    return this.ctx.on('agent/pre-step', (payload, next) => this.handlePreStep(payload, next))
  }

  private logFailure(error: unknown): void {
    const logger = (this.ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
    logger?.warn?.(`dsh-memory: index injection failed: ${String(error)}`)
  }
}

/**
 * Register index injection on a plugin context.
 * @param ctx - Plugin context carrying the agent events.
 * @param service - Memory service used for candidate reads.
 * @param config - Resolved plugin config.
 * @returns A disposer that removes the listener.
 */
export function registerIndexInjection(
  ctx: Context,
  service: MemoryIndexSourceService,
  config?: Partial<MemoryConfig> | null,
): () => void {
  return new MemoryIndexInjector({
    ctx,
    service,
    ...(config === undefined ? {} : { config }),
  }).register()
}
