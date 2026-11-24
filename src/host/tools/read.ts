/**
 * `memory_read` — read a full memory body and count the use.
 * @module dsh-memory/host/tools/read
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'
import {
  MEMORY_SCOPE_OUTPUT_SCHEMA,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  renderJsonOutput,
} from './schemas.ts'

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
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          type: { type: 'string', enum: MEMORY_TYPES, required: true },
          title: { type: 'string', required: true },
          body: { type: 'string', required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
          scope: { ...MEMORY_SCOPE_OUTPUT_SCHEMA, required: true },
          sourceRefs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string', required: true },
                eventSeq: { type: 'integer' },
                turn: { type: 'integer' },
                quote: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          status: { type: 'string', enum: MEMORY_STATUSES, required: true },
          confidence: { type: 'number', required: true },
          updatedAt: { type: 'string', required: true },
          contentRevision: { type: 'integer', required: true },
          matchCount: { type: 'integer', required: true },
          useCount: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: renderJsonOutput,
    },
    isConcurrencySafe: () => true,
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
      return {
        id: record.id,
        type: record.type,
        title: record.title,
        body: record.body,
        tags: record.tags,
        scope: record.scope,
        sourceRefs: record.sourceRefs.map((ref) => ({
          sessionId: ref.sessionId,
          ...(ref.eventSeq === undefined ? {} : { eventSeq: ref.eventSeq }),
          ...(ref.turn === undefined ? {} : { turn: ref.turn }),
          ...(ref.quote === undefined ? {} : { quote: ref.quote }),
        })),
        status: record.status,
        confidence: record.confidence,
        updatedAt: record.updatedAt,
        contentRevision: record.contentRevision,
        matchCount: record.matchCount,
        useCount: record.useCount,
      }
    },
  })
}
