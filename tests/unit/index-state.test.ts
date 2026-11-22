import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  diffIndex,
  foldVisibleState,
  resetReason,
  type IndexVisibleState,
} from '../../src/host/index-state.ts'
import type { IndexEntry, MemoryIndexSnapshot } from '../../src/host/indexing.ts'
import type { MemoryIndexChange, MemoryIndexSource } from '../../src/shared/types.ts'

function messageWith(source: unknown): UserMessage {
  return {
    id: 'm',
    role: 'user',
    content: [{ type: 'text', text: 'index' }],
    source,
  } as unknown as UserMessage
}

function baselineSource(
  baselineId: string,
  scopeKey: string,
  changes: MemoryIndexChange[],
  mode: 'baseline' | 'reset' = 'baseline',
  invalidations: { memoryId: string; contentRevision: number }[] = [],
): MemoryIndexSource {
  return {
    kind: 'dsh-memory',
    form: 'memory-index',
    mode,
    protocolVersion: 1,
    baselineId,
    scopeKey,
    changes,
    invalidations,
  }
}

function deltaSource(
  baselineId: string,
  scopeKey: string,
  changes: MemoryIndexChange[],
): MemoryIndexSource {
  return { ...baselineSource(baselineId, scopeKey, changes), mode: 'delta' }
}

function add(id: string, revision: number, digest: string): MemoryIndexChange {
  return { action: 'add', memoryId: id, contentRevision: revision, digest }
}

function entry(id: string, revision: number, digest: string): IndexEntry {
  return {
    memoryId: id,
    type: 'lesson',
    title: id,
    summary: 'summary',
    contentRevision: revision,
    digest,
    priority: 50,
  }
}

function snapshot(entries: IndexEntry[]): MemoryIndexSnapshot {
  return { baselineId: 'b1', scopeKey: 'ws', entries }
}

describe('fold baseline', () => {
  it('reports the baseline changes as the visible state', () => {
    const state = foldVisibleState([
      messageWith(baselineSource('b1', 'ws', [add('a', 1, 'da'), add('b', 1, 'db')])),
    ])
    expect(state).toBeDefined()
    expect(state!.baselineId).toBe('b1')
    expect([...state!.entries.keys()].sort()).toEqual(['a', 'b'])
  })
})

describe('fold delta add/replace/remove', () => {
  it('applies deltas in order and ignores an older replacement', () => {
    const messages = [
      messageWith(baselineSource('b1', 'ws', [add('a', 1, 'da')])),
      messageWith(deltaSource('b1', 'ws', [add('b', 1, 'db')])),
      messageWith(
        deltaSource('b1', 'ws', [
          { action: 'replace', memoryId: 'a', contentRevision: 2, digest: 'da2' },
          { action: 'remove', memoryId: 'b', contentRevision: 1 },
        ]),
      ),
      // Older revision for `a` must be ignored.
      messageWith(
        deltaSource('b1', 'ws', [
          { action: 'replace', memoryId: 'a', contentRevision: 1, digest: 'old' },
        ]),
      ),
    ]
    const state = foldVisibleState(messages)
    expect(state).toBeDefined()
    expect(state!.entries.has('b')).toBe(false)
    expect(state!.entries.get('a')).toEqual({ memoryId: 'a', contentRevision: 2, digest: 'da2' })
  })
})

describe('fold reset', () => {
  it('clears the old cycle and records invalidations without contradictory removes', () => {
    const reset = baselineSource('b2', 'ws', [add('b', 1, 'db')], 'reset', [
      { memoryId: 'a', contentRevision: 3 },
    ])
    const state = foldVisibleState([
      messageWith(baselineSource('b1', 'ws', [add('a', 3, 'da')])),
      messageWith(reset),
    ])
    expect(state).toBeDefined()
    expect(state!.baselineId).toBe('b2')
    expect([...state!.entries.keys()]).toEqual(['b'])
    expect(reset.invalidations).toEqual([{ memoryId: 'a', contentRevision: 3 }])
    expect(reset.changes.some((change) => change.action === 'remove')).toBe(false)
  })
})

