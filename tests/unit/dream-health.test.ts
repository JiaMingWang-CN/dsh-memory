import { describe, expect, it } from 'vitest'
import { checkDreamHealth, renderDreamHealth } from '../../src/host/dream-health.ts'
import { buildDreamPrompt } from '../../src/host/dream-prompt.ts'
import type { EpisodeId } from '../../src/shared/types.ts'
import { openStore } from '../helpers/runner.ts'

const WORKSPACE = { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' } as const

async function addEpisode(
  store: Awaited<ReturnType<typeof openStore>>['store'],
  options: { turn: number; toolName?: string; toolError?: string },
): Promise<EpisodeId> {
  const episode = await store.appendEpisode({
    sessionId: 'session-1',
    workspaceKey: 'ws-a',
    workspaceRoot: 'C:/ws/a',
    kind: options.toolName === undefined ? 'turn' : 'tool-failure',
    turn: options.turn,
    sourceSeqs: [options.turn],
    prompt: `prompt ${options.turn}`,
    files: [],
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    ...(options.toolError === undefined ? {} : { toolError: options.toolError }),
  })
  if (episode === undefined) throw new Error('episode was not stored')
  return episode.id
}

describe('dream health', () => {
  it('health counts', async () => {
    const { store } = await openStore()
    const sourceId = await addEpisode(store, {
      turn: 1,
      toolName: 'web_fetch',
      toolError: 'WEB_PROVIDER_ERROR',
    })
    await addEpisode(store, { turn: 2, toolName: 'web_fetch', toolError: 'WEB_PROVIDER_ERROR' })
    await addEpisode(store, { turn: 3 })

    await store.create({
      type: 'worklog',
      worklogKind: 'daily',
      title: 'Daily summary 2026-11-19',
      body: 'A daily summary.',
      scope: WORKSPACE,
      status: 'active',
      origin: 'system',
      sourceEpisodeIds: [sourceId],
    })
    await store.create({
      type: 'lesson',
      title: 'Always run typecheck first',
      body: 'Run typecheck before building.',
      scope: WORKSPACE,
      status: 'active',
    })
    await store.create({
      type: 'lesson',
      title: 'Always run typecheck first',
      body: 'Run typecheck before building.',
      scope: WORKSPACE,
      status: 'pending',
      origin: 'dream',
      sourceEpisodeIds: [sourceId],
    })

    const health = checkDreamHealth(store, WORKSPACE)

    expect(health.pendingEpisodes).toBe(3)
    expect(health.duplicateToolFailures).toBe(2)
    expect(health.pendingProposals).toBe(1)
    expect(health.duplicatePendingTitles).toEqual(['Always run typecheck first'])
    expect(health.missingDaily).toBe(false)
    expect(health.activeByType).toEqual({ lesson: 1, worklog: 1, wiki: 0, preference: 0 })
    expect(health.issues).toHaveLength(4)
    expect(renderDreamHealth(health).split('\n')).toHaveLength(4)
  })

  it('health empty', async () => {
    const { store } = await openStore()
    const episodeId = await addEpisode(store, { turn: 1 })
    await store.create({
      type: 'worklog',
      worklogKind: 'daily',
      title: 'Daily summary 2026-11-19',
      body: 'A daily summary.',
      scope: WORKSPACE,
      status: 'active',
      origin: 'system',
      sourceEpisodeIds: [episodeId],
    })
    // A processed episode is not pending any more.
    await store.updateEpisode(episodeId, { status: 'processed' })

    const health = checkDreamHealth(store, WORKSPACE)

    expect(health.pendingEpisodes).toBe(0)
    expect(health.duplicateToolFailures).toBe(0)
    expect(health.pendingProposals).toBe(0)
    expect(health.duplicatePendingTitles).toEqual([])
    expect(health.missingDaily).toBe(false)
    expect(health.activeByType).toEqual({ lesson: 0, worklog: 1, wiki: 0, preference: 0 })
    expect(health.issues).toEqual([])
    expect(renderDreamHealth(health)).toBe('')
  })

  it('redacts secrets in duplicate pending titles', async () => {
    const { store } = await openStore()
    const episodeId = await addEpisode(store, { turn: 1 })
    const title = 'Deploy with password=hunter2'
    await store.create({
      type: 'lesson',
      title,
      body: 'Deploy notes.',
      scope: WORKSPACE,
      status: 'active',
    })
    await store.create({
      type: 'lesson',
      title,
      body: 'Deploy notes.',
      scope: WORKSPACE,
      status: 'pending',
      origin: 'dream',
      sourceEpisodeIds: [episodeId],
    })

    const health = checkDreamHealth(store, WORKSPACE)
    expect(health.duplicatePendingTitles).toEqual(['Deploy with [REDACTED]'])
    expect(health.issues.join('\n')).not.toContain('hunter2')
    expect(health.issues.join('\n')).toContain('[REDACTED]')

    const prompt = buildDreamPrompt({ episodes: store.episodeList(), related: [], health })
    expect(prompt).not.toContain('hunter2')
    expect(prompt).toContain('[REDACTED]')
  })
})
