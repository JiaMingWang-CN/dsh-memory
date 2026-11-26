/**
 * Signed-runtime local launcher for Memloom Desktop (`node.exe` + `msedge.exe --app`).
 *
 * Avoids unsigned Electron executables on Windows 11 Smart App Control hosts by
 * serving the UI over a loopback token-authenticated server and opening an
 * app-mode Edge window while sharing the same `desktop-state.json` userData dir.
 * @module memloom/desktop/local-launcher
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWindowsPowerShellDialogAdapter, startLocalDesktopServer } from './local-server.ts'
import { MultiClientService } from './multi-service.ts'
import { createPlatformAdapter } from './platform/index.ts'
import { ClientRegistry } from './registry.ts'
import { WriteGuard } from './write-guard.ts'

/** Locate Microsoft Edge executable on Windows hosts. */
export function findEdgeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'win32') return undefined
  const candidates = [
    path.join(
      env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),
    path.join(
      env.ProgramFiles ?? 'C:\\Program Files',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),
    ...(env.LOCALAPPDATA
      ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : []),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/** Resolve the Electron-compatible `userData` directory for desktop state persistence. */
export function resolveDesktopUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'memloom-desktop')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'memloom-desktop')
  }
  const configHome = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(configHome, 'memloom-desktop')
}

function resolveDefaultRendererDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const siblingRenderer = path.join(moduleDir, 'renderer')
  if (existsSync(path.join(siblingRenderer, 'index.html'))) {
    return siblingRenderer
  }
  return path.resolve(process.cwd(), 'dist', 'desktop-app', 'renderer')
}

function readAppVersion(rendererDir: string): string {
  const candidates = [
    path.resolve(rendererDir, '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.trim() !== '') {
        return pkg.version
      }
    } catch {
      // Ignore malformed candidate and fall back.
    }
  }
  return '0.0.0'
}

export interface LaunchLocalDesktopOptions {
  readonly rendererDir?: string
  readonly openWindow?: boolean
  readonly onReady?: (url: string) => void
}

export interface LaunchedLocalDesktop {
  readonly url: string
  close(): Promise<void>
}

/** Build Microsoft Edge `--app` command-line flags ensuring a foreground window with no background residency. */
export function buildEdgeLaunchArgs(url: string, edgeProfileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${edgeProfileDir}`,
    '--window-size=1280,840',
    '--new-window',
    '--disable-extensions',
    '--disable-background-mode',
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

/** Start Memloom Desktop via signed Node + Edge `--app` (or headless server when `openWindow: false`). */
export async function launchLocalDesktop(
  options: LaunchLocalDesktopOptions = {},
): Promise<LaunchedLocalDesktop> {
  const rendererDir = path.resolve(options.rendererDir ?? resolveDefaultRendererDir())
  const assetsDir = path.resolve(rendererDir, '..', 'assets')
  const userDataDir = resolveDesktopUserDataDir()
  const statePath = path.join(userDataDir, 'desktop-state.json')

  const platform = createPlatformAdapter()
  const registry = new ClientRegistry({ statePath, platform })
  const writeGuard = new WriteGuard(platform)
  const service = new MultiClientService({ registry, writeGuard })

  await service.initialize()

  const server = await startLocalDesktopServer({
    rendererDir,
    assetsDir,
    service,
    dialog: createWindowsPowerShellDialogAdapter(),
    appInfo: {
      version: readAppVersion(rendererDir),
      platform: process.platform,
    },
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await server.close().catch(() => {})
    await service.closeAll().catch(() => {})
  }

  if (options.onReady !== undefined) {
    options.onReady(server.url)
  } else {
    console.log(`Memloom Desktop listening at ${server.url}`)
  }

  if (options.openWindow !== false) {
    const edgePath = findEdgeExecutable()
    if (edgePath !== undefined) {
      const edgeProfileDir = path.join(userDataDir, 'edge-app-profile')
      const edgeProc = spawn(edgePath, buildEdgeLaunchArgs(server.url, edgeProfileDir), {
        stdio: 'ignore',
        windowsHide: false,
      })
      if (options.onReady === undefined) {
        console.log(
          'Launched Microsoft Edge app window (close the window or press Ctrl+C to stop).',
        )
      }
      edgeProc.once('error', (err) => {
        console.error(
          `Failed to launch Microsoft Edge (${edgePath}): ${err instanceof Error ? err.message : String(err)}`,
        )
        console.log(`You can open ${server.url} manually in your browser.`)
      })
      edgeProc.once('exit', () => {
        void close().finally(() => {
          process.exit(0)
        })
      })
    } else if (options.onReady === undefined) {
      console.log(`Microsoft Edge was not found; open ${server.url} in a local browser.`)
    }
  }

  const handleSignal = (): void => {
    void close().finally(() => {
      process.exit(0)
    })
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)

  return { url: server.url, close }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await launchLocalDesktop()
}
