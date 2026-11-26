/**
 * DSH (`dsh-unit`) storage domain adapter for Memloom Desktop.
 *
 * Preserves the `{ unit, global, tables }` outer envelope losslessly, verifies
 * disk SHA-256 before any logical write batch to abort on external modifications,
 * writes at most one pre-write snapshot backup per dirty batch (rotating up to
 * 20 desktop backups without touching other backups), and mirrors tiered
 * per-table corruption protection.
 * @module memloom/desktop/storage/dsh-domain
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { readFileWithRetry, sha256Hex, writeFileAtomic } from '../../agy/storage.ts'
import { OperationError } from '../../core/operations.ts'
import {
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  MEMORY_TABLE_SCHEMAS,
  type MemoryDomainHandle,
  type MemoryKvTable,
  type MemoryTableKeyMap,
  type MemoryTableName,
  type MemoryTableValueMap,
} from '../../core/storage-contract.ts'
import { MEMORY_TABLE_NAMES, parseStoreEnvelope, serializeStoreEnvelope } from './envelope.ts'

export const DSH_DESKTOP_BACKUP_PREFIX = 'memory-desktop-before-write-'
export const DSH_DESKTOP_BACKUP_LIMIT = 20

const DERIVED_TABLE_NAMES: readonly Exclude<MemoryTableName, 'memories'>[] = [
  'episodes',
  'dreams',
  'audit',
  'operations',
  'session_cursors',
]

export class DesktopExternalChangeError extends Error {
  readonly code = 'desktop/external-change'
  readonly storePath: string

  constructor(storePath: string, message?: string) {
    super(message ?? `Memory store at ${storePath} was modified externally; reload before saving.`)
    this.name = 'DesktopExternalChangeError'
    this.storePath = storePath
  }
}

export interface DshFileDomainOptions {
  storePath: string
  backupsDir?: string
  maxDesktopBackups?: number
  onReload?: () => void
  onWarn?: (message: string) => void
  now?: () => Date
}

type TableMaps = {
  [N in MemoryTableName]: Map<MemoryTableKeyMap[N], MemoryTableValueMap[N]>
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function createEmptyTables(): TableMaps {
  return {
    memories: new Map(),
    episodes: new Map(),
    dreams: new Map(),
    audit: new Map(),
    operations: new Map(),
    session_cursors: new Map(),
  }
}

function cloneTables(tables: TableMaps): TableMaps {
  return {
    memories: new Map([...tables.memories.entries()].map(([k, v]) => [k, structuredClone(v)])),
    episodes: new Map([...tables.episodes.entries()].map(([k, v]) => [k, structuredClone(v)])),
    dreams: new Map([...tables.dreams.entries()].map(([k, v]) => [k, structuredClone(v)])),
    audit: new Map([...tables.audit.entries()].map(([k, v]) => [k, structuredClone(v)])),
    operations: new Map([...tables.operations.entries()].map(([k, v]) => [k, structuredClone(v)])),
    session_cursors: new Map(
      [...tables.session_cursors.entries()].map(([k, v]) => [k, structuredClone(v)]),
    ),
  }
}

function tablesToPlainRecord(tables: TableMaps): Record<MemoryTableName, Record<string, unknown>> {
  const out = {} as Record<MemoryTableName, Record<string, unknown>>
  for (const tableName of MEMORY_TABLE_NAMES) {
    out[tableName] = Object.fromEntries(tables[tableName].entries())
  }
  return out
}

function formatDesktopBackupStamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-${iso.slice(20, 23)}`
}

const BACKUP_NAME_RE = /^memory-desktop-before-write-(\d{8}-\d{6}-\d{3})(?:-(\d+))?\.json$/

function compareDesktopBackupNames(a: string, b: string): number {
  const ma = BACKUP_NAME_RE.exec(a)
  const mb = BACKUP_NAME_RE.exec(b)
  if (ma && mb) {
    const stampA = ma[1] ?? ''
    const stampB = mb[1] ?? ''
    if (stampA !== stampB) {
      return stampA < stampB ? -1 : 1
    }
    const seqA = ma[2] ? Number.parseInt(ma[2], 10) : 0
    const seqB = mb[2] ? Number.parseInt(mb[2], 10) : 0
    if (seqA !== seqB) {
      return seqA - seqB
    }
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * File-backed {@link MemoryDomainHandle} for DSH `dsh-unit` memory stores.
 */
