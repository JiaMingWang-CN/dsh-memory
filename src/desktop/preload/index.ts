/**
 * Sandboxed Electron Preload bridge exposing a whitelisted `DesktopBridgeApi`
 * on `window.memloomDesktop` via `contextBridge.exposeInMainWorld`.
 * @module memloom/desktop/preload
 */
import type * as Electron from 'electron'
import { createDesktopBridge, type PreloadIpcRendererLike } from '../bridge-shared.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'

export { createDesktopBridge, type PreloadIpcRendererLike }

declare const require: ((id: string) => unknown) | undefined

/** Expose `window.memloomDesktop` onto the renderer main world via `contextBridge`. */
export function exposeDesktopBridge(
  bridge: Pick<typeof Electron.contextBridge, 'exposeInMainWorld'>,
  ipc: PreloadIpcRendererLike,
): DesktopBridgeApi {
  const api = createDesktopBridge(ipc)
  bridge.exposeInMainWorld('memloomDesktop', api)
  return api
}

function tryAutoExposePreload(): void {
  if (typeof process === 'undefined' || typeof require !== 'function') {
    return
  }
  const electronVersion = (process as { versions?: { electron?: string } }).versions?.electron
  if (typeof electronVersion !== 'string') {
    return
  }
  const electron = require('electron') as typeof import('electron')
  exposeDesktopBridge(electron.contextBridge, electron.ipcRenderer)
}

tryAutoExposePreload()
