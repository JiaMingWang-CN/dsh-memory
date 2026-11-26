import { describe, expect, it, vi } from 'vitest'
import { MemoryEngine } from '../../src/core/engine.ts'
import { OperationError } from '../../src/core/operations.ts'
import { ManagementSearchIndex, SearchIndex } from '../../src/core/search.ts'
import {
  MEMORY_DOMAIN_NAME,
  MEMORY_TABLE_SCHEMAS,
  type MemoryDomainHandle,
  type MemoryKvTable,
  type MemoryTableKeyMap,
  type MemoryTableName,
  type MemoryTableValueMap,
} from '../../src/core/storage-contract.ts'
import {
  DreamId,
  MemoryId,
  OperationId,
  type DreamRun,
  type MemoryRecord,
  type OperationRecord,
} from '../../src/shared/types.ts'

function createInMemoryDomain(): MemoryDomainHandle {
  const stores = new Map<MemoryTableName, Map<string, unknown>>([
    ['memories', new Map()],
    ['episodes', new Map()],
    ['dreams', new Map()],
    ['audit', new Map()],
    ['operations', new Map()],
    ['session_cursors', new Map()],
  ])

  return {
    name: MEMORY_DOMAIN_NAME,
    table<N extends MemoryTableName>(
      name: N,
    ): MemoryKvTable<MemoryTableKeyMap[N], MemoryTableValueMap[N]> {
      const store = stores.get(name)!
      const schema = MEMORY_TABLE_SCHEMAS[name]
      return {
        get(key) {
          return store.get(key) as MemoryTableValueMap[N] | undefined
        },
        entries() {
          const pairs = [...store.entries()].map(
            ([k, v]) => [k, v] as [MemoryTableKeyMap[N], MemoryTableValueMap[N]],
          )
          return pairs[Symbol.iterator]()
        },
        keys() {
          return [...store.keys()].map((k) => k as MemoryTableKeyMap[N])[Symbol.iterator]()
        },
        get size() {
          return store.size
        },
        async put(key, value) {
          store.set(key, schema.parse(value))
        },
        async delete(key) {
          return store.delete(key)
        },
        async deleteMany(keys) {
          let removed = 0
          for (const key of new Set(keys)) {
            if (store.delete(key)) removed += 1
          }
          return removed
        },
        async update(key, fn) {
          if (!store.has(key)) throw new Error(`missing-key: ${key}`)
          const next = schema.parse(fn(store.get(key) as MemoryTableValueMap[N]))
          store.set(key, next)
          return next as MemoryTableValueMap[N]
        },
      }
    },
    async close() {},
  }
}

function makeRecord(overrides: Omit<Partial<MemoryRecord>, 'id'> & { id: string }): MemoryRecord {
  const { id, ...rest } = overrides
  return {
    ...rest,
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
    importance: rest.importance ?? 0.5,
    contentRevision: rest.contentRevision ?? 1,
    statsRevision: rest.statsRevision ?? 0,
    createdAt: rest.createdAt ?? '2026-11-25T00:00:00.000Z',
    updatedAt: rest.updatedAt ?? '2026-11-25T00:00:00.000Z',
    matchCount: rest.matchCount ?? 0,
    useCount: rest.useCount ?? 0,
    sourceRefs: rest.sourceRefs ?? [],
    sourceEpisodeIds: rest.sourceEpisodeIds ?? [],
    supersedes: rest.supersedes ?? [],
    contentHash: rest.contentHash ?? `hash-${id}`,
  }
}

