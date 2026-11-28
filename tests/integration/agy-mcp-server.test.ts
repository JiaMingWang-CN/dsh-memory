import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AgyConfigStore } from '../../src/agy/config-store.ts'
import { StdioMcpServer } from '../../src/agy/mcp-protocol.ts'
import { startAgyMcpServer } from '../../src/agy/mcp-server.ts'
import { resolveAgyDataPaths } from '../../src/agy/paths.ts'
import { AgySessionStateStore } from '../../src/agy/session-state.ts'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import { createAgyTools } from '../../src/agy/tools.ts'
import { resolveCallContext } from '../../src/agy/workspace-resolver.ts'
import { MemoryEngine } from '../../src/core/engine.ts'

interface JsonRpcMessage {
  jsonrpc: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const tempDirs: string[] = []
const activeChildren: ChildProcessWithoutNullStreams[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-agy-mcp-'))
  tempDirs.push(dir)
  return dir
}

class JsonRpcTestClient {
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
        this.handleLine(line)
        idx = this.buffer.indexOf('\n')
      }
    })
  }

  get stdoutLines(): readonly string[] {
    return this.rawLines
  }

  sendRaw(raw: string): void {
    this.input.write(raw)
  }

  send(msg: Record<string, unknown>): void {
    this.input.write(`${JSON.stringify(msg)}\n`)
  }

  async request(
    id: string | number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 5000,
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

  waitFor(predicate: (msg: JsonRpcMessage) => boolean, timeoutMs = 5000): Promise<JsonRpcMessage> {
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

async function createInProcessServer(
  dataDir: string,
  options?: { maxLineBytes?: number; rootsTimeoutMs?: number },
): Promise<{
  server: StdioMcpServer
  clientToServer: PassThrough
  serverToClient: PassThrough
  stderrText: () => string
}> {
  const paths = resolveAgyDataPaths({ PLUGIN_DATA: dataDir })
  const configStore = new AgyConfigStore(paths.configPath)
  const sessionStore = new AgySessionStateStore(paths.sessionsDir)
  const config = await configStore.load()
  const engineHolder: { current?: MemoryEngine } = {}
  const domain = await FileMemoryDomain.open({
    storePath: paths.storePath,
    lockPath: paths.lockPath,
    backupsDir: paths.backupsDir,
    onReload: () => {
      engineHolder.current?.syncSearchIndex()
    },
  })
  const engine = new MemoryEngine({ domain, config })
  engineHolder.current = engine
  await domain.withWriteLock(async () => {
    await engine.recover()
  })
  const tools = createAgyTools({
    domain,
    engine,
    configStore,
    sessionStore,
    dataDir: paths.dataDir,
  })

  const clientToServer = new PassThrough()
  const serverToClient = new PassThrough()
  const stderrStream = new PassThrough()
  let stderrOutput = ''
  stderrStream.on('data', (chunk) => {
    stderrOutput += String(chunk)
  })

  const server = new StdioMcpServer({
    serverInfo: { name: 'memloom', version: '0.2.3' },
    tools,
    resolveContext: (args, listRoots) =>
      resolveCallContext({
        args,
        dataDir: paths.dataDir,
        sessionStore,
        ...(listRoots === undefined ? {} : { listRoots }),
      }),
    input: clientToServer,
    output: serverToClient,
    stderr: stderrStream,
    ...(options?.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    ...(options?.rootsTimeoutMs === undefined ? {} : { rootsTimeoutMs: options.rootsTimeoutMs }),
  })
  server.start()

  return {
    server,
    clientToServer,
    serverToClient,
    stderrText: () => stderrOutput,
  }
}

afterEach(async () => {
  while (activeChildren.length > 0) {
    const child = activeChildren.pop()!
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('StdioMcpServer (PassThrough streams)', () => {
  it('handles initialize, notifications/initialized, ping, tools/list, reverse roots/list, CRUD, and error resilience', async () => {
    const dir = makeTempDir()
    const { server, clientToServer, serverToClient } = await createInProcessServer(dir)
    const rootsRequests: JsonRpcMessage[] = []

    const client = new JsonRpcTestClient(clientToServer, serverToClient, (req) => {
      if (req.method === 'roots/list') {
        rootsRequests.push(req)
        client.send({
          jsonrpc: '2.0',
          id: req.id,
          result: { roots: [{ uri: 'file:///c:/ws/demo', name: 'demo' }] },
        })
      }
    })

    try {
      // 1. initialize
      const initRes = await client.request(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: { roots: {} },
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })
      expect(initRes.error).toBeUndefined()
      expect(initRes.result).toEqual({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'memloom', version: '0.2.3' },
      })

      // 2. notifications/initialized + ping
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const pingRes = await client.request(2, 'ping')
      expect(pingRes.error).toBeUndefined()
      expect(pingRes.result).toEqual({})

      // 3. tools/list -> 20 tools
      const listRes = await client.request(3, 'tools/list')
      const listedTools = (
        listRes.result as {
          tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
        }
      ).tools
      expect(listedTools).toHaveLength(20)
      const toolNames = listedTools.map((tool) => tool.name)
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'memory_search',
          'memory_write',
          'memory_dream_prepare',
          'memory_review',
          'memory_config',
        ]),
      )

      // 4. tools/call memory_write -> reverse roots/list -> memory_search -> memory_read
      const writeRes = await client.request(4, 'tools/call', {
        name: 'memory_write',
        arguments: {
          type: 'lesson',
          scope: 'workspace',
          title: 'Use pnpm in demo workspace',
          body: 'Always run pnpm test before pushing changes.',
          tags: ['tooling'],
        },
      })
      expect(rootsRequests.length).toBeGreaterThanOrEqual(1)
      const writeResult = writeRes.result as {
        content: Array<{ type: string; text: string }>
        isError?: boolean
      }
      expect(writeResult.isError).toBeUndefined()
      const written = JSON.parse(writeResult.content[0]!.text) as {
        id: string
        scope: { kind: string; key?: string }
      }
      expect(written.id).toBeTruthy()
      expect(written.scope).toMatchObject({ kind: 'workspace', key: 'c:/ws/demo' })

      const searchRes = await client.request(5, 'tools/call', {
        name: 'memory_search',
        arguments: { query: 'pnpm demo workspace' },
      })
      const searchPayload = JSON.parse(
        (searchRes.result as { content: Array<{ type: string; text: string }> }).content[0]!.text,
      ) as { results: Array<{ id: string; title: string }> }
      expect(searchPayload.results.some((hit) => hit.id === written.id)).toBe(true)

      const readRes = await client.request(6, 'tools/call', {
        name: 'memory_read',
        arguments: { id: written.id },
      })
      const readPayload = JSON.parse(
        (readRes.result as { content: Array<{ type: string; text: string }> }).content[0]!.text,
      ) as { id: string; body: string }
      expect(readPayload.id).toBe(written.id)
      expect(readPayload.body).toBe('Always run pnpm test before pushing changes.')

      // 5. Invalid tool name & strong secret error -> isError: true, server stays alive
      const badToolRes = await client.request(7, 'tools/call', {
        name: 'memory_does_not_exist',
        arguments: {},
      })
      const badToolResult = badToolRes.result as {
        content: Array<{ type: string; text: string }>
        isError?: boolean
      }
      expect(badToolResult.isError).toBe(true)
      const badToolError = JSON.parse(badToolResult.content[0]!.text) as {
        error: { code: string; message: string }
      }
      expect(badToolError.error.code).toBeTruthy()
      expect(badToolError.error.message).toMatch(/memory_does_not_exist/i)

      const secretRes = await client.request(8, 'tools/call', {
        name: 'memory_write',
        arguments: {
          type: 'lesson',
          scope: 'workspace',
          title: 'Deploy key',
          body: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----',
        },
      })
      const secretResult = secretRes.result as {
        content: Array<{ type: string; text: string }>
        isError?: boolean
      }
      expect(secretResult.isError).toBe(true)
      const secretError = JSON.parse(secretResult.content[0]!.text) as {
        error: { code: string; message: string }
      }
      expect(secretError.error.code).toBe('MEMORY_INVALID_CONTENT')

      // Malformed JSON and unknown method do not crash the server
      client.sendRaw('{not valid json\n')
      const parseErr = await client.waitFor((msg) => msg.error?.code === -32700)
      expect(parseErr.error?.code).toBe(-32700)

      const pingAfterErrors = await client.request(9, 'ping')
      expect(pingAfterErrors.result).toEqual({})

      // Verify zero non-JSON lines appeared on stdout
      for (const line of client.stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    } finally {
      await server.stop()
    }
  })

  it('rejects oversized lines with -32700 and skips roots/list when client lacks roots capability', async () => {
    const dir = makeTempDir()
    const { server, clientToServer, serverToClient } = await createInProcessServer(dir, {
      maxLineBytes: 512,
    })
    let rootsCalled = false
    const client = new JsonRpcTestClient(clientToServer, serverToClient, (req) => {
      if (req.method === 'roots/list') rootsCalled = true
    })

    try {
      await client.request(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
      })

      // Oversized frame returns -32700 without killing server
      client.sendRaw(`${'x'.repeat(700)}\n`)
      const oversizedErr = await client.waitFor((msg) => msg.error?.code === -32700)
      expect(oversizedErr.error?.code).toBe(-32700)

      // Workspace write without roots capability fails with MEMORY_FORBIDDEN_SCOPE and never sends roots/list
      const wsWrite = await client.request(2, 'tools/call', {
        name: 'memory_write',
        arguments: {
          type: 'lesson',
          scope: 'workspace',
          title: 'No workspace',
          body: 'Should fail without workspace context.',
        },
      })
      expect(rootsCalled).toBe(false)
      const wsResult = wsWrite.result as {
        content: Array<{ type: string; text: string }>
        isError?: boolean
      }
      expect(wsResult.isError).toBe(true)
      const errObj = JSON.parse(wsResult.content[0]!.text) as { error: { code: string } }
      expect(errObj.error.code).toBe('MEMORY_FORBIDDEN_SCOPE')

      const stillAlive = await client.request(3, 'ping')
      expect(stillAlive.result).toEqual({})
    } finally {
      await server.stop()
    }
  })

  it('falls back cleanly when reverse roots/list times out and supports startAgyMcpServer handle stop', async () => {
    const dir = makeTempDir()
    const { server, clientToServer, serverToClient } = await createInProcessServer(dir, {
      rootsTimeoutMs: 60,
    })
    const client = new JsonRpcTestClient(clientToServer, serverToClient)

    try {
      await client.request(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: { roots: {} },
      })

      // Client intentionally never replies to roots/list; global preference write still succeeds
      const prefRes = await client.request(2, 'tools/call', {
        name: 'memory_write',
        arguments: {
          type: 'preference',
          scope: 'global',
          title: 'Prefer concise diffs',
          body: 'Keep diffs minimal and focused.',
        },
      })
      const prefResult = prefRes.result as {
        content: Array<{ type: string; text: string }>
        isError?: boolean
      }
      expect(prefResult.isError).toBeUndefined()
      const parsed = JSON.parse(prefResult.content[0]!.text) as { scope: { kind: string } }
      expect(parsed.scope.kind).toBe('global')
    } finally {
      await server.stop()
    }

    // Verify startAgyMcpServer can also be instantiated programmatically and stopped cleanly
    const dir2 = makeTempDir()
    const handle = await startAgyMcpServer(
      { ...process.env, PLUGIN_DATA: dir2 },
      {
        input: new PassThrough(),
        output: new PassThrough(),
        stderr: new PassThrough(),
      },
    )
    await handle.stop()
  })
})

