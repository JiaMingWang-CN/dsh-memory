/**
 * `memory_write` — create or update a memory from an explicit model decision.
 * @module dsh-memory/host/tools/write
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'

const MEMORY_TYPES = ['lesson', 'worklog', 'wiki', 'preference'] as const

/** Session id carried by the calling agent, when the runtime exposes one. */
function sessionIdOf(agent: unknown): string | undefined {
  const session = (agent as { session?: { id?: unknown } } | undefined)?.session
  return typeof session?.id === 'string' && session.id !== '' ? session.id : undefined
}

/**
 * Build the `memory_write` tool.
 * @param ctx - Host context (for the caller's workspace).
 * @param service - Memory service.
 * @returns A registry-ready tool definition.
 */
export function memoryWriteTool(ctx: Context, service: MemoryService): ToolDefinition {
  return defineTool({
    name: 'memory_write',
    description:
      'Create or update one long-term memory. Write only durable knowledge the environment cannot give back: reusable rules, verified approaches, pitfalls and stable user preferences. Do not write task progress, completed actions, code or file contents, current config values, git history or command output. Search first and update an existing memory (id + expectedContentRevision) instead of duplicating it; keep one topic per memory and a searchable title. Explicit writes are active immediately. Literal \\n sequences in title or body are normalized to real newlines when the text has no real newlines. Strong secrets (private keys, API keys, tokens) are refused; record where the credential is configured instead.',
    parameters: {
      id: { type: 'string', description: 'Existing memory id to update; omit to create.' },
      type: { type: 'string', required: true, enum: MEMORY_TYPES, description: 'Memory type.' },
      title: { type: 'string', required: true, description: 'Short title (1-200 characters).' },
      body: { type: 'string', required: true, description: 'Markdown body (1-65536 bytes).' },
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description: 'workspace (default) or global; global is allowed only for preferences.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      importance: { type: 'number', description: 'Importance in [0, 1].' },
      expectedContentRevision: {
        type: 'integer',
        description: 'Required when updating: the revision the caller last saw.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const workspace = await workspaceIdentityOf(ctx, exec.agent)
      const sessionId = sessionIdOf(exec.agent)
      const result = await service.write(
        {
          ...(args.id === undefined ? {} : { id: args.id }),
          type: args.type,
          title: args.title,
          body: args.body,
          ...(args.scope === undefined ? {} : { scope: args.scope }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          ...(args.expectedContentRevision === undefined
            ? {}
            : { expectedContentRevision: args.expectedContentRevision }),
          // A create records which session produced it; an update keeps the
          // record's existing source references instead of replacing them.
          ...(args.id === undefined && sessionId !== undefined
            ? { sourceRefs: [{ sessionId }] }
            : {}),
        },
        workspace,
        exec.callId,
      )
      return JSON.stringify({
        id: result.record.id,
        contentRevision: result.record.contentRevision,
        status: result.record.status,
        redactions: result.redactions,
        duplicate: result.duplicate ?? false,
      })
    },
  })
}
