import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../src/host/store.ts'
import { OperationError } from '../../src/host/operations.ts'
import { openMemory, openStore } from '../helpers/runner.ts'

const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

describe('memory store revisions and recovery gate', () => {
  it('increments contentRevision on business edits and not on statistics', async () => {
    const { store } = await openStore()
    const record = await store.create({
      type: 'lesson',
      title: 'Title',
      body: 'Body',
      scope: workspace,
    })
    expect(record.contentRevision).toBe(1)

    const updated = await store.update(record.id, { expectedContentRevision: 1, title: 'Title 2' })
    expect(updated.contentRevision).toBe(2)

    const matched = await store.recordMatch(record.id)
    expect(matched?.contentRevision).toBe(2)
    expect(matched?.matchCount).toBe(1)
    expect(matched?.statsRevision).toBe(1)
  })

  it('rejects a stale expectedContentRevision and keeps the original record', async () => {
    const { store } = await openStore()
    const record = await store.create({
      type: 'lesson',
      title: 'Title',
      body: 'Body',
      scope: workspace,
    })
    await store.update(record.id, { expectedContentRevision: 1, title: 'Title 2' })

    await expect(
      store.update(record.id, { expectedContentRevision: 1, title: 'Stale' }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(store.get(record.id)?.title).toBe('Title 2')
  })

  it('refuses global scope unless the memory is a preference', async () => {
    const { store } = await openStore()
    await expect(
      store.create({ type: 'lesson', title: 'G', body: 'B', scope: { kind: 'global' } }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN_SCOPE' })
  })

  it('throws MEMORY_RECOVERING before initialization completes', async () => {
    const { domain, runner } = await openMemory()
    const store = new MemoryStore(domain, runner)
    try {
      store.list({ workspaceKey: 'all', management: true })
      throw new Error('expected list to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError)
      expect((error as OperationError).code).toBe('MEMORY_RECOVERING')
    }
  })

  it('returns the original record for a duplicate requestId and persists one operation', async () => {
    const { store, domain } = await openStore()
    const input = {
      type: 'lesson' as const,
      title: 'dedupe',
      body: 'body',
      scope: workspace,
    }
    const first = await store.create(input, 'request-dedupe')
    const second = await store.create(input, 'request-dedupe')

    expect(second.id).toBe(first.id)
    expect(domain.table('memories').size).toBe(1)
    expect(domain.table('operations').size).toBe(1)
  })

  it('persists a confidence-only update and increments contentRevision', async () => {
    const { store } = await openStore()
    const record = await store.create({ type: 'lesson', title: 'C', body: 'B', scope: workspace })
    const updated = await store.update(record.id, {
      expectedContentRevision: 1,
      confidence: 0.1,
    })
    expect(updated.confidence).toBe(0.1)
    expect(updated.contentRevision).toBe(2)
  })

  it('rejects a derived memory without a source at the store boundary', async () => {
    const { store } = await openStore()
    await expect(
      store.create({
        type: 'lesson',
        title: 'derived',
        body: 'B',
        scope: workspace,
        origin: 'dream',
        ownership: 'derived',
      }),
    ).rejects.toThrow(/derived memory requires/)
  })

  it('rejects list({ workspaceKey: "all" }) without the management flag', async () => {
    const { store } = await openStore()
    expect(() => store.list({ workspaceKey: 'all' })).toThrowError(OperationError)
  })

  it('rejects an unbounded tag list before persistence', async () => {
    const { store } = await openStore()
    await expect(
      store.create({
        type: 'lesson',
        title: 'too many tags',
        body: 'b',
        scope: workspace,
        tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`),
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
  })

  it('keeps audit rows inside the undo window even above maxAuditRecords', async () => {
    const { domain, runner } = await openMemory({ maxAuditRecords: 1 })
    const store = new MemoryStore(domain, runner)
    await store.initialize()
    await store.create({ type: 'lesson', title: 'one', body: 'b', scope: workspace })
    await store.create({ type: 'lesson', title: 'two', body: 'b', scope: workspace })
    // Both rows are younger than the 30-day undo window, so none is pruned.
    expect(domain.table('audit').size).toBe(2)
  })

  it('stops accepting writes after stop()', async () => {
    const { store } = await openStore()
    store.stop()
    await expect(
      store.create({ type: 'lesson', title: 'stopped', body: 'b', scope: workspace }),
    ).rejects.toMatchObject({ code: 'MEMORY_STOPPED' })
  })

  it('dedupes an update requestId before the CAS check', async () => {
    const { store } = await openStore()
    const record = await store.create({ type: 'lesson', title: 'U', body: 'b', scope: workspace })
    const first = await store.update(
      record.id,
      { expectedContentRevision: 1, title: 'updated' },
      'request-update',
    )
    const second = await store.update(
      record.id,
      { expectedContentRevision: 1, title: 'updated' },
      'request-update',
    )
    expect(second.title).toBe(first.title)
    expect(second.contentRevision).toBe(2)
  })
})
