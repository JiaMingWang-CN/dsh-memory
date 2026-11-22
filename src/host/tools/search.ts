/**
 * `memory_search` — BM25 search over long-term memories.
 * @module dsh-memory/host/tools/search
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { OperationError } from '../operations.ts'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'

const MEMORY_TYPES = ['lesson', 'worklog', 'wiki', 'preference'] as const

/**
 * Build the `memory_search` tool.
 * @param ctx - Host context (for the caller's workspace).
 * @param service - Memory service.
 * @returns A registry-ready tool definition.
 */
export function memorySearchTool(ctx: Context, service: MemoryService): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description:
      'Search long-term memories by keywords, optionally filtered by type and scope. Returns ranked summaries; use memory_read for the full body.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords.' },
      type: { type: 'string', enum: MEMORY_TYPES, description: 'Restrict results to one type.' },
      scope: {
        type: 'string',
        enum: ['auto', 'workspace', 'global'],
        description:
          'auto: current workspace + global (default); workspace: current workspace only; global: global preferences only.',
      },
      limit: { type: 'integer', description: 'Maximum number of hits (1-50, default 20).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const query = args.query.trim()
      if (query.length === 0) {
        throw new OperationError('MEMORY_INVALID_QUERY', 'query must not be empty')
      }
      const scope = args.scope ?? 'auto'
      const workspace = scope === 'global' ? null : await workspaceIdentityOf(ctx, exec.agent)
      if (scope === 'workspace' && workspace === null) {
        return JSON.stringify({ results: [], total: 0, truncated: false })
      }
      const result = service.search({
        query,
        workspaceKey: workspace?.key ?? null,
        scope,
        ...(args.type === undefined ? {} : { types: [args.type] }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      // Search hits touch match statistics only; failures are diagnostic and
      // must never block the result or fail the tool call.
      for (const hit of result.results) {
        void service.recordMatch(hit.id).catch((error: unknown) => {
          console.warn(
            '[dsh-memory] failed to record search statistics',
            hit.id,
            error instanceof Error ? error.message : String(error),
          )
        })
      }
      return JSON.stringify({
        results: result.results,
        total: result.total,
        truncated: result.truncated,
      })
    },
  })
}
