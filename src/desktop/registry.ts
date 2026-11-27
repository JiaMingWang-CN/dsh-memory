/**
 * Multi-client registry, built-in store discovery, health probing, and atomic
 * `desktop-state.json` persistence for Memloom Desktop.
 * @module memloom/desktop/registry
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { readFileWithRetry, writeFileAtomic } from '../agy/storage.ts'
import { OperationError } from '../core/operations.ts'
import type { DiscoveredStore, HostPluginStatus, PlatformAdapter } from './platform/types.ts'
import { parseStoreEnvelope, type StoreEnvelopeFormat } from './storage/envelope.ts'

export const DESKTOP_STATE_VERSION = 1

export type ClientKind = 'dsh' | 'agy' | 'custom'
export type ClientHealth = 'ready' | 'missing' | 'corrupted' | 'unreadable'

export interface DesktopWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DesktopPreferences {
  readonly theme: 'system' | 'light' | 'dark'
  readonly locale: 'zh' | 'en'
  readonly windowBounds?: DesktopWindowBounds
}

export interface RegisteredClient {
  readonly id: string
  readonly name: string
  readonly kind: ClientKind
  readonly builtin: boolean
  readonly storePath: string
  readonly enabled: boolean
  readonly dshProtected: boolean
  readonly allowInitializeWhenMissing: boolean
  readonly format: StoreEnvelopeFormat | null
  readonly health: ClientHealth
  readonly healthDetail?: string
  readonly lastCheckedAt: string
  readonly profileName?: string
  readonly pluginStatus?: HostPluginStatus
}

export interface AddCustomClientInput {
  readonly name: string
  readonly storePath: string
  readonly dshProtected?: boolean
  readonly createIfMissing?: boolean
}

export interface UpdateClientInput {
  readonly id: string
  readonly name?: string
  readonly enabled?: boolean
  readonly dshProtected?: boolean
}

const windowBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
})

const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(['zh', 'en']),
  windowBounds: windowBoundsSchema.optional(),
})

const preferencesPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    locale: z.enum(['zh', 'en']).optional(),
    windowBounds: windowBoundsSchema.optional(),
  })
  .strict()

const hostPluginStatusSchema = z.object({
  state: z.enum(['enabled', 'disabled', 'not-installed', 'unknown']),
  installed: z.boolean(),
  enabled: z.boolean().nullable(),
  version: z.string().min(1).optional(),
  pluginName: z.string().min(1).optional(),
  installPath: z.string().min(1).optional(),
  detail: z.string().optional(),
})

const registeredClientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['dsh', 'agy', 'custom']),
  builtin: z.boolean(),
  storePath: z.string().min(1),
  enabled: z.boolean(),
  dshProtected: z.boolean(),
  allowInitializeWhenMissing: z.boolean(),
  format: z.enum(['dsh-unit', 'agy-flat']).nullable(),
  health: z.enum(['ready', 'missing', 'corrupted', 'unreadable']),
  healthDetail: z.string().optional(),
  lastCheckedAt: z.string().min(1),
  profileName: z.string().min(1).optional(),
  pluginStatus: hostPluginStatusSchema.optional(),
})

const persistedStateSchema = z.object({
  version: z.literal(DESKTOP_STATE_VERSION),
  preferences: preferencesSchema,
  clients: z.array(registeredClientSchema),
})

interface ProbeResult {
  readonly format: StoreEnvelopeFormat | null
  readonly health: ClientHealth
  readonly healthDetail?: string
  readonly lastCheckedAt: string
}

const DEFAULT_PREFERENCES: DesktopPreferences = {
  theme: 'system',
  locale: 'zh',
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function clonePreferences(prefs: DesktopPreferences): DesktopPreferences {
  return {
    theme: prefs.theme,
    locale: prefs.locale,
    ...(prefs.windowBounds !== undefined ? { windowBounds: { ...prefs.windowBounds } } : {}),
  }
}

function clonePluginStatus(status: {
  readonly state: HostPluginStatus['state']
  readonly installed: boolean
  readonly enabled: boolean | null
  readonly version?: string | undefined
  readonly pluginName?: string | undefined
  readonly installPath?: string | undefined
  readonly detail?: string | undefined
}): HostPluginStatus {
  return {
    state: status.state,
    installed: status.installed,
    enabled: status.enabled,
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.pluginName !== undefined ? { pluginName: status.pluginName } : {}),
    ...(status.installPath !== undefined ? { installPath: status.installPath } : {}),
    ...(status.detail !== undefined ? { detail: status.detail } : {}),
  }
}

function cloneClient(client: RegisteredClient): RegisteredClient {
  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    builtin: client.builtin,
    storePath: client.storePath,
    enabled: client.enabled,
    dshProtected: client.dshProtected,
    allowInitializeWhenMissing: client.allowInitializeWhenMissing,
    format: client.format,
    health: client.health,
    ...(client.healthDetail !== undefined ? { healthDetail: client.healthDetail } : {}),
    lastCheckedAt: client.lastCheckedAt,
    ...(client.profileName !== undefined ? { profileName: client.profileName } : {}),
    ...(client.pluginStatus !== undefined
      ? { pluginStatus: clonePluginStatus(client.pluginStatus) }
      : {}),
  }
}

function fromParsedPreferences(parsed: z.infer<typeof preferencesSchema>): DesktopPreferences {
  return {
    theme: parsed.theme,
    locale: parsed.locale,
    ...(parsed.windowBounds !== undefined ? { windowBounds: { ...parsed.windowBounds } } : {}),
  }
}

function fromParsedClient(parsed: z.infer<typeof registeredClientSchema>): RegisteredClient {
  return {
    id: parsed.id,
    name: parsed.name,
    kind: parsed.kind,
    builtin: parsed.builtin,
    storePath: path.resolve(parsed.storePath),
    enabled: parsed.enabled,
    dshProtected: parsed.dshProtected,
    allowInitializeWhenMissing: parsed.allowInitializeWhenMissing,
    format: parsed.format,
    health: parsed.health,
    ...(parsed.healthDetail !== undefined ? { healthDetail: parsed.healthDetail } : {}),
    lastCheckedAt: parsed.lastCheckedAt,
    ...(parsed.profileName !== undefined ? { profileName: parsed.profileName } : {}),
    ...(parsed.pluginStatus !== undefined
      ? { pluginStatus: clonePluginStatus(parsed.pluginStatus) }
      : {}),
  }
}

/**
 * Manages built-in DSH/AGY store discovery, custom store registration, health
 * probing, and desktop preferences persisted to `desktop-state.json`.
 */
