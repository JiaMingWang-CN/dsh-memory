import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { DreamScheduler } from '../../src/host/dream-scheduler.ts'
import { MemoryDreamer, classifyDreamError, type DreamLlm } from '../../src/host/dreamer.ts'
import type { EpisodeRecord } from '../../src/shared/types.ts'
import { dreamJson, scriptedLlm } from '../helpers/dream-llm.ts'
import { openStore } from '../helpers/runner.ts'
import { openService } from '../helpers/service.ts'

type LlmStep = { error: string } | { text: string }

/** An LLM stand-in that throws or answers per call, in order. */
function sequenceLlm(steps: readonly LlmStep[]): DreamLlm & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  let index = 0
  return {
    calls,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      if (step === undefined || 'error' in step) {
        throw new Error(step?.error ?? 'unexpected dream failure')
      }
      const text = step.text
      async function* generate(): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return generate()
    },
  }
}

/** An LLM stand-in that reports DSH-style terminal `finish(error)` chunks in order. */
function finishErrorLlm(failures: readonly LlmFailure[]): DreamLlm & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  let index = 0
  return {
    calls,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const failure = failures[Math.min(index, failures.length - 1)]
      index += 1
      async function* generate(): AsyncGenerator<StreamChunk> {
        if (failure !== undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure } }
        }
      }
      return generate()
    },
  }
}

async function addEpisode(
  store: Awaited<ReturnType<typeof openStore>>['store'],
  turn = 1,
): Promise<EpisodeRecord> {
  const episode = await store.appendEpisode({
    sessionId: 's1',
    workspaceKey: 'ws-a',
    workspaceRoot: 'C:/ws/a',
    kind: 'turn',
    turn,
    sourceSeqs: [turn],
    prompt: 'run the build',
    outcome: 'completed',
  })
  if (episode === undefined) throw new Error('episode was not stored')
  return episode
}

function autoRequest() {
  return {
    scopeKey: 'ws-a',
    scopeKind: 'workspace' as const,
    scopeRoot: 'C:/ws/a',
    trigger: 'auto' as const,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dream error classification', () => {
  it('classify fatal', () => {
    expect(classifyDreamError('401 Unauthorized')).toBe('fatal')
    expect(classifyDreamError('403 Forbidden')).toBe('fatal')
    expect(classifyDreamError('invalid API key')).toBe('fatal')
    expect(classifyDreamError('insufficient quota')).toBe('fatal')
    expect(classifyDreamError('billing credit exhausted')).toBe('fatal')
    expect(classifyDreamError({ message: 'quota exhausted', code: 'QUOTA', status: 429 })).toBe(
      'fatal',
    )
  })

  it('classify transient', () => {
    expect(classifyDreamError('429 Too Many Requests')).toBe('transient')
    expect(classifyDreamError('ECONNRESET while reading')).toBe('transient')
    expect(classifyDreamError('fetch failed')).toBe('transient')
    expect(classifyDreamError('503 Service Unavailable')).toBe('transient')
    expect(classifyDreamError('request timeout')).toBe('transient')
  })

  it('classify other', () => {
    expect(classifyDreamError('invalid JSON output')).toBe('other')
    expect(classifyDreamError('model output was not valid JSON')).toBe('other')
  })
})

describe('dream finish chunk failures', () => {
  it('classifies DSH finish failures', async () => {
    const { store, runner } = await openStore()
    await addEpisode(store)
    let now = new Date('2026-01-01T00:00:00.000Z')
    const llm = finishErrorLlm([
      { message: 'provider request failed', code: 'HTTP_429', status: 429 },
      { message: 'provider request failed', code: 'HTTP_500', status: 500 },
      { message: 'credential rejected', code: 'AUTH', status: 401 },
    ])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
      now: () => new Date(now.getTime()),
    })

    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(dreamer.dreamQueueState()).toEqual({
      paused: false,
      retryAt: now.getTime() + 60_000,
    })
    expect(store.dreamList().some((run) => run.error?.includes('HTTP_429'))).toBe(true)

    now = new Date(now.getTime() + 61_000)
    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(dreamer.dreamQueueState()).toEqual({
      paused: false,
      retryAt: now.getTime() + 180_000,
    })

    now = new Date(now.getTime() + 181_000)
    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(dreamer.dreamQueueState().paused).toBe(true)
    expect(dreamer.dreamQueueState().reason).toMatch(/auth/i)
  })
})

