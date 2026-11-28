/**
 * Pure-Node, zod-validated IPC handler registry and authorized-path guard for
 * Memloom Desktop's Electron Main process.
 * @module memloom/desktop/main/ipc-handlers
 */
import path from 'node:path'
import { z } from 'zod'
import type { MemoryConfig } from '../../core/config.ts'
import type { WorkspaceSummary } from '../../core/engine.ts'
import type { ExportScope, MemoryExport, WorkspaceMapping } from '../../core/exchange.ts'
import {
  episodeRecordSchema,
  memoryRecordSchema,
  memoryStatusSchema,
  memoryTypeSchema,
} from '../../shared/types.ts'
import {
  IPC_CHANNELS,
  isAllowedExternalUrl,
  mapDesktopError,
  type AggregateWorkspaceItem,
  type AggregateWorkspacesResult,
  type DesktopAppInfo,
  type IpcResult,
} from '../ipc-contract.ts'
import {
  DesktopUnsupportedError,
  type AggregateSearchRequest,
  type AggregateSearchResult,
  type MigrationSourceSelection,
  type MultiClientService,
} from '../multi-service.ts'
import { isAllowedDshCliBasename, type DesktopPluginManager } from '../plugin-manager.ts'
import type { DesktopPreferences } from '../registry.ts'
import type { DesktopUpdater } from '../updater.ts'

export interface DialogAdapter {
  pickMemoryFile(mode: 'open' | 'create'): Promise<string | null>
  pickDirectory(): Promise<string | null>
  pickImportJson(): Promise<{ path: string; content: string } | null>
  saveExportJson(defaultFileName: string, content: string): Promise<string | null>
  pickDshCli(): Promise<string | null>
}

export interface DesktopIpcDeps {
  readonly service: MultiClientService
  readonly dialog: DialogAdapter
  readonly appInfo: DesktopAppInfo
  readonly pluginManager?: DesktopPluginManager
  readonly updater?: DesktopUpdater
  readonly resolveBundledAvailable?: () => Promise<boolean>
  readonly openExternal?: (url: string) => Promise<void>
  readonly onPreferencesUpdated?: (prefs: DesktopPreferences) => void | Promise<void>
  readonly pathBook?: AuthorizedPathBook
}

function hasUnsafePathSegments(rawPath: string): boolean {
  if (rawPath.trim() === '' || rawPath.includes('\0')) {
    return true
  }
  const segments = rawPath.split(/[\\/]+/)
  return segments.includes('..')
}

