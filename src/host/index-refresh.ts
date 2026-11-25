/**
 * DSH host adapter for delta/reset planning on `agent/pre-step`.
 * @module dsh-memory/host/index-refresh
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  planIndexRefresh,
  resetInvalidations,
  type IndexBudget,
  type IndexVisibleState,
} from '../core/index-protocol.ts'
import type { MemoryIndexSnapshot } from './indexing.ts'
import './index-types.ts'

export { resetInvalidations, type IndexBudget }

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
    const planned = planIndexRefresh({
      visible,
      target,
      budget: this.budget,
      now: this.now(),
    })
    if (planned.mode === 'none' || planned.source === undefined) {
      return {
        messages: [],
        reset: false,
        urgent: false,
        withinInterval: false,
        baselineId: planned.baselineId,
        bytes: 0,
      }
    }
    return {
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: planned.renderedText }],
          source: planned.source,
        }),
      ],
      reset: planned.reset,
      urgent: planned.urgent,
      withinInterval: planned.withinInterval,
      baselineId: planned.baselineId,
      bytes: planned.bytes,
    }
  }
}
