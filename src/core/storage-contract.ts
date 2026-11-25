/**
 * Host-agnostic storage domain contract and canonical record digest.
 *
 * The contract matches DSH storage-domain's `Domain` / `KvTable`
 * surface structurally while carrying zero DSH runtime dependencies.
 * @module memloom/core/storage-contract
 */
import { createHash } from 'node:crypto'
import type { z } from 'zod'
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

export type MemoryTableName =
  'memories' | 'episodes' | 'dreams' | 'audit' | 'operations' | 'session_cursors'

export interface MemoryTableKeyMap {
  memories: MemoryId
  episodes: EpisodeId
  dreams: DreamId
  audit: AuditId
  operations: OperationId
  session_cursors: string
}

export interface MemoryTableValueMap {
  memories: MemoryRecord
  episodes: EpisodeRecord
  dreams: DreamRun
  audit: AuditRecord
  operations: OperationRecord
  session_cursors: SessionCursor
}

/** Host-agnostic key-value table handle structurally compatible with DSH `KvTable`. */
export interface MemoryKvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  deleteMany(keys: readonly K[]): Promise<number>
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** Host-agnostic memory domain handle structurally compatible with DSH `Domain`. */
export interface MemoryDomainHandle {
  readonly name: string
  table<N extends MemoryTableName>(
    name: N,
  ): MemoryKvTable<MemoryTableKeyMap[N], MemoryTableValueMap[N]>
  close(): Promise<void>
}

/** Canonical zod schemas for all six memory domain tables. */
export const MEMORY_TABLE_SCHEMAS: {
  readonly [N in MemoryTableName]: z.ZodType<MemoryTableValueMap[N]>
} = {
  memories: memoryRecordSchema,
  episodes: episodeRecordSchema,
  dreams: dreamRunSchema,
  audit: auditRecordSchema,
  operations: operationRecordSchema,
  session_cursors: sessionCursorSchema,
}

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
