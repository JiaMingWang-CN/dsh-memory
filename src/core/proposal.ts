/**
 * Stable dream-proposal identity and duplicate policy.
 *
 * `proposalKey` is a SHA-256 over the type, scope, normalized title, content
 * hash and sorted source episode ids. It recognises exact duplicates in any
 * status. A reworded proposal for the same scope/type/title whose source
 * episodes overlap is a *semantic* duplicate handled by
 * {@link applyDuplicatePolicy}.
 * @module memloom/core/proposal
 */
import { createHash } from 'node:crypto'
import type { MemoryRecord, MemoryScope, MemoryType, WorklogKind } from '../shared/types.ts'

/** One validated dream proposal before it becomes a memory record. */
export interface DreamProposalOutput {
  type: MemoryType
  worklogKind?: WorklogKind
  scope: MemoryScope
  title: string
  body: string
  tags?: string[]
  confidence: number
  importance: number
  sourceEpisodeIds: string[]
  supersedes?: string[]
}

/** Trim and collapse internal whitespace in a title. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ')
}

/** SHA-256 of a proposal body. */
export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** Canonical scope key used inside the proposal material. */
export function proposalScopeKey(scope: MemoryScope): string {
  return scope.kind === 'global' ? 'global' : `workspace:${scope.key}`
}

/**
 * Compute the stable proposal key for one output.
 * @param output - Validated proposal output.
 * @returns Lowercase hex SHA-256.
 */
export function computeProposalKey(output: DreamProposalOutput): string {
  const parts = [
    output.type,
    proposalScopeKey(output.scope),
    normalizeTitle(output.title),
    contentHash(output.body),
    [...output.sourceEpisodeIds].sort().join(','),
  ]
  if (output.supersedes !== undefined && output.supersedes.length > 0) {
    parts.push([...new Set(output.supersedes)].sort().join(','))
  }
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex')
}

/** Which duplicate rule to apply to an existing record for one output. */
export type DuplicatePolicy = 'skip' | 'update-pending' | 'skip-active'

/**
 * Decide how a new output relates to one existing record.
 *
 * An exact `proposalKey` match is always skipped; a pending record with the same
 * scope/type/title and overlapping sources is updated in place; an active or
 * archived record is never overwritten.
 * @param existing - Existing record found for this output.
 * @param output - Validated proposal output.
 * @returns The duplicate policy.
 */
export function applyDuplicatePolicy(
  existing: MemoryRecord,
  output: DreamProposalOutput,
): DuplicatePolicy {
  if (existing.proposalKey === computeProposalKey(output)) return 'skip'
  if (existing.status === 'pending') {
    // A proposal the user already edited or reviewed is user-owned text: a
    // later dream must not silently replace it with fresh model output.
    if (existing.ownership === 'user' || existing.reviewedByUserAt !== undefined) {
      return 'skip-active'
    }
    return 'update-pending'
  }
  return 'skip-active'
}
