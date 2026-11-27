import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MemoryDreamer, type DreamLlm } from '../../src/host/dreamer.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { openStore } from '../helpers/runner.ts'
import { dreamJson, scriptedLlm } from '../helpers/dream-llm.ts'

async function addEpisode(
  store: Awaited<ReturnType<typeof openStore>>['store'],
  turn = 1,
  files: string[] = [],
) {
  const episode = await store.appendEpisode({
    sessionId: 's1',
    workspaceKey: 'ws-a',
    workspaceRoot: 'C:/ws/a',
    kind: 'turn',
    turn,
    sourceSeqs: [turn],
    prompt: 'run the build',
    outcome: 'completed',
    files,
  })
  if (episode === undefined) throw new Error('episode was not stored')
  return episode
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function promptText(call: GenerateOptions | undefined): string {
  const message = call?.messages[0] as unknown as
    { content: { type: string; text?: string }[] } | undefined
  return message?.content.map((block) => block.text ?? '').join('\n') ?? ''
}

describe('dream related search', () => {
  it('uses the related-search hook and renders the memory id in the prompt', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const memory = await store.create({
      type: 'lesson',
      title: 'existing rule',
      body: 'existing body',
      scope: { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' },
    })
    const llm = scriptedLlm([dreamJson([episode.id])])
    const queries: string[] = []
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
      relatedSearch: (input) => {
        queries.push(input.query)
        return [memory]
      },
    })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    expect(queries).toHaveLength(1)
    expect(promptText(llm.calls[0])).toContain(`id: ${memory.id}`)
  })
})

describe('dream organize', () => {
  it('proposes merges that supersede existing memories and archives every target on accept', async () => {
    const { store, runner } = await openStore()
    const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }
    const first = await store.create({
      type: 'lesson',
      title: 'rule a',
      body: 'body a',
      scope: workspace,
    })
    const second = await store.create({
      type: 'lesson',
      title: 'rule b',
      body: 'body b',
      scope: workspace,
    })
    const llm = scriptedLlm([
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'merged rule',
            body: 'merged body',
            confidence: 0.9,
            importance: 0.7,
            supersedes: [first.id, second.id],
          },
        ],
        wikiUpdates: [],
      }),
    ])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
    })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'organize',
    })
    await dreamer.flush()

    expect(store.dreamList()[0]?.trigger).toBe('organize')
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    expect(pending[0]?.supersedes).toEqual([first.id, second.id])

    const accepted = await store.acceptProposal(pending[0]!.id)
    expect(accepted.status).toBe('active')
    expect(store.get(first.id)?.status).toBe('archived')
    expect(store.get(second.id)?.status).toBe('archived')
  })
})

describe('dream pending', () => {
  it('writes every valid output as a pending derived dream memory', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm([dreamJson([episode.id])])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
    })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    expect(store.dreamList()[0]?.status).toBe('completed')
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    expect(pending[0]?.origin).toBe('dream')
    expect(pending[0]?.ownership).toBe('derived')
    expect(pending[0]?.status).toBe('pending')
    expect(store.getEpisode(episode.id)?.status).toBe('processed')
  })
})

describe('dream model fixed', () => {
  it('uses the configured provider and model', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm([dreamJson([episode.id])])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({
        dreamModelMode: 'fixed',
        dreamProvider: 'prov',
        dreamModel: 'm1',
      }),
      llm,
    })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    expect(llm.calls[0]?.provider).toBe('prov')
    expect(llm.calls[0]?.model).toBe('m1')
  })
})

describe('dream model follow', () => {
  it('uses the session selection and reasoning effort', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm([dreamJson([episode.id])])
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
      modelSelection: { provider: 'sess', model: 'm2', reasoningEffort: 'high' },
    })
    await dreamer.flush()

    expect(llm.calls[0]?.provider).toBe('sess')
    expect(llm.calls[0]?.model).toBe('m2')
    expect(llm.calls[0]?.reasoningEffort).toBe('high')
  })
})

