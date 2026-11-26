import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGY_EDITABLE_CONFIG_FIELDS } from '../../src/core/config.ts'
import { OperationError } from '../../src/core/operations.ts'
import { contentDigest } from '../../src/core/storage-contract.ts'
import { DesktopUnsupportedError, MultiClientService } from '../../src/desktop/multi-service.ts'
import { createWin32PlatformAdapter } from '../../src/desktop/platform/win32.ts'
import { ClientRegistry } from '../../src/desktop/registry.ts'
import { DesktopExternalChangeError } from '../../src/desktop/storage/dsh-domain.ts'
import { DesktopReadonlyGuardError, WriteGuard } from '../../src/desktop/write-guard.ts'
import {
  AuditId,
  DreamId,
  EpisodeId,
  MemoryId,
  OperationId,
  type AuditRecord,
  type DreamRun,
  type EpisodeRecord,
  type MemoryRecord,
  type OperationRecord,
} from '../../src/shared/types.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'memloom-desktop-multi-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function makeRecord(overrides: Omit<Partial<MemoryRecord>, 'id'> & { id: string }): MemoryRecord {
  const { id, ...rest } = overrides
  const base: MemoryRecord = {
    id: MemoryId(id),
    type: rest.type ?? 'lesson',
    scope: rest.scope ?? { kind: 'workspace', key: 'c:/ws/alpha', root: 'C:/ws/alpha' },
    origin: rest.origin ?? 'user',
    ownership: rest.ownership ?? 'user',
    pinned: rest.pinned ?? false,
    title: rest.title ?? `Title ${id}`,
    body: rest.body ?? `Body for ${id}`,
    tags: rest.tags ?? [],
    status: rest.status ?? 'active',
    confidence: rest.confidence ?? 1,
    importance: rest.importance ?? 0.6,
    contentRevision: rest.contentRevision ?? 1,
    statsRevision: rest.statsRevision ?? 0,
    createdAt: rest.createdAt ?? '2026-11-25T00:00:00.000Z',
    updatedAt: rest.updatedAt ?? '2026-11-25T00:00:00.000Z',
    matchCount: rest.matchCount ?? 0,
    useCount: rest.useCount ?? 0,
    sourceRefs: rest.sourceRefs ?? [],
    sourceEpisodeIds: rest.sourceEpisodeIds ?? [],
    supersedes: rest.supersedes ?? [],
    contentHash: rest.contentHash ?? 'placeholder',
  }
  base.contentHash = rest.contentHash ?? contentDigest(base)
  return base
}

function makeEpisode(
  overrides: Omit<Partial<EpisodeRecord>, 'id'> & { id: string },
): EpisodeRecord {
  const { id, ...rest } = overrides
  return {
    id: EpisodeId(id),
    sessionId: rest.sessionId ?? 'sess-1',
    workspaceKey: rest.workspaceKey ?? 'c:/ws/alpha',
    workspaceRoot: rest.workspaceRoot ?? 'C:/ws/alpha',
    kind: rest.kind ?? 'turn',
    status: rest.status ?? 'new',
    attempts: rest.attempts ?? 0,
    turn: rest.turn ?? 1,
    sourceSeqs: rest.sourceSeqs ?? [1],
    files: rest.files ?? [],
    createdAt: rest.createdAt ?? '2026-11-25T00:00:00.000Z',
    ...rest,
  }
}

interface RawTableFixtures {
  memories?: Record<string, MemoryRecord>
  episodes?: Record<string, EpisodeRecord>
  dreams?: Record<string, DreamRun>
  audit?: Record<string, AuditRecord>
  operations?: Record<string, OperationRecord>
}

function writeDshUnitFile(
  filePath: string,
  tables: RawTableFixtures = {},
  extras: { extraUnit?: Record<string, unknown>; global?: unknown } = {},
): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const payload = {
    unit: { name: 'memory', version: 1, ...(extras.extraUnit ?? {}) },
    global: extras.global ?? { schema: 1, preserveMe: 'dsh-global-intact' },
    tables: {
      memories: tables.memories ?? {},
      episodes: tables.episodes ?? {},
      dreams: tables.dreams ?? {},
      audit: tables.audit ?? {},
      operations: tables.operations ?? {},
      session_cursors: {},
    },
  }
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function writeAgyFlatFile(filePath: string, tables: RawTableFixtures = {}): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const payload = {
    name: 'memory',
    version: 1,
    memories: tables.memories ?? {},
    episodes: tables.episodes ?? {},
    dreams: tables.dreams ?? {},
    audit: tables.audit ?? {},
    operations: tables.operations ?? {},
    session_cursors: {},
  }
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
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

