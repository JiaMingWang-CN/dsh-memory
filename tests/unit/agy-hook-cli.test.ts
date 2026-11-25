import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AgyConfigStore } from '../../src/agy/config-store.ts'
import { handleHookEvent, resolveHookTargetTool, runHookCli } from '../../src/agy/hook-cli.ts'
import { resolveAgyDataPaths } from '../../src/agy/paths.ts'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import { SENSITIVE_TOOL_NAMES } from '../../src/agy/tools.ts'
import { HOST_CONTEXT_ARG_KEY, verifyHostContextNonce } from '../../src/agy/workspace-resolver.ts'
import { resolveMemoryConfig } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/core/engine.ts'
import { normalizeWorkspaceKey } from '../../src/core/workspace.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-memory-agy-hook-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function seedMemory(
  dataDir: string,
  workspaceRoot: string,
  title: string,
  body: string,
): Promise<string> {
  const paths = resolveAgyDataPaths({ PLUGIN_DATA: dataDir })
  const domain = await FileMemoryDomain.open({
    storePath: paths.storePath,
    lockPath: paths.lockPath,
    backupsDir: paths.backupsDir,
  })
  const engine = new MemoryEngine({ domain, config: resolveMemoryConfig() })
  await engine.recover()
  const written = await domain.withWriteLock(() =>
    engine.write(
      {
        type: 'lesson',
        title,
        body,
        scope: 'workspace',
        importance: 0.9,
      },
      { key: normalizeWorkspaceKey(workspaceRoot), root: workspaceRoot },
    ),
  )
  return written.record.id
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveHookTargetTool', () => {
  it('resolves direct MCP memory tool names and wrapped call_mcp_tool payloads', () => {
    expect(
      resolveHookTargetTool({
        name: 'dsh-memory_memory_review',
        args: { id: 'm1', action: 'accept' },
      }),
    ).toEqual({
      toolName: 'memory_review',
      toolArgs: { id: 'm1', action: 'accept' },
      wrapped: false,
    })

    expect(
      resolveHookTargetTool({
        name: 'mcp_dsh-memory_memory_export',
        args: { scope: 'all' },
      }),
    ).toEqual({
      toolName: 'memory_export',
      toolArgs: { scope: 'all' },
      wrapped: false,
    })

    expect(
      resolveHookTargetTool({
        name: 'call_mcp_tool',
        args: {
          ServerName: 'dsh-memory_memory',
          ToolName: 'memory_review',
          Arguments: { id: 'm2', action: 'reject' },
        },
      }),
    ).toEqual({
      toolName: 'memory_review',
      toolArgs: { id: 'm2', action: 'reject' },
      wrapped: true,
      wrapperArgsKey: 'Arguments',
    })

    expect(
      resolveHookTargetTool({
        name: 'call_mcp_tool',
        args: {
          serverName: 'memory',
          toolName: 'memory_list',
          arguments: JSON.stringify({ scope: 'all' }),
        },
      }),
    ).toEqual({
      toolName: 'memory_list',
      toolArgs: { scope: 'all' },
      wrapped: true,
      wrapperArgsKey: 'arguments',
    })

    expect(resolveHookTargetTool({ name: 'write_file', args: { Path: '/a.ts' } })).toBeUndefined()
    expect(
      resolveHookTargetTool({
        name: 'call_mcp_tool',
        args: { ServerName: 'agy-fast', ToolName: 'fast_batch_search', Arguments: {} },
      }),
    ).toBeUndefined()
  })
})