describe('dream backoff', () => {
  it('backoff sequence', async () => {
    const { store, runner } = await openStore()
    await addEpisode(store)
    let now = new Date('2026-01-01T00:00:00.000Z')
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: sequenceLlm([{ error: '429 Too Many Requests' }]),
      now: () => new Date(now.getTime()),
    })

    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(dreamer.dreamQueueState()).toEqual({
      paused: false,
      retryAt: now.getTime() + 60_000,
    })

    now = new Date(now.getTime() + 61_000)
    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(dreamer.dreamQueueState()).toEqual({
      paused: false,
      retryAt: now.getTime() + 180_000,
    })

    now = new Date(now.getTime() + 181_000)
    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    const state = dreamer.dreamQueueState()
    expect(state.paused).toBe(true)
    expect(state.reason).toMatch(/transient/i)
    expect(state.retryAt).toBeUndefined()
  })

  it('fatal pauses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const config = resolveMemoryConfig({
      autoDream: true,
      dreamIdleDelayMs: 10_000,
      autoDreamMinIntervalMs: 0,
    })
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config,
      llm: sequenceLlm([{ error: '401 Unauthorized' }, { text: dreamJson([episode.id]) }]),
    })
    const scheduler = new DreamScheduler({ dreamer, config })
    try {
      scheduler.onTurnEnd('ws-a', 'C:/ws/a')
      await vi.advanceTimersByTimeAsync(10_000)
      await dreamer.flush()

      expect(store.dreamList()).toHaveLength(1)
      expect(store.dreamList()[0]?.status).toBe('failed')
      expect(dreamer.dreamQueueState().paused).toBe(true)
      expect(dreamer.dreamQueueState().reason).toMatch(/auth/i)

      // A paused automatic dreamer is not asked again by the scheduler.
      scheduler.onTurnEnd('ws-a', 'C:/ws/a')
      await vi.advanceTimersByTimeAsync(10_000)
      await dreamer.flush()
      expect(store.dreamList()).toHaveLength(1)

      // A manual dream is still allowed while automatic dreaming is paused.
      const manual = await dreamer.enqueue({
        ...autoRequest(),
        trigger: 'manual',
      })
      await dreamer.flush()
      expect(store.getDream(manual.id)?.status).toBe('completed')
    } finally {
      await scheduler.dispose()
    }
  })

  it('paused queue cancels already queued automatic dreams', async () => {
    const { store, runner } = await openStore()
    await addEpisode(store)
    const llm = finishErrorLlm([
      { message: 'credential rejected', code: 'AUTH', status: 401 },
      { message: 'should never run', code: 'HTTP_500', status: 500 },
    ])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
    })

    await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(dreamer.dreamQueueState().paused).toBe(true)
    expect(llm.calls).toHaveLength(1)

    const queued = await dreamer.enqueue(autoRequest())
    await dreamer.flush()
    expect(store.getDream(queued.id)?.status).toBe('cancelled')
    expect(llm.calls).toHaveLength(1)
  })
})

describe('dream operation settlement', () => {
  it('marks the dream.run operation failed when the model call fails', async () => {
    const { store, domain, runner } = await openStore()
    await addEpisode(store)
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: sequenceLlm([{ error: 'boom' }]),
    })

    const dream = await dreamer.enqueue(autoRequest())
    await dreamer.flush()

    expect(store.getDream(dream.id)?.status).toBe('failed')
    const operations = [...domain.table('operations').entries()].map(([, operation]) => operation)
    const dreamOperations = operations.filter((operation) => operation.kind === 'dream.run')
    expect(dreamOperations.some((operation) => operation.status === 'failed')).toBe(true)
    // A failed run must never leave a durable `planned`/`applying` row that a
    // restart would report as an interrupted process.
    expect(
      dreamOperations.filter(
        (operation) => operation.status === 'planned' || operation.status === 'applying',
      ),
    ).toEqual([])
  })
})

