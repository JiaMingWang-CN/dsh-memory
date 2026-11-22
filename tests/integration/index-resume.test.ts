import { describe, expect, it } from 'vitest'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { recoverIndexState, resetReason } from '../../src/host/index-state.ts'
import type { MemoryIndexChange } from '../../src/shared/types.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import {
  baselineSource,
  deltaSource,
  fakeContext,
  FakeIndexService,
  humanMessage,
  indexEntry,
  indexMessage,
  preference,
  snapshotOf,
  WS,
  WS_B,
} from '../helpers/index-fixtures.ts'

function add(id: string, revision = 1, digest = `digest-${id}`): MemoryIndexChange {
  return { action: 'add', memoryId: id, contentRevision: revision, digest }
}

describe('resume from surface', () => {
  it('folds a baseline plus deltas and does not re-inject', async () => {
    const messages = [
      indexMessage(baselineSource('b1', WS.key, [add('a', 1, 'da')])),
      indexMessage(deltaSource('b1', WS.key, [add('b', 1, 'db')])),
      indexMessage(
        deltaSource('b1', WS.key, [
          { action: 'replace', memoryId: 'a', contentRevision: 2, digest: 'da2' },
        ]),
      ),
    ]
    const fake = makeFakeAgent({ messages })
    const state = recoverIndexState(fake.session)
    expect(state).toBeDefined()
    expect(state!.entries.get('a')).toEqual({ memoryId: 'a', contentRevision: 2, digest: 'da2' })
    expect(state!.entries.has('b')).toBe(true)

    const service = new FakeIndexService([preference('p1')])
    const injector = new MemoryIndexInjector({ ctx: fakeContext(), service })
    const decision = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(0)
  })
})

describe('resume missing baseline', () => {
  it('resets when only deltas are visible', async () => {
    const messages = [indexMessage(deltaSource('b1', WS.key, [add('a')]))]
    const fake = makeFakeAgent({ messages })
    expect(recoverIndexState(fake.session)).toBeUndefined()
    expect(resetReason(fake.session, snapshotOf(WS.key, [indexEntry('a')], 'b1'))).toBe(
      'missing-baseline',
    )

    const service = new FakeIndexService([])
    const injector = new MemoryIndexInjector({ ctx: fakeContext(), service })
    const decision = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 1 },
      async () => ({ kind: 'enter', messages: [humanMessage()] }),
    )
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source.kind).toBe('dsh-memory')
    if (injected.source.kind !== 'dsh-memory') throw new Error('unreachable')
    expect(injected.source.mode).toBe('reset')
  })
})

describe('compaction', () => {
  it('resets instead of treating shadowed history as visible', async () => {
    // Compaction shadows the baseline; only a delta survives on the surface.
    const messages = [indexMessage(deltaSource('b1', WS.key, [add('a')]))]
    const fake = makeFakeAgent({ messages })
    expect(recoverIndexState(fake.session)).toBeUndefined()

    const service = new FakeIndexService([])
    const injector = new MemoryIndexInjector({ ctx: fakeContext(), service })
    const decision = await injector.handlePreStep(
      { agent: fake.agent, messages: [humanMessage()], step: 1 },
      async () => ({ kind: 'enter', messages: [humanMessage()] }),
    )
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injected = decision.messages[1]!
    if (injected.source.kind !== 'dsh-memory') throw new Error('unreachable')
    expect(injected.source.mode).toBe('reset')
    // The reset describes only the new (empty) snapshot.
    expect(injected.source.changes).toEqual([])
  })
})

describe('scope mismatch', () => {
  it('reports a scope change when the baseline scope differs', () => {
    const fake = makeFakeAgent({
      messages: [indexMessage(baselineSource('b1', WS.key, [add('a')]))],
    })
    expect(resetReason(fake.session, snapshotOf(WS_B.key, [indexEntry('b')], 'b2'))).toBe(
      'scope-change',
    )
  })
})
