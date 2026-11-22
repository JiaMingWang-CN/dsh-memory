/**
 * The `memory` storage domain and its derived helpers.
 *
 * All six tables are declared here from the shared zod schemas, and the domain
 * is the single declaration the service opens through `ctx.storageDomain`.
 * @module dsh-memory/host/domain
 */
import { createHash } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  auditRecordSchema,
  dreamRunSchema,
  episodeRecordSchema,
  memoryRecordSchema,
  operationRecordSchema,
  sessionCursorSchema,
  type AuditId,
  type AuditRecord,
  type DreamId,
  type DreamRun,
  type EpisodeId,
  type EpisodeRecord,
  type MemoryId,
  type MemoryRecord,
  type OperationId,
  type OperationRecord,
  type SessionCursor,
} from '../shared/types.ts'

/** Domain identifier for memory data. */
export const MEMORY_DOMAIN_NAME = 'memory'

/** Domain format version. */
export const MEMORY_DOMAIN_VERSION = 1

export const memoryDomain = defineDomain({
  name: MEMORY_DOMAIN_NAME,
  version: MEMORY_DOMAIN_VERSION,
  tables: {
    memories: domainTable<MemoryId, MemoryRecord>(memoryRecordSchema),
    episodes: domainTable<EpisodeId, EpisodeRecord>(episodeRecordSchema),
    dreams: domainTable<DreamId, DreamRun>(dreamRunSchema),
    audit: domainTable<AuditId, AuditRecord>(auditRecordSchema),
    operations: domainTable<OperationId, OperationRecord>(operationRecordSchema),
    // The storage domain restricts table names to `[a-z][a-z0-9_]*`, so the
    // design's `sessionCursors` table is stored as `session_cursors`.
    session_cursors: domainTable<string, SessionCursor>(sessionCursorSchema),
  },
})

/**
 * Reduce a memory's scope to a stable plain shape for hashing and comparison.
 * @param scope - Stored scope.
 * @returns A canonical object with fixed keys.
 */
function canonicalScope(scope: MemoryRecord['scope']): Record<string, string> {
  return scope.kind === 'global'
    ? { kind: 'global' }
    : { kind: 'workspace', key: scope.key, root: scope.root }
}

/**
 * Digest of only the business fields of a memory record.
 *
 * Statistics (`matchCount`, `useCount`, timestamps, `statsRevision`) are
 * intentionally excluded, so search/read bookkeeping never changes the digest
 * while any user-visible content edit does.
 * @param record - Memory record to digest.
 * @returns Lowercase hex SHA-256 of the canonical business fields.
 */
export function contentDigest(record: MemoryRecord): string {
  const material = JSON.stringify({
    type: record.type,
    title: record.title,
    body: record.body,
    tags: [...record.tags],
    scope: canonicalScope(record.scope),
    status: record.status,
    importance: record.importance,
    confidence: record.confidence,
    pinned: record.pinned,
    sourceRefs: record.sourceRefs.map((ref) => ({
      sessionId: ref.sessionId,
      ...(ref.turn === undefined ? {} : { turn: ref.turn }),
      ...(ref.eventSeq === undefined ? {} : { eventSeq: ref.eventSeq }),
      ...(ref.quote === undefined ? {} : { quote: ref.quote }),
    })),
  })
  return createHash('sha256').update(material, 'utf8').digest('hex')
}
