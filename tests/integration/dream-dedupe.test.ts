import { describe, expect, it } from 'vitest'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { computeProposalKey } from '../../src/host/proposal.ts'
import { openStore } from '../helpers/runner.ts'
import { scriptedLlm } from '../helpers/dream-llm.ts'
import { openService } from '../helpers/service.ts'

const scope = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

type Store = Awaited<ReturnType<typeof openStore>>['store']

async function addEpisode(store: Store, turn: number) {
  const episode = await store.appendEpisode({
    sessionId: 's1',
    workspaceKey: 'ws-a',
    workspaceRoot: 'C:/ws/a',
    kind: 'turn',
    turn,
    sourceSeqs: [turn],
    prompt: 'work',
    outcome: 'completed',
    files: [],
  })
  if (episode === undefined) throw new Error('episode missing')
  return episode
}

async function runDream(
  store: Store,
  runner: Awaited<ReturnType<typeof openStore>>['runner'],
  response: string,
) {
  const dreamer = new MemoryDreamer({
    store,
    runner,
    config: resolveMemoryConfig({}),
    llm: scriptedLlm([response]),
  })
  await dreamer.enqueue({
    scopeKey: 'ws-a',
    scopeKind: 'workspace',
    scopeRoot: 'C:/ws/a',
    trigger: 'manual',
  })
  await dreamer.flush()
}

describe('duplicate exact', () => {
  it('does not create a second record for an existing proposalKey and marks the episode processed', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store, 1)
    const key = computeProposalKey({
      type: 'lesson',
      scope,
      title: 'Shared title',
      body: 'Shared body',
      confidence: 0.8,
      importance: 0.5,
      sourceEpisodeIds: [episode.id],
    })
    await store.create({
      type: 'lesson',
      title: 'Seeded',
      body: 'seeded body',
      scope,
      origin: 'dream',
      ownership: 'derived',
      status: 'pending',
      proposalKey: key,
      sourceEpisodeIds: [episode.id],
    })
    await runDream(
      store,
      runner,
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Shared title',
            body: 'Shared body',
            confidence: 0.8,
            importance: 0.5,
            sourceEpisodeIds: [episode.id],
          },
        ],
      }),
    )
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(1)
    expect(store.getEpisode(episode.id)?.status).toBe('processed')
  })
})

describe('duplicate semantic pending', () => {
  it('updates the existing pending instead of creating a new one', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store, 1)
    const seeded = await store.create({
      type: 'lesson',
      title: 'Same title',
      body: 'old body',
      scope,
      origin: 'dream',
      ownership: 'derived',
      status: 'pending',
      proposalKey: 'seed',
      sourceEpisodeIds: [episode.id],
    })
    await runDream(
      store,
      runner,
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Same title',
            body: 'new body',
            confidence: 0.9,
            importance: 0.7,
            sourceEpisodeIds: [episode.id],
          },
        ],
      }),
    )
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    const updated = store.get(seeded.id)
    expect(updated?.body).toBe('new body')
    expect(updated?.contentRevision).toBe(2)
  })
})

describe('duplicate semantic active', () => {
  it('skips an active duplicate without changing it', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store, 1)
    const seeded = await store.create({
      type: 'lesson',
      title: 'Same title',
      body: 'active body',
      scope,
      origin: 'dream',
      ownership: 'derived',
      status: 'active',
      proposalKey: 'seed',
      sourceEpisodeIds: [episode.id],
    })
    await runDream(
      store,
      runner,
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Same title',
            body: 'new body',
            confidence: 0.9,
            importance: 0.7,
            sourceEpisodeIds: [episode.id],
          },
        ],
      }),
    )
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(0)
    expect(store.get(seeded.id)?.body).toBe('active body')
    expect(store.getEpisode(episode.id)?.status).toBe('processed')
  })
})

describe('duplicate body merge', () => {
  it('merges a near-identical body into the existing pending proposal', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store, 1)
    const seeded = await store.create({
      type: 'lesson',
      title: 'Older wording',
      body: 'run typecheck before build to avoid broken builds',
      scope,
      origin: 'dream',
      ownership: 'derived',
      status: 'pending',
      proposalKey: 'seed',
      sourceEpisodeIds: [episode.id],
    })
    await runDream(
      store,
      runner,
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Newer wording',
            body: 'run typecheck before build to avoid broken builds',
            confidence: 0.9,
            importance: 0.7,
            sourceEpisodeIds: [episode.id],
          },
        ],
      }),
    )
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    expect(store.get(seeded.id)?.title).toBe('Newer wording')
  })
})

describe('proposal no user key', () => {
  it('leaves proposalKey empty for an explicit user write', async () => {
    const host = await openService()
    const result = await host.service.write(
      { type: 'lesson', title: 'User fact', body: 'body' },
      { key: 'ws-a', root: 'C:/ws/a' },
    )
    expect(result.record.proposalKey).toBeUndefined()
    await host.dispose()
  })
})
