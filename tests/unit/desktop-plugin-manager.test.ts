import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBundledPlugins } from '../../src/desktop/bundled-plugins.ts'
import {
  DesktopBusyError,
  DesktopDshCliMissingError,
  DesktopDshRunningError,
  DesktopPluginManager,
  DesktopPluginOpError,
  isAllowedDshCliBasename,
  validateSafeDshProfileName,
  type DshExecRunnerOptions,
} from '../../src/desktop/plugin-manager.ts'
import { createWin32PlatformAdapter } from '../../src/desktop/platform/win32.ts'
import { ClientRegistry } from '../../src/desktop/registry.ts'

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(prefix = 'memloom-pm-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

async function createFakeBundled(
  rootDir: string,
  version: string,
): Promise<ResolvedBundledPlugins> {
  const bundledRoot = path.join(rootDir, `bundled-${version}`)
  const agyDir = path.join(bundledRoot, 'agy-plugin')
  const dshDir = path.join(bundledRoot, 'dsh-bundle')
  await fs.mkdir(path.join(agyDir, 'bin'), { recursive: true })
  await fs.mkdir(dshDir, { recursive: true })

  const pluginJson = JSON.stringify({ name: 'memloom', version }, null, 2)
  const mcpJs = `// memloom mcp v${version}\n`
  await fs.writeFile(path.join(agyDir, 'plugin.json'), pluginJson, 'utf8')
  await fs.writeFile(path.join(agyDir, 'bin', 'mcp-server.mjs'), mcpJs, 'utf8')

  const files = ['bin/mcp-server.mjs', 'plugin.json']
  const agyHash = createHash('sha256')
  agyHash.update('bin/mcp-server.mjs\0').update(mcpJs)
  agyHash.update('plugin.json\0').update(pluginJson)
  const agySha = agyHash.digest('hex')

  const tgzName = `memloom-${version}.tgz`
  const tgzPath = path.join(dshDir, tgzName)
  const tgzBuf = Buffer.from(`fake-tgz-${version}`)
  await fs.writeFile(tgzPath, tgzBuf)
  const dshSha = createHash('sha256').update(tgzBuf).digest('hex')

  const manifest = {
    version,
    builtAt: '2026-11-27T00:00:00.000Z',
    agy: { dir: 'agy-plugin', files, sha256: agySha },
    dsh: { file: `dsh-bundle/${tgzName}`, sha256: dshSha },
  }
  await fs.writeFile(path.join(bundledRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  return { rootDir: bundledRoot, manifest, agyDir, dshTgzPath: tgzPath }
}

async function setupEnv(options?: { dshProbeJson?: string; dshProbeThrows?: boolean }) {
  const root = await makeTempDir()
  const homeDir = path.join(root, 'home')
  const statePath = path.join(root, 'userData', 'desktop-state.json')
  await fs.mkdir(homeDir, { recursive: true })
  const platform = createWin32PlatformAdapter({
    homeDir,
    runProbe: async () => {
      if (options?.dshProbeThrows) throw new Error('CIM failure')
      return options?.dshProbeJson ?? '[]'
    },
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
  return { root, homeDir, statePath, platform, env, registry }
}

describe('DesktopPluginManager', () => {
  it('installs, upgrades (preserving disabled state), and uninstalls AGY without touching plugin-data', async () => {
    const { root, homeDir, platform, env, registry } = await setupEnv()
    const bundledV1 = await createFakeBundled(root, '0.2.2')
    const bundledV2 = await createFakeBundled(root, '0.2.3')
    let activeBundled = bundledV1

    const pluginDataDir = path.join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom')
    await fs.mkdir(pluginDataDir, { recursive: true })
    const memoryJsonPath = path.join(pluginDataDir, 'memory.json')
    const runtimeConfigPath = path.join(pluginDataDir, 'config.json')
    const memoryContent = '{"name":"memory","version":1,"memories":{"m1":{"text":"keep"}}}'
    const configContent = '{"enabled":true,"custom":42}'
    await fs.writeFile(memoryJsonPath, memoryContent, 'utf8')
    await fs.writeFile(runtimeConfigPath, configContent, 'utf8')

    const pm = new DesktopPluginManager({
      registry,
      platform,
      homeDir,
      env,
      trustedArtifactRoots: [root],
      resolveBundled: async () => activeBundled,
    })

    // Fresh install
    const installRes = await pm.installBundled({ kind: 'agy' })
    expect(installRes.version).toBe('0.2.2')
    expect(installRes.pluginStatus.installed).toBe(true)
    expect(installRes.pluginStatus.state).toBe('enabled')

    // Simulate user disabling AGY plugin in host config.json
    const hostConfigPath = path.join(homeDir, '.gemini', 'config', 'config.json')
    await fs.writeFile(
      hostConfigPath,
      JSON.stringify({ plugins: { memloom: { enabled: false } } }),
      'utf8',
    )

    // Upgrade to v0.2.3 — must preserve disabled state
    activeBundled = bundledV2
    const upgradeRes = await pm.installBundled({ kind: 'agy' })
    expect(upgradeRes.version).toBe('0.2.3')
    expect(upgradeRes.pluginStatus.state).toBe('disabled')

    // Uninstall — must keep memory.json & runtime config.json byte-identical
    const uninstallRes = await pm.uninstall({ kind: 'agy' })
    expect(uninstallRes.pluginStatus.installed).toBe(false)
    expect(await fs.readFile(memoryJsonPath, 'utf8')).toBe(memoryContent)
    expect(await fs.readFile(runtimeConfigPath, 'utf8')).toBe(configContent)
  })

  it('protects AGY symlinks, preserves third-party plugins.json entries, and fails closed on corrupt JSON', async () => {
    const { root, homeDir, platform, env, registry } = await setupEnv()
    const bundled = await createFakeBundled(root, '0.2.3')
    const externalRepo = path.join(root, 'my-dev-memloom')
    await fs.mkdir(externalRepo, { recursive: true })
    await fs.writeFile(
      path.join(externalRepo, 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.1.0' }),
      'utf8',
    )
    await fs.writeFile(path.join(externalRepo, 'sentinel.txt'), 'do-not-delete', 'utf8')

    const geminiConfigDir = path.join(homeDir, '.gemini', 'config')
    const pluginsDir = path.join(geminiConfigDir, 'plugins')
    await fs.mkdir(pluginsDir, { recursive: true })
    const symlinkTarget = path.join(pluginsDir, 'memloom')
    await fs.symlink(externalRepo, symlinkTarget, process.platform === 'win32' ? 'junction' : 'dir')

    const pm = new DesktopPluginManager({
      registry,
      platform,
      homeDir,
      env,
      trustedArtifactRoots: [root],
      resolveBundled: async () => bundled,
    })

    // Uninstall symlink — must unlink only, leaving externalRepo intact
    const unlinkRes = await pm.uninstall({ kind: 'agy' })
    expect(unlinkRes.pluginStatus.installed).toBe(false)
    expect(await fs.readFile(path.join(externalRepo, 'sentinel.txt'), 'utf8')).toBe('do-not-delete')

    // Multi-plugin plugins.json containing third-party plugin + external memloom
    const pluginsJsonPath = path.join(geminiConfigDir, 'plugins.json')
    await fs.writeFile(
      pluginsJsonPath,
      JSON.stringify({
        'other-plugin': { path: 'C:/other/plugin', extra: 123 },
        memloom: { path: externalRepo },
      }),
      'utf8',
    )

    const installRes = await pm.installBundled({ kind: 'agy' })
    expect(installRes.pluginStatus.installed).toBe(true)
    const updatedPluginsJson = JSON.parse(await fs.readFile(pluginsJsonPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(updatedPluginsJson['other-plugin']).toEqual({ path: 'C:/other/plugin', extra: 123 })
    expect(updatedPluginsJson.memloom).toBeUndefined()
    expect(await fs.readFile(path.join(externalRepo, 'sentinel.txt'), 'utf8')).toBe('do-not-delete')

    // Non-standard sibling directory (e.g. manually extracted memloom-agy-plugin-0.2.1) is cleaned up while unrelated third-party plugin stays intact
    const nonStandardDup = path.join(pluginsDir, 'memloom-agy-plugin-0.2.1')
    const thirdPartyDir = path.join(pluginsDir, 'other-plugin')
    await fs.mkdir(nonStandardDup, { recursive: true })
    await fs.mkdir(thirdPartyDir, { recursive: true })
    await fs.writeFile(
      path.join(nonStandardDup, 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.1' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(thirdPartyDir, 'plugin.json'),
      JSON.stringify({ name: 'other-plugin', version: '1.0.0' }),
      'utf8',
    )
    await pm.installBundled({ kind: 'agy' })
    await expect(fs.stat(nonStandardDup)).rejects.toThrow()
    expect((await fs.stat(thirdPartyDir)).isDirectory()).toBe(true)

    // Corrupt config.json — fail closed without overwriting
    const corruptContent = '{ invalid json'
    const hostConfigPath = path.join(geminiConfigDir, 'config.json')
    await fs.writeFile(hostConfigPath, corruptContent, 'utf8')
    await expect(pm.installBundled({ kind: 'agy' })).rejects.toBeInstanceOf(DesktopPluginOpError)
    expect(await fs.readFile(hostConfigPath, 'utf8')).toBe(corruptContent)
  })

  it('rolls back existing AGY directory when atomic swap fails with EBUSY', async () => {
    const { root, homeDir, platform, env, registry } = await setupEnv()
    const bundledV1 = await createFakeBundled(root, '0.2.2')
    const bundledV2 = await createFakeBundled(root, '0.2.3')
    let activeBundled = bundledV1

    let failOnSecondRename = false
    let renameCallCount = 0
    const pm = new DesktopPluginManager({
      registry,
      platform,
      homeDir,
      env,
      trustedArtifactRoots: [root],
      resolveBundled: async () => activeBundled,
      renameImpl: async (oldPath, newPath) => {
        if (failOnSecondRename) {
          renameCallCount += 1
          if (renameCallCount === 2) {
            const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException
            err.code = 'EBUSY'
            throw err
          }
        }
        await fs.rename(oldPath, newPath)
      },
    })

    await pm.installBundled({ kind: 'agy' })

    activeBundled = bundledV2
    failOnSecondRename = true
    await expect(pm.installBundled({ kind: 'agy' })).rejects.toBeInstanceOf(DesktopPluginOpError)

    const restoredPluginJson = JSON.parse(
      await fs.readFile(
        path.join(homeDir, '.gemini', 'config', 'plugins', 'memloom', 'plugin.json'),
        'utf8',
      ),
    ) as { version: string }
    expect(restoredPluginJson.version).toBe('0.2.2')
  })

  it('enforces DSH running guard, Windows .cmd quoting & metacharacter checks, cli whitelist, and legacy migration', async () => {
    // 1. Running DSH process blocks operation
    const runningEnv = await setupEnv({
      dshProbeJson: JSON.stringify([{ Name: 'DeepSeek Harness.exe', ProcessId: 1234 }]),
    })
    const bundled = await createFakeBundled(runningEnv.root, '0.2.3')
    const runningPm = new DesktopPluginManager({
      registry: runningEnv.registry,
      platform: runningEnv.platform,
      homeDir: runningEnv.homeDir,
      env: runningEnv.env,
      hostPlatform: 'win32',
      trustedArtifactRoots: [runningEnv.root],
      resolveBundled: async () => bundled,
    })
    await expect(
      runningPm.installBundled({ kind: 'dsh', profileName: 'desktop' }),
    ).rejects.toBeInstanceOf(DesktopDshRunningError)

    // 2. Uncertain probe also blocks (fail-closed)
    const uncertainEnv = await setupEnv({ dshProbeThrows: true })
    const uncertainPm = new DesktopPluginManager({
      registry: uncertainEnv.registry,
      platform: uncertainEnv.platform,
      homeDir: uncertainEnv.homeDir,
      env: uncertainEnv.env,
      hostPlatform: 'win32',
      trustedArtifactRoots: [uncertainEnv.root],
      resolveBundled: async () => bundled,
    })
    await expect(
      uncertainPm.installBundled({ kind: 'dsh', profileName: 'desktop' }),
    ).rejects.toBeInstanceOf(DesktopDshRunningError)

    // 3. Space-containing Windows .cmd path + legacy dsh-memory removal + metachar rejection
    const { root, homeDir, platform, env, registry } = await setupEnv()
    const spaceRoot = path.join(root, 'Alice Smith')
    const cliDir = path.join(spaceRoot, 'pnpm')
    await fs.mkdir(cliDir, { recursive: true })
    const cliPath = path.join(cliDir, 'dsh.cmd')
    await fs.writeFile(cliPath, '@echo off\r\n', 'utf8')

    const spaceBundled = await createFakeBundled(spaceRoot, '0.2.3')
    const desktopProfileDir = path.join(homeDir, '.dsh', 'profiles', 'desktop')
    await fs.mkdir(path.join(desktopProfileDir, 'node_modules', 'dsh-memory'), { recursive: true })
    await fs.writeFile(
      path.join(desktopProfileDir, 'package.json'),
      JSON.stringify({
        dependencies: { 'dsh-memory': '0.2.1' },
        dsh: { profile: { bundles: ['dsh-memory'] } },
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(desktopProfileDir, 'node_modules', 'dsh-memory', 'package.json'),
      JSON.stringify({ name: 'dsh-memory', version: '0.2.1' }),
      'utf8',
    )

    await registry.updatePreferences({ dshCliPath: cliPath })

    const calls: Array<{ file: string; args: readonly string[]; options: DshExecRunnerOptions }> =
      []
    const pm = new DesktopPluginManager({
      registry,
      platform,
      homeDir,
      env: { ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      hostPlatform: 'win32',
      trustedArtifactRoots: [spaceRoot],
      resolveBundled: async () => spaceBundled,
      execFileRunner: async (file, args, options) => {
        calls.push({ file, args, options })
        return { stdout: 'ok', stderr: '' }
      },
    })

    await pm.installBundled({ kind: 'dsh', profileName: 'desktop' })
    expect(calls).toHaveLength(2)
    // First call removes legacy dsh-memory, second adds new tgz via cmd.exe /d /s /c with verbatim args
    expect(calls[0]!.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(calls[0]!.options.windowsVerbatimArguments).toBe(true)
    expect(calls[0]!.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(calls[0]!.args[3]).toContain(`"${cliPath}"`)
    expect(calls[0]!.args[3]).toContain('remove dsh-memory')
    expect(calls[1]!.args[3]).toContain(`"${spaceBundled.dshTgzPath}"`)

    // Reject unsafe profileName
    await expect(
      pm.installBundled({ kind: 'dsh', profileName: 'desktop & calc' }),
    ).rejects.toBeInstanceOf(DesktopPluginOpError)

    // Reject metacharacters in cliPath
    const evilCliDir = path.join(root, 'bad&dir')
    await fs.mkdir(evilCliDir, { recursive: true })
    const evilCli = path.join(evilCliDir, 'dsh.cmd')
    await fs.writeFile(evilCli, '@echo off\r\n', 'utf8')
    await registry.updatePreferences({ dshCliPath: evilCli })
    await expect(pm.installBundled({ kind: 'dsh', profileName: 'desktop' })).rejects.toBeInstanceOf(
      DesktopPluginOpError,
    )

    // Reject non-whitelisted cli basename (e.g. powershell.exe) -> ignored -> missing CLI
    const fakePs = path.join(root, 'powershell.exe')
    await fs.writeFile(fakePs, 'fake', 'utf8')
    await registry.updatePreferences({ dshCliPath: fakePs })
    await expect(pm.installBundled({ kind: 'dsh', profileName: 'desktop' })).rejects.toBeInstanceOf(
      DesktopDshCliMissingError,
    )

    expect(isAllowedDshCliBasename('C:\\bin\\dsh.cmd')).toBe(true)
    expect(isAllowedDshCliBasename('/usr/local/bin/dsh')).toBe(true)
    expect(isAllowedDshCliBasename('C:\\Windows\\powershell.exe')).toBe(false)
    expect(validateSafeDshProfileName('desktop')).toBe(true)
    expect(validateSafeDshProfileName('work_1.2-a')).toBe(true)
    expect(validateSafeDshProfileName('desktop & calc')).toBe(false)
  })

  it('skips disabled DSH profiles during syncTargetsWithBundled and handles missing profiles dir', async () => {
    const { root, homeDir, platform, env, registry } = await setupEnv()
    const bundled = await createFakeBundled(root, '0.2.3')
    const execMock = vi.fn(async () => ({ stdout: '', stderr: '' }))

    const pm = new DesktopPluginManager({
      registry,
      platform,
      homeDir,
      env,
      trustedArtifactRoots: [root],
      resolveBundled: async () => bundled,
      execFileRunner: execMock,
    })

    // Empty profiles dir -> []
    expect(await pm.listDshProfiles()).toEqual([])

    // Create a disabled DSH profile (in dependencies, omitted from bundles)
    const disabledProfileDir = path.join(homeDir, '.dsh', 'profiles', 'work')
    await fs.mkdir(path.join(disabledProfileDir, 'node_modules', 'memloom'), { recursive: true })
    await fs.writeFile(
      path.join(disabledProfileDir, 'package.json'),
      JSON.stringify({
        dependencies: { memloom: '0.2.2' },
        dsh: { profile: { bundles: [] } },
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(disabledProfileDir, 'node_modules', 'memloom', 'package.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.2' }),
      'utf8',
    )

    const profiles = await pm.listDshProfiles()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.pluginStatus.state).toBe('disabled')

    const syncResults = await pm.syncTargetsWithBundled(
      [{ kind: 'dsh', profileName: 'work', previousVersion: '0.2.2', status: 'pending' }],
      bundled,
    )
    expect(syncResults[0]!.status).toBe('skipped-disabled')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('rejects concurrent runExclusive operations immediately with DesktopBusyError', async () => {
    const { root, homeDir, platform, env, registry } = await setupEnv()
    const pm = new DesktopPluginManager({
      registry,
      platform,
      homeDir,
      env,
      trustedArtifactRoots: [root],
    })

    let releaseFirst!: () => void
    const firstDone = pm.runExclusive(
      'op-1',
      () =>
        new Promise<void>((r) => {
          releaseFirst = r
        }),
    )
    expect(pm.isBusy()).toBe(true)

    await expect(pm.runExclusive('op-2', async () => 'nope')).rejects.toBeInstanceOf(
      DesktopBusyError,
    )

    releaseFirst()
    await firstDone
    expect(pm.isBusy()).toBe(false)
  })
})
