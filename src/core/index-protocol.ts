/**
 * Host-agnostic index folding, diffing and refresh planning protocol.
 *
 * Pure state-machine over {@link MemoryIndexSource} records without any DSH
 * `UserMessage` or `Session` dependencies.
 * @module dsh-memory/core/index-protocol
 */
import type { MemoryIndexChange, MemoryIndexSource } from '../shared/types.ts'
import { PROTOCOL_VERSION, renderDelta, renderReset, type MemoryIndexSnapshot } from './indexing.ts'

/** One entry currently visible to the model, tracked by its rendered digest. */
export interface VisibleEntry {
  memoryId: string
  contentRevision: number
  digest: string
}

/** The index state folded from durable sources for one baseline cycle. */
export interface IndexVisibleState {
  baselineId: string
  scopeKey: string
  entries: Map<string, VisibleEntry>
  /** Durable delta bytes admitted since the latest baseline/reset. */
  refreshBytes: number
  /** Epoch milliseconds of the latest admitted delta, when one is recorded. */
  refreshedAt: number | undefined
}

/** Why a fresh snapshot must replace the visible baseline. */
export type ResetReason =
  'none' | 'scope-change' | 'missing-baseline' | 'protocol-mismatch' | 'budget-change'

/** Byte and interval budget for index refresh (design §4.4 / §6.7). */
export interface IndexBudget {
  refreshMaxBytes: number
  refreshResetBytes: number
  refreshMinIntervalMs: number
}

/** Host-agnostic refresh plan returned by {@link planIndexRefresh}. */
export interface PlannedIndexRefresh {
  mode: 'none' | 'delta' | 'reset'
  renderedText: string
  source?: MemoryIndexSource
  reset: boolean
  /** A remove or reset must not be delayed by the minimum interval. */
  urgent: boolean
  /** Whether the latest durable delta is still inside the interval. */
  withinInterval: boolean
  baselineId: string
  bytes: number
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
 * Fold an ordered sequence of raw source entries (with optional fallback byte
 * accounting for host messages that omitted `refreshBytes`) into visible state.
 */
export function foldRawIndexSources(
  items: readonly { readonly source: unknown; readonly fallbackBytes?: () => number }[],
): IndexVisibleState | undefined {
  let state: IndexVisibleState | undefined
  let incompatible = false
  for (const item of items) {
    const rawSource = item.source
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
    state.refreshBytes += source.refreshBytes ?? item.fallbackBytes?.() ?? 0
    const refreshedAt =
      source.refreshedAt === undefined ? undefined : Date.parse(source.refreshedAt)
    if (refreshedAt !== undefined) state.refreshedAt = refreshedAt
  }
  if (incompatible) return undefined
  return state
}

/**
 * Fold stored index sources for a target `scopeKey` and `baselineId`.
 * @param sources - Ordered index sources recorded for the session.
 * @param scopeKey - Expected normalized scope key.
 * @param baselineId - Expected baseline identity.
 * @returns The folded state, or `undefined` when missing, incompatible, or mismatched.
 */
export function foldIndexSources(
  sources: readonly MemoryIndexSource[],
  scopeKey: string,
  baselineId: string,
): IndexVisibleState | undefined {
  const state = foldRawIndexSources(sources.map((source) => ({ source })))
  if (state === undefined) return undefined
  if (state.scopeKey !== scopeKey || state.baselineId !== baselineId) return undefined
  return state
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

/**
 * Plan an index refresh (`none`, `delta`, or `reset`) from folded visible
 * state and a freshly composed target snapshot.
 */
export function planIndexRefresh(input: {
  visible: IndexVisibleState
  target: MemoryIndexSnapshot
  budget: IndexBudget
  now: Date
}): PlannedIndexRefresh {
  const { visible, target, budget, now } = input
  const diff = diffIndex(target, visible)
  if (diff.length === 0) {
    return {
      mode: 'none',
      renderedText: '',
      reset: false,
      urgent: false,
      withinInterval: false,
      baselineId: target.baselineId,
      bytes: 0,
    }
  }

  const removes = diff.filter((change) => change.action === 'remove')
  const entriesById = new Map(target.entries.map((entry) => [entry.memoryId, entry]))
  const deltaText = renderDelta(diff, entriesById)
  const deltaBytes = Buffer.byteLength(deltaText, 'utf8')
  const resetNeeded =
    deltaBytes > budget.refreshMaxBytes ||
    visible.refreshBytes + deltaBytes >= budget.refreshResetBytes

  if (resetNeeded) {
    const invalidations = resetInvalidations(visible, target)
    const text = renderReset(target, undefined, invalidations)
    const bytes = Buffer.byteLength(text, 'utf8')
    const source = makeSource(
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
      now.toISOString(),
    )
    return {
      mode: 'reset',
      renderedText: text,
      source,
      reset: true,
      urgent: true,
      withinInterval: false,
      baselineId: target.baselineId,
      bytes,
    }
  }

  const withinInterval =
    visible.refreshedAt !== undefined &&
    now.getTime() - visible.refreshedAt < budget.refreshMinIntervalMs
  const source = makeSource('delta', target, diff, [], deltaBytes, now.toISOString())
  return {
    mode: 'delta',
    renderedText: deltaText,
    source,
    reset: false,
    urgent: removes.length > 0,
    withinInterval,
    baselineId: target.baselineId,
    bytes: deltaBytes,
  }
}
