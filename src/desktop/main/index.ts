/**
 * Electron Main process entry point, secure window lifecycle, native dialog
 * adapter, and IPC handler registration for Memloom Desktop.
 * @module memloom/desktop/main
 */
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Electron from 'electron'
import { writeFileAtomic } from '../../agy/storage.ts'
import { resolveBundledPlugins } from '../bundled-plugins.ts'
import { IPC_CHANNELS, isAllowedExternalUrl } from '../ipc-contract.ts'
import { MultiClientService } from '../multi-service.ts'
import { createPlatformAdapter } from '../platform/index.ts'
import { DesktopPluginManager } from '../plugin-manager.ts'
import { ClientRegistry } from '../registry.ts'
import { DesktopUpdater } from '../updater.ts'
import { WriteGuard } from '../write-guard.ts'
import { AuthorizedPathBook, createDesktopIpcHandlers, type DialogAdapter } from './ipc-handlers.ts'

declare const __dirname: string | undefined

/** Immutable security baseline applied to every BrowserWindow `webPreferences`. */
export const MAIN_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
} as const

/** Build hardened `webPreferences` pointing at the compiled `preload.cjs` script. */
export function createSecureWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    ...MAIN_WINDOW_WEB_PREFERENCES,
  }
}

/** Return whether a keyboard input matches Chromium/Electron DevTools shortcuts. */
export function isDevToolsShortcut(input: {
  readonly key?: string | undefined
  readonly control?: boolean | undefined
  readonly meta?: boolean | undefined
  readonly shift?: boolean | undefined
  readonly alt?: boolean | undefined
}): boolean {
  const key = (input.key ?? '').toLowerCase()
  if (key === 'f12') return true
  const primaryModifier = input.control === true || input.meta === true
  if (primaryModifier && input.shift === true && (key === 'i' || key === 'j' || key === 'c')) {
    return true
  }
  if (input.meta === true && input.alt === true && key === 'i') {
    return true
  }
  return false
}

/**
 * Strip the native top menu bar (File/Edit/View/Developer Tools) and block
 * DevTools keyboard shortcuts unless explicitly enabled for local diagnostics.
 */
export function attachProductionWindowGuards(
  win: {
    setMenuBarVisibility(visible: boolean): void
    removeMenu(): void
    webContents: {
      on(
        event: 'before-input-event',
        listener: (event: Electron.BeforeInputEvent, input: Electron.Input) => void,
      ): void
    }
  },
  options: { readonly allowDevTools?: boolean } = {},
): void {
  win.setMenuBarVisibility(false)
  win.removeMenu()
  if (options.allowDevTools !== true) {
    win.webContents.on('before-input-event', (event, input) => {
      if (isDevToolsShortcut(input)) {
        event.preventDefault()
      }
    })
  }
}

/**
 * Enforce single-origin local navigation and whitelisted external-link opening
 * on one `BrowserWindow`'s `webContents`.
 */
export function attachNavigationGuards(
  contents: {
    on(
      event: 'will-navigate',
      listener: (event: Electron.WillNavigateEvent, url: string) => void,
    ): void
    setWindowOpenHandler: Electron.WebContents['setWindowOpenHandler']
  },
  allowedEntryUrl: string,
  openExternal: (url: string) => Promise<void>,
): void {
  contents.on('will-navigate', (event, targetUrl) => {
    const allowed =
      targetUrl === allowedEntryUrl ||
      targetUrl.startsWith(`${allowedEntryUrl}#`) ||
      targetUrl.startsWith(`${allowedEntryUrl}?`)
    if (!allowed) {
      event.preventDefault()
    }
  })

  contents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void openExternal(details.url).catch(() => {})
    }
    return { action: 'deny' }
  })
}

