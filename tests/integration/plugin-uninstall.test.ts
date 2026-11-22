/**
 * Plugin uninstall / disable cleanup (plan 06, Task 2).
 *
 * After the plugin fiber is disposed, a new session must not be injected, must
 * not capture episodes, and must not write memories — while already-persisted
 * `dsh-memory` messages stay replayable. Verified by reopening the durable
 * domain after dispose and comparing table sizes.
 */
import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { memoryDomain } from '../../src/host/domain.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import { openService } from '../helpers/service.ts'
import {
  captureSession,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
  userMessage,
} from '../helpers/capture-events.ts'

type Emitter = (event: string, ...args: unknown[]) => void
type Table = { size: number }
type Domain = { table(name: string): Table; close(): Promise<void> }

function humanMessage(text: string): UserMessage {
  return {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** Emit one complete turn that capture turns into a queued episode. */
function emitCapturedTurn(
  emit: Emitter,
  session: ReturnType<typeof captureSession>,
  base: number,
): void {
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

describe('plugin uninstall cleanup', () => {
  it('stops injection, capture and writes after dispose while keeping history replayable', async () => {
    const host = await openService()
    const emit: Emitter = (event, ...args) => {
      ;(host.ctx as unknown as { emit(e: string, ...a: unknown[]): void }).emit(event, ...args)
    }
    try {
      // Produce one durable episode and one memory message before uninstalling.
      emitCapturedTurn(emit, captureSession('s1', 'C:/ws/a'), 1)
      await host.service.flush()
      const episodesBefore = host.service.status().counts.queuedEpisodes
      const memoriesBefore = host.service.status().counts.stored
      expect(episodesBefore).toBeGreaterThanOrEqual(1)

      // A persisted memory-index message on a session surface must survive.
      const fake = makeFakeAgent({ id: 'session-b' })
      const historyMessage = {
        id: 'mem-hist',
        role: 'user',
        content: [{ type: 'text', text: 'old memory index' }],
        source: {
          kind: 'dsh-memory',
          form: 'memory-index',
          mode: 'baseline',
          protocolVersion: 1,
          baselineId: 'b0',
          scopeKey: 'c:/ws/a',
          changes: [],
          invalidations: [],
        },
      } as unknown as UserMessage
      fake.session.messages.push(historyMessage)

      await host.dispose()

      // The service is gone from the context.
      expect((host.ctx as unknown as { get(name: string): unknown }).get('memory')).toBeUndefined()

      // No injection into a new request after uninstall.
      const injector = new MemoryIndexInjector({ ctx: host.ctx, service: host.service })
      const request = humanMessage('start fresh')
      const decision = await injector.handlePreStep(
        { agent: fake.agent, messages: [request], step: 1 },
        async () => ({ kind: 'enter', messages: [request] }),
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('unreachable')
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages.some((message) => message.source.kind === 'dsh-memory')).toBe(false)

      // No capture after uninstall: emitting another turn adds nothing.
      emitCapturedTurn(emit, captureSession('s2', 'C:/ws/a'), 10)
      await new Promise((resolve) => setTimeout(resolve, 20))

      const reopened = (await (
        host.ctx as unknown as { storageDomain: { open(spec: unknown): Promise<unknown> } }
      ).storageDomain.open(memoryDomain)) as Domain
      try {
        expect(reopened.table('episodes').size).toBe(episodesBefore)
        expect(reopened.table('memories').size).toBe(memoriesBefore)
      } finally {
        await reopened.close()
      }

      // History is still replayable from the durable surface.
      expect(
        fake.session.deriveMessages().some((message) => message.source.kind === 'dsh-memory'),
      ).toBe(true)
    } finally {
      // Disposing twice is safe when the first dispose already ran.
      await host.dispose().catch(() => {})
    }
  })
})
