import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { openService } from '../helpers/service.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
function humanMessage(text: string): UserMessage {
  return {
    id: 'm',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

describe('inject first turn', () => {
  it('admits one baseline message on the first step and nothing afterwards', async () => {
    const host = await openService()
    try {
      await host.service.write(
        {
          type: 'preference',
          title: 'Prefer typecheck',
          body: 'Always typecheck first.',
          scope: 'global',
        },
        null,
      )
      const injector = new MemoryIndexInjector({ ctx: host.ctx, service: host.service })
      const fake = makeFakeAgent()

      const decision = await injector.handlePreStep(
        { agent: fake.agent, messages: [humanMessage('hello')], step: 1 },
        async () => ({ kind: 'enter', messages: [humanMessage('hello')] }),
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('unreachable')
      expect(decision.messages).toHaveLength(2)
      const injected = decision.messages[1]!
      expect(injected.source.kind).toBe('memloom')
      if (injected.source.kind !== 'memloom') throw new Error('unreachable')
      expect(injected.source.mode).toBe('baseline')

      // Simulate the loop persisting the admitted message, then run step 1 again.
      fake.session.messages.push(injected)
      const second = await injector.handlePreStep(
        { agent: fake.agent, messages: [humanMessage('hello again')], step: 1 },
        async () => ({ kind: 'enter', messages: [humanMessage('hello again')] }),
      )
      if (second.kind !== 'enter') throw new Error('unreachable')
      expect(second.messages).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })

  it('is wired onto the agent/pre-step waterfall through the service registration', async () => {
    const host = await openService()
    try {
      await host.service.write(
        { type: 'preference', title: 'Prefer tests', body: 'Run tests.', scope: 'global' },
        null,
      )
      const fake = makeFakeAgent()
      const claimed = [humanMessage('hello')]
      const decision = await host.ctx.waterfall(
        'agent/pre-step',
        {
          agent: fake.agent,
          messages: claimed,
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
          modelSelection: { provider: 'test', model: 'test' },
        },
        async () => ({ kind: 'enter', messages: claimed }),
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('unreachable')
      expect(decision.messages).toHaveLength(2)
      expect(decision.messages[1]!.source.kind).toBe('memloom')
    } finally {
      await host.dispose()
    }
  })
})
