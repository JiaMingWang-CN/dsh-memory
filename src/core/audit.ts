/**
 * Audit helpers over the `audit` table.
 * @module dsh-memory/core/audit
 */
import type { AuditRecord } from '../shared/types.ts'
import type { MemoryDomainHandle } from './storage-contract.ts'

/** Default page size of an audit listing. */
export const DEFAULT_AUDIT_LIMIT = 100
/** Largest page size of one audit listing. */
export const MAX_AUDIT_LIMIT = 500

export interface AuditListRequest {
  memoryId?: string
  limit?: number
  offset?: number
}

export interface AuditListResult {
  items: AuditRecord[]
  total: number
  limit: number
  offset: number
}

/**
 * List audit records newest-first with a bounded page.
 * @param domain - Open memory domain.
 * @param request - Optional memory filter and page bounds.
 * @returns The requested page and total matching count.
 */
export function listAudit(
  domain: MemoryDomainHandle,
  request: AuditListRequest = {},
): AuditListResult {
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT)
  const offset = Math.max(request.offset ?? 0, 0)
  const all = [...domain.table('audit').entries()]
    .map(([, record], index) => ({ record, index }))
    .filter(({ record }) => request.memoryId === undefined || record.memoryId === request.memoryId)
    // Newest first; equal timestamps fall back to later insertion (stable recency).
    .sort(
      (left, right) => right.record.at.localeCompare(left.record.at) || right.index - left.index,
    )
    .map(({ record }) => structuredClone(record))
  return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }
}