describe('fold incompatible', () => {
  it('rejects an unknown protocol version', () => {
    const bad = { ...baselineSource('b1', 'ws', [add('a', 1, 'da')]), protocolVersion: 2 }
    expect(foldVisibleState([messageWith(bad)])).toBeUndefined()
  })

  it('rejects a delta whose scope does not match its baseline', () => {
    const messages = [
      messageWith(baselineSource('b1', 'ws-a', [add('a', 1, 'da')])),
      messageWith(deltaSource('b1', 'ws-b', [add('b', 1, 'db')])),
    ]
    expect(foldVisibleState(messages)).toBeUndefined()
  })
})

describe('diff remove first', () => {
  it('emits a remove for a vanished record and no unrelated add', () => {
    const visible: IndexVisibleState = {
      baselineId: 'b1',
      scopeKey: 'ws',
      refreshBytes: 0,
      refreshedAt: undefined,
      entries: new Map([
        ['a', { memoryId: 'a', contentRevision: 1, digest: 'da' }],
        ['b', { memoryId: 'b', contentRevision: 1, digest: 'db' }],
      ]),
    }
    const changes = diffIndex(snapshot([entry('b', 1, 'db')]), visible)
    expect(changes).toEqual([{ action: 'remove', memoryId: 'a', contentRevision: 1 }])
  })
})

describe('fold recovery', () => {
  it('lets a later reset establish a baseline after an orphan delta', () => {
    const state = foldVisibleState([
      messageWith(deltaSource('b1', 'ws', [add('orphan', 1, 'd-orphan')])),
      messageWith(baselineSource('b2', 'ws', [add('a', 2, 'da2')], 'reset')),
    ])
    expect(state).toBeDefined()
    expect(state!.baselineId).toBe('b2')
    expect([...state!.entries.keys()]).toEqual(['a'])
  })

  it('does not let an older remove delete a newer visible record', () => {
    const state = foldVisibleState([
      messageWith(baselineSource('b1', 'ws', [add('a', 2, 'da2')])),
      messageWith(
        deltaSource('b1', 'ws', [{ action: 'remove', memoryId: 'a', contentRevision: 1 }]),
      ),
    ])
    expect(state!.entries.get('a')).toEqual({
      memoryId: 'a',
      contentRevision: 2,
      digest: 'da2',
    })
  })

  it('applies a same-revision digest replacement', () => {
    const state = foldVisibleState([
      messageWith(baselineSource('b1', 'ws', [add('a', 2, 'old')])),
      messageWith(
        deltaSource('b1', 'ws', [
          { action: 'replace', memoryId: 'a', contentRevision: 2, digest: 'new' },
        ]),
      ),
    ])
    expect(state!.entries.get('a')!.digest).toBe('new')
  })

  it('folds durable refresh bytes and timestamps for resume', () => {
    const message = messageWith({
      ...deltaSource('b1', 'ws', [add('b', 1, 'db')]),
      refreshBytes: 321,
      refreshedAt: '2026-11-17T12:00:00.000Z',
    })
    const state = foldVisibleState([
      messageWith(baselineSource('b1', 'ws', [add('a', 1, 'da')])),
      message,
    ])
    expect(state!.refreshBytes).toBe(321)
    expect(state!.refreshedAt).toBe(Date.parse('2026-11-17T12:00:00.000Z'))
  })

  it('uses the latest baseline for resetReason after a scope reset', () => {
    const fake = {
      deriveMessages: () => [
        messageWith(baselineSource('b1', 'ws-a', [add('a', 1, 'da')])),
        messageWith(baselineSource('b2', 'ws-b', [], 'reset')),
      ],
    }
    expect(resetReason(fake, { baselineId: 'b2', scopeKey: 'ws-b', entries: [] })).toBe('none')
  })
})
