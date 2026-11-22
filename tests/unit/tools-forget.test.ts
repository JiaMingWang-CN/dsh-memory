import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import { getTool, runTool, toolExec } from '../helpers/tool.ts'

const directories: Record<string, string> = {
  'agent-a': 'C:/ws/a',
  'agent-b': 'C:/ws/b',
}

function openWorkspaceService() {
  return openService({
    workingDirectory: (agent) => directories[(agent as { id: string }).id] ?? 'C:/ws/a',
  })
}

describe('memory_forget tool', () => {
  it('soft-forgets by archiving: gone from search but still readable', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'forget target',
          body: 'run typecheck to forget',
        },
        'agent-a',
      )
      await runTool(
        host.tools,
        'memory_forget',
        { id: created.id, reason: 'no longer needed' },
        'agent-a',
      )

      const search = await runTool(host.tools, 'memory_search', { query: 'typecheck' }, 'agent-a')
      expect(search.results.map((hit: { id: string }) => hit.id)).not.toContain(created.id)

      const stored = host.service.read(created.id, 'c:/ws/a')
      expect(stored.status).toBe('archived')
      expect(stored.contentRevision).toBeGreaterThan(1)

      const store = (
        host.service as unknown as {
          store: {
            auditList: (request: unknown) => { items: { action: string; reason?: string }[] }
          }
        }
      ).store
      const audit = store.auditList({ memoryId: created.id, limit: 10 })
      expect(audit.items.find((item) => item.action === 'archive')?.reason).toBe('no longer needed')
    } finally {
      await host.dispose()
    }
  })

  it('rejects forged permanent/confirm arguments and keeps the record', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(
        host.tools,
        'memory_write',
        {
          type: 'lesson',
          title: 'keep me',
          body: 'do not delete permanently',
        },
        'agent-a',
      )
      const parameters = getTool(host.tools, 'memory_forget').parameters as {
        properties: Record<string, unknown>
      }
      expect(parameters.properties).not.toHaveProperty('permanent')
      expect(parameters.properties).not.toHaveProperty('confirm')

      await expect(
        getTool(host.tools, 'memory_forget').execute(
          { id: created.id, permanent: true, confirm: true },
          toolExec('memory_forget', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN' })
      const stored = host.service.read(created.id, 'c:/ws/a')
      expect(stored.status).toBe('active')
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
          title: 'other workspace',
          body: 'workspace b body',
        },
        'agent-b',
      )
      await expect(
        getTool(host.tools, 'memory_forget').execute(
          { id: created.id },
          toolExec('memory_forget', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
    } finally {
      await host.dispose()
    }
  })
})
