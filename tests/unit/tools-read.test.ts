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

describe('memory_read tool', () => {
  it('returns the full body of a visible memory', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'typecheck body',
          body: 'Run typecheck before building. Then deploy.',
        },
        'agent-a',
      )
      const result = await runTool(host.tools, 'memory_read', { id: created.id }, 'agent-a')
      expect(result.body).toBe('Run typecheck before building. Then deploy.')
      expect(result.title).toBe('typecheck body')
      expect(result.type).toBe('lesson')
    } finally {
      await host.dispose()
    }
  })

  it('returns MEMORY_NOT_FOUND for another workspace memory', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'workspace b secret',
          body: 'workspace b body',
        },
        'agent-b',
      )
      await expect(
        getTool(host.tools, 'memory_read').execute(
          { id: created.id },
          toolExec('memory_read', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
    } finally {
      await host.dispose()
    }
  })

  it('does not return an archived memory through the model tool', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'forgotten rule',
          body: 'must not be recalled by id after forget',
        },
        'agent-a',
      )
      await runTool(host.tools, 'memory_forget', { id: created.id }, 'agent-a')
      await expect(
        getTool(host.tools, 'memory_read').execute(
          { id: created.id },
          toolExec('memory_read', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
      // Management reads still see the archived record.
      expect(host.service.read(created.id, 'c:/ws/a').status).toBe('archived')
    } finally {
      await host.dispose()
    }
  })

  it('increments useCount on read', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'read stats',
          body: 'body for read stats',
        },
        'agent-a',
      )
      await runTool(host.tools, 'memory_read', { id: created.id }, 'agent-a')
      await host.service.flush()
      const stored = host.service.read(created.id, 'c:/ws/a')
      expect(stored.useCount).toBe(1)
      expect(stored.matchCount).toBe(0)
    } finally {
      await host.dispose()
    }
  })
})