/** Create a {@link DialogAdapter} backed by Electron's native `dialog` module. */
export function createElectronDialogAdapter(
  getWindow: () => Electron.BrowserWindow | null,
  electronDialog: typeof Electron.dialog,
): DialogAdapter {
  const showOpen = (options: Electron.OpenDialogOptions) => {
    const win = getWindow()
    return win !== null
      ? electronDialog.showOpenDialog(win, options)
      : electronDialog.showOpenDialog(options)
  }

  const showSave = (options: Electron.SaveDialogOptions) => {
    const win = getWindow()
    return win !== null
      ? electronDialog.showSaveDialog(win, options)
      : electronDialog.showSaveDialog(options)
  }

  return {
    async pickMemoryFile(mode) {
      if (mode === 'create') {
        const res = await showSave({
          title: 'Create Memloom memory.json',
          defaultPath: 'memory.json',
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
        })
        return res.canceled || res.filePath === undefined || res.filePath === ''
          ? null
          : path.resolve(res.filePath)
      }
      const res = await showOpen({
        title: 'Select Memloom memory.json',
        properties: ['openFile'],
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      })
      const first = res.filePaths[0]
      return res.canceled || first === undefined ? null : path.resolve(first)
    },

    async pickDirectory() {
      const res = await showOpen({
        title: 'Select Workspace Directory',
        properties: ['openDirectory'],
      })
      const first = res.filePaths[0]
      return res.canceled || first === undefined ? null : path.resolve(first)
    },

    async pickImportJson() {
      const res = await showOpen({
        title: 'Import Memloom JSON',
        properties: ['openFile'],
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      })
      const first = res.filePaths[0]
      if (res.canceled || first === undefined) return null
      const resolved = path.resolve(first)
      const content = await fs.readFile(resolved, 'utf8')
      return { path: resolved, content }
    },

    async saveExportJson(defaultFileName, content) {
      const res = await showSave({
        title: 'Export Memloom JSON',
        defaultPath: defaultFileName,
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      })
      if (res.canceled || res.filePath === undefined || res.filePath === '') {
        return null
      }
      const resolved = path.resolve(res.filePath)
      await writeFileAtomic(resolved, content)
      return resolved
    },

    async pickDshCli() {
      const res = await showOpen({
        title: 'Select DSH CLI executable',
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [{ name: 'DSH CLI (dsh.cmd / dsh.exe)', extensions: ['cmd', 'exe'] }]
            : [{ name: 'All Files', extensions: ['*'] }],
      })
      const first = res.filePaths[0]
      return res.canceled || first === undefined ? null : path.resolve(first)
    },
  }
}

function resolveDefaultAppDir(): string {
  if (typeof __dirname === 'string' && __dirname !== '') {
    return __dirname
  }
  return path.resolve(process.cwd(), 'dist', 'desktop-app')
}

export interface StartDesktopMainOptions {
  readonly appDir?: string
}

/**
 * Bootstrap the Electron Main process, initialize {@link MultiClientService},
 * register zod-validated IPC handlers, and open the hardened main window.
 */
