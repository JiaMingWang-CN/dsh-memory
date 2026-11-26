import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationError } from '../../src/core/operations.ts'
import { contentDigest } from '../../src/core/storage-contract.ts'
import {
  DSH_DESKTOP_BACKUP_LIMIT,
  DSH_DESKTOP_BACKUP_PREFIX,
  DesktopExternalChangeError,
  DshFileDomain,
} from '../../src/desktop/storage/dsh-domain.ts'
import {
  detectEnvelopeFormat,
  parseStoreEnvelope,
  serializeStoreEnvelope,
} from '../../src/desktop/storage/envelope.ts'
import { openDesktopStore } from '../../src/desktop/storage/open-store.ts'
import { AuditId, MemoryId, type AuditRecord, type MemoryRecord } from '../../src/shared/types.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'memloom-desktop-storage-'): string {
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
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
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

function makeAuditRecord(id: string, memoryId: string): AuditRecord {
  return {
    id: AuditId(id),
    operationId: `op-${id}`,
    action: 'create',
    memoryId,
    actor: 'user',
    status: 'applied',
    at: '2026-11-25T00:00:00.000Z',
  }
}

function makeDshEnvelopeJson(
  memories: Record<string, unknown> = {},
  options: {
    global?: unknown
    unit?: Record<string, unknown>
    audit?: Record<string, unknown>
  } = {},
): string {
  return JSON.stringify(
    {
      unit: options.unit ?? { name: 'memory', version: 1 },
      global: 'global' in options ? options.global : null,
      tables: {
        memories,
        episodes: {},
        dreams: {},
        audit: options.audit ?? {},
        operations: {},
        session_cursors: {},
      },
    },
    null,
    2,
  )
}

