/**
 * DSH host adapter for `MemoryStore` over `memoryDomain`.
 * @module memloom/host/store
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { OperationRunner } from '../core/operations.ts'
import type { MemoryDomainHandle } from '../core/storage-contract.ts'
import {
  auditCarriesMemory,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_SOURCES,
  MAX_MEMORY_SUPERSEDES,
  MAX_MEMORY_TAGS,
  MAX_MEMORY_TITLE_LENGTH,
  MemoryStore as CoreMemoryStore,
  type AcceptProposalOptions,
  type ArchiveOptions,
  type ArchivePurgePolicy,
  type CapacityController,
  type DeleteOptions,
  type DreamProposalPatch,
  type EpisodeFilter,
  type EpisodeInput,
  type ListRequest,
  type ListResult,
  type MemoryInput,
  type MemoryPatch,
  type MemoryStoreBatch,
  type MemoryStoreChange,
  type MemoryStoreOptions,
  type StoreCounts,
} from '../core/store.ts'
import { asMemoryDomainHandle, type memoryDomain } from './domain.ts'

export {
  auditCarriesMemory,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_SOURCES,
  MAX_MEMORY_SUPERSEDES,
  MAX_MEMORY_TAGS,
  MAX_MEMORY_TITLE_LENGTH,
  type AcceptProposalOptions,
  type ArchiveOptions,
  type ArchivePurgePolicy,
  type CapacityController,
  type DeleteOptions,
  type DreamProposalPatch,
  type EpisodeFilter,
  type EpisodeInput,
  type ListRequest,
  type ListResult,
  type MemoryInput,
  type MemoryPatch,
  type MemoryStoreBatch,
  type MemoryStoreChange,
  type MemoryStoreOptions,
  type StoreCounts,
}

/** The memory CRUD and audit facade backed by DSH `memoryDomain` or any {@link MemoryDomainHandle}. */
export class MemoryStore extends CoreMemoryStore {
  constructor(
    domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
    runner: OperationRunner,
    options?: MemoryStoreOptions,
  ) {
    super(asMemoryDomainHandle(domain), runner, options)
  }
}
