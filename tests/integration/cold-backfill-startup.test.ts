/**
 * Startup cold-session reconciliation (plan 07, Task 1).
 *
 * With `autoDream=true` the service scans recent cold sessions once at boot,
 * ingests their unseen turns and queues one dream. Cursors advance only after a
 * completed dream, so the next boot does not repeat the work. With
 * `autoDream=false` startup reads no session and calls no model for backfill.
 *
 * SessionHeader exposes `createdAt` (not `updatedAt`); the lookback therefore
 * filters on `createdAt`, matching design §4.5.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { memoryDomain } from '../../src/host/domain.ts'
import type { ColdSessionRecord } from '../../src/host/dream-scheduler.ts'
import type { DreamLlm } from '../../src/host/dreamer.ts'
import {
  assistantMessage,
  captureSession,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
  userMessage,
} from '../helpers/capture-events.ts'
import { dreamJson } from '../helpers/dream-llm.ts'
import { FakeDomainFacility } from '../helpers/fake-domain.ts'
import { openService } from '../helpers/service.ts'
import { DreamId, EpisodeId, type DreamRun, type EpisodeRecord } from '../../src/shared/types.ts'

const WORKSPACE = 'c:/ws/a'
const SESSION_ID = 'cold-1'

/** Two completed turns whose second turn includes a tool call. */
function coldSessionEvents(): SessionEvent[] {
  return [
    turnStart(1, 1),
    userMessage(2, 'scaffold the module'),
    toolCall(3, {
      callId: 'c1',
      name: 'write',
      arguments: '{"file_path":"C:/ws/a/a.ts"}',
      turn: 1,
    }),
    toolResult(4, { callId: 'c1', turn: 1 }),
    assistantMessage(5, 'scaffolded the module', 1, 1),
    turnEnd(6, 'completed', 1),
    turnStart(7, 2),
    userMessage(8, 'run the tests'),
    toolCall(9, {
      callId: 'c2',
      name: 'bash',
      arguments: '{"command":"pnpm test"}',
      turn: 2,
    }),
    toolResult(10, { callId: 'c2', turn: 2 }),
    assistantMessage(11, 'tests passed', 2, 1),
    turnEnd(12, 'completed', 2),
  ]
}

/** Two completed turns without tool calls, used for live capture then replay. */
function liveTurnEvents(): SessionEvent[] {
  return [
    turnStart(1, 1),
    userMessage(2, 'first live turn'),
    assistantMessage(3, 'first answer', 1, 1),
    turnEnd(4, 'completed', 1),
    turnStart(5, 2),
    userMessage(6, 'second live turn'),
    assistantMessage(7, 'second answer', 2, 1),
    turnEnd(8, 'completed', 2),
  ]
}

type Emitter = (event: string, ...args: unknown[]) => void

/** Emit one completed turn through the live session event path. */
function emitLiveTurn(
  emit: Emitter,
  session: Session,
  turn: number,
  base: number,
  prompt: string,
  answer: string,
): void {
  emit('session/event', session, turnStart(base, turn))
  emit('session/event', session, userMessage(base + 1, prompt))
  emit('session/event', session, assistantMessage(base + 2, answer, turn, 1))
  emit('session/event', session, turnEnd(base + 3, 'completed', turn))
}

/** Open a fresh facility, seed its memory domain, and close it again. */
async function seedFacility(
  seed: (domain: Domain<typeof memoryDomain>) => Promise<void>,
): Promise<FakeDomainFacility> {
  const facility = new FakeDomainFacility()
  const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
  try {
    await seed(domain)
  } finally {
    await domain.close()
  }
  return facility
}

/** Extract the episode ids the dream prompt lists. */
function promptedEpisodeIds(options: GenerateOptions): string[] {
  const messages = options.messages as readonly {
    content?: readonly { type: string; text?: string }[]
  }[]
  const text = messages
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  return [...text.matchAll(/### episode (\S+)/g)].map((match) => match[1]!)
}

/** A dream model that answers with a proposal for every episode in the prompt. */
function episodeAwareLlm(): DreamLlm & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  return {
    calls,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const text = dreamJson(promptedEpisodeIds(options))
      async function* generate(): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return generate()
    },
  }
}

/** A dream model whose first call never produces a chunk or finishes. */
function hangingLlm(): DreamLlm & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  return {
    calls,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      async function* generate(): AsyncGenerator<StreamChunk> {
        await new Promise(() => {})
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return generate()
    },
  }
}

