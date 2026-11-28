/**
 * Typed Electron IPC channel constants, error mapping, and Preload bridge API
 * contract for Memloom Desktop.
 * @module memloom/desktop/ipc-contract
 */
import { ZodError } from 'zod'
import type { AuditListResult } from '../core/audit.ts'
import type { MemoryConfig } from '../core/config.ts'
import type {
  ManageCreateInput,
  ManageDeleteInput,
  ManageUpdateInput,
  MemoryAuditQuery,
  MemoryOverviewResult,
  WorkspaceSummary,
} from '../core/engine.ts'
import type {
  ExportRequest,
  ImportOptions,
  ImportReport,
  MemoryExport,
  PurgeReport,
  PurgeRequest,
  RebuildReport,
  RebuildRequest,
} from '../core/exchange.ts'
import {
  OperationError,
  type DreamUndoReport,
  type OperationErrorCode,
} from '../core/operations.ts'
import type { ListRequest, ListResult } from '../core/store.ts'
import type { DreamRun, MemoryRecord, MemorySourceRef } from '../shared/types.ts'
import {
  DesktopStoreCorruptError,
  DesktopUnsupportedError,
  type AggregateSearchRequest,
  type AggregateSearchResult,
  type DesktopClientConfigResult,
  type DesktopClientInfo,
  type MigrationExecuteRequest,
  type MigrationPreviewRequest,
  type MigrationPreviewResult,
} from './multi-service.ts'
import {
  DesktopBusyError,
  DesktopDshCliMissingError,
  DesktopDshRunningError,
  DesktopPluginOpError,
  type DshProfileSummary,
  type PluginOpResult,
} from './plugin-manager.ts'
import type {
  AddCustomClientInput,
  DesktopPreferences,
  DesktopPreferencesPatch,
  UpdateClientInput,
} from './registry.ts'
import { DesktopExternalChangeError } from './storage/dsh-domain.ts'
import {
  DesktopUpdateChecksumError,
  DesktopUpdateNetworkError,
  type DesktopRuntimeMode,
  type UpdateCheckResult,
  type UpdaterTaskSnapshot,
} from './updater.ts'
import { DesktopReadonlyGuardError, type WriteGuardSnapshot } from './write-guard.ts'

import { IPC_CHANNELS } from './bridge-shared.ts'

export { IPC_CHANNELS }

export type IpcErrorCode =
  | 'memory/conflict'
  | 'memory/not-found'
  | 'memory/invalid'
  | 'memory/forbidden'
  | 'memory/capacity'
  | 'memory/unavailable'
  | 'desktop/readonly-guard'
  | 'desktop/external-change'
  | 'desktop/store-corrupt'
  | 'desktop/unsupported'
  | 'desktop/invalid-args'
  | 'desktop/internal'
  | 'desktop/busy'
  | 'desktop/dsh-running'
  | 'desktop/dsh-cli-missing'
  | 'desktop/update-network'
  | 'desktop/update-checksum-failed'
  | 'desktop/plugin-op-failed'

export interface IpcError {
  readonly code: IpcErrorCode
  readonly message: string
  readonly details?: Record<string, unknown>
}

export type IpcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError }

export interface DesktopAppInfo {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly systemTheme?: 'light' | 'dark'
  readonly runtimeMode: DesktopRuntimeMode
  readonly bundledPluginsAvailable: boolean
}

export interface AggregateWorkspaceItem extends WorkspaceSummary {
  readonly clientId: string
  readonly clientName: string
}

export interface AggregateWorkspacesResult {
  readonly items: WorkspaceSummary[]
  readonly byClient: AggregateWorkspaceItem[]
  readonly skippedClients: AggregateSearchResult['skippedClients']
}

const OPERATION_CODE_MAP: Record<OperationErrorCode, IpcErrorCode> = {
  MEMORY_CONFLICT: 'memory/conflict',
  MEMORY_NOT_FOUND: 'memory/not-found',
  MEMORY_INVALID_CONTENT: 'memory/invalid',
  MEMORY_INVALID_CONFIG: 'memory/invalid',
  MEMORY_INVALID_QUERY: 'memory/invalid',
  MEMORY_FORBIDDEN: 'memory/forbidden',
  MEMORY_FORBIDDEN_SCOPE: 'memory/forbidden',
  MEMORY_CONFIRM_REQUIRED: 'memory/forbidden',
  MEMORY_CAPACITY: 'memory/capacity',
  MEMORY_RECOVERING: 'memory/unavailable',
  MEMORY_STOPPED: 'memory/unavailable',
  MEMORY_UNAVAILABLE: 'memory/unavailable',
}

