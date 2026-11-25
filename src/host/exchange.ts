/**
 * DSH host adapter for export, import, rebuild and purge over `memoryDomain`.
 * @module memloom/host/exchange
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  exportMemories as coreExportMemories,
  importMemories as coreImportMemories,
  purgeAll as corePurgeAll,
  rebuild as coreRebuild,
  type ExportRequest,
  type ExportScope,
  type ImportOptions,
  type ImportReport,
  type MemoryExport,
  type PurgeReport,
  type PurgeRequest,
  type RebuildReport,
  type RebuildRequest,
  type WorkspaceMapping,
} from '../core/exchange.ts'
import type { OperationRunner } from '../core/operations.ts'
import type { MemoryDomainHandle } from '../core/storage-contract.ts'
import type { MemoryStore } from '../core/store.ts'
import { asMemoryDomainHandle, type memoryDomain } from './domain.ts'

export {
  type ExportRequest,
  type ExportScope,
  type ImportOptions,
  type ImportReport,
  type MemoryExport,
  type PurgeReport,
  type PurgeRequest,
  type RebuildReport,
  type RebuildRequest,
  type WorkspaceMapping,
}

/** Build an export payload for one scope. */
export function exportMemories(
  domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
  request: ExportRequest,
  now?: () => Date,
): MemoryExport {
  return coreExportMemories(asMemoryDomainHandle(domain), request, now)
}

/** Import an export document into the store. */
export function importMemories(
  store: MemoryStore,
  domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
  payload: MemoryExport,
  options?: ImportOptions,
): Promise<ImportReport> {
  return coreImportMemories(store, asMemoryDomainHandle(domain), payload, options)
}

/** Delete derived, unreviewed, unpinned memories in one scope and reset its episodes and cursors. */
export function rebuild(
  domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
  runner: OperationRunner,
  request: RebuildRequest,
  now?: () => Date,
  serial?: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<RebuildReport> {
  return coreRebuild(asMemoryDomainHandle(domain), runner, request, now, serial)
}

/** Clear one scope's memories and episodes after an exact confirmation phrase. */
export function purgeAll(
  domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
  runner: OperationRunner,
  request: PurgeRequest,
  now?: () => Date,
  serial?: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<PurgeReport> {
  return corePurgeAll(asMemoryDomainHandle(domain), runner, request, now, serial)
}
