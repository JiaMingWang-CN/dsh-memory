/**
 * Default-off automatic dreaming (plan 06, Task 3).
 *
 * OFF: a completed turn captures an episode but never calls the dreamer/LLM.
 * ON: the debounce fires an automatic dream that produces only `pending`
 * proposals; running it again does not duplicate the pending record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { DreamScheduler } from '../../src/host/dream-scheduler.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { openStore } from '../helpers/runner.ts'
import { openService } from '../helpers/service.ts'
import { dreamJson, scriptedLlm } from '../helpers/dream-llm.ts'
import {
  captureSession,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
  userMessage,
} from '../helpers/capture-events.ts'

type Emitter = (event: string, ...args: unknown[]) => void

/** Emit one failed turn whose tool failure capture records as an episode. */
function emitCapturedTurn(emit: Emitter, base = 1): void {
  const session = captureSession('s1', 'C:/ws/a')
  emit('session/event', session, turnStart(base, 1))
  emit('session/event', session, userMessage(base + 1, 'run the build'))
  emit(
    'session/event',
    session,
    toolCall(base + 2, { callId: `c${base}`, name: 'bash', arguments: '{"command":"pnpm build"}' }),
  )
  emit(
    'session/event',
    session,
    toolResult(base + 3, {
      callId: `c${base}`,
      error: { name: 'bash', code: 'E_BUILD' },
      isError: true,
    }),
  )
  emit('session/event', session, turnEnd(base + 4))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('auto dream off', () => {
  it('captures an episode without ever calling the dreamer', async () => {
    const enqueue = vi.spyOn(MemoryDreamer.prototype, 'enqueue')
    const host = await openService({ config: { autoDream: false } })
    try {
      const emit: Emitter = (event, ...args) => {
        ;(host.ctx as unknown as { emit(e: string, ...a: unknown[]): void }).emit(event, ...args)
      }
      emitCapturedTurn(emit)
      await host.service.flush()
      expect(host.service.status().counts.queuedEpisodes).toBeGreaterThanOrEqual(1)
      expect(enqueue).not.toHaveBeenCalled()
      expect(host.service.dreamStatus()).toBeNull()
    } finally {
      await host.dispose()
    }
  })
})

describe('auto dream on', () => {
  it('fires one debounced dream that produces a pending proposal and never repeats it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
    const { store, runner } = await openStore()
    const episode = await store.appendEpisode({
      sessionId: 's1',
      workspaceKey: 'ws-a',
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'run the build',
      outcome: 'completed',
      files: [],
    })
    if (episode === undefined) throw new Error('episode was not stored')
    const llm = scriptedLlm([dreamJson([episode.id]), dreamJson([episode.id])])
    const config = resolveMemoryConfig({ autoDream: true, dreamIdleDelayMs: 30_000 })
    const dreamer = new MemoryDreamer({ store, runner, config, llm })
    const scheduler = new DreamScheduler({ dreamer, config })

    // A turn ends: the debounce schedules one automatic dream.
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(30_000)
    await dreamer.flush()

    expect(store.dreamList()[0]?.status).toBe('completed')
    const pending = store.list({ workspaceKey: 'ws-a', status: 'pending' }).items
    expect(pending).toHaveLength(1)
    expect(pending[0]?.ownership).toBe('derived')
    // Never auto-activates.
    expect(store.list({ workspaceKey: 'ws-a', status: 'active' }).items).toHaveLength(0)

    // A later automatic run must not duplicate the pending proposal.
    vi.setSystemTime(new Date('2026-11-18T00:10:00.000Z'))
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(30_000)
    await dreamer.flush()
    expect(store.list({ workspaceKey: 'ws-a', status: 'pending' }).items).toHaveLength(1)

    await scheduler.dispose()
  })
})
