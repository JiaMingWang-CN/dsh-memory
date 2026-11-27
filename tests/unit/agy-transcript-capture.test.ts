import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAgyDataPaths } from '../../src/agy/paths.ts'
import { AgySessionStateStore } from '../../src/agy/session-state.ts'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import { captureAgyTranscript } from '../../src/agy/transcript-capture.ts'
import { resolveMemoryConfig } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/core/engine.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-memory-agy-capture-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeJsonl(filePath: string, lines: readonly (Record<string, unknown> | string)[]): void {
  const text = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n')
  writeFileSync(filePath, `${text}\n`, 'utf8')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('captureAgyTranscript', () => {
  it('captures whitelisted fields, unwraps compact JSON-stringified args, redacts secrets, excludes thinking/GENERIC bodies, skips corrupt JSONL lines, and advances cursor', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript.jsonl')
    const secretKey = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456'
    const secretThinking = 'INTERNAL_THINKING_TOP_SECRET_MARKER'
    const secretFileBody = 'SENSITIVE_FILE_CONTENT_SHOULD_NEVER_BE_STORED'

    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T01:00:00.000Z',
        content: `<USER_REQUEST>\nFix build error with key ${secretKey} in a.ts\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nWorkspace: C:\\ws\\demo\nSECRET_META_IGNORED\n</ADDITIONAL_METADATA>`,
      },
      '{{{ broken json line that must be skipped safely',
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T01:00:01.000Z',
        thinking: `Private chain of thought: ${secretThinking}`,
        content: 'Updated a.ts and ran verification.',
        tool_calls: [
          {
            name: 'write_file',
            args: {
              // Compact transcript.jsonl JSON-stringified arg value
              Path: JSON.stringify('C:\\ws\\demo\\a.ts'),
              Content: JSON.stringify(secretFileBody),
            },
          },
          {
            name: 'run_command',
            args: {
              CommandLine: JSON.stringify('pnpm test'),
              Cwd: JSON.stringify('C:\\ws\\demo'),
            },
          },
        ],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T01:00:02.000Z',
        content: `Wrote file successfully\nLine 2 ok\n${secretFileBody}`,
      },
      {
        step_index: 3,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T01:00:03.000Z',
        content: `Command exited with code 1\nSyntaxError: unexpected token using ${secretKey}\n${secretFileBody}\nmore stdout line 4`,
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T01:00:04.000Z',
        thinking: secretThinking,
        content: 'Retrying command after fix.',
        tool_calls: [
          {
            name: 'run_command',
            args: {
              CommandLine: JSON.stringify('pnpm test'),
              Cwd: JSON.stringify('C:\\ws\\demo'),
            },
          },
        ],
      },
      {
        step_index: 5,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T01:00:05.000Z',
        content: `Command exited with code 0\nAll tests passed\n${secretFileBody}`,
      },
    ])

    const report = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-1',
      workspaceRoot: 'C:\\ws\\demo',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
      now: () => new Date('2026-11-25T01:01:00.000Z'),
    })

    expect(report.processedSteps).toBe(6)
    expect(report.lastStepIndex).toBe(5)
    expect(report.episodesCreated).toBe(3) // tool-failure + tool-recovery + turn
    expect(report.worklogsCreated).toBe(1)
    expect(report.directMemoriesCreated).toBe(0)

    // Verify cursor advanced
    const cursor = domain.table('session_cursors').get('conv-1')
    expect(cursor?.lastProcessedSeq).toBe(5)

    // Verify episodes
    const episodes = [...domain.table('episodes').entries()].map(([, ep]) => ep)
    const turnEp = episodes.find((ep) => ep.kind === 'turn')
    const failEp = episodes.find((ep) => ep.kind === 'tool-failure')
    const recEp = episodes.find((ep) => ep.kind === 'tool-recovery')

    expect(turnEp).toBeDefined()
    expect(turnEp?.prompt).toContain('Fix build error')
    expect(turnEp?.prompt).toContain('[REDACTED]')
    expect(turnEp?.prompt).not.toContain(secretKey)
    expect(turnEp?.prompt).not.toContain('ADDITIONAL_METADATA')
    expect(turnEp?.prompt).not.toContain('SECRET_META_IGNORED')
    expect(turnEp?.files).toContain('C:\\ws\\demo\\a.ts')
    expect(turnEp?.outcome).toBe('completed')

    expect(failEp).toBeDefined()
    expect(failEp?.toolName).toBe('run_command')
    expect(failEp?.toolError).toContain('Command exited with code 1')
    expect(failEp?.toolError).toContain('[REDACTED]')
    expect(failEp?.toolError).not.toContain(secretKey)
    expect(failEp?.toolError).not.toContain(secretFileBody)
    expect(Buffer.byteLength(failEp?.toolError ?? '', 'utf8')).toBeLessThanOrEqual(1024)

    expect(recEp).toBeDefined()
    expect(recEp?.toolName).toBe('run_command')
    expect(recEp?.sourceSeqs).toEqual([3, 5])

    // Verify serialized episodes & memories contain zero thinking or GENERIC file body leakage
    const allMemories = [...domain.table('memories').entries()].map(([, m]) => m)
    const serialized = JSON.stringify({ episodes, allMemories })
    expect(serialized).not.toContain(secretThinking)
    expect(serialized).not.toContain(secretFileBody)
    expect(serialized).not.toContain(secretKey)

    // Verify worklog created
    const worklog = allMemories.find((m) => m.type === 'worklog' && m.worklogKind === 'turn')
    expect(worklog).toBeDefined()
    expect(worklog?.ownership).toBe('derived')
    expect(worklog?.origin).toBe('system')

    // Re-running with no new steps is a no-op
    const secondReport = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-1',
      workspaceRoot: 'C:\\ws\\demo',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })
    expect(secondReport.processedSteps).toBe(0)
    expect(secondReport.episodesCreated).toBe(0)
    expect(secondReport.lastStepIndex).toBe(5)
  })

  it('splits multi-turn increments at USER_INPUT boundaries and detects cross-process user-correction via sessionStore', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript-multi.jsonl')
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T02:00:00.000Z',
        content: '<USER_REQUEST>Create module A</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T02:00:01.000Z',
        content: 'Created module A using npm.',
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T02:00:02.000Z',
        content: '<USER_REQUEST>Now create module B</USER_REQUEST>',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T02:00:03.000Z',
        content: 'Created module B with yarn.',
      },
    ])

    const first = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-multi',
      workspaceRoot: '/ws/multi',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })

    expect(first.processedSteps).toBe(4)
    expect(first.episodesCreated).toBe(2)

    const savedState = await sessionStore.read('conv-multi')
    expect(savedState?.captureTurn).toBe(2)
    expect(savedState?.previousAssistantText).toBe('Created module B with yarn.')

    // Append turn 3: user correction in a subsequent Stop Hook process
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T02:00:00.000Z',
        content: '<USER_REQUEST>Create module A</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T02:00:01.000Z',
        content: 'Created module A using npm.',
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T02:00:02.000Z',
        content: '<USER_REQUEST>Now create module B</USER_REQUEST>',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T02:00:03.000Z',
        content: 'Created module B with yarn.',
      },
      {
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T02:01:00.000Z',
        content: '<USER_REQUEST>不对，不要用 yarn，应该是 pnpm</USER_REQUEST>',
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T02:01:01.000Z',
        content: 'Switched to pnpm.',
      },
    ])

    const second = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-multi',
      workspaceRoot: '/ws/multi',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })

    expect(second.processedSteps).toBe(2)
    expect(second.worklogsCreated).toBe(1) // correction triggers worklog

    const episodes = [...domain.table('episodes').entries()].map(([, ep]) => ep)
    const correctionEp = episodes.find((ep) => ep.kind === 'user-correction')
    expect(correctionEp).toBeDefined()
    expect(correctionEp?.turn).toBe(3)
    expect(correctionEp?.correctionText).toContain('不对')
    expect(correctionEp?.assistantFinal).toBe('Created module B with yarn.')
  })

  it('persists oral remember as active system/user memory, respects negation guard, and deduplicates when memory_write was called in the same turn', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript-remember.jsonl')
    writeJsonl(transcriptPath, [
      // Turn 1: oral remember without memory_write -> creates active memory
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T03:00:00.000Z',
        content: '<USER_REQUEST>记住以后都用 pnpm 运行脚本</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T03:00:01.000Z',
        content: '好的，我记住了。',
      },
      // Turn 2: negated remember -> must NOT create memory
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T03:00:02.000Z',
        content: '<USER_REQUEST>不要记住这条临时调试命令</USER_REQUEST>',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T03:00:03.000Z',
        content: '收到，不会保存。',
      },
      // Turn 3: oral remember WITH explicit memloom_memory_write -> deduplicated
      {
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T03:00:04.000Z',
        content: '<USER_REQUEST>记住接口路径统一使用 kebab-case</USER_REQUEST>',
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T03:00:05.000Z',
        content: '已写入记忆。',
        tool_calls: [
          {
            name: 'memloom_memory_write',
            args: { title: 'kebab-case' },
          },
        ],
      },
      {
        step_index: 6,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T03:00:06.000Z',
        content: '{"id":"m-1"}',
      },
    ])

    const report = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-rem',
      workspaceRoot: '/ws/rem',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })

    expect(report.directMemoriesCreated).toBe(1)

    const memories = [...domain.table('memories').entries()]
      .map(([, m]) => m)
      .filter((m) => m.type !== 'worklog')
    expect(memories).toHaveLength(1)
    expect(memories[0]?.status).toBe('active')
    expect(memories[0]?.origin).toBe('system')
    expect(memories[0]?.ownership).toBe('user')
    expect(memories[0]?.type).toBe('preference')
    expect(memories[0]?.body).toContain('记住以后都用 pnpm 运行脚本')
  })

  it('falls back to stripping ADDITIONAL_METADATA when USER_REQUEST tag is absent and deduplicates wrapped call_mcp_tool memory_write', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript-fallback.jsonl')
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T03:30:00.000Z',
        content:
          'Remember to keep API responses deterministic\n<ADDITIONAL_METADATA>ignored metadata</ADDITIONAL_METADATA>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T03:30:01.000Z',
        content: 'Saved via MCP tool.',
        tool_calls: [
          {
            name: 'call_mcp_tool',
            args: {
              ServerName: JSON.stringify('memloom_memory'),
              ToolName: JSON.stringify('memory_write'),
              Arguments: JSON.stringify({ title: 'Deterministic API' }),
            },
          },
        ],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T03:30:02.000Z',
        content: '{"id":"m-2"}',
      },
    ])

    const report = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-fallback',
      workspaceRoot: '/ws/fallback',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })

    expect(report.processedSteps).toBe(3)
    expect(report.directMemoriesCreated).toBe(0)
    const memories = [...domain.table('memories').entries()].map(([, m]) => m)
    expect(memories).toHaveLength(0)
  })

  it('skips turn worklog when terminationReason is USER_CANCELED, subagent is true, or worklogCapture is off', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript-cancel.jsonl')
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T04:00:00.000Z',
        content: '<USER_REQUEST>Refactor helper.ts</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T04:00:01.000Z',
        content: 'Updated helper.ts.',
        tool_calls: [{ name: 'edit_file', args: { Path: '/ws/demo/helper.ts' } }],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T04:00:02.000Z',
        content: 'Edited file',
      },
    ])

    const canceled = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-canceled',
      workspaceRoot: '/ws/demo',
      terminationReason: 'USER_CANCELED',
      domain,
      engine,
      sessionStore,
      config,
    })
    expect(canceled.worklogsCreated).toBe(0)

    const subagent = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-subagent',
      workspaceRoot: '/ws/demo',
      terminationReason: 'NO_TOOL_CALL',
      subagent: true,
      domain,
      engine,
      sessionStore,
      config,
    })
    expect(subagent.worklogsCreated).toBe(0)

    const offConfig = resolveMemoryConfig({ worklogCapture: 'off' })
    const offResult = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-off',
      workspaceRoot: '/ws/demo',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config: offConfig,
    })
    expect(offResult.worklogsCreated).toBe(0)
  })

  it('reads session_cursors inside withWriteLock to avoid duplicate capture after peer writes and skips unrelated ServerName call_mcp_tool', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript-peer-sync.jsonl')
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T05:00:00.000Z',
        content: '<USER_REQUEST>Remember to test unrelated MCP calls</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T05:00:01.000Z',
        content: 'Checked external memory server.',
        tool_calls: [
          {
            name: 'call_mcp_tool',
            args: {
              ServerName: 'other-plugin_notes',
              ToolName: 'memory_write',
              Arguments: { title: 'unrelated' },
            },
          },
        ],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T05:00:02.000Z',
        content: 'ok',
      },
    ])

    // Simulate another process advancing session_cursors on disk after `domain` opened
    const peerDomain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    await peerDomain.table('session_cursors').put('conv-peer', {
      sessionId: 'conv-peer',
      workspaceKey: '/ws/demo',
      lastProcessedSeq: 2,
      lastProcessedAt: '2026-11-25T05:00:03.000Z',
    })

    const syncedReport = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-peer',
      workspaceRoot: '/ws/demo',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })
    expect(syncedReport.processedSteps).toBe(0)
    expect(syncedReport.episodesCreated).toBe(0)

    // For a fresh conversation, call_mcp_tool targeting other-plugin_notes does NOT suppress oral remember dedup
    const freshReport = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-unrelated-srv',
      workspaceRoot: '/ws/demo',
      terminationReason: 'NO_TOOL_CALL',
      domain,
      engine,
      sessionStore,
      config,
    })
    expect(freshReport.processedSteps).toBe(3)
    expect(freshReport.directMemoriesCreated).toBe(1)
  })

  it('skips transient tool errors and USER_CANCELED turns without user corrections', async () => {
    const base = makeTempDir()
    const paths = resolveAgyDataPaths({ PLUGIN_DATA: base })
    const config = resolveMemoryConfig()
    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config })
    await engine.recover()
    const sessionStore = new AgySessionStateStore(paths.sessionsDir)

    const transcriptPath = join(base, 'transcript-transient-cancel.jsonl')
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T00:00:00.000Z',
        content: '<USER_REQUEST>Search missing symbol</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T00:00:01.000Z',
        content: 'Searching.',
        tool_calls: [{ name: 'grep_search', args: { Query: 'nope' } }],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T00:00:02.000Z',
        content: 'SEARCH_FAILED: no index ready',
      },
    ])

    const report = await captureAgyTranscript({
      transcriptPath,
      conversationId: 'conv-transient-cancel',
      workspaceRoot: '/ws/demo',
      terminationReason: 'USER_CANCELED',
      domain,
      engine,
      sessionStore,
      config,
    })

    expect(report.episodesCreated).toBe(0)
    expect(domain.table('episodes').size).toBe(0)
  })
})
