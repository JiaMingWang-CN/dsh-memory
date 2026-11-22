/**
 * `memory_read` — read a full memory body and count the use.
 * @module dsh-memory/host/tools/read
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'

/**
 * Build the `memory_read` tool.
 * @param ctx - Host context (for the caller's workspace).
 * @param service - Memory service.
 * @returns A registry-ready tool definition.
 */
export function memoryReadTool(ctx: Context, service: MemoryService): ToolDefinition {
  return defineTool({
    name: 'memory_read',
    description:
      'Read one recallable (active, unexpired) memory in full, including body, tags, source references and statistics. Reading counts as a use; searching does not.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id from a search result.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const workspace = await workspaceIdentityOf(ctx, exec.agent)
      const record = service.readForModel(args.id, workspace?.key ?? null)
      void service.recordUse(record.id).catch((error: unknown) => {
        console.warn(
          '[dsh-memory] failed to record read statistics',
          record.id,
          error instanceof Error ? error.message : String(error),
        )
      })
      return JSON.stringify({
        id: record.id,
        type: record.type,
        title: record.title,
        body: record.body,
        tags: record.tags,
        scope: record.scope,
        sourceRefs: record.sourceRefs,
        status: record.status,
        confidence: record.confidence,
        updatedAt: record.updatedAt,
        contentRevision: record.contentRevision,
        matchCount: record.matchCount,
        useCount: record.useCount,
      })
    },
  })
}
