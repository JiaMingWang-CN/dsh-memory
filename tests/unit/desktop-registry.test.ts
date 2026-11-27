import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationError } from '../../src/core/operations.ts'
import { createWin32PlatformAdapter } from '../../src/desktop/platform/win32.ts'
import { ClientRegistry } from '../../src/desktop/registry.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'memloom-desktop-registry-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeDshUnitJson(): string {
  return JSON.stringify(
    {
      unit: { name: 'memory', version: 1 },
      global: { schema: 1 },
      tables: {
        memories: {},
        episodes: {},
        dreams: {},
        audit: {},
        operations: {},
        session_cursors: {},
      },
    },
    null,
    2,
  )
}

function makeAgyFlatJson(): string {
  return JSON.stringify(
    {
      name: 'memory',
      version: 1,
      memories: {},
      episodes: {},
      dreams: {},
      audit: {},
      operations: {},
      session_cursors: {},
    },
    null,
    2,
  )
}

function createFixedClock(startIso = '2026-11-26T00:00:00.000Z'): () => Date {
  let tick = 0
  const baseMs = Date.parse(startIso)
  return () => {
    const d = new Date(baseMs + tick * 1000)
    tick += 1
    return d
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ClientRegistry', () => {
  it('discovers DSH default, DSH profiles, AGY default (missing), and legacy dsh-memory candidate', async () => {
    const root = makeTempDir()
    const homeDir = join(root, 'home')
    const statePath = join(root, 'userData', 'desktop-state.json')

    const dshDefaultPath = join(homeDir, '.dsh', 'storages', 'memory.json')
    const dshWorkPath = join(homeDir, '.dsh', 'profiles', 'work', 'storages', 'memory.json')
    const legacyAgyPath = join(
      homeDir,
      '.gemini',
      'config',
      'plugin-data',
      'dsh-memory',
      'memory.json',
    )

    mkdirSync(path.dirname(dshDefaultPath), { recursive: true })
    mkdirSync(path.dirname(dshWorkPath), { recursive: true })
    mkdirSync(path.dirname(legacyAgyPath), { recursive: true })

    writeFileSync(dshDefaultPath, makeDshUnitJson(), 'utf8')
    writeFileSync(dshWorkPath, makeDshUnitJson(), 'utf8')
    writeFileSync(legacyAgyPath, makeAgyFlatJson(), 'utf8')

    const platform = createWin32PlatformAdapter({
      homeDir,
      runProbe: async () => '[]',
    })
    const registry = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })

    await registry.load()
    const clients = await registry.refreshDiscovery()

    expect(clients).toHaveLength(3)

    const dshDefault = registry.getClient('dsh-default')
    expect(dshDefault).toBeDefined()
    expect(dshDefault).toMatchObject({
      id: 'dsh-default',
      kind: 'dsh',
      builtin: true,
      storePath: path.resolve(dshDefaultPath),
      enabled: true,
      dshProtected: true,
      allowInitializeWhenMissing: false,
      format: 'dsh-unit',
      health: 'ready',
    })

    const dshWork = registry.getClient('dsh-profile-work')
    expect(dshWork).toBeDefined()
    expect(dshWork).toMatchObject({
      id: 'dsh-profile-work',
      kind: 'dsh',
      builtin: true,
      storePath: path.resolve(dshWorkPath),
      enabled: true,
      dshProtected: true,
      allowInitializeWhenMissing: false,
      format: 'dsh-unit',
      health: 'ready',
      profileName: 'work',
    })

    const agyDefault = registry.getClient('agy-default')
    expect(agyDefault).toBeDefined()
    expect(agyDefault).toMatchObject({
      id: 'agy-default',
      kind: 'agy',
      builtin: true,
      enabled: true,
      dshProtected: false,
      allowInitializeWhenMissing: true,
      format: null,
      health: 'missing',
    })

    expect(registry.getLegacyAgyCandidate()).toBe(path.resolve(legacyAgyPath))
    expect(clients.some((c) => path.resolve(c.storePath) === path.resolve(legacyAgyPath))).toBe(
      false,
    )

    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { version: number }
    expect(persisted.version).toBe(1)
  })

  it('defaults dshProtected by format when adding custom stores and deduplicates Windows-case paths', async () => {
    const root = makeTempDir()
    const homeDir = join(root, 'home')
    const statePath = join(root, 'userData', 'desktop-state.json')

    const customDshPath = join(root, 'custom', 'DshStore', 'Memory.json')
    const customAgyPath = join(root, 'custom', 'AgyStore', 'memory.json')
    const missingCustomPath = join(root, 'custom', 'NewStore', 'memory.json')

    mkdirSync(path.dirname(customDshPath), { recursive: true })
    mkdirSync(path.dirname(customAgyPath), { recursive: true })
    writeFileSync(customDshPath, makeDshUnitJson(), 'utf8')
    writeFileSync(customAgyPath, makeAgyFlatJson(), 'utf8')

    const platform = createWin32PlatformAdapter({
      homeDir,
      runProbe: async () => '[]',
    })
    const registry = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })

    await registry.load()
    await registry.refreshDiscovery()

    const addedDsh = await registry.addCustomClient({
      name: 'Custom DSH',
      storePath: customDshPath,
    })
    expect(addedDsh).toMatchObject({
      name: 'Custom DSH',
      kind: 'custom',
      builtin: false,
      storePath: path.resolve(customDshPath),
      enabled: true,
      dshProtected: true,
      allowInitializeWhenMissing: true,
      format: 'dsh-unit',
      health: 'ready',
    })

    const addedAgy = await registry.addCustomClient({
      name: 'Custom AGY',
      storePath: customAgyPath,
    })
    expect(addedAgy).toMatchObject({
      name: 'Custom AGY',
      kind: 'custom',
      builtin: false,
      dshProtected: false,
      allowInitializeWhenMissing: true,
      format: 'agy-flat',
      health: 'ready',
    })

    // Explicit createIfMissing registers without creating the file prematurely
    const addedMissing = await registry.addCustomClient({
      name: 'Planned Store',
      storePath: missingCustomPath,
      createIfMissing: true,
    })
    expect(addedMissing).toMatchObject({
      health: 'missing',
      format: null,
      dshProtected: false,
      allowInitializeWhenMissing: true,
    })
    expect(existsSync(missingCustomPath)).toBe(false)

    // Missing path without createIfMissing is rejected
    await expect(
      registry.addCustomClient({
        name: 'Missing Without Flag',
        storePath: join(root, 'custom', 'does-not-exist', 'memory.json'),
      }),
    ).rejects.toMatchObject({
      name: 'OperationError',
      code: 'MEMORY_NOT_FOUND',
    })

    // Duplicate path with altered casing and relative traversal is rejected as MEMORY_CONFLICT
    const altCasePath = join(
      path.dirname(customDshPath).toUpperCase(),
      '..',
      path.basename(path.dirname(customDshPath)).toLowerCase(),
      'memory.JSON',
    )
    await expect(
      registry.addCustomClient({
        name: 'Duplicate DSH',
        storePath: altCasePath,
      }),
    ).rejects.toMatchObject({
      name: 'OperationError',
      code: 'MEMORY_CONFLICT',
    })

    // Duplicating a built-in store path is also rejected
    const agyDefault = registry.getClient('agy-default')!
    await expect(
      registry.addCustomClient({
        name: 'Duplicate Builtin AGY',
        storePath: agyDefault.storePath.toUpperCase(),
        createIfMissing: true,
      }),
    ).rejects.toMatchObject({
      name: 'OperationError',
      code: 'MEMORY_CONFLICT',
    })
  })

  it('removes custom client without deleting memory.json and forbids removing builtin clients', async () => {
    const root = makeTempDir()
    const homeDir = join(root, 'home')
    const statePath = join(root, 'userData', 'desktop-state.json')
    const customPath = join(root, 'custom', 'memory.json')

    mkdirSync(path.dirname(customPath), { recursive: true })
    writeFileSync(customPath, makeAgyFlatJson(), 'utf8')

    const platform = createWin32PlatformAdapter({
      homeDir,
      runProbe: async () => '[]',
    })
    const registry = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })

    await registry.load()
    await registry.refreshDiscovery()

    const custom = await registry.addCustomClient({
      name: 'Keep File Store',
      storePath: customPath,
    })

    const removed = await registry.removeCustomClient(custom.id)
    expect(removed).toBe(true)
    expect(registry.getClient(custom.id)).toBeUndefined()
    expect(existsSync(customPath)).toBe(true)

    const removedMissing = await registry.removeCustomClient('custom-nonexistent')
    expect(removedMissing).toBe(false)

    await expect(registry.removeCustomClient('dsh-default')).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_FORBIDDEN',
    )
    await expect(registry.removeCustomClient('agy-default')).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_FORBIDDEN',
    )
    expect(registry.getClient('dsh-default')).toBeDefined()
    expect(registry.getClient('agy-default')).toBeDefined()
  })

  it('marks corrupted JSON as health=corrupted with diagnostic detail and forbids disabling DSH builtin protection', async () => {
    const root = makeTempDir()
    const homeDir = join(root, 'home')
    const statePath = join(root, 'userData', 'desktop-state.json')

    const dshDefaultPath = join(homeDir, '.dsh', 'storages', 'memory.json')
    const corruptCustomPath = join(root, 'custom', 'corrupt.json')
    const dirAsStorePath = join(root, 'custom', 'not-a-file')

    mkdirSync(path.dirname(dshDefaultPath), { recursive: true })
    mkdirSync(path.dirname(corruptCustomPath), { recursive: true })
    mkdirSync(dirAsStorePath, { recursive: true })

    writeFileSync(dshDefaultPath, '{ invalid json', 'utf8')
    writeFileSync(corruptCustomPath, JSON.stringify({ hello: 'world' }), 'utf8')

    const platform = createWin32PlatformAdapter({
      homeDir,
      runProbe: async () => '[]',
    })
    const registry = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })

    await registry.load()
    await registry.refreshDiscovery()

    const dshDefault = registry.getClient('dsh-default')!
    expect(dshDefault.health).toBe('corrupted')
    expect(dshDefault.format).toBeNull()
    expect(dshDefault.healthDetail).toBeTruthy()

    const corruptCustom = await registry.addCustomClient({
      name: 'Corrupt Custom',
      storePath: corruptCustomPath,
    })
    expect(corruptCustom.health).toBe('corrupted')
    expect(corruptCustom.format).toBeNull()
    expect(corruptCustom.healthDetail).toContain('unrecognized envelope format')

    const unreadableCustom = await registry.addCustomClient({
      name: 'Dir Path',
      storePath: dirAsStorePath,
    })
    expect(unreadableCustom.health).toBe('unreadable')
    expect(unreadableCustom.format).toBeNull()
    expect(unreadableCustom.healthDetail).toBeTruthy()

    await expect(
      registry.updateClient({ id: 'dsh-default', dshProtected: false }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_FORBIDDEN',
    )
  })

  it('persists preferences, custom clients, and builtin overrides atomically across reloads', async () => {
    const root = makeTempDir()
    const homeDir = join(root, 'home')
    const statePath = join(root, 'userData', 'desktop-state.json')

    const dshDefaultPath = join(homeDir, '.dsh', 'storages', 'memory.json')
    const customPath = join(root, 'custom', 'memory.json')

    mkdirSync(path.dirname(dshDefaultPath), { recursive: true })
    mkdirSync(path.dirname(customPath), { recursive: true })
    writeFileSync(dshDefaultPath, makeDshUnitJson(), 'utf8')
    writeFileSync(customPath, makeAgyFlatJson(), 'utf8')

    const platform = createWin32PlatformAdapter({
      homeDir,
      runProbe: async () => '[]',
    })
    const registry1 = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })

    await registry1.load()
    expect(registry1.getPreferences()).toEqual({ theme: 'system', locale: 'zh' })

    await registry1.refreshDiscovery()
    const custom = await registry1.addCustomClient({
      name: 'My Extra Store',
      storePath: customPath,
    })

    await registry1.updateClient({
      id: 'dsh-default',
      name: 'Primary DSH',
      enabled: false,
    })
    await registry1.updateClient({
      id: custom.id,
      name: 'Renamed Extra',
      dshProtected: true,
    })

    const updatedPrefs = await registry1.updatePreferences({
      theme: 'dark',
      locale: 'en',
      windowBounds: { x: 120, y: 60, width: 1280, height: 800 },
    })
    expect(updatedPrefs).toEqual({
      theme: 'dark',
      locale: 'en',
      windowBounds: { x: 120, y: 60, width: 1280, height: 800 },
    })

    const partialPrefs = await registry1.updatePreferences({ theme: 'light' })
    expect(partialPrefs).toEqual({
      theme: 'light',
      locale: 'en',
      windowBounds: { x: 120, y: 60, width: 1280, height: 800 },
    })

    // Verify file is written with version=1
    const rawState = JSON.parse(readFileSync(statePath, 'utf8')) as {
      version: number
      preferences: unknown
      clients: unknown[]
    }
    expect(rawState.version).toBe(1)

    // Reload from a brand new registry instance
    const registry2 = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock('2026-11-26T01:00:00.000Z'),
    })
    await registry2.load()
    expect(registry2.getPreferences()).toEqual({
      theme: 'light',
      locale: 'en',
      windowBounds: { x: 120, y: 60, width: 1280, height: 800 },
    })

    await registry2.refreshDiscovery()
    const reloadedDsh = registry2.getClient('dsh-default')!
    expect(reloadedDsh.name).toBe('Primary DSH')
    expect(reloadedDsh.enabled).toBe(false)
    expect(reloadedDsh.dshProtected).toBe(true)

    const reloadedCustom = registry2.getClient(custom.id)!
    expect(reloadedCustom.name).toBe('Renamed Extra')
    expect(reloadedCustom.dshProtected).toBe(true)
    expect(reloadedCustom.health).toBe('ready')
  })

  it('updates health from missing to ready on refreshDiscovery and rejects corrupted desktop-state.json', async () => {
    const root = makeTempDir()
    const homeDir = join(root, 'home')
    const statePath = join(root, 'userData', 'desktop-state.json')
    const agyDefaultPath = join(
      homeDir,
      '.gemini',
      'config',
      'plugin-data',
      'memloom',
      'memory.json',
    )

    const platform = createWin32PlatformAdapter({
      homeDir,
      runProbe: async () => '[]',
    })
    const registry = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })

    await registry.load()
    await registry.refreshDiscovery()
    expect(registry.getClient('agy-default')?.health).toBe('missing')

    mkdirSync(path.dirname(agyDefaultPath), { recursive: true })
    writeFileSync(agyDefaultPath, makeAgyFlatJson(), 'utf8')

    await registry.refreshDiscovery()
    const refreshedAgy = registry.getClient('agy-default')!
    expect(refreshedAgy.health).toBe('ready')
    expect(refreshedAgy.format).toBe('agy-flat')

    // Corrupted desktop-state.json should throw MEMORY_UNAVAILABLE on load
    const badStatePath = join(root, 'userData', 'bad-state.json')
    writeFileSync(badStatePath, '{ broken state json', 'utf8')
    const badRegistry = new ClientRegistry({
      statePath: badStatePath,
      platform,
      env: {},
      now: createFixedClock(),
    })
    await expect(badRegistry.load()).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_UNAVAILABLE',
    )

    // Built-in pluginStatus is discovered and persisted through reload
    const agyPluginDir = join(homeDir, '.gemini', 'config', 'plugins', 'memloom')
    mkdirSync(agyPluginDir, { recursive: true })
    writeFileSync(
      join(agyPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'memloom', version: '0.2.1' }),
      'utf8',
    )
    await registry.refreshDiscovery()
    expect(registry.getClient('agy-default')?.pluginStatus).toMatchObject({
      state: 'enabled',
      installed: true,
      version: '0.2.1',
    })

    const reloaded = new ClientRegistry({
      statePath,
      platform,
      env: {},
      now: createFixedClock(),
    })
    await reloaded.load()
    expect(reloaded.getClient('agy-default')?.pluginStatus?.state).toBe('enabled')
    expect(reloaded.getClient('dsh-default')?.pluginStatus?.state).toBe('not-installed')
  })
})
