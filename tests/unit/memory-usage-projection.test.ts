import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyMemoryUsage,
  memoryUsageDefinition,
  viewMemoryUsage,
  MEMORY_USAGE_KEY,
  type MemoryUsageState,
} from '../../src/host/projection.ts'
import type { MemoryIndexSource } from '../../src/shared/types.ts'
import { turnStart } from '../helpers/capture-events.ts'

/** Build a memory-index `user/message` event carrying the given source. */
function indexMessage(seq: number, source: MemoryIndexSource): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: {
      role: 'user',
      id: `u${seq}`,
      source,
      content: [{ type: 'text', text: 'memory index' }],
    },
  } as unknown as SessionEvent
}

/** Build a baseline source adding every supplied id. */
function baseline(...ids: string[]): MemoryIndexSource {
  return {
    kind: 'dsh-memory',
    form: 'memory-index',
    mode: 'baseline',
    protocolVersion: 1,
    baselineId: 'base-1',
    scopeKey: 'ws-a',
    changes: ids.map((memoryId) => ({
      action: 'add' as const,
      memoryId,
      contentRevision: 1,
      digest: 'd0',
    })),
    invalidations: [],
  }
}

/** Build a `tool/call` event for one memory tool. */
function toolCall(seq: number, callId: string, name: string, turn = 1): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn, step: 1, callId, name, arguments: '{}' },
  } as unknown as SessionEvent
}

/** Build a successful `tool/result` event carrying plain text output. */
function toolResult(seq: number, callId: string, text: string, turn = 1): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn,
      step: 1,
      message: {
        role: 'tool',
        id: `t${seq}`,
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
      },
    },
  } as unknown as SessionEvent
}

/** Fold a list of events through the projection state machine. */
function fold(events: readonly SessionEvent[]): MemoryUsageState {
  return events.reduce<MemoryUsageState>(
    (state, event) => applyMemoryUsage(state, event),
    memoryUsageDefinition.init(),
  )
}

describe('memoryUsage projection', () => {
  it('records every baseline memory id as injected', () => {
    const state = fold([turnStart(1, 1), indexMessage(2, baseline('m1', 'm2'))])
    const view = viewMemoryUsage(state)
    expect(view.totalInjected).toBe(2)
    expect(view.turns['1']).toEqual({ injected: ['m1', 'm2'], written: [], searched: 0 })
  })

  it('counts a search call without touching written memories', () => {
    const state = fold([turnStart(1, 1), toolCall(2, 'c1', 'memory_search')])
    const view = viewMemoryUsage(state)
    expect(view.turns['1']?.searched).toBe(1)
    expect(view.totalWritten).toBe(0)
    expect(view.totalInjected).toBe(0)
  })

  it('returns the same state and view references for unrelated events', () => {
    const seeded = fold([turnStart(1, 1), indexMessage(2, baseline('m1'))])
    const view = viewMemoryUsage(seeded)
    const next = applyMemoryUsage(seeded, {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'a3',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'text', text: 'ok' }],
        },
        stream: [],
      },
    } as unknown as SessionEvent)
    expect(next).toBe(seeded)
    expect(viewMemoryUsage(next)).toBe(view)
  })

  it('records a written memory id from the write result', () => {
    const state = fold([
      turnStart(1, 1),
      toolCall(2, 'c1', 'memory_write'),
      toolResult(3, 'c1', JSON.stringify({ id: 'm9', status: 'active' })),
    ])
    const view = viewMemoryUsage(state)
    expect(view.turns['1']?.written).toEqual(['m9'])
    expect(view.totalWritten).toBe(1)
  })

  it('exposes the projection key and a versioned pure-JSON definition', () => {
    expect(MEMORY_USAGE_KEY).toBe('memoryUsage')
    expect(memoryUsageDefinition.key).toBe('memoryUsage')
    expect(memoryUsageDefinition.stateVersion).toBe(1)
    // The initial state round-trips through JSON (checkpoint-safe).
    expect(JSON.parse(JSON.stringify(memoryUsageDefinition.init()))).toEqual(
      memoryUsageDefinition.init(),
    )
  })
})