function normalizePathKey(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Session-scoped registry of filesystem paths explicitly authorized via native
 * OS file/directory dialogs (or the service-discovered legacy AGY path).
 */
export class AuthorizedPathBook {
  private readonly authorizedFiles = new Set<string>()
  private readonly authorizedDirectories = new Set<string>()

  /** Record a file path selected through an OS dialog. */
  authorizeFile(filePath: string): string {
    const resolved = path.resolve(filePath)
    this.authorizedFiles.add(normalizePathKey(resolved))
    return resolved
  }

  /** Record a directory path selected through an OS dialog. */
  authorizeDirectory(dirPath: string): string {
    const resolved = path.resolve(dirPath)
    this.authorizedDirectories.add(normalizePathKey(resolved))
    return resolved
  }

  /** Return true iff `rawPath` is a clean absolute path inside an authorized file or directory. */
  isFileAuthorized(rawPath: string): boolean {
    if (hasUnsafePathSegments(rawPath) || !path.isAbsolute(rawPath)) {
      return false
    }
    const resolved = path.resolve(rawPath)
    const fileKey = normalizePathKey(resolved)
    if (this.authorizedFiles.has(fileKey)) {
      return true
    }
    const parentKey = normalizePathKey(path.dirname(resolved))
    return this.authorizedDirectories.has(parentKey)
  }

  /** Return true iff `rawPath` is a clean absolute path matching an authorized directory. */
  isDirectoryAuthorized(rawPath: string): boolean {
    if (hasUnsafePathSegments(rawPath) || !path.isAbsolute(rawPath)) {
      return false
    }
    return this.authorizedDirectories.has(normalizePathKey(rawPath))
  }

  /** Clear all recorded path grants. */
  clear(): void {
    this.authorizedFiles.clear()
    this.authorizedDirectories.clear()
  }
}

function isExactCandidatePath(rawPath: string, candidate: string | undefined): boolean {
  if (candidate === undefined || hasUnsafePathSegments(rawPath) || !path.isAbsolute(rawPath)) {
    return false
  }
  return normalizePathKey(rawPath) === normalizePathKey(candidate)
}

/* ------------------------------------------------------------------ *
 * Strict zod input schemas
 * ------------------------------------------------------------------ */

const nonEmptyId = z.string().trim().min(1)
const nonEmptyText = z.string().trim().min(1)
const workspaceFilterSchema = z.union([nonEmptyText, z.null()])

const exportScopeSchema: z.ZodType<ExportScope> = z.union([
  z.literal('all'),
  z.literal('global'),
  z.object({ workspaceKey: nonEmptyText }).strict(),
])

const workspaceMappingSchema: z.ZodType<WorkspaceMapping> = z.record(
  z.string().min(1),
  z
    .object({
      key: nonEmptyText,
      root: nonEmptyText,
    })
    .strict(),
)

const noArgsSchema = z.undefined()

const addClientSchema = z
  .object({
    name: nonEmptyText,
    storePath: nonEmptyText,
    dshProtected: z.boolean().optional(),
    createIfMissing: z.boolean().optional(),
  })
  .strict()

const updateClientSchema = z
  .object({
    id: nonEmptyId,
    name: nonEmptyText.optional(),
    enabled: z.boolean().optional(),
    dshProtected: z.boolean().optional(),
  })
  .strict()

const removeClientSchema = z.object({ id: nonEmptyId }).strict()
const forceUnlockSchema = z.object({ confirmed: z.boolean() }).strict()

const overviewSchema = z
  .object({
    clientId: nonEmptyId,
    workspaceKey: workspaceFilterSchema.optional(),
  })
  .strict()

const listSchema = z
  .object({
    clientId: nonEmptyId,
    workspaceKey: workspaceFilterSchema.optional(),
    scopeKind: z.enum(['workspace', 'global']).optional(),
    type: memoryTypeSchema.optional(),
    status: memoryStatusSchema.optional(),
    tags: z.array(z.string()).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    management: z.boolean().optional(),
    includeExpired: z.boolean().optional(),
  })
  .strict()

const viewSchema = z.object({ clientId: nonEmptyId, id: nonEmptyId }).strict()

const createSchema = z
  .object({
    clientId: nonEmptyId,
    type: memoryTypeSchema,
    title: z.string(),
    body: z.string(),
    scope: z.enum(['workspace', 'global']).optional(),
    workspaceKey: nonEmptyText.optional(),
    workspaceRoot: nonEmptyText.optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().finite().min(0).max(1).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    pinned: z.boolean().optional(),
    status: z.enum(['active', 'pending']).optional(),
  })
  .strict()

const updateSchema = z
  .object({
    clientId: nonEmptyId,
    id: nonEmptyId,
    expectedContentRevision: z.number().int().min(1),
    type: memoryTypeSchema.optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().finite().min(0).max(1).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    pinned: z.boolean().optional(),
    status: z.enum(['active', 'archived']).optional(),
    scope: z.enum(['workspace', 'global']).optional(),
    workspaceKey: nonEmptyText.optional(),
    workspaceRoot: nonEmptyText.optional(),
  })
  .strict()

const deleteSchema = z
  .object({
    clientId: nonEmptyId,
    id: nonEmptyId,
    permanent: z.boolean().optional(),
    confirm: z.boolean().optional(),
    actor: z.enum(['user', 'model']).optional(),
  })
  .strict()

const restoreSchema = z.object({ clientId: nonEmptyId, id: nonEmptyId }).strict()

const reviewSchema = z
  .object({
    clientId: nonEmptyId,
    id: nonEmptyId,
    action: z.enum(['accept', 'reject']),
  })
  .strict()

const listDreamsSchema = z
  .object({
    clientId: nonEmptyId,
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()

const undoDreamSchema = z
  .object({
    clientId: nonEmptyId,
    dreamId: nonEmptyId,
  })
  .strict()

const listAuditSchema = z
  .object({
    clientId: nonEmptyId,
    memoryId: nonEmptyId.optional(),
    dreamId: nonEmptyId.optional(),
    workspaceKey: workspaceFilterSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()

const clientOnlySchema = z.object({ clientId: nonEmptyId }).strict()

const exportSchema = z
  .object({
    clientId: nonEmptyId,
    scope: exportScopeSchema,
    includeArchived: z.boolean().optional(),
  })
  .strict()

const memoryExportSchema: z.ZodType<MemoryExport> = z
  .object({
    format: z.enum(['memloom', 'dsh-memory']),
    version: z.literal(1),
    exportedAt: z.string().min(1),
    scope: exportScopeSchema,
    includeArchived: z.boolean(),
    memories: z.array(memoryRecordSchema),
    episodes: z.array(episodeRecordSchema),
  })
  .strict()

const importOptionsSchema = z
  .object({
    mode: z.enum(['merge', 'replace']).optional(),
    mapping: workspaceMappingSchema.optional(),
    confirm: z.boolean().optional(),
    targetScope: exportScopeSchema.optional(),
    redactSecrets: z.boolean().optional(),
  })
  .strict()

const importSchema = z
  .object({
    clientId: nonEmptyId,
    payload: memoryExportSchema,
    options: importOptionsSchema.optional(),
  })
  .strict()

const rebuildSchema = z
  .object({
    clientId: nonEmptyId,
    scope: exportScopeSchema,
    since: z.string().min(1).optional(),
    confirm: z.boolean().optional(),
  })
  .strict()

const purgeAllSchema = z
  .object({
    clientId: nonEmptyId,
    scope: exportScopeSchema,
    confirmText: z.string(),
  })
  .strict()

const updateConfigSchema = z
  .object({
    clientId: nonEmptyId,
    patch: z.record(z.string(), z.unknown()),
  })
  .strict()

const aggregateSearchSchema = z
  .object({
    query: z.string().optional(),
    clientIds: z.array(nonEmptyId).optional(),
    workspaceKey: workspaceFilterSchema.optional(),
    types: z.array(memoryTypeSchema).optional(),
    statuses: z.array(memoryStatusSchema).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()
  .optional()

const aggregateWorkspacesSchema = z
  .object({
    clientIds: z.array(nonEmptyId).optional(),
  })
  .strict()
  .optional()

const migrationSelectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('scope'),
      scope: exportScopeSchema,
      includeArchived: z.boolean().optional(),
      includeEpisodes: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('records'),
      memoryIds: z.array(nonEmptyId).min(1),
    })
    .strict(),
])

const migrationPreviewSchema = z
  .object({
    sourceClientId: nonEmptyId,
    targetClientId: nonEmptyId,
    selection: migrationSelectionSchema,
  })
  .strict()

const migrationExecuteSchema = z
  .object({
    sourceClientId: nonEmptyId,
    targetClientId: nonEmptyId,
    selection: migrationSelectionSchema,
    mode: z.enum(['merge', 'replace']),
    mapping: workspaceMappingSchema,
    targetScope: exportScopeSchema.optional(),
    confirm: z.boolean().optional(),
  })
  .strict()

const pickMemoryFileSchema = z
  .object({
    mode: z.enum(['open', 'create']),
  })
  .strict()

const saveExportJsonSchema = z
  .object({
    defaultFileName: nonEmptyText,
    content: z.string(),
  })
  .strict()

const windowBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()

const updatePreferencesSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    locale: z.enum(['zh', 'en']).optional(),
    windowBounds: windowBoundsSchema.optional(),
    dshCliPath: z.union([z.string(), z.null()]).optional(),
  })
  .strict()

const pluginsInstallSchema = z
  .object({
    kind: z.enum(['agy', 'dsh']),
    profileName: nonEmptyText.optional(),
    source: z.enum(['bundled', 'online']).optional(),
    version: nonEmptyText.optional(),
  })
  .strict()

const pluginsUninstallSchema = z
  .object({
    kind: z.enum(['agy', 'dsh']),
    profileName: nonEmptyText.optional(),
  })
  .strict()

const openExternalSchema = z
  .object({
    url: nonEmptyText,
  })
  .strict()

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function stripUndefinedProps<T extends Record<string, unknown>>(
  obj: T,
): {
  [K in keyof T]: Exclude<T[K], undefined>
} {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> }
}

