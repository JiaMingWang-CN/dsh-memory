import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import { runTool, getTool } from '../helpers/tool.ts'

const directories: Record<string, string> = {
  'agent-a': 'C:/ws/a',
  'agent-b': 'C:/ws/b',
}

function openWorkspaceService() {
  return openService({
    workingDirectory: (agent) => directories[(agent as { id: string }).id] ?? 'C:/ws/a',
  })
}

describe('memory_search tool', () => {
  it('returns the current workspace plus global records in auto scope', async () => {
    const host = await openWorkspaceService()
    try {
      const a = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'typecheck before build',
          body: 'always run typecheck before building',
        },
        'agent-a',
      )
      const b = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'typecheck other project',
          body: 'typecheck in workspace b',
        },
        'agent-b',
      )
      const preference = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'preference',
          title: 'always typecheck',
          body: 'the user always wants typecheck run',
          scope: 'global',
        },
        'agent-a',
      )

      const result = await runTool(host.tools, 'memory_search', { query: 'typecheck' }, 'agent-a')
      const ids = result.results.map((hit: { id: string }) => hit.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(preference.id)
      expect(ids).not.toContain(b.id)
    } finally {
      await host.dispose()
    }
  })

  it('honours explicit workspace and global scopes', async () => {
    const host = await openWorkspaceService()
    try {
      const local = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'typecheck local', body: 'typecheck local body' },
        'agent-a',
      )
      const global = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'preference',
          title: 'typecheck global',
          body: 'typecheck global body',
          scope: 'global',
        },
        'agent-a',
      )
      const workspaceOnly = await runTool(
        host.tools,
        'memory_search',
        { query: 'typecheck', scope: 'workspace' },
        'agent-a',
      )
      expect(workspaceOnly.results.map((hit: { id: string }) => hit.id)).toEqual([local.id])

      const globalOnly = await runTool(
        host.tools,
        'memory_search',
        { query: 'typecheck', scope: 'global' },
        'agent-a',
      )
      expect(globalOnly.results.map((hit: { id: string }) => hit.id)).toEqual([global.id])
    } finally {
      await host.dispose()
    }
  })

  it('lists visible active memories when query is omitted or whitespace without touching matchCount', async () => {
    const host = await openWorkspaceService()
    try {
      const low = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'low importance', body: 'low body', importance: 0.2 },
        'agent-a',
      )
      const high = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'high importance', body: 'high body', importance: 0.9 },
        'agent-a',
      )
      const pinned = await runTool(
        host.tools,
        'memory_write',
        { type: 'wiki', title: 'pinned wiki', body: 'pinned body', importance: 0.1 },
        'agent-a',
      )
      await host.service.update({
        id: pinned.id,
        expectedContentRevision: 1,
        pinned: true,
      })
      const pref = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'preference',
          title: 'global pref',
          body: 'global body',
          scope: 'global',
          importance: 0.5,
        },
        'agent-a',
      )
      const otherWs = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'other ws', body: 'other body', importance: 1 },
        'agent-b',
      )

      const omitted = await runTool(host.tools, 'memory_search', {}, 'agent-a')
      const blank = await runTool(host.tools, 'memory_search', { query: '   ' }, 'agent-a')
      expect(blank).toEqual(omitted)
      expect(omitted.total).toBe(4)
      expect(omitted.truncated).toBe(false)
      expect(omitted.results.map((hit: { id: string }) => hit.id)).toEqual([
        pinned.id,
        high.id,
        pref.id,
        low.id,
      ])
      expect(omitted.results.map((hit: { id: string }) => hit.id)).not.toContain(otherWs.id)

      const workspaceOnly = await runTool(
        host.tools,
        'memory_search',
        { scope: 'workspace' },
        'agent-a',
      )
      expect(workspaceOnly.results.map((hit: { id: string }) => hit.id)).toEqual([
        pinned.id,
        high.id,
        low.id,
      ])

      const globalOnly = await runTool(host.tools, 'memory_search', { scope: 'global' }, 'agent-a')
      expect(globalOnly.results.map((hit: { id: string }) => hit.id)).toEqual([pref.id])

      const filteredType = await runTool(
        host.tools,
        'memory_search',
        { type: 'lesson', limit: 1 },
        'agent-a',
      )
      expect(filteredType.results.map((hit: { id: string }) => hit.id)).toEqual([high.id])
      expect(filteredType.total).toBe(2)
      expect(filteredType.truncated).toBe(true)

      await host.service.flush()
      for (const id of [pinned.id, high.id, pref.id, low.id]) {
        const stored = host.service.read(id, 'c:/ws/a')
        expect(stored.matchCount).toBe(0)
        expect(stored.useCount).toBe(0)
      }
    } finally {
      await host.dispose()
    }
  })

  it('orders ties by updatedAt descending and excludes archived/pending/expired memories in listing mode', async () => {
    const host = await openWorkspaceService()
    try {
      const older = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'older lesson', body: 'older body', importance: 0.7 },
        'agent-a',
      )
      await new Promise((resolve) => setTimeout(resolve, 15))
      const newer = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'newer lesson', body: 'newer body', importance: 0.7 },
        'agent-a',
      )
      const archived = await runTool(
        host.tools,
        'memory_write',
        { type: 'lesson', title: 'archived lesson', body: 'archived body', importance: 1 },
        'agent-a',
      )
      await runTool(host.tools, 'memory_forget', { id: archived.id }, 'agent-a')

      const store = (
        host.service as unknown as {
          store: {
            create: (input: Record<string, unknown>) => Promise<{ id: string }>
          }
        }
      ).store
      const expired = await store.create({
        type: 'lesson',
        title: 'expired lesson',
        body: 'expired body',
        scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
        origin: 'model',
        ownership: 'user',
        status: 'active',
        importance: 1,
        expiresAt: '2020-01-01T00:00:00.000Z',
        actor: 'model',
      })
      const pending = await store.create({
        type: 'lesson',
        title: 'pending lesson',
        body: 'pending body',
        scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
        origin: 'dream',
        ownership: 'derived',
        status: 'pending',
        importance: 1,
        sourceEpisodeIds: ['ep-1'],
        actor: 'dream',
      })

      const listed = await runTool(host.tools, 'memory_search', {}, 'agent-a')
      const ids = listed.results.map((hit: { id: string }) => hit.id)
      expect(ids).toEqual([newer.id, older.id])
      expect(ids).not.toContain(archived.id)
      expect(ids).not.toContain(expired.id)
      expect(ids).not.toContain(pending.id)
    } finally {
      await host.dispose()
    }
  })

  it('documents optional query listing and marks memory_search concurrency-safe', async () => {
    const host = await openWorkspaceService()
    try {
      const tool = getTool(host.tools, 'memory_search')
      const params = tool.parameters as { required?: string[] }
      expect(params.required ?? []).not.toContain('query')
      expect(tool.description.toLowerCase()).toContain('omit query')
      expect(tool.isConcurrencySafe?.({})).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('increments matchCount but not useCount on a search hit', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'typecheck stats',
          body: 'run typecheck to measure stats',
        },
        'agent-a',
      )
      await runTool(host.tools, 'memory_search', { query: 'typecheck' }, 'agent-a')
      await host.service.flush()
      const stored = host.service.read(created.id, 'c:/ws/a')
      expect(stored.matchCount).toBe(1)
      expect(stored.useCount).toBe(0)
    } finally {
      await host.dispose()
    }
  })

  it('uses the configured searchLimit as the default page size', async () => {
    const host = await openService({
      workingDirectory: () => 'C:/ws/a',
      config: { searchLimit: 1 },
    })
    try {
      await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'limit one',
        body: 'limit body one',
      })
      await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'limit two',
        body: 'limit body two',
      })
      const result = await runTool(host.tools, 'memory_search', { query: 'limit' })
      expect(result.results).toHaveLength(1)
      expect(result.total).toBe(2)
      expect(result.truncated).toBe(true)
    } finally {
      await host.dispose()
    }
  })
})
