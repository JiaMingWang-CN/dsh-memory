import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { baselineIdOf } from '../../src/host/indexing.ts'
import { foldVisibleState } from '../../src/host/index-state.ts'
import { IndexRefresher } from '../../src/host/index-refresh.ts'
import type { SearchRequest, SearchResult } from '../../src/host/search.ts'
import type { MemoryIndexSourceService } from '../../src/host/indexing.ts'
import type { MemoryIndexChange, MemoryIndexSource, MemoryRecord } from '../../src/shared/types.ts'
import { MemoryId } from '../../src/shared/types.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const WS = { key: 'c:/ws/a', root: 'C:/ws/a' }
const WS_B = { key: 'c:/ws/b', root: 'C:/ws/b' }

function context(root = WS.root): Context {
  return { workingDirectory: { ensure: async () => root } } as unknown as Context
}

function human(text = 'hello'): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

function runtimeContext(text = 'tool continuation'): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context' },
  } as unknown as UserMessage
}

function indexMessage(source: MemoryIndexSource): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text: 'index' }],
    source,
  } as unknown as UserMessage
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
    if (record === undefined) throw new Error(`missing ${id}`)
    return record
  }
}

function preference(id: string): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'preference',
    scope: { kind: 'global' },
    body: `preference ${id}`,
  })
}

function lesson(id: string, workspace = WS): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'lesson',
    scope: { kind: 'workspace', ...workspace },
    body: `lesson ${id}`,
    importance: 0.9,
  })
}

function add(id: string, revision = 1, digest = `digest-${id}`): MemoryIndexChange {
  return { action: 'add', memoryId: id, contentRevision: revision, digest }
}

function baselineSource(
  baselineId: string,
  scopeKey: string,
  changes: MemoryIndexChange[],
  mode: 'baseline' | 'reset' = 'baseline',
): MemoryIndexSource {
  return {
    kind: 'memloom',
    form: 'memory-index',
    mode,
    protocolVersion: 1,
    baselineId,
    scopeKey,
    changes,
    invalidations: [],
  }
}

describe('missing baseline recovery', () => {
  it('composes the current index into the reset and does not repeat it', async () => {
    const scopeKey = WS.key
    const fake = makeFakeAgent({
      messages: [
        indexMessage({
          ...baselineSource(baselineIdOf(scopeKey, 4096), scopeKey, []),
          mode: 'delta',
          changes: [add('orphan')],
        }),
      ],
    })
    const service = new FakeService([preference('p1')])
    const injector = new MemoryIndexInjector({ ctx: context(), service })

    const first = await injector.handlePreStep(
      { agent: fake.agent, messages: [human('continue')], step: 1 },
      async () => ({ kind: 'enter', messages: [human('continue')] }),
    )
    if (first.kind !== 'enter') throw new Error('expected enter')
    const reset = first.messages.at(-1)!
    if (reset.source.kind !== 'memloom') throw new Error('expected memory source')
    expect(reset.source.mode).toBe('reset')
    expect(reset.source.changes.map((change) => change.memoryId)).toContain('p1')
    fake.session.messages.push(reset)

    const second = await injector.handlePreStep(
      { agent: fake.agent, messages: [human('next')], step: 2 },
      async () => ({ kind: 'enter', messages: [human('next')] }),
    )
    if (second.kind !== 'enter') throw new Error('expected enter')
    expect(second.messages).toHaveLength(1)
  })
})

describe('scope switch with refresh disabled', () => {
  it('resets to the new workspace and invalidates the old one', async () => {
    let root = WS.root
    const ctx = { workingDirectory: { ensure: async () => root } } as unknown as Context
    const service = new FakeService([lesson('a1', WS), preference('p1')])
    const injector = new MemoryIndexInjector({ ctx, service })
    const fake = makeFakeAgent()

    const first = await injector.handlePreStep(
      { agent: fake.agent, messages: [human()], step: 1 },
      async () => ({ kind: 'enter', messages: [human()] }),
    )
    if (first.kind !== 'enter') throw new Error('expected enter')
    fake.session.messages.push(first.messages.at(-1)!)

    root = WS_B.root
    service.records = [lesson('b1', WS_B), preference('p1')]
    const second = await injector.handlePreStep(
      { agent: fake.agent, messages: [human('next')], step: 2 },
      async () => ({ kind: 'enter', messages: [human('next')] }),
    )
    if (second.kind !== 'enter') throw new Error('expected enter')
    const reset = second.messages.at(-1)!
    if (reset.source.kind !== 'memloom') throw new Error('expected memory source')
    expect(reset.source.mode).toBe('reset')
    expect(reset.source.scopeKey).toBe(WS_B.key)
    expect(reset.source.changes.map((change) => change.memoryId)).toContain('b1')
    expect(reset.source.invalidations).toEqual([{ memoryId: 'a1', contentRevision: 1 }])
  })
})

