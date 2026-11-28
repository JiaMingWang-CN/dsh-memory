/**
 * In-app GitHub Releases updater, fail-closed SHA-256 verifier, and
 * post-restart host plugin sync coordinator for Memloom Desktop.
 * @module memloom/desktop/updater
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { compareSemver } from './bridge-shared.ts'
import { extractZipSafely, type ResolvedBundledPlugins } from './bundled-plugins.ts'

export { compareSemver }
import { DesktopUnsupportedError } from './multi-service.ts'
import {
  DesktopBusyError,
  DesktopDshCliMissingError,
  DesktopDshRunningError,
  DesktopPluginOpError,
  type DesktopPluginManager,
  type PluginOpResult,
} from './plugin-manager.ts'
import type { ClientRegistry, PendingPluginSyncState, PendingPluginSyncTarget } from './registry.ts'

const REPO_OWNER = 'JiaMingWang-CN'
const REPO_NAME = 'memloom'
const RELEASE_API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`
const API_TIMEOUT_MS = 15_000
const ALLOWED_GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const SHA256_LINE_RE = /^([a-f0-9]{64})\s+\*?(.+)$/i

export class DesktopUpdateNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopUpdateNetworkError'
  }
}

export class DesktopUpdateChecksumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopUpdateChecksumError'
  }
}

export type DesktopRuntimeMode = 'electron' | 'local-bridge'

export interface UpdateCheckResult {
  readonly currentVersion: string
  readonly latestVersion: string
  readonly hasUpdate: boolean
  readonly releaseUrl: string
  readonly releaseNotes: string
  readonly publishedAt?: string
  readonly runtimeMode: DesktopRuntimeMode
  readonly canSelfUpdateApp: boolean
  readonly assets: {
    readonly desktopExe?: string
    readonly agyZip?: string
    readonly dshTgz?: string
    readonly checksums?: string
  }
  readonly installedTargets: readonly PendingPluginSyncTarget[]
}

export interface UpdaterTaskSnapshot {
  readonly phase:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'launching-installer'
    | 'syncing-plugins'
    | 'completed'
    | 'failed'
    | 'cancelled'
  readonly action?: 'app-update' | 'online-plugin-update' | 'pending-sync'
  readonly targetVersion?: string
  readonly bytesReceived?: number
  readonly totalBytes?: number
  readonly installerPath?: string
  readonly message?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly pendingSync: PendingPluginSyncState | null
  readonly lastSyncResults?: readonly PendingPluginSyncTarget[]
  readonly updatedAt: string
}

export interface DesktopUpdaterOptions {
  readonly currentVersion: string
  readonly runtimeMode: DesktopRuntimeMode
  readonly hostPlatform?: NodeJS.Platform
  readonly updatesDir: string
  readonly registry: ClientRegistry
  readonly pluginManager: DesktopPluginManager
  readonly resolveBundled: () => Promise<ResolvedBundledPlugins | null>
  readonly fetchImpl?: typeof fetch
  readonly prepareForInstallerQuit?: () => Promise<void>
  readonly onInstallerLaunchAborted?: () => void
  readonly launchInstallerImpl?: (exePath: string) => Promise<void>
  readonly requestAppQuit?: () => void
  readonly now?: () => Date
}

/** Parse standard GNU `SHA256SUMS.txt` content into a `fileName -> lowercase sha256` map. */
export function parseSha256Sums(content: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = SHA256_LINE_RE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const digest = match[1].toLowerCase()
      const fileName = path.posix.basename(match[2].trim().replace(/\\/g, '/'))
      if (fileName.length > 0) {
        map.set(fileName, digest)
      }
    }
  }
  return map
}

/** Verify that a release or asset download URL uses HTTPS on an allowlisted GitHub host. */
export function isAllowedReleaseDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' && ALLOWED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

interface ParsedRelease {
  readonly version: string
  readonly releaseUrl: string
  readonly releaseNotes: string
  readonly publishedAt?: string
  readonly assets: {
    readonly desktopExe?: { readonly name: string; readonly url: string }
    readonly agyZip?: { readonly name: string; readonly url: string }
    readonly dshTgz?: { readonly name: string; readonly url: string }
    readonly checksums?: { readonly name: string; readonly url: string }
  }
}

function defaultLaunchInstaller(exePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
    })
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn)
      reject(err)
    }
    const onSpawn = (): void => {
      child.off('error', onError)
      child.unref()
      resolve()
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'))
  )
}

