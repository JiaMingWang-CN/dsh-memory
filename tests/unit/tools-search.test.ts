import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import { runTool, toolExec, getTool } from '../helpers/tool.ts'

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

  it('rejects an empty query with MEMORY_INVALID_QUERY', async () => {
    const host = await openWorkspaceService()
    try {
      await expect(
        getTool(host.tools, 'memory_search').execute(
          { query: '   ' },
          toolExec('memory_search', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_QUERY' })
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
