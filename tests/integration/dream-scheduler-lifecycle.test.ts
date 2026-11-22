import { afterEach, describe, expect, it, vi } from 'vitest'
import { DreamScheduler, type DreamerLike } from '../../src/host/dream-scheduler.ts'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { openStore } from '../helpers/runner.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DreamRequest } from '../../src/host/dreamer.ts'
import type { DreamRun } from '../../src/shared/types.ts'

afterEach(() => {
  vi.useRealTimers()
})

class CancelDreamer implements DreamerLike {
  readonly enqueued: DreamRequest[] = []
  readonly cancel = vi.fn(async () => true)
  async enqueue(request: DreamRequest): Promise<DreamRun> {
    this.enqueued.push(request)
    return {
      id: `dream-${this.enqueued.length}` as DreamRun['id'],
      trigger: request.trigger,
      scopeKey: request.scopeKey,
      status: 'queued',
      startedAt: '',
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
  }
  async flush(): Promise<void> {}
  status(): DreamRun[] {
    return []
  }
}

describe('auto dream global serial', () => {
  it('runs at most one dream at a time across workspaces and writes pending proposals', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { store, runner } = await openStore()
    for (const [key, root] of [
      ['ws-a', 'C:/ws/a'],
      ['ws-b', 'C:/ws/b'],
    ] as const) {
      const episode = await store.appendEpisode({
        sessionId: key,
        workspaceKey: key,
        workspaceRoot: root,
        kind: 'turn',
        turn: 1,
        sourceSeqs: [1],
        prompt: 'work',
        outcome: 'completed',
        files: [],
      })
      if (episode === undefined) throw new Error('episode missing')
    }

    let active = 0
    let maxActive = 0
    const llm = {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const first = options.messages[0] as unknown as {
          content: { type: string; text?: string }[]
        }
        const text = first.content.map((block) => block.text ?? '').join('\n')
        const ids = [...text.matchAll(/### episode (\S+)/g)].map((match) => match[1]!)
        active += 1
        maxActive = Math.max(maxActive, active)
        async function* generate(): AsyncGenerator<StreamChunk> {
          await Promise.resolve()
          yield {
            type: 'text-delta',
            index: 0,
            text: JSON.stringify({
              memories: ids.map((id) => ({
                type: 'lesson',
                title: `Lesson ${id}`,
                body: `Body ${id}`,
                confidence: 0.8,
                importance: 0.5,
                sourceEpisodeIds: [id],
              })),
            }),
          }
          active -= 1
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return generate()
      },
    }
    const dreamer = new MemoryDreamer({ store, runner, config: resolveMemoryConfig({}), llm })
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({
        autoDream: true,
        dreamIdleDelayMs: 1000,
        autoDreamMinIntervalMs: 0,
      }),
    })
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    scheduler.onTurnEnd('ws-b', 'C:/ws/b')
    await vi.advanceTimersByTimeAsync(1000)
    await dreamer.flush()

    expect(maxActive).toBe(1)
    expect(store.dreamList().filter((dream) => dream.status === 'completed')).toHaveLength(2)
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(1)
    expect(store.list({ workspaceKey: 'ws-b', status: 'pending' }).items).toHaveLength(1)
    await scheduler.dispose()
  })
})

describe('scheduler dispose', () => {
  it('clears timers and cancels the current dream', async () => {
    vi.useFakeTimers()
    const dreamer = new CancelDreamer()
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({ autoDream: true, dreamIdleDelayMs: 1000 }),
    })
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(1000)
    expect(dreamer.enqueued).toHaveLength(1)

    await scheduler.dispose()
    expect(dreamer.cancel).toHaveBeenCalledWith('dream-1')

    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(dreamer.enqueued).toHaveLength(1)
  })
})