describe('dream poison episodes', () => {
  it('poison skipped', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: scriptedLlm([
        'not json',
        'not json',
        'not json',
        'not json',
        'not json',
        'not json',
        dreamJson([episode.id]),
      ]),
    })

    let latest: Awaited<ReturnType<typeof dreamer.enqueue>> | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      latest = await dreamer.enqueue(autoRequest())
      await dreamer.flush()
    }

    const stored = store.getEpisode(episode.id)
    expect(stored?.status).toBe('skipped')
    expect(stored?.attempts).toBe(3)
    expect(store.dreamList()).toHaveLength(3)
    const terminal = store.getDream(latest!.id)
    expect(terminal?.status).toBe('failed')
    expect(terminal?.error).toContain('skipped after 3 attempts')
    expect(terminal?.error).toContain('3 attempts')

    // A manual dream may re-include skipped episodes.
    const manual = await dreamer.enqueue({ ...autoRequest(), trigger: 'manual' })
    await dreamer.flush()
    expect(store.getDream(manual.id)?.status).toBe('completed')
    expect(store.getEpisode(episode.id)?.status).toBe('processed')
  })

  it('other failure after transient streak is not poison', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: sequenceLlm([
        { error: '429 Too Many Requests' },
        { error: '429 Too Many Requests' },
        { error: '429 Too Many Requests' },
        { text: 'not json' },
        { text: 'not json' },
      ]),
    })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await dreamer.enqueue({ ...autoRequest(), trigger: 'manual' })
      await dreamer.flush()
    }
    expect(store.getEpisode(episode.id)?.attempts).toBe(3)

    await dreamer.enqueue({ ...autoRequest(), trigger: 'manual' })
    await dreamer.flush()
    const stored = store.getEpisode(episode.id)
    expect(stored?.status).toBe('failed-retryable')
    expect(stored?.attempts).toBe(4)
  })

  it('persisted dream errors are redacted and bounded', async () => {
    const { store, runner } = await openStore()
    const episode = await addEpisode(store)
    const secret = `sk-${'A'.repeat(40)}`
    const message = `401 Unauthorized password=hunter2 ${secret} ${'x'.repeat(800)}`
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: sequenceLlm([{ error: message }]),
    })

    await dreamer.enqueue(autoRequest())
    await dreamer.flush()

    const dream = store.dreamList()[0]
    expect(dream?.error).not.toContain('hunter2')
    expect(dream?.error).not.toContain(secret)
    expect(dream?.error).toContain('[REDACTED]')
    expect((dream?.error ?? '').length).toBeLessThanOrEqual(500)

    const storedEpisode = store.getEpisode(episode.id)
    expect(storedEpisode?.lastError).not.toContain('hunter2')
    expect(storedEpisode?.lastError).not.toContain(secret)
    expect((storedEpisode?.lastError ?? '').length).toBeLessThanOrEqual(500)
  })
})

describe('dream manual recovery', () => {
  it('manual success clears', async () => {
    const { store, runner } = await openStore()
    const first = await addEpisode(store, 1)
    let now = new Date('2026-01-01T00:00:00.000Z')
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: sequenceLlm([
        { error: '429 Too Many Requests' },
        { error: '429 Too Many Requests' },
        { error: '401 Unauthorized' },
        { text: dreamJson([first.id]) },
        { error: '429 Too Many Requests' },
      ]),
      now: () => new Date(now.getTime()),
    })

    const run = async (trigger: 'auto' | 'manual') => {
      await dreamer.enqueue({ ...autoRequest(), trigger })
      await dreamer.flush()
    }

    await run('auto')
    now = new Date(now.getTime() + 61_000)
    await run('auto')
    now = new Date(now.getTime() + 181_000)
    await run('auto')
    expect(dreamer.dreamQueueState().paused).toBe(true)

    await run('manual')
    expect(dreamer.dreamQueueState()).toEqual({ paused: false })

    // A successful manual run resets the streak: the next transient failure
    // schedules the first-step backoff instead of pausing the dreamer.
    await addEpisode(store, 2)
    now = new Date(now.getTime() + 1_000)
    await run('auto')
    expect(dreamer.dreamQueueState()).toEqual({
      paused: false,
      retryAt: now.getTime() + 60_000,
    })
  })
})

describe('dream queue state service', () => {
  it('service dream queue state', async () => {
    const host = await openService({ config: { autoDream: false } })
    try {
      expect(host.service.dreamQueueState()).toEqual({ paused: false })
      expect(host.service.status().dreamQueue).toEqual({ paused: false })
    } finally {
      await host.dispose()
    }
  })
})
