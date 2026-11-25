/**
 * Workspace isolation across every consumer path (plan 06, Task 2).
 *
 * A workspace-A lesson must be invisible in workspace B through all three
 * paths the design names: the injected index, explicit search, and the default
 * management list. Global preferences remain visible, so the test writes one
 * too and asserts it crosses the boundary.
 */
import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { normalizeWorkspaceKey } from '../../src/host/workspace.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import { openService } from '../helpers/service.ts'
import { runTool } from '../helpers/tool.ts'

const ROOT_A = 'C:/ws/a'
const ROOT_B = 'C:/ws/b'
const KEY_A = normalizeWorkspaceKey(ROOT_A)
const KEY_B = normalizeWorkspaceKey(ROOT_B)

/** Resolve a different workspace per session id. */
function workspaceOf(agent: unknown): string {
  return (agent as { id?: string }).id === 'session-b' ? ROOT_B : ROOT_A
}

function humanMessage(text: string): UserMessage {
  return {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

describe('workspace isolation', () => {
  it('hides a workspace-A lesson from workspace B in index, search and management list', async () => {
    const host = await openService({ workingDirectory: workspaceOf })
    try {
      const lesson = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: '工作区 A 专属教训',
          body: '这条教训只在工作区 A 生效。',
          importance: 0.9,
        },
        'session-a',
      )
      const preference = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'preference',
          title: '全局偏好：先跑测试',
          body: '任何工作区都先跑测试。',
          scope: 'global',
        },
        'session-a',
      )

      // Path 1 — explicit search.
      const searchA = await runTool(host.tools, 'memory_search', { query: '教训' }, 'session-a')
      expect(searchA.results.map((hit: { id: string }) => hit.id)).toContain(lesson.id)
      const searchB = await runTool(host.tools, 'memory_search', { query: '教训' }, 'session-b')
      expect(searchB.results.map((hit: { id: string }) => hit.id)).not.toContain(lesson.id)
      // Global preference is visible in B.
      const prefB = await runTool(host.tools, 'memory_search', { query: '测试' }, 'session-b')
      expect(prefB.results.map((hit: { id: string }) => hit.id)).toContain(preference.id)

      // Path 2 — injected index for a fresh session B.
      const injector = new MemoryIndexInjector({ ctx: host.ctx, service: host.service })
      const sessionB = makeFakeAgent({ id: 'session-b' })
      const decision = await injector.handlePreStep(
        { agent: sessionB.agent, messages: [humanMessage('继续工作')], step: 1 },
        async () => ({ kind: 'enter', messages: [humanMessage('继续工作')] }),
      )
      if (decision.kind !== 'enter') throw new Error('unreachable')
      const injected = decision.messages.find((message) => message.source.kind === 'memloom')
      if (injected !== undefined) {
        const text = injected.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        expect(text).not.toContain(lesson.id)
        expect(text).not.toContain('工作区 A 专属教训')
      }

      // Path 3 — default management list.
      const listB = host.service.remoteList({ workspaceKey: KEY_B })
      expect(listB.items.map((item) => item.id)).not.toContain(lesson.id)
      const listA = host.service.remoteList({ workspaceKey: KEY_A })
      expect(listA.items.map((item) => item.id)).toContain(lesson.id)
    } finally {
      await host.dispose()
    }
  })
})
