import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyConfigStore } from '../../src/agy/config-store.ts'
import { resolveAgyDataPaths } from '../../src/agy/paths.ts'
import { AgySessionStateStore } from '../../src/agy/session-state.ts'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import { OperationError } from '../../src/core/operations.ts'
import { contentDigest } from '../../src/core/storage-contract.ts'
import {
  EpisodeId,
  MemoryId,
  type EpisodeRecord,
  type MemoryRecord,
} from '../../src/shared/types.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-memory-agy-storage-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeMemoryRecord(id: string, title = 'Prefer pnpm'): MemoryRecord {
  const base: Omit<MemoryRecord, 'contentHash'> = {
    id: MemoryId(id),
    type: 'preference',
    scope: { kind: 'global' },
    origin: 'user',
    ownership: 'user',
    pinned: false,
    title,
    body: 'Always use pnpm in this workspace.',
    tags: ['tooling'],
    status: 'active',
    confidence: 0.9,
    importance: 0.8,
    contentRevision: 1,
    statsRevision: 0,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    matchCount: 0,
    useCount: 0,
    sourceRefs: [],
    sourceEpisodeIds: [],
    supersedes: [],
  }
  return {
    ...base,
    contentHash: contentDigest(base as MemoryRecord),
  }
}

function makeEpisodeRecord(id: string): EpisodeRecord {
  return {
    id: EpisodeId(id),
    sessionId: 'sess-1',
    workspaceKey: 'c:/ws/demo',
    workspaceRoot: 'C:/ws/demo',
    kind: 'turn',
    status: 'new',
    attempts: 0,
    turn: 1,
    sourceSeqs: [1, 2],
    prompt: 'Run tests',
    assistantFinal: 'Done',
    files: [],
    outcome: 'completed',
    createdAt: '2026-11-24T00:00:00.000Z',
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveAgyDataPaths', () => {
  it('resolves paths strictly by priority DSH_MEMORY_STORE_PATH > DSH_MEMORY_DATA_DIR > PLUGIN_DATA > homedir fallback', () => {
    const base = makeTempDir('agy-paths-')
    const storeFile = join(base, 'override', 'custom.json')
    const dataDir = join(base, 'data-dir')
    const pluginData = join(base, 'plugin-data')

    const p1 = resolveAgyDataPaths({
      DSH_MEMORY_STORE_PATH: `  ${storeFile}  `,
      DSH_MEMORY_DATA_DIR: dataDir,
      PLUGIN_DATA: pluginData,
    })
    expect(p1.storePath).toBe(storeFile)
    expect(p1.dataDir).toBe(join(base, 'override'))
    expect(p1.lockPath).toBe(join(base, 'override', '.memory.lock'))
    expect(p1.configPath).toBe(join(base, 'override', 'config.json'))
    expect(p1.sessionsDir).toBe(join(base, 'override', 'sessions'))
    expect(p1.backupsDir).toBe(join(base, 'override', 'backups'))
    expect(p1.logPath).toBe(join(base, 'override', 'logs', 'hook-errors.log'))

    const p2 = resolveAgyDataPaths({
      DSH_MEMORY_STORE_PATH: '   ',
      DSH_MEMORY_DATA_DIR: dataDir,
      PLUGIN_DATA: pluginData,
    })
    expect(p2.dataDir).toBe(dataDir)
    expect(p2.storePath).toBe(join(dataDir, 'memory.json'))

    const p3 = resolveAgyDataPaths({
      DSH_MEMORY_DATA_DIR: '',
      PLUGIN_DATA: pluginData,
    })
    expect(p3.dataDir).toBe(pluginData)
    expect(p3.storePath).toBe(join(pluginData, 'memory.json'))

    const p4 = resolveAgyDataPaths({})
    expect(p4.dataDir).toMatch(/\.gemini[/\\]config[/\\]plugin-data[/\\]dsh-memory$/)
    expect(p4.storePath).toBe(join(p4.dataDir, 'memory.json'))
  })
})