export class ClientRegistry {
  private readonly statePath: string
  private readonly platform: PlatformAdapter
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly now: () => Date

  private clients: RegisteredClient[] = []
  private preferences: DesktopPreferences = clonePreferences(DEFAULT_PREFERENCES)
  private legacyAgyCandidate: string | undefined
  private opQueue: Promise<void> = Promise.resolve()

  constructor(options: {
    statePath: string
    platform: PlatformAdapter
    env?: NodeJS.ProcessEnv
    now?: () => Date
  }) {
    this.statePath = path.resolve(options.statePath)
    this.platform = options.platform
    this.env = options.env
    this.now = options.now ?? (() => new Date())
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn)
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private normalizePathKey(filePath: string): string {
    const resolved = path.resolve(filePath)
    if (this.platform.platform === 'win32' || process.platform === 'win32') {
      return resolved.toLowerCase()
    }
    return resolved
  }

  private async probeStoreFile(storePath: string): Promise<ProbeResult> {
    const resolvedPath = path.resolve(storePath)
    const lastCheckedAt = this.now().toISOString()

    let bytes: Buffer
    try {
      bytes = await readFileWithRetry(resolvedPath)
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) {
        return {
          format: null,
          health: 'missing',
          healthDetail: 'Memory store file does not exist on disk.',
          lastCheckedAt,
        }
      }
      return {
        format: null,
        health: 'unreadable',
        healthDetail: err instanceof Error ? err.message : String(err),
        lastCheckedAt,
      }
    }

