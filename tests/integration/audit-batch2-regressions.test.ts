import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { registerMemoryCommands } from '../../src/host/command.ts'
import { escapeInjection, renderBaseline } from '../../src/host/indexing.ts'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { applyMemoryUsage, memoryUsageDefinition } from '../../src/host/projection.ts'
import { MemoryId } from '../../src/shared/types.ts'
import { makeFakeAgent } from '../helpers/agent.ts'
import { openService } from '../helpers/service.ts'

const WS = { key: 'c:/ws/a', root: 'C:/ws/a' }

function human(text = 'hello'): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

describe('Batch 2 audit regressions', () => {
  it('[H7] enqueueDream rejects maxEpisodes < 1 and invalid since, and normalizes timezone offsets', async () => {
    const host = await openService()
    try {
      await expect(
        host.service.enqueueDream({ scope: 'workspace', workspace: WS, maxEpisodes: 0 }),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_QUERY' })
      await expect(
        host.service.enqueueDream({ scope: 'workspace', workspace: WS, maxEpisodes: -5 }),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_QUERY' })
      await expect(
        host.service.enqueueDream({ scope: 'workspace', workspace: WS, since: 'not-a-date' }),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_QUERY' })

      const run = await host.service.enqueueDream({
        scope: 'workspace',
        workspace: WS,
        maxEpisodes: 5,
        since: '2026-11-20T08:00:00+08:00',
      })
      expect(run.id).toBeTruthy()
    } finally {
      await host.dispose()
    }
  })

  it('[M5] disposed service immediately rejects store/domain access with MEMORY_STOPPED', async () => {
    const host = await openService()
    await host.dispose()
    expect(() => host.service.view({ id: 'any' })).toThrow(/stopping|MEMORY_STOPPED/i)
    await expect(
      host.service.enqueueDream({ scope: 'global', workspace: null }),
    ).rejects.toMatchObject({
      code: 'MEMORY_STOPPED',
    })
  })

  it('[M6] write() rejects archived/pending records and preserves callId idempotency over title dedupe', async () => {
    const host = await openService()
    try {
      const created = await host.service.create({
        type: 'lesson',
        scope: 'workspace',
        workspaceKey: WS.key,
        workspaceRoot: WS.root,
        title: 'Archived item',
        body: 'old body',
      })
      await host.service.delete({ id: created.id })
      const archived = host.service.view({ id: created.id }).record
      await expect(
        host.service.write(
          {
            id: archived.id,
            expectedContentRevision: archived.contentRevision,
            type: 'lesson',
            title: 'Archived item',
            body: 'updated body',
          },
          WS,
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })

      const first = await host.service.write(
        { type: 'lesson', title: 'Unique Title', body: 'first body' },
        WS,
        'call-1',
      )
      expect(first.duplicate).toBeUndefined()

      // Retrying with the same callId replays the original create without marking duplicate=true.
      const replayed = await host.service.write(
        { type: 'lesson', title: 'Unique Title', body: 'first body' },
        WS,
        'call-1',
      )
      expect(replayed.record.id).toBe(first.record.id)
      expect(replayed.duplicate).toBeUndefined()

      // A new callId with the same title still deduplicates.
      const dup = await host.service.write(
        { type: 'lesson', title: 'Unique Title', body: 'second body' },
        WS,
        'call-2',
      )
      expect(dup.record.id).toBe(first.record.id)
      expect(dup.duplicate).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('[M7] mid-turn compaction (step > 1) re-injects memory index even when refreshIndexOnChange=false', async () => {
    const host = await openService()
    try {
      await host.service.write(
        { type: 'preference', title: 'Prefer pnpm', body: 'Always use pnpm.', scope: 'global' },
        null,
      )
      const injector = new MemoryIndexInjector({
        ctx: host.ctx,
        service: host.service,
        config: { refreshIndexOnChange: false },
      })
      const fake = makeFakeAgent()

      const step1 = await injector.handlePreStep(
        { agent: fake.agent, messages: [human('start')], step: 1 },
        async () => ({ kind: 'enter', messages: [human('start')] }),
      )
      if (step1.kind !== 'enter') throw new Error('expected enter')
      expect(step1.messages).toHaveLength(2)

      // Simulate compaction wiping the surface completely before step 2.
      fake.session.messages.length = 0
      const step2 = await injector.handlePreStep(
        { agent: fake.agent, messages: [human('continue after compact')], step: 2 },
        async () => ({ kind: 'enter', messages: [human('continue after compact')] }),
      )
      if (step2.kind !== 'enter') throw new Error('expected enter')
      expect(step2.messages).toHaveLength(2)
      const injected = step2.messages[1]!
      expect(injected.source.kind).toBe('memloom')
      if (injected.source.kind === 'memloom') {
        expect(injected.source.mode).toBe('reset')
      }
    } finally {
      await host.dispose()
    }
  })

  it('[M8] memoryUsage projection deduplicates totalInjected across turns and clears writeCalls on error', () => {
    let state = memoryUsageDefinition.init()
    const injectEvent = (turn: number): SessionEvent =>
      ({
        seq: turn * 2,
        type: 'user/message',
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'idx' }],
          source: {
            kind: 'memloom',
            form: 'memory-index',
            mode: turn === 1 ? 'baseline' : 'reset',
            protocolVersion: 1,
            baselineId: 'b1',
            scopeKey: 'global',
            changes: [{ action: 'add', memoryId: 'mem-1', contentRevision: 1, digest: 'd1' }],
            invalidations: [],
          },
        },
      }) as unknown as SessionEvent

    state = applyMemoryUsage(state, {
      seq: 1,
      type: 'turn/start',
      data: { turn: 1 },
    } as SessionEvent)
    state = applyMemoryUsage(state, injectEvent(1))
    state = applyMemoryUsage(state, {
      seq: 3,
      type: 'turn/start',
      data: { turn: 2 },
    } as SessionEvent)
    state = applyMemoryUsage(state, injectEvent(2))
    expect(state.totalInjected).toBe(1)

    // Tool call followed by errored tool/result must clear writeCalls.
    state = applyMemoryUsage(state, {
      seq: 5,
      type: 'tool/call',
      data: { name: 'memory_write', callId: 'c-err', turn: 2, arguments: '{}' },
    } as unknown as SessionEvent)
    expect(state.writeCalls['c-err']).toBe(2)

    state = applyMemoryUsage(state, {
      seq: 6,
      type: 'tool/result',
      data: {
        error: { code: 'FAILED', reason: 'boom' },
        message: { role: 'tool', isError: true, content: [], source: { callId: 'c-err' } },
      },
    } as unknown as SessionEvent)
    expect(state.writeCalls['c-err']).toBeUndefined()
    expect(state.totalWritten).toBe(0)
  })

  it('[L5] /memory status and /memory search catch service errors and return kind=error', async () => {
    let handler:
      | ((inv: {
          rawInput: string
          agent: unknown
          commandId?: string
        }) => Promise<{ kind: string; text: string }>)
      | undefined
    const ctx = {
      commands: {
        register: (def: { handler: typeof handler }) => {
          handler = def.handler
          return () => {}
        },
      },
      workingDirectory: { ensure: async () => '' },
    } as unknown as Context
    const throwingService = {
      status: () => {
        throw new Error('service unavailable')
      },
      search: () => {
        throw new Error('search failed')
      },
    } as unknown as Parameters<typeof registerMemoryCommands>[1]

    registerMemoryCommands(ctx, throwingService)
    const statusRes = await handler!({ rawInput: 'status', agent: undefined })
    expect(statusRes.kind).toBe('error')
    expect(statusRes.text).toContain('service unavailable')

    const searchRes = await handler!({ rawInput: 'search test', agent: undefined })
    expect(searchRes.kind).toBe('error')
    expect(searchRes.text).toContain('search failed')
  })

  it('[L6] escapeInjection neutralizes whitespace variants of </system-reminder> and collapses multiline titles', () => {
    expect(escapeInjection('a </system-reminder   > b')).not.toMatch(/<\/system-reminder\s*>/i)
    const rendered = renderBaseline({
      baselineId: 'b1',
      scopeKey: 'global',
      entries: [
        {
          memoryId: MemoryId('m1'),
          type: 'preference',
          title: 'Line one\nLine two',
          summary: 'Summary',
          contentRevision: 1,
          digest: 'd1',
          priority: 100,
        },
      ],
    })
    expect(rendered).toContain('Line one Line two')
    expect(rendered).not.toContain('Line one\nLine two')
  })
})
