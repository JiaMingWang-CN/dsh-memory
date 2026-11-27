import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformAdapter } from '../../src/desktop/platform/index.ts'
import type { DshProcessProbeResult, PlatformAdapter } from '../../src/desktop/platform/types.ts'
import {
  createWin32PlatformAdapter,
  parseWin32ProcessOutput,
  probeAgyPluginStatus,
  probeDshPluginStatus,
} from '../../src/desktop/platform/win32.ts'
import { DesktopReadonlyGuardError, WriteGuard } from '../../src/desktop/write-guard.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'memloom-desktop-guard-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseWin32ProcessOutput', () => {
  it('detects DeepSeek Harness.exe and DSH node.exe runtimes while ignoring ordinary node.exe', () => {
    const arrayJson = JSON.stringify([
      { Name: 'node.exe', ProcessId: 101, CommandLine: 'node.exe vitest run' },
      { Name: 'node.exe', ProcessId: 102, CommandLine: null },
      {
        Name: 'DeepSeek Harness.exe',
        ProcessId: 201,
        CommandLine: '"C:\\App\\DeepSeek Harness.exe"',
      },
      {
        Name: 'node.exe',
        ProcessId: 202,
        CommandLine: 'node.exe C:\\Users\\u\\.dsh\\dsh-runtimes\\worker.js',
      },
      {
        Name: 'NODE.EXE',
        ProcessId: 203,
        CommandLine: 'node.exe --entry dsh-host/dist/index.js',
      },
      {
        Name: 'node.exe',
        ProcessId: 204,
        CommandLine: 'node.exe "C:\\Program Files\\DeepSeek Harness\\resources\\server.js"',
      },
    ])

    const res = parseWin32ProcessOutput(arrayJson)
    expect(res.running).toBe(true)
    expect(res.uncertain).toBe(false)
    expect(res.matchedProcesses).toHaveLength(4)
    expect(res.matchedProcesses.some((item) => item.includes('DeepSeek Harness.exe'))).toBe(true)
    expect(
      res.matchedProcesses.every((item) => !item.includes('101') && !item.includes('102')),
    ).toBe(true)
  })

  it('handles single-object JSON output from PowerShell ConvertTo-Json', () => {
    const singleJson = JSON.stringify({
      Name: 'DeepSeek Harness.exe',
      ProcessId: 333,
      CommandLine: 'DeepSeek Harness.exe',
    })
    const res = parseWin32ProcessOutput(singleJson)
    expect(res.running).toBe(true)
    expect(res.uncertain).toBe(false)
    expect(res.matchedProcesses).toHaveLength(1)
  })

  it('returns not running for empty output, null, empty array, or unrelated node.exe only', () => {
    expect(parseWin32ProcessOutput('')).toEqual({
      running: false,
      uncertain: false,
      matchedProcesses: [],
    })
    expect(parseWin32ProcessOutput('   \r\n ')).toEqual({
      running: false,
      uncertain: false,
      matchedProcesses: [],
    })
    expect(parseWin32ProcessOutput('null')).toEqual({
      running: false,
      uncertain: false,
      matchedProcesses: [],
    })
    expect(parseWin32ProcessOutput('[]')).toEqual({
      running: false,
      uncertain: false,
      matchedProcesses: [],
    })
    expect(
      parseWin32ProcessOutput(
        JSON.stringify([{ Name: 'node.exe', ProcessId: 88, CommandLine: 'vite dev' }]),
      ),
    ).toEqual({
      running: false,
      uncertain: false,
      matchedProcesses: [],
    })
  })

  it('fails closed with uncertain=true on malformed JSON or unexpected payload shape', () => {
    const badJson = parseWin32ProcessOutput('{ not valid json')
    expect(badJson.running).toBe(false)
    expect(badJson.uncertain).toBe(true)
    expect(badJson.matchedProcesses).toEqual([])
    expect(badJson.error).toBeTruthy()

    const badShape = parseWin32ProcessOutput('"unexpected string"')
    expect(badShape.running).toBe(false)
    expect(badShape.uncertain).toBe(true)
    expect(badShape.matchedProcesses).toEqual([])
  })
})

