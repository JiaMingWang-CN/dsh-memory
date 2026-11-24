import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import { getTool, runTool, toolExec } from '../helpers/tool.ts'

const workspaceA = { key: 'c:/ws/a', root: 'C:/ws/a' }

function openWorkspaceService() {
  return openService({ workingDirectory: () => 'C:/ws/a' })
}

describe('memory_write tool', () => {
  it('creates an active model-owned user memory', async () => {
    const host = await openWorkspaceService()
    try {
      const result = await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'typecheck lesson',
        body: 'run typecheck before building',
      })
      expect(typeof result.id).toBe('string')
      expect(result.status).toBe('active')
      const stored = host.service.read(result.id, 'c:/ws/a')
      expect(stored.origin).toBe('model')
      expect(stored.ownership).toBe('user')
      expect(stored.status).toBe('active')
      expect(stored.contentRevision).toBe(1)
    } finally {
      await host.dispose()
    }
  })

  it('allows a global preference', async () => {
    const host = await openWorkspaceService()
    try {
      const result = await runTool(host.tools, 'memory_write', {
        type: 'preference',
        title: 'reply in Chinese',
        body: 'the user prefers Chinese replies',
        scope: 'global',
      })
      expect(result.status).toBe('active')
      const stored = host.service.read(result.id, 'c:/ws/a')
      expect(stored.scope).toEqual({ kind: 'global' })
    } finally {
      await host.dispose()
    }
  })

  it('rejects a global non-preference with MEMORY_FORBIDDEN_SCOPE', async () => {
    const host = await openWorkspaceService()
    try {
      await expect(
        getTool(host.tools, 'memory_write').execute(
          { type: 'lesson', title: 'global lesson', body: 'nope', scope: 'global' },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN_SCOPE' })
    } finally {
      await host.dispose()
    }
  })

  it('redacts secrets in body, tags and source reference quotes', async () => {
    const host = await openWorkspaceService()
    try {
      const { record, redactions } = await host.service.write(
        {
          type: 'lesson',
          title: 'safe title',
          body: 'see password=hunter2 for details',
          tags: ['password=hunter2'],
          sourceRefs: [{ sessionId: 's1', quote: 'password=correcthorse' }],
        },
        workspaceA,
      )
      expect(redactions).toBe(3)
      const stored = host.service.read(record.id, 'c:/ws/a')
      expect(stored.body).toContain('[REDACTED]')
      expect(stored.body).not.toContain('hunter2')
      expect(stored.tags).toEqual(['[REDACTED]'])
      expect(stored.sourceRefs[0]?.quote).toBe('[REDACTED]')
    } finally {
      await host.dispose()
    }
  })

  it('rejects a strong secret with MEMORY_INVALID_CONTENT', async () => {
    const host = await openWorkspaceService()
    try {
      await expect(
        getTool(host.tools, 'memory_write').execute(
          {
            type: 'lesson',
            title: 'secret note',
            body: 'see sk-live-ABCDEFGHIJKLMNOP1234 for details',
          },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
      expect(host.service.status().counts.stored).toBe(0)
    } finally {
      await host.dispose()
    }
  })

  it('rejects widening an existing memory scope through the model tool', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await host.service.write(
        { type: 'preference', title: 'local preference', body: 'only for this project' },
        workspaceA,
      )
      await expect(
        getTool(host.tools, 'memory_write').execute(
          {
            id: created.record.id,
            type: 'preference',
            title: 'local preference',
            body: 'only for this project',
            scope: 'global',
            expectedContentRevision: 1,
          },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN_SCOPE' })
      expect(host.service.read(created.record.id, 'c:/ws/a').scope).toEqual({
        kind: 'workspace',
        key: 'c:/ws/a',
        root: 'C:/ws/a',
      })
    } finally {
      await host.dispose()
    }
  })

  it('rejects an update with a stale expectedContentRevision', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'original title',
        body: 'original body',
      })
      await expect(
        getTool(host.tools, 'memory_write').execute(
          {
            id: created.id,
            type: 'lesson',
            title: 'changed',
            body: 'changed body',
            expectedContentRevision: 99,
          },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
      expect(host.service.read(created.id, 'c:/ws/a').title).toBe('original title')
    } finally {
      await host.dispose()
    }
  })

  it('updates type and source references while preserving createdAt', async () => {
    const host = await openWorkspaceService()
    try {
      const created = await host.service.write(
        { type: 'lesson', title: 'before', body: 'before body' },
        workspaceA,
      )
      const updated = await host.service.write(
        {
          id: created.record.id,
          type: 'wiki',
          title: 'after',
          body: 'after body',
          expectedContentRevision: 1,
          sourceRefs: [{ sessionId: 's1', quote: 'updated quote' }],
        },
        workspaceA,
      )
      expect(updated.record.type).toBe('wiki')
      expect(updated.record.sourceRefs[0]?.quote).toBe('updated quote')
      expect(updated.record.createdAt).toBe(created.record.createdAt)
      expect(updated.record.ownership).toBe('user')
      expect(updated.record.reviewedByUserAt).toBeUndefined()
    } finally {
      await host.dispose()
    }
  })

  it('rejects an out-of-range importance with MEMORY_INVALID_CONTENT', async () => {
    const host = await openWorkspaceService()
    try {
      await expect(
        getTool(host.tools, 'memory_write').execute(
          { type: 'lesson', title: 'bad importance', body: 'body', importance: 3 },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
    } finally {
      await host.dispose()
    }
  })

  it('rejects title and body outside the configured bounds', async () => {
    const host = await openWorkspaceService()
    try {
      await expect(
        getTool(host.tools, 'memory_write').execute(
          { type: 'lesson', title: 'x'.repeat(201), body: 'body' },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
      await expect(
        getTool(host.tools, 'memory_write').execute(
          { type: 'lesson', title: 'title', body: 'x'.repeat(65_537) },
          toolExec('memory_write', 'agent-a'),
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
    } finally {
      await host.dispose()
    }
  })

  it('honours redactSecrets=false for an explicitly configured deployment', async () => {
    const host = await openService({
      workingDirectory: () => 'C:/ws/a',
      config: { redactSecrets: false },
    })
    try {
      const result = await host.service.write(
        { type: 'lesson', title: 'no redaction', body: 'password=hunter2' },
        workspaceA,
      )
      expect(result.redactions).toBe(0)
      expect(host.service.read(result.record.id, 'c:/ws/a').body).toBe('password=hunter2')
    } finally {
      await host.dispose()
    }
  })

  it('treats an identical scope, type and normalized title as the same memory', async () => {
    const host = await openWorkspaceService()
    try {
      const first = await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'Same  Title',
        body: 'first body',
      })
      const second = await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: 'Same Title',
        body: 'second body',
      })
      expect(second.id).toBe(first.id)
      expect(second.duplicate).toBe(true)
      expect(host.service.list({ workspaceKey: 'c:/ws/a' }).items).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })

  it('records the calling session as a source reference when creating', async () => {
    const host = await openWorkspaceService()
    try {
      const created = (await getTool(host.tools, 'memory_write').execute(
        { type: 'lesson', title: 'sourced lesson', body: 'body' },
        toolExec('memory_write', 'agent-a', 'session-1'),
      )) as { id: string }
      const stored = host.service.read(created.id, 'c:/ws/a')
      expect(stored.sourceRefs).toEqual([{ sessionId: 'session-1' }])
    } finally {
      await host.dispose()
    }
  })

  it('replays one tool call id instead of creating a second memory', async () => {
    const host = await openWorkspaceService()
    try {
      const exec = (callId: string) => toolExec('memory_write', 'agent-a', 'session-1', callId)
      const args = { type: 'lesson' as const, title: 'retry once', body: 'body' }
      const first = (await getTool(host.tools, 'memory_write').execute(
        args,
        exec('call-retry'),
      )) as { id: string }
      const second = (await getTool(host.tools, 'memory_write').execute(
        args,
        exec('call-retry'),
      )) as { id: string }
      expect(second.id).toBe(first.id)
      expect(host.service.list({ workspaceKey: 'c:/ws/a' }).items).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })

  it('keeps the existing source references when updating', async () => {
    const host = await openWorkspaceService()
    try {
      const created = (await getTool(host.tools, 'memory_write').execute(
        { type: 'lesson', title: 'sourced lesson', body: 'body' },
        toolExec('memory_write', 'agent-a', 'session-1'),
      )) as { id: string }
      await getTool(host.tools, 'memory_write').execute(
        {
          id: created.id,
          expectedContentRevision: 1,
          type: 'lesson',
          title: 'sourced lesson',
          body: 'updated body',
        },
        toolExec('memory_write', 'agent-a', 'session-2'),
      )
      const stored = host.service.read(created.id, 'c:/ws/a')
      expect(stored.sourceRefs).toEqual([{ sessionId: 'session-1' }])
    } finally {
      await host.dispose()
    }
  })

  it('forbids copying auto-loaded docs and enforces single-topic concise writes in description', async () => {
    const host = await openWorkspaceService()
    try {
      const { description } = getTool(host.tools, 'memory_write')
      expect(description).toContain('AGENTS.md')
      expect(description).toContain('CLAUDE.md')
      expect(description).toContain('README')
      expect(description).toContain('skills')
      expect(description).toContain('single independent topic')
      expect(description).toContain('broad request')
    } finally {
      await host.dispose()
    }
  })
})
