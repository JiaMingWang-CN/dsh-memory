/**
 * Zero-dependency newline-delimited JSON-RPC 2.0 Stdio MCP server protocol layer.
 *
 * Writes exclusively JSON-RPC 2.0 messages to `output` (stdout); all diagnostics
 * go strictly to `stderr`. Supports `initialize`, `notifications/initialized`,
 * `ping`, `tools/list`, `tools/call`, and bidirectional server-to-client
 * `roots/list` requests with timeout fallback.
 * @module dsh-memory/agy/mcp-protocol
 */
import { OperationError } from '../core/operations.ts'
import type { AgyToolDefinition } from './tools.ts'
import type { ResolvedCallContext } from './workspace-resolver.ts'

const DEFAULT_PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
const DEFAULT_ROOTS_TIMEOUT_MS = 2000

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603

/** Identifying metadata returned during the MCP `initialize` handshake. */
export interface McpServerInfo {
  readonly name: string
  readonly version: string
}

/** Configuration options for {@link StdioMcpServer}. */
export interface StdioMcpServerOptions {
  serverInfo: McpServerInfo
  tools: readonly AgyToolDefinition[]
  resolveContext: (
    args: Record<string, unknown>,
    listRoots?: () => Promise<readonly string[]>,
  ) => Promise<ResolvedCallContext>
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  maxLineBytes?: number
  rootsTimeoutMs?: number
}

type JsonRpcId = string | number | null

interface PendingServerRequest {
  resolve: (response: { result?: unknown; error?: unknown }) => void
  timer: NodeJS.Timeout
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function formatToolError(
  code: string,
  message: string,
): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
    isError: true,
  }
}

/**
 * Newline-delimited JSON-RPC 2.0 MCP server operating over arbitrary stdio streams.
 */
export class StdioMcpServer {
  private readonly serverInfo: McpServerInfo
  private readonly tools: readonly AgyToolDefinition[]
  private readonly toolsByName: ReadonlyMap<string, AgyToolDefinition>
  private readonly resolveContext: StdioMcpServerOptions['resolveContext']
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream
  private readonly stderr: NodeJS.WritableStream
  private readonly maxLineBytes: number
  private readonly rootsTimeoutMs: number

  private started = false
  private stopped = false
  private clientSupportsRoots = false
  private serverRequestSeq = 0
  private lineBuffer: Buffer = Buffer.alloc(0)
  private discardingOversized = false

  private readonly pendingRequests = new Map<string | number, PendingServerRequest>()
  private readonly inFlight = new Set<Promise<void>>()

  private readonly onDataBound: (chunk: Buffer | string) => void
  private readonly onEndBound: () => void
  private readonly onInputErrorBound: (err: Error) => void

