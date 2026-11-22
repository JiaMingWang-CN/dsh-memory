import { contentDigest } from '../../src/host/domain.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'

/**
 * Build a valid `MemoryRecord`, deriving `contentHash` from the final fields
 * unless an explicit hash is supplied.
 * @param overrides - Field overrides applied on top of the defaults.
 * @returns A complete memory record.
 */
export function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const base: MemoryRecord = {
    id: MemoryId('mem-1'),
    type: 'lesson',
    scope: { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' },
    origin: 'user',
    ownership: 'user',
    pinned: false,
    title: 'Typecheck before build',
    body: 'Run typecheck before building to avoid broken builds.',
    tags: ['build'],
    status: 'active',
    confidence: 0.9,
    importance: 0.5,
    contentRevision: 1,
    statsRevision: 0,
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    matchCount: 0,
    useCount: 0,
    sourceRefs: [],
    sourceEpisodeIds: [],
    supersedes: [],
    contentHash: 'placeholder',
  }
  const merged: MemoryRecord = { ...base, ...overrides }
  if (
    merged.ownership === 'derived' &&
    merged.sourceRefs.length === 0 &&
    merged.sourceEpisodeIds.length === 0
  ) {
    merged.sourceEpisodeIds = ['episode-default']
  }
  merged.contentHash = overrides.contentHash ?? contentDigest(merged)
  return merged
}