describe('createWin32PlatformAdapter and platform factory', () => {
  it('returns uncertain=true when probe runner throws timeout or permission error', async () => {
    const adapter = createWin32PlatformAdapter({
      homeDir: makeTempDir(),
      probeTimeoutMs: 500,
      runProbe: async () => {
        throw new Error('ETIMEDOUT: powershell probe timed out')
      },
    })

    const res = await adapter.detectDshProcesses()
    expect(res.running).toBe(false)
    expect(res.uncertain).toBe(true)
    expect(res.matchedProcesses).toEqual([])
    expect(res.error).toContain('ETIMEDOUT')
  })

  it('resolves DSH default and profile stores under DSH_HOME or homeDir fallback', async () => {
    const root = makeTempDir()
    const dshHome = join(root, 'custom-dsh')
    mkdirSync(join(dshHome, 'storages'), { recursive: true })
    writeFileSync(join(dshHome, 'storages', 'memory.json'), '{}', 'utf8')
    mkdirSync(join(dshHome, 'profiles', 'work', 'storages'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', 'work', 'storages', 'memory.json'), '{}', 'utf8')
    mkdirSync(join(dshHome, 'profiles', 'empty-profile', 'storages'), { recursive: true })

    const adapter = createWin32PlatformAdapter({ homeDir: root })
    const stores = await adapter.resolveDefaultDshStores({ DSH_HOME: dshHome })

    expect(stores.map((s) => s.id)).toEqual(['dsh-default', 'dsh-profile-work'])
    expect(stores[0]).toMatchObject({
      id: 'dsh-default',
      kind: 'dsh',
      storePath: join(dshHome, 'storages', 'memory.json'),
    })
    expect(stores[1]).toMatchObject({
      id: 'dsh-profile-work',
      kind: 'dsh',
      profileName: 'work',
      storePath: join(dshHome, 'profiles', 'work', 'storages', 'memory.json'),
    })

    const fallbackStores = await adapter.resolveDefaultDshStores({})
    expect(fallbackStores).toMatchObject([
      {
        id: 'dsh-default',
        name: 'DSH (Default)',
        kind: 'dsh',
        storePath: join(root, '.dsh', 'storages', 'memory.json'),
        pluginStatus: {
          state: 'not-installed',
          installed: false,
          enabled: false,
        },
      },
    ])
  })

  it('resolves AGY default store and exposes legacyCandidatePath when primary is missing and legacy exists', async () => {
    const home = makeTempDir()
    const legacyDir = join(home, '.gemini', 'config', 'plugin-data', 'dsh-memory')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'memory.json')
    writeFileSync(legacyPath, '{}', 'utf8')

    const adapter = createWin32PlatformAdapter({ homeDir: home })
    const discovered = await adapter.resolveDefaultAgyStore({})
    expect(discovered.primary).toMatchObject({
      id: 'agy-default',
      kind: 'agy',
      storePath: join(home, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json'),
    })
    expect(discovered.legacyCandidatePath).toBe(legacyPath)

    // Once primary store exists, legacyCandidatePath is no longer surfaced
    mkdirSync(join(home, '.gemini', 'config', 'plugin-data', 'memloom'), { recursive: true })
    writeFileSync(discovered.primary.storePath, '{}', 'utf8')
    const afterPrimaryExists = await adapter.resolveDefaultAgyStore({})
    expect(afterPrimaryExists.legacyCandidatePath).toBeUndefined()
  })

  it('exposes darwin and linux conservative fail-closed stubs via createPlatformAdapter', async () => {
    const darwin = createPlatformAdapter('darwin')
    expect(darwin.platform).toBe('darwin')
    const darwinProbe = await darwin.detectDshProcesses()
    expect(darwinProbe.running).toBe(false)
    expect(darwinProbe.uncertain).toBe(true)

    const linux = createPlatformAdapter('linux')
    expect(linux.platform).toBe('linux')
    const linuxProbe = await linux.detectDshProcesses()
    expect(linuxProbe.running).toBe(false)
    expect(linuxProbe.uncertain).toBe(true)

    const win32 = createPlatformAdapter('win32')
    expect(win32.platform).toBe('win32')
  })
})

describe('WriteGuard state machine', () => {
  function makeStubPlatform(probeFn: () => Promise<DshProcessProbeResult>): PlatformAdapter {
    return {
      platform: 'win32',
      detectDshProcesses: probeFn,
      resolveDefaultDshStores: async () => [],
      resolveDefaultAgyStore: async () => ({
        primary: {
          id: 'agy-default',
          name: 'AGY (Default)',
          kind: 'agy',
          storePath: '/tmp/agy/memory.json',
        },
      }),
    }
  }

  it('transitions fail-closed -> readonly -> force-unlocked -> relocked -> writable', async () => {
    let currentProbe: DshProcessProbeResult = {
      running: false,
      uncertain: true,
      matchedProcesses: [],
      error: 'probe failed',
    }
    const tick = new Date('2026-11-25T10:00:00.000Z')
    const guard = new WriteGuard(
      makeStubPlatform(async () => currentProbe),
      () => tick,
    )

    // Initial state before first refresh is fail-closed readonly
    expect(guard.getSnapshot().mode).toBe('readonly-dsh-running')
    expect(guard.isClientWritable(true)).toBe(false)
    expect(guard.isClientWritable(false)).toBe(true)

    // Refresh with uncertain=true stays readonly-dsh-running
    const uncertainSnap = await guard.refresh()
    expect(uncertainSnap.mode).toBe('readonly-dsh-running')
    expect(uncertainSnap.uncertain).toBe(true)
    expect(() => guard.assertClientWritable(true)).toThrow(DesktopReadonlyGuardError)
    try {
      guard.assertClientWritable(true)
    } catch (err) {
      expect(err).toBeInstanceOf(DesktopReadonlyGuardError)
      expect((err as DesktopReadonlyGuardError).code).toBe('desktop/readonly-guard')
      expect((err as DesktopReadonlyGuardError).snapshot.mode).toBe('readonly-dsh-running')
    }
    expect(() => guard.assertClientWritable(false)).not.toThrow()

    // Refresh with running=true stays readonly-dsh-running
    currentProbe = {
      running: true,
      uncertain: false,
      matchedProcesses: ['DeepSeek Harness.exe (PID 42)'],
    }
    const runningSnap = await guard.refresh()
    expect(runningSnap.mode).toBe('readonly-dsh-running')
    expect(runningSnap.dshRunning).toBe(true)
    expect(runningSnap.uncertain).toBe(false)

    // forceUnlock(false) rejects without unlocking
    expect(() => guard.forceUnlock(false)).toThrow(DesktopReadonlyGuardError)
    expect(guard.getSnapshot().mode).toBe('readonly-dsh-running')

    // forceUnlock(true) unlocks protected clients for the session
    const unlockedSnap = guard.forceUnlock(true)
    expect(unlockedSnap.mode).toBe('force-unlocked')
    expect(guard.isClientWritable(true)).toBe(true)
    expect(() => guard.assertClientWritable(true)).not.toThrow()

    // Refresh while DSH is still running keeps force-unlocked
    const stillRunningSnap = await guard.refresh()
    expect(stillRunningSnap.mode).toBe('force-unlocked')

    // relock() returns to readonly-dsh-running
    const relockedSnap = guard.relock()
    expect(relockedSnap.mode).toBe('readonly-dsh-running')
    expect(guard.isClientWritable(true)).toBe(false)
    expect(() => guard.assertClientWritable(true)).toThrow(DesktopReadonlyGuardError)

    // Refresh when DSH exits enters writable
    currentProbe = {
      running: false,
      uncertain: false,
      matchedProcesses: [],
    }
    const writableSnap = await guard.refresh()
    expect(writableSnap.mode).toBe('writable')
    expect(writableSnap.dshRunning).toBe(false)
    expect(writableSnap.uncertain).toBe(false)
    expect(guard.isClientWritable(true)).toBe(true)
    expect(() => guard.assertClientWritable(true)).not.toThrow()
  })

  it('fails closed to readonly-dsh-running if detectDshProcesses rejects', async () => {
    const guard = new WriteGuard(
      makeStubPlatform(async () => {
        throw new Error('unexpected probe crash')
      }),
    )

    const snap = await guard.refresh()
    expect(snap.mode).toBe('readonly-dsh-running')
    expect(snap.uncertain).toBe(true)
    expect(snap.dshRunning).toBe(false)
    expect(snap.reason).toContain('unexpected probe crash')
  })

  it('probes DSH plugin install/enabled status across package.json, node_modules, and cordis.patch.yml', async () => {
    const dshHome = makeTempDir('dsh-plugin-probe-')
    expect((await probeDshPluginStatus(dshHome)).state).toBe('not-installed')

    const profileDir = join(dshHome, 'profiles', 'desktop')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-memory'), { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        dsh: { profile: { bundles: ['dsh-memory'] } },
        dependencies: { 'dsh-memory': '0.2.1' },
      }),
      'utf8',
    )
    writeFileSync(
      join(profileDir, 'node_modules', 'dsh-memory', 'package.json'),
      JSON.stringify({ name: 'dsh-memory', version: '0.2.1' }),
      'utf8',
    )
    // Unrelated scoped legacy entry must not mark dsh-memory disabled
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- id: memory',
        '  name: "@wjm200509/dsh-memory"',
        '  disabled: true',
        '- id: dsh-memory',
        '  name: dsh-memory',
        '  config:',
        '    autoDream: true',
      ].join('\n'),
      'utf8',
    )

    const enabled = await probeDshPluginStatus(dshHome)
    expect(enabled).toMatchObject({
      state: 'enabled',
      installed: true,
      enabled: true,
      version: '0.2.1',
      pluginName: 'dsh-memory',
    })

    // cordis.patch.yml disabled: true -> disabled
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      ['- id: dsh-memory', '  name: dsh-memory', '  disabled: true'].join('\n'),
      'utf8',
    )
    expect((await probeDshPluginStatus(dshHome)).state).toBe('disabled')

    // cordis.patch.yml config.enabled: false -> disabled
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      ['- id: dsh-memory', '  name: dsh-memory', '  config:', '    enabled: false'].join('\n'),
      'utf8',
    )
    expect((await probeDshPluginStatus(dshHome)).state).toBe('disabled')

    // Removed from dsh.profile.bundles while still in dependencies -> disabled
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        dsh: { profile: { bundles: [] } },
        dependencies: { 'dsh-memory': '0.2.1' },
      }),
      'utf8',
    )
    expect((await probeDshPluginStatus(dshHome)).state).toBe('disabled')
  })

  it('probes AGY plugin install/enabled status across plugins dir, plugins.json fallback, config.json, and runtime config', async () => {
    const home = makeTempDir('agy-plugin-probe-')
    const storePath = join(home, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json')
    expect((await probeAgyPluginStatus(home, storePath)).state).toBe('not-installed')

    const pluginDir = join(home, '.gemini', 'config', 'plugins', 'memloom')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.1' }),
      'utf8',
    )

    const enabled = await probeAgyPluginStatus(home, storePath)
    expect(enabled).toMatchObject({
      state: 'enabled',
      installed: true,
      enabled: true,
      version: '0.2.1',
      pluginName: 'memloom',
      installPath: pluginDir,
    })

    // Disabled in ~/.gemini/config/config.json
    writeFileSync(
      join(home, '.gemini', 'config', 'config.json'),
      JSON.stringify({ plugins: { memloom: { enabled: false } } }),
      'utf8',
    )
    expect((await probeAgyPluginStatus(home, storePath)).state).toBe('disabled')

    // Re-enabled in AGY config, disabled in plugin runtime config.json
    writeFileSync(
      join(home, '.gemini', 'config', 'config.json'),
      JSON.stringify({ plugins: { memloom: { enabled: true } } }),
      'utf8',
    )
    mkdirSync(dirname(storePath), { recursive: true })
    writeFileSync(
      join(dirname(storePath), 'config.json'),
      JSON.stringify({ enabled: false }),
      'utf8',
    )
    expect((await probeAgyPluginStatus(home, storePath)).state).toBe('disabled')

    // plugins.json fallback when not copied into ~/.gemini/config/plugins
    rmSync(pluginDir, { recursive: true, force: true })
    rmSync(join(dirname(storePath), 'config.json'), { force: true })
    const customPluginDir = join(home, 'custom-agy-plugin')
    mkdirSync(customPluginDir, { recursive: true })
    writeFileSync(
      join(customPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.1' }),
      'utf8',
    )
    writeFileSync(
      join(home, '.gemini', 'config', 'plugins.json'),
      JSON.stringify([customPluginDir]),
      'utf8',
    )
    const fallbackEnabled = await probeAgyPluginStatus(home, storePath)
    expect(fallbackEnabled).toMatchObject({
      state: 'enabled',
      installed: true,
      version: '0.2.1',
      installPath: customPluginDir,
    })
  })
})
