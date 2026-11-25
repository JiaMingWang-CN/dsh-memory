/**
 * DSH host adapter for audit queries over `memoryDomain`.
 * @module memloom/host/audit
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  DEFAULT_AUDIT_LIMIT,
  listAudit as coreListAudit,
  MAX_AUDIT_LIMIT,
  type AuditListRequest,
  type AuditListResult,
} from '../core/audit.ts'
import type { MemoryDomainHandle } from '../core/storage-contract.ts'
import { asMemoryDomainHandle, type memoryDomain } from './domain.ts'

export { DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT, type AuditListRequest, type AuditListResult }

/**
 * List audit records newest-first with a bounded page.
 * @param domain - Open memory domain.
 * @param request - Optional memory filter and page bounds.
 * @returns The requested page and total matching count.
 */
export function listAudit(
  domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
  request: AuditListRequest = {},
): AuditListResult {
  return coreListAudit(asMemoryDomainHandle(domain), request)
}