function setupHarness(options: { initialRunning: boolean; homeDir?: string }) {
  const root = makeTempDir()
  const homeDir = options.homeDir ?? join(root, 'home')
  const statePath = join(root, 'userData', 'desktop-state.json')
  let dshRunning = options.initialRunning

  const platform = createWin32PlatformAdapter({
    homeDir,
    runProbe: async () =>
      JSON.stringify(
        dshRunning ? [{ Name: 'DeepSeek Harness.exe', ProcessId: 4242, CommandLine: '' }] : [],
      ),
  })
  const clock = createFixedClock()
  const registry = new ClientRegistry({ statePath, platform, env: {}, now: clock })
  const writeGuard = new WriteGuard(platform, clock)
  const service = new MultiClientService({ registry, writeGuard, now: clock })

  return {
    root,
    homeDir,
    statePath,
    service,
    setDshRunning(next: boolean) {
      dshRunning = next
    },
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('MultiClientService integration', () => {
  it('enforces zero-write invariant on DSH stores with unfinished operations while running', async () => {
    const { homeDir, service } = setupHarness({ initialRunning: true })
    const dshPath = join(homeDir, '.dsh', 'storages', 'memory.json')

    const existingMem = makeRecord({
      id: 'mem-dsh-1',
      title: 'DSH ReadOnly Verification',
      body: 'Existing memory preserved in readonly mode',
      updatedAt: '2026-11-25T10:00:00.000Z',
    })
    const pendingOp: OperationRecord = {
      id: OperationId('op-pending-1'),
      kind: 'memory.create',
      status: 'planned',
      step: 0,
      totalSteps: 2,
      stepName: 'plan',
      payload: {
        record: makeRecord({ id: 'mem-unrecovered', title: 'Should not recover in readonly' }),
        actor: 'user',
      },
      attempts: 0,
      createdAt: '2026-11-25T09:00:00.000Z',
      updatedAt: '2026-11-25T09:00:00.000Z',
    }
    const expiredDream: DreamRun = {
      id: DreamId('dream-running-1'),
      trigger: 'auto',
      scopeKey: 'c:/ws/alpha',
      status: 'running',
      startedAt: '2026-11-25T00:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-chat',
      episodes: 1,
      committed: 0,
      pending: 0,
    }
    const auditEntry: AuditRecord = {
      id: AuditId('audit-1'),
      operationId: 'op-seed-1',
      action: 'create',
      memoryId: 'mem-dsh-1',
      actor: 'user',
      before: null,
      after: existingMem,
      status: 'applied',
      at: '2026-11-25T10:00:00.000Z',
    }

    writeDshUnitFile(dshPath, {
      memories: { [existingMem.id]: existingMem },
      operations: { [pendingOp.id]: pendingOp },
      dreams: { [expiredDream.id]: expiredDream },
      audit: { [auditEntry.id]: auditEntry },
    })

    const initialStat = statSync(dshPath)
    const initialSha = sha256File(dshPath)

    await service.initialize()

    const clients = service.listClients()
    const dshClient = clients.find((c) => c.id === 'dsh-default')
    expect(dshClient).toMatchObject({
      writable: false,
      configEditable: false,
      format: 'dsh-unit',
      health: 'ready',
    })
    expect(service.getGuardSnapshot().mode).toBe('readonly-dsh-running')

    const overview = await service.overview('dsh-default', 'all')
    expect(overview.counts.active).toBe(1)

    const listed = await service.list('dsh-default', { workspaceKey: 'all' })
    expect(listed.total).toBe(1)
    expect(listed.items[0]?.id).toBe('mem-dsh-1')

    const viewed = await service.view('dsh-default', 'mem-dsh-1')
    expect(viewed.record.title).toBe('DSH ReadOnly Verification')

    const audits = await service.listAudit('dsh-default')
    expect(audits.total).toBe(1)

    const dreams = await service.listDreams('dsh-default')
    expect(dreams).toHaveLength(1)
    expect(dreams[0]?.status).toBe('running')

    const workspaces = await service.listWorkspaces('dsh-default')
    expect(workspaces.map((w) => w.key)).toEqual(['c:/ws/alpha'])

    const exported = await service.export('dsh-default', { scope: 'all' })
    expect(exported.memories).toHaveLength(1)

    await expect(
      service.create('dsh-default', {
        type: 'lesson',
        title: 'Blocked',
        body: 'Cannot write while DSH runs',
        workspaceKey: 'c:/ws/alpha',
        workspaceRoot: 'C:/ws/alpha',
      }),
    ).rejects.toThrow(DesktopReadonlyGuardError)

    await expect(
      service.update('dsh-default', {
        id: 'mem-dsh-1',
        expectedContentRevision: 1,
        title: 'Blocked update',
      }),
    ).rejects.toThrow(DesktopReadonlyGuardError)

    await expect(service.delete('dsh-default', { id: 'mem-dsh-1' })).rejects.toThrow(
      DesktopReadonlyGuardError,
    )
    await expect(service.restore('dsh-default', 'mem-dsh-1')).rejects.toThrow(
      DesktopReadonlyGuardError,
    )
    await expect(
      service.review('dsh-default', { id: 'mem-dsh-1', action: 'accept' }),
    ).rejects.toThrow(DesktopReadonlyGuardError)
    await expect(service.undoDream('dsh-default', 'dream-running-1')).rejects.toThrow(
      DesktopReadonlyGuardError,
    )
    await expect(service.import('dsh-default', exported)).rejects.toThrow(DesktopReadonlyGuardError)
    await expect(service.rebuild('dsh-default', { scope: 'all', confirm: true })).rejects.toThrow(
      DesktopReadonlyGuardError,
    )
    await expect(
      service.purgeAll('dsh-default', { scope: 'all', confirmText: 'all' }),
    ).rejects.toThrow(DesktopReadonlyGuardError)

    expect(statSync(dshPath).mtimeMs).toBe(initialStat.mtimeMs)
    expect(sha256File(dshPath)).toBe(initialSha)

    await service.closeAll()
  })

  it('unlocks DSH writes, preserves envelope & pre-write backup, and rejects external disk edits', async () => {
    const { homeDir, service, setDshRunning } = setupHarness({ initialRunning: true })
    const dshPath = join(homeDir, '.dsh', 'storages', 'memory.json')

    writeDshUnitFile(
      dshPath,
      {
        memories: {
          'mem-1': makeRecord({ id: 'mem-1', title: 'Initial DSH record', body: 'Initial body' }),
        },
      },
      {
        extraUnit: { customUnitMeta: 'keep-unit' },
        global: { schema: 1, customGlobalMeta: 'keep-global' },
      },
    )

    await service.initialize()

    // forceUnlock requires confirmed=true
    expect(() => service.forceUnlockDsh(false)).toThrow(DesktopReadonlyGuardError)
    expect(service.forceUnlockDsh(true).mode).toBe('force-unlocked')
    expect(service.relockDsh().mode).toBe('readonly-dsh-running')

    // Switch probe to stopped and refresh guard
    setDshRunning(false)
    const snap = await service.refreshDshGuard()
    expect(snap.mode).toBe('writable')

    const created = await service.create('dsh-default', {
      type: 'lesson',
      title: 'Unlocked DSH write',
      body: 'Created after DSH stopped',
      workspaceKey: 'c:/ws/alpha',
      workspaceRoot: 'C:/ws/alpha',
    })
    expect(created.title).toBe('Unlocked DSH write')

    const updated = await service.update('dsh-default', {
      id: created.id,
      expectedContentRevision: created.contentRevision,
      body: 'Updated after DSH stopped',
    })
    expect(updated.contentRevision).toBe(2)

    // Verify outer envelope fidelity and pre-write backup
    const rawOnDisk = JSON.parse(readFileSync(dshPath, 'utf8')) as {
      unit: Record<string, unknown>
      global: Record<string, unknown>
      tables: { memories: Record<string, unknown> }
    }
    expect(rawOnDisk.unit.customUnitMeta).toBe('keep-unit')
    expect(rawOnDisk.global.customGlobalMeta).toBe('keep-global')
    expect(Object.keys(rawOnDisk.tables.memories)).toContain(created.id)

    const backupsDir = join(path.dirname(dshPath), 'backups')
    expect(existsSync(backupsDir)).toBe(true)
    const desktopBackups = readdirSync(backupsDir).filter((f) =>
      f.startsWith('memory-desktop-before-write-'),
    )
    expect(desktopBackups.length).toBeGreaterThanOrEqual(1)

    // Simulate external modification without refreshing
    const modifiedPayload = JSON.parse(readFileSync(dshPath, 'utf8')) as {
      global: Record<string, unknown>
    }
    modifiedPayload.global.externalEdit = true
    writeFileSync(dshPath, `${JSON.stringify(modifiedPayload, null, 2)}\n`, 'utf8')
    const externalSha = sha256File(dshPath)

    await expect(
      service.update('dsh-default', {
        id: created.id,
        expectedContentRevision: updated.contentRevision,
        body: 'Should abort on external change',
      }),
    ).rejects.toThrow(DesktopExternalChangeError)

    expect(sha256File(dshPath)).toBe(externalSha)

    await service.closeAll()
  })

  it('handles AGY config.json read/write with engine hot-update and rejects DSH config edits', async () => {
    const { homeDir, service } = setupHarness({ initialRunning: false })
    const dshPath = join(homeDir, '.dsh', 'storages', 'memory.json')
    const agyPath = join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json')
    const agyConfigPath = join(path.dirname(agyPath), 'config.json')

    writeDshUnitFile(dshPath)
    writeAgyFlatFile(agyPath, {
      memories: {
        'agy-1': makeRecord({ id: 'agy-1', title: 'AGY 1', body: 'First' }),
        'agy-2': makeRecord({ id: 'agy-2', title: 'AGY 2', body: 'Second' }),
      },
    })

    await service.initialize()

    // DSH config is read-only
    const dshConfig = await service.getConfig('dsh-default')
    expect(dshConfig.editable).toBe(false)
    expect(dshConfig.reason).toBeTruthy()
    await expect(service.updateConfig('dsh-default', { searchLimit: 10 })).rejects.toThrow(
      DesktopUnsupportedError,
    )
    try {
      await service.updateConfig('dsh-default', { searchLimit: 10 })
    } catch (err) {
      expect((err as { code?: string }).code).toBe('desktop/unsupported')
    }

    // Custom dsh-unit store config is also read-only
    const customDshPath = join(path.dirname(dshPath), '..', 'custom-dsh', 'memory.json')
    writeDshUnitFile(customDshPath)
    const customDshClient = await service.addCustomClient({
      name: 'Custom DSH Store',
      storePath: customDshPath,
    })
    expect(customDshClient.configEditable).toBe(false)
    expect((await service.getConfig(customDshClient.id)).editable).toBe(false)
    await expect(service.updateConfig(customDshClient.id, { searchLimit: 5 })).rejects.toThrow(
      DesktopUnsupportedError,
    )

    // AGY config is editable (only AGY_EDITABLE_CONFIG_FIELDS)
    const initialAgyConfig = await service.getConfig('agy-default')
    expect(initialAgyConfig.editable).toBe(true)
    expect(initialAgyConfig.editableFields).toEqual(AGY_EDITABLE_CONFIG_FIELDS)
    expect(initialAgyConfig.config?.searchLimit).toBe(20)

    // Disallow DSH-only or capacity fields
    await expect(service.updateConfig('agy-default', { dreamProvider: 'openai' })).rejects.toThrow(
      OperationError,
    )
    await expect(service.updateConfig('agy-default', { maxActiveMemories: 999 })).rejects.toThrow(
      OperationError,
    )

    // Warm up AGY engine cache before updating config
    const beforeList = await service.list('agy-default', { workspaceKey: 'all' })
    expect(beforeList.items).toHaveLength(2)

    const updatedConfig = await service.updateConfig('agy-default', {
      searchLimit: 1,
      redactSecrets: false,
    })
    expect(updatedConfig.editable).toBe(true)
    expect(updatedConfig.config?.searchLimit).toBe(1)
    expect(updatedConfig.config?.redactSecrets).toBe(false)
    expect(existsSync(agyConfigPath)).toBe(true)

    // Hot-applied to cached engine: default list limit is now 1
    const afterList = await service.list('agy-default', { workspaceKey: 'all' })
    expect(afterList.items).toHaveLength(1)
    expect(afterList.total).toBe(2)

    await service.closeAll()
  })

  it('aggregates search across healthy clients by normalizedScore and skips corrupted/missing stores', async () => {
    const { root, homeDir, service } = setupHarness({ initialRunning: true })
    const dshPath = join(homeDir, '.dsh', 'storages', 'memory.json')
    const agyPath = join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json')
    const corruptPath = join(root, 'custom', 'corrupt-memory.json')
    const missingPath = join(root, 'custom', 'missing-memory.json')

    writeDshUnitFile(dshPath, {
      memories: {
        'dsh-hit': makeRecord({
          id: 'dsh-hit',
          title: 'Vitest SQLite Locking Guide',
          body: 'Vitest SQLite locking guidance for DSH workflows',
          status: 'pending',
          updatedAt: '2026-11-25T12:00:00.000Z',
        }),
        'dsh-other': makeRecord({
          id: 'dsh-other',
          title: 'Unrelated DSH note',
          body: 'Nothing about tests here',
          status: 'active',
          updatedAt: '2026-11-25T08:00:00.000Z',
        }),
      },
    })

    writeAgyFlatFile(agyPath, {
      memories: {
        'agy-hit': makeRecord({
          id: 'agy-hit',
          title: 'Vitest Configuration Tip',
          body: 'Use vitest temp dirs cleanly',
          status: 'archived',
          updatedAt: '2026-11-25T14:00:00.000Z',
        }),
      },
    })

    mkdirSync(path.dirname(corruptPath), { recursive: true })
    writeFileSync(corruptPath, '{not valid json!!!', 'utf8')

    await service.initialize()
    const corruptClient = await service.addCustomClient({
      name: 'Broken Store',
      storePath: corruptPath,
    })
    const missingClient = await service.addCustomClient({
      name: 'Absent Store',
      storePath: missingPath,
      createIfMissing: true,
    })
    expect(corruptClient.health).toBe('corrupted')
    expect(missingClient.health).toBe('missing')

    // Keyword aggregate search across all clients (including pending & archived)
    const searchRes = await service.aggregateSearch({
      query: 'vitest',
      workspaceKey: 'all',
      limit: 1,
      offset: 0,
    })
    expect(searchRes.total).toBe(2)
    expect(searchRes.items).toHaveLength(1)
    expect(searchRes.truncated).toBe(true)
    expect(searchRes.items[0]?.normalizedScore).toBeGreaterThan(0)
    expect(searchRes.items[0]?.normalizedScore).toBeLessThanOrEqual(1)
    expect(searchRes.skippedClients.map((s) => s.id).sort()).toEqual(
      [corruptClient.id, missingClient.id].sort(),
    )

    // Page 2
    const page2 = await service.aggregateSearch({
      query: 'vitest',
      workspaceKey: 'all',
      limit: 1,
      offset: 1,
    })
    expect(page2.items).toHaveLength(1)
    expect(page2.truncated).toBe(false)
    const returnedClientIds = new Set([searchRes.items[0]?.clientId, page2.items[0]?.clientId])
    expect(returnedClientIds).toEqual(new Set(['dsh-default', 'agy-default']))

    // Check writable metadata in items
    const dshItem = [searchRes.items[0], page2.items[0]].find((i) => i?.clientId === 'dsh-default')
    const agyItem = [searchRes.items[0], page2.items[0]].find((i) => i?.clientId === 'agy-default')
    expect(dshItem?.writable).toBe(false)
    expect(agyItem?.writable).toBe(true)

    // Empty query sorts by updatedAt descending across healthy stores
    const browseRes = await service.aggregateSearch({ workspaceKey: 'all', limit: 10 })
    expect(browseRes.items.map((i) => i.record.id)).toEqual(['agy-hit', 'dsh-hit', 'dsh-other'])

    await service.closeAll()
  })

  it('migrates directly between clients with read-only source export and strict replace guards', async () => {
    const { homeDir, service, setDshRunning } = setupHarness({ initialRunning: true })
    const dshPath = join(homeDir, '.dsh', 'storages', 'memory.json')
    const agyPath = join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json')
    const agyConfigPath = join(path.dirname(agyPath), 'config.json')

    const dshActive = makeRecord({
      id: 'dsh-m1',
      title: 'DSH Lesson Alpha',
      body: 'Alpha body',
      scope: { kind: 'workspace', key: 'c:/ws/alpha', root: 'C:/ws/alpha' },
      status: 'active',
    })
    const dshArchived = makeRecord({
      id: 'dsh-m2',
      title: 'DSH Archived Beta',
      body: 'Beta archived body',
      scope: { kind: 'workspace', key: 'c:/ws/beta', root: 'C:/ws/beta' },
      status: 'archived',
    })
    const dshEp = makeEpisode({
      id: 'dsh-ep1',
      workspaceKey: 'c:/ws/alpha',
      workspaceRoot: 'C:/ws/alpha',
    })

    writeDshUnitFile(dshPath, {
      memories: { [dshActive.id]: dshActive, [dshArchived.id]: dshArchived },
      episodes: { [dshEp.id]: dshEp },
    })

    const agyTargetOld = makeRecord({
      id: 'agy-old-1',
      title: 'Old AGY Target',
      body: 'Should remain untouched by merge',
      scope: { kind: 'workspace', key: 'c:/ws/target', root: 'C:/ws/target' },
    })
    writeAgyFlatFile(agyPath, {
      memories: { [agyTargetOld.id]: agyTargetOld },
    })
    mkdirSync(path.dirname(agyConfigPath), { recursive: true })
    writeFileSync(agyConfigPath, JSON.stringify({ archivePurgePolicy: 'after-export' }), 'utf8')

    // Separate custom agy-flat store for replace tests (avoids id conflict with earlier merge into agy-default)
    const replaceTargetPath = join(path.dirname(agyPath), '..', 'replace-target', 'memory.json')
    const replaceOldTarget = makeRecord({
      id: 'rep-old-1',
      title: 'Old Replace Target',
      body: 'Should be replaced when replace succeeds',
      scope: { kind: 'workspace', key: 'c:/ws/target', root: 'C:/ws/target' },
    })
    const replaceKeepOther = makeRecord({
      id: 'rep-keep-1',
      title: 'Keep Other Scope',
      body: 'Outside replace targetScope so it must survive',
      scope: { kind: 'workspace', key: 'c:/ws/keep', root: 'C:/ws/keep' },
    })
    writeAgyFlatFile(replaceTargetPath, {
      memories: {
        [replaceOldTarget.id]: replaceOldTarget,
        [replaceKeepOther.id]: replaceKeepOther,
      },
    })

    await service.initialize()
    const replaceTargetClient = await service.addCustomClient({
      name: 'Replace Target',
      storePath: replaceTargetPath,
    })

    const dshInitialSha = sha256File(dshPath)

    // 0. Same source & target is rejected
    await expect(
      service.executeMigration({
        sourceClientId: 'dsh-default',
        targetClientId: 'dsh-default',
        selection: { kind: 'scope', scope: 'all' },
        mode: 'merge',
        mapping: {},
      }),
    ).rejects.toThrow(OperationError)

    // 1. Preview scope migration
    const scopePreview = await service.previewMigration({
      sourceClientId: 'dsh-default',
      targetClientId: 'agy-default',
      selection: { kind: 'scope', scope: 'all', includeArchived: true, includeEpisodes: true },
    })
    expect(scopePreview.allowReplace).toBe(true)
    expect(scopePreview.targetWritable).toBe(true)
    expect(scopePreview.memoryCount).toBe(2)
    expect(scopePreview.episodeCount).toBe(1)
    expect(scopePreview.sourceWorkspaces.map((w) => w.key).sort()).toEqual([
      'c:/ws/alpha',
      'c:/ws/beta',
    ])
    expect(scopePreview.suggestedMapping['c:/ws/alpha']).toEqual({
      key: 'c:/ws/alpha',
      root: 'C:/ws/alpha',
    })

    // 2. Scope merge DSH -> AGY; source DSH remains untouched (archived still present, sha identical)
    const mergeReport = await service.executeMigration({
      sourceClientId: 'dsh-default',
      targetClientId: 'agy-default',
      selection: { kind: 'scope', scope: 'all', includeArchived: true, includeEpisodes: true },
      mode: 'merge',
      mapping: scopePreview.suggestedMapping,
    })
    expect(mergeReport.created).toBe(2)
    expect(mergeReport.episodesImported).toBe(1)
    expect(sha256File(dshPath)).toBe(dshInitialSha)

    // 3. Record selection locks allowReplace=false and rejects mode='replace'
    const recordPreview = await service.previewMigration({
      sourceClientId: 'dsh-default',
      targetClientId: replaceTargetClient.id,
      selection: { kind: 'records', memoryIds: ['dsh-m1'] },
    })
    expect(recordPreview.allowReplace).toBe(false)
    expect(recordPreview.memoryCount).toBe(1)

    const targetShaBeforeBlockedReplace = sha256File(replaceTargetPath)
    await expect(
      service.executeMigration({
        sourceClientId: 'dsh-default',
        targetClientId: replaceTargetClient.id,
        selection: { kind: 'records', memoryIds: ['dsh-m1'] },
        mode: 'replace',
        mapping: { 'c:/ws/alpha': { key: 'c:/ws/target', root: 'C:/ws/target' } },
        targetScope: { workspaceKey: 'c:/ws/target' },
        confirm: true,
      }),
    ).rejects.toThrow(OperationError)
    expect(sha256File(replaceTargetPath)).toBe(targetShaBeforeBlockedReplace)

    // 4. Replace mode safety gates: unmapped workspace, missing confirm, out-of-scope mapping
    await expect(
      service.executeMigration({
        sourceClientId: 'dsh-default',
        targetClientId: replaceTargetClient.id,
        selection: { kind: 'scope', scope: 'all', includeArchived: true },
        mode: 'replace',
        mapping: { 'c:/ws/alpha': { key: 'c:/ws/target', root: 'C:/ws/target' } }, // missing beta
        targetScope: { workspaceKey: 'c:/ws/target' },
        confirm: true,
      }),
    ).rejects.toThrow(OperationError)

    await expect(
      service.executeMigration({
        sourceClientId: 'dsh-default',
        targetClientId: replaceTargetClient.id,
        selection: { kind: 'scope', scope: 'all', includeArchived: true },
        mode: 'replace',
        mapping: {
          'c:/ws/alpha': { key: 'c:/ws/target', root: 'C:/ws/target' },
          'c:/ws/beta': { key: 'c:/ws/target', root: 'C:/ws/target' },
        },
        targetScope: { workspaceKey: 'c:/ws/target' },
        confirm: false,
      }),
    ).rejects.toThrow(OperationError)

    await expect(
      service.executeMigration({
        sourceClientId: 'dsh-default',
        targetClientId: replaceTargetClient.id,
        selection: { kind: 'scope', scope: 'all', includeArchived: true },
        mode: 'replace',
        mapping: {
          'c:/ws/alpha': { key: 'c:/ws/target', root: 'C:/ws/target' },
          'c:/ws/beta': { key: 'c:/ws/other', root: 'C:/ws/other' }, // outside targetScope
        },
        targetScope: { workspaceKey: 'c:/ws/target' },
        confirm: true,
      }),
    ).rejects.toThrow(OperationError)
    expect(sha256File(replaceTargetPath)).toBe(targetShaBeforeBlockedReplace)

    // 5. Valid replace succeeds, keeps outside scope intact, and writes import audit on target
    const replaceReport = await service.executeMigration({
      sourceClientId: 'dsh-default',
      targetClientId: replaceTargetClient.id,
      selection: { kind: 'scope', scope: 'all', includeArchived: true, includeEpisodes: false },
      mode: 'replace',
      mapping: {
        'c:/ws/alpha': { key: 'c:/ws/target', root: 'C:/ws/target' },
        'c:/ws/beta': { key: 'c:/ws/target', root: 'C:/ws/target' },
      },
      targetScope: { workspaceKey: 'c:/ws/target' },
      confirm: true,
    })
    expect(replaceReport.replaced).toBe(1) // rep-old-1 replaced
    expect(replaceReport.created).toBe(2)
    expect(replaceReport.unmapped).toEqual([])

    const targetScopeList = await service.list(replaceTargetClient.id, {
      workspaceKey: 'c:/ws/target',
    })
    expect(targetScopeList.items.map((r) => r.id).sort()).toEqual(['dsh-m1', 'dsh-m2'])
    const keepScopeList = await service.list(replaceTargetClient.id, {
      workspaceKey: 'c:/ws/keep',
    })
    expect(keepScopeList.items.map((r) => r.id)).toEqual(['rep-keep-1'])
    const targetAudits = await service.listAudit(replaceTargetClient.id)
    expect(targetAudits.items.some((a) => a.action === 'import')).toBe(true)

    // 6. Migration into readonly-dsh-running DSH target is rejected
    await expect(
      service.executeMigration({
        sourceClientId: 'agy-default',
        targetClientId: 'dsh-default',
        selection: { kind: 'records', memoryIds: ['agy-old-1'] },
        mode: 'merge',
        mapping: { 'c:/ws/target': { key: 'c:/ws/target', root: 'C:/ws/target' } },
      }),
    ).rejects.toThrow(DesktopReadonlyGuardError)
    expect(sha256File(dshPath)).toBe(dshInitialSha)

    // When DSH becomes writable, record merge of agy-old-1 succeeds
    setDshRunning(false)
    await service.refreshDshGuard()
    const dshMergeReport = await service.executeMigration({
      sourceClientId: 'agy-default',
      targetClientId: 'dsh-default',
      selection: { kind: 'records', memoryIds: ['agy-old-1'] },
      mode: 'merge',
      mapping: { 'c:/ws/target': { key: 'c:/ws/new-dest', root: 'C:/ws/new-dest' } },
    })
    expect(dshMergeReport.created).toBe(1)

    await service.closeAll()
  })

  it('supports delete, restore, review, rebuild, purgeAll, preferences, and corrupt store errors', async () => {
    const { root, homeDir, service } = setupHarness({ initialRunning: false })
    const agyPath = join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json')
    const corruptPath = join(root, 'custom', 'bad.json')

    const pendingMem = makeRecord({
      id: 'mem-pending-1',
      title: 'Pending proposal',
      body: 'Needs user review',
      status: 'pending',
      ownership: 'derived',
      origin: 'dream',
      sourceEpisodeIds: ['ep-1'],
    })
    writeAgyFlatFile(agyPath, {
      memories: { [pendingMem.id]: pendingMem },
    })
    mkdirSync(path.dirname(corruptPath), { recursive: true })
    writeFileSync(corruptPath, '{"unit": "broken"}', 'utf8')

    await service.initialize()

    // Review accept -> soft delete -> restore -> rebuild -> purgeAll
    const accepted = await service.review('agy-default', {
      id: 'mem-pending-1',
      action: 'accept',
    })
    expect(accepted.status).toBe('active')

    const archived = await service.delete('agy-default', { id: 'mem-pending-1' })
    expect(archived.deleted).toBe(false)
    expect((await service.view('agy-default', 'mem-pending-1')).record.status).toBe('archived')

    const restored = await service.restore('agy-default', 'mem-pending-1')
    expect(restored.status).toBe('active')

    const rebuildReport = await service.rebuild('agy-default', { scope: 'all', confirm: true })
    expect(rebuildReport.retainedUser).toBe(1)

    const purgeReport = await service.purgeAll('agy-default', {
      scope: 'all',
      confirmText: 'PURGE all',
    })
    expect(purgeReport.deleted).toBe(1)

    // Preferences & custom client lifecycle
    const prefs = await service.updatePreferences({ theme: 'dark', locale: 'en' })
    expect(prefs.theme).toBe('dark')
    expect(service.getPreferences().locale).toBe('en')

    const badClient = await service.addCustomClient({ name: 'Bad', storePath: corruptPath })
    await expect(service.overview(badClient.id)).rejects.toMatchObject({
      code: 'desktop/store-corrupt',
    })
    const renamed = await service.updateClient({ id: badClient.id, name: 'Bad Renamed' })
    expect(renamed.name).toBe('Bad Renamed')
    expect(await service.removeCustomClient(badClient.id)).toBe(true)

    await service.refreshAll()
    await service.closeAll()
  })

  it('defaults MultiClientService.list to workspaceKey="all" when omitted', async () => {
    const { homeDir, service } = setupHarness({ initialRunning: false })
    const agyPath = join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom', 'memory.json')
    const wsPending = makeRecord({
      id: 'ws-pending-1',
      title: 'Workspace Pending Proposal',
      body: 'Stored in workspace scope',
      status: 'pending',
      ownership: 'derived',
      origin: 'dream',
      sourceEpisodeIds: ['ep-1'],
      scope: { kind: 'workspace', key: 'c:/ws/demo', root: 'C:/ws/demo' },
    })
    writeAgyFlatFile(agyPath, {
      memories: { [wsPending.id]: wsPending },
    })

    await service.initialize()

    const listed = await service.list('agy-default', { status: 'pending' })
    expect(listed.total).toBe(1)
    expect(listed.items.map((r) => r.id)).toEqual(['ws-pending-1'])
    await service.closeAll()
  })
})