function coldSessionSource(session: ColdSessionRecord, events: SessionEvent[]) {
  const source = {
    listCalls: 0,
    readCalls: 0,
    listSessions: async (): Promise<ColdSessionRecord[]> => {
      source.listCalls += 1
      return [session]
    },
    readSession: async (id: string): Promise<{ events: SessionEvent[] }> => {
      source.readCalls += 1
      return id === session.header.id ? { events } : { events: [] }
    },
  }
  return source
}

describe('startup cold-session reconciliation', () => {
  it('startup backfill', async () => {
    const createdAt = Date.now() - 60_000
    const session: ColdSessionRecord = { header: { id: SESSION_ID, cwd: 'C:/ws/a', createdAt } }
    const source = coldSessionSource(session, coldSessionEvents())
    const llm = episodeAwareLlm()
    const facility = new FakeDomainFacility()

    const first = await openService({
      facility,
      config: { autoDream: true },
      sessionQuery: source,
      llm,
    })
    try {
      // flush() also awaits the startup reconciliation pass.
      await first.service.flush()
      expect(source.listCalls).toBe(1)
      const completed = first.service.dreamRuns().filter((run) => run.status === 'completed')
      expect(completed).toHaveLength(1)
      expect(first.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items).toHaveLength(
        1,
      )
      expect(llm.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      await first.dispose()
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(domain.table('session_cursors').get(SESSION_ID)?.lastProcessedSeq).toBe(12)
      expect(domain.table('episodes').size).toBe(2)
      expect(domain.table('dreams').size).toBe(1)
    } finally {
      await domain.close()
    }

    source.listCalls = 0
    source.readCalls = 0
    const second = await openService({
      facility,
      config: { autoDream: true },
      sessionQuery: source,
      llm,
    })
    try {
      await second.service.flush()
      expect(source.listCalls).toBeGreaterThan(0)
      expect(second.service.dreamRuns()).toHaveLength(1)
      expect(
        second.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items,
      ).toHaveLength(1)
    } finally {
      await second.dispose()
    }

    const reopened = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(reopened.table('episodes').size).toBe(2)
      expect(reopened.table('dreams').size).toBe(1)
    } finally {
      await reopened.close()
    }
  })

  it('existing episodes are not replayed when cursors are empty', async () => {
    const createdAt = Date.now() - 60_000
    const session: ColdSessionRecord = { header: { id: 'live-1', cwd: 'C:/ws/a', createdAt } }
    const source = coldSessionSource(session, liveTurnEvents())
    const facility = new FakeDomainFacility()

    // autoDream=false: two live turns create two episodes but no cursor.
    const first = await openService({
      facility,
      config: { autoDream: false },
      sessionQuery: source,
    })
    try {
      const emit: Emitter = (event, ...args) => {
        ;(first.ctx as unknown as { emit(e: string, ...a: unknown[]): void }).emit(event, ...args)
      }
      const live = captureSession('live-1', 'C:/ws/a')
      emitLiveTurn(emit, live, 1, 1, 'first live turn', 'first answer')
      emitLiveTurn(emit, live, 2, 5, 'second live turn', 'second answer')
      await first.service.flush()
      expect(first.service.status().counts.queuedEpisodes).toBe(2)
      expect(source.listCalls).toBe(0)
    } finally {
      await first.dispose()
    }

    const before = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(before.table('episodes').size).toBe(2)
      expect(before.table('session_cursors').size).toBe(0)
    } finally {
      await before.close()
    }

    // autoDream=true: the existing episodes are processed once, not captured again.
    const llm = episodeAwareLlm()
    const second = await openService({
      facility,
      config: { autoDream: true },
      sessionQuery: source,
      llm,
    })
    try {
      await second.service.flush()
      const completed = second.service.dreamRuns().filter((run) => run.status === 'completed')
      expect(completed).toHaveLength(1)
      expect(llm.calls).toHaveLength(1)
      const pending = second.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items
      expect(pending).toHaveLength(1)
      expect(pending[0]?.scope).toEqual({
        kind: 'workspace',
        key: WORKSPACE,
        root: 'C:/ws/a',
      })
    } finally {
      await second.dispose()
    }

    const after = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(after.table('episodes').size).toBe(2)
      expect(after.table('dreams').size).toBe(1)
      expect(
        [...after.table('episodes').entries()].every(
          ([, episode]) => episode.status === 'processed',
        ),
      ).toBe(true)
    } finally {
      await after.close()
    }

    // A further boot has no pending episodes and must not create another dream.
    const third = await openService({
      facility,
      config: { autoDream: true },
      sessionQuery: source,
      llm,
    })
    try {
      await third.service.flush()
      expect(third.service.dreamRuns()).toHaveLength(1)
    } finally {
      await third.dispose()
    }
  })

  it('one failing workspace does not block another', async () => {
    const createdAt = Date.now() - 60_000
    const bad: ColdSessionRecord = { header: { id: 'bad-1', cwd: 'C:/ws/bad', createdAt } }
    const good: ColdSessionRecord = { header: { id: 'good-1', cwd: 'C:/ws/good', createdAt } }
    const source = {
      listCalls: 0,
      readCalls: 0,
      listSessions: async (): Promise<ColdSessionRecord[]> => {
        source.listCalls += 1
        return [bad, good]
      },
      readSession: async (id: string): Promise<{ events: SessionEvent[] }> => {
        source.readCalls += 1
        if (id === bad.header.id) throw new Error('broken session log')
        return { events: coldSessionEvents() }
      },
    }
    const llm = episodeAwareLlm()
    const facility = new FakeDomainFacility()
    const host = await openService({
      facility,
      config: { autoDream: true },
      sessionQuery: source,
      llm,
    })
    try {
      await host.service.flush()
      expect(source.listCalls).toBe(1)
      const completed = host.service.dreamRuns().filter((run) => run.status === 'completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]?.scopeKey).toBe('c:/ws/good')
      expect(
        host.service.list({ workspaceKey: 'c:/ws/good', status: 'pending' }).items,
      ).toHaveLength(1)
      expect(
        host.service.list({ workspaceKey: 'c:/ws/bad', status: 'pending' }).items,
      ).toHaveLength(0)
    } finally {
      await host.dispose()
    }
  })

  it('autoDream=false resumes an explicit queued dream without cold backfill', async () => {
    const createdAt = Date.now() - 60_000
    const session: ColdSessionRecord = { header: { id: 'cold-1', cwd: 'C:/ws/a', createdAt } }
    const source = coldSessionSource(session, coldSessionEvents())
    const episodeId = EpisodeId('episode-explicit')
    const dream: DreamRun = {
      id: DreamId('dream-explicit'),
      trigger: 'manual',
      scopeKey: WORKSPACE,
      status: 'queued',
      startedAt: '2026-11-18T00:00:00.000Z',
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
    const episode: EpisodeRecord = {
      id: episodeId,
      sessionId: 'session-explicit',
      workspaceKey: WORKSPACE,
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      status: 'new',
      attempts: 0,
      turn: 1,
      sourceSeqs: [1],
      prompt: 'explicit queued work',
      files: [],
      createdAt: '2026-11-18T00:00:00.000Z',
    }
    const facility = await seedFacility(async (domain) => {
      await domain.table('dreams').put(dream.id, dream)
      await domain.table('episodes').put(episodeId, episode)
    })
    const llm = episodeAwareLlm()
    const host = await openService({
      facility,
      config: { autoDream: false },
      sessionQuery: source,
      llm,
    })
    try {
      await host.service.flush()
      expect(source.listCalls).toBe(0)
      expect(source.readCalls).toBe(0)
      expect(llm.calls).toHaveLength(1)
      expect(host.service.dreamRuns().find((run) => run.id === 'dream-explicit')?.status).toBe(
        'completed',
      )
      expect(host.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items).toHaveLength(
        1,
      )
    } finally {
      await host.dispose()
    }
  })

  it('dispose does not wait forever for a stuck startup reconcile', async () => {
    const facility = new FakeDomainFacility()
    const source = {
      listSessions: (): Promise<ColdSessionRecord[]> => new Promise(() => {}),
      readSession: async (): Promise<{ events: SessionEvent[] }> => ({ events: [] }),
    }
    const host = await openService({
      facility,
      config: { autoDream: true },
      sessionQuery: source,
    })
    const started = Date.now()
    await host.dispose()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('dispose cancels a resumed dream whose model never returns', async () => {
    const episodeId = EpisodeId('episode-hanging')
    const dream: DreamRun = {
      id: DreamId('dream-hanging'),
      trigger: 'manual',
      scopeKey: WORKSPACE,
      status: 'queued',
      startedAt: '2026-11-18T00:00:00.000Z',
      provider: '',
      model: '',
      episodes: 0,
      committed: 0,
      pending: 0,
    }
    const episode: EpisodeRecord = {
      id: episodeId,
      sessionId: 'session-hanging',
      workspaceKey: WORKSPACE,
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      status: 'new',
      attempts: 0,
      turn: 1,
      sourceSeqs: [1],
      prompt: 'hanging dream work',
      files: [],
      createdAt: '2026-11-18T00:00:00.000Z',
    }
    const facility = await seedFacility(async (domain) => {
      await domain.table('dreams').put(dream.id, dream)
      await domain.table('episodes').put(episodeId, episode)
    })
    const llm = hangingLlm()
    const host = await openService({
      facility,
      config: { autoDream: false },
      llm,
    })
    try {
      await vi.waitFor(() => expect(llm.calls.length).toBeGreaterThan(0))
      const started = Date.now()
      await host.dispose()
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await host.dispose().catch(() => {})
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(['cancelled', 'failed']).toContain(domain.table('dreams').get(dream.id)?.status)
    } finally {
      await domain.close()
    }
  })

  it('skips fully processed newer sessions before applying maxSessions', async () => {
    const createdAt = Date.now() - 60_000
    const newer: ColdSessionRecord = { header: { id: 'newer-1', cwd: 'C:/ws/a', createdAt } }
    const older: ColdSessionRecord = {
      header: { id: 'older-1', cwd: 'C:/ws/a', createdAt: createdAt - 60_000 },
    }
    const source = {
      listCalls: 0,
      readCalls: 0,
      listSessions: async (): Promise<ColdSessionRecord[]> => {
        source.listCalls += 1
        return [newer, older]
      },
      readSession: async (id: string): Promise<{ events: SessionEvent[] }> => {
        source.readCalls += 1
        return { events: id === newer.header.id ? coldSessionEvents() : liveTurnEvents() }
      },
    }
    const facility = await seedFacility(async (domain) => {
      await domain.table('session_cursors').put('newer-1', {
        sessionId: 'newer-1',
        workspaceKey: WORKSPACE,
        lastProcessedSeq: 12,
        lastProcessedAt: '2026-11-18T00:00:00.000Z',
      })
    })
    const host = await openService({
      facility,
      config: { autoDream: true, dreamMaxSessionsPerRun: 1 },
      sessionQuery: source,
      llm: episodeAwareLlm(),
    })
    try {
      await host.service.flush()
      expect(source.listCalls).toBe(1)
      expect(host.service.dreamRuns().filter((run) => run.status === 'completed')).toHaveLength(1)
    } finally {
      await host.dispose()
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(domain.table('episodes').size).toBe(2)
      expect(domain.table('session_cursors').get('older-1')?.lastProcessedSeq).toBe(8)
      expect(domain.table('session_cursors').get('newer-1')?.lastProcessedSeq).toBe(12)
    } finally {
      await domain.close()
    }
  })

  it('backfill disabled', async () => {
    const createdAt = Date.now() - 60_000
    const session: ColdSessionRecord = { header: { id: SESSION_ID, cwd: 'C:/ws/a', createdAt } }
    const source = coldSessionSource(session, coldSessionEvents())
    const llm = episodeAwareLlm()
    const existingId = EpisodeId('episode-existing')
    const facility = await seedFacility(async (domain) => {
      await domain.table('episodes').put(existingId, {
        id: existingId,
        sessionId: 'session-existing',
        workspaceKey: WORKSPACE,
        workspaceRoot: 'C:/ws/a',
        kind: 'turn',
        status: 'new',
        attempts: 0,
        turn: 1,
        sourceSeqs: [1],
        files: [],
        createdAt: '2026-11-18T00:00:00.000Z',
      })
    })

    const host = await openService({
      facility,
      config: { autoDream: false },
      sessionQuery: source,
      llm,
    })
    try {
      await host.service.flush()
      expect(source.listCalls).toBe(0)
      expect(source.readCalls).toBe(0)
      expect(llm.calls).toHaveLength(0)
      expect(host.service.status().counts.queuedEpisodes).toBe(1)
      expect(host.service.dreamRuns()).toHaveLength(0)
    } finally {
      await host.dispose()
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(domain.table('episodes').size).toBe(1)
    } finally {
      await domain.close()
    }
  })
})
