import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import { runTool } from '../helpers/tool.ts'

describe('search index synchronisation', () => {
  it('drops capacity-archived derived victims from search results', async () => {
    const host = await openService({
      workingDirectory: () => 'C:/ws/a',
      config: { maxActiveMemories: 1 },
    })
    try {
      // Only derived records may be demoted automatically, so the victim is
      // seeded as dream output; an explicit write then makes room for itself.
      const store = (
        host.service as unknown as {
          store: {
            create: (input: {
              type: 'lesson'
              title: string
              body: string
              scope: { kind: 'workspace'; key: string; root: string }
              origin: 'dream'
              ownership: 'derived'
              sourceEpisodeIds: string[]
            }) => Promise<{ id: string }>
          }
        }
      ).store
      const first = await store.create({
        type: 'lesson',
        title: 'alpha victim',
        body: 'alpha unique body',
        scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
        origin: 'dream',
        ownership: 'derived',
        sourceEpisodeIds: ['episode-1'],
      })
      await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'beta current',
        body: 'beta body',
      })
      expect(host.service.read(first.id, 'c:/ws/a').status).toBe('archived')
      const search = await runTool(host.tools, 'memory_search', { query: 'alpha' })
      expect(search.results.map((hit: { id: string }) => hit.id)).not.toContain(first.id)
    } finally {
      await host.dispose()
    }
  })

  it('indexes store mutations outside the explicit write path', async () => {
    const host = await openService({ workingDirectory: () => 'C:/ws/a' })
    try {
      const store = (
        host.service as unknown as {
          store: {
            create: (input: {
              type: 'lesson'
              title: string
              body: string
              scope: { kind: 'workspace'; key: string; root: string }
            }) => Promise<{ id: string }>
          }
        }
      ).store
      const created = await store.create({
        type: 'lesson',
        title: 'direct store typecheck',
        body: 'direct store body',
        scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
      })
      const search = await runTool(host.tools, 'memory_search', { query: 'typecheck' })
      expect(search.results.map((hit: { id: string }) => hit.id)).toContain(created.id)
    } finally {
      await host.dispose()
    }
  })
})