describe('FileMemoryDomain corruption tiers and locking', () => {
  it('refuses overwrite and throws MEMORY_UNAVAILABLE on invalid overall JSON', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const raw = '{ not valid json'
    writeFileSync(storePath, raw, 'utf8')

    await expect(FileMemoryDomain.open({ storePath })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'MEMORY_UNAVAILABLE',
    })
    expect(readFileSync(storePath, 'utf8')).toBe(raw)
  })

  it('backs up raw file and throws MEMORY_UNAVAILABLE if any record in memories is invalid', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const backupsDir = join(dir, 'backups')
    const valid = makeMemoryRecord('mem-ok')
    const payload = {
      name: 'memory',
      version: 1,
      memories: {
        'mem-ok': valid,
        'mem-bad': { id: 'mem-bad', title: '' },
      },
      episodes: {},
      dreams: {},
      audit: {},
      operations: {},
      session_cursors: {},
    }
    const raw = JSON.stringify(payload, null, 2)
    writeFileSync(storePath, raw, 'utf8')

    let caught: unknown
    try {
      await FileMemoryDomain.open({ storePath, backupsDir })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(OperationError)
    expect((caught as OperationError).code).toBe('MEMORY_UNAVAILABLE')
    expect((caught as OperationError).message).toContain('mem-bad')
    expect(readFileSync(storePath, 'utf8')).toBe(raw)

    const backups = readdirSync(backupsDir)
    expect(backups.length).toBe(1)
    expect(readFileSync(join(backupsDir, backups[0]!), 'utf8')).toBe(raw)
  })

  it('backs up raw file and isolates invalid entries in derived tables while loading valid ones', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const backupsDir = join(dir, 'backups')
    const mem = makeMemoryRecord('mem-1')
    const epValid = makeEpisodeRecord('ep-ok')
    const raw = JSON.stringify({
      name: 'memory',
      version: 1,
      memories: { 'mem-1': mem },
      episodes: {
        'ep-ok': epValid,
        'ep-bad': { id: 'ep-bad', status: 'invalid-status' },
      },
      dreams: {},
      audit: {},
      operations: {},
      session_cursors: {},
    })
    writeFileSync(storePath, raw, 'utf8')

    const onWarn = vi.fn()
    const domain = await FileMemoryDomain.open({ storePath, backupsDir, onWarn })
    expect(domain.table('memories').size).toBe(1)
    expect(domain.table('episodes').size).toBe(1)
    expect(domain.table('episodes').get(EpisodeId('ep-ok'))?.prompt).toBe('Run tests')
    expect(domain.table('episodes').get(EpisodeId('ep-bad'))).toBeUndefined()
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('episodes')
    expect(onWarn.mock.calls[0]?.[0]).toContain('ep-bad')

    const backups = readdirSync(backupsDir)
    expect(backups.length).toBe(1)
    expect(readFileSync(join(backupsDir, backups[0]!), 'utf8')).toBe(raw)
  })

  it('takes over stale .memory.lock when age > staleLockMs and holding PID does not exist', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const lockPath = join(dir, '.memory.lock')
    const nowMs = Date.parse('2026-11-25T00:00:00.000Z')
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, hostname: 'other-host', createdAtMs: nowMs - 31_000 }),
      'utf8',
    )

    const domain = await FileMemoryDomain.open({
      storePath,
      lockPath,
      staleLockMs: 30_000,
      lockTimeoutMs: 500,
      now: () => new Date(nowMs),
    })

    const rec = makeMemoryRecord('mem-stale-takeover')
    await domain.table('memories').put(rec.id, rec)

    const reopened = await FileMemoryDomain.open({ storePath, lockPath })
    expect(reopened.table('memories').get(rec.id)?.title).toBe('Prefer pnpm')
  })

  it('forces takeover when lock age exceeds staleLockMs * 4 even if PID is alive', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const lockPath = join(dir, '.memory.lock')
    const nowMs = Date.parse('2026-11-25T00:00:00.000Z')
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAtMs: nowMs - 120_001 }),
      'utf8',
    )

    const domain = await FileMemoryDomain.open({
      storePath,
      lockPath,
      staleLockMs: 30_000,
      lockTimeoutMs: 500,
      now: () => new Date(nowMs),
    })

    const rec = makeMemoryRecord('mem-hard-takeover')
    await domain.table('memories').put(rec.id, rec)
    expect(domain.table('memories').get(rec.id)?.id).toBe(rec.id)
  })

  it('detects same-size same-mtime external writes inside withWriteLock via SHA-256 and rolls back failed transactions', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const onReload = vi.fn()
    const domain = await FileMemoryDomain.open({ storePath, onReload })
    await domain.table('memories').put(MemoryId('m1'), makeMemoryRecord('m1', 'AAAA'))

    const stat = statSync(storePath)
    const originalBytes = readFileSync(storePath, 'utf8')
    const modifiedBytes = originalBytes.replace('AAAA', 'BBBB')
    expect(Buffer.byteLength(modifiedBytes)).toBe(Buffer.byteLength(originalBytes))
    writeFileSync(storePath, modifiedBytes, 'utf8')
    utimesSync(storePath, stat.atime, stat.mtime)

    await domain.withWriteLock(async () => {
      expect(domain.table('memories').get(MemoryId('m1'))?.title).toBe('BBBB')
      await domain.table('memories').put(MemoryId('m2'), makeMemoryRecord('m2', 'Temp'))
    })
    expect(onReload).toHaveBeenCalledTimes(1)

    await expect(
      domain.withWriteLock(async () => {
        await domain.table('memories').delete(MemoryId('m1'))
        throw new Error('abort-tx')
      }),
    ).rejects.toThrow('abort-tx')
    expect(domain.table('memories').get(MemoryId('m1'))?.title).toBe('BBBB')
  })

  it('throws OperationError(MEMORY_UNAVAILABLE) when a fresh active lock exceeds lockTimeoutMs', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const lockPath = join(dir, '.memory.lock')
    const nowMs = Date.parse('2026-11-25T00:00:00.000Z')
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: 'local', createdAtMs: nowMs }),
      'utf8',
    )

    const domain = await FileMemoryDomain.open({
      storePath,
      lockPath,
      lockTimeoutMs: 150,
      staleLockMs: 30_000,
      now: () => new Date(nowMs),
    })

    await expect(
      domain.withWriteLock(async () => {
        await domain.table('memories').put(MemoryId('m1'), makeMemoryRecord('m1'))
      }),
    ).rejects.toMatchObject({
      name: 'OperationError',
      code: 'MEMORY_UNAVAILABLE',
    })
  })

  it('coalesces multiple mutations inside withWriteLock into one atomic write and auto-wraps standalone writes', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const onReload = vi.fn()
    const domain = await FileMemoryDomain.open({ storePath, onReload })

    await domain.withWriteLock(async () => {
      await domain.table('memories').put(MemoryId('m1'), makeMemoryRecord('m1', 'First'))
      await domain.table('memories').put(MemoryId('m2'), makeMemoryRecord('m2', 'Second'))
      expect(readFileSyncOrNull(storePath)).toBeNull()
    })

    const diskAfterBatch = JSON.parse(readFileSync(storePath, 'utf8')) as {
      memories: Record<string, MemoryRecord>
    }
    expect(Object.keys(diskAfterBatch.memories).sort()).toEqual(['m1', 'm2'])

    await domain.table('memories').update(MemoryId('m1'), (cur) => ({ ...cur, title: 'Updated' }))
    const diskAfterUpdate = JSON.parse(readFileSync(storePath, 'utf8')) as {
      memories: Record<string, MemoryRecord>
    }
    expect(diskAfterUpdate.memories['m1']?.title).toBe('Updated')
  })
})

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

