/**
 * `memory_search` — BM25 search and priority listing over long-term memories.
 * @module dsh-memory/host/tools/search
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'
import { MEMORY_SCOPE_OUTPUT_SCHEMA, MEMORY_TYPES, renderJsonOutput } from './schemas.ts'

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
      'Search long-term memories by keywords, or omit query to list visible active memories in the selected scope ordered by priority (pinned, importance, updatedAt). Optionally filter by type and scope. Returns summaries; use memory_read for the full body.',
    parameters: {
      query: {
        type: 'string',
        description:
          'Search keywords. Omit or leave empty to list visible active memories without guessing keywords.',
      },
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
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', enum: MEMORY_TYPES, required: true },
                title: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                scope: { ...MEMORY_SCOPE_OUTPUT_SCHEMA, required: true },
                confidence: { type: 'number', required: true },
                updatedAt: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: renderJsonOutput,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = args.query?.trim() ?? ''
      const scope = args.scope ?? 'auto'
      const workspace = scope === 'global' ? null : await workspaceIdentityOf(ctx, exec.agent)
      if (scope === 'workspace' && workspace === null) {
        return { results: [], total: 0, truncated: false }
      }
      const filter = {
        workspaceKey: workspace?.key ?? null,
        scope,
        ...(args.type === undefined ? {} : { types: [args.type] }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }
      if (query.length === 0) {
        return service.browse(filter)
      }
      const result = service.search({
        query,
        ...filter,
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
      return {
        results: result.results,
        total: result.total,
        truncated: result.truncated,
      }
    },
  })
}
