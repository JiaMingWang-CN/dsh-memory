import { describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MemoryCapture } from '../../src/host/capture.ts'
import { memoryDomain } from '../../src/host/domain.ts'
import { DreamScheduler, DomainSessionCursorStore } from '../../src/host/dream-scheduler.ts'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { OperationRunner } from '../../src/host/operations.ts'
import { computeProposalKey } from '../../src/host/proposal.ts'
import { MemoryStore } from '../../src/host/store.ts'
import { buildWorklogContent, shouldCreateWorklog } from '../../src/host/worklog.ts'
import { MemoryId } from '../../src/shared/types.ts'
import { scriptedLlm } from '../helpers/dream-llm.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { FakeDomainFacility } from '../helpers/fake-domain.ts'

const WS_A = { kind: 'workspace' as const, key: 'c:/ws/a', root: 'C:/ws/a' }

async function openStore(options?: {
  now?: () => Date
  logger?: { warn?: (msg: string) => void }
}) {
  const facility = new FakeDomainFacility()
  const domain = (await facility.open(memoryDomain)) as unknown as Domain<typeof memoryDomain>
  const runner = new OperationRunner(domain, options?.now === undefined ? {} : { now: options.now })
  const store = new MemoryStore(domain, runner, {
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.logger === undefined ? {} : { logger: options.logger }),
  })
  await store.initialize()
  return { domain, runner, store }
}