describe('AgyConfigStore', () => {
  it('rejects unknown fields, persists valid patches atomically, and detects disk changes via syncIfChanged', async () => {
    const dir = makeTempDir('agy-config-')
    const configPath = join(dir, 'config.json')
    const store1 = new AgyConfigStore(configPath)
    const store2 = new AgyConfigStore(configPath)

    const initial = await store1.load()
    expect(initial.indexMaxBytes).toBe(4096)
    await expect(store1.savePatch({ unknownField: true } as never)).rejects.toMatchObject({
      name: 'OperationError',
      code: 'MEMORY_INVALID_CONFIG',
    })

    const saved = await store1.savePatch({ indexMaxBytes: 2048, redactSecrets: false })
    expect(saved.indexMaxBytes).toBe(2048)
    expect(saved.redactSecrets).toBe(false)

    const sync1 = await store2.syncIfChanged()
    expect(sync1.changed).toBe(true)
    expect(sync1.config.indexMaxBytes).toBe(2048)

    const sync2 = await store2.syncIfChanged()
    expect(sync2.changed).toBe(false)
  })
})

describe('AgySessionStateStore', () => {
  it('reads/writes session state, resolves strictly single recent workspace, and prunes only expired sessions', async () => {
    const dir = makeTempDir('agy-sessions-')
    const sessionsDir = join(dir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const store = new AgySessionStateStore(sessionsDir)
    const now = new Date('2026-11-25T12:00:00.000Z')

    await store.write({
      conversationId: 'conv-fresh-1',
      workspaceRoot: 'C:/ws/demo',
      scopeKey: 'c:/ws/demo',
      indexSources: [],
      captureTurn: 2,
      previousAssistantText: 'Done',
      updatedAt: '2026-11-25T10:00:00.000Z',
    })
    await store.write({
      conversationId: 'conv-old',
      workspaceRoot: 'C:/ws/legacy',
      scopeKey: 'c:/ws/legacy',
      indexSources: [],
      captureTurn: 1,
      updatedAt: '2026-10-20T00:00:00.000Z',
    })

    const readBack = await store.read('conv-fresh-1')
    expect(readBack?.captureTurn).toBe(2)
    expect(readBack?.previousAssistantText).toBe('Done')

    // Only 1 recent session within 24h -> returns it
    const single = await store.findRecentSingleWorkspace(24 * 60 * 60 * 1000, now)
    expect(single).toEqual({ conversationId: 'conv-fresh-1', workspaceRoot: 'C:/ws/demo' })

    // Add a second distinct recent workspace -> ambiguous -> returns undefined
    await store.write({
      conversationId: 'conv-fresh-2',
      workspaceRoot: 'C:/ws/other',
      scopeKey: 'c:/ws/other',
      indexSources: [],
      captureTurn: 1,
      updatedAt: '2026-11-25T11:00:00.000Z',
    })
    expect(await store.findRecentSingleWorkspace(24 * 60 * 60 * 1000, now)).toBeUndefined()

    // Prune older than 30 days -> removes only conv-old
    const pruned = await store.pruneExpired(30, now)
    expect(pruned).toBe(1)
    expect(await store.read('conv-old')).toBeUndefined()
    expect(await store.read('conv-fresh-1')).toBeDefined()
    expect(await store.read('conv-fresh-2')).toBeDefined()
  })
})