function makeAgyEnvelopeJson(memories: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: 'memory',
      version: 1,
      memories,
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('envelope detection, parsing, and lossless round-trip serialization', () => {
  it('round-trips dsh-unit with global=null or custom global object and extra unit fields', () => {
    const mem = makeMemoryRecord('mem-dsh-1')
    const rawNull = Buffer.from(
      makeDshEnvelopeJson(
        { [mem.id]: mem },
        { global: null, unit: { name: 'memory', version: 1, extra: 'keep' } },
      ),
      'utf8',
    )
    expect(detectEnvelopeFormat(JSON.parse(rawNull.toString('utf8')))).toBe('dsh-unit')

    const parsedNull = parseStoreEnvelope(rawNull, '/tmp/dsh-memory.json')
    expect(parsedNull.format).toBe('dsh-unit')
    expect(parsedNull.unit).toEqual({ name: 'memory', version: 1, extra: 'keep' })
    expect(parsedNull.global).toBeNull()
    expect(parsedNull.rawTables.memories[mem.id]).toEqual(mem)

    const outNull = serializeStoreEnvelope('dsh-unit', parsedNull.rawTables, {
      unit: parsedNull.unit,
      global: parsedNull.global,
    })
    expect(JSON.parse(outNull.toString('utf8'))).toEqual(JSON.parse(rawNull.toString('utf8')))

    const customGlobal = { schemaRev: 4, marker: 'preserved' }
    const rawCustom = Buffer.from(
      makeDshEnvelopeJson({ [mem.id]: mem }, { global: customGlobal }),
      'utf8',
    )
    const parsedCustom = parseStoreEnvelope(rawCustom, '/tmp/dsh-memory.json')
    const outCustom = serializeStoreEnvelope('dsh-unit', parsedCustom.rawTables, {
      unit: parsedCustom.unit,
      global: parsedCustom.global,
    })
    expect(JSON.parse(outCustom.toString('utf8'))).toEqual({
      unit: { name: 'memory', version: 1 },
      global: customGlobal,
      tables: {
        memories: { [mem.id]: mem },
        episodes: {},
        dreams: {},
        audit: {},
        operations: {},
        session_cursors: {},
      },
    })
  })

  it('round-trips agy-flat preserving top-level name, version, and six tables', () => {
    const mem = makeMemoryRecord('mem-agy-1')
    const raw = Buffer.from(makeAgyEnvelopeJson({ [mem.id]: mem }), 'utf8')
    expect(detectEnvelopeFormat(JSON.parse(raw.toString('utf8')))).toBe('agy-flat')

    const parsed = parseStoreEnvelope(raw, '/tmp/agy-memory.json')
    expect(parsed.format).toBe('agy-flat')
    expect(parsed.rawTables.memories[mem.id]).toEqual(mem)

    const out = serializeStoreEnvelope('agy-flat', parsed.rawTables)
    expect(JSON.parse(out.toString('utf8'))).toEqual(JSON.parse(raw.toString('utf8')))
  })

  it('throws OperationError(MEMORY_UNAVAILABLE) on invalid JSON or unrecognized envelope', () => {
    expect(() =>
      parseStoreEnvelope(Buffer.from('{not-json', 'utf8'), '/tmp/bad.json'),
    ).toThrowError(OperationError)
    expect(() =>
      parseStoreEnvelope(
        Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8'),
        '/tmp/unknown.json',
      ),
    ).toThrowError(OperationError)

    try {
      parseStoreEnvelope(
        Buffer.from(
          JSON.stringify({ unit: { name: 'wrong', version: 9 }, global: null, tables: {} }),
          'utf8',
        ),
        '/tmp/wrong-unit.json',
      )
      expect.unreachable('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(OperationError)
      expect((err as OperationError).code).toBe('MEMORY_UNAVAILABLE')
    }
  })
})

describe('DshFileDomain write-batch, backup rotation, external change guard, and corruption protection', () => {
  it('coalesces 6 table.put calls inside withWriteBatch into 1 disk write and 1 pre-write backup while preserving global', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const backupsDir = join(dir, 'backups')
    const initialGlobal = { customFlag: true }
    writeFileSync(storePath, makeDshEnvelopeJson({}, { global: initialGlobal }), 'utf8')

    const domain = await DshFileDomain.open({ storePath, backupsDir })
    expect(domain.envelopeFormat).toBe('dsh-unit')
    expect(domain.lastHash).not.toBeNull()

    await domain.withWriteBatch(async () => {
      const memTable = domain.table('memories')
      const auditTable = domain.table('audit')
      for (let i = 1; i <= 4; i += 1) {
        await memTable.put(MemoryId(`m-${i}`), makeMemoryRecord(`m-${i}`, `Title ${i}`))
      }
      await auditTable.put(AuditId('a-1'), makeAuditRecord('a-1', 'm-1'))
      await auditTable.put(AuditId('a-2'), makeAuditRecord('a-2', 'm-2'))
    })

    const backupFiles = readdirSync(backupsDir).filter((f) =>
      f.startsWith(DSH_DESKTOP_BACKUP_PREFIX),
    )
    expect(backupFiles).toHaveLength(1)

    const diskJson = JSON.parse(readFileSync(storePath, 'utf8')) as {
      unit: { name: string; version: number }
      global: unknown
      tables: { memories: Record<string, unknown>; audit: Record<string, unknown> }
    }
    expect(diskJson.unit).toEqual({ name: 'memory', version: 1 })
    expect(diskJson.global).toEqual(initialGlobal)
    expect(Object.keys(diskJson.tables.memories)).toHaveLength(4)
    expect(Object.keys(diskJson.tables.audit)).toHaveLength(2)
  })

  it('rotates desktop pre-write backups to latest 20 without deleting other backup files', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const backupsDir = join(dir, 'backups')
    mkdirSync(backupsDir, { recursive: true })
    const manualBackup = join(backupsDir, 'corrupt-manual.json')
    writeFileSync(manualBackup, '{"manual":true}', 'utf8')
    writeFileSync(storePath, makeDshEnvelopeJson({}), 'utf8')

    let tick = 0
    const baseMs = Date.UTC(2026, 10, 26, 1, 0, 0, 0)
    const domain = await DshFileDomain.open({
      storePath,
      backupsDir,
      now: () => new Date(baseMs + tick++ * 1000),
    })

    expect(DSH_DESKTOP_BACKUP_LIMIT).toBe(20)

    for (let i = 1; i <= 22; i += 1) {
      await domain.withWriteBatch(async () => {
        await domain
          .table('memories')
          .put(MemoryId(`m-${i}`), makeMemoryRecord(`m-${i}`, `Item ${i}`))
      })
    }

    const allBackups = readdirSync(backupsDir)
    const desktopBackups = allBackups
      .filter((f) => f.startsWith(DSH_DESKTOP_BACKUP_PREFIX) && f.endsWith('.json'))
      .sort()
    expect(desktopBackups).toHaveLength(20)
    expect(existsSync(manualBackup)).toBe(true)
    expect(readFileSync(manualBackup, 'utf8')).toBe('{"manual":true}')
    // Oldest two timestamps (00s and 01s) should have been pruned; 02s..21s remain
    expect(desktopBackups[0]).toContain('010002-000')
    expect(desktopBackups[19]).toContain('010021-000')
  })

  it('aborts with DesktopExternalChangeError before executing batch callback when disk file changed externally', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const backupsDir = join(dir, 'backups')
    const m1 = makeMemoryRecord('m-1', 'Original')
    writeFileSync(storePath, makeDshEnvelopeJson({ [m1.id]: m1 }), 'utf8')

    const domain = await DshFileDomain.open({ storePath, backupsDir })

    const mExternal = makeMemoryRecord('m-ext', 'Written by DSH')
    const externalContent = makeDshEnvelopeJson({ [m1.id]: m1, [mExternal.id]: mExternal })
    writeFileSync(storePath, externalContent, 'utf8')

    const callbackSpy = vi.fn(async () => {
      await domain.table('memories').put(MemoryId('m-2'), makeMemoryRecord('m-2', 'Should not run'))
    })

    let caught: unknown
    try {
      await domain.withWriteBatch(callbackSpy)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(DesktopExternalChangeError)
    expect((caught as DesktopExternalChangeError).code).toBe('desktop/external-change')
    expect((caught as DesktopExternalChangeError).storePath).toBe(storePath)
    expect(callbackSpy).not.toHaveBeenCalled()
    expect(readFileSync(storePath, 'utf8')).toBe(externalContent)
    expect(existsSync(backupsDir)).toBe(false)
  })

  it('rolls back in-memory table changes without writing disk when withWriteBatch throws', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const backupsDir = join(dir, 'backups')
    const m1 = makeMemoryRecord('m-1', 'Initial')
    const initialRaw = makeDshEnvelopeJson({ [m1.id]: m1 })
    writeFileSync(storePath, initialRaw, 'utf8')

    const domain = await DshFileDomain.open({ storePath, backupsDir })

    await expect(
      domain.withWriteBatch(async () => {
        await domain.table('memories').put(MemoryId('m-2'), makeMemoryRecord('m-2', 'Temp'))
        await domain.table('memories').delete(MemoryId('m-1'))
        throw new Error('simulated business failure')
      }),
    ).rejects.toThrow('simulated business failure')

    expect(domain.table('memories').size).toBe(1)
    expect(domain.table('memories').get(MemoryId('m-1'))?.title).toBe('Initial')
    expect(domain.table('memories').get(MemoryId('m-2'))).toBeUndefined()
    expect(readFileSync(storePath, 'utf8')).toBe(initialRaw)
    expect(existsSync(backupsDir)).toBe(false)
  })

  it('blocks and backs up on corrupted core memories record, and isolates/warns on corrupted derived audit record', async () => {
    const dirCore = makeTempDir()
    const coreStorePath = join(dirCore, 'memory.json')
    const coreBackupsDir = join(dirCore, 'backups')
    const corruptCoreRaw = makeDshEnvelopeJson({
      'bad-mem': { id: 'bad-mem', title: 123 },
    })
    writeFileSync(coreStorePath, corruptCoreRaw, 'utf8')

    await expect(
      DshFileDomain.open({ storePath: coreStorePath, backupsDir: coreBackupsDir }),
    ).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' })
    expect(readFileSync(coreStorePath, 'utf8')).toBe(corruptCoreRaw)
    expect(readdirSync(coreBackupsDir).some((f) => f.startsWith('memory.corrupt-'))).toBe(true)

    const dirDerived = makeTempDir()
    const derivedStorePath = join(dirDerived, 'memory.json')
    const derivedBackupsDir = join(dirDerived, 'backups')
    const goodMem = makeMemoryRecord('m-ok', 'Healthy')
    const goodAudit = makeAuditRecord('a-ok', 'm-ok')
    writeFileSync(
      derivedStorePath,
      makeDshEnvelopeJson(
        { [goodMem.id]: goodMem },
        {
          audit: {
            [goodAudit.id]: goodAudit,
            'a-bad': { id: 'a-bad', broken: true },
          },
        },
      ),
      'utf8',
    )

    const warnings: string[] = []
    const domain = await DshFileDomain.open({
      storePath: derivedStorePath,
      backupsDir: derivedBackupsDir,
      onWarn: (msg) => warnings.push(msg),
    })

    expect(domain.table('memories').size).toBe(1)
    expect(domain.table('audit').size).toBe(1)
    expect(domain.table('audit').get(AuditId('a-ok'))).toEqual(goodAudit)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('audit')
    expect(readdirSync(derivedBackupsDir).some((f) => f.startsWith('memory.corrupt-'))).toBe(true)
  })
})

