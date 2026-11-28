import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDeterministicZip,
  type ResolvedBundledPlugins,
} from '../../src/desktop/bundled-plugins.ts'
import { DesktopUnsupportedError } from '../../src/desktop/multi-service.ts'
import { createWin32PlatformAdapter } from '../../src/desktop/platform/win32.ts'
import { DesktopPluginManager } from '../../src/desktop/plugin-manager.ts'
import { ClientRegistry } from '../../src/desktop/registry.ts'
import {
  compareSemver,
  DesktopUpdateChecksumError,
  DesktopUpdater,
  isAllowedReleaseDownloadUrl,
  parseSha256Sums,
  type UpdaterTaskSnapshot,
} from '../../src/desktop/updater.ts'

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(prefix = 'memloom-updater-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function waitForTerminal(updater: DesktopUpdater): Promise<UpdaterTaskSnapshot> {
  const terminal = new Set(['idle', 'completed', 'failed', 'cancelled'])
  for (let i = 0; i < 100; i++) {
    const state = updater.getState()
    if (terminal.has(state.phase)) return state
    await new Promise((r) => setTimeout(r, 15))
  }
  return updater.getState()
}

async function createFakeBundled(
  rootDir: string,
  version: string,
): Promise<ResolvedBundledPlugins> {
  const bundledRoot = path.join(rootDir, `bundled-${version}`)
  const agyDir = path.join(bundledRoot, 'agy-plugin')
  const dshDir = path.join(bundledRoot, 'dsh-bundle')
  await fs.mkdir(agyDir, { recursive: true })
  await fs.mkdir(dshDir, { recursive: true })

  const pluginJson = JSON.stringify({ name: 'memloom', version })
  await fs.writeFile(path.join(agyDir, 'plugin.json'), pluginJson, 'utf8')
  const agySha = createHash('sha256').update('plugin.json\0').update(pluginJson).digest('hex')

  const tgzName = `memloom-${version}.tgz`
  const tgzPath = path.join(dshDir, tgzName)
  const tgzBytes = Buffer.from(`tgz-${version}`)
  await fs.writeFile(tgzPath, tgzBytes)
  const dshSha = sha256Hex(tgzBytes)

  const manifest = {
    version,
    builtAt: '2026-11-27T00:00:00.000Z',
    agy: { dir: 'agy-plugin', files: ['plugin.json'], sha256: agySha },
    dsh: { file: `dsh-bundle/${tgzName}`, sha256: dshSha },
  }
  await fs.writeFile(path.join(bundledRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  return { rootDir: bundledRoot, manifest, agyDir, dshTgzPath: tgzPath }
}

async function setupHarness(options?: {
  currentVersion?: string
  runtimeMode?: 'electron' | 'local-bridge'
  dshRunning?: boolean
}) {
  const root = await makeTempDir()
  const homeDir = path.join(root, 'home')
  const updatesDir = path.join(root, 'userData', 'updates')
  const statePath = path.join(root, 'userData', 'desktop-state.json')
  await fs.mkdir(homeDir, { recursive: true })

  let dshRunning = options?.dshRunning ?? false
  const platform = createWin32PlatformAdapter({
    homeDir,
    runProbe: async () =>
      dshRunning ? JSON.stringify([{ Name: 'DeepSeek Harness.exe', ProcessId: 888 }]) : '[]',
  })
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    DSH_HOME: path.join(homeDir, '.dsh'),
    PATH: '',
  }
  const registry = new ClientRegistry({ statePath, platform, env })
  await registry.load()
  await registry.refreshDiscovery()

  const cliPath = path.join(root, 'bin', 'dsh.exe')
  await fs.mkdir(path.dirname(cliPath), { recursive: true })
  await fs.writeFile(cliPath, 'fake-exe', 'utf8')
  await registry.updatePreferences({ dshCliPath: cliPath })

  const dshExecCalls: Array<{ file: string; args: readonly string[] }> = []
  const bundledV2 = await createFakeBundled(root, '0.2.3')
  const pluginManager = new DesktopPluginManager({
    registry,
    platform,
    homeDir,
    env,
    hostPlatform: 'win32',
    trustedArtifactRoots: [root, updatesDir],
    resolveBundled: async () => bundledV2,
    execFileRunner: async (file, args) => {
      dshExecCalls.push({ file, args })
      return { stdout: 'ok', stderr: '' }
    },
  })

  return {
    root,
    homeDir,
    updatesDir,
    statePath,
    platform,
    env,
    registry,
    pluginManager,
    bundledV2,
    dshExecCalls,
    setDshRunning: (val: boolean) => {
      dshRunning = val
    },
  }
}

function makeReleasePayload(version: string, includeChecksums = true) {
  const base = `https://github.com/JiaMingWang-CN/memloom/releases/download/v${version}`
  const assets = [
    {
      name: `memloom-desktop-${version}-win-x64-setup.exe`,
      browser_download_url: `${base}/memloom-desktop-${version}-win-x64-setup.exe`,
    },
    {
      name: `memloom-agy-plugin-${version}.zip`,
      browser_download_url: `${base}/memloom-agy-plugin-${version}.zip`,
    },
    {
      name: `memloom-${version}.tgz`,
      browser_download_url: `${base}/memloom-${version}.tgz`,
    },
  ]
  if (includeChecksums) {
    assets.push({
      name: 'SHA256SUMS.txt',
      browser_download_url: `${base}/SHA256SUMS.txt`,
    })
  }
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/JiaMingWang-CN/memloom/releases/tag/v${version}`,
    body: `Release notes for v${version}`,
    published_at: '2026-11-27T00:00:00Z',
    assets,
  }
}

describe('DesktopUpdater', () => {
  it('compares SemVer versions accurately and enforces HTTPS GitHub download URL allowlist', () => {
    expect(compareSemver('0.10.0', '0.2.3')).toBeGreaterThan(0)
    expect(compareSemver('0.2.3', '0.2.2')).toBeGreaterThan(0)
    expect(compareSemver('0.2.2', '0.2.2-rc.1')).toBeGreaterThan(0)
    expect(compareSemver('v0.2.2', '0.2.2')).toBe(0)

    expect(
      isAllowedReleaseDownloadUrl(
        'https://github.com/JiaMingWang-CN/memloom/releases/download/v0.2.3/a.exe',
      ),
    ).toBe(true)
    expect(
      isAllowedReleaseDownloadUrl(
        'https://objects.githubusercontent.com/github-production-release-asset/1',
      ),
    ).toBe(true)
    expect(isAllowedReleaseDownloadUrl('https://release-assets.githubusercontent.com/1')).toBe(true)
    expect(isAllowedReleaseDownloadUrl('http://github.com/a.exe')).toBe(false)
    expect(isAllowedReleaseDownloadUrl('https://evil.example.com/a.exe')).toBe(false)

    const parsed = parseSha256Sums(
      `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  memloom-0.2.3.tgz\n`,
    )
    expect(parsed.get('memloom-0.2.3.tgz')).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
  })

  it('enforces fail-closed SHA-256 verification and cleans up .part files on mismatch or cancellation', async () => {
    const h = await setupHarness()
    const exeBytes = Buffer.from('fake-installer-binary')
    const wrongSums = `${'0'.repeat(64)}  memloom-desktop-0.2.3-win-x64-setup.exe\n`

    // 1. Mismatch -> DesktopUpdateChecksumError & zero .part left
    const mismatchFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify(makeReleasePayload('0.2.3')), { status: 200 })
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(wrongSums, { status: 200 })
      }
      return new Response(exeBytes, { status: 200 })
    }

    const updater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl: mismatchFetch,
    })

    await updater.startAppUpdate()
    const failedState = await waitForTerminal(updater)
    expect(failedState.phase).toBe('failed')
    expect(failedState.errorCode).toBe('desktop/update-checksum-failed')
    const leftovers = await fs.readdir(h.updatesDir).catch(() => [])
    expect(leftovers.filter((f) => f.endsWith('.part'))).toEqual([])

    // 2. Missing SHA256SUMS.txt -> installOnlinePlugin throws DesktopUpdateChecksumError
    const noSumsFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/releases/tags/v0.2.3')) {
        return new Response(JSON.stringify(makeReleasePayload('0.2.3', false)), { status: 200 })
      }
      return new Response(Buffer.from('payload'), { status: 200 })
    }
    const noSumsUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl: noSumsFetch,
    })
    await expect(
      noSumsUpdater.installOnlinePlugin({ kind: 'dsh', profileName: 'desktop', version: '0.2.3' }),
    ).rejects.toBeInstanceOf(DesktopUpdateChecksumError)

    // 3. Cancellation aborts active download deterministically via barrier, cleans .part, and releases lock
    let releaseStream!: () => void
    let markDownloadStarted!: () => void
    const downloadStarted = new Promise<void>((r) => {
      markDownloadStarted = r
    })
    const slowFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify(makeReleasePayload('0.2.3')), { status: 200 })
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${sha256Hex(exeBytes)}  memloom-desktop-0.2.3-win-x64-setup.exe\n`, {
          status: 200,
        })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          markDownloadStarted()
          if (init?.signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'))
            releaseStream()
            return
          }
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'))
            releaseStream()
          })
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': '100' },
      })
    }

    const cancelUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl: slowFetch,
    })
    const abortedDone = new Promise<void>((r) => {
      releaseStream = r
    })
    await cancelUpdater.startAppUpdate()
    await downloadStarted
    await cancelUpdater.cancel()
    await abortedDone
    const cancelledState = await waitForTerminal(cancelUpdater)
    expect(cancelledState.phase).toBe('cancelled')
    expect(h.pluginManager.isBusy()).toBe(false)
    const afterCancel = await fs.readdir(h.updatesDir).catch(() => [])
    expect(afterCancel.filter((f) => f.endsWith('.part'))).toEqual([])

    // 4. Immediate cancel before fetchGitHub runs aborts cleanly without hanging
    const neverCalledFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('fetch should not be called after immediate abort')
    })
    const immediateCancelUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl: neverCalledFetch,
    })
    await immediateCancelUpdater.startAppUpdate()
    await immediateCancelUpdater.cancel()
    const immediateCancelled = await waitForTerminal(immediateCancelUpdater)
    expect(immediateCancelled.phase).toBe('cancelled')
    expect(h.pluginManager.isBusy()).toBe(false)
  })

  it('blocks Zip Slip and supports both root and single-subdirectory AGY .zip layouts', async () => {
    const h = await setupHarness()

    const evilZip = createDeterministicZip([
      { relativePath: '../evil.txt', data: Buffer.from('boom') },
    ])
    const nestedZip = createDeterministicZip([
      {
        relativePath: 'memloom/plugin.json',
        data: Buffer.from(JSON.stringify({ name: 'memloom', version: '0.2.3' })),
      },
    ])
    const flatZip = createDeterministicZip([
      {
        relativePath: 'plugin.json',
        data: Buffer.from(JSON.stringify({ name: 'memloom', version: '0.2.4' })),
      },
    ])

    let activeZip = evilZip
    let activeVer = '0.2.3'
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes(`/releases/tags/v${activeVer}`)) {
        return new Response(JSON.stringify(makeReleasePayload(activeVer)), { status: 200 })
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${sha256Hex(activeZip)}  memloom-agy-plugin-${activeVer}.zip\n`, {
          status: 200,
        })
      }
      return new Response(new Uint8Array(activeZip), { status: 200 })
    }

    const updater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl,
    })

    // 1. Zip Slip rejected
    await expect(updater.installOnlinePlugin({ kind: 'agy', version: '0.2.3' })).rejects.toThrow()

    // 2. Single-subdirectory zip succeeds
    activeZip = nestedZip
    const resNested = await updater.installOnlinePlugin({ kind: 'agy', version: '0.2.3' })
    expect(resNested.version).toBe('0.2.3')

    // 3. Flat root zip succeeds
    activeZip = flatZip
    activeVer = '0.2.4'
    const resFlat = await updater.installOnlinePlugin({ kind: 'agy', version: '0.2.4' })
    expect(resFlat.version).toBe('0.2.4')
  })

  it('handles Electron app update, installer launch failure rollback, post-restart sync, partial retry, and stale cleanup', async () => {
    const h = await setupHarness()
    // Pre-install AGY & DSH desktop profile
    await fs.mkdir(path.join(h.homeDir, '.gemini', 'config', 'plugins', 'memloom'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(h.homeDir, '.gemini', 'config', 'plugins', 'memloom', 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.2' }),
      'utf8',
    )
    const dshDesktop = path.join(h.homeDir, '.dsh', 'profiles', 'desktop')
    await fs.mkdir(path.join(dshDesktop, 'node_modules', 'memloom'), { recursive: true })
    await fs.writeFile(
      path.join(dshDesktop, 'package.json'),
      JSON.stringify({
        dependencies: { memloom: '0.2.2' },
        dsh: { profile: { bundles: ['memloom'] } },
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(dshDesktop, 'node_modules', 'memloom', 'package.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.2' }),
      'utf8',
    )

    const exeBytes = Buffer.from('valid-nsis-installer')
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify(makeReleasePayload('0.2.3')), { status: 200 })
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${sha256Hex(exeBytes)}  memloom-desktop-0.2.3-win-x64-setup.exe\n`, {
          status: 200,
        })
      }
      return new Response(exeBytes, { status: 200 })
    }

    // 1. Installer launch failure (e.g. Smart App Control EACCES) -> rollback pendingPluginSync, invoke onInstallerLaunchAborted, never quit
    const quitFailSpy = vi.fn()
    const abortedRollbackSpy = vi.fn()
    const failingLauncherUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl,
      onInstallerLaunchAborted: abortedRollbackSpy,
      launchInstallerImpl: async () => {
        throw new Error('EACCES: blocked by Smart App Control')
      },
      requestAppQuit: quitFailSpy,
    })
    await failingLauncherUpdater.startAppUpdate()
    const launchFailState = await waitForTerminal(failingLauncherUpdater)
    expect(launchFailState.phase).toBe('failed')
    expect(launchFailState.installerPath).toMatch(/memloom-desktop-0\.2\.3-win-x64-setup\.exe$/)
    expect(h.registry.getPendingPluginSync()).toBeNull()
    expect(abortedRollbackSpy).toHaveBeenCalledTimes(1)
    expect(quitFailSpy).not.toHaveBeenCalled()

    // 2. Successful launch -> prepareForInstallerQuit, pendingPluginSync written, requestAppQuit called
    const prepareSpy = vi.fn(async () => undefined)
    const launchSpy = vi.fn(async () => undefined)
    const quitSpy = vi.fn()
    const oldUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl,
      prepareForInstallerQuit: prepareSpy,
      launchInstallerImpl: launchSpy,
      requestAppQuit: quitSpy,
    })
    await oldUpdater.startAppUpdate()
    const okLaunchState = await waitForTerminal(oldUpdater)
    expect(okLaunchState.phase).toBe('completed')
    expect(prepareSpy).toHaveBeenCalledTimes(1)
    expect(launchSpy).toHaveBeenCalledTimes(1)
    expect(quitSpy).toHaveBeenCalledTimes(1)
    expect(h.registry.getPendingPluginSync()?.targets).toHaveLength(2)

    // 3. New version v0.2.3 boots while DSH is running -> AGY succeeds, DSH blocked & retained in pendingSync
    h.setDshRunning(true)
    const newUpdater = new DesktopUpdater({
      currentVersion: '0.2.3',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl,
    })
    const partialState = await newUpdater.reconcilePendingSyncOnStartup()
    expect(partialState.phase).toBe('failed')
    expect(partialState.pendingSync?.targets).toHaveLength(1)
    expect(partialState.pendingSync?.targets[0]?.kind).toBe('dsh')
    expect(partialState.pendingSync?.targets[0]?.status).toBe('blocked-dsh-running')

    // 4. Close DSH and retry syncPending() -> succeeds & clears pendingPluginSync
    h.setDshRunning(false)
    await newUpdater.syncPending()
    const retriedState = await waitForTerminal(newUpdater)
    expect(retriedState.phase).toBe('completed')
    expect(h.registry.getPendingPluginSync()).toBeNull()

    // 5. Stale pendingSync when user cancelled NSIS and reopened old version v0.2.2 -> cleared without syncing
    await h.registry.setPendingPluginSync({
      targetVersion: '0.2.3',
      requestedAt: '2026-11-27T00:00:00.000Z',
      targets: [{ kind: 'agy', previousVersion: '0.2.2', status: 'pending' }],
    })
    const staleState = await oldUpdater.reconcilePendingSyncOnStartup()
    expect(staleState.pendingSync).toBeNull()
    expect(h.registry.getPendingPluginSync()).toBeNull()
  })

  it('isolates local-bridge from pendingPluginSync, rejects startAppUpdate, and updates plugins online', async () => {
    const h = await setupHarness({ runtimeMode: 'local-bridge' })
    const agyZip = createDeterministicZip([
      {
        relativePath: 'plugin.json',
        data: Buffer.from(JSON.stringify({ name: 'memloom', version: '0.2.3' })),
      },
    ])
    await fs.mkdir(path.join(h.homeDir, '.gemini', 'config', 'plugins', 'memloom'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(h.homeDir, '.gemini', 'config', 'plugins', 'memloom', 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.2' }),
      'utf8',
    )

    const pending = {
      targetVersion: '0.2.3',
      requestedAt: '2026-11-27T00:00:00.000Z',
      targets: [{ kind: 'agy' as const, previousVersion: '0.2.2', status: 'pending' as const }],
    }
    await h.registry.setPendingPluginSync(pending)

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify(makeReleasePayload('0.2.3')), { status: 200 })
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${sha256Hex(agyZip)}  memloom-agy-plugin-0.2.3.zip\n`, { status: 200 })
      }
      return new Response(new Uint8Array(agyZip), { status: 200 })
    }

    const localUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'local-bridge',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl,
    })

    // Must neither execute nor clear pendingPluginSync
    await localUpdater.reconcilePendingSyncOnStartup()
    expect(h.registry.getPendingPluginSync()).toEqual(pending)

    // startAppUpdate is unsupported in local-bridge
    await expect(localUpdater.startAppUpdate()).rejects.toBeInstanceOf(DesktopUnsupportedError)

    // updateInstalledPluginsOnline updates AGY online
    await localUpdater.updateInstalledPluginsOnline()
    const done = await waitForTerminal(localUpdater)
    expect(done.phase).toBe('completed')
    const installedJson = JSON.parse(
      await fs.readFile(
        path.join(h.homeDir, '.gemini', 'config', 'plugins', 'memloom', 'plugin.json'),
        'utf8',
      ),
    ) as { version: string }
    expect(installedJson.version).toBe('0.2.3')
  })

  it('requests /releases/tags/v<version> for installOnlinePlugin with explicit version', async () => {
    const h = await setupHarness()
    const requestedUrls: string[] = []
    const agyZip = createDeterministicZip([
      {
        relativePath: 'plugin.json',
        data: Buffer.from(JSON.stringify({ name: 'memloom', version: '0.2.2' })),
      },
    ])

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.includes('/releases/tags/v0.2.2')) {
        return new Response(JSON.stringify(makeReleasePayload('0.2.2')), { status: 200 })
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${sha256Hex(agyZip)}  memloom-agy-plugin-0.2.2.zip\n`, { status: 200 })
      }
      return new Response(new Uint8Array(agyZip), { status: 200 })
    }

    const updater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl,
    })

    const res = await updater.installOnlinePlugin({ kind: 'agy', version: '0.2.2' })
    expect(res.version).toBe('0.2.2')
    expect(requestedUrls.some((u) => u.endsWith('/releases/tags/v0.2.2'))).toBe(true)
    expect(requestedUrls.some((u) => u.endsWith('/releases/latest'))).toBe(false)

    // 404 for unpublished release gives explicit not-published message
    const notFoundUpdater = new DesktopUpdater({
      currentVersion: '0.2.2',
      runtimeMode: 'electron',
      hostPlatform: 'win32',
      updatesDir: h.updatesDir,
      registry: h.registry,
      pluginManager: h.pluginManager,
      resolveBundled: async () => h.bundledV2,
      fetchImpl: async () => new Response('Not Found', { status: 404 }),
    })
    await expect(
      notFoundUpdater.installOnlinePlugin({ kind: 'agy', version: '9.9.9' }),
    ).rejects.toThrow(/HTTP 404.*not be published/i)
  })
})
