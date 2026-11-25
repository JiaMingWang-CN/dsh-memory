/**
 * `memory_forget` — soft-forget a memory (archive only).
 *
 * The model tool never deletes permanently: the schema exposes no confirmation
 * parameters and any forged `permanent` / `confirm` argument is rejected before
 * execution. Permanent deletion is reserved for the confirmed user management
 * surface added by a later plan.
 * @module memloom/host/tools/forget
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { OperationError } from '../operations.ts'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'
import { MEMORY_STATUSES, renderJsonOutput } from './schemas.ts'

/**
 * Build the `memory_forget` tool.
 * @param ctx - Host context (for the caller's workspace).
 * @param service - Memory service.
 * @returns A registry-ready tool definition.
 */
export function memoryForgetTool(ctx: Context, service: MemoryService): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description:
      'Soft-forget one memory by archiving it. The record is retained for recovery from the management surface; this tool cannot permanently delete anything.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id to archive.' },
      reason: { type: 'string', description: 'Optional reason recorded for the audit trail.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', enum: MEMORY_STATUSES, required: true },
          contentRevision: { type: 'integer', required: true },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
        additionalProperties: false,
      },
      render: renderJsonOutput,
    },
    async execute(args, exec) {
      const forged = args as Record<string, unknown>
      if ('permanent' in forged || 'confirm' in forged) {
        throw new OperationError(
          'MEMORY_FORBIDDEN',
          'permanent deletion is not available to model tools',
        )
      }
      const workspace = await workspaceIdentityOf(ctx, exec.agent)
      const archived = await service.forget(
        args.id,
        workspace?.key ?? null,
        args.reason,
        exec.callId,
      )
      return {
        id: archived.id,
        status: archived.status,
        contentRevision: archived.contentRevision,
        reason: args.reason ?? null,
      }
    },
  })
}