export async function startDesktopMain(options: StartDesktopMainOptions = {}): Promise<{
  readonly service: MultiClientService
  readonly getMainWindow: () => Electron.BrowserWindow | null
}> {
  const electron = await import('electron')
  const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = electron

  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  if (!gotSingleInstanceLock) {
    app.quit()
    const platform = createPlatformAdapter()
    const statePath = path.join(app.getPath('userData'), 'desktop-state.json')
    const registry = new ClientRegistry({ statePath, platform })
    const writeGuard = new WriteGuard(platform)
    return {
      service: new MultiClientService({ registry, writeGuard }),
      getMainWindow: () => null,
    }
  }

  const appDir = options.appDir ?? resolveDefaultAppDir()
  const preloadPath = path.join(appDir, 'preload.cjs')
  const rendererHtmlPath = path.join(appDir, 'renderer', 'index.html')
  const iconPath = path.join(appDir, 'assets', 'icon.ico')
  const allowedEntryUrl = pathToFileURL(rendererHtmlPath).href

  const platform = createPlatformAdapter()
  const userDataDir = app.getPath('userData')
  const statePath = path.join(userDataDir, 'desktop-state.json')
  const updatesDir = path.join(userDataDir, 'updates')
  const registry = new ClientRegistry({ statePath, platform })
  const writeGuard = new WriteGuard(platform)
  const service = new MultiClientService({ registry, writeGuard })

  await app.whenReady()
  Menu?.setApplicationMenu?.(null)
  await service.initialize()

  const currentVersion = app.getVersion()
  const resourcesPath = process.resourcesPath
  const resolveBundled = () =>
    resolveBundledPlugins({
      appDir,
      ...(resourcesPath !== undefined ? { resourcesPath } : {}),
      expectedVersion: currentVersion,
    })
  const initialBundled = await resolveBundled()
  const trustedArtifactRoots = [
    updatesDir,
    ...(resourcesPath !== undefined ? [path.join(resourcesPath, 'bundled-plugins')] : []),
    path.resolve(appDir, '..', 'desktop-bundled-plugins'),
  ]

  const pluginManager = new DesktopPluginManager({
    registry,
    platform,
    trustedArtifactRoots,
    resolveBundled,
  })

  let quittingForInstaller = false
  const updater = new DesktopUpdater({
    currentVersion,
    runtimeMode: 'electron',
    updatesDir,
    registry,
    pluginManager,
    resolveBundled,
    prepareForInstallerQuit: async () => {
      quittingForInstaller = true
      await service.closeAll()
    },
    onInstallerLaunchAborted: () => {
      quittingForInstaller = false
    },
    requestAppQuit: () => {
      app.exit(0)
    },
  })

  const initialPrefs = service.getPreferences()
  nativeTheme.themeSource = initialPrefs.theme

  let mainWindow: Electron.BrowserWindow | null = null
  const getMainWindow = (): Electron.BrowserWindow | null =>
    mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null

  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win !== null) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  const pathBook = new AuthorizedPathBook()
  const dialogAdapter = createElectronDialogAdapter(getMainWindow, dialog)

  const handlers = createDesktopIpcHandlers({
    service,
    dialog: dialogAdapter,
    pathBook,
    pluginManager,
    updater,
    resolveBundledAvailable: async () => (await resolveBundled()) !== null,
    appInfo: {
      version: currentVersion,
      platform: process.platform,
      systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      runtimeMode: 'electron',
      bundledPluginsAvailable: initialBundled !== null,
    },
    openExternal: (url) => shell.openExternal(url),
    onPreferencesUpdated: (prefs) => {
      nativeTheme.themeSource = prefs.theme
    },
  })

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_event, rawPayload) => handler(rawPayload))
  }

  const createMainWindow = async (): Promise<Electron.BrowserWindow> => {
    const prefs = service.getPreferences()
    const bounds = prefs.windowBounds
    const isDarkWindow =
      prefs.theme === 'dark' || (prefs.theme === 'system' && nativeTheme.shouldUseDarkColors)
    const win = new BrowserWindow({
      width: bounds?.width ?? 1240,
      height: bounds?.height ?? 820,
      minWidth: 920,
      minHeight: 620,
      ...(bounds !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      title: 'Memloom Desktop',
      autoHideMenuBar: true,
      backgroundColor: isDarkWindow ? '#0f1218' : '#f4f6fa',
      icon: iconPath,
      webPreferences: createSecureWebPreferences(preloadPath),
    })

    mainWindow = win
    attachProductionWindowGuards(win, {
      allowDevTools: process.env.MEMLOOM_DESKTOP_DEVTOOLS === '1',
    })
    attachNavigationGuards(win.webContents, allowedEntryUrl, (url) => shell.openExternal(url))

    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleBoundsPersist = (): void => {
      if (quittingForInstaller || win.isDestroyed() || win.isMinimized()) return
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        if (!quittingForInstaller && !win.isDestroyed() && !win.isMinimized()) {
          void service.updatePreferences({ windowBounds: win.getBounds() }).catch(() => {})
        }
      }, 250)
    }

    win.on('resize', scheduleBoundsPersist)
    win.on('move', scheduleBoundsPersist)
    win.on('close', () => {
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      if (!quittingForInstaller && !win.isDestroyed() && !win.isMinimized()) {
        void service.updatePreferences({ windowBounds: win.getBounds() }).catch(() => {})
      }
    })
    win.on('focus', () => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.appFocusRefresh)
      }
    })
    win.on('closed', () => {
      if (mainWindow === win) {
        mainWindow = null
      }
    })

    await win.loadFile(rendererHtmlPath)
    return win
  }

  await createMainWindow()
  void updater.reconcilePendingSyncOnStartup().catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    void service.closeAll()
  })

  return { service, getMainWindow }
}

function isElectronMainProcess(): boolean {
  if (typeof process === 'undefined') return false
  const electronVersion = (process as { versions?: { electron?: string } }).versions?.electron
  const processType = (process as { type?: string }).type
  return typeof electronVersion === 'string' && processType === 'browser'
}

if (isElectronMainProcess()) {
  void startDesktopMain()
}
