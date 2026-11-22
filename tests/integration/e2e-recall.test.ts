/**
 * End-to-end recall across two sessions (plan 06, Task 2).
 *
 * A content lesson written in session A must be present in a fresh session B's
 * injected memory index, without B re-supplying A's conversation, and must be
 * retrievable through the explicit search/read tools.
 *
 * The "model answer" step is simulated (`simulatedAnswer`) because the offline
 * test environment has no LLM and `@deepseek-ai/dsh-llm-replay` is not an
 * installed dependency; a real provider call is therefore NOT verified here.
 * This is recorded as a known limitation in the release checklist.
 */
import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import { openService } from '../helpers/service.ts'
import { runTool } from '../helpers/tool.ts'

/** A plain human message (source kind `user`). */
function humanMessage(text: string): UserMessage {
  return {
    id: `u-${text.length}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** Concatenate one message's text blocks. */
function textOf(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Deterministic stand-in for the model, answering only from injected context. */
function simulatedAnswer(injectedContext: string): string {
  return injectedContext.includes('typecheck') ? '建议先运行 typecheck，再构建。' : '我不知道。'
}

describe('end-to-end recall', () => {
  it('injects a lesson written in session A into a fresh session B and drives the answer', async () => {
    const host = await openService()
    try {
      // Session A: an explicit write becomes an active, resident workspace lesson.
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: '构建前先跑 typecheck',
          body: '构建前先运行 typecheck，避免构建失败。',
          importance: 0.9,
        },
        'session-a',
      )

      // Session B: first request, no A history provided.
      const injector = new MemoryIndexInjector({ ctx: host.ctx, service: host.service })
      const sessionB = makeFakeAgent({ id: 'session-b' })
      const request = humanMessage('帮我构建这个项目')
      const decision = await injector.handlePreStep(
        { agent: sessionB.agent, messages: [request], step: 1 },
        async () => ({ kind: 'enter', messages: [request] }),
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('unreachable')
      expect(decision.messages).toHaveLength(2)
      const injected = decision.messages[1]!
      expect(injected.source.kind).toBe('dsh-memory')

      const context = textOf(injected)
      expect(context).toContain('typecheck')
      expect(context).toContain(created.id)
      // The simulated model answers from the injected context alone.
      expect(simulatedAnswer(context)).toContain('typecheck')

      // The same session can retrieve it explicitly.
      const found = await runTool(host.tools, 'memory_search', { query: 'typecheck' }, 'session-b')
      expect(found.results.map((hit: { id: string }) => hit.id)).toContain(created.id)
      const read = await runTool(host.tools, 'memory_read', { id: created.id }, 'session-b')
      expect(read.body).toContain('typecheck')
    } finally {
      await host.dispose()
    }
  })
})
