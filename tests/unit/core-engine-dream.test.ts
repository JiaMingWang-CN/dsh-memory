import { describe, expect, it } from 'vitest'
import { MemoryEngine } from '../../src/core/engine.ts'
import { OperationError } from '../../src/core/operations.ts'
import {
  MEMORY_DOMAIN_NAME,
  MEMORY_TABLE_SCHEMAS,
  type MemoryDomainHandle,
  type MemoryKvTable,
  type MemoryTableKeyMap,
  type MemoryTableName,
  type MemoryTableValueMap,
} from '../../src/core/storage-contract.ts'
import type { MemoryScope } from '../../src/shared/types.ts'

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

const WS_SCOPE: MemoryScope = { kind: 'workspace', key: 'c:/ws/demo', root: 'C:/ws/demo' }
const OTHER_WS_SCOPE: MemoryScope = { kind: 'workspace', key: 'c:/ws/other', root: 'C:/ws/other' }

describe('MemoryEngine two-stage dream, organize and lifecycle', () => {
  it('keeps unexpired two-stage running DreamRun intact across recover()', async () => {
    let nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({ domain, now: () => new Date(nowMs) })
    await engine.recover()

    const ep1 = await engine.appendEpisode({
      sessionId: 'sess-1',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1, 2],
      prompt: 'Use pnpm instead of npm',
      assistantFinal: 'Switched to pnpm',
      outcome: 'completed',
    })
    const ep2 = await engine.appendEpisode({
      sessionId: 'sess-1',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'user-correction',
      turn: 2,
      sourceSeqs: [3, 4],
      prompt: 'Always run typecheck',
      correctionText: 'Run pnpm typecheck before commit',
      outcome: 'completed',
    })
    expect(ep1).toBeDefined()
    expect(ep2).toBeDefined()

    const prepared = await engine.prepareDream({ scope: WS_SCOPE })
    expect(prepared.episodeIds).toEqual([ep1!.id, ep2!.id])
    expect(prepared.systemPrompt).toContain('consolidate')
    expect(prepared.userPrompt).toContain(ep1!.id)
    expect(prepared.outputSchema).toMatchObject({ type: 'object' })

    const dream = domain.table('dreams').get(prepared.dreamId as never)
    expect(dream?.status).toBe('running')
    expect(domain.table('operations').size).toBe(0)
    expect(domain.table('episodes').get(ep1!.id)?.status).toBe('processing')
    expect(domain.table('episodes').get(ep2!.id)?.status).toBe('processing')

    // Simulate Stop Hook or MCP restart within dreamProcessingTimeoutMs (600_000ms)
    nowMs += 30_000
    const restarted = new MemoryEngine({ domain, now: () => new Date(nowMs) })
    const { expiredDreams } = await restarted.recover()

    expect(expiredDreams).toBe(0)
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('running')
    expect(domain.table('episodes').get(ep1!.id)?.status).toBe('processing')
    expect(domain.table('episodes').get(ep2!.id)?.status).toBe('processing')
  })

  it('fails expired running dreams after dreamProcessingTimeoutMs and releases episodes', async () => {
    let nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({
      domain,
      config: { dreamProcessingTimeoutMs: 600_000 },
      now: () => new Date(nowMs),
    })
    await engine.recover()

    const ep = await engine.appendEpisode({
      sessionId: 'sess-expire',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'Check timeout handling',
    })

    const prepared = await engine.prepareDream({ scope: WS_SCOPE })
    nowMs += 600_001

    const expiredCount = await engine.failExpiredDreams()
    expect(expiredCount).toBe(1)
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('failed')
    expect(domain.table('episodes').get(ep!.id)?.status).toBe('failed-retryable')

    // Also verify recover() invokes expiration cleanup cleanly
    const prepared2 = await engine.prepareDream({ scope: WS_SCOPE })
    expect(prepared2.episodeIds).toEqual([ep!.id])
    nowMs += 600_001
    const { expiredDreams } = await engine.recover()
    expect(expiredDreams).toBe(1)
    expect(domain.table('dreams').get(prepared2.dreamId as never)?.status).toBe('failed')
    expect(domain.table('episodes').get(ep!.id)?.status).toBe('failed-retryable')
  })

  it('completes empty commitDream by marking claimed episodes skipped so they are not reclaimed', async () => {
    const nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({ domain, now: () => new Date(nowMs) })
    await engine.recover()

    const ep1 = await engine.appendEpisode({
      sessionId: 'sess-empty',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'Just said hello',
    })
    const ep2 = await engine.appendEpisode({
      sessionId: 'sess-empty',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 2,
      sourceSeqs: [2],
      prompt: 'Nothing durable here',
    })

    const prepared = await engine.prepareDream({ scope: WS_SCOPE })
    expect(prepared.episodeIds).toHaveLength(2)

    const result = await engine.commitDream({
      dreamId: prepared.dreamId,
      memories: [],
    })

    expect(result).toEqual({
      dreamId: prepared.dreamId,
      status: 'completed',
      createdIds: [],
      skippedDuplicates: 0,
      processedEpisodes: 0,
      skippedEpisodes: 2,
    })
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('completed')
    expect(domain.table('episodes').get(ep1!.id)?.status).toBe('skipped')
    expect(domain.table('episodes').get(ep2!.id)?.status).toBe('skipped')

    const nextPrepared = await engine.prepareDream({ scope: WS_SCOPE })
    expect(nextPrepared.episodeIds).toEqual([])
  })

  it('rejects whole commitDream batch on strong secret while keeping DreamRun running for retry', async () => {
    const nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({ domain, now: () => new Date(nowMs) })
    await engine.recover()

    const ep1 = await engine.appendEpisode({
      sessionId: 'sess-sec',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'Use pnpm',
    })
    const ep2 = await engine.appendEpisode({
      sessionId: 'sess-sec',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 2,
      sourceSeqs: [2],
      prompt: 'Configured SSH key',
    })

    const prepared = await engine.prepareDream({ scope: WS_SCOPE })

    await expect(
      engine.commitDream({
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Use pnpm',
            body: 'Always use pnpm for scripts.',
            confidence: 0.9,
            importance: 0.8,
            sourceEpisodeIds: [ep1!.id],
          },
          {
            type: 'wiki',
            title: 'Deploy key',
            body: 'Key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----',
            confidence: 0.9,
            importance: 0.7,
            sourceEpisodeIds: [ep2!.id],
          },
        ],
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_INVALID_CONTENT',
    )

    expect(domain.table('memories').size).toBe(0)
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('running')
    expect(domain.table('episodes').get(ep1!.id)?.status).toBe('processing')
    expect(domain.table('episodes').get(ep2!.id)?.status).toBe('processing')

    // Retry with sanitized content (referencing only ep1; uncited ep2 is marked skipped)
    const committed = await engine.commitDream({
      dreamId: prepared.dreamId,
      memories: [
        {
          type: 'lesson',
          title: 'Use pnpm',
          body: 'Always use pnpm for scripts.',
          confidence: 0.9,
          importance: 0.8,
          sourceEpisodeIds: [ep1!.id],
        },
      ],
    })

    expect(committed.status).toBe('completed')
    expect(committed.createdIds).toHaveLength(1)
    expect(committed.processedEpisodes).toBe(1)
    expect(committed.skippedEpisodes).toBe(1)
    expect(domain.table('episodes').get(ep1!.id)?.status).toBe('processed')
    expect(domain.table('episodes').get(ep2!.id)?.status).toBe('skipped')
  })

  it('validates organize supersedes strictly and writes valid proposals as pending derived dream records', async () => {
    const nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({ domain, now: () => new Date(nowMs) })
    await engine.recover()

    const wsIdent = { key: WS_SCOPE.key, root: WS_SCOPE.root }
    const otherIdent = { key: OTHER_WS_SCOPE.key, root: OTHER_WS_SCOPE.root }

    const m1 = (
      await engine.write(
        { type: 'lesson', title: 'Rule A', body: 'Always run tests before commit' },
        wsIdent,
      )
    ).record
    const m2 = (
      await engine.write(
        { type: 'lesson', title: 'Rule B', body: 'Always run lint before commit' },
        wsIdent,
      )
    ).record
    const archivedMem = (
      await engine.write({ type: 'wiki', title: 'Old note', body: 'Archived content' }, wsIdent)
    ).record
    await engine.forget(archivedMem.id, wsIdent.key)
    const otherMem = (
      await engine.write(
        { type: 'lesson', title: 'Other WS', body: 'Belongs to other workspace' },
        otherIdent,
      )
    ).record

    const prepared = await engine.prepareOrganize({ scope: WS_SCOPE })
    expect(prepared.episodeIds).toEqual([])
    expect(prepared.userPrompt).toContain(m1.id)
    expect(prepared.userPrompt).toContain(m2.id)

    // 1. Empty supersedes rejected
    await expect(
      engine.commitOrganize({
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Merged rule',
            body: 'Run tests and lint before commit.',
            confidence: 0.9,
            importance: 0.9,
            supersedes: [],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(OperationError)
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('running')

    // 2. Non-active supersedes rejected
    await expect(
      engine.commitOrganize({
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Merged rule',
            body: 'Run tests and lint before commit.',
            confidence: 0.9,
            importance: 0.9,
            supersedes: [archivedMem.id],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(OperationError)
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('running')

    // 3. Cross-workspace supersedes rejected
    await expect(
      engine.commitOrganize({
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Merged rule',
            body: 'Run tests and lint before commit.',
            confidence: 0.9,
            importance: 0.9,
            supersedes: [otherMem.id],
          },
        ],
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_FORBIDDEN_SCOPE',
    )
    expect(domain.table('dreams').get(prepared.dreamId as never)?.status).toBe('running')

    // 4. Valid organize commit writes pending derived record without touching active records
    const organized = await engine.commitOrganize({
      dreamId: prepared.dreamId,
      memories: [
        {
          type: 'lesson',
          title: 'Pre-commit checks',
          body: 'Run both tests and lint before commit.',
          confidence: 0.95,
          importance: 0.9,
          supersedes: [m1.id, m2.id],
        },
      ],
    })
    expect(organized.status).toBe('completed')
    expect(organized.createdIds).toHaveLength(1)

    const proposal = domain.table('memories').get(organized.createdIds[0]! as never)
    expect(proposal?.status).toBe('pending')
    expect(proposal?.ownership).toBe('derived')
    expect(proposal?.origin).toBe('dream')
    expect(proposal?.supersedes).toEqual([m1.id, m2.id])

    // Active records remain active until reviewed
    expect(domain.table('memories').get(m1.id)?.status).toBe('active')
    expect(domain.table('memories').get(m2.id)?.status).toBe('active')

    // Accept proposal archives m1 & m2 and promotes proposal to user-owned active
    const accepted = await engine.review({
      id: proposal!.id,
      action: 'accept',
      workspaceKey: WS_SCOPE.key,
    })
    expect(accepted.status).toBe('active')
    expect(accepted.ownership).toBe('user')
    expect(accepted.reviewedByUserAt).toBeDefined()
    expect(domain.table('memories').get(m1.id)?.status).toBe('archived')
    expect(domain.table('memories').get(m2.id)?.status).toBe('archived')
  })

  it('keeps export strictly read-only even when archivePurgePolicy is after-export', async () => {
    const nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({
      domain,
      config: { archivePurgePolicy: 'after-export' },
      now: () => new Date(nowMs),
    })
    await engine.recover()

    const wsIdent = { key: WS_SCOPE.key, root: WS_SCOPE.root }
    const created = (
      await engine.write(
        { type: 'wiki', title: 'Archived fact', body: 'Keep me on export' },
        wsIdent,
      )
    ).record
    await engine.forget(created.id, wsIdent.key, 'soft forget')

    const snapshot = engine.export({ scope: { workspaceKey: WS_SCOPE.key }, includeArchived: true })
    expect(snapshot.memories).toHaveLength(1)
    expect(snapshot.memories[0]?.status).toBe('archived')

    // Archived record MUST still exist in the domain
    expect(domain.table('memories').get(created.id)?.status).toBe('archived')
  })

  it('supports hot updateConfig, syncSearchIndex, undoDream, and full CRUD/exchange lifecycle', async () => {
    let nowMs = Date.parse('2026-11-24T00:00:00.000Z')
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({ domain, now: () => new Date(nowMs) })
    await engine.recover()

    const wsIdent = { key: WS_SCOPE.key, root: WS_SCOPE.root }
    await engine.write({ type: 'lesson', title: 'L1', body: 'alpha keyword one' }, wsIdent)
    await engine.write({ type: 'lesson', title: 'L2', body: 'alpha keyword two' }, wsIdent)

    expect(() => engine.updateConfig({ unknownKey: 1 } as never)).toThrow(OperationError)
    const updatedCfg = engine.updateConfig({ searchLimit: 1 })
    expect(updatedCfg.searchLimit).toBe(1)

    const hits = engine.search({ query: 'alpha', workspaceKey: WS_SCOPE.key })
    expect(hits.results).toHaveLength(1)
    expect(hits.total).toBe(2)
    expect(hits.truncated).toBe(true)

    // Out-of-band external record write + syncSearchIndex
    const external = (
      await engine.write({ type: 'wiki', title: 'W1', body: 'external reload marker' }, wsIdent)
    ).record
    await domain.table('memories').put(external.id, {
      ...external,
      body: 'external zeta token',
      contentRevision: external.contentRevision + 1,
    })
    engine.syncSearchIndex()
    expect(engine.search({ query: 'zeta', workspaceKey: WS_SCOPE.key }).total).toBe(1)

    // Undo dream restores prior state
    const ep = await engine.appendEpisode({
      sessionId: 's-undo',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'Undoable rule',
    })
    const prep = await engine.prepareDream({ scope: WS_SCOPE })
    const comm = await engine.commitDream({
      dreamId: prep.dreamId,
      memories: [
        {
          type: 'lesson',
          title: 'Undoable',
          body: 'Should be removed by undoDream',
          confidence: 0.8,
          importance: 0.7,
          sourceEpisodeIds: [ep!.id],
        },
      ],
    })
    expect(domain.table('memories').get(comm.createdIds[0]! as never)).toBeDefined()
    const undo = await engine.undoDream(prep.dreamId)
    expect(undo.undone).toBe(1)
    expect(domain.table('memories').get(comm.createdIds[0]! as never)).toBeUndefined()

    // Status, audit, restore, delete, retention, purge
    expect(engine.status().ready).toBe(true)
    expect(engine.audit({ workspaceKey: WS_SCOPE.key }).total).toBeGreaterThan(0)
    const restored = await engine.restore(
      (await engine.forget(external.id, wsIdent.key)).id,
      wsIdent.key,
    )
    expect(restored.status).toBe('active')
    const delRes = await engine.delete({
      id: restored.id,
      expectedContentRevision: restored.contentRevision,
      permanent: true,
      confirm: true,
      workspaceKey: wsIdent.key,
    })
    expect(delRes.deleted).toBe(true)

    nowMs += 1000
    const retention = await engine.runRetention()
    expect(retention.archivedWorklogs).toBe(0)
  })

  it('enforces worklogCapture=off in prepareDream/commitDream and includes pending proposals in related memories', async () => {
    const domain = createInMemoryDomain()
    const engine = new MemoryEngine({
      domain,
      config: { worklogCapture: 'off' },
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    })
    await engine.recover()

    await engine.manageCreate({
      type: 'lesson',
      title: 'Already queued pending lesson',
      body: 'Pending body.',
      scope: 'workspace',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      status: 'pending',
    })
    const ep = await engine.appendEpisode({
      sessionId: 's-off',
      workspaceKey: WS_SCOPE.key,
      workspaceRoot: WS_SCOPE.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'Fix build issue',
    })

    const prepared = await engine.prepareDream({ scope: WS_SCOPE })
    expect(prepared.systemPrompt).toContain('Do NOT output type "worklog"')
    expect(prepared.userPrompt).toContain('[lesson|pending] Already queued pending lesson')
    expect(JSON.stringify(prepared.outputSchema)).not.toContain('"worklog"')

    await expect(
      engine.commitDream({
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'worklog',
            title: 'Disallowed worklog',
            body: 'Should fail validation.',
            confidence: 0.9,
            importance: 0.5,
            sourceEpisodeIds: [ep!.id],
          },
        ],
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof OperationError && err.code === 'MEMORY_INVALID_CONTENT',
    )
  })
})
