import {
  validateJsonSchemaValue,
  type ToolDefinition,
  type ToolRunContext,
  type ToolsService,
} from '@deepseek-ai/dsh-tools'

/**
 * Look up a registered tool or fail loudly.
 * @param tools - Tool registry.
 * @param name - Registered tool name.
 * @returns The tool definition.
 */
export function getTool(tools: ToolsService, name: string): ToolDefinition {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
  return definition
}

/** Monotonic per-call identity so request dedupe does not merge unrelated calls. */
let nextCall = 0

/**
 * Build a minimal {@link ToolRunContext} carrying one calling agent.
 * @param name - Tool name.
 * @param agentId - Calling agent id.
 * @param sessionId - Optional session id the agent is running.
 * @param callId - Optional explicit call id (a retry reuses its original id).
 * @returns A tool execution context.
 */
export function toolExec(
  name: string,
  agentId: string,
  sessionId?: string,
  callId?: string,
): ToolRunContext {
  const id = callId ?? `call-${(nextCall += 1)}`
  return {
    callId: id,
    rootCallId: id,
    name,
    arguments: {},
    signal: new AbortController().signal,
    agent: {
      id: agentId,
      ...(sessionId === undefined ? {} : { session: { id: sessionId } }),
    },
    token: Symbol('tool-execution-token'),
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
}

/**
 * Execute a tool, validate its structured output against `output.schema`, and
 * verify that `output.render` emits valid JSON text.
 * @param tools - Tool registry.
 * @param name - Registered tool name.
 * @param args - Tool arguments.
 * @param agentId - Calling agent id.
 * @returns The structured output object.
 */
export async function runTool(
  tools: ToolsService,
  name: string,
  args: Record<string, unknown>,
  agentId = 'agent-a',
): Promise<any> {
  const tool = getTool(tools, name)
  const value = await tool.execute(args, toolExec(name, agentId))
  const violations = validateJsonSchemaValue(tool.output.schema, value)
  if (violations.length > 0) {
    throw new Error(`tool "${name}" output failed schema validation: ${violations.join('; ')}`)
  }
  const rendered = tool.output.render(args, value as Parameters<typeof tool.output.render>[1])
  if (rendered.length !== 1 || rendered[0]?.type !== 'text') {
    throw new Error(`tool "${name}" render() must return a single text block`)
  }
  JSON.parse((rendered[0] as { text: string }).text)
  return value
}
