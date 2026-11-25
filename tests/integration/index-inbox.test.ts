import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import type { MemoryIndexSourceService } from '../../src/host/indexing.ts'
import type { SearchRequest, SearchResult } from '../../src/host/search.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'
import { makeFakeAgent, type FakeAgent } from '../helpers/agent.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const WS = { key: 'c:/ws/a', root: 'C:/ws/a' }

function fakeContext(): Context {
  return { workingDirectory: { ensure: async () => WS.root } } as unknown as Context
}

class FakeService implements MemoryIndexSourceService {
  hits: SearchResult = { results: [], total: 0, truncated: false }
  constructor(public records: MemoryRecord[]) {}
  activeInScope(workspaceKey: string | null): MemoryRecord[] {
    return this.records.filter((record) => {
      if (record.status !== 'active') return false
      if (record.scope.kind === 'global') return record.type === 'preference'
      return workspaceKey !== null && record.scope.key === workspaceKey
    })
  }
  search(_request: SearchRequest): SearchResult {
    return this.hits
  }
  read(id: string, _workspaceKey: string | null): MemoryRecord {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) throw new Error('missing')
    return record
  }
}

function humanMessage(): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

function preference(id: string): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'preference',
    scope: { kind: 'global' },
    importance: 0.5,
  })
}

function enter(): PreStepDecision {
  return { kind: 'enter', messages: [humanMessage()] }
}

async function seedBaseline(injector: MemoryIndexInjector, fake: FakeAgent): Promise<void> {
  const decision = await injector.handlePreStep(
    { agent: fake.agent, messages: [humanMessage()], step: 1 },
    async () => enter(),
  )
  if (decision.kind !== 'enter') throw new Error('expected enter')
  fake.session.messages.push(decision.messages[decision.messages.length - 1]!)
}

describe('index inbox', () => {
  it('does not queue a rejected refresh and applies it on the next accepted step', async () => {
    const service = new FakeService([preference('a')])
    const injector = new MemoryIndexInjector({
      ctx: fakeContext(),
      service,
      config: { refreshIndexOnChange: true },
    })
    const fake = makeFakeAgent()
    await seedBaseline(injector, fake)
    const surfaceBefore = fake.session.messages.length

    service.records = [preference('a'), preference('b')]
    const rejected = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 2 },
      async () => ({ kind: 'reject' }),
    )
    expect(rejected).toEqual({ kind: 'reject' })
    expect(fake.inbox.nextTurn).toHaveLength(0)
    expect(fake.inbox.nextStep).toHaveLength(0)
    expect(fake.session.messages).toHaveLength(surfaceBefore)

    const accepted = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 3 },
      async () => enter(),
    )
    if (accepted.kind !== 'enter') throw new Error('expected enter')
    expect(accepted.messages).toHaveLength(2)
    expect(accepted.messages[1]!.source.kind).toBe('memloom')
  })

  it('defers a non-urgent delta without putting anything into a waking inbox', async () => {
    let clock = Date.parse('2026-11-17T12:00:00.000Z')
    const service = new FakeService([preference('a')])
    const injector = new MemoryIndexInjector({
      ctx: fakeContext(),
      service,
      now: () => new Date(clock),
      config: { refreshIndexOnChange: true, refreshMinIntervalMs: 60_000 },
    })
    const fake = makeFakeAgent()
    await seedBaseline(injector, fake)

    service.records = [preference('a'), preference('b')]
    const second = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 2 },
      async () => enter(),
    )
    if (second.kind !== 'enter') throw new Error('expected enter')
    fake.session.messages.push(second.messages[second.messages.length - 1]!)

    clock += 10_000
    service.records = [preference('a'), preference('b'), preference('c')]
    const third = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 3 },
      async () => enter(),
    )
    if (third.kind !== 'enter') throw new Error('expected enter')
    expect(third.messages).toHaveLength(1)
    expect(fake.inbox.nextStep).toHaveLength(0)
    expect(fake.inbox.nextTurn).toHaveLength(0)

    clock += 60_000
    const fourth = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 4 },
      async () => enter(),
    )
    if (fourth.kind !== 'enter') throw new Error('expected enter')
    expect(fourth.messages).toHaveLength(2)
    expect(fourth.messages[1]!.source.kind).toBe('memloom')
  })
})
