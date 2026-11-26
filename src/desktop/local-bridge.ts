/**
 * Browser-side transport bridge for the signed Node + Edge `--app` launcher.
 *
 * Reuses {@link createDesktopBridge} from the Electron preload module, routing
 * every channel over authenticated same-origin `POST /api/invoke` requests and
 * forwarding window `focus` events to `app.onFocusRefresh`.
 * @module memloom/desktop/local-bridge
 */
import { createDesktopBridge, IPC_CHANNELS, type PreloadIpcRendererLike } from './bridge-shared.ts'
import type { DesktopBridgeApi, IpcResult } from './ipc-contract.ts'

const TOKEN_META_NAME = 'memloom-session-token'

function readSessionToken(): string {
  if (typeof document === 'undefined') return ''
  const meta = document.querySelector(`meta[name="${TOKEN_META_NAME}"]`)
  return meta?.getAttribute('content') ?? ''
}

function createFetchIpcTransport(token: string): PreloadIpcRendererLike {
  const focusListeners = new Map<
    (event: { readonly senderId: number }, ...args: unknown[]) => void,
    EventListener
  >()

  return {
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      try {
        const response = await fetch('/api/invoke', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Memloom-Token': token,
          },
          body: JSON.stringify({
            channel,
            ...(args[0] === undefined ? {} : { payload: args[0] }),
          }),
        })
        const json = (await response.json()) as IpcResult<unknown>
        return json as unknown as T
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          error: {
            code: 'desktop/internal',
            message: message || 'Local desktop bridge request failed',
          },
        } as unknown as T
      }
    },
    on(channel, listener): void {
      if (channel !== IPC_CHANNELS.appFocusRefresh || typeof window === 'undefined') return
      const wrapped: EventListener = () => {
        listener({ senderId: 0 })
      }
      focusListeners.set(listener, wrapped)
      window.addEventListener('focus', wrapped)
    },
    removeListener(channel, listener): void {
      if (channel !== IPC_CHANNELS.appFocusRefresh || typeof window === 'undefined') return
      const wrapped = focusListeners.get(listener)
      if (wrapped !== undefined) {
        window.removeEventListener('focus', wrapped)
        focusListeners.delete(listener)
      }
    },
  }
}

export function installLocalDesktopBridge(): DesktopBridgeApi {
  const api = createDesktopBridge(createFetchIpcTransport(readSessionToken()))
  if (typeof window !== 'undefined') {
    ;(window as unknown as { memloomDesktop: DesktopBridgeApi }).memloomDesktop = api
  }
  return api
}

if (typeof window !== 'undefined') {
  installLocalDesktopBridge()
}
