/**
 * Dream queue startup recovery (plan 07, Task 1).
 *
 * A dream left `queued` by a previous process must resume on boot with the same
 * dream id; a dream left `running` without an operation record must fail and
 * return its episodes to the retryable pool. Recovery is idempotent.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveMemoryConfig } from '../../src/host/config.ts'
import { memoryDomain } from '../../src/host/domain.ts'
import { MemoryDreamer } from '../../src/host/dreamer.ts'
import { FakeDomainFacility } from '../helpers/fake-domain.ts'
import { dreamJson, scriptedLlm } from '../helpers/dream-llm.ts'
import { openStore } from '../helpers/runner.ts'
import { openService } from '../helpers/service.ts'
import { DreamId, EpisodeId, type DreamRun, type EpisodeRecord } from '../../src/shared/types.ts'

const WORKSPACE = 'ws-a'
const WORKSPACE_ROOT = 'C:/ws/a'

/** Build one queued dream record. */
function dreamRecord(
  id: string,
  status: DreamRun['status'] = 'queued',
  overrides: Partial<DreamRun> = {},
): DreamRun {
  return {
    id: DreamId(id),
    trigger: 'manual',
    scopeKey: WORKSPACE,
    status,
    startedAt: '2026-11-18T00:00:00.000Z',
    provider: status === 'running' ? 'deepseek' : '',
    model: status === 'running' ? 'deepseek-chat' : '',
    episodes: 0,
    committed: 0,
    pending: 0,
    ...overrides,
  }
}