describe('handleHookEvent — PreInvocation', () => {
  it('injects baseline on first turn and fast-skips second turn without reading memory.json when refreshIndexOnChange is false', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const ws = 'C:\\ws\\demo'
    await seedMemory(dataDir, ws, 'Use pnpm everywhere', 'Always run pnpm instead of npm.')

    const first = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-pre-1',
        workspacePaths: [ws],
        lastUserInput:
          '<USER_REQUEST>How should I run tests?</USER_REQUEST><ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>',
      },
      env,
    )

    const steps = first.injectSteps as Array<{ systemMessage: { systemMessage: string } }>
    expect(Array.isArray(steps)).toBe(true)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.systemMessage.systemMessage).toContain('<system-reminder>')
    expect(steps[0]?.systemMessage.systemMessage).toContain('Use pnpm everywhere')
    expect(steps[0]?.systemMessage.systemMessage).toContain('</system-reminder>')

    // Prove fast-skip does NOT read memory.json by overwriting memory.json with invalid JSON
    const paths = resolveAgyDataPaths(env)
    writeFileSync(paths.storePath, '{{{ CORRUPT_NOT_READ_ON_FAST_SKIP', 'utf8')

    const second = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-pre-1',
        workspacePaths: [ws],
        lastUserInput: '<USER_REQUEST>Next question</USER_REQUEST>',
      },
      env,
    )
    expect(second).toEqual({})
  })

  it('recalls BM25-matched workspace preference, wiki, and low-importance lesson on lock-free PreInvocation', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const ws = 'C:\\ws\\bm25-recall'
    const paths = resolveAgyDataPaths(env)

    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    const engine = new MemoryEngine({ domain, config: resolveMemoryConfig() })
    await engine.recover()
    const wsId = { key: normalizeWorkspaceKey(ws), root: ws }
    await domain.withWriteLock(async () => {
      await engine.write(
        {
          type: 'preference',
          scope: 'workspace',
          title: 'Prefer pnpm workspace scripts',
          body: 'Use pnpm for all monorepo builds and tests.',
          importance: 0.5,
        },
        wsId,
      )
      await engine.write(
        {
          type: 'wiki',
          scope: 'workspace',
          title: 'Quartz scheduler architecture',
          body: 'Quartz jobs read pnpm configuration before dispatch.',
          importance: 0.5,
        },
        wsId,
      )
      await engine.write(
        {
          type: 'lesson',
          scope: 'workspace',
          title: 'Avoid npm lockfile drift',
          body: 'Never mix npm with pnpm in this repository.',
          importance: 0.5,
        },
        wsId,
      )
    })

    const res = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-bm25-1',
        workspacePaths: [ws],
        lastUserInput: '<USER_REQUEST>How should we run pnpm quartz builds?</USER_REQUEST>',
      },
      env,
    )

    const steps = res.injectSteps as Array<{ systemMessage: { systemMessage: string } }>
    expect(Array.isArray(steps)).toBe(true)
    expect(steps).toHaveLength(1)
    const text = steps[0]?.systemMessage.systemMessage ?? ''
    expect(text).toContain('Prefer pnpm workspace scripts')
    expect(text).toContain('Quartz scheduler architecture')
    expect(text).toContain('Avoid npm lockfile drift')
  })

  it('injects delta when refreshIndexOnChange is true and a new memory is added', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const paths = resolveAgyDataPaths(env)
    const configStore = new AgyConfigStore(paths.configPath)
    await configStore.savePatch({
      refreshIndexOnChange: true,
      refreshMinIntervalMs: 0,
    })

    const ws = '/ws/delta'
    await seedMemory(dataDir, ws, 'Initial rule', 'Always check types.')

    const first = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-delta-1',
        workspacePaths: [ws],
        lastUserInput: 'check types',
      },
      env,
    )
    expect(Array.isArray(first.injectSteps)).toBe(true)

    await seedMemory(dataDir, ws, 'Second critical rule', 'Never skip lint before commit.')

    const second = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-delta-1',
        workspacePaths: [ws],
        lastUserInput: 'commit changes',
      },
      env,
    )
    const steps = second.injectSteps as Array<{ systemMessage: { systemMessage: string } }>
    expect(Array.isArray(steps)).toBe(true)
    expect(steps[0]?.systemMessage.systemMessage).toContain('增量更新')
    expect(steps[0]?.systemMessage.systemMessage).toContain('Second critical rule')
  })

  it('respects enabled=false, subagent suppression, and scope-change reset in PreInvocation', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const ws1 = '/ws/one'
    const ws2 = '/ws/two'
    await seedMemory(dataDir, ws1, 'Rule One', 'Workspace one rule.')
    await seedMemory(dataDir, ws2, 'Rule Two', 'Workspace two rule.')

    // Subagent suppressed by default (injectForSubagents=false)
    const subRes = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-sub',
        workspacePaths: [ws1],
        subagent: true,
        lastUserInput: 'hello',
      },
      env,
    )
    expect(subRes).toEqual({})

    // First turn in ws1 -> baseline
    const baseRes = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-scope-switch',
        workspacePaths: [ws1],
        lastUserInput: 'rule',
      },
      env,
    )
    expect(
      (baseRes.injectSteps as Array<{ systemMessage: { systemMessage: string } }>)[0]?.systemMessage
        .systemMessage,
    ).toContain('Rule One')

    // Scope changes to ws2 -> reset even when refreshIndexOnChange=false
    const resetRes = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-scope-switch',
        workspacePaths: [ws2],
        lastUserInput: 'rule',
      },
      env,
    )
    const resetText = (
      resetRes.injectSteps as Array<{ systemMessage: { systemMessage: string } }>
    )[0]?.systemMessage.systemMessage
    expect(resetText).toContain('记忆索引已重置')
    expect(resetText).toContain('Rule Two')

    // Disabled config skips injection
    const paths = resolveAgyDataPaths(env)
    await new AgyConfigStore(paths.configPath).savePatch({ enabled: false })
    const disabledRes = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-disabled',
        workspacePaths: [ws1],
        lastUserInput: 'rule',
      },
      env,
    )
    expect(disabledRes).toEqual({})
  })

  it('fails open and logs redacted diagnostic when memory.json is corrupt on first turn', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const paths = resolveAgyDataPaths(env)
    writeFileSync(paths.storePath, '{{{ invalid json', 'utf8')

    const result = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-corrupt',
        workspacePaths: ['/ws/demo'],
        lastUserInput: 'hello',
      },
      env,
    )
    expect(result).toEqual({})
    const logContent = readFileSync(paths.logPath, 'utf8')
    expect(logContent).toContain('PreInvocation')
  })
})

