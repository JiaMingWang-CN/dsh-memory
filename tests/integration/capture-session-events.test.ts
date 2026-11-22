import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import {
  captureSession,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
  userMessage,
} from '../helpers/capture-events.ts'

type Emitter = { emit(event: string, ...args: unknown[]): void }

describe('capture session events (integration)', () => {
  it('turns real session events into queued episodes', async () => {
    const host = await openService()
    const emit = (host.ctx as unknown as Emitter).emit.bind(host.ctx)
    const session = captureSession('s1', 'C:/ws/a')

    emit('session/event', session, turnStart(1, 1))
    emit('session/event', session, userMessage(2, 'run the build'))
    emit(
      'session/event',
      session,
      toolCall(3, { callId: 'c1', name: 'bash', arguments: '{"command":"pnpm build"}' }),
    )
    emit(
      'session/event',
      session,
      toolResult(4, { callId: 'c1', error: { name: 'bash', code: 'E_BUILD' }, isError: true }),
    )
    emit('session/event', session, turnEnd(5))
    await host.service.flush()

    expect(host.service.status().counts.queuedEpisodes).toBeGreaterThanOrEqual(1)
    await host.dispose()
  })

  it('captures nothing when autoCaptureEpisodes is false', async () => {
    const host = await openService({ config: { autoCaptureEpisodes: false } })
    const emit = (host.ctx as unknown as Emitter).emit.bind(host.ctx)
    const session = captureSession('s2', 'C:/ws/a')

    emit('session/event', session, turnStart(1, 1))
    emit('session/event', session, userMessage(2, 'remember this'))
    emit('session/event', session, turnEnd(3))
    await host.service.flush()

    expect(host.service.status().counts.queuedEpisodes).toBe(0)
    await host.dispose()
  })
})
