import { describe, expect, it } from 'vitest'
import { MemoryId } from '../../src/shared/types.ts'
import { exportMemories, importMemories, purgeAll } from '../../src/host/exchange.ts'
import type { MemoryExport } from '../../src/host/exchange.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { openStore } from '../helpers/runner.ts'

const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }
const identityMapping = { 'ws-a': { key: 'ws-a', root: 'C:/ws/a' } }

describe('export / purge / import round-trip', () => {
  it('preserves memory fields, scope, status and ownership', async () => {
    const { store, domain, runner } = await openStore()
    await store.create({
      type: 'lesson',
      title: 'A',
      body: 'body',
      scope: workspace,
      importance: 0.7,
    })
    await store.create({ type: 'preference', title: 'P', body: 'pref', scope: { kind: 'global' } })
    await store.create({
      type: 'lesson',
      title: 'pending',
      body: 'p',
      scope: workspace,
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      sourceEpisodeIds: ['episode-1'],
    })

    const exported = exportMemories(domain, { scope: 'all' })
    expect(exported.memories).toHaveLength(3)

    await purgeAll(domain, runner, { scope: 'all', confirmText: 'PURGE all' })
    expect(store.counts().stored).toBe(0)

    const report = await importMemories(store, domain, exported, { mapping: identityMapping })
    expect(report.created).toBe(3)
    expect(report.unmapped).toEqual([])

    const byTitle = new Map(
      store.list({ workspaceKey: 'all', management: true }).items.map((item) => [item.title, item]),
    )
    expect(byTitle.get('A')?.body).toBe('body')
    expect(byTitle.get('A')?.scope).toEqual(workspace)
    expect(byTitle.get('A')?.importance).toBe(0.7)
    expect(byTitle.get('A')?.ownership).toBe('user')
    expect(byTitle.get('P')?.scope).toEqual({ kind: 'global' })
    expect(byTitle.get('pending')?.status).toBe('pending')
  })

  it('skips and reports memories whose workspace is not mapped', async () => {
    const { store, domain } = await openStore()
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-remote' },
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('remote-1'),
          scope: { kind: 'workspace', key: 'ws-remote', root: '/remote' },
        }),
      ],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, { mapping: {} })
    expect(report.unmapped).toContain('remote-1')
    expect(store.get(MemoryId('remote-1'))).toBeUndefined()
    expect(report.created).toBe(0)
  })

  it('redacts secrets in title, body, tags and source quotes before persisting', async () => {
    const { store, domain } = await openStore()
    const secret = makeMemoryRecord({
      id: MemoryId('secret-1'),
      title: `ghp_${'a'.repeat(30)}`,
      body: `token=supersecretvalue and sk-${'b'.repeat(20)}`,
      tags: [`sk-${'c'.repeat(24)}`],
      sourceRefs: [{ sessionId: 's-1', quote: `password=hunter2` }],
    })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [secret],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, { mapping: identityMapping })
    expect(report.created).toBe(1)
    expect(report.redacted).toBe(1)

    const imported = store.get(MemoryId('secret-1'))
    expect(imported?.title).not.toContain('ghp_')
    expect(imported?.body).not.toContain('supersecretvalue')
    expect(imported?.body).not.toContain(`sk-${'b'.repeat(20)}`)
    expect(imported?.body).toContain('[REDACTED]')
    expect(imported?.tags[0]).toBe('[REDACTED]')
    expect(imported?.sourceRefs[0]?.quote).toBe('[REDACTED]')
    expect(imported?.status).toBe('active')
    expect(imported?.type).toBe('lesson')
  })

  it('dedupes imported content by digest even when the id differs', async () => {
    const { store, domain } = await openStore()
    await store.create({ type: 'lesson', title: 'same', body: 'body', scope: workspace })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('different-id'),
          title: 'same',
          body: 'body',
          scope: workspace,
          tags: [],
          importance: 0.5,
          pinned: false,
        }),
      ],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, { mapping: identityMapping })
    expect(report.created).toBe(0)
    expect(report.skipped).toBe(1)
  })
})

