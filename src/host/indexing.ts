/**
 * DSH host adapter for durable memory index composition and rendering.
 * @module dsh-memory/host/indexing
 */
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryIndexChange } from '../shared/types.ts'
import {
  baselineIdOf,
  composeMemoryIndex,
  DEFAULT_INDEX_MAX_BYTES,
  escapeInjection,
  HIGH_LESSON_LIMIT,
  HIGH_PREFERENCE_LIMIT,
  INDEX_RULES_VERSION,
  indexDigest,
  PROTOCOL_VERSION,
  RECENT_TURN_LIMIT,
  RECENT_TURN_WINDOW_DAYS,
  RELATED_LIMIT,
  renderBaseline as coreRenderBaseline,
  renderDelta as coreRenderDelta,
  renderReset as coreRenderReset,
  SUMMARY_LENGTH,
  summaryOf,
  type IndexEntry,
  type MemoryIndexSnapshot,
  type MemoryIndexSourceService,
} from '../core/indexing.ts'
import type { MemoryIndexMessage } from './index-types.ts'
import { workspaceIdentityOf } from './workspace.ts'

export {
  baselineIdOf,
  DEFAULT_INDEX_MAX_BYTES,
  escapeInjection,
  HIGH_LESSON_LIMIT,
  HIGH_PREFERENCE_LIMIT,
  INDEX_RULES_VERSION,
  indexDigest,
  PROTOCOL_VERSION,
  RECENT_TURN_LIMIT,
  RECENT_TURN_WINDOW_DAYS,
  RELATED_LIMIT,
  SUMMARY_LENGTH,
  summaryOf,
  type IndexEntry,
  type MemoryIndexMessage,
  type MemoryIndexSnapshot,
  type MemoryIndexSourceService,
}

/** Options for {@link IndexComposer}. */
export interface IndexComposerOptions {
  ctx: Context
  service: MemoryIndexSourceService
  indexMaxBytes?: number
  now?: () => Date
}

/** Extract the first direct human prompt that should drive BM25 recall. */
export function firstUserQuery(messages: readonly UserMessage[]): string {
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/** Render a complete baseline inside the fixed reminder frame. */
export function renderBaseline(snapshot: MemoryIndexSnapshot): string {
  return coreRenderBaseline(snapshot)
}

/** Render a full reset, listing the invalidated previous versions. */
export function renderReset(
  snapshot: MemoryIndexSnapshot,
  invalidations: readonly { memoryId: string; contentRevision: number }[] = [],
): string {
  return coreRenderReset(snapshot, undefined, invalidations)
}

/** Render a delta message from expected-snapshot entries and visible changes. */
export function renderDelta(
  snapshot: MemoryIndexSnapshot,
  changes: readonly MemoryIndexChange[],
): string {
  const byId = new Map(snapshot.entries.map((entry) => [entry.memoryId, entry]))
  return coreRenderDelta(changes, byId)
}

/**
 * Compose, render and budget the index for one agent request.
 */
export class IndexComposer {
  private readonly ctx: Context
  private readonly service: MemoryIndexSourceService
  private readonly indexMaxBytes: number
  private readonly now: () => Date

  constructor(options: IndexComposerOptions) {
    this.ctx = options.ctx
    this.service = options.service
    this.indexMaxBytes = options.indexMaxBytes ?? DEFAULT_INDEX_MAX_BYTES
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Build an empty snapshot identity for the current workspace, used when a
   * reset must invalidate a previous baseline while the index is now empty.
   * @param agent - Calling agent, used to resolve the workspace scope.
   */
  async emptySnapshot(agent: unknown): Promise<MemoryIndexSnapshot> {
    const workspace = await workspaceIdentityOf(this.ctx, agent)
    const scopeKey = workspace?.key ?? ''
    return { baselineId: baselineIdOf(scopeKey, this.indexMaxBytes), scopeKey, entries: [] }
  }

  /**
   * Build the expected index snapshot for an agent and its claimed messages.
   * @param agent - Calling agent, used to resolve the workspace scope.
   * @param messages - Messages entering the proposed step.
   * @returns The snapshot, or `undefined` when the index is empty.
   */
  async composeIndex(
    agent: unknown,
    messages: readonly UserMessage[],
  ): Promise<MemoryIndexSnapshot | undefined> {
    const workspace = await workspaceIdentityOf(this.ctx, agent)
    const workspaceKey = workspace?.key ?? null
    const snapshot = composeMemoryIndex({
      service: this.service,
      workspaceKey,
      queryText: firstUserQuery(messages),
      indexMaxBytes: this.indexMaxBytes,
      now: this.now,
    })
    return snapshot.entries.length === 0 ? undefined : snapshot
  }
}
