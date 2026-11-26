/**
 * Unified store opener for Memloom Desktop.
 *
 * Inspects existing store files via {@link parseStoreEnvelope} to choose between
 * {@link DshFileDomain} (`dsh-unit`) and {@link FileMemoryDomain} (`agy-flat`),
 * defaulting newly created stores to `agy-flat` unless `expectedFormat === 'dsh-unit'`.
 * @module memloom/desktop/storage/open-store
 */
import path from 'node:path'
import { FileMemoryDomain, readFileWithRetry } from '../../agy/storage.ts'
import type { MemoryDomainHandle } from '../../core/storage-contract.ts'
import { DshFileDomain } from './dsh-domain.ts'
import { parseStoreEnvelope, type StoreEnvelopeFormat } from './envelope.ts'

export interface DesktopStoreHandle {
  readonly format: StoreEnvelopeFormat
  readonly domain: MemoryDomainHandle
  readonly storePath: string
  syncFromDiskIfChanged(): Promise<boolean>
  runWrite<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

/**
 * Open a memory store in either `dsh-unit` or `agy-flat` format.
 */
export async function openDesktopStore(options: {
  storePath: string
  expectedFormat?: StoreEnvelopeFormat
  onReload?: () => void
  onWarn?: (message: string) => void
  now?: () => Date
}): Promise<DesktopStoreHandle> {
  const storePath = path.resolve(options.storePath)

  let format: StoreEnvelopeFormat
  try {
    const raw = await readFileWithRetry(storePath)
    const parsed = parseStoreEnvelope(raw, storePath)
    format = parsed.format
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      format = options.expectedFormat === 'dsh-unit' ? 'dsh-unit' : 'agy-flat'
    } else {
      throw err
    }
  }

  const callbacks = {
    ...(options.onReload ? { onReload: options.onReload } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options.now ? { now: options.now } : {}),
  }

  if (format === 'dsh-unit') {
    const domain = await DshFileDomain.open({ storePath, ...callbacks })
    return {
      format: 'dsh-unit',
      domain,
      storePath,
      syncFromDiskIfChanged: () => domain.syncFromDiskIfChanged(),
      runWrite: (fn) => domain.withWriteBatch(fn),
      close: () => domain.close(),
    }
  }

  const domain = await FileMemoryDomain.open({ storePath, ...callbacks })
  return {
    format: 'agy-flat',
    domain,
    storePath,
    syncFromDiskIfChanged: () => domain.syncFromDiskIfChanged(),
    runWrite: (fn) => domain.withWriteLock(fn),
    close: () => domain.close(),
  }
}