describe('purge confirmation', () => {
  it('rejects a wrong confirmation and clears with the exact PURGE <scopeKey>, keeping an audit', async () => {
    const { store, domain, runner } = await openStore()
    await store.create({ type: 'lesson', title: 'x', body: 'b', scope: workspace })

    await expect(
      purgeAll(domain, runner, { scope: { workspaceKey: 'ws-a' }, confirmText: 'PURGE wrong' }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN' })
    expect(store.counts().stored).toBe(1)

    const report = await purgeAll(domain, runner, {
      scope: { workspaceKey: 'ws-a' },
      confirmText: 'PURGE ws-a',
    })
    expect(report.deleted).toBe(1)
    expect(store.counts().stored).toBe(0)
    expect(store.auditList({ limit: 500 }).items.some((item) => item.action === 'purge')).toBe(true)
  })

  it('resets the scope session cursors so the cleared scope can be regenerated', async () => {
    const { store, domain, runner } = await openStore()
    await store.create({ type: 'lesson', title: 'x', body: 'b', scope: workspace })
    await domain.table('session_cursors').put('s1', {
      sessionId: 's1',
      workspaceKey: 'ws-a',
      lastProcessedSeq: 42,
      lastProcessedAt: '2026-11-15T00:00:00.000Z',
    })
    await domain.table('session_cursors').put('s2', {
      sessionId: 's2',
      workspaceKey: 'ws-b',
      lastProcessedSeq: 7,
      lastProcessedAt: '2026-11-15T00:00:00.000Z',
    })

    await purgeAll(domain, runner, {
      scope: { workspaceKey: 'ws-a' },
      confirmText: 'PURGE ws-a',
    })
    expect(domain.table('session_cursors').get('s1')).toBeUndefined()
    expect(domain.table('session_cursors').get('s2')).toBeDefined()
  })

  it('removes memory content from every audit row when purging', async () => {
    const { store, domain, runner } = await openStore()
    await store.create({
      type: 'lesson',
      title: 'secret',
      body: 'SUPER_SECRET_BODY',
      scope: workspace,
    })
    await purgeAll(domain, runner, {
      scope: { workspaceKey: 'ws-a' },
      confirmText: 'PURGE ws-a',
    })
    const auditJson = JSON.stringify([...domain.table('audit').entries()])
    expect(auditJson).not.toContain('SUPER_SECRET_BODY')
    expect([...domain.table('audit').entries()].some(([, audit]) => audit.action === 'purge')).toBe(
      true,
    )
    const operationsJson = JSON.stringify([...domain.table('operations').entries()])
    expect(operationsJson).not.toContain('SUPER_SECRET_BODY')
  })
})

describe('import safety', () => {
  it('does not delete existing data when the payload is malformed', async () => {
    const { store, domain } = await openStore()
    const existing = await store.create({
      type: 'lesson',
      title: 'keep',
      body: 'keep body',
      scope: workspace,
    })
    const malformed = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: 'all',
      includeArchived: true,
    } as unknown as MemoryExport
    await expect(
      importMemories(store, domain, malformed, {
        mode: 'replace',
        confirm: true,
        targetScope: { workspaceKey: 'ws-a' },
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
    expect(store.get(existing.id)).toBeDefined()
  })

  it('rejects a business-invalid replace record before deleting existing data', async () => {
    const { store, domain } = await openStore()
    const existing = await store.create({
      type: 'preference',
      title: 'keep preference',
      body: 'must survive',
      scope: { kind: 'global' },
    })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: 'global',
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('bad-global-lesson'),
          type: 'lesson',
          title: 'invalid global lesson',
          body: 'schema-valid but business-invalid',
          scope: { kind: 'global' },
        }),
      ],
      episodes: [],
    }
    await expect(
      importMemories(store, domain, payload, {
        mode: 'replace',
        confirm: true,
        targetScope: 'global',
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN_SCOPE' })
    expect(store.get(existing.id)?.body).toBe('must survive')
    expect(store.counts().stored).toBe(1)
  })

  it('replace only touches the selected target scope', async () => {
    const { store, domain } = await openStore()
    const workspaceB = { kind: 'workspace' as const, key: 'ws-b', root: 'C:/ws/b' }
    const keepB = await store.create({
      type: 'lesson',
      title: 'keep b',
      body: 'keep b body',
      scope: workspaceB,
    })
    const replaceA = await store.create({
      type: 'lesson',
      title: 'old a',
      body: 'old a body',
      scope: workspace,
    })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: 'all',
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('new-a'),
          title: 'new a',
          body: 'new a body',
          scope: workspace,
        }),
        makeMemoryRecord({
          id: MemoryId('intruder-b'),
          title: 'intruder',
          body: 'b',
          scope: workspaceB,
        }),
      ],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, {
      mode: 'replace',
      confirm: true,
      targetScope: { workspaceKey: 'ws-a' },
      mapping: {
        'ws-a': { key: 'ws-a', root: 'C:/ws/a' },
        'ws-b': { key: 'ws-b', root: 'C:/ws/b' },
      },
    })
    expect(report.errors).toEqual([])
    expect(store.get(replaceA.id)).toBeUndefined()
    expect(store.get(MemoryId('new-a'))).toBeDefined()
    expect(store.get(keepB.id)?.body).toBe('keep b body')
    expect(store.get(MemoryId('intruder-b'))).toBeUndefined()
    expect(report.skipped).toBe(1)
  })

  it('dedupes by digest after mapping the source workspace to the local scope', async () => {
    const { store, domain } = await openStore()
    await store.create({ type: 'lesson', title: 'same', body: 'body', scope: workspace })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-remote' },
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('remote-same'),
          title: 'same',
          body: 'body',
          scope: { kind: 'workspace', key: 'ws-remote', root: '/remote' },
          tags: [],
          importance: 0.5,
          pinned: false,
        }),
      ],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, {
      mapping: { 'ws-remote': { key: 'ws-a', root: 'C:/ws/a' } },
    })
    expect(report.created).toBe(0)
    expect(report.skipped).toBe(1)
  })

  it('refuses a replace import without a workspace mapping and keeps every record', async () => {
    const { store, domain } = await openStore()
    const existing = await store.create({
      type: 'lesson',
      title: 'must survive',
      body: 'keep body',
      scope: workspace,
    })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [makeMemoryRecord({ id: MemoryId('replacement'), scope: workspace })],
      episodes: [],
    }

    await expect(
      importMemories(store, domain, payload, {
        mode: 'replace',
        confirm: true,
        targetScope: { workspaceKey: 'ws-a' },
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN' })
    expect(store.get(existing.id)?.body).toBe('keep body')
    expect(store.counts().stored).toBe(1)
    expect(store.get(MemoryId('replacement'))).toBeUndefined()
  })

  it('refuses a replace import that would delete a scope without replacement records', async () => {
    const { store, domain } = await openStore()
    const existing = await store.create({
      type: 'lesson',
      title: 'must survive',
      body: 'keep body',
      scope: workspace,
    })
    const empty: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [],
      episodes: [],
    }

    await expect(
      importMemories(store, domain, empty, {
        mode: 'replace',
        confirm: true,
        targetScope: { workspaceKey: 'ws-a' },
        mapping: identityMapping,
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN' })
    expect(store.get(existing.id)?.status).toBe('active')
    expect(store.counts().stored).toBe(1)
  })

  it('remaps imported episode session ids so they cannot move a local backfill cursor', async () => {
    const { store, domain } = await openStore()
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [],
      episodes: [
        {
          id: 'episode-imported' as never,
          sessionId: 'session-local',
          workspaceKey: 'ws-a',
          workspaceRoot: 'C:/ws/a',
          kind: 'turn',
          status: 'new',
          attempts: 0,
          turn: 1,
          sourceSeqs: [40, 41],
          files: [],
          createdAt: '2026-11-15T00:00:00.000Z',
        },
      ],
    }
    const report = await importMemories(store, domain, payload, {
      mode: 'replace',
      confirm: true,
      targetScope: { workspaceKey: 'ws-a' },
      mapping: identityMapping,
    })
    expect(report.episodesImported).toBe(1)
    const imported = domain.table('episodes').get('episode-imported' as never)
    expect(imported?.sessionId).toBe('import:episode-imported')
    expect(imported?.sourceSeqs).toEqual([])
    expect(store.maxEpisodeSourceSeq('session-local')).toBeUndefined()
  })

  it('restores the rows a failed replace already deleted', async () => {
    const { store, domain } = await openStore()
    const existing = await store.create({
      type: 'lesson',
      title: 'must survive',
      body: 'keep body',
      scope: workspace,
    })
    const create = store.create.bind(store)
    let injected = false
    ;(store as unknown as { create: typeof store.create }).create = async (input, requestId) => {
      if (!injected && input.id === 'replacement') {
        injected = true
        throw new Error('storage write failed')
      }
      return create(input, requestId)
    }
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('replacement'),
          title: 'replacement',
          body: 'new body',
          scope: workspace,
        }),
      ],
      episodes: [],
    }

    await expect(
      importMemories(store, domain, payload, {
        mode: 'replace',
        confirm: true,
        targetScope: { workspaceKey: 'ws-a' },
        mapping: identityMapping,
      }),
    ).rejects.toThrow(/restored 1 previously deleted record/)
    expect(store.get(existing.id)?.body).toBe('keep body')
    expect(store.get(existing.id)?.status).toBe('active')
  })

  it('drops supersede targets that live outside the imported scope', async () => {
    const { store, domain } = await openStore()
    const workspaceB = { kind: 'workspace' as const, key: 'ws-b', root: 'C:/ws/b' }
    const foreign = await store.create({
      type: 'lesson',
      title: 'other workspace',
      body: 'keep me',
      scope: workspaceB,
    })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('proposal-1'),
          status: 'pending',
          supersedes: [foreign.id],
          scope: workspace,
        }),
      ],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, { mapping: identityMapping })
    expect(report.created).toBe(1)
    const proposal = store.get(MemoryId('proposal-1'))
    expect(proposal?.supersedes).toEqual([])

    await store.acceptProposal(MemoryId('proposal-1'))
    expect(store.get(foreign.id)?.status).toBe('active')
  })
})
