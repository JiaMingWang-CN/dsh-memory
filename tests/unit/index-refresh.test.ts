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

function humanMessage(text = 'hello'): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

function preference(id: string, body = 'pref body'): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'preference',
    scope: { kind: 'global' },
    body,
    importance: 0.5,
  })
}

function enter(messages: UserMessage[]): PreStepDecision {
  return { kind: 'enter', messages }
}

async function runStep(
  injector: MemoryIndexInjector,
  fake: FakeAgent,
  step: number,
  nextMessages: UserMessage[] = [humanMessage()],
): Promise<PreStepDecision> {
  return injector.handlePreStep({ agent: fake.agent, messages: nextMessages, step }, async () =>
    enter(nextMessages),
  )
}

/** Seed a baseline by running step 1 and persisting its message onto the surface. */
async function seedBaseline(injector: MemoryIndexInjector, fake: FakeAgent): Promise<void> {
  const decision = await runStep(injector, fake, 1)
  if (decision.kind !== 'enter') throw new Error('expected enter')
  const injected = decision.messages[decision.messages.length - 1]!
  fake.session.messages.push(injected)
}

describe('refresh disabled', () => {
  it('appends no message when refreshIndexOnChange is false', async () => {
    const service = new FakeService([preference('a')])
    const injector = new MemoryIndexInjector({ ctx: fakeContext(), service, config: {} })
    const fake = makeFakeAgent()
    await seedBaseline(injector, fake)

    service.records = [preference('a'), preference('b')]
    const decision = await runStep(injector, fake, 2)
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(1)
  })
})

describe('refresh delta', () => {
  it('adds a delta message for a new memory and never calls followup', async () => {
    const service = new FakeService([preference('a')])
    const injector = new MemoryIndexInjector({
      ctx: fakeContext(),
      service,
      config: { refreshIndexOnChange: true },
    })
    const fake = makeFakeAgent()
    await seedBaseline(injector, fake)

    service.records = [preference('a'), preference('b')]
    const decision = await runStep(injector, fake, 2)
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source.kind).toBe('memloom')
    if (injected.source.kind !== 'memloom') throw new Error('unreachable')
    expect(injected.source.mode).toBe('delta')
    expect(injected.source.changes).toEqual([
      expect.objectContaining({ action: 'add', memoryId: 'b' }),
    ])
    expect(fake.followup).not.toHaveBeenCalled()
  })
})

describe('refresh remove priority', () => {
  it('turns an over-budget delta into a reset that keeps remove and add', async () => {
    const service = new FakeService([preference('a')])
    const injector = new MemoryIndexInjector({
      ctx: fakeContext(),
      service,
      config: { refreshIndexOnChange: true, refreshMaxBytes: 80, indexMaxBytes: 4096 },
    })
    const fake = makeFakeAgent()
    await seedBaseline(injector, fake)

    service.records = [preference('b', 'x'.repeat(400))]
    const decision = await runStep(injector, fake, 2)
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injected = decision.messages[1]!
    if (injected.source.kind !== 'memloom') throw new Error('unreachable')
    expect(injected.source.mode).toBe('reset')
    expect(injected.source.invalidations).toEqual([{ memoryId: 'a', contentRevision: 1 }])
    expect(injected.source.changes).toEqual([
      expect.objectContaining({ action: 'add', memoryId: 'b' }),
    ])
  })
})

describe('refresh reset threshold', () => {
  it('resets when the accumulated delta reaches refreshResetBytes', async () => {
    const service = new FakeService([preference('a')])
    const injector = new MemoryIndexInjector({
      ctx: fakeContext(),
      service,
      config: { refreshIndexOnChange: true, refreshMaxBytes: 100_000, refreshResetBytes: 10 },
    })
    const fake = makeFakeAgent()
    await seedBaseline(injector, fake)

    service.records = [preference('a'), preference('b')]
    const decision = await runStep(injector, fake, 2)
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injected = decision.messages[1]!
    if (injected.source.kind !== 'memloom') throw new Error('unreachable')
    expect(injected.source.mode).toBe('reset')
  })
})
