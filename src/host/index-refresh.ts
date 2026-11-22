/**
 * Delta planning for the durable memory index when `refreshIndexOnChange` is on.
 *
 * A refresh never wakes an agent: it computes the expected snapshot, diffs it
 * against the folded visible state and either admits a delta message on an
 * already-occurring pre-step or leaves it for a later request when the minimum
 * interval is still active. Safety invalidations are never dropped for budget —
 * an over-budget delta becomes a full reset whose `invalidations` carry every
 * stale version.
 *
 * Refresh accounting is persisted in each delta source: the folded visible
 * state carries the admitted byte total and latest timestamp, so restart,
 * resume and compaction recover the same budget instead of trusting process
 * memory.
 * @module dsh-memory/host/index-refresh
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { diffIndex, type IndexVisibleState } from './index-state.ts'
import { PROTOCOL_VERSION, renderDelta, renderReset, type MemoryIndexSnapshot } from './indexing.ts'
import type { MemoryIndexChange, MemoryIndexSource } from '../shared/types.ts'

/** Byte and interval budget for index refresh (design §4.4 / §6.7). */
export interface IndexBudget {
  refreshMaxBytes: number
  refreshResetBytes: number
  refreshMinIntervalMs: number
}

/** One planned refresh action before the injector decides to admit or defer. */
export interface RefreshOutcome {
  messages: UserMessage[]
  reset: boolean
  /** A remove or reset must not be delayed by the minimum interval. */
  urgent: boolean
  /** Whether the latest durable delta is still inside the interval. */
  withinInterval: boolean
  baselineId: string
  bytes: number
}

/** Options for {@link IndexRefresher}. */
export interface IndexRefresherOptions {
  budget: IndexBudget
  now?: () => Date
}

/** Build the reset invalidations from the visible state that the new snapshot drops. */
export function resetInvalidations(
  visible: IndexVisibleState,
  target: MemoryIndexSnapshot,
): { memoryId: string; contentRevision: number }[] {
  const byId = new Map(target.entries.map((entry) => [entry.memoryId, entry]))
  const invalidations: { memoryId: string; contentRevision: number }[] = []
  for (const [memoryId, entry] of visible.entries) {
    const next = byId.get(memoryId)
    if (next === undefined || next.contentRevision !== entry.contentRevision) {
      invalidations.push({ memoryId, contentRevision: entry.contentRevision })
    }
  }
  return invalidations
}

function makeSource(
  mode: 'delta' | 'reset',
  target: MemoryIndexSnapshot,
  changes: MemoryIndexChange[],
  invalidations: { memoryId: string; contentRevision: number }[],
  refreshBytes: number,
  refreshedAt: string,
): MemoryIndexSource {
  return {
    kind: 'dsh-memory',
    form: 'memory-index',
    mode,
    protocolVersion: PROTOCOL_VERSION,
    baselineId: target.baselineId,
    scopeKey: target.scopeKey,
    changes,
    invalidations,
    refreshBytes,
    refreshedAt,
  }
}

/** Plan and track delta/reset injections for one session. */
export class IndexRefresher {
  private readonly budget: IndexBudget
  private readonly now: () => Date

  constructor(options: IndexRefresherOptions) {
    this.budget = options.budget
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Plan one refresh from the expected snapshot and the visible state.
   * @param expected - Expected snapshot, or `undefined` when the index is empty.
   * @param visible - Folded visible state, including durable refresh accounting.
   * @returns The planned messages and whether they may be delayed.
   */
  plan(expected: MemoryIndexSnapshot | undefined, visible: IndexVisibleState): RefreshOutcome {
    const target: MemoryIndexSnapshot = expected ?? {
      baselineId: visible.baselineId,
      scopeKey: visible.scopeKey,
      entries: [],
    }
    const diff = diffIndex(target, visible)
    if (diff.length === 0) {
      return {
        messages: [],
        reset: false,
        urgent: false,
        withinInterval: false,
        baselineId: target.baselineId,
        bytes: 0,
      }
    }

    const removes = diff.filter((change) => change.action === 'remove')
    const deltaText = renderDelta(target, diff)
    const deltaBytes = Buffer.byteLength(deltaText, 'utf8')
    const resetNeeded =
      deltaBytes > this.budget.refreshMaxBytes ||
      visible.refreshBytes + deltaBytes >= this.budget.refreshResetBytes

    const timestamp = this.now()
    if (resetNeeded) {
      const invalidations = resetInvalidations(visible, target)
      const text = renderReset(target, invalidations)
      return {
        messages: [
          createUserMessage({
            content: [{ type: 'text', text }],
            source: makeSource(
              'reset',
              target,
              target.entries.map((entry) => ({
                action: 'add' as const,
                memoryId: entry.memoryId,
                contentRevision: entry.contentRevision,
                digest: entry.digest,
              })),
              invalidations,
              0,
              timestamp.toISOString(),
            ),
          }),
        ],
        reset: true,
        urgent: true,
        withinInterval: false,
        baselineId: target.baselineId,
        bytes: Buffer.byteLength(text, 'utf8'),
      }
    }

    return {
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: deltaText }],
          source: makeSource('delta', target, diff, [], deltaBytes, timestamp.toISOString()),
        }),
      ],
      reset: false,
      urgent: removes.length > 0,
      withinInterval:
        visible.refreshedAt !== undefined &&
        timestamp.getTime() - visible.refreshedAt < this.budget.refreshMinIntervalMs,
      baselineId: target.baselineId,
      bytes: deltaBytes,
    }
  }
}
