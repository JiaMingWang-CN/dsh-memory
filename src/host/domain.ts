/**
 * The `memory` storage domain and its derived helpers.
 *
 * All six tables are declared here from the shared zod schemas, and the domain
 * is the single declaration the service opens through `ctx.storageDomain`.
 * @module memloom/host/domain
 */
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
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
import {
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  contentDigest,
  type MemoryDomainHandle,
} from '../core/storage-contract.ts'

export { MEMORY_DOMAIN_NAME, MEMORY_DOMAIN_VERSION, contentDigest }

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
 * Adapt an opened DSH `memoryDomain` handle to the host-agnostic
 * {@link MemoryDomainHandle} contract.
 */
export function asMemoryDomainHandle(
  domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
): MemoryDomainHandle {
  return domain as unknown as MemoryDomainHandle
}
