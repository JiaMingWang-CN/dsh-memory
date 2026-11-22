import { describe, expect, it } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CapacityPolicy } from '../../src/host/capacity.ts'
import { contentDigest, memoryDomain } from '../../src/host/domain.ts'
import { importMemories, type MemoryExport } from '../../src/host/exchange.ts'
import { OperationError, OperationRunner } from '../../src/host/operations.ts'
import { MemoryStore } from '../../src/host/store.ts'
import { AuditId, EpisodeId, MemoryId, type EpisodeRecord } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { FakeDomainFacility } from '../helpers/fake-domain.ts'
import { openService } from '../helpers/service.ts'

const WS_A = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }
const WS_A_ALT_ROOT = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a-symlink' }

async function openStore(options?: {
  now?: () => Date
  capacity?: CapacityPolicy
  maxAuditRecords?: number
}) {
  const facility = new FakeDomainFacility()
  const domain = (await facility.open(memoryDomain)) as unknown as Domain<typeof memoryDomain>
  const runner = new OperationRunner(domain, {
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.maxAuditRecords === undefined ? {} : { maxAuditRecords: options.maxAuditRecords }),
  })
  const store = new MemoryStore(domain, runner, {
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.capacity === undefined ? {} : { capacity: options.capacity }),
  })
  await store.initialize()
  return { domain, runner, store }
}