function invalidArgsResult(error: z.ZodError): IpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'desktop/invalid-args',
      message: error.issues[0]?.message ?? error.message,
      details: { issues: error.issues },
    },
  }
}

function makeValidatedHandler<S extends z.ZodTypeAny, R>(
  schema: S,
  exec: (parsed: z.infer<S>) => Promise<IpcResult<R>> | IpcResult<R>,
): (rawPayload?: unknown) => Promise<IpcResult<unknown>> {
  return async (rawPayload?: unknown): Promise<IpcResult<unknown>> => {
    const parsed = schema.safeParse(rawPayload)
    if (!parsed.success) {
      return invalidArgsResult(parsed.error)
    }
    try {
      return await exec(parsed.data)
    } catch (err) {
      return {
        ok: false,
        error: mapDesktopError(err),
      }
    }
  }
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

async function aggregateWorkspacesAcrossClients(
  service: MultiClientService,
  clientIds?: readonly string[],
): Promise<AggregateWorkspacesResult> {
  const filterSet = clientIds !== undefined ? new Set(clientIds) : null
  const clients = service
    .listClients()
    .filter((client) => client.enabled && (filterSet === null || filterSet.has(client.id)))

  const skippedClients: AggregateSearchResult['skippedClients'][number][] = []
  const byClient: AggregateWorkspaceItem[] = []
  const merged = new Map<string, WorkspaceSummary>()

  for (const client of clients) {
    if (client.health !== 'ready') {
      skippedClients.push({
        id: client.id,
        name: client.name,
        health: client.health,
        ...(client.healthDetail !== undefined ? { detail: client.healthDetail } : {}),
      })
      continue
    }
    try {
      const workspaces = await service.listWorkspaces(client.id)
      for (const ws of workspaces) {
        byClient.push({
          ...ws,
          clientId: client.id,
          clientName: client.name,
        })
        const existing = merged.get(ws.key)
        if (existing === undefined) {
          merged.set(ws.key, { ...ws })
        } else {
          existing.memoryCount += ws.memoryCount
          if (ws.updatedAt.localeCompare(existing.updatedAt) > 0) {
            existing.updatedAt = ws.updatedAt
            if (ws.root !== '') existing.root = ws.root
          }
        }
      }
    } catch (err) {
      skippedClients.push({
        id: client.id,
        name: client.name,
        health: 'unreadable',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const items = [...merged.values()].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key),
  )

  return { items, byClient, skippedClients }
}

/* ------------------------------------------------------------------ *
 * Handler factory
 * ------------------------------------------------------------------ */

/**
 * Create the complete map of zod-validated Main IPC handlers keyed by channel name.
 * Remains pure Node and Electron-free so integration tests can invoke handlers directly.
 */
export function createDesktopIpcHandlers(
  deps: DesktopIpcDeps,
): Record<string, (rawPayload?: unknown) => Promise<IpcResult<unknown>>> {
  const pathBook = deps.pathBook ?? new AuthorizedPathBook()
  const { service, dialog } = deps

  return {
    [IPC_CHANNELS.clientsList]: makeValidatedHandler(noArgsSchema, () => ok(service.listClients())),
    [IPC_CHANNELS.clientsRefreshAll]: makeValidatedHandler(noArgsSchema, async () =>
      ok(await service.refreshAll()),
    ),
    [IPC_CHANNELS.clientsAdd]: makeValidatedHandler(addClientSchema, async (input) => {
      const legacyCandidate = service.getLegacyAgyCandidate()
      const authorized =
        pathBook.isFileAuthorized(input.storePath) ||
        isExactCandidatePath(input.storePath, legacyCandidate)
      if (!authorized) {
        return {
          ok: false,
          error: {
            code: 'memory/forbidden',
            message:
              'Store path must be selected via an OS file/directory dialog or match the detected legacy AGY store.',
            details: { code: 'MEMORY_FORBIDDEN' },
          },
        }
      }
      const cleanInput = stripUndefinedProps(input)
      return ok(await service.addCustomClient(cleanInput))
    }),
    [IPC_CHANNELS.clientsUpdate]: makeValidatedHandler(updateClientSchema, async (input) =>
      ok(await service.updateClient(stripUndefinedProps(input))),
    ),
    [IPC_CHANNELS.clientsRemove]: makeValidatedHandler(removeClientSchema, async (input) =>
      ok(await service.removeCustomClient(input.id)),
    ),
    [IPC_CHANNELS.clientsGetGuardSnapshot]: makeValidatedHandler(noArgsSchema, () =>
      ok(service.getGuardSnapshot()),
    ),
    [IPC_CHANNELS.clientsRefreshDshGuard]: makeValidatedHandler(noArgsSchema, async () =>
      ok(await service.refreshDshGuard()),
    ),
    [IPC_CHANNELS.clientsForceUnlockDsh]: makeValidatedHandler(forceUnlockSchema, (input) =>
      ok(service.forceUnlockDsh(input.confirmed)),
    ),
    [IPC_CHANNELS.clientsRelockDsh]: makeValidatedHandler(noArgsSchema, () =>
      ok(service.relockDsh()),
    ),
    [IPC_CHANNELS.clientsGetLegacyAgyCandidate]: makeValidatedHandler(noArgsSchema, () =>
      ok(service.getLegacyAgyCandidate() ?? null),
    ),

    [IPC_CHANNELS.memoryOverview]: makeValidatedHandler(overviewSchema, async (input) =>
      ok(await service.overview(input.clientId, input.workspaceKey ?? 'all')),
    ),
    [IPC_CHANNELS.memoryList]: makeValidatedHandler(listSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.list(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryView]: makeValidatedHandler(viewSchema, async (input) =>
      ok(await service.view(input.clientId, input.id)),
    ),
    [IPC_CHANNELS.memoryCreate]: makeValidatedHandler(createSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.create(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryUpdate]: makeValidatedHandler(updateSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.update(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryDelete]: makeValidatedHandler(deleteSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.delete(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryRestore]: makeValidatedHandler(restoreSchema, async (input) =>
      ok(await service.restore(input.clientId, input.id)),
    ),
    [IPC_CHANNELS.memoryReview]: makeValidatedHandler(reviewSchema, async (input) =>
      ok(await service.review(input.clientId, { id: input.id, action: input.action })),
    ),
    [IPC_CHANNELS.memoryListDreams]: makeValidatedHandler(listDreamsSchema, async (input) =>
      ok(await service.listDreams(input.clientId, input.limit)),
    ),
    [IPC_CHANNELS.memoryUndoDream]: makeValidatedHandler(undoDreamSchema, async (input) =>
      ok(await service.undoDream(input.clientId, input.dreamId)),
    ),
    [IPC_CHANNELS.memoryListAudit]: makeValidatedHandler(listAuditSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.listAudit(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryListWorkspaces]: makeValidatedHandler(clientOnlySchema, async (input) =>
      ok(await service.listWorkspaces(input.clientId)),
    ),
    [IPC_CHANNELS.memoryExport]: makeValidatedHandler(exportSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.export(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryImport]: makeValidatedHandler(importSchema, async (input) =>
      ok(
        await service.import(
          input.clientId,
          input.payload,
          input.options !== undefined ? stripUndefinedProps(input.options) : undefined,
        ),
      ),
    ),
    [IPC_CHANNELS.memoryRebuild]: makeValidatedHandler(rebuildSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.rebuild(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryPurgeAll]: makeValidatedHandler(purgeAllSchema, async (input) => {
      const { clientId, ...rest } = input
      return ok(await service.purgeAll(clientId, stripUndefinedProps(rest)))
    }),
    [IPC_CHANNELS.memoryGetConfig]: makeValidatedHandler(clientOnlySchema, async (input) =>
      ok(await service.getConfig(input.clientId)),
    ),
    [IPC_CHANNELS.memoryUpdateConfig]: makeValidatedHandler(updateConfigSchema, async (input) =>
      ok(await service.updateConfig(input.clientId, input.patch as Partial<MemoryConfig>)),
    ),

    [IPC_CHANNELS.aggregateSearch]: makeValidatedHandler(aggregateSearchSchema, async (input) => {
      const request: AggregateSearchRequest = input === undefined ? {} : stripUndefinedProps(input)
      return ok(await service.aggregateSearch(request))
    }),
    [IPC_CHANNELS.aggregateListWorkspaces]: makeValidatedHandler(
      aggregateWorkspacesSchema,
      async (input) => ok(await aggregateWorkspacesAcrossClients(service, input?.clientIds)),
    ),

    [IPC_CHANNELS.migrationPreview]: makeValidatedHandler(migrationPreviewSchema, async (input) =>
      ok(
        await service.previewMigration({
          sourceClientId: input.sourceClientId,
          targetClientId: input.targetClientId,
          selection: stripUndefinedProps(input.selection) as MigrationSourceSelection,
        }),
      ),
    ),
    [IPC_CHANNELS.migrationExecute]: makeValidatedHandler(migrationExecuteSchema, async (input) =>
      ok(
        await service.executeMigration({
          ...stripUndefinedProps(input),
          selection: stripUndefinedProps(input.selection) as MigrationSourceSelection,
        }),
      ),
    ),

    [IPC_CHANNELS.dialogPickMemoryFile]: makeValidatedHandler(
      pickMemoryFileSchema,
      async (input) => {
        const picked = await dialog.pickMemoryFile(input.mode)
        if (picked === null) return ok(null)
        return ok(pathBook.authorizeFile(picked))
      },
    ),
    [IPC_CHANNELS.dialogPickDirectory]: makeValidatedHandler(noArgsSchema, async () => {
      const picked = await dialog.pickDirectory()
      if (picked === null) return ok(null)
      return ok(pathBook.authorizeDirectory(picked))
    }),
    [IPC_CHANNELS.dialogPickImportJson]: makeValidatedHandler(noArgsSchema, async () => {
      const picked = await dialog.pickImportJson()
      if (picked === null) return ok(null)
      const authorized = pathBook.authorizeFile(picked.path)
      return ok({ path: authorized, content: picked.content })
    }),
    [IPC_CHANNELS.dialogSaveExportJson]: makeValidatedHandler(
      saveExportJsonSchema,
      async (input) => {
        const saved = await dialog.saveExportJson(input.defaultFileName, input.content)
        return ok(saved)
      },
    ),
    [IPC_CHANNELS.dialogPickDshCli]: makeValidatedHandler(noArgsSchema, async () => {
      const picked = await dialog.pickDshCli()
      if (picked === null) return ok(null)
      return ok(pathBook.authorizeFile(picked))
    }),

    [IPC_CHANNELS.pluginsListDshProfiles]: makeValidatedHandler(noArgsSchema, async () => {
      if (deps.pluginManager === undefined) {
        throw new DesktopUnsupportedError('Plugin manager is not available in this runtime.')
      }
      return ok(await deps.pluginManager.listDshProfiles())
    }),
    [IPC_CHANNELS.pluginsInstall]: makeValidatedHandler(pluginsInstallSchema, async (input) => {
      const source = input.source ?? 'bundled'
      if (source === 'online') {
        if (deps.updater === undefined) {
          throw new DesktopUnsupportedError('Updater is not available in this runtime.')
        }
        return ok(await deps.updater.installOnlinePlugin(stripUndefinedProps(input)))
      }
      if (deps.pluginManager === undefined) {
        throw new DesktopUnsupportedError('Plugin manager is not available in this runtime.')
      }
      const bundledAvailable =
        deps.resolveBundledAvailable !== undefined
          ? await deps.resolveBundledAvailable()
          : deps.appInfo.bundledPluginsAvailable
      if (!bundledAvailable) {
        throw new DesktopUnsupportedError(
          'Bundled plugins are not available in this build; switch to online installation.',
        )
      }
      return ok(await deps.pluginManager.installBundled(stripUndefinedProps(input)))
    }),
    [IPC_CHANNELS.pluginsUninstall]: makeValidatedHandler(pluginsUninstallSchema, async (input) => {
      if (deps.pluginManager === undefined) {
        throw new DesktopUnsupportedError('Plugin manager is not available in this runtime.')
      }
      return ok(await deps.pluginManager.uninstall(stripUndefinedProps(input)))
    }),
    [IPC_CHANNELS.pluginsSyncPending]: makeValidatedHandler(noArgsSchema, async () => {
      if (deps.updater === undefined) {
        throw new DesktopUnsupportedError('Updater is not available in this runtime.')
      }
      return ok(await deps.updater.syncPending())
    }),
    [IPC_CHANNELS.pluginsDismissPendingSync]: makeValidatedHandler(noArgsSchema, async () => {
      if (deps.updater === undefined) {
        throw new DesktopUnsupportedError('Updater is not available in this runtime.')
      }
      return ok(await deps.updater.dismissPendingSync())
    }),

    [IPC_CHANNELS.updaterCheck]: makeValidatedHandler(noArgsSchema, async () => {
      if (deps.updater === undefined) {
        throw new DesktopUnsupportedError('Updater is not available in this runtime.')
      }
      return ok(await deps.updater.checkForUpdates())
    }),
    [IPC_CHANNELS.updaterGetState]: makeValidatedHandler(noArgsSchema, () => {
      if (deps.updater === undefined) {
        throw new DesktopUnsupportedError('Updater is not available in this runtime.')
      }
      return ok(deps.updater.getState())
    }),
    [IPC_CHANNELS.updaterCancel]: makeValidatedHandler(noArgsSchema, async () => {
      if (deps.updater === undefined) {
        throw new DesktopUnsupportedError('Updater is not available in this runtime.')
      }
      return ok(await deps.updater.cancel())
    }),
    [IPC_CHANNELS.updaterStartAppUpdate]: makeValidatedHandler(noArgsSchema, async () => {
      if (deps.updater === undefined) {
        throw new DesktopUnsupportedError('Updater is not available in this runtime.')
      }
      return ok(await deps.updater.startAppUpdate())
    }),
    [IPC_CHANNELS.updaterUpdateInstalledPluginsOnline]: makeValidatedHandler(
      noArgsSchema,
      async () => {
        if (deps.updater === undefined) {
          throw new DesktopUnsupportedError('Updater is not available in this runtime.')
        }
        return ok(await deps.updater.updateInstalledPluginsOnline())
      },
    ),

    [IPC_CHANNELS.appGetInfo]: makeValidatedHandler(noArgsSchema, async () => {
      const bundledPluginsAvailable =
        deps.resolveBundledAvailable !== undefined
          ? await deps.resolveBundledAvailable()
          : deps.appInfo.bundledPluginsAvailable
      return ok({
        ...deps.appInfo,
        bundledPluginsAvailable,
      })
    }),
    [IPC_CHANNELS.appGetPreferences]: makeValidatedHandler(noArgsSchema, () =>
      ok(service.getPreferences()),
    ),
    [IPC_CHANNELS.appUpdatePreferences]: makeValidatedHandler(
      updatePreferencesSchema,
      async (patch) => {
        if (typeof patch.dshCliPath === 'string' && patch.dshCliPath.trim().length > 0) {
          const trimmed = patch.dshCliPath.trim()
          if (!isAllowedDshCliBasename(trimmed)) {
            return {
              ok: false,
              error: {
                code: 'desktop/invalid-args',
                message: 'dshCliPath must point to `dsh`, `dsh.exe`, or `dsh.cmd`.',
              },
            }
          }
          if (!pathBook.isFileAuthorized(trimmed)) {
            return {
              ok: false,
              error: {
                code: 'memory/forbidden',
                message: 'dshCliPath must be selected via the OS file dialog.',
                details: { code: 'MEMORY_FORBIDDEN' },
              },
            }
          }
        }
        const updated = await service.updatePreferences(stripUndefinedProps(patch))
        if (deps.onPreferencesUpdated !== undefined) {
          await deps.onPreferencesUpdated(updated)
        }
        return ok(updated)
      },
    ),
    [IPC_CHANNELS.appOpenExternal]: makeValidatedHandler(openExternalSchema, async (input) => {
      if (!isAllowedExternalUrl(input.url)) {
        return {
          ok: false,
          error: {
            code: 'memory/forbidden',
            message: `External URL is not in the Memloom allowlist: ${input.url}`,
            details: { code: 'MEMORY_FORBIDDEN' },
          },
        }
      }
      if (deps.openExternal !== undefined) {
        await deps.openExternal(input.url)
      }
      return ok(true)
    }),
  }
}
