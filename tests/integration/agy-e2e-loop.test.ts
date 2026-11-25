import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgyPlugin } from '../../scripts/build-agy.mjs'
import { resolveAgyDataPaths } from '../../src/agy/paths.ts'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import {
  HOST_CONTEXT_ARG_KEY,
  verifyHostContextNonce,
  type HostContextPayload,
} from '../../src/agy/workspace-resolver.ts'
import { normalizeWorkspaceKey } from '../../src/core/workspace.ts'
import { memoryDomain } from '../../src/host/domain.ts'
import { importMemories, type MemoryExport } from '../../src/host/exchange.ts'
import { OperationRunner } from '../../src/host/operations.ts'
import { MemoryStore } from '../../src/host/store.ts'
import type { MemoryRecord } from '../../src/shared/types.ts'
import { createFakeHost, FakeDomainFacility } from '../helpers/fake-domain.ts'

interface JsonRpcMessage {
  jsonrpc: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpToolCallResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

interface HookExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown>
}

class StdioJsonRpcClient {
  private readonly input: NodeJS.WritableStream
  private readonly rawLines: string[] = []
  private readonly messages: JsonRpcMessage[] = []
  private readonly waiters: Array<{
    predicate: (msg: JsonRpcMessage) => boolean
    resolve: (msg: JsonRpcMessage) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }> = []
  private readonly onServerRequest?: (msg: JsonRpcMessage) => void
  private buffer = ''