/** Build one captured turn episode. */
function episodeRecord(id: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: EpisodeId(id),
    sessionId: 'session-1',
    workspaceKey: WORKSPACE,
    workspaceRoot: WORKSPACE_ROOT,
    kind: 'turn',
    status: 'new',
    attempts: 0,
    turn: 1,
    sourceSeqs: [1],
    files: [],
    createdAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

/** Concatenate the text blocks of one dream request. */
function promptText(options: GenerateOptions): string {
  const messages = options.messages as readonly {
    content?: readonly { type: string; text?: string }[]
  }[]
  return messages
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
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

describe('dream startup recovery', () => {
  it('queued dream resumes on boot', async () => {
    const episodeIds = [EpisodeId('episode-a'), EpisodeId('episode-b')]
    const facility = await seedFacility(async (domain) => {
      await domain.table('dreams').put(DreamId('dream-queued'), dreamRecord('dream-queued'))
      for (const id of episodeIds) {
        await domain.table('episodes').put(id, episodeRecord(id))
      }
    })
    const llm = scriptedLlm([dreamJson(episodeIds)])
    const host = await openService({ facility, llm })
    try {
      await vi.waitFor(() => {
        expect(host.service.dreamRuns().find((run) => run.id === 'dream-queued')?.status).toBe(
          'completed',
        )
      })
      const pending = host.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items
      expect(pending).toHaveLength(1)
      expect(pending[0]?.origin).toBe('dream')
      expect(host.service.status().counts.queuedEpisodes).toBe(0)
    } finally {
      await host.dispose()
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(domain.table('episodes').get(episodeIds[0]!)?.status).toBe('processed')
      expect(domain.table('episodes').get(episodeIds[1]!)?.status).toBe('processed')
    } finally {
      await domain.close()
    }
  })

  it('running dream on boot', async () => {
    const episodeId = EpisodeId('episode-running')
    const facility = await seedFacility(async (domain) => {
      await domain
        .table('dreams')
        .put(DreamId('dream-running'), dreamRecord('dream-running', 'running'))
      await domain.table('episodes').put(
        episodeId,
        episodeRecord(episodeId, {
          status: 'processing',
          attempts: 1,
          dreamId: 'dream-running',
        }),
      )
    })
    const host = await openService({ facility, llm: scriptedLlm([dreamJson([episodeId])]) })
    try {
      await vi.waitFor(() => {
        expect(host.service.dreamRuns().find((run) => run.id === 'dream-running')?.status).toBe(
          'failed',
        )
      })
    } finally {
      await host.dispose()
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      const episode = domain.table('episodes').get(episodeId)
      expect(episode?.status).toBe('failed-retryable')
      expect(episode?.attempts).toBe(2)
      expect(episode?.lastError).toContain('interrupted by restart')
    } finally {
      await domain.close()
    }
  })

  it('queued and running dreams settle independently on boot', async () => {
    const queuedEpisode = EpisodeId('episode-queued-coexist')
    const runningEpisode = EpisodeId('episode-running-coexist')
    const facility = await seedFacility(async (domain) => {
      await domain
        .table('dreams')
        .put(DreamId('dream-queued-coexist'), dreamRecord('dream-queued-coexist'))
      await domain
        .table('dreams')
        .put(
          DreamId('dream-running-coexist'),
          dreamRecord('dream-running-coexist', 'running', { scopeKey: 'ws-running' }),
        )
      await domain.table('episodes').put(queuedEpisode, episodeRecord(queuedEpisode))
      await domain.table('episodes').put(
        runningEpisode,
        episodeRecord(runningEpisode, {
          workspaceKey: 'ws-running',
          workspaceRoot: 'C:/ws/running',
          status: 'processing',
          attempts: 1,
          dreamId: 'dream-running-coexist',
        }),
      )
    })
    const host = await openService({ facility, llm: scriptedLlm([dreamJson([queuedEpisode])]) })
    try {
      await vi.waitFor(() => {
        expect(
          host.service.dreamRuns().find((run) => run.id === 'dream-queued-coexist')?.status,
        ).toBe('completed')
        expect(
          host.service.dreamRuns().find((run) => run.id === 'dream-running-coexist')?.status,
        ).toBe('failed')
      })
      expect(host.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items).toHaveLength(
        1,
      )
    } finally {
      await host.dispose()
    }

    const domain = (await facility.open(memoryDomain)) as Domain<typeof memoryDomain>
    try {
      expect(domain.table('episodes').get(queuedEpisode)?.status).toBe('processed')
      expect(domain.table('episodes').get(runningEpisode)?.status).toBe('failed-retryable')
      expect(domain.table('episodes').get(runningEpisode)?.attempts).toBe(2)
    } finally {
      await domain.close()
    }
  })

  it('queued dream without episodes completes on boot', async () => {
    const facility = await seedFacility(async (domain) => {
      await domain.table('dreams').put(DreamId('dream-empty'), dreamRecord('dream-empty'))
    })
    const llm = scriptedLlm([''])
    const host = await openService({ facility, llm })
    try {
      await vi.waitFor(() => {
        expect(host.service.dreamRuns().find((run) => run.id === 'dream-empty')?.status).toBe(
          'completed',
        )
      })
      expect(host.service.dreamRuns().find((run) => run.id === 'dream-empty')?.episodes).toBe(0)
      expect(llm.calls).toHaveLength(0)
      expect(host.service.list({ workspaceKey: WORKSPACE, status: 'pending' }).items).toHaveLength(
        0,
      )
    } finally {
      await host.dispose()
    }
  })

  it('resume is idempotent', async () => {
    const { store, runner } = await openStore()
    await store.putDream(dreamRecord('dream-idempotent'))
    const claimedIds: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const episode = await store.appendEpisode({
        sessionId: 'session-1',
        workspaceKey: WORKSPACE,
        workspaceRoot: WORKSPACE_ROOT,
        kind: 'turn',
        turn: index + 1,
        sourceSeqs: [index + 1],
        prompt: 'run the build',
        files: [],
      })
      if (episode === undefined) throw new Error('episode was not stored')
      claimedIds.push(episode.id)
    }
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm: scriptedLlm([dreamJson(claimedIds)]),
    })

    expect(await dreamer.resumeQueued()).toBe(1)
    expect(await dreamer.resumeQueued()).toBe(0)
    await dreamer.flush()

    expect(store.dreamList()).toHaveLength(1)
    expect(store.list({ workspaceKey: WORKSPACE, status: 'pending' }).items).toHaveLength(1)
    expect(await dreamer.resumeQueued()).toBe(0)
    expect(store.dreamList()).toHaveLength(1)
    expect(store.list({ workspaceKey: WORKSPACE, status: 'pending' }).items).toHaveLength(1)
  })

  it('manual queued dreams resume before auto', async () => {
    const { store, runner } = await openStore()
    const manualEpisode = await store.appendEpisode({
      sessionId: 'session-manual',
      workspaceKey: 'ws-manual',
      workspaceRoot: 'C:/ws/manual',
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'manual request',
      files: [],
    })
    const autoEpisode = await store.appendEpisode({
      sessionId: 'session-auto',
      workspaceKey: 'ws-auto',
      workspaceRoot: 'C:/ws/auto',
      kind: 'turn',
      turn: 1,
      sourceSeqs: [1],
      prompt: 'auto request',
      files: [],
    })
    if (manualEpisode === undefined || autoEpisode === undefined) {
      throw new Error('episode was not stored')
    }
    await store.putDream(
      dreamRecord('dream-manual', 'queued', {
        trigger: 'manual',
        scopeKey: 'ws-manual',
        startedAt: '2026-11-18T01:00:00.000Z',
      }),
    )
    await store.putDream(
      dreamRecord('dream-auto', 'queued', {
        trigger: 'auto',
        scopeKey: 'ws-auto',
        startedAt: '2026-11-18T00:00:00.000Z',
      }),
    )
    const llm = scriptedLlm([dreamJson([manualEpisode.id]), dreamJson([autoEpisode.id])])
    const dreamer = new MemoryDreamer({
      store,
      runner,
      config: resolveMemoryConfig({}),
      llm,
    })

    expect(await dreamer.resumeQueued()).toBe(2)
    await dreamer.flush()

    expect(llm.calls).toHaveLength(2)
    expect(promptText(llm.calls[0]!)).toContain('manual request')
    expect(promptText(llm.calls[1]!)).toContain('auto request')
    expect(store.dreamList().every((dream) => dream.status === 'completed')).toBe(true)
  })
})
