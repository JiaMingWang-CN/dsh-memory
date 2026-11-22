import { describe, expect, it } from 'vitest'
import { CapacityPolicy } from '../../src/host/capacity.ts'
import { openStore } from '../helpers/runner.ts'

const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

const makeCreate = (title: string, importance: number, pinned = false, derived = false) => ({
  type: 'lesson' as const,
  title,
  body: 'body',
  scope: workspace,
  importance,
  pinned,
  // Dream output is `derived` and may be demoted automatically; a plain create
  // is user-owned and must never be archived by the capacity policy. A derived
  // record also needs a source reference to satisfy the record schema.
  ...(derived ? { origin: 'dream' as const, sourceRefs: [{ sessionId: 'session-1' }] } : {}),
})

describe('capacity policy', () => {
  it('archives the lowest importance derived record when active overflows', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 2,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy })
    const low = await store.create(makeCreate('low', 0.2, false, true))
    const high = await store.create(makeCreate('high', 0.9, false, true))
    const mid = await store.create(makeCreate('mid', 0.5, false, true))

    expect(store.get(low.id)?.status).toBe('archived')
    expect(store.get(high.id)?.status).toBe('active')
    expect(store.get(mid.id)?.status).toBe('active')
  })

  it('never archives a pinned record', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 1,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy })
    const pinned = await store.create(makeCreate('pinned', 0.01, true, true))
    await expect(store.create(makeCreate('other', 0.5, false, true))).rejects.toMatchObject({
      code: 'MEMORY_CAPACITY',
    })
    expect(store.get(pinned.id)?.status).toBe('active')
  })

  it('never archives a user-owned record and refuses the write instead', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 1,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy })
    const owned = await store.create(makeCreate('owned', 0.1))

    await expect(store.create(makeCreate('dream output', 0.9, false, true))).rejects.toMatchObject({
      code: 'MEMORY_CAPACITY',
    })
    expect(store.get(owned.id)?.status).toBe('active')
  })

  it('rejects a restore that would exceed the active cap', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 1,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy })
    const first = await store.create(makeCreate('first', 0.5))
    await store.archive(first.id)
    await store.create(makeCreate('second', 0.5))

    await expect(store.restore(first.id)).rejects.toMatchObject({ code: 'MEMORY_CAPACITY' })
    expect(store.get(first.id)?.status).toBe('archived')
  })

  it('rejects an Accept that cannot fit without archiving anything first', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 1,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy })
    const active = await store.create(makeCreate('active', 0.5))
    const proposal = await store.create({
      type: 'lesson',
      title: 'proposal',
      body: 'pending body',
      scope: workspace,
      origin: 'dream',
      ownership: 'derived',
      status: 'pending',
      sourceEpisodeIds: ['episode-1'],
    })

    await expect(store.acceptProposal(proposal.id)).rejects.toMatchObject({
      code: 'MEMORY_CAPACITY',
    })
    // The failed Accept must not leave partial side effects.
    expect(store.get(active.id)?.status).toBe('active')
    expect(store.get(proposal.id)?.status).toBe('pending')
  })

  it('counts the archived superseded records as freed space when accepting', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 1,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy })
    const active = await store.create(makeCreate('active', 0.5))
    const proposal = await store.create({
      type: 'lesson',
      title: 'proposal',
      body: 'pending body',
      scope: workspace,
      origin: 'dream',
      ownership: 'derived',
      status: 'pending',
      sourceEpisodeIds: ['episode-1'],
      supersedes: [active.id],
    })

    const accepted = await store.acceptProposal(proposal.id)
    expect(accepted.status).toBe('active')
    expect(store.get(active.id)?.status).toBe('archived')
  })

  it('rejects new records once the stored hard cap is reached but keeps updates working', async () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 100,
      maxArchivedMemories: 100,
      maxStoredMemories: 2,
    })
    const { store } = await openStore({ capacity: policy })
    const first = await store.create(makeCreate('one', 0.5))
    await store.create(makeCreate('two', 0.5))

    await expect(store.create(makeCreate('three', 0.5))).rejects.toMatchObject({
      code: 'MEMORY_CAPACITY',
    })
    const updated = await store.update(first.id, { expectedContentRevision: 1, body: 'changed' })
    expect(updated.body).toBe('changed')
  })

  it('rejects episode capture when the queued episode cap is reached', () => {
    const policy = new CapacityPolicy({
      maxActiveMemories: 100,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
      maxQueuedEpisodes: 2,
    })
    expect(() =>
      policy.checkEpisodeQueue({
        active: 0,
        archived: 0,
        pending: 0,
        stored: 0,
        queuedEpisodes: 2,
        auditRecords: 0,
        operationRecords: 0,
      }),
    ).toThrowError(/queued episode/)
  })

  it('breaks an importance tie by archiving the oldest derived record first', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const policy = new CapacityPolicy({
      maxActiveMemories: 2,
      maxArchivedMemories: 100,
      maxStoredMemories: 100,
    })
    const { store } = await openStore({ capacity: policy, now: () => now })
    const first = await store.create(makeCreate('first', 0.5, false, true))
    now = new Date('2026-02-01T00:00:00.000Z')
    const second = await store.create(makeCreate('second', 0.5, false, true))
    now = new Date('2026-03-01T00:00:00.000Z')
    await store.create(makeCreate('third', 0.5, false, true))

    expect(store.get(first.id)?.status).toBe('archived')
    expect(store.get(second.id)?.status).toBe('active')
  })
})
