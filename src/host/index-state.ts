/**
 * Fold the durable memory-index messages back into the currently visible index
 * state, and diff that state against a freshly composed snapshot.
 *
 * The session surface is the single source of truth: folding reads message
 * sources and content only, so resume and compaction recompute the same state
 * without any process-local cache. Unknown or incompatible sources are never
 * guessed — the caller is told to emit a reset instead.
 * @module dsh-memory/host/index-state
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MemoryIndexChange, MemoryIndexSource } from '../shared/types.ts'
import type { MemoryIndexSnapshot } from './indexing.ts'

/** One entry currently visible to the model, tracked by its rendered digest. */
export interface VisibleEntry {
  memoryId: string
  contentRevision: number
  digest: string
}

/** The index state folded from durable messages for one baseline cycle. */
export interface IndexVisibleState {
  baselineId: string
  scopeKey: string
  entries: Map<string, VisibleEntry>
  /** Durable delta bytes admitted since the latest baseline/reset. */
  refreshBytes: number
  /** Epoch milliseconds of the latest admitted delta, when one is recorded. */
  refreshedAt: number | undefined
}

/** Validate one unknown message source as a legal memory-index source. */
export function parseMemoryIndexSource(raw: unknown): MemoryIndexSource | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  if (source.kind !== 'dsh-memory' || source.form !== 'memory-index') return undefined
  if (source.protocolVersion !== 1) return undefined
  if (typeof source.baselineId !== 'string' || source.baselineId === '') return undefined
  if (typeof source.scopeKey !== 'string') return undefined
  if (source.mode !== 'baseline' && source.mode !== 'delta' && source.mode !== 'reset') {
    return undefined
  }
  if (!Array.isArray(source.changes) || !Array.isArray(source.invalidations)) return undefined
  if (
    source.refreshBytes !== undefined &&
    (typeof source.refreshBytes !== 'number' ||
      !Number.isFinite(source.refreshBytes) ||
      source.refreshBytes < 0)
  ) {
    return undefined
  }
  if (
    source.refreshedAt !== undefined &&
    (typeof source.refreshedAt !== 'string' || Number.isNaN(Date.parse(source.refreshedAt)))
  ) {
    return undefined
  }
  for (const change of source.changes) {
    if (change === null || typeof change !== 'object') return undefined
    const item = change as Record<string, unknown>
    if (item.action !== 'add' && item.action !== 'replace' && item.action !== 'remove') {
      return undefined
    }
    if (typeof item.memoryId !== 'string' || item.memoryId === '') return undefined
    if (typeof item.contentRevision !== 'number' || !Number.isInteger(item.contentRevision)) {
      return undefined
    }
    if (item.action !== 'remove' && typeof item.digest !== 'string') return undefined
  }
  return source as unknown as MemoryIndexSource
}

function applyChanges(
  entries: Map<string, VisibleEntry>,
  changes: readonly MemoryIndexChange[],
): void {
  for (const change of changes) {
    const existing = entries.get(change.memoryId)
    if (change.action === 'remove') {
      // A stale remove must not delete a newer visible version.
      if (existing === undefined || change.contentRevision < existing.contentRevision) continue
      entries.delete(change.memoryId)
      continue
    }
    // A replayed or out-of-order older revision never overwrites a newer one.
    if (existing !== undefined && change.contentRevision < existing.contentRevision) continue
    if (
      existing !== undefined &&
      existing.contentRevision === change.contentRevision &&
      existing.digest === change.digest
    ) {
      continue
    }
    entries.set(change.memoryId, {
      memoryId: change.memoryId,
      contentRevision: change.contentRevision,
      digest: change.digest,
    })
  }
}

/**
 * Fold the visible memory-index messages, in order, into one index state.
 * @param messages - Surface messages in model-visible order (durable plus claimed).
 * @returns The folded state, or `undefined` when no compatible baseline exists.
 */
export function foldVisibleState(messages: readonly UserMessage[]): IndexVisibleState | undefined {
  let state: IndexVisibleState | undefined
  let incompatible = false
  for (const message of messages) {
    if (message.role !== 'user') continue
    const rawSource = message.source as unknown
    if (
      rawSource === null ||
      typeof rawSource !== 'object' ||
      (rawSource as { kind?: unknown }).kind !== 'dsh-memory'
    ) {
      continue
    }
    const source = parseMemoryIndexSource(rawSource)
    if (source === undefined) {
      // A later baseline or reset can still establish a trustworthy cycle.
      incompatible = true
      state = undefined
      continue
    }

    if (source.mode === 'baseline' || source.mode === 'reset') {
      // A fresh baseline or reset replaces the entire previous cycle, including
      // a scope change; the new snapshot is authoritative.
      state = {
        baselineId: source.baselineId,
        scopeKey: source.scopeKey,
        entries: new Map(),
        refreshBytes: 0,
        refreshedAt: undefined,
      }
      incompatible = false
      applyChanges(state.entries, source.changes)
      continue
    }

    if (state === undefined) {
      // A delta can only apply to an already visible baseline.
      incompatible = true
      continue
    }
    if (state.baselineId !== source.baselineId || state.scopeKey !== source.scopeKey) {
      incompatible = true
      state = undefined
      continue
    }
    applyChanges(state.entries, source.changes)
    state.refreshBytes += source.refreshBytes ?? Buffer.byteLength(messageText(message), 'utf8')
    const refreshedAt =
      source.refreshedAt === undefined ? undefined : Date.parse(source.refreshedAt)
    if (refreshedAt !== undefined) state.refreshedAt = refreshedAt
  }
  if (incompatible) return undefined
  return state
}

/** Join the text blocks of one message for byte accounting. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Diff the expected snapshot against the visible state.
 *
 * Removals come first so a caller can preserve safety invalidations ahead of
 * additions. Only content revision or rendered digest differences create a
 * change; statistics and ordering never do.
 * @param expected - Freshly composed expected snapshot.
 * @param visible - Folded visible state.
 * @returns Ordered changes (removes, then replaces, then adds).
 */
export function diffIndex(
  expected: MemoryIndexSnapshot,
  visible: IndexVisibleState,
): MemoryIndexChange[] {
  const expectedById = new Map(expected.entries.map((entry) => [entry.memoryId, entry]))
  const changes: MemoryIndexChange[] = []

  for (const [memoryId, entry] of visible.entries) {
    if (!expectedById.has(memoryId)) {
      changes.push({ action: 'remove', memoryId, contentRevision: entry.contentRevision })
    }
  }
  for (const entry of expected.entries) {
    const current = visible.entries.get(entry.memoryId)
    if (current === undefined) {
      changes.push({
        action: 'add',
        memoryId: entry.memoryId,
        contentRevision: entry.contentRevision,
        digest: entry.digest,
      })
    } else if (
      current.contentRevision !== entry.contentRevision ||
      current.digest !== entry.digest
    ) {
      changes.push({
        action: 'replace',
        memoryId: entry.memoryId,
        contentRevision: entry.contentRevision,
        digest: entry.digest,
      })
    }
  }
  return changes
}

/** Why a fresh snapshot must replace the visible baseline. */
export type ResetReason =
  'none' | 'scope-change' | 'missing-baseline' | 'protocol-mismatch' | 'budget-change'

/**
 * Recover the visible index state from a session's durable surface.
 *
 * Compaction already shadows replaced nodes out of `deriveMessages()`, so a
 * shadowed baseline disappears and the result is `undefined`; callers must then
 * reset rather than treat stale deltas as a baseline.
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
