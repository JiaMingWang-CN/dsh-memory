/**
 * DSH host adapter for folding durable memory-index messages and recovering
 * visible index state from a session surface.
 * @module dsh-memory/host/index-state
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  diffIndex,
  foldRawIndexSources,
  parseMemoryIndexSource,
  type IndexVisibleState,
  type ResetReason,
  type VisibleEntry,
} from '../core/index-protocol.ts'
import type { MemoryIndexSnapshot } from './indexing.ts'
import './index-types.ts'

export {
  diffIndex,
  parseMemoryIndexSource,
  type IndexVisibleState,
  type ResetReason,
  type VisibleEntry,
}

/** Join the text blocks of one message for byte accounting. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Fold the visible memory-index messages, in order, into one index state.
 * @param messages - Surface messages in model-visible order (durable plus claimed).
 * @returns The folded state, or `undefined` when no compatible baseline exists.
 */
export function foldVisibleState(messages: readonly UserMessage[]): IndexVisibleState | undefined {
  return foldRawIndexSources(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => ({
        source: message.source as unknown,
        fallbackBytes: () => Buffer.byteLength(messageText(message), 'utf8'),
      })),
  )
}

/**
 * Recover the visible index state from a session's durable surface.
 * @param session - Live or restored session.
 * @returns The folded state, or `undefined` when no compatible baseline exists.
 */
export function recoverIndexState(
  session: Pick<Session, 'deriveMessages'>,
): IndexVisibleState | undefined {
  const messages = session
    .deriveMessages()
    .filter((message): message is UserMessage => message.role === 'user')
  return foldVisibleState(messages)
}

/**
 * Compare the durable baseline identity against the expected snapshot.
 * @param session - Session whose surface carries the previous baseline.
 * @param expected - Freshly composed expected snapshot.
 * @returns Why a reset is needed, or `none`.
 */
export function resetReason(
  session: Pick<Session, 'deriveMessages'>,
  expected: MemoryIndexSnapshot,
): ResetReason {
  const sources = session
    .deriveMessages()
    .filter((message) => message.role === 'user')
    .map((message) => message.source as unknown)
    .filter(
      (source): source is Record<string, unknown> =>
        source !== null &&
        typeof source === 'object' &&
        (source as { kind?: unknown }).kind === 'dsh-memory',
    )
  const baseline = sources
    .filter((source) => source.mode === 'baseline' || source.mode === 'reset')
    .at(-1)
  if (baseline === undefined) return 'missing-baseline'
  if (baseline.protocolVersion !== 1) return 'protocol-mismatch'
  if (baseline.scopeKey !== expected.scopeKey) return 'scope-change'
  if (baseline.baselineId !== expected.baselineId) return 'budget-change'
  return 'none'
}
