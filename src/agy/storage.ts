/**
 * Pure-Node JSON storage backend implementing {@link MemoryDomainHandle}.
 *
 * Coordinates concurrent MCP Server and short-lived Hook processes via an
 * exclusive `.memory.lock` file, SHA-256 content-hash change detection, atomic
 * temp+fsync+rename writes, and tiered per-table corruption handling.
 * @module memloom/agy/storage
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OperationError } from '../core/operations.ts'
import {
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  MEMORY_TABLE_SCHEMAS,
  type MemoryDomainHandle,
  type MemoryKvTable,
  type MemoryTableKeyMap,
  type MemoryTableName,
  type MemoryTableValueMap,
} from '../core/storage-contract.ts'

const TABLE_NAMES: readonly MemoryTableName[] = [
  'memories',
  'episodes',
  'dreams',
  'audit',
  'operations',
  'session_cursors',
]

const DERIVED_TABLE_NAMES: readonly Exclude<MemoryTableName, 'memories'>[] = [
  'episodes',
  'dreams',
  'audit',
  'operations',
  'session_cursors',
]

const DEFAULT_LOCK_TIMEOUT_MS = 5000
const DEFAULT_STALE_LOCK_MS = 30_000
const RENAME_MAX_ATTEMPTS = 5
const RENAME_RETRY_BASE_MS = 20
const RENAME_RETRY_STEP_MS = 7

/** Options for opening {@link FileMemoryDomain}. */
export interface FileMemoryDomainOptions {
  storePath: string
  lockPath?: string
  backupsDir?: string
  lockTimeoutMs?: number
  staleLockMs?: number
  onReload?: () => void
  onWarn?: (message: string) => void
  now?: () => Date
}

interface LockPayload {
  pid: number
  hostname: string
  createdAtMs: number
}

type TableMaps = {
  [N in MemoryTableName]: Map<MemoryTableKeyMap[N], MemoryTableValueMap[N]>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function isTransientWindowsError(error: unknown): boolean {
  return isErrno(error, 'EPERM') || isErrno(error, 'EBUSY')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Write a file atomically via same-directory temporary file, `fsync`, and
 * Windows `EPERM`/`EBUSY` retryable `rename`.
 */
export async function writeFileAtomic(targetPath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(targetPath)
  await fs.mkdir(dir, { recursive: true })
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  )

  try {
    const fh = await fs.open(tmpPath, 'w')
    try {
      await fh.writeFile(data)
      await fh.sync()
    } finally {
      await fh.close()
    }

    for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
      try {
        await fs.rename(tmpPath, targetPath)
        return
      } catch (err) {
        if (!isTransientWindowsError(err) || attempt === RENAME_MAX_ATTEMPTS - 1) {
          throw err
        }
        await sleep(RENAME_RETRY_BASE_MS + attempt * RENAME_RETRY_STEP_MS)
      }
    }
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {})
    throw err
  }
}

/**
 * Read a file with brief retry on transient Windows `EPERM`/`EBUSY` lock races.
 */
export async function readFileWithRetry(filePath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fs.readFile(filePath)
    } catch (err) {
      if (!isTransientWindowsError(err) || attempt === RENAME_MAX_ATTEMPTS - 1) {
        throw err
      }
      await sleep(RENAME_RETRY_BASE_MS + attempt * RENAME_RETRY_STEP_MS)
    }
  }
  return await fs.readFile(filePath)
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (isErrno(err, 'ESRCH')) return false
    // On Windows/POSIX, EPERM means the process exists under another user/elevation.
    if (isErrno(err, 'EPERM')) return true
    return true
  }
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

/**
 * File-backed {@link MemoryDomainHandle} with cross-process `.memory.lock`
 * mutual exclusion and tiered corruption protection.
 */
export class FileMemoryDomain implements MemoryDomainHandle {
  readonly name = MEMORY_DOMAIN_NAME

  private readonly storePath: string
  private readonly lockPath: string
  private readonly backupsDir: string
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number
  private readonly onReload: (() => void) | undefined
  private readonly onWarn: ((message: string) => void) | undefined
  private readonly now: () => Date

  private readonly lockContext = new AsyncLocalStorage<boolean>()
  private inProcessMutex: Promise<void> = Promise.resolve()

  private tables: TableMaps = createEmptyTables()
  private lastLoadedHash: string | null = null
  private lastStat: Stats | null = null
  private dirty = false