describe('core desktop extensions', () => {
  it('openReadOnly enables read/overview/search without touching domain writes even with pending ops', async () => {
    const domain = createInMemoryDomain()
    const seedRecord = makeRecord({
      id: 'mem-readonly-1',
      title: 'ReadOnly BM25 Memory',
      body: 'Stored before readonly open',
    })
    await domain.table('memories').put(seedRecord.id, seedRecord)

    const pendingOp: OperationRecord = {
      id: OperationId('op-pending-1'),
      kind: 'memory.create',
      status: 'planned',
      step: 0,
      totalSteps: 2,
      stepName: 'apply',
      payload: { record: seedRecord, actor: 'user' },
      attempts: 0,
      createdAt: '2026-11-25T00:00:00.000Z',
      updatedAt: '2026-11-25T00:00:00.000Z',
    }
    await domain.table('operations').put(pendingOp.id, pendingOp)

    const expiredDream: DreamRun = {
      id: DreamId('dream-stale-1'),
      trigger: 'manual',
      scopeKey: 'c:/ws/alpha',
      status: 'running',
      startedAt: '2026-11-24T00:00:00.000Z',
      provider: 'test',
      model: 'test-model',
      episodes: 1,
      committed: 0,
      pending: 0,
    }
    await domain.table('dreams').put(expiredDream.id, expiredDream)

    const opPut = vi.spyOn(domain.table('operations'), 'put')
    const dreamPut = vi.spyOn(domain.table('dreams'), 'put')
    const memPut = vi.spyOn(domain.table('memories'), 'put')
    const auditPut = vi.spyOn(domain.table('audit'), 'put')

    const engine = new MemoryEngine({
      domain,
      now: () => new Date('2026-11-25T12:00:00.000Z'),
    })
    engine.openReadOnly()

    expect(engine.list({ workspaceKey: 'all', management: true }).items).toHaveLength(1)
    const overview = engine.overview('all')
    expect(overview.counts.active).toBe(1)
    expect(overview.recentDream?.id).toBe('dream-stale-1')
    expect(engine.view('mem-readonly-1').record.title).toBe('ReadOnly BM25 Memory')
    expect(engine.searchManagement({ query: 'ReadOnly' }).items).toHaveLength(1)
    expect(engine.dreamList()).toHaveLength(1)
    expect(engine.audit()).toMatchObject({ total: 0 })

    expect(opPut).not.toHaveBeenCalled()
    expect(dreamPut).not.toHaveBeenCalled()
    expect(memPut).not.toHaveBeenCalled()
    expect(auditPut).not.toHaveBeenCalled()
  })

  it('manageCreate/manageUpdate auto-redact secrets like DSH UI, support pinned/scope/pending-edit-before-accept', async () => {
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({
      domain,
      now: () => new Date('2026-11-25T12:00:00.000Z'),
    })
    await engine.recover()

    const created = await engine.manageCreate({
      type: 'lesson',
      title: 'API key sk-live-1234567890abcdef123456',
      body: 'Use token sk-live-abcdef1234567890abcdef in config',
      scope: 'workspace',
      workspaceKey: 'C:\\ws\\Alpha\\',
      workspaceRoot: 'C:\\ws\\Alpha',
      pinned: true,
      tags: ['auth'],
    })

    expect(created.origin).toBe('user')
    expect(created.ownership).toBe('user')
    expect(created.pinned).toBe(true)
    expect(created.scope).toEqual({
      kind: 'workspace',
      key: 'c:/ws/alpha',
      root: 'C:\\ws\\Alpha',
    })
    expect(created.title).not.toContain('sk-live-1234567890abcdef123456')
    expect(created.body).not.toContain('sk-live-abcdef1234567890abcdef')

    // Change scope to global via manageUpdate requires type='preference'
    const updatedPref = await engine.manageUpdate({
      id: created.id,
      expectedContentRevision: created.contentRevision,
      type: 'preference',
      scope: 'global',
      pinned: false,
      title: 'Updated pref sk-live-0987654321fedcba098765',
    })
    expect(updatedPref.scope).toEqual({ kind: 'global' })
    expect(updatedPref.pinned).toBe(false)
    expect(updatedPref.reviewedByUserAt).toBe('2026-11-25T12:00:00.000Z')
    expect(updatedPref.title).not.toContain('sk-live-0987654321fedcba098765')

    // Pending proposal: edit title/body/pinned via manageUpdate, then accept via manageReview
    const pending = await engine.manageCreate({
      type: 'wiki',
      title: 'Pending draft',
      body: 'Initial draft body',
      scope: 'workspace',
      workspaceKey: 'c:/ws/alpha',
      workspaceRoot: 'C:/ws/alpha',
      status: 'pending',
    })
    expect(pending.status).toBe('pending')

    const editedPending = await engine.manageUpdate({
      id: pending.id,
      expectedContentRevision: pending.contentRevision,
      title: 'Edited pending title',
      body: 'Edited pending body',
      pinned: true,
    })
    expect(editedPending.status).toBe('pending')
    expect(editedPending.pinned).toBe(true)

    const accepted = await engine.manageReview({ id: pending.id, action: 'accept' })
    expect(accepted.status).toBe('active')
    expect(accepted.title).toBe('Edited pending title')
    expect(accepted.pinned).toBe(true)
    expect(accepted.ownership).toBe('user')

    // Delete guards
    await expect(
      engine.manageDelete({ id: created.id, permanent: true, confirm: false }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFIRM_REQUIRED' })

    await expect(
      engine.manageDelete({ id: created.id, permanent: true, confirm: true, actor: 'model' }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN' })

    const softDeleted = await engine.manageDelete({ id: created.id })
    expect(softDeleted.deleted).toBe(false)
    expect(engine.view(created.id).record.status).toBe('archived')

    const restored = await engine.manageRestore(created.id)
    expect(restored.status).toBe('active')

    const permDeleted = await engine.manageDelete({
      id: created.id,
      permanent: true,
      confirm: true,
      actor: 'user',
    })
    expect(permDeleted).toEqual({ deleted: true, record: null })
    expect(() => engine.view(created.id)).toThrow(OperationError)
  })

  it('ManagementSearchIndex searches active/pending/archived across all workspaces with offset pagination and normalizedScore', () => {
    const activeA = makeRecord({
      id: 'm1',
      status: 'active',
      scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
      title: 'Electron IPC Bridge',
      body: 'Use contextBridge for Electron preload IPC security',
      updatedAt: '2026-11-25T03:00:00.000Z',
    })
    const pendingB = makeRecord({
      id: 'm2',
      status: 'pending',
      scope: { kind: 'workspace', key: 'c:/ws/b', root: 'C:/ws/b' },
      title: 'Electron Sandbox Proposal',
      body: 'Pending proposal about Electron sandbox',
      updatedAt: '2026-11-25T02:00:00.000Z',
    })
    const archivedB = makeRecord({
      id: 'm3',
      status: 'archived',
      scope: { kind: 'workspace', key: 'c:/ws/b', root: 'C:/ws/b' },
      title: 'Archived Electron Notes',
      body: 'Electron portable build notes',
      updatedAt: '2026-11-25T01:00:00.000Z',
    })
    const globalPref = makeRecord({
      id: 'm4',
      type: 'preference',
      status: 'active',
      scope: { kind: 'global' },
      title: 'Always prefer pnpm',
      body: 'Use pnpm instead of npm',
      updatedAt: '2026-11-25T04:00:00.000Z',
    })

    const mgmt = new ManagementSearchIndex()
    mgmt.rebuild([activeA, pendingB, archivedB, globalPref])
    expect(mgmt.size).toBe(4)

    const allElectron = mgmt.search({
      query: 'Electron',
      workspaceKey: 'all',
      statuses: ['active', 'pending', 'archived'],
      limit: 10,
      offset: 0,
    })
    expect(allElectron.total).toBe(3)
    expect(allElectron.items[0]!.normalizedScore).toBe(1)
    for (const hit of allElectron.items) {
      expect(hit.normalizedScore).toBeGreaterThan(0)
      expect(hit.normalizedScore).toBeLessThanOrEqual(1)
    }

    const pendingArchivedPage = mgmt.search({
      query: 'Electron',
      workspaceKey: 'all',
      statuses: ['pending', 'archived'],
      limit: 1,
      offset: 1,
    })
    expect(pendingArchivedPage.total).toBe(2)
    expect(pendingArchivedPage.items).toHaveLength(1)
    expect(pendingArchivedPage.offset).toBe(1)
    expect(pendingArchivedPage.truncated).toBe(false)

    // No-keyword browse returns updatedAt descending with score 0
    const noKeyword = mgmt.search({ workspaceKey: 'all', limit: 2, offset: 0 })
    expect(noKeyword.total).toBe(4)
    expect(noKeyword.truncated).toBe(true)
    expect(noKeyword.items.map((item) => item.record.id)).toEqual(['m4', 'm1'])
    expect(noKeyword.items[0]!.score).toBe(0)
    expect(noKeyword.items[0]!.normalizedScore).toBe(0)

    // Global-only selector
    const globalOnly = mgmt.search({ workspaceKey: null })
    expect(globalOnly.items.map((item) => item.record.id)).toEqual(['m4'])

    // Verify legacy SearchIndex still only indexes active and isolates workspace
    const legacy = new SearchIndex()
    legacy.rebuild([activeA, pendingB, archivedB, globalPref])
    expect(legacy.size).toBe(2)
    const legacyRes = legacy.search({ query: 'Electron', workspaceKey: 'c:/ws/b' })
    expect(legacyRes.results).toHaveLength(0)

    // Verify ManagementSearchIndex does not clamp limit at MAX_SEARCH_LIMIT=50
    const manyRecords = Array.from({ length: 65 }, (_, index) =>
      makeRecord({
        id: `bulk-${index}`,
        title: `Bulk item ${index}`,
        body: 'Shared keyword bulksearch',
        updatedAt: `2026-11-25T00:00:${String(index).padStart(2, '0')}.000Z`,
      }),
    )
    mgmt.rebuild(manyRecords)
    const bulkRes = mgmt.search({ query: 'bulksearch', limit: 60, offset: 0 })
    expect(bulkRes.total).toBe(65)
    expect(bulkRes.items).toHaveLength(60)
    expect(bulkRes.limit).toBe(60)
    expect(bulkRes.truncated).toBe(true)
  })

  it('listWorkspaces aggregates unique normalized workspaces from memories and episodes', async () => {
    const domain = createInMemoryDomain()
    await domain.table('memories').put(
      MemoryId('w1'),
      makeRecord({
        id: 'w1',
        scope: { kind: 'workspace', key: 'C:\\ws\\Alpha\\', root: 'C:\\ws\\Alpha' },
        updatedAt: '2026-11-25T01:00:00.000Z',
      }),
    )
    await domain.table('memories').put(
      MemoryId('w2'),
      makeRecord({
        id: 'w2',
        scope: { kind: 'workspace', key: 'c:/ws/alpha', root: 'c:/ws/alpha' },
        updatedAt: '2026-11-25T03:00:00.000Z',
      }),
    )
    await domain.table('memories').put(
      MemoryId('g1'),
      makeRecord({
        id: 'g1',
        type: 'preference',
        scope: { kind: 'global' },
        updatedAt: '2026-11-25T05:00:00.000Z',
      }),
    )

    const engine = new MemoryEngine({ domain })
    engine.openReadOnly()
    await engine.appendEpisode({
      sessionId: 'sess-ep',
      workspaceKey: 'C:\\ws\\Beta\\',
      workspaceRoot: 'C:\\ws\\Beta',
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'Check beta',
    })

    const workspaces = engine.listWorkspaces()
    expect(workspaces).toHaveLength(2)
    const alpha = workspaces.find((w) => w.key === 'c:/ws/alpha')
    const beta = workspaces.find((w) => w.key === 'c:/ws/beta')
    expect(alpha?.memoryCount).toBe(2)
    expect(alpha?.updatedAt).toBe('2026-11-25T03:00:00.000Z')
    expect(beta?.memoryCount).toBe(0)
    expect(beta?.root).toBe('C:\\ws\\Beta')
  })
})
