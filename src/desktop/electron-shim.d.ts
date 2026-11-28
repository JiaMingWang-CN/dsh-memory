/**
 * Minimal ambient type declarations for Electron APIs used by Memloom Desktop.
 *
 * The root workspace intentionally omits `electron` from dependencies (it is
 * isolated in `desktop/package.json`), so this declaration keeps root
 * `typecheck` strict while `esbuild` marks `electron` external in bundles.
 * @module memloom/desktop/electron-shim
 */
declare module 'electron' {
  export interface FileFilter {
    name: string
    extensions: string[]
  }

  export interface OpenDialogOptions {
    title?: string | undefined
    defaultPath?: string | undefined
    filters?: FileFilter[] | undefined
    properties?:
      Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'> | undefined
  }

  export interface OpenDialogReturnValue {
    canceled: boolean
    filePaths: string[]
  }

  export interface SaveDialogOptions {
    title?: string | undefined
    defaultPath?: string | undefined
    filters?: FileFilter[] | undefined
  }

  export interface SaveDialogReturnValue {
    canceled: boolean
    filePath?: string | undefined
  }

  export interface WebPreferences {
    preload?: string | undefined
    contextIsolation?: boolean | undefined
    nodeIntegration?: boolean | undefined
    sandbox?: boolean | undefined
    webSecurity?: boolean | undefined
    webviewTag?: boolean | undefined
  }

  export interface Rectangle {
    x: number
    y: number
    width: number
    height: number
  }

  export interface BeforeInputEvent {
    preventDefault(): void
  }

  export interface Input {
    type?: string | undefined
    key?: string | undefined
    code?: string | undefined
    control?: boolean | undefined
    meta?: boolean | undefined
    shift?: boolean | undefined
    alt?: boolean | undefined
  }

  export interface BrowserWindowConstructorOptions {
    width?: number | undefined
    height?: number | undefined
    minWidth?: number | undefined
    minHeight?: number | undefined
    x?: number | undefined
    y?: number | undefined
    title?: string | undefined
    show?: boolean | undefined
    autoHideMenuBar?: boolean | undefined
    backgroundColor?: string | undefined
    icon?: string | undefined
    webPreferences?: WebPreferences | undefined
  }

  export interface WillNavigateEvent {
    preventDefault(): void
  }

  export interface WindowOpenHandlerDetails {
    url: string
  }

  export interface WebContents {
    on(event: 'will-navigate', listener: (event: WillNavigateEvent, url: string) => void): void
    on(event: 'before-input-event', listener: (event: BeforeInputEvent, input: Input) => void): void
    on(event: string, listener: (...args: unknown[]) => void): void
    setWindowOpenHandler(
      handler: (details: WindowOpenHandlerDetails) => { action: 'allow' | 'deny' },
    ): void
    send(channel: string, ...args: unknown[]): void
    isDestroyed(): boolean
  }

  export class BrowserWindow {
    static getAllWindows(): BrowserWindow[]
    readonly webContents: WebContents
    constructor(options?: BrowserWindowConstructorOptions)
    loadFile(filePath: string): Promise<void>
    loadURL(url: string): Promise<void>
    getBounds(): Rectangle
    isMinimized(): boolean
    isDestroyed(): boolean
    restore(): void
    focus(): void
    setMenuBarVisibility(visible: boolean): void
    removeMenu(): void
    on(event: string, listener: (...args: unknown[]) => void): void
    once(event: string, listener: (...args: unknown[]) => void): void
  }

  export interface IpcMainInvokeEvent {
    readonly sender: WebContents
  }

  export interface IpcRendererEvent {
    readonly senderId: number
  }

  export const app: {
    getPath(name: 'home' | 'appData' | 'userData' | 'temp' | string): string
    getVersion(): string
    whenReady(): Promise<void>
    on(event: string, listener: (...args: unknown[]) => void): void
    requestSingleInstanceLock(): boolean
    quit(): void
    exit(exitCode?: number): void
  }

  export const dialog: {
    showOpenDialog(
      window: BrowserWindow,
      options: OpenDialogOptions,
    ): Promise<OpenDialogReturnValue>
    showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
    showSaveDialog(
      window: BrowserWindow,
      options: SaveDialogOptions,
    ): Promise<SaveDialogReturnValue>
    showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  }

  export const ipcMain: {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ): void
    removeHandler(channel: string): void
  }

  export const nativeTheme: {
    readonly shouldUseDarkColors: boolean
    themeSource: 'system' | 'light' | 'dark'
    on(event: 'updated' | string, listener: () => void): void
    off(event: 'updated' | string, listener: () => void): void
  }

  export const shell: {
    openExternal(url: string): Promise<void>
  }

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void
  }

  export const ipcRenderer: {
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
    on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
    removeListener(
      channel: string,
      listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
    ): void
  }

  export const Menu: {
    setApplicationMenu(menu: null): void
  }
}

declare namespace NodeJS {
  interface Process {
    readonly resourcesPath?: string
  }
}
