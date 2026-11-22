import type { ToolDefinition, ToolRunContext, ToolsService } from '@deepseek-ai/dsh-tools'

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
 * Execute a tool and parse its JSON string output.
 * @param tools - Tool registry.
 * @param name - Registered tool name.
 * @param args - Tool arguments.
 * @param agentId - Calling agent id.
 * @returns The parsed JSON output.
 */
export async function runTool(
  tools: ToolsService,
  name: string,
  args: Record<string, unknown>,
  agentId = 'agent-a',
): Promise<any> {
  const text = await getTool(tools, name).execute(args, toolExec(name, agentId))
  return JSON.parse(text as string)
}
