/**
 * Mechanical dream health checks.
 *
 * The checks run in code before a dream prompt is built, so the model spends
 * its single call on consolidation instead of rediscovering queue backlogs and
 * duplicate titles. The result carries counts and titles only — never memory
 * bodies or episode text.
 * @module dsh-memory/core/dream-health
 */
import { normalizeTitle } from './proposal.ts'
import { redactSecrets } from './redact.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from '../shared/types.ts'

/** Pre-computed health state for one dream scope. */
export interface DreamHealth {
  /** Episodes still waiting in the queue (`new` or `failed-retryable`). */
  pendingEpisodes: number
  /** Pending episodes sharing the same `toolName` + `toolError` signature. */
  duplicateToolFailures: number
  /** Draft proposals in `pending` status. */
  pendingProposals: number
  /** Normalized titles shared by a pending proposal and another record. */
  duplicatePendingTitles: string[]
  /** Active record counts by memory type. */
  activeByType: Record<MemoryType, number>
  /** Whether the workspace has no active daily worklog. */
  missingDaily: boolean
  /** Human-readable English issue lines for the dream prompt. */
  issues: string[]
}

const PAGE_SIZE = 50

/** Selector understood by {@link MemoryStore.list} for one dream scope. */
function scopeTarget(scope: MemoryScope): string | null {
  return scope.kind === 'workspace' ? scope.key : null
}

/** Read every record of one status visible in the scope, across list pages. */
function recordsWithStatus(
  store: MemoryStore,
  scope: MemoryScope,
  status: MemoryStatus,
): MemoryRecord[] {
  const target = scopeTarget(scope)
  const records: MemoryRecord[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = store.list({ workspaceKey: target, status, limit: PAGE_SIZE, offset })
    records.push(...page.items)
    if (!page.truncated) break
  }
  return records
}

/**
 * Count queued episodes and repeated tool-failure signatures in one workspace.
 * A global dream has no episode queue, so both counters stay zero there.
 */
function episodeHealth(
  store: MemoryStore,
  scope: MemoryScope,
): { pendingEpisodes: number; duplicateToolFailures: number } {
  if (scope.kind !== 'workspace') return { pendingEpisodes: 0, duplicateToolFailures: 0 }
  const episodes = store.episodeList({
    workspaceKey: scope.key,
    statuses: ['new', 'failed-retryable'],
  })
  const signatures = new Map<string, number>()
  for (const episode of episodes) {
    if (episode.toolName === undefined || episode.toolError === undefined) continue
    const signature = `${episode.toolName}\u0000${episode.toolError}`
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
  }
  let duplicateToolFailures = 0
  for (const count of signatures.values()) {
    if (count > 1) duplicateToolFailures += count
  }
  return { pendingEpisodes: episodes.length, duplicateToolFailures }
}

/** Normalized titles that a pending proposal shares with another active or pending record. */
function findDuplicatePendingTitles(
  active: readonly MemoryRecord[],
  pending: readonly MemoryRecord[],
): string[] {
  const byTitle = new Map<string, MemoryRecord[]>()
  for (const record of [...active, ...pending]) {
    const key = normalizeTitle(record.title).toLowerCase()
    const group = byTitle.get(key)
    if (group === undefined) byTitle.set(key, [record])
    else group.push(record)
  }
  const duplicates: string[] = []
  for (const group of byTitle.values()) {
    if (group.length < 2) continue
    const proposal = group.find((record) => record.status === 'pending')
    if (proposal === undefined) continue
    const title = redactSecrets(normalizeTitle(proposal.title))
    if (!duplicates.includes(title)) duplicates.push(title)
  }
  return duplicates.sort()
}

/**
 * Compute the health state for one dream scope without calling the model.
 * @param store - Ready memory store.
 * @param scope - Scope the dream will consolidate.
 * @returns Counts, duplicate titles, active-by-type counts and issue lines.
 */
export function checkDreamHealth(store: MemoryStore, scope: MemoryScope): DreamHealth {
  const { pendingEpisodes, duplicateToolFailures } = episodeHealth(store, scope)
  const pending = recordsWithStatus(store, scope, 'pending')
  const active = recordsWithStatus(store, scope, 'active')

  const activeByType: Record<MemoryType, number> = { lesson: 0, worklog: 0, wiki: 0, preference: 0 }
  for (const record of active) activeByType[record.type] += 1

  const duplicatePendingTitles = findDuplicatePendingTitles(active, pending)
  const missingDaily =
    scope.kind === 'workspace' &&
    !active.some((record) => record.type === 'worklog' && record.worklogKind === 'daily')

  const issues: string[] = []
  if (pendingEpisodes > 0) {
    issues.push(
      `${pendingEpisodes} pending episode(s) are waiting in the dream queue (new or failed-retryable).`,
    )
  }
  if (duplicateToolFailures > 0) {
    issues.push(
      `${duplicateToolFailures} duplicate tool failure(s) share the same toolName + toolError signature.`,
    )
  }
  if (pending.length > 0) {
    issues.push(`${pending.length} pending dream proposal(s) are waiting for review.`)
  }
  for (const title of duplicatePendingTitles) {
    issues.push(`duplicate pending title: "${title}".`)
  }
  if (missingDaily) issues.push('no active daily worklog exists for this workspace.')

  return {
    pendingEpisodes,
    duplicateToolFailures,
    pendingProposals: pending.length,
    duplicatePendingTitles,
    activeByType,
    missingDaily,
    issues,
  }
}

/**
 * Render health issues as prompt bullet lines.
 * @param health - Computed health state.
 * @returns Bullet lines, or an empty string when nothing is wrong.
 */
export function renderDreamHealth(health: DreamHealth): string {
  return health.issues.map((issue) => `- ${issue}`).join('\n')
}