describe('AGY MCP Server real Node child process', () => {
  it('completes full stdio handshake, 20-tool listing, reverse roots/list CRUD, and error recovery in a spawned process', async () => {
    const dir = makeTempDir()
    const entryPath = join(process.cwd(), 'src/agy/mcp-server.ts')
    const child = spawn(process.execPath, [entryPath], {
      env: {
        ...process.env,
        PLUGIN_DATA: dir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    activeChildren.push(child)

    let stderrLog = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrLog += chunk
    })

    const rootsSeen: JsonRpcMessage[] = []
    const client = new JsonRpcTestClient(child.stdin, child.stdout, (req) => {
      if (req.method === 'roots/list') {
        rootsSeen.push(req)
        client.send({
          jsonrpc: '2.0',
          id: req.id,
          result: { roots: [{ uri: 'file:///c:/ws/demo' }] },
        })
      }
    })

    // 1. initialize
    const initRes = await client.request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: { roots: {} },
    })
    expect(initRes.error, stderrLog).toBeUndefined()
    const initPayload = initRes.result as {
      protocolVersion: string
      serverInfo: { name: string; version: string }
      capabilities: { tools?: Record<string, unknown> }
    }
    expect(initPayload.protocolVersion).toBe('2025-03-26')
    expect(initPayload.serverInfo.name).toBe('memloom')
    expect(initPayload.capabilities.tools).toEqual({})

    // 2. notifications/initialized + ping
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const pingRes = await client.request(2, 'ping')
    expect(pingRes.result).toEqual({})

    // 3. tools/list -> 20 tools
    const listRes = await client.request(3, 'tools/list')
    const tools = (listRes.result as { tools: Array<{ name: string }> }).tools
    expect(tools).toHaveLength(20)
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'memory_search',
        'memory_write',
        'memory_dream_prepare',
        'memory_review',
        'memory_config',
      ]),
    )

    // 4. tools/call memory_write (workspace) -> reverse roots/list -> search -> read
    const writeRes = await client.request(4, 'tools/call', {
      name: 'memory_write',
      arguments: {
        type: 'lesson',
        scope: 'workspace',
        title: 'Child process stdio note',
        body: 'Verified over real Node child process stdio.',
      },
    })
    expect(rootsSeen.length).toBeGreaterThanOrEqual(1)
    const writeText = (writeRes.result as { content: Array<{ text: string }> }).content[0]!.text
    const written = JSON.parse(writeText) as { id: string; scope: { kind: string; key?: string } }
    expect(written.scope).toMatchObject({ kind: 'workspace', key: 'c:/ws/demo' })

    const searchRes = await client.request(5, 'tools/call', {
      name: 'memory_search',
      arguments: { query: 'Child process stdio note' },
    })
    const searchData = JSON.parse(
      (searchRes.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { results: Array<{ id: string }> }
    expect(searchData.results.some((hit) => hit.id === written.id)).toBe(true)

    const readRes = await client.request(6, 'tools/call', {
      name: 'memory_read',
      arguments: { id: written.id },
    })
    const readData = JSON.parse(
      (readRes.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { id: string; body: string }
    expect(readData.body).toBe('Verified over real Node child process stdio.')

    // 5. Invalid tool name & strong-secret OperationError -> isError: true, process stays alive
    const invalidToolRes = await client.request(7, 'tools/call', {
      name: 'nonexistent_tool',
      arguments: {},
    })
    expect((invalidToolRes.result as { isError?: boolean }).isError).toBe(true)

    const secretRes = await client.request(8, 'tools/call', {
      name: 'memory_write',
      arguments: {
        type: 'lesson',
        scope: 'workspace',
        title: 'Secret leak attempt',
        body: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      },
    })
    const secretResult = secretRes.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(secretResult.isError).toBe(true)
    const secretErr = JSON.parse(secretResult.content[0]!.text) as {
      error: { code: string }
    }
    expect(secretErr.error.code).toBe('MEMORY_INVALID_CONTENT')

    // Process still responds to ping and stdout contains zero non-JSON-RPC noise
    const finalPing = await client.request(9, 'ping')
    expect(finalPing.result).toEqual({})
    expect(child.exitCode).toBeNull()
    for (const line of client.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    // Graceful shutdown when stdin ends
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
    })
    child.stdin.end()
    const exitCode = await exited
    expect(exitCode).toBe(0)
  }, 20_000)
})