describe('openDesktopStore unified opener', () => {
  it('detects and opens dsh-unit via DshFileDomain and agy-flat (or new store) via FileMemoryDomain', async () => {
    const dir = makeTempDir()
    const dshPath = join(dir, 'dsh-memory.json')
    const agyPath = join(dir, 'agy-memory.json')
    const newPath = join(dir, 'custom-memory.json')

    writeFileSync(dshPath, makeDshEnvelopeJson({}), 'utf8')
    writeFileSync(agyPath, makeAgyEnvelopeJson({}), 'utf8')

    const dshHandle = await openDesktopStore({ storePath: dshPath })
    expect(dshHandle.format).toBe('dsh-unit')
    await dshHandle.runWrite(async () => {
      await dshHandle.domain.table('memories').put(MemoryId('m-dsh'), makeMemoryRecord('m-dsh'))
    })
    const dshWritten = JSON.parse(readFileSync(dshPath, 'utf8')) as Record<string, unknown>
    expect(dshWritten).toHaveProperty('unit')
    expect(dshWritten).toHaveProperty('tables')
    await dshHandle.close()

    const agyHandle = await openDesktopStore({ storePath: agyPath })
    expect(agyHandle.format).toBe('agy-flat')
    await agyHandle.runWrite(async () => {
      await agyHandle.domain.table('memories').put(MemoryId('m-agy'), makeMemoryRecord('m-agy'))
    })
    const agyWritten = JSON.parse(readFileSync(agyPath, 'utf8')) as Record<string, unknown>
    expect(agyWritten).toHaveProperty('memories')
    expect(agyWritten).not.toHaveProperty('tables')
    await agyHandle.close()

    const newHandle = await openDesktopStore({ storePath: newPath })
    expect(newHandle.format).toBe('agy-flat')
    await newHandle.runWrite(async () => {
      await newHandle.domain.table('memories').put(MemoryId('m-new'), makeMemoryRecord('m-new'))
    })
    const newWritten = JSON.parse(readFileSync(newPath, 'utf8')) as Record<string, unknown>
    expect(newWritten).toHaveProperty('name', 'memory')
    expect(newWritten).toHaveProperty('memories')
    await newHandle.close()
  })
})