  private constructor(options: FileMemoryDomainOptions) {
    this.storePath = path.resolve(options.storePath)
    const dir = path.dirname(this.storePath)
    this.lockPath = path.resolve(options.lockPath ?? path.join(dir, '.memory.lock'))
    this.backupsDir = path.resolve(options.backupsDir ?? path.join(dir, 'backups'))
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
    this.onReload = options.onReload
    this.onWarn = options.onWarn
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Open the file-backed memory domain and load any existing store snapshot.
   */
  static async open(options: FileMemoryDomainOptions): Promise<FileMemoryDomain> {
    const domain = new FileMemoryDomain(options)
    await domain.reloadFromDisk()
    return domain
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
        if (this.lockContext.getStore() === true) {
          await applyPut()
          return
        }
        await this.withWriteLock(applyPut)
      },
      delete: async (key) => {
        const applyDelete = async () => {
          const removed = getMap().delete(key)
          if (removed) this.dirty = true
          return removed
        }
        if (this.lockContext.getStore() === true) {
          return await applyDelete()
        }
        return await this.withWriteLock(applyDelete)
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
        if (this.lockContext.getStore() === true) {
          return await applyDeleteMany()
        }
        return await this.withWriteLock(applyDeleteMany)
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
        if (this.lockContext.getStore() === true) {
          return await applyUpdate()
        }
        return await this.withWriteLock(applyUpdate)
      },
    }
  }

  /**
   * Execute `fn` under an exclusive cross-process `.memory.lock`.
   * Always checks disk content hash on entry, reloads if externally modified,
   * and coalesces all mutations made during `fn` into one atomic disk write.
   */
  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore() === true) {
      return await fn()
    }

    let releaseInProcess!: () => void
    const prev = this.inProcessMutex
    this.inProcessMutex = new Promise<void>((resolve) => {
      releaseInProcess = resolve
    })
    await prev

    try {
      const lockToken = await this.acquireFileLock()
      try {
        const changed = await this.reloadIfHashChanged()
        if (changed) {
          this.onReload?.()
        }

        this.dirty = false
        try {
          const result = await this.lockContext.run(true, fn)
          if (this.dirty) {
            await this.flushToDisk()
            this.dirty = false
          }
          return result
        } catch (err) {
          if (this.dirty) {
            this.dirty = false
            await this.reloadFromDisk().catch(() => {})
          }
          throw err
        }
      } finally {
        await this.releaseFileLock(lockToken)
      }
    } finally {
      releaseInProcess()
    }
  }

  /**
   * Lightweight `stat` + hash check before read operations.
   * Reloads from disk and invokes `onReload` when an external write occurred.
   */
  async syncFromDiskIfChanged(): Promise<boolean> {
    if (this.lockContext.getStore() === true) {
      return false
    }

    let stat: Stats
    try {
      stat = await fs.stat(this.storePath)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        if (this.lastLoadedHash === null) return false
        this.tables = createEmptyTables()
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
        this.lastLoadedHash = null
        this.lastStat = null
        return
      }
      throw err
    }

    await this.applyLoadedBytes(raw, sha256Hex(raw), stat)
  }

  private async applyLoadedBytes(raw: Buffer, hash: string, stat: Stats | null): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Memory store at ${this.storePath} contains invalid JSON (${err instanceof Error ? err.message : String(err)}); refusing to overwrite. Inspect or restore the file manually.`,
      )
    }

    if (!isPlainObject(parsed)) {
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Memory store at ${this.storePath} must be a JSON object; refusing to overwrite.`,
      )
    }

    if (
      (parsed.name !== undefined && parsed.name !== MEMORY_DOMAIN_NAME) ||
      (parsed.version !== undefined && parsed.version !== MEMORY_DOMAIN_VERSION)
    ) {
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Memory store at ${this.storePath} has unexpected domain header (name=${String(parsed.name)}, version=${String(parsed.version)}); refusing to overwrite.`,
      )
    }

    for (const tableName of TABLE_NAMES) {
      const rawTable = parsed[tableName]
      if (rawTable !== undefined && !isPlainObject(rawTable)) {
        throw new OperationError(
          'MEMORY_UNAVAILABLE',
          `Memory store at ${this.storePath} has invalid table container "${tableName}"; refusing to overwrite.`,
        )
      }
    }

    const nextTables = createEmptyTables()
    let backupPath: string | null = null
    const ensureBackup = async (): Promise<string> => {
      if (backupPath !== null) return backupPath
      backupPath = await this.writeCorruptBackup(raw)
      return backupPath
    }

    // Tier 2: Core `memories` table — any invalid record is backed up and blocks loading/writing.
    const rawMemories = (parsed.memories as Record<string, unknown> | undefined) ?? {}
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

    // Tier 3: Derived tables — backup once and isolate/skip invalid entries.
    for (const tableName of DERIVED_TABLE_NAMES) {
      await this.loadDerivedTable(tableName, parsed[tableName], nextTables, ensureBackup)
    }

    this.tables = nextTables
    this.lastLoadedHash = hash
    this.lastStat = stat
  }

  private async loadDerivedTable<N extends Exclude<MemoryTableName, 'memories'>>(
    tableName: N,
    rawTable: unknown,
    nextTables: TableMaps,
    ensureBackup: () => Promise<string>,
  ): Promise<void> {
    if (!isPlainObject(rawTable)) return
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

  private async flushToDisk(): Promise<void> {
    const serialized: Record<string, unknown> = {
      name: MEMORY_DOMAIN_NAME,
      version: MEMORY_DOMAIN_VERSION,
    }
    for (const tableName of TABLE_NAMES) {
      serialized[tableName] = Object.fromEntries(this.tables[tableName].entries())
    }
    const buffer = Buffer.from(JSON.stringify(serialized, null, 2), 'utf8')
    await writeFileAtomic(this.storePath, buffer)
    this.lastLoadedHash = sha256Hex(buffer)
    this.lastStat = await fs.stat(this.storePath).catch(() => null)
  }

  private async acquireFileLock(): Promise<string> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true })
    const deadlineMs = Date.now() + this.lockTimeoutMs
    let backoffMs = 10

    while (true) {
      const token = randomUUID()
      const payload: LockPayload & { token: string } = {
        pid: process.pid,
        hostname: os.hostname(),
        createdAtMs: this.now().getTime(),
        token,
      }

      try {
        const fh = await fs.open(this.lockPath, 'wx')
        try {
          await fh.writeFile(JSON.stringify(payload), 'utf8')
        } catch (writeErr) {
          await fh.close().catch(() => {})
          await fs.unlink(this.lockPath).catch(() => {})
          throw writeErr
        }
        await fh.close()
        return token
      } catch (err) {
        if (!isErrno(err, 'EEXIST') && !isTransientWindowsError(err)) {
          throw err
        }
      }

      const tookOver = await this.tryTakeoverStaleLock()
      if (tookOver) {
        continue
      }

      const remainingMs = deadlineMs - Date.now()
      if (remainingMs <= 0) {
        throw new OperationError(
          'MEMORY_UNAVAILABLE',
          `Timed out after ${this.lockTimeoutMs}ms waiting for memory lock: ${this.lockPath}`,
        )
      }

      const jitter = Math.floor(Math.random() * 6)
      await sleep(Math.min(backoffMs + jitter, remainingMs))
      backoffMs = Math.min(backoffMs * 2, 50)
    }
  }

  private async tryTakeoverStaleLock(): Promise<boolean> {
    let raw: string
    let stat: Stats | null = null
    try {
      raw = await fs.readFile(this.lockPath, 'utf8')
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return true
      return false
    }

    const nowMs = this.now().getTime()
    let isStale = false

    try {
      const parsed = JSON.parse(raw) as Partial<LockPayload>
      if (typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs)) {
        const ageMs = nowMs - parsed.createdAtMs
        if (ageMs > this.staleLockMs) {
          const deadPid = typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)
          if (deadPid || ageMs > this.staleLockMs * 4) {
            isStale = true
          }
        }
      }
    } catch {
      // Partial or empty lock file: only break if its filesystem mtime is well past staleLockMs.
      stat = await fs.stat(this.lockPath).catch(() => null)
      if (stat !== null && nowMs - stat.mtimeMs > this.staleLockMs) {
        isStale = true
      }
    }

    if (!isStale) return false

    const stalePath = `${this.lockPath}.stale.${randomUUID().slice(0, 8)}`
    try {
      await fs.rename(this.lockPath, stalePath)
      await fs.unlink(stalePath).catch(() => {})
      return true
    } catch {
      return false
    }
  }

  private async releaseFileLock(token: string): Promise<void> {
    try {
      const raw = (await readFileWithRetry(this.lockPath)).toString('utf8')
      const parsed = JSON.parse(raw) as { token?: unknown }
      if (parsed.token !== token) return
      for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
        try {
          await fs.unlink(this.lockPath)
          return
        } catch (err) {
          if (!isTransientWindowsError(err) || attempt === RENAME_MAX_ATTEMPTS - 1) {
            return
          }
          await sleep(RENAME_RETRY_BASE_MS + attempt * RENAME_RETRY_STEP_MS)
        }
      }
    } catch {
      // Lock already removed or unreadable; nothing left to release.
    }
  }
}
