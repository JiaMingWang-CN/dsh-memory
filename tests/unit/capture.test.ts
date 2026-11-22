import { describe, expect, it } from 'vitest'
import { MemoryCapture } from '../../src/host/capture.ts'
import { createTurnWorklog } from '../../src/host/worklog.ts'
import { openStore } from '../helpers/runner.ts'
import {
  assistantMessage,
  captureSession,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
  userMessage,
} from '../helpers/capture-events.ts'

async function setup(config: Record<string, unknown> = {}) {
  const opened = await openStore()
  const capture = new MemoryCapture({ store: opened.store, config })
  return { ...opened, capture }
}

describe('capture user message', () => {
  it('truncates a direct user message to 4KB and stores a turn episode', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'x'.repeat(5000)))
    capture.onSessionEvent(session, turnEnd(3))
    await capture.flush()

    const episodes = store.episodeList()
    const turn = episodes.find((item) => item.kind === 'turn')
    expect(turn).toBeDefined()
    expect(Buffer.byteLength(turn?.prompt ?? '', 'utf8')).toBe(4096)
  })
})

describe('capture tool failure', () => {
  it('stores a tool-failure episode with the tool name and error code', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(
      session,
      toolCall(2, { callId: 'c1', name: 'bash', arguments: '{"command":"boom"}' }),
    )
    capture.onSessionEvent(
      session,
      toolResult(3, { callId: 'c1', error: { name: 'bash', code: 'E_BOOM' }, isError: true }),
    )
    await capture.flush()

    const failure = store.episodeList().find((item) => item.kind === 'tool-failure')
    expect(failure?.toolName).toBe('bash')
    expect(failure?.toolError).toContain('E_BOOM')
  })
})

describe('capture recovery matched', () => {
  it('creates a tool-recovery episode when the same tool and target succeed after a failure', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(
      session,
      toolCall(2, { callId: 'c1', name: 'write', arguments: '{"file_path":"C:/a.ts"}' }),
    )
    capture.onSessionEvent(
      session,
      toolResult(3, { callId: 'c1', error: { name: 'write', code: 'E_IO' }, isError: true }),
    )
    capture.onSessionEvent(
      session,
      toolCall(4, { callId: 'c2', name: 'write', arguments: '{"file_path":"C:/a.ts"}' }),
    )
    capture.onSessionEvent(session, toolResult(5, { callId: 'c2' }))
    await capture.flush()

    expect(store.episodeList().some((item) => item.kind === 'tool-recovery')).toBe(true)
  })
})

describe('capture recovery unmatched', () => {
  it('does not infer recovery when a different target succeeds', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(
      session,
      toolCall(2, { callId: 'c1', name: 'write', arguments: '{"file_path":"C:/a.ts"}' }),
    )
    capture.onSessionEvent(
      session,
      toolResult(3, { callId: 'c1', error: { name: 'write', code: 'E_IO' }, isError: true }),
    )
    capture.onSessionEvent(
      session,
      toolCall(4, { callId: 'c2', name: 'write', arguments: '{"file_path":"C:/b.ts"}' }),
    )
    capture.onSessionEvent(session, toolResult(5, { callId: 'c2' }))
    await capture.flush()

    expect(store.episodeList().some((item) => item.kind === 'tool-recovery')).toBe(false)
  })
})

describe('capture correction candidate', () => {
  it('creates a user-correction candidate but never a lesson', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'do the thing'))
    capture.onSessionEvent(session, assistantMessage(3, 'I did the thing'))
    capture.onSessionEvent(session, turnEnd(4))
    capture.onSessionEvent(session, turnStart(5, 2))
    capture.onSessionEvent(session, userMessage(6, '不是这个意思'))
    await capture.flush()

    const correction = store.episodeList().find((item) => item.kind === 'user-correction')
    expect(correction?.correctionText).toBe('不是这个意思')
    expect(store.counts().stored).toBe(0)
  })
})

describe('capture disabled', () => {
  it('produces no episodes when autoCaptureEpisodes is false', async () => {
    const { store, capture } = await setup({ autoCaptureEpisodes: false })
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'remember this'))
    capture.onSessionEvent(
      session,
      toolCall(3, { callId: 'c1', name: 'bash', arguments: '{"command":"x"}' }),
    )
    capture.onSessionEvent(
      session,
      toolResult(4, { callId: 'c1', error: { name: 'bash', code: 'E' }, isError: true }),
    )
    capture.onSessionEvent(session, turnEnd(5))
    await capture.flush()

    expect(store.episodeList().length).toBe(0)
  })
})

describe('capture target redaction', () => {
  it('redacts secrets in whitelisted file paths before storing episode files', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(
      session,
      toolCall(2, {
        callId: 'c1',
        name: 'write',
        arguments: '{"file_path":"C:/tmp/password=hunter2.ts"}',
      }),
    )
    capture.onSessionEvent(session, toolResult(3, { callId: 'c1' }))
    capture.onSessionEvent(session, turnEnd(4))
    await capture.flush()

    const turn = store.episodeList().find((item) => item.kind === 'turn')
    expect(turn?.files).toEqual(['C:/tmp/[REDACTED]'])
    expect(JSON.stringify(store.episodeList())).not.toContain('hunter2')
  })
})