export class DshFileDomain implements MemoryDomainHandle {
  readonly name = MEMORY_DOMAIN_NAME

  private readonly storePath: string
  private readonly backupsDir: string
  private readonly maxDesktopBackups: number
  private readonly onReload: (() => void) | undefined
  private readonly onWarn: ((message: string) => void) | undefined
  private readonly now: () => Date

  private readonly batchContext = new AsyncLocalStorage<boolean>()
  private inProcessMutex: Promise<void> = Promise.resolve()

  private tables: TableMaps = createEmptyTables()
  private envelopeUnit: Record<string, unknown> = {
    name: MEMORY_DOMAIN_NAME,
    version: MEMORY_DOMAIN_VERSION,
  }
  private envelopeGlobal: unknown = null
  private lastLoadedHash: string | null = null
  private lastStat: Stats | null = null
  private dirty = false

  private constructor(options: DshFileDomainOptions) {
    this.storePath = path.resolve(options.storePath)
    const dir = path.dirname(this.storePath)
    this.backupsDir = path.resolve(options.backupsDir ?? path.join(dir, 'backups'))
    this.maxDesktopBackups = Math.max(0, options.maxDesktopBackups ?? DSH_DESKTOP_BACKUP_LIMIT)
    this.onReload = options.onReload
    this.onWarn = options.onWarn
    this.now = options.now ?? (() => new Date())
  }

  static async open(options: DshFileDomainOptions): Promise<DshFileDomain> {
    const domain = new DshFileDomain(options)
    await domain.reloadFromDisk()
    return domain
  }

  get lastHash(): string | null {
    return this.lastLoadedHash
  }

  get envelopeFormat(): 'dsh-unit' {
    return 'dsh-unit'
  }

  table<N extends MemoryTableName>(
    name: N,
  ): MemoryKvTable<MemoryTableKeyMap[N], MemoryTableValueMap[N]> {
    const schema = MEMORY_TABLE_SCHEMAS[name]
    const getMap = (): Map<MemoryTableKeyMap[N], MemoryTableValueMap[N]> => this.tables[name]

    return {
      get: (key) => getMap().get(key),
      entries: () => [...getMap().entries()][Symbol.iterator](),
      keys: () => [...getMap().keys()][Symbol.iterator](),
      get size() {
        return getMap().size
      },
      put: async (key, value) => {
        const parsed = structuredClone(schema.parse(value))
        const applyPut = async () => {
          getMap().set(key, parsed)
          this.dirty = true
        }
        if (this.batchContext.getStore() === true) {
          await applyPut()
          return
        }
        await this.withWriteBatch(applyPut)
      },
      delete: async (key) => {
        const applyDelete = async () => {
          const removed = getMap().delete(key)
          if (removed) this.dirty = true
          return removed
        }
        if (this.batchContext.getStore() === true) {
          return await applyDelete()
        }
        return await this.withWriteBatch(applyDelete)
      },
      deleteMany: async (keys) => {
        const applyDeleteMany = async () => {
          const map = getMap()
          let removed = 0
          for (const key of new Set(keys)) {
            if (map.delete(key)) removed += 1
          }
          if (removed > 0) this.dirty = true
          return removed
        }
        if (this.batchContext.getStore() === true) {
          return await applyDeleteMany()
        }
        return await this.withWriteBatch(applyDeleteMany)
      },
      update: async (key, fn) => {
        const applyUpdate = async () => {
          const map = getMap()
          if (!map.has(key)) throw new Error(`missing-key: ${key}`)
          const current = structuredClone(map.get(key)!)
          const next = structuredClone(schema.parse(fn(current)))
          map.set(key, next)
          this.dirty = true
          return structuredClone(next)
        }
        if (this.batchContext.getStore() === true) {
          return await applyUpdate()
        }
        return await this.withWriteBatch(applyUpdate)
      },
    }
  }

