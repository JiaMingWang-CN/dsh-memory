import { describe, expect, it } from 'vitest'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { openStore } from '../helpers/runner.ts'
import { scriptedLlm } from '../helpers/dream-llm.ts'

type Store = Awaited<ReturnType<typeof openStore>>['store']
type Runner = Awaited<ReturnType<typeof openStore>>['runner']

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

function twoMemoryJson(episodeIds: readonly string[]): string {
  return JSON.stringify({
    memories: [
      {
        type: 'lesson',
        title: 'Lesson one',
        body: 'first body',
        confidence: 0.8,
        importance: 0.5,
        sourceEpisodeIds: [episodeIds[0]],
      },
      {
        type: 'lesson',
        title: 'Lesson two',
        body: 'second body',
        confidence: 0.8,
        importance: 0.5,
        sourceEpisodeIds: [episodeIds[1]],
      },
    ],
  })
}

async function runDream(store: Store, runner: Runner, response: string) {
  const dreamer = new MemoryDreamer({
    store,
    runner,
    config: resolveMemoryConfig({}),
    llm: scriptedLlm([response]),
  })
  const dream = await dreamer.enqueue({
    scopeKey: 'ws-a',
    scopeKind: 'workspace',
    scopeRoot: 'C:/ws/a',
    trigger: 'manual',
  })
  await dreamer.flush()
  return dream.id
}

describe('undo dream', () => {
  it('rolls back the pending proposals of one dream and marks the audit undone', async () => {
    const { store, runner } = await openStore()
    const first = await addEpisode(store, 1)
    const second = await addEpisode(store, 2)
    const dreamId = await runDream(store, runner, twoMemoryJson([first.id, second.id]))
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(2)

    const report = await runner.undoDream(dreamId)
    expect(report.undone).toBe(2)
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(0)
    for (const record of pending) {
      const audits = store.auditList({ memoryId: record.id, limit: 10 })
      expect(audits.items.some((item) => item.status === 'undone')).toBe(true)
    }
  })
})

describe('undo same-proposal chain', () => {
  it('undoes a create followed by an update of the same pending proposal', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store, 1)
    const response = JSON.stringify({
      memories: [
        {
          type: 'lesson',
          title: 'Same title',
          body: 'body one',
          confidence: 0.8,
          importance: 0.5,
          sourceEpisodeIds: [episode.id],
        },
        {
          type: 'lesson',
          title: 'Same title',
          body: 'body two',
          confidence: 0.8,
          importance: 0.5,
          sourceEpisodeIds: [episode.id],
        },
      ],
    })
    const dreamId = await runDream(store, runner, response)
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    expect(pending[0]?.body).toBe('body two')
    expect(pending[0]?.contentRevision).toBe(2)

    const report = await runner.undoDream(dreamId)
    expect(report.undone).toBe(2)
    expect(report.skipped).toBe(0)
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(0)
  })
})

describe('undo skips edited', () => {
  it('skips a memory edited after the dream and rolls back the rest', async () => {
    const { store, runner } = await openStore()
    const first = await addEpisode(store, 1)
    const second = await addEpisode(store, 2)
    const dreamId = await runDream(store, runner, twoMemoryJson([first.id, second.id]))
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    const edited = pending.find((record) => record.body === 'first body')!
    await store.update(edited.id, {
      expectedContentRevision: edited.contentRevision,
      body: 'user edited body',
    })

    const report = await runner.undoDream(dreamId)
    expect(report.skipped).toBe(1)
    expect(report.undone).toBe(1)
    expect(store.get(edited.id)?.body).toBe('user edited body')
    const remaining = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(edited.id)
  })
})

describe('undo stats ok', () => {
  it('still undoes a memory whose only change is match statistics', async () => {
    const { store, runner } = await openStore()
    const first = await addEpisode(store, 1)
    const second = await addEpisode(store, 2)
    const dreamId = await runDream(store, runner, twoMemoryJson([first.id, second.id]))
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    await store.recordMatch(pending[0]!.id)

    const report = await runner.undoDream(dreamId)
    expect(report.undone).toBe(2)
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(0)
  })
})
