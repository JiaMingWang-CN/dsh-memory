import { describe, expect, it } from 'vitest'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { openStore } from '../helpers/runner.ts'
import { dreamJson, scriptedLlm } from '../helpers/dream-llm.ts'

describe('dream replay (integration)', () => {
  it('replays a fixed model answer into a pending proposal with a dream-commit audit', async () => {
    const { store, runner } = await openStore()
    const episode = await store.appendEpisode({
      sessionId: 'sess-1',
      workspaceKey: 'ws-a',
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1, 2],
      prompt: 'typecheck then build',
      assistantFinal: 'ran both',
      outcome: 'completed',
      files: ['C:/ws/a/src/x.ts'],
    })
    if (episode === undefined) throw new Error('episode missing')

    const llm = scriptedLlm([dreamJson([episode.id])])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
    })
    const queued = await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    expect(queued.status).toBe('queued')
    await dreamer.flush()

    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    const record = pending[0]!
    expect(record.proposalKey).toBeTruthy()
    expect(record.sourceEpisodeIds).toContain(episode.id)
    const audits = store.auditList({ memoryId: record.id, limit: 10 })
    expect(
      audits.items.some((item) => item.action === 'dream-commit' && item.actor === 'dream'),
    ).toBe(true)
    expect(store.dreamList()[0]?.status).toBe('completed')
  })
})
