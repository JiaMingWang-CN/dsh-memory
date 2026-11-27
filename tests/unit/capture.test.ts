import { describe, expect, it, vi } from 'vitest'
import { MemoryCapture } from '../../src/host/capture.ts'
import { createTurnWorklog } from '../../src/host/worklog.ts'
import { openStore } from '../helpers/runner.ts'
import {
  assistantMessage,
  captureSession,
  ptcDispatch,
  ptcDispatchStart,
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

describe('capture plugin noise filtering and PTC compatibility', () => {
  it('ignores tool-failure and tool-recovery episodes for all memory_* tools', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    const memoryTools = [
      'memory_search',
      'memory_read',
      'memory_write',
      'memory_forget',
      'memory_dream',
      'memory_organize',
    ]
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'run memory maintenance'))
    let seq = 3
    for (const toolName of memoryTools) {
      const failId = `fail-${toolName}`
      const okId = `ok-${toolName}`
      capture.onSessionEvent(
        session,
        toolCall(seq++, { callId: failId, name: toolName, arguments: '{}' }),
      )
      capture.onSessionEvent(
        session,
        toolResult(seq++, {
          callId: failId,
          isError: true,
          error: { name: toolName, code: 'MEMORY_INVALID_QUERY', reason: 'bad args' },
        }),
      )
      capture.onSessionEvent(
        session,
        toolCall(seq++, { callId: okId, name: toolName, arguments: '{}' }),
      )
      capture.onSessionEvent(session, toolResult(seq++, { callId: okId }))
    }
    capture.onSessionEvent(session, assistantMessage(seq++, 'checked memory'))
    capture.onSessionEvent(session, turnEnd(seq++))
    await capture.flush()

    expect(store.episodeList()).toHaveLength(0)
  })

  it('ignores run_code script errors and memory_* failures inside PTC without creating turn noise', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '执行记忆操作'))
    capture.onSessionEvent(
      session,
      toolCall(3, {
        callId: 'ptc-1',
        name: 'run_code',
        arguments: '{"code":"for (const r of res.results) {}"}',
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatchStart(4, {
        rootCallId: 'ptc-1',
        parentCallId: 'ptc-1',
        subCallId: 'ptc-1:ptc:1',
        name: 'memory_search',
        arguments: { query: 'anything' },
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(5, {
        rootCallId: 'ptc-1',
        parentCallId: 'ptc-1',
        subCallId: 'ptc-1:ptc:1',
        name: 'memory_search',
        arguments: { query: 'anything' },
        isError: true,
        error: { name: 'memory_search', code: 'E_SEARCH', reason: 'failed' },
      }),
    )
    capture.onSessionEvent(
      session,
      toolResult(6, {
        callId: 'ptc-1',
        isError: true,
        error: {
          name: 'run_code',
          code: 'PTC_RUNTIME_ERROR',
          reason: 'TypeError: res.results is not iterable',
        },
      }),
    )
    capture.onSessionEvent(session, assistantMessage(7, 'memory check complete'))
    capture.onSessionEvent(session, turnEnd(8))
    await capture.flush()

    expect(store.episodeList()).toHaveLength(0)
  })

  it('keeps turn episode when memory_* is accompanied by an error turn outcome', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'check memory'))
    capture.onSessionEvent(
      session,
      toolCall(3, { callId: 'c1', name: 'memory_search', arguments: '{}' }),
    )
    capture.onSessionEvent(session, toolResult(4, { callId: 'c1' }))
    capture.onSessionEvent(
      session,
      turnEnd(5, 'error', 1, { code: 'MODEL_UNAVAILABLE', message: 'model down' }),
    )
    await capture.flush()

    const turns = store.episodeList().filter((item) => item.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]?.outcome).toBe('error')
    expect(turns[0]?.failureCode).toBe('MODEL_UNAVAILABLE')
  })

  it('keeps turn episode when memory_* is mixed with a user correction or business tool', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'do it'))
    capture.onSessionEvent(session, assistantMessage(3, 'wrong answer'))
    capture.onSessionEvent(session, turnEnd(4))

    capture.onSessionEvent(session, turnStart(5, 2))
    capture.onSessionEvent(session, userMessage(6, '不对，应该是 pnpm typecheck'))
    capture.onSessionEvent(
      session,
      toolCall(7, { callId: 'c1', name: 'memory_write', arguments: '{}' }),
    )
    capture.onSessionEvent(session, toolResult(8, { callId: 'c1' }))
    capture.onSessionEvent(session, turnEnd(9, 'completed', 2))

    capture.onSessionEvent(session, turnStart(10, 3))
    capture.onSessionEvent(session, userMessage(11, 'search memory and run check'))
    capture.onSessionEvent(
      session,
      toolCall(12, { callId: 'c2', name: 'memory_search', arguments: '{}' }),
    )
    capture.onSessionEvent(session, toolResult(13, { callId: 'c2' }))
    capture.onSessionEvent(
      session,
      toolCall(14, { callId: 'c3', name: 'bash', arguments: '{"command":"pnpm typecheck"}' }),
    )
    capture.onSessionEvent(session, toolResult(15, { callId: 'c3' }))
    capture.onSessionEvent(session, turnEnd(16, 'completed', 3))
    await capture.flush()

    const turns = store.episodeList().filter((item) => item.kind === 'turn')
    expect(turns.map((item) => item.turn)).toEqual([1, 2, 3])
  })

  it('captures PTC business file edits, tool-failure, tool-recovery and worklogs with redaction', async () => {
    const opened = await openStore()
    const capture = new MemoryCapture({
      store: opened.store,
      config: {},
      onTurnEnd: async (input, record) => {
        await createTurnWorklog(opened.store, {}, input, record)
      },
    })
    const session = captureSession('s1', 'C:/ws/a', 0)
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'fix and write file'))
    capture.onSessionEvent(
      session,
      toolCall(3, {
        callId: 'ptc-root',
        name: 'run_code',
        arguments: '{"code":"await write(...); await deliver(...)"}',
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(4, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:1',
        name: 'write',
        arguments: { file_path: 'C:/ws/a/password=hunter2.ts', content: 'RAW_SECRET_PAYLOAD' },
        isError: true,
        error: { name: 'write', code: 'E_IO', reason: 'password=hunter2 failed' },
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(5, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:2',
        name: 'write',
        arguments: { file_path: 'C:/ws/a/password=hunter2.ts', content: 'RAW_SECRET_PAYLOAD' },
        isError: false,
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(6, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:3',
        name: 'deliver',
        arguments: { summary: 'done' },
        isError: false,
      }),
    )
    capture.onSessionEvent(session, toolResult(7, { callId: 'ptc-root' }))
    capture.onSessionEvent(session, assistantMessage(8, 'Updated the file cleanly.'))
    capture.onSessionEvent(session, turnEnd(9))
    await capture.flush()

    const episodes = opened.store.episodeList()
    const failure = episodes.find((item) => item.kind === 'tool-failure')
    const recovery = episodes.find((item) => item.kind === 'tool-recovery')
    const turn = episodes.find((item) => item.kind === 'turn')
    expect(failure?.toolName).toBe('write')
    expect(failure?.toolError).toContain('[REDACTED]')
    expect(recovery?.toolName).toBe('write')
    expect(recovery?.sourceSeqs).toEqual([4, 5])
    expect(turn?.files).toEqual(['C:/ws/a/[REDACTED]'])
    expect(JSON.stringify(episodes)).not.toContain('RAW_SECRET_PAYLOAD')
    expect(JSON.stringify(episodes)).not.toContain('hunter2')
    expect(opened.store.activeRecords().filter((record) => record.type === 'worklog')).toHaveLength(
      1,
    )
  })

  it('captures PTC completion tools and suppresses spoken remember after PTC memory_write', async () => {
    const opened = await openStore()
    const capture = new MemoryCapture({
      store: opened.store,
      config: {},
      onTurnEnd: async (input, record) => {
        await createTurnWorklog(opened.store, {}, input, record)
      },
    })
    const session = captureSession('s1', 'C:/ws/a', 0)
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '记住：部署前先跑 pnpm typecheck'))
    capture.onSessionEvent(
      session,
      toolCall(3, { callId: 'ptc-root', name: 'run_code', arguments: '{"code":"..."}' }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(4, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:1',
        name: 'memory_write',
        arguments: { type: 'lesson', title: 't', body: 'b' },
        isError: false,
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(5, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:2',
        name: 'complete_task',
        arguments: {},
        isError: false,
      }),
    )
    capture.onSessionEvent(session, toolResult(6, { callId: 'ptc-root' }))
    capture.onSessionEvent(session, assistantMessage(7, 'Completed the task and saved memory.'))
    capture.onSessionEvent(session, turnEnd(8))
    await capture.flush()

    const records = opened.store.activeRecords()
    expect(records.filter((record) => record.type === 'lesson')).toHaveLength(0)
    expect(records.filter((record) => record.type === 'worklog')).toHaveLength(1)
  })

  it('extracts and redacts first-line error summary from DSH PTC content when error field is absent', async () => {
    const { store, capture } = await setup()
    const session = captureSession()
    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'run build command'))
    capture.onSessionEvent(
      session,
      toolCall(3, {
        callId: 'ptc-root',
        name: 'run_code',
        arguments: '{"code":"await bash(...)"}',
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(4, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:1',
        name: 'bash',
        arguments: { command: 'pnpm build' },
        isError: true,
        text: '\n  Error: exit 1 password=hunter2  \nsecond line huge raw output should be ignored\n',
      }),
    )
    capture.onSessionEvent(
      session,
      ptcDispatch(5, {
        rootCallId: 'ptc-root',
        parentCallId: 'ptc-root',
        subCallId: 'ptc-root:ptc:2',
        name: 'bash',
        arguments: { command: 'pnpm build' },
        isError: false,
      }),
    )
    capture.onSessionEvent(session, toolResult(6, { callId: 'ptc-root' }))
    capture.onSessionEvent(session, turnEnd(7))
    await capture.flush()

    const failure = store.episodeList().find((item) => item.kind === 'tool-failure')
    const recovery = store.episodeList().find((item) => item.kind === 'tool-recovery')
    expect(failure?.toolName).toBe('bash')
    expect(failure?.toolError).toContain('Error: exit 1 [REDACTED]')
    expect(failure?.toolError).not.toContain('hunter2')
    expect(failure?.toolError).not.toContain('second line huge raw output')
    expect(recovery?.toolName).toBe('bash')
    expect(recovery?.sourceSeqs).toEqual([4, 5])
  })

  it('does not invoke onTurnEnd callback on pure memory-maintenance turns', async () => {
    const opened = await openStore()
    const onTurnEnd = vi.fn()
    const capture = new MemoryCapture({
      store: opened.store,
      config: {},
      onTurnEnd,
    })
    const session = captureSession()

    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, '执行记忆操作'))
    capture.onSessionEvent(
      session,
      toolCall(3, { callId: 'c1', name: 'memory_search', arguments: '{}' }),
    )
    capture.onSessionEvent(session, toolResult(4, { callId: 'c1' }))
    capture.onSessionEvent(session, assistantMessage(5, 'memory checked'))
    capture.onSessionEvent(session, turnEnd(6))
    await capture.flush()

    expect(onTurnEnd).not.toHaveBeenCalled()
    expect(opened.store.episodeList()).toHaveLength(0)

    capture.onSessionEvent(session, turnStart(7, 2))
    capture.onSessionEvent(session, userMessage(8, 'edit file'))
    capture.onSessionEvent(
      session,
      toolCall(9, { callId: 'c2', name: 'write', arguments: '{"file_path":"C:/ws/a/app.ts"}' }),
    )
    capture.onSessionEvent(session, toolResult(10, { callId: 'c2' }))
    capture.onSessionEvent(session, turnEnd(11, 'completed', 2))
    await capture.flush()

    expect(onTurnEnd).toHaveBeenCalledTimes(1)
  })

  it('ignores transient tool failures and interrupted turns without user corrections', async () => {
    const { store, capture } = await setup()
    const session = captureSession()

    capture.onSessionEvent(session, turnStart(1, 1))
    capture.onSessionEvent(session, userMessage(2, 'inspect missing path'))
    capture.onSessionEvent(
      session,
      toolCall(3, { callId: 'c1', name: 'read', arguments: '{"file_path":"C:/ws/a/missing.ts"}' }),
    )
    capture.onSessionEvent(
      session,
      toolResult(4, { callId: 'c1', error: { name: 'read', code: 'FS_NOT_FOUND' }, isError: true }),
    )
    capture.onSessionEvent(
      session,
      toolCall(5, { callId: 'c2', name: 'read', arguments: '{"file_path":"C:/ws/a/missing.ts"}' }),
    )
    capture.onSessionEvent(session, toolResult(6, { callId: 'c2' }))
    capture.onSessionEvent(session, turnEnd(7, 'interrupted', 1))
    await capture.flush()

    expect(store.episodeList()).toHaveLength(0)
  })
})
