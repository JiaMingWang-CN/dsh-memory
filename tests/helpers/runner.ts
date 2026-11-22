import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { memoryDomain } from '../../src/host/domain.ts'
import { OperationRunner, type OperationRunnerOptions } from '../../src/host/operations.ts'
import { MemoryStore, type MemoryStoreOptions } from '../../src/host/store.ts'
import { createFakeHost, type FakeDomainFacility } from './fake-domain.ts'

export interface OpenMemory {
  domain: Domain<typeof memoryDomain>
  runner: OperationRunner
  facility: FakeDomainFacility
}

/**
 * Open a fresh in-memory `memory` domain with an operation runner.
 * @param options - Runner options (clock, observer, limits).
 * @returns The domain, runner, and facility.
 */
export async function openMemory(options: OperationRunnerOptions = {}): Promise<OpenMemory> {
  const { ctx, facility } = createFakeHost()
  const domain = await ctx.storageDomain.open(memoryDomain)
  const runner = new OperationRunner(domain, options)
  return { domain, runner, facility }
}

/**
 * Open a memory domain with an initialized {@link MemoryStore}.
 * @param options - Store options.
 * @returns The domain, runner, facility and ready store.
 */
export async function openStore(
  options: MemoryStoreOptions = {},
): Promise<OpenMemory & { store: MemoryStore }> {
  const opened = await openMemory()
  const store = new MemoryStore(opened.domain, opened.runner, options)
  await store.initialize()
  return { ...opened, store }
}