describe('empty first decision', () => {
  it('does not revive a request another listener emptied', async () => {
    const service = new FakeService([preference('p1')])
    const injector = new MemoryIndexInjector({ ctx: context(), service })
    const fake = makeFakeAgent()

    const decision = await injector.handlePreStep(
      { agent: fake.agent, messages: [human('local command')], step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })
})

describe('tool continuation recall', () => {
  it('keeps the first human query candidates across a runtime-context step', async () => {
    const wiki = makeMemoryRecord({
      id: MemoryId('wiki-build'),
      type: 'wiki',
      scope: { kind: 'workspace', ...WS },
      title: 'Build guide',
      body: 'build commands',
    })
    const service = new FakeService([wiki])
    service.hits = {
      results: [
        {
          id: wiki.id,
          type: wiki.type,
          title: wiki.title,
          snippet: '',
          scope: wiki.scope,
          confidence: wiki.confidence,
          updatedAt: wiki.updatedAt,
          score: 1,
        },
      ],
      total: 1,
      truncated: false,
    }
    const injector = new MemoryIndexInjector({
      ctx: context(),
      service,
      config: { refreshIndexOnChange: true },
    })
    const fake = makeFakeAgent()

    const first = await injector.handlePreStep(
      { agent: fake.agent, messages: [human('build')], step: 1 },
      async () => ({ kind: 'enter', messages: [human('build')] }),
    )
    if (first.kind !== 'enter') throw new Error('expected enter')
    const baseline = first.messages.at(-1)!
    if (baseline.source.kind !== 'memloom') throw new Error('expected memory source')
    expect(baseline.source.changes.map((change) => change.memoryId)).toContain('wiki-build')
    fake.session.messages.push(human('build'), baseline)

    const continuation = runtimeContext()
    const second = await injector.handlePreStep(
      { agent: fake.agent, messages: [continuation], step: 2 },
      async () => ({ kind: 'enter', messages: [continuation] }),
    )
    if (second.kind !== 'enter') throw new Error('expected enter')
    expect(second.messages).toHaveLength(1)
  })
})

describe('durable cumulative budget', () => {
  it('recovers refresh bytes from folded durable deltas', () => {
    const scopeKey = WS.key
    const baseline = indexMessage(
      baselineSource(baselineIdOf(scopeKey, 4096), scopeKey, [add('a')]),
    )
    const delta = indexMessage({
      ...baselineSource(baselineIdOf(scopeKey, 4096), scopeKey, [add('b')]),
      mode: 'delta',
      refreshBytes: 900,
      refreshedAt: '2026-11-17T12:00:00.000Z',
    })
    const visible = foldVisibleState([baseline, delta])!
    expect(visible.refreshBytes).toBe(900)

    const expected = {
      baselineId: baselineIdOf(scopeKey, 4096),
      scopeKey,
      entries: [
        {
          memoryId: 'a',
          type: 'lesson' as const,
          title: 'a',
          summary: 's',
          contentRevision: 1,
          digest: 'digest-a',
          priority: 50,
        },
        {
          memoryId: 'b',
          type: 'lesson' as const,
          title: 'b',
          summary: 's',
          contentRevision: 1,
          digest: 'digest-b',
          priority: 50,
        },
        {
          memoryId: 'c',
          type: 'lesson' as const,
          title: 'c',
          summary: 's',
          contentRevision: 1,
          digest: 'digest-c',
          priority: 50,
        },
      ],
    }
    const refresher = new IndexRefresher({
      budget: { refreshMaxBytes: 100_000, refreshResetBytes: 1000, refreshMinIntervalMs: 60_000 },
      now: () => new Date('2026-11-17T12:00:10.000Z'),
    })
    const outcome = refresher.plan(expected, visible)
    expect(outcome.reset).toBe(true)
  })
})