describe('dream invalid json', () => {
  it('fails the run and releases the episodes as failed-retryable', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm(['not json', 'still not json'])
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    expect(store.dreamList()[0]?.status).toBe('failed')
    expect(store.getEpisode(episode.id)?.status).toBe('failed-retryable')
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(0)
  })
})

describe('dream max episodes', () => {
  it('processes only dreamMaxEpisodes and leaves the rest new', async () => {
    const { store, runner } = await openStore()
    const ids: string[] = []
    for (let index = 1; index <= 50; index += 1) {
      const episode = await addEpisode(store, index)
      ids.push(episode.id)
    }
    const llm = scriptedLlm([dreamJson(ids.slice(0, 40))])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({ dreamMaxEpisodes: 40 }),
      llm,
    })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    expect(store.episodeList({ statuses: ['processed'] })).toHaveLength(40)
    expect(store.episodeList({ statuses: ['new'] })).toHaveLength(10)
  })
})

describe('dream cancellation', () => {
  it('does not commit a late successful model answer after cancel', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const started = deferred()
    const finish = deferred()
    const llm: DreamLlm = {
      stream(): AsyncIterable<StreamChunk> {
        started.resolve()
        async function* generate(): AsyncGenerator<StreamChunk> {
          await finish.promise
          yield { type: 'text-delta', index: 0, text: dreamJson([episode.id]) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return generate()
      },
    }
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    const dream = await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await started.promise

    expect(await dreamer.cancel(dream.id)).toBe(true)
    finish.resolve()
    await dreamer.flush()

    expect(store.getDream(dream.id)?.status).toBe('cancelled')
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(0)
    expect(store.getEpisode(episode.id)?.status).toBe('failed-retryable')
  })

  it('releases claimed episodes when the aborted model call throws', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const started = deferred()
    const llm: DreamLlm = {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        started.resolve()
        async function* generate(): AsyncGenerator<StreamChunk> {
          const signal = options.signal
          if (signal?.aborted) throw new Error('dream model call aborted')
          await new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('dream model call aborted')), {
              once: true,
            })
          })
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return generate()
      },
    }
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    const dream = await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await started.promise

    expect(await dreamer.cancel(dream.id)).toBe(true)
    await dreamer.flush()

    expect(store.getDream(dream.id)?.status).toBe('cancelled')
    expect(store.getEpisode(episode.id)?.status).toBe('failed-retryable')
    expect(store.episodeList({ statuses: ['processing'] })).toHaveLength(0)
  })

  it('stops writing further proposals when the signal aborts mid-persist', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm([
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'First lesson',
            body: 'First body.',
            confidence: 0.8,
            importance: 0.5,
            sourceEpisodeIds: [episode.id],
          },
          {
            type: 'lesson',
            title: 'Second lesson',
            body: 'Second body.',
            confidence: 0.8,
            importance: 0.5,
            sourceEpisodeIds: [episode.id],
          },
        ],
        wikiUpdates: [],
      }),
    ])
    const hooks: { dreamer?: MemoryDreamer; dreamId: string } = { dreamId: '' }
    let writes = 0
    const original = store.writeDreamProposal.bind(store)
    store.writeDreamProposal = async (record, id, operationId) => {
      const written = await original(record, id, operationId)
      writes += 1
      if (writes === 1) await hooks.dreamer!.cancel(hooks.dreamId)
      return written
    }
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    hooks.dreamer = dreamer
    const dream = await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    hooks.dreamId = dream.id
    await dreamer.flush()

    expect(writes).toBe(1)
    expect(store.getDream(dream.id)?.status).toBe('cancelled')
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(1)
    expect(store.getEpisode(episode.id)?.status).toBe('failed-retryable')
  })
})