describe('handleHookEvent — PreToolUse', () => {
  it('returns {} immediately for non-memory tools', async () => {
    const dataDir = makeTempDir()
    const res = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-1',
        workspacePaths: ['/ws/demo'],
        toolCall: { id: 'tc-1', name: 'write_file', args: { Path: '/ws/demo/a.ts' } },
      },
      { PLUGIN_DATA: dataDir },
    )
    expect(res).toEqual({})
  })

  it('gates all 8 sensitive tools with force_ask in both direct and wrapped call_mcp_tool forms with risk highlights and proper shallow-merge overwrite', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const ws = '/ws/demo'

    for (const toolName of SENSITIVE_TOOL_NAMES) {
      const directRes = await handleHookEvent(
        {
          hookEventName: 'PreToolUse',
          conversationId: 'conv-sens',
          workspacePaths: [ws],
          toolCall: {
            id: `direct-${toolName}`,
            name: `dsh-memory_${toolName}`,
            args:
              toolName === 'memory_config'
                ? { redactSecrets: false, autoAcceptProposals: true, injectForSubagents: true }
                : toolName === 'memory_import'
                  ? { mode: 'replace', targetScope: 'all', confirm: true }
                  : toolName === 'memory_purge'
                    ? { scope: 'workspace', confirmText: 'PURGE /ws/demo' }
                    : toolName === 'memory_delete'
                      ? { id: 'mem-1', expectedContentRevision: 2 }
                      : { id: 'mem-1', action: 'accept', dreamId: 'drm-1' },
          },
        },
        env,
      )

      expect(directRes.decision, toolName).toBe('force_ask')
      expect(typeof directRes.reason, toolName).toBe('string')
      expect((directRes.reason as string).length, toolName).toBeGreaterThan(5)

      const directOverwrite = directRes.overwrite as Record<string, unknown>
      const directHostCtx = directOverwrite[HOST_CONTEXT_ARG_KEY] as {
        nonce: string
        workspaceRoot: string
        conversationId: string
      }
      expect(await verifyHostContextNonce(dataDir, directHostCtx.nonce)).toBe(true)
      expect(directHostCtx.workspaceRoot).toBe(ws)
      expect(directHostCtx.conversationId).toBe('conv-sens')

      if (toolName === 'memory_config') {
        expect(directRes.reason).toContain('redactSecrets')
        expect(directRes.reason).toContain('autoAcceptProposals')
        expect(directRes.reason).toContain('injectForSubagents')
      }
      if (toolName === 'memory_import') {
        expect(directRes.reason).toContain('replace')
      }
      if (toolName === 'memory_purge') {
        expect(directRes.reason).toContain('不可逆')
      }

      // Wrapped call_mcp_tool form MUST replace the whole Arguments key while preserving inner args
      const wrappedArgs = { id: 'mem-wrapped', action: 'accept' }
      const wrappedRes = await handleHookEvent(
        {
          hookEventName: 'PreToolUse',
          conversationId: 'conv-sens',
          workspacePaths: [ws],
          toolCall: {
            id: `wrap-${toolName}`,
            name: 'call_mcp_tool',
            args: {
              ServerName: 'dsh-memory_memory',
              ToolName: toolName,
              Arguments: wrappedArgs,
            },
          },
        },
        env,
      )
      expect(wrappedRes.decision, `wrapped ${toolName}`).toBe('force_ask')
      const wrappedOverwrite = wrappedRes.overwrite as {
        Arguments: Record<string, unknown>
      }
      expect(wrappedOverwrite.Arguments.id).toBe('mem-wrapped')
      expect(wrappedOverwrite.Arguments.action).toBe('accept')
      expect(wrappedOverwrite.Arguments[HOST_CONTEXT_ARG_KEY]).toBeDefined()
    }
  })

  it('allows normal memory_list/memory_export with verified nonce and escalates scope=all, cross-workspace, or outputPath to force_ask', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const ws = 'C:\\ws\\project-a'

    const normalList = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-reg',
        workspacePaths: [ws],
        toolCall: { name: 'mcp_dsh-memory_memory_list', args: { scope: 'current' } },
      },
      env,
    )
    expect(normalList.decision).toBe('allow')
    const normalCtx = (normalList.overwrite as Record<string, unknown>)[HOST_CONTEXT_ARG_KEY] as {
      nonce: string
      approvedScopeOverride?: boolean
    }
    expect(await verifyHostContextNonce(dataDir, normalCtx.nonce)).toBe(true)
    expect(normalCtx.approvedScopeOverride).toBeUndefined()

    const allScopeList = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-reg',
        workspacePaths: [ws],
        toolCall: { name: 'memory_list', args: { scope: 'all' } },
      },
      env,
    )
    expect(allScopeList.decision).toBe('force_ask')
    const allCtx = (allScopeList.overwrite as Record<string, unknown>)[HOST_CONTEXT_ARG_KEY] as {
      approvedScopeOverride?: boolean
    }
    expect(allCtx.approvedScopeOverride).toBe(true)

    const crossWsExport = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-reg',
        workspacePaths: [ws],
        toolCall: {
          name: 'memory_export',
          args: { workspaceRoot: 'C:\\ws\\project-b' },
        },
      },
      env,
    )
    expect(crossWsExport.decision).toBe('force_ask')
    expect(
      (
        (crossWsExport.overwrite as Record<string, unknown>)[HOST_CONTEXT_ARG_KEY] as {
          approvedScopeOverride?: boolean
        }
      ).approvedScopeOverride,
    ).toBe(true)

    const outputPathExport = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-reg',
        workspacePaths: [ws],
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'dsh-memory_memory',
            ToolName: 'memory_export',
            Arguments: { outputPath: 'C:\\tmp\\export.json' },
          },
        },
      },
      env,
    )
    expect(outputPathExport.decision).toBe('force_ask')
    const wrappedExportArgs = (outputPathExport.overwrite as { Arguments: Record<string, unknown> })
      .Arguments
    expect(wrappedExportArgs.outputPath).toBe('C:\\tmp\\export.json')
    expect(
      (wrappedExportArgs[HOST_CONTEXT_ARG_KEY] as { approvedScopeOverride?: boolean })
        .approvedScopeOverride,
    ).toBe(true)
  })

  it('fails closed with force_ask when memory tool arguments are malformed', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }

    const badDirect = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-bad',
        workspacePaths: ['/ws/demo'],
        toolCall: { name: 'memory_export', args: '{not valid json' },
      },
      env,
    )
    expect(badDirect.decision).toBe('force_ask')

    const badWrapped = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-bad',
        workspacePaths: ['/ws/demo'],
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'dsh-memory_memory',
            ToolName: 'memory_list',
            Arguments: '{broken json',
          },
        },
      },
      env,
    )
    expect(badWrapped.decision).toBe('force_ask')
  })
})