/** Allowed external documentation repository URL prefix for `shell.openExternal`. */
export const ALLOWED_EXTERNAL_URL_PREFIX = 'https://github.com/JiaMingWang-CN/memloom'

/** Return whether an external URL is permitted to open in the OS browser. */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return false
  }
  return (
    parsed.pathname === '/JiaMingWang-CN/memloom' ||
    parsed.pathname.startsWith('/JiaMingWang-CN/memloom/')
  )
}

/** Map domain and desktop protection errors onto the stable {@link IpcError} envelope. */
export function mapDesktopError(error: unknown): {
  readonly code: IpcErrorCode
  readonly message: string
  readonly details?: Record<string, unknown>
} {
  if (error instanceof OperationError) {
    return {
      code: OPERATION_CODE_MAP[error.code],
      message: error.message,
      details: { code: error.code },
    }
  }
  if (error instanceof DesktopReadonlyGuardError) {
    return {
      code: 'desktop/readonly-guard',
      message: error.message,
      details: { snapshot: error.snapshot },
    }
  }
  if (error instanceof DesktopExternalChangeError) {
    return {
      code: 'desktop/external-change',
      message: error.message,
      details: { storePath: error.storePath },
    }
  }
  if (error instanceof DesktopStoreCorruptError) {
    return {
      code: 'desktop/store-corrupt',
      message: error.message,
      details: { clientId: error.clientId, storePath: error.storePath },
    }
  }
  if (error instanceof DesktopUnsupportedError) {
    return {
      code: 'desktop/unsupported',
      message: error.message,
    }
  }
  if (error instanceof DesktopBusyError) {
    return {
      code: 'desktop/busy',
      message: error.message,
    }
  }
  if (error instanceof DesktopDshRunningError) {
    return {
      code: 'desktop/dsh-running',
      message: error.message,
      details: { matchedProcesses: error.matchedProcesses },
    }
  }
  if (error instanceof DesktopDshCliMissingError) {
    return {
      code: 'desktop/dsh-cli-missing',
      message: error.message,
    }
  }
  if (error instanceof DesktopUpdateNetworkError) {
    return {
      code: 'desktop/update-network',
      message: error.message,
    }
  }
  if (error instanceof DesktopUpdateChecksumError) {
    return {
      code: 'desktop/update-checksum-failed',
      message: error.message,
    }
  }
  if (error instanceof DesktopPluginOpError) {
    return {
      code: 'desktop/plugin-op-failed',
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    }
  }
  if (error instanceof ZodError) {
    return {
      code: 'desktop/invalid-args',
      message: error.issues[0]?.message ?? error.message,
      details: { issues: error.issues },
    }
  }
  const message =
    error instanceof Error && error.message !== ''
      ? error.message
      : typeof error === 'string' && error !== ''
        ? error
        : 'Unexpected internal desktop error.'
  return {
    code: 'desktop/internal',
    message,
  }
}

