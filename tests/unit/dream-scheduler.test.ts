import { afterEach, describe, expect, it, vi } from 'vitest'
import { DreamScheduler, type DreamerLike } from '../../src/host/dream-scheduler.ts'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import type { DreamRequest } from '../../src/host/dreamer.ts'
import type { DreamRun } from '../../src/shared/types.ts'

class FakeDreamer implements DreamerLike {
  readonly enqueued: DreamRequest[] = []
  async enqueue(request: DreamRequest): Promise<DreamRun> {
    this.enqueued.push(request)
    return {
      id: `dream-${this.enqueued.length}` as DreamRun['id'],
      trigger: request.trigger,
      scopeKey: request.scopeKey,
      status: 'queued',
      startedAt: new Date().toISOString(),
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
  }
  async flush(): Promise<void> {}
  status(): DreamRun[] {
    return []
  }
}

class TrackingDreamer implements DreamerLike {
  readonly enqueued: DreamRequest[] = []
  readonly runs = new Map<string, DreamRun>()
  readonly cancelled: string[] = []

  async enqueue(request: DreamRequest): Promise<DreamRun> {
    const id = `dream-${this.enqueued.length + 1}` as DreamRun['id']
    const run: DreamRun = {
      id,
      trigger: request.trigger,
      scopeKey: request.scopeKey,
      status: 'queued',
      startedAt: new Date().toISOString(),
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
    this.enqueued.push(request)
    this.runs.set(id, run)
    return run
  }

  async flush(): Promise<void> {
    for (const [id, run] of this.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        this.runs.set(id, { ...run, status: 'completed', finishedAt: new Date().toISOString() })
      }
    }
  }

  status(): DreamRun[] {
    return [...this.runs.values()]
  }

  async cancel(dreamId: string): Promise<boolean> {
    const run = this.runs.get(dreamId)
    if (run === undefined || (run.status !== 'queued' && run.status !== 'running')) return false
    this.runs.set(dreamId, { ...run, status: 'cancelled', finishedAt: new Date().toISOString() })
    this.cancelled.push(dreamId)
    return true
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('forced replay', () => {
  it('replays cold sessions for an explicit rebuild even when autoDream is off', async () => {
    const dreamer = new TrackingDreamer()
    const now = new Date('2026-01-10T00:00:00.000Z')
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({ autoDream: false }),
      now: () => now,
      coldSource: {
        listSessions: async () => [
          { header: { id: 's1', cwd: 'C:/ws/a', createdAt: now.getTime() - 60_000 } },
        ],
        readSession: async () => ({
          events: [{ seq: 3 } as never],
        }),
      },
      ingestSession: async (input) => input.events.length,
    })
    try {
      const report = await scheduler.backfillColdSessions('c:/ws/a', {
        force: true,
        trigger: 'rebuild',
        lookbackDays: 90,
        includePendingEpisodes: true,
      })
      expect(report.sessions).toBe(1)
      expect(report.episodes).toBe(1)
      expect(dreamer.enqueued).toHaveLength(1)
      expect(dreamer.enqueued[0]?.trigger).toBe('rebuild')
    } finally {
      await scheduler.dispose()
    }
  })
})

describe('auto dream disabled', () => {
  it('schedules no timer and enqueues nothing when autoDream is false', async () => {
    vi.useFakeTimers()
    const dreamer = new FakeDreamer()
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({ autoDream: false }),
    })
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(dreamer.enqueued).toHaveLength(0)
    await scheduler.dispose()
  })
})

describe('auto dream debounce', () => {
  it('cancels on a new turn, enqueues once after idle, and respects the minimum interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const dreamer = new FakeDreamer()
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({
        autoDream: true,
        dreamIdleDelayMs: 30_000,
        autoDreamMinIntervalMs: 300_000,
      }),
    })

    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(20_000)
    scheduler.onTurnStart('ws-a')
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(dreamer.enqueued).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(dreamer.enqueued).toHaveLength(1)

    // A second idle within the minimum interval does not enqueue again.
    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(dreamer.enqueued).toHaveLength(1)
    await scheduler.dispose()
  })
})

describe('scheduler dispose', () => {
  it('cancels every queued dream and never completes an earlier one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const dreamer = new TrackingDreamer()
    const scheduler = new DreamScheduler({
      dreamer,
      config: resolveMemoryConfig({
        autoDream: true,
        dreamIdleDelayMs: 10_000,
        autoDreamMinIntervalMs: 0,
      }),
    })

    scheduler.onTurnEnd('ws-a', 'C:/ws/a')
    await vi.advanceTimersByTimeAsync(10_000)
    scheduler.onTurnEnd('ws-b', 'C:/ws/b')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dreamer.enqueued).toHaveLength(2)

    await scheduler.dispose()

    expect(dreamer.cancelled).toEqual(['dream-1', 'dream-2'])
    expect(dreamer.runs.get('dream-1')?.status).toBe('cancelled')
    expect(dreamer.runs.get('dream-2')?.status).toBe('cancelled')
  })
})
