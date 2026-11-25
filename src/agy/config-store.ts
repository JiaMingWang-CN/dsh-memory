/**
 * Runtime configuration store for `${PLUGIN_DATA}/config.json`.
 *
 * Rejects unknown or invalid fields via {@link validateMemoryConfigPatch},
 * persists atomically, and supports lightweight `stat` + SHA-256 hot reload.
 * @module memloom/agy/config-store
 */
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  resolveMemoryConfig,
  validateMemoryConfigPatch,
  type MemoryConfig,
  type ResolvedMemoryConfig,
} from '../core/config.ts'
import { OperationError } from '../core/operations.ts'
import { readFileWithRetry, sha256Hex, writeFileAtomic } from './storage.ts'

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

/** Persistent JSON config store for the AGY plugin. */
export class AgyConfigStore {
  private readonly configPath: string
  private lastHash: string | null = null
  private lastStat: Stats | null = null
  private cachedConfig: ResolvedMemoryConfig | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath)
  }

  /**
   * Load and resolve the current configuration from disk (or defaults if absent).
   */
  async load(): Promise<ResolvedMemoryConfig> {
    let raw: Buffer
    let stat: Stats | null = null
    try {
      raw = await readFileWithRetry(this.configPath)
      stat = await fs.stat(this.configPath).catch(() => null)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        const defaults = resolveMemoryConfig()
        this.lastHash = null
        this.lastStat = null
        this.cachedConfig = defaults
        return structuredClone(defaults)
      }
      throw err
    }

    const resolved = this.parseAndResolve(raw)
    this.lastHash = sha256Hex(raw)
    this.lastStat = stat
    this.cachedConfig = resolved
    return structuredClone(resolved)
  }

  /**
   * Check whether `config.json` changed on disk and return the resolved config.
   */
  async syncIfChanged(): Promise<{ changed: boolean; config: ResolvedMemoryConfig }> {
    let stat: Stats
    try {
      stat = await fs.stat(this.configPath)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        if (this.lastHash === null && this.cachedConfig !== null) {
          return { changed: false, config: structuredClone(this.cachedConfig) }
        }
        const hadFile = this.lastHash !== null
        const config = await this.load()
        return { changed: hadFile, config }
      }
      throw err
    }

    if (
      this.lastStat !== null &&
      this.cachedConfig !== null &&
      stat.mtimeMs === this.lastStat.mtimeMs &&
      stat.size === this.lastStat.size
    ) {
      return { changed: false, config: structuredClone(this.cachedConfig) }
    }

    const raw = await readFileWithRetry(this.configPath)
    const hash = sha256Hex(raw)
    if (hash === this.lastHash && this.cachedConfig !== null) {
      this.lastStat = stat
      return { changed: false, config: structuredClone(this.cachedConfig) }
    }

    const resolved = this.parseAndResolve(raw)
    this.lastHash = hash
    this.lastStat = stat
    this.cachedConfig = resolved
    return { changed: true, config: structuredClone(resolved) }
  }

  /**
   * Validate a partial config patch, merge with existing persisted overrides,
   * write atomically to disk, and return the resolved configuration.
   */
  async savePatch(patch: Partial<MemoryConfig>): Promise<ResolvedMemoryConfig> {
    const cleanPatch = validateMemoryConfigPatch(patch)

    let release!: () => void
    const prev = this.writeChain
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev

    try {
      let existingPatch: Partial<MemoryConfig> = {}
      try {
        const raw = await readFileWithRetry(this.configPath)
        existingPatch = this.parsePatch(raw)
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) {
          throw err
        }
      }

      const merged: Partial<MemoryConfig> = {
        ...existingPatch,
        ...cleanPatch,
      }
      const resolved = resolveMemoryConfig(merged)
      const buffer = Buffer.from(JSON.stringify(merged, null, 2), 'utf8')
      await writeFileAtomic(this.configPath, buffer)
      this.lastHash = sha256Hex(buffer)
      this.lastStat = await fs.stat(this.configPath).catch(() => null)
      this.cachedConfig = resolved
      return structuredClone(resolved)
    } finally {
      release()
    }
  }

  private parsePatch(raw: Buffer): Partial<MemoryConfig> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      throw new OperationError(
        'MEMORY_INVALID_CONFIG',
        `invalid JSON in config file ${this.configPath}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return validateMemoryConfigPatch(parsed)
  }

  private parseAndResolve(raw: Buffer): ResolvedMemoryConfig {
    return resolveMemoryConfig(this.parsePatch(raw))
  }
}
