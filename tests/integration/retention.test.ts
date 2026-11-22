import { describe, expect, it } from 'vitest'
import { EpisodeId, type EpisodeRecord } from '../../src/shared/types.ts'
import { openStore } from '../helpers/runner.ts'

const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

describe('retention', () => {
  it('archives old turn worklogs and deletes old processed episodes', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const { store, domain } = await openStore({
      now: () => clock,
      worklogRetentionDays: 30,
      episodeRetentionDays: 30,
    })
    const worklog = await store.create({
      type: 'worklog',
      worklogKind: 'turn',
      title: 'old turn',
      body: 'body',
      scope: workspace,
    })
    const episode: EpisodeRecord = {
      id: EpisodeId('episode-old'),
      sessionId: 's1',
      workspaceKey: 'ws-a',
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      status: 'processed',
      attempts: 0,
      turn: 1,
      sourceSeqs: [1],
      files: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      processedAt: '2026-01-01T00:00:00.000Z',
    }
    await domain.table('episodes').put(episode.id, episode)

    clock = new Date('2026-03-01T00:00:00.000Z')
    const result = await store.applyRetention()
    expect(result.archivedWorklogs).toBe(1)
    expect(result.deletedEpisodes).toBe(1)
    expect(store.get(worklog.id)?.status).toBe('archived')
    expect(domain.table('episodes').get(episode.id)).toBeUndefined()
  })

  it('purges archived memories under the age policy', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const { store } = await openStore({
      now: () => clock,
      archivePurgePolicy: 'age',
      archiveRetentionDays: 1,
    })
    const record = await store.create({ type: 'lesson', title: 'old', body: 'x', scope: workspace })
    await store.archive(record.id)
    clock = new Date('2026-01-03T00:00:00.000Z')
    const result = await store.applyRetention()
    expect(result.purgedArchives).toBe(1)
    expect(store.get(record.id)).toBeUndefined()
  })

  it('purges archived memories only after an explicit export under after-export', async () => {
    const { store } = await openStore({ archivePurgePolicy: 'after-export' })
    const record = await store.create({
      type: 'lesson',
      title: 'exported',
      body: 'x',
      scope: workspace,
    })
    await store.archive(record.id)
    expect(await store.purgeArchivedAfterExport()).toBe(1)
    expect(store.get(record.id)).toBeUndefined()
  })

  it('limits the after-export purge to the exported scope', async () => {
    const { store } = await openStore({ archivePurgePolicy: 'after-export' })
    const workspaceB = { kind: 'workspace' as const, key: 'ws-b', root: 'C:/ws/b' }
    const inScope = await store.create({ type: 'lesson', title: 'a', body: 'x', scope: workspace })
    const outside = await store.create({ type: 'lesson', title: 'b', body: 'y', scope: workspaceB })
    await store.archive(inScope.id)
    await store.archive(outside.id)

    expect(await store.purgeArchivedAfterExport({ workspaceKey: 'ws-a' })).toBe(1)
    expect(store.get(inScope.id)).toBeUndefined()
    expect(store.get(outside.id)?.status).toBe('archived')
  })

  it('never automatically archives or purges pinned records', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const { store } = await openStore({
      now: () => clock,
      worklogRetentionDays: 1,
      archivePurgePolicy: 'age',
      archiveRetentionDays: 1,
    })
    const pinnedTurn = await store.create({
      type: 'worklog',
      worklogKind: 'turn',
      title: 'pinned turn',
      body: 'x',
      scope: workspace,
      pinned: true,
    })
    const pinnedArchived = await store.create({
      type: 'lesson',
      title: 'pinned archived',
      body: 'y',
      scope: workspace,
      pinned: true,
    })
    await store.archive(pinnedArchived.id)

    clock = new Date('2026-01-10T00:00:00.000Z')
    const result = await store.applyRetention()
    expect(result.archivedWorklogs).toBe(0)
    expect(result.purgedArchives).toBe(0)
    expect(store.get(pinnedTurn.id)?.status).toBe('active')
    expect(store.get(pinnedArchived.id)?.status).toBe('archived')

    // The after-export policy honours the same protection.
    expect(await store.purgeArchivedAfterExport()).toBe(0)
    expect(store.get(pinnedArchived.id)).toBeDefined()
  })
})