function mapUpdaterErrorCode(err: unknown): string {
  if (err instanceof DesktopUpdateChecksumError) return 'desktop/update-checksum-failed'
  if (err instanceof DesktopUpdateNetworkError) return 'desktop/update-network'
  if (err instanceof DesktopBusyError) return 'desktop/busy'
  if (err instanceof DesktopDshRunningError) return 'desktop/dsh-running'
  if (err instanceof DesktopDshCliMissingError) return 'desktop/dsh-cli-missing'
  if (err instanceof DesktopUnsupportedError) return 'desktop/unsupported'
  return 'desktop/plugin-op-failed'
}

async function resolveExtractedAgySourceDir(extractDir: string): Promise<string> {
  try {
    const rootPluginStat = await fs.stat(path.join(extractDir, 'plugin.json'))
    if (rootPluginStat.isFile()) return extractDir
  } catch {
    // Check single nested directory
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  const files = entries.filter((entry) => entry.isFile())
  if (dirs.length === 1 && files.length === 0) {
    const candidate = path.join(extractDir, dirs[0]!.name)
    try {
      const nestedStat = await fs.stat(path.join(candidate, 'plugin.json'))
      if (nestedStat.isFile()) return candidate
    } catch {
      // Fall through to error
    }
  }

  throw new DesktopPluginOpError(
    'Extracted AGY archive does not contain plugin.json at root or in a single top-level directory.',
  )
}

export class DesktopUpdater {
  private readonly currentVersion: string
  private readonly runtimeMode: DesktopRuntimeMode
  private readonly hostPlatform: NodeJS.Platform
  private readonly updatesDir: string
  private readonly registry: ClientRegistry
  private readonly pluginManager: DesktopPluginManager
  private readonly resolveBundled: () => Promise<ResolvedBundledPlugins | null>
  private readonly fetchImpl: typeof fetch
  private readonly prepareForInstallerQuit?: () => Promise<void>
  private readonly onInstallerLaunchAborted?: () => void
  private readonly launchInstallerImpl: (exePath: string) => Promise<void>
  private readonly requestAppQuit?: () => void
  private readonly now: () => Date

  private activeAbortController: AbortController | null = null
  private snapshot: UpdaterTaskSnapshot

  constructor(options: DesktopUpdaterOptions) {
    this.currentVersion = options.currentVersion
    this.runtimeMode = options.runtimeMode
    this.hostPlatform = options.hostPlatform ?? process.platform
    this.updatesDir = path.resolve(options.updatesDir)
    this.registry = options.registry
    this.pluginManager = options.pluginManager
    this.resolveBundled = options.resolveBundled
    this.fetchImpl = options.fetchImpl ?? fetch
    if (options.prepareForInstallerQuit !== undefined) {
      this.prepareForInstallerQuit = options.prepareForInstallerQuit
    }
    if (options.onInstallerLaunchAborted !== undefined) {
      this.onInstallerLaunchAborted = options.onInstallerLaunchAborted
    }
    this.launchInstallerImpl = options.launchInstallerImpl ?? defaultLaunchInstaller
    if (options.requestAppQuit !== undefined) {
      this.requestAppQuit = options.requestAppQuit
    }
    this.now = options.now ?? (() => new Date())
    this.snapshot = {
      phase: 'idle',
      pendingSync: this.registry.getPendingPluginSync(),
      updatedAt: this.now().toISOString(),
    }
  }

  private updateSnapshot(
    patch: Omit<UpdaterTaskSnapshot, 'pendingSync' | 'updatedAt'>,
  ): UpdaterTaskSnapshot {
    this.snapshot = {
      ...patch,
      pendingSync: this.registry.getPendingPluginSync(),
      updatedAt: this.now().toISOString(),
    }
    return this.getState()
  }

  /** Return the current updater task snapshot. */
  getState(): UpdaterTaskSnapshot {
    const pendingSync = this.registry.getPendingPluginSync()
    return {
      ...this.snapshot,
      pendingSync,
      ...(this.snapshot.lastSyncResults !== undefined
        ? { lastSyncResults: this.snapshot.lastSyncResults.map((t) => ({ ...t })) }
        : {}),
    }
  }

  /** Cancel any in-flight online download and clean up partial files. */
  async cancel(): Promise<UpdaterTaskSnapshot> {
    if (this.activeAbortController !== null) {
      this.activeAbortController.abort()
    }
    return this.getState()
  }

  private async fetchGitHub(url: string, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (!isAllowedReleaseDownloadUrl(url)) {
      throw new DesktopUpdateNetworkError(`Blocked disallowed download URL: ${url}`)
    }
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), API_TIMEOUT_MS)
    const onExternalAbort = (): void => timeoutController.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          'User-Agent': `memloom-desktop/${this.currentVersion}`,
          Accept: 'application/vnd.github+json',
        },
        signal: timeoutController.signal,
      })
      if (response.url && !isAllowedReleaseDownloadUrl(response.url)) {
        throw new DesktopUpdateNetworkError(`Blocked redirected download URL: ${response.url}`)
      }
      return response
    } catch (err) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      if (err instanceof DesktopUpdateNetworkError) throw err
      throw new DesktopUpdateNetworkError(
        `Network request failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async fetchRelease(endpointUrl: string, signal?: AbortSignal): Promise<ParsedRelease> {
    const response = await this.fetchGitHub(endpointUrl, signal)
    if (response.status === 404) {
      throw new DesktopUpdateNetworkError(
        `Release not found on GitHub (HTTP 404) for ${endpointUrl}. This version may not be published yet.`,
      )
    }
    if (!response.ok) {
      throw new DesktopUpdateNetworkError(
        `GitHub Releases API returned HTTP ${response.status} for ${endpointUrl}`,
      )
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch (err) {
      throw new DesktopUpdateNetworkError(
        `Invalid GitHub Releases JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DesktopUpdateNetworkError('Unexpected GitHub Releases response payload.')
    }

    const obj = raw as Record<string, unknown>
    const tagName = typeof obj.tag_name === 'string' ? obj.tag_name.trim() : ''
    if (tagName.length === 0) {
      throw new DesktopUpdateNetworkError('GitHub Release is missing tag_name.')
    }
    const version = tagName.replace(/^v/i, '')
    const releaseUrl =
      typeof obj.html_url === 'string' && obj.html_url.trim().length > 0
        ? obj.html_url.trim()
        : `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${tagName}`
    const releaseNotes = typeof obj.body === 'string' ? obj.body : ''
    const publishedAt =
      typeof obj.published_at === 'string' && obj.published_at.trim().length > 0
        ? obj.published_at.trim()
        : undefined

    const rawAssets = Array.isArray(obj.assets) ? obj.assets : []
    let desktopExe: { name: string; url: string } | undefined
    let agyZip: { name: string; url: string } | undefined
    let dshTgz: { name: string; url: string } | undefined
    let checksums: { name: string; url: string } | undefined

    for (const item of rawAssets) {
      if (item === null || typeof item !== 'object') continue
      const asset = item as Record<string, unknown>
      const name = typeof asset.name === 'string' ? asset.name.trim() : ''
      const url =
        typeof asset.browser_download_url === 'string' ? asset.browser_download_url.trim() : ''
      if (name.length === 0 || !isAllowedReleaseDownloadUrl(url)) continue

      if (name === 'SHA256SUMS.txt') {
        checksums = { name, url }
      } else if (
        name === `memloom-desktop-${version}-win-x64-setup.exe` ||
        (desktopExe === undefined && name.endsWith('-win-x64-setup.exe'))
      ) {
        desktopExe = { name, url }
      } else if (
        name === `memloom-agy-plugin-${version}.zip` ||
        (agyZip === undefined && name.startsWith('memloom-agy-plugin-') && name.endsWith('.zip'))
      ) {
        agyZip = { name, url }
      } else if (
        name === `memloom-${version}.tgz` ||
        (dshTgz === undefined && name.startsWith('memloom-') && name.endsWith('.tgz'))
      ) {
        dshTgz = { name, url }
      }
    }

    return {
      version,
      releaseUrl,
      releaseNotes,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      assets: {
        ...(desktopExe !== undefined ? { desktopExe } : {}),
        ...(agyZip !== undefined ? { agyZip } : {}),
        ...(dshTgz !== undefined ? { dshTgz } : {}),
        ...(checksums !== undefined ? { checksums } : {}),
      },
    }
  }

  private async fetchChecksums(
    release: ParsedRelease,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    if (release.assets.checksums === undefined) {
      throw new DesktopUpdateChecksumError(
        `Release v${release.version} does not provide SHA256SUMS.txt. Refusing unverified download.`,
      )
    }
    const response = await this.fetchGitHub(release.assets.checksums.url, signal)
    if (!response.ok) {
      throw new DesktopUpdateChecksumError(
        `Failed to fetch SHA256SUMS.txt (HTTP ${response.status}). Refusing unverified download.`,
      )
    }
    const text = await response.text()
    const parsed = parseSha256Sums(text)
    if (parsed.size === 0) {
      throw new DesktopUpdateChecksumError('SHA256SUMS.txt is empty or invalid.')
    }
    return parsed
  }

  private async cleanupUpdatesDir(): Promise<void> {
    try {
      const entries = await fs.readdir(this.updatesDir)
      await Promise.all(
        entries.map((entry) =>
          fs.rm(path.join(this.updatesDir, entry), { recursive: true, force: true }),
        ),
      )
    } catch {
      // Ignore missing updatesDir
    }
  }

  private async downloadVerifiedAsset(options: {
    readonly asset: { readonly name: string; readonly url: string }
    readonly expectedSha256: string | undefined
    readonly signal: AbortSignal
    readonly action?: 'app-update' | 'online-plugin-update'
    readonly targetVersion?: string
  }): Promise<string> {
    if (options.expectedSha256 === undefined) {
      throw new DesktopUpdateChecksumError(
        `SHA256SUMS.txt does not contain an entry for ${options.asset.name}.`,
      )
    }
    if (!isAllowedReleaseDownloadUrl(options.asset.url)) {
      throw new DesktopUpdateNetworkError(`Blocked disallowed asset URL: ${options.asset.url}`)
    }

    if (options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    await fs.mkdir(this.updatesDir, { recursive: true })
    const safeName = path.basename(options.asset.name)
    const partPath = path.join(this.updatesDir, `${safeName}.part`)
    const finalPath = path.join(this.updatesDir, safeName)
    await fs.rm(partPath, { force: true }).catch(() => undefined)
    if (options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    let fileHandle: fs.FileHandle | null = null
    try {
      const response = await this.fetchImpl(options.asset.url, {
        headers: { 'User-Agent': `memloom-desktop/${this.currentVersion}` },
        signal: options.signal,
      })
      if (response.url && !isAllowedReleaseDownloadUrl(response.url)) {
        throw new DesktopUpdateNetworkError(`Blocked redirected asset URL: ${response.url}`)
      }
      if (!response.ok) {
        throw new DesktopUpdateNetworkError(
          `Failed to download ${safeName} (HTTP ${response.status}).`,
        )
      }

      const contentLengthHeader = response.headers.get('content-length')
      const totalBytes =
        contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
          ? Number.parseInt(contentLengthHeader, 10)
          : undefined

      fileHandle = await fs.open(partPath, 'w')
      const hash = createHash('sha256')
      let bytesReceived = 0

      if (response.body !== null) {
        const reader = response.body.getReader()
        try {
          for (;;) {
            if (options.signal.aborted) {
              throw new DOMException('Aborted', 'AbortError')
            }
            const { done, value } = await reader.read()
            if (done) break
            if (value !== undefined && value.byteLength > 0) {
              await fileHandle.write(value)
              hash.update(value)
              bytesReceived += value.byteLength
              if (options.action !== undefined) {
                this.updateSnapshot({
                  phase: 'downloading',
                  action: options.action,
                  ...(options.targetVersion !== undefined
                    ? { targetVersion: options.targetVersion }
                    : {}),
                  bytesReceived,
                  ...(totalBytes !== undefined ? { totalBytes } : {}),
                  message: `Downloading ${safeName}...`,
                })
              }
            }
          }
        } finally {
          reader.releaseLock()
        }
      } else {
        const buf = Buffer.from(await response.arrayBuffer())
        await fileHandle.write(buf)
        hash.update(buf)
        bytesReceived = buf.byteLength
      }

      await fileHandle.close()
      fileHandle = null

      if (options.action !== undefined) {
        this.updateSnapshot({
          phase: 'verifying',
          action: options.action,
          ...(options.targetVersion !== undefined ? { targetVersion: options.targetVersion } : {}),
          bytesReceived,
          ...(totalBytes !== undefined ? { totalBytes } : {}),
          message: `Verifying SHA-256 for ${safeName}...`,
        })
      }

      const actualSha = hash.digest('hex').toLowerCase()
      if (actualSha !== options.expectedSha256.toLowerCase()) {
        await fs.rm(partPath, { force: true }).catch(() => undefined)
        throw new DesktopUpdateChecksumError(
          `SHA-256 verification failed for ${safeName}: expected ${options.expectedSha256}, got ${actualSha}.`,
        )
      }

      await fs.rm(finalPath, { force: true }).catch(() => undefined)
      await fs.rename(partPath, finalPath)
      return finalPath
    } catch (err) {
      if (fileHandle !== null) {
        await fileHandle.close().catch(() => undefined)
      }
      await fs.rm(partPath, { force: true }).catch(() => undefined)
      throw err
    }
  }

  /** Check GitHub Releases for the latest version and installed plugin targets. */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    const release = await this.fetchRelease(`${RELEASE_API_BASE}/latest`)
    const installedTargets = await this.pluginManager.collectEnabledInstalledSyncTargets()
    const hasUpdate = compareSemver(release.version, this.currentVersion) > 0
    const canSelfUpdateApp =
      this.runtimeMode === 'electron' &&
      this.hostPlatform === 'win32' &&
      release.assets.desktopExe !== undefined &&
      release.assets.checksums !== undefined

    return {
      currentVersion: this.currentVersion,
      latestVersion: release.version,
      hasUpdate,
      releaseUrl: release.releaseUrl,
      releaseNotes: release.releaseNotes,
      ...(release.publishedAt !== undefined ? { publishedAt: release.publishedAt } : {}),
      runtimeMode: this.runtimeMode,
      canSelfUpdateApp,
      assets: {
        ...(release.assets.desktopExe !== undefined
          ? { desktopExe: release.assets.desktopExe.url }
          : {}),
        ...(release.assets.agyZip !== undefined ? { agyZip: release.assets.agyZip.url } : {}),
        ...(release.assets.dshTgz !== undefined ? { dshTgz: release.assets.dshTgz.url } : {}),
        ...(release.assets.checksums !== undefined
          ? { checksums: release.assets.checksums.url }
          : {}),
      },
      installedTargets,
    }
  }

  private async launchExclusiveBackgroundTask(
    label: string,
    initialSnapshot: Omit<UpdaterTaskSnapshot, 'pendingSync' | 'updatedAt'>,
    runner: (signal: AbortSignal) => Promise<void>,
  ): Promise<UpdaterTaskSnapshot> {
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    let lockError: unknown = null

    void this.pluginManager
      .runExclusive(label, async () => {
        const controller = new AbortController()
        this.activeAbortController = controller
        this.updateSnapshot(initialSnapshot)
        startedResolve()
        try {
          await runner(controller.signal)
        } finally {
          if (this.activeAbortController === controller) {
            this.activeAbortController = null
          }
        }
      })
      .catch((err: unknown) => {
        lockError = err
        startedResolve()
      })

    await started
    if (lockError !== null) {
      throw lockError
    }
    return this.getState()
  }

  /**
   * Start an asynchronous Electron app update:
   * download + SHA-256 verify NSIS installer -> prepare quit -> persist pendingPluginSync -> spawn installer -> quit.
   */
  async startAppUpdate(): Promise<UpdaterTaskSnapshot> {
    if (this.runtimeMode !== 'electron' || this.hostPlatform !== 'win32') {
      throw new DesktopUnsupportedError(
        'In-app installer self-update is only supported in packaged Windows Electron mode.',
      )
    }

    return this.launchExclusiveBackgroundTask(
      'app-update',
      { phase: 'checking', action: 'app-update', message: 'Checking latest release...' },
      async (signal) => {
        let exePath: string | undefined
        let preparedForQuit = false
        try {
          await this.cleanupUpdatesDir()
          const release = await this.fetchRelease(`${RELEASE_API_BASE}/latest`, signal)
          if (compareSemver(release.version, this.currentVersion) <= 0) {
            this.updateSnapshot({
              phase: 'completed',
              action: 'app-update',
              targetVersion: release.version,
              message: `Already on latest version v${this.currentVersion}.`,
            })
            return
          }
          if (release.assets.desktopExe === undefined) {
            throw new DesktopUpdateNetworkError(
              `Release v${release.version} does not include a Windows x64 installer.`,
            )
          }

          const checksums = await this.fetchChecksums(release, signal)
          exePath = await this.downloadVerifiedAsset({
            asset: release.assets.desktopExe,
            expectedSha256: checksums.get(release.assets.desktopExe.name),
            signal,
            action: 'app-update',
            targetVersion: release.version,
          })

          const targets = await this.pluginManager.collectEnabledInstalledSyncTargets()
          await this.prepareForInstallerQuit?.()
          preparedForQuit = true

          await this.registry.setPendingPluginSync({
            targetVersion: release.version,
            requestedAt: this.now().toISOString(),
            targets,
          })

          this.updateSnapshot({
            phase: 'launching-installer',
            action: 'app-update',
            targetVersion: release.version,
            installerPath: exePath,
            message: 'Launching Memloom Desktop installer...',
          })

          try {
            await this.launchInstallerImpl(exePath)
          } catch (launchErr) {
            await this.registry.setPendingPluginSync(null)
            preparedForQuit = false
            this.onInstallerLaunchAborted?.()
            this.updateSnapshot({
              phase: 'failed',
              action: 'app-update',
              targetVersion: release.version,
              installerPath: exePath,
              errorCode: 'desktop/plugin-op-failed',
              errorMessage: `Failed to launch installer: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
            })
            return
          }

          preparedForQuit = false
          this.updateSnapshot({
            phase: 'completed',
            action: 'app-update',
            targetVersion: release.version,
            installerPath: exePath,
            message: 'Installer launched; exiting current instance...',
          })
          this.requestAppQuit?.()
        } catch (err) {
          if (preparedForQuit) {
            await this.registry.setPendingPluginSync(null).catch(() => undefined)
            this.onInstallerLaunchAborted?.()
          }
          if (isAbortError(err) || signal.aborted) {
            this.updateSnapshot({
              phase: 'cancelled',
              action: 'app-update',
              message: 'Update download cancelled.',
            })
            return
          }
          this.updateSnapshot({
            phase: 'failed',
            action: 'app-update',
            ...(exePath !== undefined ? { installerPath: exePath } : {}),
            errorCode: mapUpdaterErrorCode(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
      },
    )
  }

  /**
   * Asynchronously download verified online plugin artifacts from the latest Release
   * and update all currently installed & enabled host targets.
   */
  async updateInstalledPluginsOnline(): Promise<UpdaterTaskSnapshot> {
    return this.launchExclusiveBackgroundTask(
      'online-plugin-update',
      {
        phase: 'checking',
        action: 'online-plugin-update',
        message: 'Checking latest release for plugin updates...',
      },
      async (signal) => {
        try {
          await this.cleanupUpdatesDir()
          const release = await this.fetchRelease(`${RELEASE_API_BASE}/latest`, signal)
          const checksums = await this.fetchChecksums(release, signal)
          const targets = await this.pluginManager.collectEnabledInstalledSyncTargets()

          if (targets.length === 0) {
            this.updateSnapshot({
              phase: 'completed',
              action: 'online-plugin-update',
              targetVersion: release.version,
              lastSyncResults: [],
              message: 'No installed & enabled host plugins to update.',
            })
            return
          }

          const results: PendingPluginSyncTarget[] = []
          let cachedAgyExtractDir: string | undefined
          let cachedDshTgzPath: string | undefined

          try {
            for (const target of targets) {
              if (signal.aborted) {
                throw new DOMException('Aborted', 'AbortError')
              }
              if (target.kind === 'agy') {
                try {
                  if (cachedAgyExtractDir === undefined) {
                    if (release.assets.agyZip === undefined) {
                      throw new DesktopUpdateNetworkError(
                        `Release v${release.version} does not include an AGY plugin ZIP.`,
                      )
                    }
                    const zipPath = await this.downloadVerifiedAsset({
                      asset: release.assets.agyZip,
                      expectedSha256: checksums.get(release.assets.agyZip.name),
                      signal,
                      action: 'online-plugin-update',
                      targetVersion: release.version,
                    })
                    cachedAgyExtractDir = path.join(
                      this.updatesDir,
                      `.extract-agy-${randomUUID().slice(0, 8)}`,
                    )
                    await extractZipSafely(await fs.readFile(zipPath), cachedAgyExtractDir)
                  }
                  this.updateSnapshot({
                    phase: 'syncing-plugins',
                    action: 'online-plugin-update',
                    targetVersion: release.version,
                    message: 'Updating AGY plugin...',
                  })
                  const agySourceDir = await resolveExtractedAgySourceDir(cachedAgyExtractDir)
                  await this.pluginManager.installFromLocal({
                    kind: 'agy',
                    agySourceDir,
                    preserveDisabledState: true,
                  })
                  results.push({
                    kind: 'agy',
                    ...(target.previousVersion !== undefined
                      ? { previousVersion: target.previousVersion }
                      : {}),
                    status: 'succeeded',
                  })
                } catch (err) {
                  if (isAbortError(err) || signal.aborted) throw err
                  results.push({
                    kind: 'agy',
                    ...(target.previousVersion !== undefined
                      ? { previousVersion: target.previousVersion }
                      : {}),
                    status: 'failed',
                    errorCode: mapUpdaterErrorCode(err),
                    errorMessage: err instanceof Error ? err.message : String(err),
                  })
                }
                continue
              }

              const profileName = target.profileName ?? 'desktop'
              try {
                if (cachedDshTgzPath === undefined) {
                  if (release.assets.dshTgz === undefined) {
                    throw new DesktopUpdateNetworkError(
                      `Release v${release.version} does not include a DSH plugin tarball.`,
                    )
                  }
                  cachedDshTgzPath = await this.downloadVerifiedAsset({
                    asset: release.assets.dshTgz,
                    expectedSha256: checksums.get(release.assets.dshTgz.name),
                    signal,
                    action: 'online-plugin-update',
                    targetVersion: release.version,
                  })
                }
                this.updateSnapshot({
                  phase: 'syncing-plugins',
                  action: 'online-plugin-update',
                  targetVersion: release.version,
                  message: `Updating DSH plugin (${profileName})...`,
                })
                await this.pluginManager.installFromLocal({
                  kind: 'dsh',
                  profileName,
                  dshTgzPath: cachedDshTgzPath,
                })
                results.push({
                  kind: 'dsh',
                  profileName,
                  ...(target.previousVersion !== undefined
                    ? { previousVersion: target.previousVersion }
                    : {}),
                  status: 'succeeded',
                })
              } catch (err) {
                if (isAbortError(err) || signal.aborted) throw err
                results.push({
                  kind: 'dsh',
                  profileName,
                  ...(target.previousVersion !== undefined
                    ? { previousVersion: target.previousVersion }
                    : {}),
                  status: err instanceof DesktopDshRunningError ? 'blocked-dsh-running' : 'failed',
                  errorCode: mapUpdaterErrorCode(err),
                  errorMessage: err instanceof Error ? err.message : String(err),
                })
              }
            }
          } finally {
            if (cachedAgyExtractDir !== undefined) {
              await fs
                .rm(cachedAgyExtractDir, { recursive: true, force: true })
                .catch(() => undefined)
            }
          }

          const hasFailures = results.some(
            (r) => r.status === 'failed' || r.status === 'blocked-dsh-running',
          )
          this.updateSnapshot({
            phase: hasFailures ? 'failed' : 'completed',
            action: 'online-plugin-update',
            targetVersion: release.version,
            lastSyncResults: results,
            message: hasFailures
              ? 'Some host plugins failed to update.'
              : `Updated installed plugins to v${release.version}.`,
          })
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            this.updateSnapshot({
              phase: 'cancelled',
              action: 'online-plugin-update',
              message: 'Online plugin update cancelled.',
            })
            return
          }
          this.updateSnapshot({
            phase: 'failed',
            action: 'online-plugin-update',
            errorCode: mapUpdaterErrorCode(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
      },
    )
  }

  /**
   * Download, verify via SHA256SUMS.txt, and install a single host plugin from GitHub Releases.
   */
  async installOnlinePlugin(req: {
    readonly kind: 'agy' | 'dsh'
    readonly profileName?: string
    readonly version?: string
  }): Promise<PluginOpResult> {
    return this.pluginManager.runExclusive(`install-online:${req.kind}`, async () => {
      const controller = new AbortController()
      this.activeAbortController = controller
      try {
        const targetVer = (req.version ?? this.currentVersion).trim().replace(/^v/i, '')
        const endpoint = `${RELEASE_API_BASE}/tags/v${targetVer}`
        const release = await this.fetchRelease(endpoint, controller.signal)
        const checksums = await this.fetchChecksums(release, controller.signal)

        if (req.kind === 'agy') {
          if (release.assets.agyZip === undefined) {
            throw new DesktopUpdateNetworkError(
              `Release v${release.version} does not include an AGY plugin ZIP.`,
            )
          }
          const zipPath = await this.downloadVerifiedAsset({
            asset: release.assets.agyZip,
            expectedSha256: checksums.get(release.assets.agyZip.name),
            signal: controller.signal,
          })
          const extractDir = path.join(this.updatesDir, `.extract-agy-${randomUUID().slice(0, 8)}`)
          try {
            await extractZipSafely(await fs.readFile(zipPath), extractDir)
            const agySourceDir = await resolveExtractedAgySourceDir(extractDir)
            return await this.pluginManager.installFromLocal({
              kind: 'agy',
              agySourceDir,
            })
          } finally {
            await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined)
          }
        }

        if (release.assets.dshTgz === undefined) {
          throw new DesktopUpdateNetworkError(
            `Release v${release.version} does not include a DSH plugin tarball.`,
          )
        }
        const tgzPath = await this.downloadVerifiedAsset({
          asset: release.assets.dshTgz,
          expectedSha256: checksums.get(release.assets.dshTgz.name),
          signal: controller.signal,
        })
        return await this.pluginManager.installFromLocal({
          kind: 'dsh',
          profileName: req.profileName ?? 'desktop',
          dshTgzPath: tgzPath,
        })
      } finally {
        if (this.activeAbortController === controller) {
          this.activeAbortController = null
        }
      }
    })
  }

  private async runPendingSyncCore(pending: PendingPluginSyncState): Promise<UpdaterTaskSnapshot> {
    this.updateSnapshot({
      phase: 'syncing-plugins',
      action: 'pending-sync',
      targetVersion: pending.targetVersion,
      message: `Synchronizing host plugins to v${this.currentVersion}...`,
    })

    const bundled = await this.resolveBundled()
    if (bundled === null) {
      return this.updateSnapshot({
        phase: 'failed',
        action: 'pending-sync',
        targetVersion: pending.targetVersion,
        errorCode: 'desktop/plugin-op-failed',
        errorMessage: 'Bundled plugins payload is missing; unable to synchronize host plugins.',
      })
    }

    const results = await this.pluginManager.syncTargetsWithBundled(pending.targets, bundled)
    const remaining = results.filter(
      (item) =>
        item.status === 'blocked-dsh-running' ||
        item.status === 'failed' ||
        item.status === 'pending',
    )

    if (remaining.length === 0) {
      await this.registry.setPendingPluginSync(null)
      await this.cleanupUpdatesDir()
      return this.updateSnapshot({
        phase: 'completed',
        action: 'pending-sync',
        targetVersion: pending.targetVersion,
        lastSyncResults: results,
        message: `All installed host plugins synchronized to v${bundled.manifest.version}.`,
      })
    }

    await this.registry.setPendingPluginSync({
      targetVersion: pending.targetVersion,
      requestedAt: pending.requestedAt,
      targets: remaining,
    })

    const firstErr = remaining[0]
    return this.updateSnapshot({
      phase: 'failed',
      action: 'pending-sync',
      targetVersion: pending.targetVersion,
      lastSyncResults: results,
      ...(firstErr?.errorCode !== undefined ? { errorCode: firstErr.errorCode } : {}),
      ...(firstErr?.errorMessage !== undefined ? { errorMessage: firstErr.errorMessage } : {}),
      message: 'Some host plugins could not be synchronized. Close DSH and retry.',
    })
  }

  /**
   * Reconcile `desktop-state.json.pendingPluginSync` on startup.
   * Strictly ignored (read-only) in `local-bridge` mode.
   */
  async reconcilePendingSyncOnStartup(): Promise<UpdaterTaskSnapshot> {
    if (this.runtimeMode !== 'electron') {
      return this.getState()
    }

    const pending = this.registry.getPendingPluginSync()
    if (pending === null) {
      return this.getState()
    }

    // Stale pending sync (user cancelled NSIS installer and reopened older version)
    if (compareSemver(this.currentVersion, pending.targetVersion) < 0) {
      await this.registry.setPendingPluginSync(null)
      return this.updateSnapshot({
        phase: 'idle',
        message: `Previous update to v${pending.targetVersion} was not completed.`,
      })
    }

    if (pending.targets.length === 0) {
      await this.registry.setPendingPluginSync(null)
      await this.cleanupUpdatesDir()
      return this.updateSnapshot({
        phase: 'completed',
        action: 'pending-sync',
        targetVersion: pending.targetVersion,
        lastSyncResults: [],
        message: `Updated to v${this.currentVersion}.`,
      })
    }

    return this.pluginManager.runExclusive('pending-sync-startup', () =>
      this.runPendingSyncCore(pending),
    )
  }

  /** Retry remaining targets in `pendingPluginSync` asynchronously. */
  async syncPending(): Promise<UpdaterTaskSnapshot> {
    const pending = this.registry.getPendingPluginSync()
    if (pending === null) {
      return this.getState()
    }

    return this.launchExclusiveBackgroundTask(
      'pending-sync-retry',
      {
        phase: 'syncing-plugins',
        action: 'pending-sync',
        targetVersion: pending.targetVersion,
        message: 'Retrying host plugin synchronization...',
      },
      async () => {
        try {
          await this.runPendingSyncCore(pending)
        } catch (err) {
          this.updateSnapshot({
            phase: 'failed',
            action: 'pending-sync',
            targetVersion: pending.targetVersion,
            errorCode: mapUpdaterErrorCode(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
      },
    )
  }

  /** Dismiss and clear any remaining `pendingPluginSync` banner/state. */
  async dismissPendingSync(): Promise<UpdaterTaskSnapshot> {
    await this.registry.setPendingPluginSync(null)
    return this.updateSnapshot({
      phase: 'idle',
      message: 'Pending plugin sync dismissed.',
    })
  }
}
