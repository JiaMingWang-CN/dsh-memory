/**
 * Index refresh enabled/disabled behavior (plan 06, Task 3).
 *
 * OFF: a memory change never adds a delta message during a session.
 * ON: the next accepted pre-step admits one delta carrying the new id, and a
 * simulated resume + compaction does not emit a duplicate baseline.
 */
import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryIndexInjector } from '../../src/host/inject.ts'
import { makeFakeAgent, type FakeAgent } from '../helpers/agent.ts'
import { openService } from '../helpers/service.ts'
import { runTool } from '../helpers/tool.ts'

function humanMessage(text: string): UserMessage {
  return {
    id: `u-${text.length}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

function enter(messages: UserMessage[]) {
  return { kind: 'enter' as const, messages }
}

/** Admit the first-step baseline and persist it onto the fake surface. */
async function primeBaseline(injector: MemoryIndexInjector, fake: FakeAgent): Promise<UserMessage> {
  const request = humanMessage('start')
  const first = await injector.handlePreStep(
    { agent: fake.agent, messages: [request], step: 1 },
    async () => enter([request]),
  )
  if (first.kind !== 'enter') throw new Error('expected enter')
  expect(first.messages).toHaveLength(2)
  const baseline = first.messages[1]!
  if (baseline.source.kind !== 'dsh-memory') throw new Error('expected dsh-memory baseline')
  fake.session.messages.push(baseline)
  return baseline
}

/** Write one high-priority workspace lesson that must appear in the index. */
async function writeLesson(tools: Parameters<typeof runTool>[0]): Promise<{ id: string }> {
  return runTool(tools, 'memory_write', {
    type: 'lesson',
    title: '刷新后可见的教训',
    body: '开启增量刷新后，这条教训应出现在增量消息里。',
    importance: 0.9,
  })
}

describe('index refresh off', () => {
  it('never appends a delta when a memory changes', async () => {
    const host = await openService({ config: { refreshIndexOnChange: false } })
    try {
      await runTool(host.tools, 'memory_write', {
        type: 'preference',
        title: '全局偏好',
        body: '先跑测试。',
        scope: 'global',
      })
      const injector = new MemoryIndexInjector({ ctx: host.ctx, service: host.service })
      const fake = makeFakeAgent()
      await primeBaseline(injector, fake)

      await writeLesson(host.tools)
      const request = humanMessage('next')
      const second = await injector.handlePreStep(
        { agent: fake.agent, messages: [request], step: 2 },
        async () => enter([request]),
      )
      if (second.kind !== 'enter') throw new Error('expected enter')
      expect(second.messages).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })
})

describe('index refresh on', () => {
  it('admits one delta on the next pre-step and does not repeat the baseline on resume', async () => {
    const host = await openService({
      config: { refreshIndexOnChange: true, refreshMinIntervalMs: 0 },
    })
    try {
      await runTool(host.tools, 'memory_write', {
        type: 'preference',
        title: '全局偏好',
        body: '先跑测试。',
        scope: 'global',
      })
      const injector = new MemoryIndexInjector({
        ctx: host.ctx,
        service: host.service,
        config: { refreshIndexOnChange: true, refreshMinIntervalMs: 0 },
      })
      const fake = makeFakeAgent()
      await primeBaseline(injector, fake)

      const lesson = await writeLesson(host.tools)
      const request = humanMessage('next')
      const second = await injector.handlePreStep(
        { agent: fake.agent, messages: [request], step: 2 },
        async () => enter([request]),
      )
      if (second.kind !== 'enter') throw new Error('expected enter')
      expect(second.messages).toHaveLength(2)
      const delta = second.messages[1]!
      if (delta.source.kind !== 'dsh-memory') throw new Error('expected dsh-memory delta')
      expect(delta.source.mode).toBe('delta')
      expect(delta.source.changes.map((change) => change.memoryId)).toContain(lesson.id)
      fake.session.messages.push(delta)

      // Resume: a brand-new injector folds the durable surface and must not
      // emit a second baseline.
      const resumed = new MemoryIndexInjector({
        ctx: host.ctx,
        service: host.service,
        config: { refreshIndexOnChange: true, refreshMinIntervalMs: 0 },
      })
      const resumeRequest = humanMessage('resume')
      const third = await resumed.handlePreStep(
        { agent: fake.agent, messages: [resumeRequest], step: 1 },
        async () => enter([resumeRequest]),
      )
      if (third.kind !== 'enter') throw new Error('expected enter')
      expect(third.messages).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })
})