  constructor(
    input: NodeJS.WritableStream,
    output: NodeJS.ReadableStream,
    onServerRequest?: (msg: JsonRpcMessage) => void,
  ) {
    this.input = input
    if (onServerRequest !== undefined) {
      this.onServerRequest = onServerRequest
    }
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '')
        this.buffer = this.buffer.slice(idx + 1)
        if (line.length > 0) {
          this.handleLine(line)
        }
        idx = this.buffer.indexOf('\n')
      }
    })
  }

  get stdoutLines(): readonly string[] {
    return this.rawLines
  }

  send(msg: Record<string, unknown>): void {
    this.input.write(`${JSON.stringify(msg)}\n`)
  }

  async request(
    id: string | number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<JsonRpcMessage> {
    const promise = this.waitFor((msg) => msg.id === id && msg.method === undefined, timeoutMs)
    this.send({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })
    return await promise
  }

  async callTool<T>(
    id: number,
    name: string,
    args: Record<string, unknown>,
    stderrRef?: () => string,
  ): Promise<T> {
    const response = await this.request(id, 'tools/call', { name, arguments: args })
    expect(response.error, stderrRef?.()).toBeUndefined()
    const toolResult = response.result as McpToolCallResult
    expect(toolResult.isError, toolResult.content[0]?.text).toBeUndefined()
    expect(toolResult.content.length).toBeGreaterThan(0)
    return JSON.parse(toolResult.content[0]!.text) as T
  }

  dispose(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.pop()!
      clearTimeout(waiter.timer)
      waiter.reject(new Error('JSON-RPC client disposed'))
    }
  }

  private waitFor(
    predicate: (msg: JsonRpcMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<JsonRpcMessage> {
    const existingIndex = this.messages.findIndex(predicate)
    if (existingIndex !== -1) {
      const [matched] = this.messages.splice(existingIndex, 1)
      return Promise.resolve(matched!)
    }
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((entry) => entry.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new Error(`Timed out waiting for JSON-RPC message after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  private handleLine(line: string): void {
    this.rawLines.push(line)
    const parsed = JSON.parse(line) as JsonRpcMessage
    if (typeof parsed.method === 'string' && parsed.id !== undefined) {
      this.onServerRequest?.(parsed)
    }
    const waiterIdx = this.waiters.findIndex((entry) => entry.predicate(parsed))
    if (waiterIdx !== -1) {
      const [waiter] = this.waiters.splice(waiterIdx, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(parsed)
      return
    }
    this.messages.push(parsed)
  }
}

const tempDirs: string[] = []
const activeChildren = new Set<ChildProcessWithoutNullStreams>()

function makeTempDir(prefix = 'dsh-memory-agy-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) {
    activeChildren.delete(child)
    return child.exitCode
  }
  const exitPromise = new Promise<number | null>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
      resolve(child.exitCode)
    }, 3000)
    forceKillTimer.unref()
    child.once('exit', (code) => {
      clearTimeout(forceKillTimer)
      resolve(code)
    })
  })
  try {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end()
    }
  } catch {
    // Ignore already-closed stdin.
  }
  const graceTimer = setTimeout(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM')
    }
  }, 1500)
  graceTimer.unref()
  const code = await exitPromise
  clearTimeout(graceTimer)
  activeChildren.delete(child)
  return code
}

async function runHookCli(
  hookBin: string,
  payload: Record<string, unknown>,
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<HookExecResult> {
  const child = spawn(process.execPath, [hookBin], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  activeChildren.add(child)

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
      reject(new Error(`Hook CLI timed out after ${timeoutMs}ms. stderr=${stderr}`))
    }, timeoutMs)
    timer.unref()

    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })

    child.stdin.end(JSON.stringify(payload))
  })
  activeChildren.delete(child)

  const trimmed = stdout.trim()
  const json = trimmed.length > 0 ? (JSON.parse(trimmed) as Record<string, unknown>) : {}
  return { exitCode, stdout, stderr, json }
}

describe('AGY bundled plugin end-to-end full loop', () => {
  let hookBin = ''
  let mcpBin = ''

  beforeAll(async () => {
    const buildOutDir = join(makeTempDir('dsh-memory-agy-e2e-plugin-'), 'agy-plugin')
    const built = await buildAgyPlugin({ outDir: buildOutDir })
    hookBin = join(built.outDir, 'bin', 'hook.mjs')
    mcpBin = join(built.outDir, 'bin', 'mcp-server.mjs')
  }, 30_000)

  afterAll(async () => {
    for (const child of [...activeChildren]) {
      await stopChildProcess(child)
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('completes Stop capture -> PreInvocation baseline/skip -> two-stage Dream -> PreToolUse review gate -> lossless DSH import', async () => {
    const tempRoot = makeTempDir()
    const dataDir = join(tempRoot, 'plugin-data')
    const workspaceRoot = join(tempRoot, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })

    const workspaceKey = normalizeWorkspaceKey(workspaceRoot)
    const workspaceUri = pathToFileURL(workspaceRoot).href
    const hookEnv = { PLUGIN_DATA: dataDir }
    const editedFilePath = join(workspaceRoot, 'src', 'app.ts')

    // -------------------------------------------------------------------------
    // Step 1: Stop hook captures file edit + oral "记住" preference
    // -------------------------------------------------------------------------
    const transcriptPath = join(tempRoot, 'transcript.jsonl')
    const transcriptLines = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T03:00:00.000Z',
        content:
          '<USER_REQUEST>记住以后统一使用 pnpm 运行构建和测试，并修复 src/app.ts 的配置加载</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored-metadata</ADDITIONAL_METADATA>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T03:00:01.000Z',
        thinking: 'internal thinking must not be persisted',
        content: '已更新 src/app.ts 的配置加载，并记住统一使用 pnpm。',
        tool_calls: [
          {
            name: 'edit_file',
            args: {
              Path: JSON.stringify(editedFilePath),
            },
          },
        ],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T03:00:02.000Z',
        content: 'Edited file successfully',
      },
    ]
    writeFileSync(
      transcriptPath,
      `${transcriptLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    )

    const stopRes = await runHookCli(
      hookBin,
      {
        hookEventName: 'Stop',
        conversationId: 'conv-e2e-1',
        workspacePaths: [workspaceRoot],
        transcriptPath,
        terminationReason: 'NO_TOOL_CALL',
      },
      hookEnv,
    )
    expect(stopRes.exitCode, stopRes.stderr).toBe(0)
    expect(stopRes.json).toEqual({})

    // Verify persisted episodes, worklog(turn), and active preference in PLUGIN_DATA
    const agyPaths = resolveAgyDataPaths(hookEnv)
    const inspectDomain = await FileMemoryDomain.open({
      storePath: agyPaths.storePath,
      lockPath: agyPaths.lockPath,
      backupsDir: agyPaths.backupsDir,
    })
    const persistedEpisodes = [...inspectDomain.table('episodes').entries()].map(([, ep]) => ep)
    const persistedMemories = [...inspectDomain.table('memories').entries()].map(([, mem]) => mem)

    const turnEpisode = persistedEpisodes.find((ep) => ep.kind === 'turn')
    expect(turnEpisode).toBeDefined()
    expect(turnEpisode?.workspaceKey).toBe(workspaceKey)
    expect(turnEpisode?.files).toContain(editedFilePath)

    const turnWorklog = persistedMemories.find(
      (mem) => mem.type === 'worklog' && mem.worklogKind === 'turn',
    )
    expect(turnWorklog).toBeDefined()
    expect(turnWorklog?.status).toBe('active')
    expect(turnWorklog?.ownership).toBe('derived')

    const capturedPreference = persistedMemories.find((mem) => mem.type === 'preference')
    expect(capturedPreference).toBeDefined()
    expect(capturedPreference?.status).toBe('active')
    expect(capturedPreference?.ownership).toBe('user')
    expect(capturedPreference?.body).toContain('记住以后统一使用 pnpm')

    // -------------------------------------------------------------------------
    // Step 2: PreInvocation injects <system-reminder> baseline, then skips turn 2
    // -------------------------------------------------------------------------
    const preFirst = await runHookCli(
      hookBin,
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-e2e-2',
        workspacePaths: [workspaceRoot],
        lastUserInput: '<USER_REQUEST>请帮我用 pnpm 运行构建和测试</USER_REQUEST>',
      },
      hookEnv,
    )
    expect(preFirst.exitCode, preFirst.stderr).toBe(0)
    const injectSteps = preFirst.json.injectSteps as Array<{
      systemMessage: { systemMessage: string }
    }>
    expect(Array.isArray(injectSteps)).toBe(true)
    expect(injectSteps).toHaveLength(1)
    const baselineText = injectSteps[0]!.systemMessage.systemMessage
    expect(baselineText).toContain('<system-reminder>')
    expect(baselineText).toContain('</system-reminder>')
    expect(baselineText).toContain('[preference]')
    expect(baselineText).toContain('pnpm')
    expect(baselineText).toContain('## 最近工作')
    expect(baselineText).toContain('[worklog]')

    // Second PreInvocation for the same conversationId (refreshIndexOnChange=false) returns {}
    const preSecond = await runHookCli(
      hookBin,
      {
        hookEventName: 'PreInvocation',
        conversationId: 'conv-e2e-2',
        workspacePaths: [workspaceRoot],
        lastUserInput: '<USER_REQUEST>继续检查测试输出</USER_REQUEST>',
      },
      hookEnv,
    )
    expect(preSecond.exitCode, preSecond.stderr).toBe(0)
    expect(preSecond.json).toEqual({})

    // -------------------------------------------------------------------------
    // Step 3: Spawn bundled mcp-server.mjs -> two-stage dreaming -> pending lesson
    // -------------------------------------------------------------------------
    const mcpChild = spawn(process.execPath, [mcpBin], {
      env: {
        ...process.env,
        PLUGIN_DATA: dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    activeChildren.add(mcpChild)

    let mcpStderr = ''
    mcpChild.stderr.setEncoding('utf8')
    mcpChild.stderr.on('data', (chunk: string) => {
      mcpStderr += chunk
    })

    const rootsRequests: JsonRpcMessage[] = []
    const client = new StdioJsonRpcClient(mcpChild.stdin, mcpChild.stdout, (req) => {
      if (req.method === 'roots/list') {
        rootsRequests.push(req)
        client.send({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            roots: [{ uri: workspaceUri, name: 'e2e-workspace' }],
          },
        })
      }
    })

    let dshDomainClose: (() => Promise<void>) | undefined
    try {
      const initRes = await client.request(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: { roots: {} },
        clientInfo: { name: 'agy-e2e-client', version: '1.0.0' },
      })
      expect(initRes.error, mcpStderr).toBeUndefined()
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

      const prepared = await client.callTool<{
        dreamId: string
        episodeIds: string[]
        scope: { kind: string; key?: string }
      }>(2, 'memory_dream_prepare', { scope: 'workspace' }, () => mcpStderr)

      expect(rootsRequests.length).toBeGreaterThanOrEqual(1)
      expect(prepared.dreamId).toBeTruthy()
      expect(prepared.episodeIds.length).toBeGreaterThanOrEqual(1)
      expect(prepared.scope).toMatchObject({ kind: 'workspace', key: workspaceKey })

      const committed = await client.callTool<{
        dreamId: string
        status: string
        createdIds: string[]
        processedEpisodes: number
      }>(
        3,
        'memory_dream_commit',
        {
          dreamId: prepared.dreamId,
          memories: [
            {
              type: 'lesson',
              title: 'Run pnpm verification after editing app.ts',
              body: 'Always run pnpm build and pnpm test after modifying src/app.ts configuration loading.',
              confidence: 0.92,
              importance: 0.85,
              sourceEpisodeIds: prepared.episodeIds,
              tags: ['workflow', 'pnpm'],
            },
          ],
        },
        () => mcpStderr,
      )
      expect(committed.dreamId).toBe(prepared.dreamId)
      expect(committed.status).toBe('completed')
      expect(committed.createdIds).toHaveLength(1)
      const proposalId = committed.createdIds[0]!

      const pendingList = await client.callTool<{
        items: MemoryRecord[]
        total: number
      }>(4, 'memory_list', { status: 'pending' }, () => mcpStderr)
      const pendingProposal = pendingList.items.find((item) => item.id === proposalId)
      expect(pendingProposal).toBeDefined()
      expect(pendingProposal?.type).toBe('lesson')
      expect(pendingProposal?.status).toBe('pending')
      expect(pendingProposal?.ownership).toBe('derived')
      expect(pendingProposal?.origin).toBe('dream')

      // -----------------------------------------------------------------------
      // Step 4: PreToolUse gates memory_review -> force_ask + __agyHostContext
      //         -> memory_review(accept) promotes to active + ownership='user'
      // -----------------------------------------------------------------------
      const reviewBaseArgs = { id: proposalId, action: 'accept' }
      const preToolRes = await runHookCli(
        hookBin,
        {
          hookEventName: 'PreToolUse',
          conversationId: 'conv-e2e-2',
          workspacePaths: [workspaceRoot],
          toolCall: {
            id: 'tc-review-1',
            name: 'dsh-memory_memory_review',
            args: reviewBaseArgs,
          },
        },
        hookEnv,
      )
      expect(preToolRes.exitCode, preToolRes.stderr).toBe(0)
      expect(preToolRes.json.decision).toBe('force_ask')
      expect(typeof preToolRes.json.reason).toBe('string')
      expect((preToolRes.json.reason as string).length).toBeGreaterThan(0)

      const overwrite = preToolRes.json.overwrite as Record<string, unknown>
      expect(overwrite).toBeDefined()
      const hostContext = overwrite[HOST_CONTEXT_ARG_KEY] as HostContextPayload
      expect(hostContext).toBeDefined()
      expect(hostContext.workspaceRoot).toBe(workspaceRoot)
      expect(hostContext.conversationId).toBe('conv-e2e-2')
      expect(await verifyHostContextNonce(dataDir, hostContext.nonce)).toBe(true)

      const reviewed = await client.callTool<MemoryRecord>(
        5,
        'memory_review',
        {
          ...reviewBaseArgs,
          ...overwrite,
        },
        () => mcpStderr,
      )
      expect(reviewed.id).toBe(proposalId)
      expect(reviewed.status).toBe('active')
      expect(reviewed.ownership).toBe('user')
      expect(reviewed.reviewedByUserAt).toBeTruthy()

      const pendingAfterReview = await client.callTool<{ items: MemoryRecord[] }>(
        6,
        'memory_list',
        { status: 'pending' },
        () => mcpStderr,
      )
      expect(pendingAfterReview.items.some((item) => item.id === proposalId)).toBe(false)

      // -----------------------------------------------------------------------
      // Step 5: memory_export -> lossless importMemories into DSH FakeDomainFacility
      // -----------------------------------------------------------------------
      const exported = await client.callTool<MemoryExport>(
        7,
        'memory_export',
        { includeArchived: true },
        () => mcpStderr,
      )
      expect(exported.format).toBe('dsh-memory')
      expect(exported.version).toBe(1)
      expect(exported.memories.length).toBeGreaterThanOrEqual(3)
      expect(exported.episodes.length).toBeGreaterThanOrEqual(1)
      expect(exported.memories.some((m) => m.id === proposalId && m.ownership === 'user')).toBe(
        true,
      )

      const dshFacility = new FakeDomainFacility()
      const dshHost = createFakeHost({ facility: dshFacility })
      const dshDomain = await dshHost.ctx.storageDomain.open(memoryDomain)
      dshDomainClose = () => dshDomain.close()
      const dshRunner = new OperationRunner(dshDomain)
      const dshStore = new MemoryStore(dshDomain, dshRunner)
      await dshStore.initialize()

      const importReport = await importMemories(dshStore, dshDomain, exported, {
        mapping: {
          [workspaceKey]: { key: workspaceKey, root: workspaceRoot },
        },
      })
      expect(importReport.created).toBe(exported.memories.length)
      expect(importReport.skipped).toBe(0)
      expect(importReport.unmapped).toEqual([])
      expect(importReport.errors).toEqual([])
      expect(importReport.episodesImported).toBe(exported.episodes.length)

      // Verify 100% lossless record content and metadata match in DSH store
      for (const source of exported.memories) {
        const imported = dshStore.get(source.id)
        expect(imported, `missing imported memory ${source.id}`).toBeDefined()
        expect(imported?.id).toBe(source.id)
        expect(imported?.type).toBe(source.type)
        expect(imported?.title).toBe(source.title)
        expect(imported?.body).toBe(source.body)
        expect(imported?.scope).toEqual(source.scope)
        expect(imported?.tags).toEqual(source.tags)
        expect(imported?.importance).toBe(source.importance)
        expect(imported?.confidence).toBe(source.confidence)
        expect(imported?.pinned).toBe(source.pinned)
        expect(imported?.status).toBe(source.status)
        expect(imported?.sourceRefs).toEqual(source.sourceRefs)
        expect(imported?.sourceEpisodeIds).toEqual(source.sourceEpisodeIds)
        expect(imported?.supersedes).toEqual(source.supersedes)
        expect(imported?.worklogKind).toBe(source.worklogKind)
        expect(imported?.proposalKey).toBe(source.proposalKey)
        expect(imported?.reviewedByUserAt).toBe(source.reviewedByUserAt)
        expect(imported?.expiresAt).toBe(source.expiresAt)
        expect(imported?.origin).toBe('import')
        expect(imported?.ownership).toBe('user')
      }

      // Verify imported episodes match source content and workspace metadata
      for (const sourceEp of exported.episodes) {
        const importedEp = dshDomain.table('episodes').get(sourceEp.id)
        expect(importedEp, `missing imported episode ${sourceEp.id}`).toBeDefined()
        expect(importedEp?.id).toBe(sourceEp.id)
        expect(importedEp?.kind).toBe(sourceEp.kind)
        expect(importedEp?.turn).toBe(sourceEp.turn)
        expect(importedEp?.workspaceKey).toBe(sourceEp.workspaceKey)
        expect(importedEp?.workspaceRoot).toBe(sourceEp.workspaceRoot)
        expect(importedEp?.files).toEqual(sourceEp.files)
        expect(importedEp?.prompt).toBe(sourceEp.prompt)
        expect(importedEp?.assistantFinal).toBe(sourceEp.assistantFinal)
        expect(importedEp?.outcome).toBe(sourceEp.outcome)
        expect(importedEp?.status).toBe(sourceEp.status === 'processing' ? 'new' : sourceEp.status)
      }

      // Verify zero non-JSON lines on MCP server stdout
      for (const line of client.stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }

      const exitCode = await stopChildProcess(mcpChild)
      expect(exitCode).toBe(0)
    } finally {
      client.dispose()
      await stopChildProcess(mcpChild)
      if (dshDomainClose !== undefined) {
        await dshDomainClose()
      }
    }
  }, 30_000)
})