describe('Batch 3 audit regressions', () => {
  it('[H5] global scope rejects non-preference proposals and workspace organize never exposes global preferences', async () => {
    const { store, runner } = await openStore()
    const globalPref = await store.create({
      type: 'preference',
      title: 'Global pref',
      body: 'Always dark mode',
      scope: { kind: 'global' },
    })
    const wsLesson = await store.create({
      type: 'lesson',
      title: 'WS lesson',
      body: 'Use pnpm',
      scope: WS_A,
    })

    // 1. store.writeDreamProposal rejects non-preference global record.
    await expect(
      store.writeDreamProposal(
        makeMemoryRecord({
          id: MemoryId('bad-global-lesson'),
          type: 'lesson',
          scope: { kind: 'global' },
          status: 'pending',
          origin: 'dream',
          ownership: 'derived',
          sourceEpisodeIds: ['ep-1'],
        }),
        'dream-1',
        'op-1',
      ),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN_SCOPE' })

    // 2. Workspace organize prompt must include wsLesson but NOT globalPref.
    const llm = scriptedLlm([JSON.stringify({ memories: [] })])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      llm: llm as never,
      config: { dreamModelMode: 'fixed', dreamProvider: 'p', dreamModel: 'm' },
    })
    await dreamer.enqueue({
      scopeKey: WS_A.key,
      scopeKind: 'workspace',
      scopeRoot: WS_A.root,
      trigger: 'organize',
    })
    await dreamer.flush()
    expect(llm.calls).toHaveLength(1)
    const promptText = JSON.stringify(llm.calls[0]!.messages)
    expect(promptText).toContain(wsLesson.id)
    expect(promptText).not.toContain(globalPref.id)

    // 3. Global dream rejecting a non-preference entry from LLM.
    const ep = await store.appendEpisode({
      sessionId: 's1',
      workspaceKey: 'global',
      workspaceRoot: 'global',
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'hi',
    })
    const badGlobalLlm = scriptedLlm([
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Bad global',
            body: 'Should fail',
            confidence: 0.9,
            importance: 0.7,
            sourceEpisodeIds: [ep!.id],
          },
        ],
      }),
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Still bad global',
            body: 'Should fail',
            confidence: 0.9,
            importance: 0.7,
            sourceEpisodeIds: [ep!.id],
          },
        ],
      }),
    ])
    const dreamer2 = new MemoryDreamer({
      store,
      runner,
      llm: badGlobalLlm as never,
      config: { dreamModelMode: 'fixed', dreamProvider: 'p', dreamModel: 'm' },
    })
    const run = await dreamer2.enqueue({
      scopeKey: 'global',
      scopeKind: 'global',
      trigger: 'manual',
    })
    await dreamer2.flush()
    expect(store.getDream(run.id)?.status).toBe('failed')
  })

  it('[H8] uncaught error before inner try/catch transitions DreamRun to failed instead of stuck queued/running', async () => {
    const { store, runner } = await openStore()
    await store.appendEpisode({
      sessionId: 's-h8',
      workspaceKey: WS_A.key,
      workspaceRoot: WS_A.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'test',
    })
    ;(store as unknown as { claimEpisodes: () => Promise<never> }).claimEpisodes = async () => {
      throw new Error('claim storage error before inner try')
    }
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: { dreamModelMode: 'fixed', dreamProvider: 'p', dreamModel: 'm' },
    })
    const run = await dreamer.enqueue({
      scopeKey: WS_A.key,
      scopeKind: 'workspace',
      scopeRoot: WS_A.root,
      trigger: 'manual',
    })
    await dreamer.flush()
    expect(store.getDream(run.id)?.status).toBe('failed')
    expect(store.getDream(run.id)?.error).toContain('claim storage error')
  })

  it('[H9] startDream does not resurrect a concurrently cancelled dream', async () => {
    const { store } = await openStore()
    const queued = await store.putDream({
      id: 'dream-race' as never,
      scopeKey: WS_A.key,
      trigger: 'manual',
      status: 'queued',
      provider: 'p',
      model: 'm',
      startedAt: '2026-11-15T00:00:00.000Z',
      episodes: 0,
      committed: 0,
      pending: 0,
    })
    expect(await store.cancelDream(queued.id)).toBe(true)
    const started = await store.startDream({ ...queued, status: 'running' })
    expect(started).toBeUndefined()
    expect(store.getDream(queued.id)?.status).toBe('cancelled')
  })

  it('[M9] parseOrganizeOutput rejects non-object or missing memories array and triggers 1-shot repair retry', async () => {
    const { store, runner } = await openStore()
    const rec = await store.create({
      type: 'lesson',
      title: 'Lesson 1',
      body: 'Body 1',
      scope: WS_A,
    })
    const llm = scriptedLlm([
      JSON.stringify({ wrongKey: [] }),
      JSON.stringify({
        memories: [
          {
            type: 'lesson',
            title: 'Merged Lesson',
            body: 'Clean body',
            confidence: 0.9,
            importance: 0.8,
            supersedes: [rec.id],
          },
        ],
      }),
    ])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      llm: llm as never,
      config: { dreamModelMode: 'fixed', dreamProvider: 'p', dreamModel: 'm' },
    })
    const run = await dreamer.enqueue({
      scopeKey: WS_A.key,
      scopeKind: 'workspace',
      scopeRoot: WS_A.root,
      trigger: 'organize',
    })
    await dreamer.flush()
    expect(llm.calls).toHaveLength(2)
    expect(store.getDream(run.id)?.status).toBe('completed')
    expect(store.getDream(run.id)?.pending).toBe(1)
  })

  it('[M10] explicitCompletion is wired from capture to worklog eligibility', async () => {
    const { store } = await openStore()
    const captured: Parameters<typeof shouldCreateWorklog>[0][] = []
    const capture = new MemoryCapture({
      store,
      onTurnEnd: (input) => {
        captured.push(input)
      },
    })
    const session = { id: 's-comp', header: { cwd: WS_A.root } } as unknown as Session
    capture.onSessionEvent(session, {
      seq: 1,
      type: 'turn/start',
      data: { turn: 1 },
    } as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 2,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'I finished the audit.' }] } },
    } as unknown as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 3,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)

    capture.onSessionEvent(session, {
      seq: 4,
      type: 'turn/start',
      data: { turn: 2 },
    } as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 5,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '搞定了，没问题了' }],
      },
    } as unknown as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 6,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    } as SessionEvent)
    await capture.flush()

    expect(captured).toHaveLength(2)
    expect(captured[0]!.explicitCompletion).toBe(false)
    expect(captured[1]!.explicitCompletion).toBe(true)
    expect(shouldCreateWorklog(captured[1]!)).toBe(true)
  })

  it('[M11] cold replay suppresses spoken remember after memory_write tool/result, honours expanded NEGATED_REMEMBER, and skips missing cwd', async () => {
    const { store } = await openStore()
    const capture = new MemoryCapture({ store })
    const session = { id: 's-cold', header: { cwd: WS_A.root } } as unknown as Session

    // Turn 1: user says remember, model calls memory_write via session events (cold replay, no live tools/result).
    capture.onSessionEvent(session, {
      seq: 1,
      type: 'turn/start',
      data: { turn: 1 },
    } as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 2,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '记住以后用 pnpm' }],
      },
    } as unknown as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 3,
      type: 'tool/call',
      data: { callId: 'c1', name: 'memory_write', arguments: '{}', step: 1 },
    } as unknown as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 4,
      type: 'tool/result',
      data: { message: { role: 'tool', isError: false, content: [], source: { callId: 'c1' } } },
    } as unknown as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 5,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)

    // Turn 2: negated remember ("不用记牢", "cannot remember").
    capture.onSessionEvent(session, {
      seq: 6,
      type: 'turn/start',
      data: { turn: 2 },
    } as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 7,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '这个不用记牢' }],
      },
    } as unknown as SessionEvent)
    capture.onSessionEvent(session, {
      seq: 8,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    } as SessionEvent)

    // Session without cwd: tool failure must not enqueue empty-workspaceKey episode.
    const noCwdSession = { id: 's-nocwd', header: {} } as unknown as Session
    capture.onSessionEvent(noCwdSession, {
      seq: 1,
      type: 'tool/result',
      data: {
        error: { code: 'ERR', reason: 'fail' },
        message: { role: 'tool', isError: true, content: [], source: { callId: 'c2' } },
      },
    } as unknown as SessionEvent)

    await capture.flush()
    expect(store.counts().stored).toBe(0)
    expect(store.episodeList({ workspaceKey: '' })).toEqual([])
  })

  it('[M12] computeProposalKey includes supersedes when present and updateDreamProposal updates supersedes and tags', async () => {
    const base = {
      type: 'lesson' as const,
      scope: WS_A,
      title: 'Title',
      body: 'Body',
      confidence: 0.8,
      importance: 0.7,
      sourceEpisodeIds: ['ep-1'],
    }
    expect(computeProposalKey({ ...base, supersedes: ['a'] })).not.toBe(
      computeProposalKey({ ...base, supersedes: ['b'] }),
    )
    expect(computeProposalKey({ ...base, supersedes: ['b', 'a'] })).toBe(
      computeProposalKey({ ...base, supersedes: ['a', 'b'] }),
    )

    const { store } = await openStore()
    const created = await store.writeDreamProposal(
      makeMemoryRecord({
        id: MemoryId('prop-u1'),
        type: 'lesson',
        scope: WS_A,
        status: 'pending',
        origin: 'dream',
        ownership: 'derived',
        sourceEpisodeIds: ['ep-1'],
        supersedes: ['old-1'],
        tags: ['t1'],
      }),
      'd1',
      'op1',
    )
    const updated = await store.updateDreamProposal(
      created.id,
      { supersedes: ['old-1', 'old-2'], tags: ['t1', 't2'] },
      'd2',
      'op2',
    )
    expect(updated.supersedes).toEqual(['old-1', 'old-2'])
    expect(updated.tags).toEqual(['t1', 't2'])
  })

  it('[M13] cold backfill skips ingestion when autoDream is paused and advances cursors on 0-episode scans', async () => {
    const { domain } = await openStore()
    const cursorStore = new DomainSessionCursorStore(domain)
    const ingest = vi.fn(async () => 0)
    const now = new Date('2026-11-20T00:00:00.000Z')
    let allowed = false

    const scheduler = new DreamScheduler({
      dreamer: {
        enqueue: vi.fn(),
        flush: vi.fn(async () => {}),
        status: () => [],
        autoDreamAllowed: () => allowed,
      } as never,
      config: { autoDream: true },
      cursorStore,
      now: () => now,
      coldSource: {
        listSessions: async () => [
          { header: { id: 'sess-empty', cwd: WS_A.root, createdAt: now.getTime() - 1000 } },
        ],
        readSession: async () => ({
          header: { id: 'sess-empty', cwd: WS_A.root, createdAt: now.getTime() - 1000 },
          events: [{ seq: 5, type: 'turn/start', data: { turn: 1 } } as SessionEvent],
        }),
      },
      ingestSession: ingest,
    })

    // While paused, auto backfill must not ingest anything.
    const pausedReport = await scheduler.backfillColdSessions(WS_A.key)
    expect(pausedReport).toEqual({ sessions: 0, episodes: 0 })
    expect(ingest).not.toHaveBeenCalled()

    // Once allowed, 0-episode scan advances cursor so subsequent pass skips it.
    allowed = true
    const firstPass = await scheduler.backfillColdSessions(WS_A.key)
    expect(firstPass).toEqual({ sessions: 1, episodes: 0 })
    expect(cursorStore.get('sess-empty')?.lastProcessedSeq).toBe(5)

    const secondPass = await scheduler.backfillColdSessions(WS_A.key)
    expect(secondPass).toEqual({ sessions: 0, episodes: 0 })
    expect(ingest).toHaveBeenCalledTimes(1)
  })

  it('[L7] worklog redacts before splitting title, puts list truncation on its own line, and warns on epoch-0 clock', async () => {
    const secret = 'sk-1234567890abcdefghijklmnop'
    const content = buildWorklogContent({
      kind: 'turn',
      sessionId: 's1',
      workspaceKey: WS_A.key,
      workspaceRoot: WS_A.root,
      turn: 1,
      sourceSeqs: [1],
      assistantFinal: `Rotated ${secret}. Next sentence.`,
      files: Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`),
      outcome: 'completed',
    })
    expect(content.title).not.toContain(secret)
    expect(content.body).toContain('\n…[truncated]')

    const warn = vi.fn()
    const facility = new FakeDomainFacility()
    const domain = (await facility.open(memoryDomain)) as unknown as Domain<typeof memoryDomain>
    const runner = new OperationRunner(domain, { now: () => new Date(1000) })
    const store = new MemoryStore(domain, runner, {
      now: () => new Date(1000),
      capacity: {
        activeLimit: 100,
        checkCreate: () => {},
        onActiveOverflow: () => [],
        assertActiveRoom: () => {},
        checkEpisodeQueue: () => {
          throw new Error('queue full')
        },
      },
      logger: { warn },
    })
    await store.initialize()
    const dropped = await store.appendEpisode({
      sessionId: 's1',
      workspaceKey: WS_A.key,
      workspaceRoot: WS_A.root,
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
    })
    expect(dropped).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
