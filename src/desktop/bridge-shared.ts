/**
 * Browser-safe IPC channel constants and {@link DesktopBridgeApi} factory shared
 * by Electron Preload and the signed-runtime local fetch bridge.
 * @module memloom/desktop/bridge-shared
 */
import type { DesktopBridgeApi, IpcResult } from './ipc-contract.ts'

/** Compare two SemVer strings (`> 0` if `a > b`, `< 0` if `a < b`, `0` if equal). */
export function compareSemver(a: string, b: string): number {
  const parse = (raw: string) => {
    const cleaned = raw.trim().replace(/^v/i, '')
    const [corePart = '', ...preParts] = cleaned.split('-')
    const [majStr = '0', minStr = '0', patStr = '0'] = corePart.split('.')
    const major = Number.parseInt(majStr, 10)
    const minor = Number.parseInt(minStr, 10)
    const patch = Number.parseInt(patStr, 10)
    const preJoined = preParts.join('-').split('+')[0] ?? ''
    return {
      major: Number.isFinite(major) ? major : 0,
      minor: Number.isFinite(minor) ? minor : 0,
      patch: Number.isFinite(patch) ? patch : 0,
      prerelease: preJoined.length > 0 ? preJoined.split('.') : [],
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch

  const aPre = pa.prerelease
  const bPre = pb.prerelease
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1

  const len = Math.max(aPre.length, bPre.length)
  for (let i = 0; i < len; i++) {
    const segA = aPre[i]
    const segB = bPre[i]
    if (segA === undefined) return -1
    if (segB === undefined) return 1
    if (segA === segB) continue
    const numA = /^\d+$/.test(segA) ? Number.parseInt(segA, 10) : null
    const numB = /^\d+$/.test(segB) ? Number.parseInt(segB, 10) : null
    if (numA !== null && numB !== null) return numA - numB
    if (numA !== null) return -1
    if (numB !== null) return 1
    return segA.localeCompare(segB)
  }
  return 0
}

/** Whitelisted IPC channel names shared by Main, Preload, and Renderer. */
export const IPC_CHANNELS = {
  clientsList: 'clients:list',
  clientsRefreshAll: 'clients:refreshAll',
  clientsAdd: 'clients:add',
  clientsUpdate: 'clients:update',
  clientsRemove: 'clients:remove',
  clientsGetGuardSnapshot: 'clients:getGuardSnapshot',
  clientsRefreshDshGuard: 'clients:refreshDshGuard',
  clientsForceUnlockDsh: 'clients:forceUnlockDsh',
  clientsRelockDsh: 'clients:relockDsh',
  clientsGetLegacyAgyCandidate: 'clients:getLegacyAgyCandidate',

  memoryOverview: 'memory:overview',
  memoryList: 'memory:list',
  memoryView: 'memory:view',
  memoryCreate: 'memory:create',
  memoryUpdate: 'memory:update',
  memoryDelete: 'memory:delete',
  memoryRestore: 'memory:restore',
  memoryReview: 'memory:review',
  memoryListDreams: 'memory:listDreams',
  memoryUndoDream: 'memory:undoDream',
  memoryListAudit: 'memory:listAudit',
  memoryListWorkspaces: 'memory:listWorkspaces',
  memoryExport: 'memory:export',
  memoryImport: 'memory:import',
  memoryRebuild: 'memory:rebuild',
  memoryPurgeAll: 'memory:purgeAll',
  memoryGetConfig: 'memory:getConfig',
  memoryUpdateConfig: 'memory:updateConfig',

  aggregateSearch: 'aggregate:search',
  aggregateListWorkspaces: 'aggregate:listWorkspaces',

  migrationPreview: 'migration:preview',
  migrationExecute: 'migration:execute',

  dialogPickMemoryFile: 'dialog:pickMemoryFile',
  dialogPickDirectory: 'dialog:pickDirectory',
  dialogPickImportJson: 'dialog:pickImportJson',
  dialogSaveExportJson: 'dialog:saveExportJson',
  dialogPickDshCli: 'dialog:pickDshCli',

  pluginsListDshProfiles: 'plugins:listDshProfiles',
  pluginsInstall: 'plugins:install',
  pluginsUninstall: 'plugins:uninstall',
  pluginsSyncPending: 'plugins:syncPending',
  pluginsDismissPendingSync: 'plugins:dismissPendingSync',

  updaterCheck: 'updater:check',
  updaterGetState: 'updater:getState',
  updaterCancel: 'updater:cancel',
  updaterStartAppUpdate: 'updater:startAppUpdate',
  updaterUpdateInstalledPluginsOnline: 'updater:updateInstalledPluginsOnline',

  appGetInfo: 'app:getInfo',
  appGetPreferences: 'app:getPreferences',
  appUpdatePreferences: 'app:updatePreferences',
  appOpenExternal: 'app:openExternal',
  appFocusRefresh: 'app:focusRefresh',
} as const

export interface PreloadIpcRendererLike {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  on(
    channel: string,
    listener: (event: { readonly senderId: number }, ...args: unknown[]) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: { readonly senderId: number }, ...args: unknown[]) => void,
  ): void
}

/**
 * Construct the whitelisted {@link DesktopBridgeApi} backed by an `ipcRenderer`-compatible
 * transport. Separated from Electron's global runtime so both Preload and the
 * local loopback bridge share one contract.
 */
export function createDesktopBridge(ipc: PreloadIpcRendererLike): DesktopBridgeApi {
  const invoke = <T>(channel: string, payload?: unknown): Promise<IpcResult<T>> =>
    payload === undefined
      ? ipc.invoke<IpcResult<T>>(channel)
      : ipc.invoke<IpcResult<T>>(channel, payload)

  return {
    clients: {
      list: () => invoke(IPC_CHANNELS.clientsList),
      refreshAll: () => invoke(IPC_CHANNELS.clientsRefreshAll),
      add: (input) => invoke(IPC_CHANNELS.clientsAdd, input),
      update: (input) => invoke(IPC_CHANNELS.clientsUpdate, input),
      remove: (request) => invoke(IPC_CHANNELS.clientsRemove, request),
      getGuardSnapshot: () => invoke(IPC_CHANNELS.clientsGetGuardSnapshot),
      refreshDshGuard: () => invoke(IPC_CHANNELS.clientsRefreshDshGuard),
      forceUnlockDsh: (request) => invoke(IPC_CHANNELS.clientsForceUnlockDsh, request),
      relockDsh: () => invoke(IPC_CHANNELS.clientsRelockDsh),
      getLegacyAgyCandidate: () => invoke(IPC_CHANNELS.clientsGetLegacyAgyCandidate),
    },
    memory: {
      overview: (request) => invoke(IPC_CHANNELS.memoryOverview, request),
      list: (request) => invoke(IPC_CHANNELS.memoryList, request),
      view: (request) => invoke(IPC_CHANNELS.memoryView, request),
      create: (request) => invoke(IPC_CHANNELS.memoryCreate, request),
      update: (request) => invoke(IPC_CHANNELS.memoryUpdate, request),
      delete: (request) => invoke(IPC_CHANNELS.memoryDelete, request),
      restore: (request) => invoke(IPC_CHANNELS.memoryRestore, request),
      review: (request) => invoke(IPC_CHANNELS.memoryReview, request),
      listDreams: (request) => invoke(IPC_CHANNELS.memoryListDreams, request),
      undoDream: (request) => invoke(IPC_CHANNELS.memoryUndoDream, request),
      listAudit: (request) => invoke(IPC_CHANNELS.memoryListAudit, request),
      listWorkspaces: (request) => invoke(IPC_CHANNELS.memoryListWorkspaces, request),
      export: (request) => invoke(IPC_CHANNELS.memoryExport, request),
      import: (request) => invoke(IPC_CHANNELS.memoryImport, request),
      rebuild: (request) => invoke(IPC_CHANNELS.memoryRebuild, request),
      purgeAll: (request) => invoke(IPC_CHANNELS.memoryPurgeAll, request),
      getConfig: (request) => invoke(IPC_CHANNELS.memoryGetConfig, request),
      updateConfig: (request) => invoke(IPC_CHANNELS.memoryUpdateConfig, request),
    },
    aggregate: {
      search: (request) => invoke(IPC_CHANNELS.aggregateSearch, request),
      listWorkspaces: (request) => invoke(IPC_CHANNELS.aggregateListWorkspaces, request),
    },
    migration: {
      preview: (request) => invoke(IPC_CHANNELS.migrationPreview, request),
      execute: (request) => invoke(IPC_CHANNELS.migrationExecute, request),
    },
    dialog: {
      pickMemoryFile: (request) => invoke(IPC_CHANNELS.dialogPickMemoryFile, request),
      pickDirectory: () => invoke(IPC_CHANNELS.dialogPickDirectory),
      pickImportJson: () => invoke(IPC_CHANNELS.dialogPickImportJson),
      saveExportJson: (request) => invoke(IPC_CHANNELS.dialogSaveExportJson, request),
      pickDshCli: () => invoke(IPC_CHANNELS.dialogPickDshCli),
    },
    plugins: {
      listDshProfiles: () => invoke(IPC_CHANNELS.pluginsListDshProfiles),
      install: (request) => invoke(IPC_CHANNELS.pluginsInstall, request),
      uninstall: (request) => invoke(IPC_CHANNELS.pluginsUninstall, request),
      syncPending: () => invoke(IPC_CHANNELS.pluginsSyncPending),
      dismissPendingSync: () => invoke(IPC_CHANNELS.pluginsDismissPendingSync),
    },
    updater: {
      check: () => invoke(IPC_CHANNELS.updaterCheck),
      getState: () => invoke(IPC_CHANNELS.updaterGetState),
      cancel: () => invoke(IPC_CHANNELS.updaterCancel),
      startAppUpdate: () => invoke(IPC_CHANNELS.updaterStartAppUpdate),
      updateInstalledPluginsOnline: () => invoke(IPC_CHANNELS.updaterUpdateInstalledPluginsOnline),
    },
    app: {
      getInfo: () => invoke(IPC_CHANNELS.appGetInfo),
      getPreferences: () => invoke(IPC_CHANNELS.appGetPreferences),
      updatePreferences: (patch) => invoke(IPC_CHANNELS.appUpdatePreferences, patch),
      openExternal: (request) => invoke(IPC_CHANNELS.appOpenExternal, request),
      onFocusRefresh: (listener) => {
        const handler = (): void => {
          listener()
        }
        ipc.on(IPC_CHANNELS.appFocusRefresh, handler)
        return () => {
          ipc.removeListener(IPC_CHANNELS.appFocusRefresh, handler)
        }
      },
    },
  }
}