describe('Batch 1 audit regressions', () => {
  it('[H1] rebuild() and purgeAll() rebuild the in-memory SearchIndex so deleted records are not searchable', async () => {
    const facility = new FakeDomainFacility()
    const preDomain = (await facility.open(memoryDomain)) as unknown as Domain<typeof memoryDomain>
    // Seed a derived active record before boot so SearchIndex indexes it at startup.
    const derived = makeMemoryRecord({
      id: MemoryId('derived-hit'),
      type: 'lesson',
      scope: WS_A,
      origin: 'dream',
      ownership: 'derived',
      title: 'UniqueRebuildToken',
      body: 'UniqueRebuildToken body',
      status: 'active',
      sourceEpisodeIds: ['ep-1'],
    })
    await preDomain.table('memories').put(derived.id, derived)
    await preDomain.close()

    const host = await openService({ facility })
    try {
      const user = await host.service.create({
        type: 'lesson',
        scope: 'workspace',
        workspaceKey: WS_A.key,
        workspaceRoot: WS_A.root,
        title: 'UniquePurgeToken',
        body: 'UniquePurgeToken body',
      })
      expect(
        host.service.search({ query: 'UniqueRebuildToken', workspaceKey: WS_A.key }).results.length,
      ).toBe(1)
      expect(
        host.service.search({ query: 'UniquePurgeToken', workspaceKey: WS_A.key }).results.length,
      ).toBe(1)

      await host.service.rebuild({ scope: { workspaceKey: WS_A.key }, confirm: true })
      expect(
        host.service.search({ query: 'UniqueRebuildToken', workspaceKey: WS_A.key }).results,
      ).toEqual([])
      expect(
        host.service.search({ query: 'UniquePurgeToken', workspaceKey: WS_A.key }).results.length,
      ).toBe(1)

      await host.service.purgeAll({
        scope: { workspaceKey: WS_A.key },
        confirmText: `PURGE ${WS_A.key}`,
      })
      expect(
        host.service.search({ query: 'UniquePurgeToken', workspaceKey: WS_A.key }).results,
      ).toEqual([])
      expect(user.id).toBeTruthy()
    } finally {
      await host.dispose()
    }
  })

  it('[H2] failed replace import removes partially created rows and restores original snapshots preserving revision and stats', async () => {
    const capacity = new CapacityPolicy({
      maxActiveMemories: 2,
      maxArchivedMemories: 10,
      maxStoredMemories: 20,
    })
    const { store, domain } = await openStore({ capacity })
    const original = await store.create({
      id: MemoryId('orig-1'),
      type: 'lesson',
      title: 'Original',
      body: 'v1',
      scope: WS_A,
    })
    const updated = await store.update(original.id, {
      expectedContentRevision: 1,
      body: 'v2',
    })
    await store.recordUse(original.id)
    const beforeSnapshot = store.get(original.id)!
    expect(beforeSnapshot.contentRevision).toBe(2)
    expect(beforeSnapshot.useCount).toBe(1)

    // Inject a failure on the second replacement record.
    const realCreate = store.create.bind(store)
    let calls = 0
    ;(store as unknown as { create: typeof store.create }).create = async (input, requestId) => {
      calls += 1
      if (calls === 2) throw new Error('disk full mid-replace')
      return realCreate(input, requestId)
    }

    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: WS_A.key },
      includeArchived: true,
      memories: [
        makeMemoryRecord({ id: MemoryId('new-1'), title: 'New 1', body: 'b1', scope: WS_A }),
        makeMemoryRecord({ id: MemoryId('new-2'), title: 'New 2', body: 'b2', scope: WS_A }),
      ],
      episodes: [],
    }

    await expect(
      importMemories(store, domain, payload, {
        mode: 'replace',
        confirm: true,
        targetScope: { workspaceKey: WS_A.key },
        mapping: { 'ws-a': { key: WS_A.key, root: WS_A.root } },
      }),
    ).rejects.toThrow(/restored 1 previously deleted record/)

    // Partially inserted row must be gone.
    expect(store.get(MemoryId('new-1'))).toBeUndefined()
    // Restored snapshot preserves contentRevision and stats.
    const restored = store.get(updated.id)!
    expect(restored.body).toBe('v2')
    expect(restored.contentRevision).toBe(2)
    expect(restored.useCount).toBe(1)
  })

  it('[H3] retrying create with a requestId scrubbed by permanent delete throws MEMORY_CONFLICT instead of creating a ghost record', async () => {
    const { store } = await openStore()
    const created = await store.create(
      { type: 'lesson', title: 'Transient', body: 'to delete', scope: WS_A },
      'req-create-1',
    )
    await store.delete(created.id, { permanent: true, actor: 'user', confirm: true })
    expect(store.get(created.id)).toBeUndefined()

    await expect(
      store.create(
        { type: 'lesson', title: 'Transient', body: 'to delete', scope: WS_A },
        'req-create-1',
      ),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(store.counts().stored).toBe(0)
  })

  it('[H4] permanent delete with requestId is idempotent and rejects mismatched memory ids', async () => {
    const { store } = await openStore()
    const first = await store.create({
      type: 'lesson',
      title: 'Delete me',
      body: 'body',
      scope: WS_A,
    })
    const second = await store.create({
      type: 'lesson',
      title: 'Other',
      body: 'body',
      scope: WS_A,
    })

    const res1 = await store.delete(first.id, {
      permanent: true,
      actor: 'user',
      confirm: true,
      requestId: 'req-del-1',
    })
    expect(res1).toBeNull()
    expect(store.get(first.id)).toBeUndefined()

    // Replaying the same requestId for the same id succeeds idempotently.
    const res2 = await store.delete(first.id, {
      permanent: true,
      actor: 'user',
      confirm: true,
      requestId: 'req-del-1',
    })
    expect(res2).toBeNull()

    // Reusing the same requestId for a different memory id is rejected.
    await expect(
      store.delete(second.id, {
        permanent: true,
        actor: 'user',
        confirm: true,
        requestId: 'req-del-1',
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(store.get(second.id)).toBeDefined()
  })

  it('[H6] findActiveByTitle, findSemanticProposal and findSimilarProposal match workspace by key even when root differs', async () => {
    const { store } = await openStore()
    await store.create({
      type: 'lesson',
      title: 'Use pnpm',
      body: 'Always use pnpm in this repository for deterministic installs.',
      scope: WS_A,
      sourceEpisodeIds: ['ep-1'],
    })

    expect(store.findActiveByTitle(WS_A_ALT_ROOT, 'lesson', 'Use pnpm')).toBeDefined()
    expect(store.findSemanticProposal(WS_A_ALT_ROOT, 'lesson', 'Use pnpm', ['ep-1'])).toBeDefined()
    expect(
      store.findSimilarProposal(
        WS_A_ALT_ROOT,
        'lesson',
        'Always use pnpm in this repository for deterministic installs.',
      ),
    ).toBeDefined()
  })

  it('[H12] remoteImport honours redactSecrets=false consistently with explicit writes', async () => {
    const host = await openService({ config: { redactSecrets: false } })
    try {
      const secret = 'sk-1234567890abcdefghijklmnop'
      const payload: MemoryExport = {
        format: 'dsh-memory',
        version: 1,
        exportedAt: '2026-11-15T00:00:00.000Z',
        scope: { workspaceKey: WS_A.key },
        includeArchived: true,
        memories: [
          makeMemoryRecord({
            id: MemoryId('unredacted-1'),
            title: 'Token note',
            body: `Token ${secret}`,
            scope: WS_A,
          }),
        ],
        episodes: [],
      }
      const report = await host.service.remoteImport({
        payload,
        options: { mapping: { 'ws-a': { key: WS_A.key, root: WS_A.root } } },
      })
      expect(report.redacted).toBe(0)
      const stored = host.service.view({ id: 'unredacted-1' }).record
      expect(stored.body).toContain(secret)
    } finally {
      await host.dispose()
    }
  })

  it('[M1] validateCreateBatch allows exact capacity equality and skips archived check when no archived records are added', async () => {
    const capacity = new CapacityPolicy({
      maxActiveMemories: 2,
      maxArchivedMemories: 1,
      maxStoredMemories: 3,
    })
    const { store } = await openStore({ capacity })
    // Create 2 active first, then 1 archived (archived reaches cap=1, stored reaches cap=3).
    const a1 = await store.create({ type: 'lesson', title: 'A1', body: 'b1', scope: WS_A })
    const a2 = await store.create({ type: 'lesson', title: 'A2', body: 'b2', scope: WS_A })
    await store.create({
      type: 'lesson',
      title: 'Archived',
      body: 'arch',
      scope: WS_A,
      status: 'archived',
    })

    // Replacing 2 active with 2 active hits exact stored=3 and active=2 while archived=1 (addedArchived=0).
    expect(() =>
      store.validateCreateBatch(
        [a1, a2],
        [
          { type: 'lesson', title: 'N1', body: 'b1', scope: WS_A, status: 'active' },
          { type: 'lesson', title: 'N2', body: 'b2', scope: WS_A, status: 'active' },
        ],
      ),
    ).not.toThrow()
  })

  it('[M2] merge import deduplicates using post-redaction digest', async () => {
    const { store, domain } = await openStore()
    const secret = 'sk-1234567890abcdefghijklmnop'
    await store.create({
      type: 'lesson',
      title: 'Secret note',
      body: 'Use [REDACTED]',
      scope: WS_A,
      tags: [],
      importance: 0.5,
      pinned: false,
    })
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: WS_A.key },
      includeArchived: true,
      memories: [
        makeMemoryRecord({
          id: MemoryId('unredacted-dup'),
          title: 'Secret note',
          body: `Use ${secret}`,
          scope: WS_A,
          tags: [],
          importance: 0.5,
          pinned: false,
        }),
      ],
      episodes: [],
    }
    const report = await importMemories(store, domain, payload, {
      mode: 'merge',
      mapping: { 'ws-a': { key: WS_A.key, root: WS_A.root } },
    })
    expect(report.created).toBe(0)
    expect(report.skipped).toBe(1)
  })

  it('[M3] store.update enforces field bounds and wraps ZodError as MEMORY_INVALID_CONTENT', async () => {
    const { store, domain } = await openStore()
    const rec = await store.create({ type: 'lesson', title: 'Valid', body: 'body', scope: WS_A })
    await expect(
      store.update(rec.id, { expectedContentRevision: 1, title: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
    await expect(
      store.update(rec.id, {
        expectedContentRevision: 1,
        tags: Array.from({ length: 33 }, (_, i) => `t${i}`),
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })

    const badPayload = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: 'all',
      includeArchived: true,
      memories: [{ id: 'broken' }],
      episodes: [],
    } as unknown as MemoryExport
    await expect(importMemories(store, domain, badPayload)).rejects.toMatchObject({
      code: 'MEMORY_INVALID_CONTENT',
    })
  })

  it('[M4] imported episodes redact failureMessage/outcome/lastError/files and reset processing status', async () => {
    const { store, domain } = await openStore()
    const secret = 'sk-1234567890abcdefghijklmnop'
    const episode: EpisodeRecord = {
      id: EpisodeId('ep-imp-1'),
      sessionId: 'remote-sess',
      workspaceKey: 'ws-a',
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      status: 'processing',
      dreamId: 'dream-old',
      attempts: 1,
      turn: 1,
      sourceSeqs: [1, 2],
      files: [`src/${secret}.ts`],
      outcome: `done with ${secret}`,
      failureMessage: `err ${secret}`,
      lastError: `last ${secret}`,
      createdAt: '2026-11-15T00:00:00.000Z',
    }
    const payload: MemoryExport = {
      format: 'dsh-memory',
      version: 1,
      exportedAt: '2026-11-15T00:00:00.000Z',
      scope: { workspaceKey: 'ws-a' },
      includeArchived: true,
      memories: [],
      episodes: [episode],
    }
    await importMemories(store, domain, payload, {
      mapping: { 'ws-a': { key: WS_A.key, root: WS_A.root } },
    })
    const stored = store.getEpisode(EpisodeId('ep-imp-1'))!
    expect(stored.status).toBe('new')
    expect(stored.dreamId).toBeUndefined()
    expect(stored.files[0]).not.toContain(secret)
    expect(stored.outcome).not.toContain(secret)
    expect(stored.failureMessage).not.toContain(secret)
    expect(stored.lastError).not.toContain(secret)
  })

  it('[L1] acceptProposal deduplicates supersedes before checking active capacity', async () => {
    const capacity = new CapacityPolicy({
      maxActiveMemories: 1,
      maxArchivedMemories: 10,
      maxStoredMemories: 20,
    })
    const { store } = await openStore({ capacity })
    const old = await store.create({
      id: MemoryId('old-1'),
      type: 'lesson',
      title: 'Old',
      body: 'old',
      scope: WS_A,
    })
    const proposal = await store.create({
      id: MemoryId('prop-1'),
      type: 'lesson',
      title: 'New',
      body: 'new',
      scope: WS_A,
      status: 'pending',
      supersedes: [old.id, old.id],
    })
    const accepted = await store.acceptProposal(proposal.id)
    expect(accepted.status).toBe('active')
    expect(store.get(old.id)?.status).toBe('archived')
  })

  it('[L2] contentDigest reflects changes in type, confidence and sourceRefs', () => {
    const base = makeMemoryRecord({ type: 'lesson', confidence: 0.8, sourceRefs: [] })
    expect(contentDigest({ ...base, type: 'wiki' })).not.toBe(contentDigest(base))
    expect(contentDigest({ ...base, confidence: 0.95 })).not.toBe(contentDigest(base))
    expect(
      contentDigest({ ...base, sourceRefs: [{ sessionId: 's1', turn: 1, quote: 'q' }] }),
    ).not.toBe(contentDigest(base))
  })

  it('[L3] pruneAudit prunes old undone audit rows outside the 30-day undo window', async () => {
    const currentTime = Date.parse('2026-12-30T00:00:00.000Z')
    const { store, domain } = await openStore({
      now: () => new Date(currentTime),
      maxAuditRecords: 2,
    })
    // Seed two old undone audit rows (> 30 days ago).
    for (const id of ['a-old-1', 'a-old-2']) {
      await domain.table('audit').put(AuditId(id), {
        id: AuditId(id),
        operationId: `op-${id}`,
        action: 'create',
        actor: 'user',
        status: 'undone',
        at: '2026-10-01T00:00:00.000Z',
        before: null,
        after: null,
      })
    }
    // Trigger one new audit write -> pruneAudit runs and trims old undone rows.
    await store.create({ type: 'lesson', title: 'Fresh', body: 'fresh', scope: WS_A })
    expect(domain.table('audit').size).toBeLessThanOrEqual(2)
  })

  it('[L4] null/non-object RPC payloads and bad export format/version return memory/invalid', async () => {
    const host = await openService()
    try {
      expect(() => host.service.view(null as unknown as { id: string })).toThrow(
        expect.objectContaining({ code: 'memory/invalid' }),
      )
      await expect(
        host.service.remoteImport({
          payload: {
            format: 'wrong',
            version: 2,
            memories: [],
            episodes: [],
          } as unknown as MemoryExport,
        }),
      ).rejects.toMatchObject({ code: 'memory/invalid' })
      const { store, domain } = await openStore()
      await expect(
        importMemories(store, domain, {
          format: 'wrong',
          version: 99,
          memories: [],
          episodes: [],
        } as unknown as MemoryExport),
      ).rejects.toBeInstanceOf(OperationError)
    } finally {
      await host.dispose()
    }
  })
})