describe('capture enqueue turn snapshot', () => {
  it('keeps the correction turn and previous assistant text captured at enqueue time', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'do the thing'))
    capture.onSessionEvent(session, assistantMessage(3, 'first answer'))
    capture.onSessionEvent(session, turnEnd(4))
    capture.onSessionEvent(session, turnStart(5, 2))
    capture.onSessionEvent(session, userMessage(6, '不是这个意思'))
    capture.onSessionEvent(session, turnEnd(7))
    capture.onSessionEvent(session, turnStart(8, 3))
    capture.onSessionEvent(session, userMessage(9, 'next task'))
    capture.onSessionEvent(session, assistantMessage(10, 'third answer'))
    capture.onSessionEvent(session, turnEnd(11))
    await capture.flush()

    const correction = store.episodeList().find((item) => item.kind === 'user-correction')
    expect(correction?.turn).toBe(2)
    expect(correction?.assistantFinal).toBe('first answer')
  })

  it('keeps the tool-failure and tool-recovery turn captured at enqueue time', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(
      session,
      toolCall(2, { callId: 'c1', name: 'write', arguments: '{"file_path":"C:/a.ts"}' }),
    )
    capture.onSessionEvent(
      session,
      toolResult(3, { callId: 'c1', error: { name: 'write', code: 'E_IO' }, isError: true }),
    )
    capture.onSessionEvent(
      session,
      toolCall(4, { callId: 'c2', name: 'write', arguments: '{"file_path":"C:/a.ts"}' }),
    )
    capture.onSessionEvent(session, toolResult(5, { callId: 'c2' }))
    capture.onSessionEvent(session, turnEnd(6))
    await capture.flush()

    const failure = store.episodeList().find((item) => item.kind === 'tool-failure')
    const recovery = store.episodeList().find((item) => item.kind === 'tool-recovery')
    expect(failure?.turn).toBe(1)
    expect(recovery?.turn).toBe(1)
    expect(recovery?.sourceSeqs).toEqual([3, 5])
  })
})

describe('capture spoken remember', () => {
  it('stores a spoken remember request as an active lesson', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '记住：部署前先跑 pnpm typecheck'))
    capture.onSessionEvent(session, turnEnd(3))
    await capture.flush()

    const records = store.activeRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.type).toBe('lesson')
    expect(records[0]?.title).toContain('部署前先跑')
    expect(records[0]?.origin).toBe('system')
    expect(records[0]?.ownership).toBe('user')
    expect(records[0]?.sourceRefs[0]?.sessionId).toBe('s1')
  })

  it('stores a stable preference as a preference', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '以后都用中文回复'))
    capture.onSessionEvent(session, turnEnd(3))
    await capture.flush()

    expect(store.activeRecords()[0]?.type).toBe('preference')
  })

  it('does not duplicate a remember the model already wrote explicitly', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '记住：部署前先跑 pnpm typecheck'))
    capture.onToolResult(
      { name: 'memory_write', agent: { id: 's1' } } as never,
      { isError: false } as never,
    )
    capture.onSessionEvent(session, turnEnd(3))
    await capture.flush()

    expect(store.activeRecords()).toHaveLength(0)
  })

  it('reuses an existing active memory with the same title', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    for (const turn of [1, 2]) {
      capture.onSessionEvent(session, turnStart(turn * 2 - 1, turn))
      capture.onSessionEvent(session, userMessage(turn * 2, '记住：部署前先跑 pnpm typecheck'))
      capture.onSessionEvent(session, turnEnd(turn * 2 + 1))
    }
    await capture.flush()

    expect(store.activeRecords()).toHaveLength(1)
  })

  it('ignores a negated remember request', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '不要记住这一条'))
    capture.onSessionEvent(session, turnEnd(3))
    await capture.flush()

    expect(store.activeRecords()).toHaveLength(0)
  })
})

describe('capture failure facts', () => {
  it('stores the structured failure code and redacted message of an error turn', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'do it'))
    capture.onSessionEvent(
      session,
      turnEnd(3, 'error', 1, { code: 'MODEL_UNAVAILABLE', message: 'no route for model m' }),
    )
    await capture.flush()

    const turn = store.episodeList().find((item) => item.kind === 'turn')
    expect(turn?.outcome).toBe('error')
    expect(turn?.failureCode).toBe('MODEL_UNAVAILABLE')
    expect(turn?.failureMessage).toBe('no route for model m')
  })
})

describe('capture subagent boundary', () => {
  async function withWorklog(delegationDepth: number) {
    const opened = await openStore()
    const capture = new MemoryCapture({
      store: opened.store,
      config: {},
      onTurnEnd: async (input, record) => {
        await createTurnWorklog(opened.store, {}, input, record)
      },
    })
    const session = captureSession('s1', 'C:/ws/a', delegationDepth)
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'deliver the subtask'))
    capture.onSessionEvent(
      session,
      toolCall(3, { callId: 'c1', name: 'write', arguments: '{"file_path":"C:/ws/a/out.ts"}' }),
    )
    capture.onSessionEvent(session, toolResult(4, { callId: 'c1' }))
    capture.onSessionEvent(session, turnEnd(5))
    await capture.flush()
    return opened.store
  }

  it('writes a turn worklog for a main-session turn with file output', async () => {
    const store = await withWorklog(0)
    expect(store.activeRecords().filter((record) => record.type === 'worklog')).toHaveLength(1)
  })

  it('keeps the episode but skips the worklog for a subagent turn', async () => {
    const store = await withWorklog(1)
    expect(store.episodeList().some((item) => item.kind === 'turn')).toBe(true)
    expect(store.activeRecords().filter((record) => record.type === 'worklog')).toHaveLength(0)
  })
})
