import { describe, expect, it } from 'vitest'
import {
  DreamScheduler,
  type ColdSessionRecord,
  type ColdSessionSnapshot,
  type DreamerLike,
  type SessionCursorStore,
} from '../../src/host/dream-scheduler.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import type { DreamRequest } from '../../src/host/dreamer.ts'
import type { DreamRun, SessionCursor } from '../../src/shared/types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

class MemoryCursors implements SessionCursorStore {
  readonly rows = new Map<string, SessionCursor>()
  get(sessionId: string): SessionCursor | undefined {
    return this.rows.get(sessionId)
  }
  async advance(cursor: SessionCursor): Promise<void> {
    this.rows.set(cursor.sessionId, cursor)
  }
}

class BackfillDreamer implements DreamerLike {
  readonly enqueued: DreamRequest[] = []
  constructor(private readonly finalStatus: DreamRun['status']) {}
  async enqueue(request: DreamRequest): Promise<DreamRun> {
    this.enqueued.push(request)
    return {
      id: 'dream-1' as DreamRun['id'],
      trigger: request.trigger,
      scopeKey: request.scopeKey,
      status: 'queued',
      startedAt: '',
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
  }
  async flush(): Promise<void> {}
  status(): DreamRun[] {
    return [
      {
        id: 'dream-1' as DreamRun['id'],
        trigger: 'auto',
        scopeKey: 'ws-a',
        status: this.finalStatus,
        startedAt: '',
        provider: '',
        model: '',
        episodes: 0,
        committed: 0,
        pending: 0,
      },
    ]
  }
}

function events(seqs: number[]): SessionEvent[] {
  return seqs.map(
    (seq) =>
      ({ type: 'turn/start', seq, time: seq, data: { turn: seq } }) as unknown as SessionEvent,
  )
}

function source(): { records: ColdSessionRecord[]; snapshots: Map<string, ColdSessionSnapshot> } {
  const now = Date.now()
  const records: ColdSessionRecord[] = [
    { header: { id: 's1', cwd: 'C:/ws/a', createdAt: now - 1000 } },
    { header: { id: 's2', cwd: 'C:/ws/a', createdAt: now - 2000 } },
  ]
  const snapshots = new Map<string, ColdSessionSnapshot>([
    ['s1', { events: events([1, 2, 3]) }],
    ['s2', { events: events([5, 6]) }],
  ])
  return { records, snapshots }
}

function makeScheduler(finalStatus: DreamRun['status'], cursors: MemoryCursors) {
  const fixture = source()
  const dreamer = new BackfillDreamer(finalStatus)
  const scheduler = new DreamScheduler({
    dreamer,
    config: resolveMemoryConfig({ autoDream: true }),
    cursorStore: cursors,
    coldSource: {
      listSessions: async () => fixture.records,
      readSession: async (id) => fixture.snapshots.get(id) ?? { events: [] },
    },
    ingestSession: async (input) => input.events.length,
  })
  return { scheduler, dreamer }
}

describe('cold backfill cursor', () => {
  it('processes only events after the cursor, advances on success, and does not repeat', async () => {
    const cursors = new MemoryCursors()
    const { scheduler, dreamer } = makeScheduler('completed', cursors)
    const first = await scheduler.backfillColdSessions('c:/ws/a')
    expect(first.sessions).toBe(2)
    expect(first.episodes).toBe(5)
    expect(dreamer.enqueued).toHaveLength(1)
    expect(cursors.get('s1')?.lastProcessedSeq).toBe(3)
    expect(cursors.get('s2')?.lastProcessedSeq).toBe(6)

    const second = await scheduler.backfillColdSessions('c:/ws/a')
    expect(second.episodes).toBe(0)
    expect(dreamer.enqueued).toHaveLength(1)
  })

  it('does not advance cursors when the dream failed', async () => {
    const cursors = new MemoryCursors()
    const { scheduler } = makeScheduler('failed', cursors)
    const report = await scheduler.backfillColdSessions('c:/ws/a')
    expect(report.episodes).toBe(5)
    expect(cursors.get('s1')).toBeUndefined()
    expect(cursors.get('s2')).toBeUndefined()
  })
})

describe('cold backfill in-flight dedupe', () => {
  it('returns immediately while the same scope is already scanning', async () => {
    const cursors = new MemoryCursors()
    const fixture = source()
    let listCalls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dreamer = new BackfillDreamer('completed')
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({ autoDream: true }),
      cursorStore: cursors,
      coldSource: {
        listSessions: async () => {
          listCalls += 1
          await gate
          return fixture.records
        },
        readSession: async (id) => fixture.snapshots.get(id) ?? { events: [] },
      },
      ingestSession: async (input) => input.events.length,
    })

    const first = scheduler.backfillColdSessions('c:/ws/a')
    const secondPromise = scheduler.backfillColdSessions('c:/ws/a')
    release?.()
    const [second, report] = await Promise.all([secondPromise, first])
    expect(second).toEqual({ sessions: 0, episodes: 0 })
    expect(report.episodes).toBe(5)
    expect(listCalls).toBe(1)
    expect(dreamer.enqueued).toHaveLength(1)
    expect(cursors.get('s1')?.lastProcessedSeq).toBe(3)
  })
})