describe('handleHookEvent — Stop & CLI', () => {
  it('captures transcript incrementally on Stop and skips cleanly when continuationActive has no new steps or autoCaptureEpisodes is false', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }
    const paths = resolveAgyDataPaths(env)
    const transcriptPath = join(dataDir, 'stop-valid.jsonl')

    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-25T05:00:00.000Z',
          content: '<USER_REQUEST>Update readme</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-25T05:00:01.000Z',
          content: 'Updated readme.',
          tool_calls: [{ name: 'edit_file', args: { Path: '/ws/stop/README.md' } }],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'SYSTEM',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-25T05:00:02.000Z',
          content: 'Edited README.md',
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const res = await handleHookEvent(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-stop-ok',
        workspacePaths: ['/ws/stop'],
        transcriptPath,
        terminationReason: 'NO_TOOL_CALL',
      },
      env,
    )
    expect(res).toEqual({})

    const domain = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    expect(domain.table('session_cursors').get('conv-stop-ok')?.lastProcessedSeq).toBe(2)
    expect(domain.table('episodes').size).toBe(1)

    // continuationActive with no new steps -> returns {} without error or new episodes
    const contRes = await handleHookEvent(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-stop-ok',
        workspacePaths: ['/ws/stop'],
        transcriptPath,
        continuationActive: true,
      },
      env,
    )
    expect(contRes).toEqual({})

    // autoCaptureEpisodes=false -> skips cleanly
    await new AgyConfigStore(paths.configPath).savePatch({ autoCaptureEpisodes: false })
    const offRes = await handleHookEvent(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-stop-off',
        workspacePaths: ['/ws/stop'],
        transcriptPath,
        terminationReason: 'NO_TOOL_CALL',
      },
      env,
    )
    expect(offRes).toEqual({})
    const domainAfter = await FileMemoryDomain.open({
      storePath: paths.storePath,
      lockPath: paths.lockPath,
      backupsDir: paths.backupsDir,
    })
    expect(domainAfter.table('session_cursors').get('conv-stop-off')).toBeUndefined()
  })

  it('never returns continue and fails open with redacted diagnostic log on missing transcript or lock timeout', async () => {
    const dataDir = makeTempDir()
    const env = {
      PLUGIN_DATA: dataDir,
      DSH_MEMORY_LOCK_TIMEOUT_MS: '80',
    }
    const paths = resolveAgyDataPaths(env)

    // 1. Missing transcript file on disk -> fail-open {} and log error
    const missingSecretPath = join(
      dataDir,
      'missing-sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456.jsonl',
    )
    const missingRes = await handleHookEvent(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-stop-missing',
        workspacePaths: ['/ws/demo'],
        transcriptPath: missingSecretPath,
        terminationReason: 'NO_TOOL_CALL',
      },
      env,
    )
    expect(missingRes).toEqual({})
    expect(missingRes.continue).toBeUndefined()
    const logAfterMissing = readFileSync(paths.logPath, 'utf8')
    expect(logAfterMissing).toContain('Stop')
    expect(logAfterMissing).toContain('[REDACTED]')
    expect(logAfterMissing).not.toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456')

    // 2. Active lock timeout -> fail-open {} and log error
    const transcriptPath = join(dataDir, 'valid-transcript.jsonl')
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T05:00:00.000Z',
        content: '<USER_REQUEST>Hello</USER_REQUEST>',
      })}\n`,
      'utf8',
    )
    writeFileSync(
      paths.lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: 'test-host',
        createdAtMs: Date.now(),
        token: 'held-by-test',
      }),
      'utf8',
    )

    const lockRes = await handleHookEvent(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-stop-lock',
        workspacePaths: ['/ws/demo'],
        transcriptPath,
        terminationReason: 'NO_TOOL_CALL',
      },
      env,
    )
    expect(lockRes).toEqual({})
    expect(lockRes.continue).toBeUndefined()
    const logAfterLock = readFileSync(paths.logPath, 'utf8')
    expect(logAfterLock).toContain('Timed out')
  })

  it('runHookCli reads stdin JSON and outputs single-line JSON, failing closed on corrupt PreToolUse memory input', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }

    // Valid PreToolUse stdin
    const input1 = new PassThrough()
    const output1 = new PassThrough()
    let outText1 = ''
    output1.on('data', (chunk) => {
      outText1 += String(chunk)
    })
    input1.end(
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-cli',
        workspacePaths: ['/ws/demo'],
        toolCall: { name: 'memory_purge', args: { scope: 'all', confirmText: 'PURGE all' } },
      }),
    )
    await runHookCli(input1, output1, env)
    expect(outText1.trim().split('\n')).toHaveLength(1)
    const parsed1 = JSON.parse(outText1.trim()) as { decision?: string }
    expect(parsed1.decision).toBe('force_ask')

    // Corrupt PreToolUse memory stdin -> fail-closed force_ask
    const input2 = new PassThrough()
    const output2 = new PassThrough()
    let outText2 = ''
    output2.on('data', (chunk) => {
      outText2 += String(chunk)
    })
    input2.end('{"hookEventName":"PreToolUse","toolCall":{"name":"memory_delete", bad')
    await runHookCli(input2, output2, env)
    const parsed2 = JSON.parse(outText2.trim()) as { decision?: string }
    expect(parsed2.decision).toBe('force_ask')

    // Corrupt non-PreToolUse stdin -> fail-open {}
    const input3 = new PassThrough()
    const output3 = new PassThrough()
    let outText3 = ''
    output3.on('data', (chunk) => {
      outText3 += String(chunk)
    })
    input3.end('{"hookEventName":"Stop", broken')
    await runHookCli(input3, output3, env)
    expect(JSON.parse(outText3.trim())).toEqual({})
  })

  it('ignores call_mcp_tool for unrelated MCP servers and skips empty reset injections on scope switches', async () => {
    const dataDir = makeTempDir()
    const env = { PLUGIN_DATA: dataDir }

    // Unrelated ServerName with memory_search tool name must NOT be intercepted
    const otherServerRes = await handleHookEvent(
      {
        hookEventName: 'PreToolUse',
        conversationId: 'conv-other-srv',
        workspacePaths: ['/ws/demo'],
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'other-plugin_notes',
            ToolName: 'memory_search',
            Arguments: { query: 'hello' },
          },
        },
      },
      env,
    )
    expect(otherServerRes).toEqual({})

    // Inject empty baseline in conv-switch on /ws/empty-alpha, then switch to empty /ws/empty-beta -> no empty reset step
    const first = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-switch',
        workspacePaths: ['/ws/empty-alpha'],
        lastUserInput: '<USER_REQUEST>Check alpha</USER_REQUEST>',
      },
      env,
    )
    expect(first).toEqual({})

    const switchedEmpty = await handleHookEvent(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-switch',
        workspacePaths: ['/ws/empty-beta'],
        lastUserInput: '<USER_REQUEST>Hello beta</USER_REQUEST>',
      },
      env,
    )
    expect(switchedEmpty).toEqual({})
  })
})