  /**
   * Execute `fn` inside a logical write batch.
   * Verifies the on-disk SHA-256 matches `lastLoadedHash` before invoking `fn`,
   * rolls back in-memory mutations on error, and writes at most one pre-write
   * snapshot backup plus one atomic store replacement when dirty.
   */
  async withWriteBatch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.batchContext.getStore() === true) {
      return await fn()
    }

    let releaseInProcess!: () => void
    const prev = this.inProcessMutex
    this.inProcessMutex = new Promise<void>((resolve) => {
      releaseInProcess = resolve
    })
    await prev

    try {
      let diskBytes: Buffer | null = null
      try {
        diskBytes = await readFileWithRetry(this.storePath)
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) {
          throw err
        }
      }

      const diskHash = diskBytes === null ? null : sha256Hex(diskBytes)
      if (diskHash !== this.lastLoadedHash) {
        throw new DesktopExternalChangeError(this.storePath)
      }

      const snapshot = cloneTables(this.tables)
      this.dirty = false

      try {
        const result = await this.batchContext.run(true, fn)
        if (this.dirty) {
          if (diskBytes !== null) {
            await this.writePreWriteBackup(diskBytes)
            await this.pruneDesktopBackups()
          }
          await this.flushToDisk()
          this.dirty = false
        }
        return result
      } catch (err) {
        this.tables = snapshot
        this.dirty = false
        throw err
      }
    } finally {
      releaseInProcess()
    }
  }

  /**
   * Lightweight `stat` + SHA-256 check before read operations.
   * Reloads from disk and invokes `onReload` when an external write occurred.
   */
  async syncFromDiskIfChanged(): Promise<boolean> {
    if (this.batchContext.getStore() === true) {
      return false
    }

    let stat: Stats
    try {
      stat = await fs.stat(this.storePath)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        if (this.lastLoadedHash === null) return false
        this.tables = createEmptyTables()
        this.envelopeUnit = { name: MEMORY_DOMAIN_NAME, version: MEMORY_DOMAIN_VERSION }
        this.envelopeGlobal = null
        this.lastLoadedHash = null
        this.lastStat = null
        this.onReload?.()
        return true
      }
      throw err
    }

    if (
      this.lastStat !== null &&
      stat.mtimeMs === this.lastStat.mtimeMs &&
      stat.size === this.lastStat.size
    ) {
      return false
    }

    const changed = await this.reloadIfHashChanged(stat)
    if (changed) {
      this.onReload?.()
    }
    return changed
  }

  async close(): Promise<void> {}

  private async reloadIfHashChanged(knownStat?: Stats): Promise<boolean> {
    let raw: Buffer
    let stat: Stats | null = knownStat ?? null
    try {
      raw = await readFileWithRetry(this.storePath)
      if (stat === null) {
        stat = await fs.stat(this.storePath).catch(() => null)
      }
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        if (this.lastLoadedHash === null) return false
        this.tables = createEmptyTables()
        this.envelopeUnit = { name: MEMORY_DOMAIN_NAME, version: MEMORY_DOMAIN_VERSION }
        this.envelopeGlobal = null
        this.lastLoadedHash = null
        this.lastStat = null
        return true
      }
      throw err
    }

    const hash = sha256Hex(raw)
    if (hash === this.lastLoadedHash) {
      if (stat !== null) this.lastStat = stat
      return false
    }

    await this.applyLoadedBytes(raw, hash, stat)
    return true
  }

  private async reloadFromDisk(): Promise<void> {
    let raw: Buffer
    let stat: Stats | null = null
    try {
      raw = await readFileWithRetry(this.storePath)
      stat = await fs.stat(this.storePath).catch(() => null)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        this.tables = createEmptyTables()
        this.envelopeUnit = { name: MEMORY_DOMAIN_NAME, version: MEMORY_DOMAIN_VERSION }
        this.envelopeGlobal = null
        this.lastLoadedHash = null
        this.lastStat = null
        return
      }
      throw err
    }

    await this.applyLoadedBytes(raw, sha256Hex(raw), stat)
  }

  private async applyLoadedBytes(raw: Buffer, hash: string, stat: Stats | null): Promise<void> {
    const parsed = parseStoreEnvelope(raw, this.storePath)
    if (parsed.format !== 'dsh-unit') {
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Memory store at ${this.storePath} is not in dsh-unit format; refusing to open with DshFileDomain.`,
      )
    }

    const nextTables = createEmptyTables()
    let backupPath: string | null = null
    const ensureBackup = async (): Promise<string> => {
      if (backupPath !== null) return backupPath
      backupPath = await this.writeCorruptBackup(raw)
      return backupPath
    }

    const rawMemories = parsed.rawTables.memories
    const corruptedMemoryIds: string[] = []
    for (const [key, value] of Object.entries(rawMemories)) {
      const res = MEMORY_TABLE_SCHEMAS.memories.safeParse(value)
      if (!res.success) {
        corruptedMemoryIds.push(key)
      } else {
        nextTables.memories.set(res.data.id, res.data)
      }
    }
    if (corruptedMemoryIds.length > 0) {
      const backedUpTo = await ensureBackup()
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Corrupted record(s) in memories table [${corruptedMemoryIds.join(', ')}]; raw store backed up to ${backedUpTo}. Repair or restore from backup before retrying.`,
      )
    }

    for (const tableName of DERIVED_TABLE_NAMES) {
      await this.loadDerivedTable(tableName, parsed.rawTables[tableName], nextTables, ensureBackup)
    }

    this.tables = nextTables
    this.envelopeUnit = parsed.unit
      ? { ...parsed.unit }
      : { name: MEMORY_DOMAIN_NAME, version: MEMORY_DOMAIN_VERSION }
    this.envelopeGlobal = 'global' in parsed ? parsed.global : null
    this.lastLoadedHash = hash
    this.lastStat = stat
  }

  private async loadDerivedTable<N extends Exclude<MemoryTableName, 'memories'>>(
    tableName: N,
    rawTable: Record<string, unknown>,
    nextTables: TableMaps,
    ensureBackup: () => Promise<string>,
  ): Promise<void> {
    const schema = MEMORY_TABLE_SCHEMAS[tableName]
    const targetMap = nextTables[tableName] as Map<string, MemoryTableValueMap[N]>
    const skippedKeys: string[] = []
    for (const [key, value] of Object.entries(rawTable)) {
      const res = schema.safeParse(value)
      if (!res.success) {
        skippedKeys.push(key)
        continue
      }
      targetMap.set(key, res.data)
    }
    if (skippedKeys.length > 0) {
      const backedUpTo = await ensureBackup()
      this.onWarn?.(
        `Isolated ${skippedKeys.length} corrupted record(s) in derived table "${tableName}" [${skippedKeys.join(', ')}]; backup saved to ${backedUpTo}`,
      )
    }
  }

  private async writeCorruptBackup(raw: Buffer): Promise<string> {
    await fs.mkdir(this.backupsDir, { recursive: true })
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const backupFile = path.join(
      this.backupsDir,
      `memory.corrupt-${stamp}-${randomUUID().slice(0, 8)}.json`,
    )
    await writeFileAtomic(backupFile, raw)
    return backupFile
  }

  private async writePreWriteBackup(raw: Buffer): Promise<string> {
    await fs.mkdir(this.backupsDir, { recursive: true })
    const stamp = formatDesktopBackupStamp(this.now())
    let candidate = path.join(this.backupsDir, `${DSH_DESKTOP_BACKUP_PREFIX}${stamp}.json`)
    let seq = 1
    while (true) {
      try {
        await fs.access(candidate)
        candidate = path.join(
          this.backupsDir,
          `${DSH_DESKTOP_BACKUP_PREFIX}${stamp}-${String(seq).padStart(3, '0')}.json`,
        )
        seq += 1
      } catch (err) {
        if (isErrno(err, 'ENOENT')) {
          break
        }
        throw err
      }
    }

    await writeFileAtomic(candidate, raw)
    return candidate
  }

  private async pruneDesktopBackups(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.backupsDir)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return
      throw err
    }

    const desktopBackups = entries
      .filter((name) => name.startsWith(DSH_DESKTOP_BACKUP_PREFIX) && name.endsWith('.json'))
      .sort(compareDesktopBackupNames)

    const excess = desktopBackups.length - this.maxDesktopBackups
    if (excess <= 0) return

    for (const staleName of desktopBackups.slice(0, excess)) {
      await fs.unlink(path.join(this.backupsDir, staleName)).catch(() => {})
    }
  }

  private async flushToDisk(): Promise<void> {
    const buffer = serializeStoreEnvelope('dsh-unit', tablesToPlainRecord(this.tables), {
      unit: this.envelopeUnit,
      global: this.envelopeGlobal,
    })
    await writeFileAtomic(this.storePath, buffer)
    this.lastLoadedHash = sha256Hex(buffer)
    this.lastStat = await fs.stat(this.storePath).catch(() => null)
  }
}
