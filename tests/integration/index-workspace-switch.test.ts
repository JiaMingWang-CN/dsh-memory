import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import {
  FakeIndexService,
  humanMessage,
  lesson,
  preference,
  WS,
  WS_B,
} from '../helpers/index-fixtures.ts'

function enter(messages: UserMessage[]) {
  return { kind: 'enter' as const, messages }
}

describe('workspace switch', () => {
  it('resets to the new workspace and drops every old workspace id', async () => {
    let root = WS.root
    const ctx = {
      workingDirectory: { ensure: async () => root },
    } as unknown as Context

    const service = new FakeIndexService([lesson('a1', WS), preference('p1')])
    const injector = new MemoryIndexInjector({
      ctx,
      service,
      config: { refreshIndexOnChange: true },
    })
    const fake = makeFakeAgent()

    const first = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 1 },
      async () => enter([humanMessage()]),
    )
    if (first.kind !== 'enter') throw new Error('expected enter')
    const baseline = first.messages[first.messages.length - 1]!
    if (baseline.source.kind !== 'dsh-memory') throw new Error('unreachable')
    expect(baseline.source.scopeKey).toBe(WS.key)
    fake.session.messages.push(baseline)

    // Switch to workspace B and change the visible record set.
    root = WS_B.root
    service.records = [lesson('b1', WS_B), preference('p1')]

    const second = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 2 },
      async () => enter([humanMessage()]),
    )
    if (second.kind !== 'enter') throw new Error('expected enter')
    expect(second.messages).toHaveLength(2)
    const reset = second.messages[1]!
    if (reset.source.kind !== 'dsh-memory') throw new Error('unreachable')
    expect(reset.source.mode).toBe('reset')
    expect(reset.source.scopeKey).toBe(WS_B.key)
    const changedIds = reset.source.changes.map((change) => change.memoryId)
    expect(changedIds).toContain('b1')
    expect(changedIds).not.toContain('a1')
    expect(reset.source.invalidations).toEqual([{ memoryId: 'a1', contentRevision: 1 }])

    const text = reset.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    // No indexed entry may carry an old-workspace id; only the explicit
    // invalidation notice names the stale id so it cannot be relied on.
    const indexedLines = text.split('\n').filter((line) => line.startsWith('- ['))
    expect(indexedLines.some((line) => line.includes('a1'))).toBe(false)
  })
})