describe('dream redaction', () => {
  it('redacts secrets in pending proposals and the dream-commit audit', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm([
      dreamJson([episode.id], {
        title: 'Deploy with password=hunter2',
        body: 'Use password=hunter2 before running the deploy.',
        tags: ['password=hunter2', 'deploy'],
      }),
    ])
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    const record = pending[0]!
    expect(record.title).toContain('[REDACTED]')
    expect(record.title).not.toContain('hunter2')
    expect(record.body).not.toContain('hunter2')
    expect(record.tags).toEqual(['[REDACTED]', 'deploy'])

    const commit = store
      .auditList({ memoryId: record.id, limit: 10 })
      .items.find((item) => item.action === 'dream-commit')
    expect(commit?.after?.title).toContain('[REDACTED]')
    expect(commit?.after?.title).not.toContain('hunter2')
    expect(commit?.after?.body).not.toContain('hunter2')
    expect(commit?.after?.tags).toEqual(['[REDACTED]', 'deploy'])
  })

  it('redacts existing memory titles and episode files in the prompt', async () => {
    const { store, runner } = await openStore()
    await store.create({
      type: 'lesson',
      title: 'Login with password=hunter2',
      body: 'Old lesson body.',
      scope: { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' },
      status: 'active',
    })
    const episode = await addEpisode(store, 1, ['C:/ws/password=hunter2.txt'])
    const llm = scriptedLlm([dreamJson([episode.id])])
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    const prompt = promptText(llm.calls[0])
    expect(prompt).toContain('[REDACTED]')
    expect(prompt).not.toContain('hunter2')
  })

  it('keeps dream output untouched when redaction is disabled', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const llm = scriptedLlm([
      dreamJson([episode.id], {
        title: 'Deploy with password=hunter2',
        body: 'Use password=hunter2 before running the deploy.',
      }),
    ])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({ redactSecrets: false }),
      llm,
    })
    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    expect(pending[0]?.title).toContain('hunter2')
    expect(pending[0]?.body).toContain('hunter2')
  })
})

describe('dream quality tightening', () => {
  it('completes empty dream output by marking claimed episodes skipped', async () => {
    const { store, runner } = await openStore()
    const ep1 = await addEpisode(store, 1)
    const ep2 = await addEpisode(store, 2)
    const llm = scriptedLlm([JSON.stringify({ memories: [], wikiUpdates: [] })])
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })

    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'auto',
    })
    await dreamer.flush()

    expect(llm.calls).toHaveLength(1)
    const run = store.dreamList()[0]
    expect(run?.status).toBe('completed')
    expect(run?.committed).toBe(0)
    expect(store.getEpisode(ep1.id)?.status).toBe('skipped')
    expect(store.getEpisode(ep2.id)?.status).toBe('skipped')
  })

  it('marks unreferenced episodes skipped, blocks worklog when worklogCapture is off, and includes pending proposals in related search', async () => {
    const { store, runner } = await openStore()
    const ep1 = await addEpisode(store, 1)
    const ep2 = await addEpisode(store, 2)
    await store.create({
      type: 'lesson',
      title: 'Existing pending rule',
      body: 'Already queued for review.',
      scope: { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' },
      status: 'pending',
    })

    const llm = scriptedLlm([
      JSON.stringify({
        memories: [
          {
            type: 'worklog',
            title: 'Should be filtered out',
            body: 'No worklogs when off.',
            confidence: 0.9,
            importance: 0.4,
            sourceEpisodeIds: [ep2.id],
          },
          {
            type: 'lesson',
            title: 'Real lesson',
            body: 'Verified durable finding.',
            confidence: 0.9,
            importance: 0.8,
            sourceEpisodeIds: [ep1.id],
          },
        ],
        wikiUpdates: [],
      }),
    ])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({ worklogCapture: 'off' }),
      llm,
    })

    await dreamer.enqueue({
      scopeKey: 'ws-a',
      scopeKind: 'workspace',
      scopeRoot: 'C:/ws/a',
      trigger: 'manual',
    })
    await dreamer.flush()

    expect(llm.calls[0]?.system).toContain('Do NOT output type "worklog"')
    expect(promptText(llm.calls[0])).toContain('[lesson|pending] Existing pending rule')

    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending.map((item) => item.title)).toContain('Real lesson')
    expect(pending.map((item) => item.title)).not.toContain('Should be filtered out')
    expect(store.getEpisode(ep1.id)?.status).toBe('processed')
    expect(store.getEpisode(ep2.id)?.status).toBe('skipped')
  })
})
