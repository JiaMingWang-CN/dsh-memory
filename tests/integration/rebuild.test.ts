import { describe, expect, it } from 'vitest'
import { EpisodeId, type EpisodeRecord, type SessionCursor } from '../../src/shared/types.ts'
import { rebuild } from '../../src/host/exchange.ts'
import { openStore } from '../helpers/runner.ts'

const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

describe('rebuild', () => {
  it('deletes only derived unreviewed unpinned memories and resets scope rows', async () => {
    const { store, domain, runner } = await openStore()
    const accepted = await store.create({
      type: 'lesson',
      title: 'accepted',
      body: 'x',
      scope: workspace,
      origin: 'dream',
      ownership: 'user',
      reviewedByUserAt: '2026-11-15T00:00:00.000Z',
    })
    const derived = await store.create({
      type: 'lesson',
      title: 'derived',
      body: 'x',
      scope: workspace,
      origin: 'dream',
      ownership: 'derived',
      sourceEpisodeIds: ['episode-derived'],
    })
    const pinnedDerived = await store.create({
      type: 'lesson',
      title: 'pinned-derived',
      body: 'x',
      scope: workspace,
      origin: 'dream',
      ownership: 'derived',
      pinned: true,
      sourceEpisodeIds: ['episode-pinned'],
    })
    const explicit = await store.create({
      type: 'lesson',
      title: 'explicit',
      body: 'x',
      scope: workspace,
    })

    const episode: EpisodeRecord = {
      id: EpisodeId('e1'),
      sessionId: 's1',
      workspaceKey: 'ws-a',
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      status: 'new',
      attempts: 0,
      turn: 1,
      sourceSeqs: [1],
      files: [],
      createdAt: '2026-11-15T00:00:00.000Z',
    }
    await domain.table('episodes').put(episode.id, episode)
    const cursor: SessionCursor = {
      sessionId: 's1',
      workspaceKey: 'ws-a',
      lastProcessedSeq: 5,
      lastProcessedAt: '2026-11-15T00:00:00.000Z',
    }
    await domain.table('session_cursors').put('s1', cursor)

    const report = await rebuild(domain, runner, { scope: 'all', confirm: true })
    expect(report.deleted).toBe(1)
    expect(store.get(derived.id)).toBeUndefined()
    expect(store.get(accepted.id)?.reviewedByUserAt).toBe('2026-11-15T00:00:00.000Z')
    expect(store.get(pinnedDerived.id)).toBeDefined()
    expect(store.get(explicit.id)).toBeDefined()
    expect(domain.table('episodes').size).toBe(0)
    expect(domain.table('session_cursors').size).toBe(0)
    const rebuildOperations = [...domain.table('operations').entries()].filter(
      ([, operation]) => operation.kind === 'rebuild',
    )
    expect(rebuildOperations).toHaveLength(1)
    expect(rebuildOperations[0]![1].status).toBe('committed')
  })

  it('requires explicit confirmation', async () => {
    const { domain, runner } = await openStore()
    await expect(rebuild(domain, runner, { scope: 'all' })).rejects.toMatchObject({
      code: 'MEMORY_FORBIDDEN',
    })
  })
})