  constructor(options: StdioMcpServerOptions) {
    this.serverInfo = options.serverInfo
    this.tools = options.tools
    this.toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]))
    this.resolveContext = options.resolveContext
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.rootsTimeoutMs = options.rootsTimeoutMs ?? DEFAULT_ROOTS_TIMEOUT_MS

    this.onDataBound = (chunk) => this.handleData(chunk)
    this.onEndBound = () => this.handleEnd()
    this.onInputErrorBound = (err) => {
      this.logDiagnostic(`input stream error: ${err.message}`)
    }
  }

  /** Begin reading JSON-RPC 2.0 frames from `input`. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.input.on('data', this.onDataBound)
    this.input.on('end', this.onEndBound)
    this.input.on('error', this.onInputErrorBound)
    if (typeof this.input.resume === 'function') {
      this.input.resume()
    }
  }

  /** Detach listeners, cancel pending server-to-client requests, and drain in-flight calls. */
  async stop(): Promise<void> {
    if (this.stopped) {
      await Promise.allSettled([...this.inFlight])
      return
    }
    this.stopped = true

    if (this.started) {
      this.input.off('data', this.onDataBound)
      this.input.off('end', this.onEndBound)
      this.input.off('error', this.onInputErrorBound)
      this.started = false
    }

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer)
      this.pendingRequests.delete(id)
      pending.resolve({ error: { message: 'server stopped' } })
    }

    await Promise.allSettled([...this.inFlight])
  }

  private logDiagnostic(message: string): void {
    try {
      this.stderr.write(`[dsh-memory] ${message}\n`)
    } catch {
      // Never crash on diagnostic stream errors.
    }
  }

  private writeMessage(payload: Record<string, unknown>): boolean {
    if (this.stopped) return false
    try {
      this.output.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch (err) {
      this.logDiagnostic(
        `failed to write JSON-RPC frame: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  private writeResult(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id, result })
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })
  }

  private handleData(chunk: Buffer | string): void {
    let remaining = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk

    while (remaining.length > 0) {
      const newlineIndex = remaining.indexOf(0x0a)

      if (this.discardingOversized) {
        if (newlineIndex === -1) {
          return
        }
        this.discardingOversized = false
        this.writeError(null, JSONRPC_PARSE_ERROR, 'Parse error: line exceeds maximum allowed size')
        remaining = remaining.subarray(newlineIndex + 1)
        continue
      }

      if (newlineIndex === -1) {
        const nextLength = this.lineBuffer.length + remaining.length
        if (nextLength > this.maxLineBytes) {
          this.lineBuffer = Buffer.alloc(0)
          this.discardingOversized = true
          return
        }
        this.lineBuffer =
          this.lineBuffer.length === 0 ? remaining : Buffer.concat([this.lineBuffer, remaining])
        return
      }

      const segment = remaining.subarray(0, newlineIndex)
      remaining = remaining.subarray(newlineIndex + 1)

      const totalLength = this.lineBuffer.length + segment.length
      if (totalLength > this.maxLineBytes) {
        this.lineBuffer = Buffer.alloc(0)
        this.writeError(null, JSONRPC_PARSE_ERROR, 'Parse error: line exceeds maximum allowed size')
        continue
      }

      let rawLine =
        this.lineBuffer.length === 0 ? segment : Buffer.concat([this.lineBuffer, segment])
      this.lineBuffer = Buffer.alloc(0)

      if (rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d) {
        rawLine = rawLine.subarray(0, rawLine.length - 1)
      }

      const text = rawLine.toString('utf8').trim()
      if (text.length > 0) {
        this.dispatchLine(text)
      }
    }
  }

  private handleEnd(): void {
    if (this.discardingOversized) {
      this.discardingOversized = false
      this.writeError(null, JSONRPC_PARSE_ERROR, 'Parse error: line exceeds maximum allowed size')
      return
    }
    if (this.lineBuffer.length > 0) {
      let rawLine = this.lineBuffer
      this.lineBuffer = Buffer.alloc(0)
      if (rawLine[rawLine.length - 1] === 0x0d) {
        rawLine = rawLine.subarray(0, rawLine.length - 1)
      }
      const text = rawLine.toString('utf8').trim()
      if (text.length > 0) {
        this.dispatchLine(text)
      }
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      this.writeError(
        null,
        JSONRPC_PARSE_ERROR,
        `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    if (!isPlainObject(parsed)) {
      this.writeError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request: expected JSON object')
      return
    }

    // Handle JSON-RPC responses to server-initiated requests (e.g. roots/list)
    const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id') && parsed.id !== undefined
    const hasMethod = typeof parsed.method === 'string'
    if (hasId && !hasMethod && ('result' in parsed || 'error' in parsed)) {
      this.handleClientResponse(parsed)
      return
    }

    if (parsed.jsonrpc !== '2.0' || !hasMethod) {
      const responseId: JsonRpcId = hasId && isValidJsonRpcId(parsed.id) ? parsed.id : null
      this.writeError(
        responseId,
        JSONRPC_INVALID_REQUEST,
        'Invalid Request: missing jsonrpc "2.0" or method',
      )
      return
    }

    if (hasId && !isValidJsonRpcId(parsed.id)) {
      this.writeError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request: invalid id type')
      return
    }

    const requestId = hasId ? (parsed.id as JsonRpcId) : undefined
    const method = parsed.method as string
    const params = parsed.params

    const task = this.handleRequest(requestId, method, params).catch((err) => {
      this.logDiagnostic(
        `unhandled error for ${method}: ${err instanceof Error ? err.message : String(err)}`,
      )
      if (requestId !== undefined) {
        this.writeError(
          requestId,
          JSONRPC_INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    this.inFlight.add(task)
    void task.finally(() => {
      this.inFlight.delete(task)
    })
  }

  private handleClientResponse(msg: Record<string, unknown>): void {
    const id = msg.id
    if (typeof id !== 'string' && typeof id !== 'number') return
    const pending = this.pendingRequests.get(id)
    if (pending === undefined) return

    clearTimeout(pending.timer)
    this.pendingRequests.delete(id)
    if ('error' in msg && msg.error !== undefined) {
      pending.resolve({ error: msg.error })
    } else {
      pending.resolve({ result: msg.result })
    }
  }

  private async handleRequest(
    id: JsonRpcId | undefined,
    method: string,
    params: unknown,
  ): Promise<void> {
    switch (method) {
      case 'initialize': {
        const initParams = isPlainObject(params) ? params : {}
        const requestedVersion =
          typeof initParams.protocolVersion === 'string' &&
          initParams.protocolVersion.trim().length > 0
            ? initParams.protocolVersion.trim()
            : DEFAULT_PROTOCOL_VERSION
        const capabilities = isPlainObject(initParams.capabilities) ? initParams.capabilities : {}
        this.clientSupportsRoots = isPlainObject(capabilities.roots)

        if (id !== undefined) {
          this.writeResult(id, {
            protocolVersion: requestedVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: this.serverInfo.name,
              version: this.serverInfo.version,
            },
          })
        }
        return
      }

      case 'notifications/initialized': {
        // Notification — intentionally no response.
        return
      }

      case 'ping': {
        if (id !== undefined) {
          this.writeResult(id, {})
        }
        return
      }

      case 'tools/list': {
        if (id !== undefined) {
          this.writeResult(id, {
            tools: this.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          })
        }
        return
      }

      case 'tools/call': {
        if (id === undefined) return
        if (!isPlainObject(params) || typeof params.name !== 'string') {
          this.writeError(id, JSONRPC_INVALID_PARAMS, 'Invalid params: expected { name: string }')
          return
        }

        const tool = this.toolsByName.get(params.name)
        if (tool === undefined) {
          this.writeResult(id, formatToolError('UNKNOWN_TOOL', `Unknown tool: ${params.name}`))
          return
        }

        const rawArguments = params.arguments === undefined ? {} : params.arguments
        if (!isPlainObject(rawArguments)) {
          this.writeResult(
            id,
            formatToolError('MEMORY_INVALID_QUERY', 'tool arguments must be a JSON object'),
          )
          return
        }

        try {
          const ctx = this.clientSupportsRoots
            ? await this.resolveContext(rawArguments, () => this.requestClientRoots())
            : await this.resolveContext(rawArguments)
          const result = await tool.execute(rawArguments, ctx)
          this.writeResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          })
        } catch (err) {
          const code = err instanceof OperationError ? err.code : 'INTERNAL_ERROR'
          const message = err instanceof Error ? err.message : String(err)
          this.writeResult(id, formatToolError(code, message))
        }
        return
      }

      default: {
        // JSON-RPC 2.0 notifications (including notifications/*) never receive error responses.
        if (id === undefined) return
        this.writeError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
      }
    }
  }

  private async requestClientRoots(): Promise<readonly string[]> {
    if (!this.clientSupportsRoots || this.stopped) {
      return []
    }

    const requestId = `srv-${(this.serverRequestSeq += 1)}`

    const response = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        resolve({ error: { message: 'roots/list timed out' } })
      }, this.rootsTimeoutMs)
      timer.unref?.()

      this.pendingRequests.set(requestId, { resolve, timer })

      const sent = this.writeMessage({
        jsonrpc: '2.0',
        id: requestId,
        method: 'roots/list',
        params: {},
      })
      if (!sent) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        resolve({ error: { message: 'failed to send roots/list' } })
      }
    })

    if (response.error !== undefined || !isPlainObject(response.result)) {
      return []
    }

    const roots = response.result.roots
    if (!Array.isArray(roots)) {
      return []
    }

    const uris: string[] = []
    for (const entry of roots) {
      if (isPlainObject(entry) && typeof entry.uri === 'string') {
        const trimmed = entry.uri.trim()
        if (trimmed.length > 0) {
          uris.push(trimmed)
        }
      }
    }
    return uris
  }
}
