import { describe, expect, it } from 'vitest'
import { buildDreamPrompt, DREAM_SYSTEM_PROMPT } from '../../src/host/dream-prompt.ts'
import { checkDreamHealth, type DreamHealth } from '../../src/host/dream-health.ts'
import { MemoryId } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { openStore } from '../helpers/runner.ts'

const WORKSPACE = { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' } as const

function emptyHealth(): DreamHealth {
  return {
    pendingEpisodes: 0,
    duplicateToolFailures: 0,
    pendingProposals: 0,
    duplicatePendingTitles: [],
    activeByType: { lesson: 0, worklog: 0, wiki: 0, preference: 0 },
    missingDaily: false,
    issues: [],
  }
}

async function addEpisode(
  store: Awaited<ReturnType<typeof openStore>>['store'],
  turn: number,
): Promise<string> {
  const episode = await store.appendEpisode({
    sessionId: 'session-1',
    workspaceKey: 'ws-a',
    workspaceRoot: 'C:/ws/a',
    kind: 'turn',
    turn,
    sourceSeqs: [turn],
    prompt: `prompt ${turn}`,
    assistantFinal: `answer ${turn}`,
    outcome: 'completed',
    files: [],
  })
  if (episode === undefined) throw new Error('episode was not stored')
  return episode.id
}

describe('dream prompt', () => {
  it('system prompt evidence rules', () => {
    expect(DREAM_SYSTEM_PROMPT).toContain('unverified')
    expect(DREAM_SYSTEM_PROMPT).toContain('user stated')
    expect(DREAM_SYSTEM_PROMPT).toContain('sourceEpisodeIds')
    expect(DREAM_SYSTEM_PROMPT).toContain('one topic')
    expect(DREAM_SYSTEM_PROMPT).toContain('do not store')
    expect(DREAM_SYSTEM_PROMPT).toContain('AGENTS.md')
    expect(DREAM_SYSTEM_PROMPT).toContain('CLAUDE.md')
    expect(DREAM_SYSTEM_PROMPT).toContain('README')
    expect(DREAM_SYSTEM_PROMPT).toContain('skills')
    expect(DREAM_SYSTEM_PROMPT).toContain('broad request')
    expect(DREAM_SYSTEM_PROMPT).not.toContain('ws-a')
    expect(DREAM_SYSTEM_PROMPT).not.toContain('Always run typecheck first')
  })

  it('prompt includes health', async () => {
    const { store } = await openStore()
    await addEpisode(store, 1)
    const health = checkDreamHealth(store, WORKSPACE)
    expect(health.issues.length).toBeGreaterThan(0)

    const prompt = buildDreamPrompt({ episodes: store.episodeList(), related: [], health })

    expect(prompt).toContain('## Health checks already computed')
    expect(prompt).toContain(`${health.pendingEpisodes} pending episode(s)`)
  })

  it('renders a related memory with its id and importance so supersedes can cite it', () => {
    const record = makeMemoryRecord({
      id: MemoryId('mem-rule'),
      title: 'Always run typecheck first',
      importance: 0.8,
    })
    const prompt = buildDreamPrompt({ episodes: [], related: [record], health: emptyHealth() })
    expect(prompt).toContain('(id: mem-rule, importance: 0.8)')
  })

  it('episode prefix', async () => {
    const { store } = await openStore()
    const ids = [await addEpisode(store, 1), await addEpisode(store, 2), await addEpisode(store, 3)]
    const episodes = store.episodeList()
    const prompt = buildDreamPrompt({
      episodes,
      related: [],
      health: checkDreamHealth(store, WORKSPACE),
    })

    const positions = ids.map((id) => prompt.indexOf(`### episode ${id}`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(new Set(positions).size).toBe(ids.length)

    for (const episode of episodes) {
      expect(prompt).toContain(episode.id)
      expect(prompt).toContain(episode.sessionId)
      expect(prompt).toContain(`seq ${episode.sourceSeqs.join(',')}`)
    }
  })
})