/** Type-safe bridge exposed on `window.memloomDesktop` by the Preload script. */
export interface DesktopBridgeApi {
  readonly clients: {
    list(): Promise<IpcResult<DesktopClientInfo[]>>
    refreshAll(): Promise<IpcResult<DesktopClientInfo[]>>
    add(input: AddCustomClientInput): Promise<IpcResult<DesktopClientInfo>>
    update(input: UpdateClientInput): Promise<IpcResult<DesktopClientInfo>>
    remove(request: { readonly id: string }): Promise<IpcResult<boolean>>
    getGuardSnapshot(): Promise<IpcResult<WriteGuardSnapshot>>
    refreshDshGuard(): Promise<IpcResult<WriteGuardSnapshot>>
    forceUnlockDsh(request: { readonly confirmed: boolean }): Promise<IpcResult<WriteGuardSnapshot>>
    relockDsh(): Promise<IpcResult<WriteGuardSnapshot>>
    getLegacyAgyCandidate(): Promise<IpcResult<string | null>>
  }
  readonly memory: {
    overview(request: {
      readonly clientId: string
      readonly workspaceKey?: string | 'all' | null
    }): Promise<IpcResult<MemoryOverviewResult>>
    list(request: { readonly clientId: string } & ListRequest): Promise<IpcResult<ListResult>>
    view(request: {
      readonly clientId: string
      readonly id: string
    }): Promise<IpcResult<{ readonly record: MemoryRecord; readonly sources: MemorySourceRef[] }>>
    create(
      request: { readonly clientId: string } & ManageCreateInput,
    ): Promise<IpcResult<MemoryRecord>>
    update(
      request: { readonly clientId: string } & ManageUpdateInput,
    ): Promise<IpcResult<MemoryRecord>>
    delete(
      request: { readonly clientId: string } & ManageDeleteInput,
    ): Promise<IpcResult<{ readonly deleted: boolean; readonly record: MemoryRecord | null }>>
    restore(request: {
      readonly clientId: string
      readonly id: string
    }): Promise<IpcResult<MemoryRecord>>
    review(request: {
      readonly clientId: string
      readonly id: string
      readonly action: 'accept' | 'reject'
    }): Promise<IpcResult<MemoryRecord>>
    listDreams(request: {
      readonly clientId: string
      readonly limit?: number
    }): Promise<IpcResult<DreamRun[]>>
    undoDream(request: {
      readonly clientId: string
      readonly dreamId: string
    }): Promise<IpcResult<DreamUndoReport>>
    listAudit(
      request: { readonly clientId: string } & MemoryAuditQuery,
    ): Promise<IpcResult<AuditListResult>>
    listWorkspaces(request: { readonly clientId: string }): Promise<IpcResult<WorkspaceSummary[]>>
    export(request: { readonly clientId: string } & ExportRequest): Promise<IpcResult<MemoryExport>>
    import(request: {
      readonly clientId: string
      readonly payload: MemoryExport
      readonly options?: ImportOptions
    }): Promise<IpcResult<ImportReport>>
    rebuild(
      request: { readonly clientId: string } & RebuildRequest,
    ): Promise<IpcResult<RebuildReport>>
    purgeAll(request: { readonly clientId: string } & PurgeRequest): Promise<IpcResult<PurgeReport>>
    getConfig(request: { readonly clientId: string }): Promise<IpcResult<DesktopClientConfigResult>>
    updateConfig(request: {
      readonly clientId: string
      readonly patch: Partial<MemoryConfig>
    }): Promise<IpcResult<DesktopClientConfigResult>>
  }
  readonly aggregate: {
    search(request?: AggregateSearchRequest): Promise<IpcResult<AggregateSearchResult>>
    listWorkspaces(request?: {
      readonly clientIds?: readonly string[]
    }): Promise<IpcResult<AggregateWorkspacesResult>>
  }
  readonly migration: {
    preview(request: MigrationPreviewRequest): Promise<IpcResult<MigrationPreviewResult>>
    execute(request: MigrationExecuteRequest): Promise<IpcResult<ImportReport>>
  }
  readonly dialog: {
    pickMemoryFile(request: { readonly mode: 'open' | 'create' }): Promise<IpcResult<string | null>>
    pickDirectory(): Promise<IpcResult<string | null>>
    pickImportJson(): Promise<IpcResult<{ readonly path: string; readonly content: string } | null>>
    saveExportJson(request: {
      readonly defaultFileName: string
      readonly content: string
    }): Promise<IpcResult<string | null>>
    pickDshCli(): Promise<IpcResult<string | null>>
  }
  readonly plugins: {
    listDshProfiles(): Promise<IpcResult<DshProfileSummary[]>>
    install(request: {
      readonly kind: 'agy' | 'dsh'
      readonly profileName?: string
      readonly source?: 'bundled' | 'online'
      readonly version?: string
    }): Promise<IpcResult<PluginOpResult>>
    uninstall(request: {
      readonly kind: 'agy' | 'dsh'
      readonly profileName?: string
    }): Promise<IpcResult<PluginOpResult>>
    syncPending(): Promise<IpcResult<UpdaterTaskSnapshot>>
    dismissPendingSync(): Promise<IpcResult<UpdaterTaskSnapshot>>
  }
  readonly updater: {
    check(): Promise<IpcResult<UpdateCheckResult>>
    getState(): Promise<IpcResult<UpdaterTaskSnapshot>>
    cancel(): Promise<IpcResult<UpdaterTaskSnapshot>>
    startAppUpdate(): Promise<IpcResult<UpdaterTaskSnapshot>>
    updateInstalledPluginsOnline(): Promise<IpcResult<UpdaterTaskSnapshot>>
  }
  readonly app: {
    getInfo(): Promise<IpcResult<DesktopAppInfo>>
    getPreferences(): Promise<IpcResult<DesktopPreferences>>
    updatePreferences(patch: DesktopPreferencesPatch): Promise<IpcResult<DesktopPreferences>>
    openExternal(request: { readonly url: string }): Promise<IpcResult<boolean>>
    onFocusRefresh(listener: () => void): () => void
  }
}

declare global {
  interface Window {
    memloomDesktop?: DesktopBridgeApi
  }
}