    try {
      const parsed = parseStoreEnvelope(bytes, resolvedPath)
      return {
        format: parsed.format,
        health: 'ready',
        lastCheckedAt,
      }
    } catch (err) {
      return {
        format: null,
        health: 'corrupted',
        healthDetail: err instanceof Error ? err.message : String(err),
        lastCheckedAt,
      }
    }
  }

  private async saveState(): Promise<void> {
    const payload = {
      version: DESKTOP_STATE_VERSION,
      preferences: clonePreferences(this.preferences),
      clients: this.clients.map(cloneClient),
    }
    await writeFileAtomic(this.statePath, `${JSON.stringify(payload, null, 2)}\n`)
  }

  /** Load persisted client entries and preferences from `desktop-state.json`. */
  load(): Promise<void> {
    return this.runSerialized(async () => {
      let bytes: Buffer
      try {
        bytes = await readFileWithRetry(this.statePath)
      } catch (err) {
        if (isErrno(err, 'ENOENT')) {
          this.clients = []
          this.preferences = clonePreferences(DEFAULT_PREFERENCES)
          return
        }
        throw new OperationError(
          'MEMORY_UNAVAILABLE',
          `Failed to read desktop state at ${this.statePath}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      let raw: unknown
      try {
        raw = JSON.parse(bytes.toString('utf8'))
      } catch (err) {
        throw new OperationError(
          'MEMORY_UNAVAILABLE',
          `Desktop state at ${this.statePath} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const parsed = persistedStateSchema.safeParse(raw)
      if (!parsed.success) {
        throw new OperationError(
          'MEMORY_UNAVAILABLE',
          `Desktop state at ${this.statePath} failed validation: ${parsed.error.message}`,
        )
      }

      this.preferences = fromParsedPreferences(parsed.data.preferences)
      this.clients = parsed.data.clients.map(fromParsedClient)
    })
  }

  /** Re-discover built-in DSH/AGY stores and re-probe health for all registered clients. */
  refreshDiscovery(): Promise<RegisteredClient[]> {
    return this.runSerialized(async () => {
      const [dshStores, agyDiscovery] = await Promise.all([
        this.platform.resolveDefaultDshStores(this.env),
        this.platform.resolveDefaultAgyStore(this.env),
      ])

      this.legacyAgyCandidate =
        agyDiscovery.legacyCandidatePath !== undefined
          ? path.resolve(agyDiscovery.legacyCandidatePath)
          : undefined

      const previousById = new Map<string, RegisteredClient>()
      for (const client of this.clients) {
        previousById.set(client.id, client)
      }

      const discoveredBuiltins: DiscoveredStore[] = [...dshStores, agyDiscovery.primary]
      const builtinClients: RegisteredClient[] = []
      const builtinPathKeys = new Set<string>()

      for (const store of discoveredBuiltins) {
        const resolvedPath = path.resolve(store.storePath)
        builtinPathKeys.add(this.normalizePathKey(resolvedPath))
        const previous = previousById.get(store.id)
        const probe = await this.probeStoreFile(resolvedPath)
        const isDsh = store.kind === 'dsh'

        builtinClients.push({
          id: store.id,
          name: previous?.name ?? store.name,
          kind: store.kind,
          builtin: true,
          storePath: resolvedPath,
          enabled: previous?.enabled ?? true,
          dshProtected: isDsh ? true : (previous?.dshProtected ?? false),
          allowInitializeWhenMissing: !isDsh,
          format: probe.format,
          health: probe.health,
          ...(probe.healthDetail !== undefined ? { healthDetail: probe.healthDetail } : {}),
          lastCheckedAt: probe.lastCheckedAt,
          ...(store.profileName !== undefined ? { profileName: store.profileName } : {}),
          ...(store.pluginStatus !== undefined
            ? { pluginStatus: clonePluginStatus(store.pluginStatus) }
            : {}),
        })
      }

      const customClients: RegisteredClient[] = []
      const seenCustomPathKeys = new Set<string>()

      for (const existing of this.clients) {
        if (existing.builtin) continue
        const pathKey = this.normalizePathKey(existing.storePath)
        if (builtinPathKeys.has(pathKey) || seenCustomPathKeys.has(pathKey)) {
          continue
        }
        seenCustomPathKeys.add(pathKey)

        const probe = await this.probeStoreFile(existing.storePath)
        customClients.push({
          id: existing.id,
          name: existing.name,
          kind: 'custom',
          builtin: false,
          storePath: path.resolve(existing.storePath),
          enabled: existing.enabled,
          dshProtected: existing.dshProtected,
          allowInitializeWhenMissing: true,
          format: probe.format,
          health: probe.health,
          ...(probe.healthDetail !== undefined ? { healthDetail: probe.healthDetail } : {}),
          lastCheckedAt: probe.lastCheckedAt,
        })
      }

      this.clients = [...builtinClients, ...customClients]
      await this.saveState()
      return this.listClients()
    })
  }

  /** Return all currently registered clients. */
  listClients(): RegisteredClient[] {
    return this.clients.map(cloneClient)
  }

  /** Look up a registered client by ID. */
  getClient(id: string): RegisteredClient | undefined {
    const found = this.clients.find((client) => client.id === id)
    return found !== undefined ? cloneClient(found) : undefined
  }

  /** Register a custom memory store after path deduplication and envelope probing. */
  addCustomClient(input: AddCustomClientInput): Promise<RegisteredClient> {
    return this.runSerialized(async () => {
      const name = input.name.trim()
      if (name.length === 0) {
        throw new OperationError('MEMORY_INVALID_CONFIG', 'Client name must not be empty.')
      }

      const rawStorePath = input.storePath.trim()
      if (rawStorePath.length === 0) {
        throw new OperationError('MEMORY_INVALID_CONFIG', 'Store path must not be empty.')
      }

      const resolvedPath = path.resolve(rawStorePath)
      const pathKey = this.normalizePathKey(resolvedPath)

      const duplicate = this.clients.find(
        (client) => this.normalizePathKey(client.storePath) === pathKey,
      )
      if (duplicate !== undefined) {
        throw new OperationError(
          'MEMORY_CONFLICT',
          `Store path "${resolvedPath}" is already registered as "${duplicate.name}" (${duplicate.id}).`,
        )
      }

      const probe = await this.probeStoreFile(resolvedPath)
      if (probe.health === 'missing' && input.createIfMissing !== true) {
        throw new OperationError(
          'MEMORY_NOT_FOUND',
          `Memory store file not found at "${resolvedPath}".`,
        )
      }

      const existingIds = new Set(this.clients.map((client) => client.id))
      let id = `custom-${randomUUID().slice(0, 8)}`
      while (existingIds.has(id)) {
        id = `custom-${randomUUID().slice(0, 8)}`
      }

      const dshProtected =
        input.dshProtected !== undefined ? input.dshProtected : probe.format === 'dsh-unit'

      const created: RegisteredClient = {
        id,
        name,
        kind: 'custom',
        builtin: false,
        storePath: resolvedPath,
        enabled: true,
        dshProtected,
        allowInitializeWhenMissing: true,
        format: probe.format,
        health: probe.health,
        ...(probe.healthDetail !== undefined ? { healthDetail: probe.healthDetail } : {}),
        lastCheckedAt: probe.lastCheckedAt,
      }

      this.clients.push(created)
      await this.saveState()
      return cloneClient(created)
    })
  }

  /** Update mutable settings (name, enabled, or dshProtected) on a registered client. */
  updateClient(input: UpdateClientInput): Promise<RegisteredClient> {
    return this.runSerialized(async () => {
      const index = this.clients.findIndex((client) => client.id === input.id)
      if (index === -1) {
        throw new OperationError('MEMORY_NOT_FOUND', `Client "${input.id}" not found.`)
      }

      const existing = this.clients[index]!
      let nextName = existing.name
      if (input.name !== undefined) {
        const trimmed = input.name.trim()
        if (trimmed.length === 0) {
          throw new OperationError('MEMORY_INVALID_CONFIG', 'Client name must not be empty.')
        }
        nextName = trimmed
      }

      if (input.dshProtected === false && existing.kind === 'dsh') {
        throw new OperationError(
          'MEMORY_FORBIDDEN',
          `Cannot disable DSH write protection on built-in DSH client "${existing.id}".`,
        )
      }

      const updated: RegisteredClient = {
        ...existing,
        name: nextName,
        enabled: input.enabled ?? existing.enabled,
        dshProtected: input.dshProtected ?? existing.dshProtected,
      }

      this.clients[index] = updated
      await this.saveState()
      return cloneClient(updated)
    })
  }

  /**
   * Remove a custom client from `desktop-state.json` without touching its
   * `memory.json` file on disk. Throws `MEMORY_FORBIDDEN` for built-in clients.
   */
  removeCustomClient(id: string): Promise<boolean> {
    return this.runSerialized(async () => {
      const index = this.clients.findIndex((client) => client.id === id)
      if (index === -1) {
        return false
      }

      const target = this.clients[index]!
      if (target.builtin) {
        throw new OperationError(
          'MEMORY_FORBIDDEN',
          `Built-in client "${target.id}" cannot be removed from the registry.`,
        )
      }

      this.clients.splice(index, 1)
      await this.saveState()
      return true
    })
  }

  /** Return current desktop UI preferences. */
  getPreferences(): DesktopPreferences {
    return clonePreferences(this.preferences)
  }

  /** Merge and atomically persist desktop UI preferences. */
  updatePreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences> {
    return this.runSerialized(async () => {
      const parsed = preferencesPatchSchema.safeParse(patch)
      if (!parsed.success) {
        throw new OperationError(
          'MEMORY_INVALID_CONFIG',
          `Invalid desktop preferences patch: ${parsed.error.message}`,
        )
      }

      const nextBounds =
        parsed.data.windowBounds !== undefined
          ? { ...parsed.data.windowBounds }
          : this.preferences.windowBounds !== undefined
            ? { ...this.preferences.windowBounds }
            : undefined

      this.preferences = {
        theme: parsed.data.theme ?? this.preferences.theme,
        locale: parsed.data.locale ?? this.preferences.locale,
        ...(nextBounds !== undefined ? { windowBounds: nextBounds } : {}),
      }

      await this.saveState()
      return this.getPreferences()
    })
  }

  /** Return the legacy `dsh-memory` AGY store path if detected during discovery. */
  getLegacyAgyCandidate(): string | undefined {
    return this.legacyAgyCandidate
  }
}
