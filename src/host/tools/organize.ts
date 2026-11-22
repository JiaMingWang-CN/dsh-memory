/**
 * `memory_organize` — queue a full-store consolidation pass over active memories.
 * @module dsh-memory/host/tools/organize
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'

/**
 * Build the `memory_organize` tool.
 * @param ctx - Host context (for the caller's workspace).
 * @param service - Memory service.
 * @returns A registry-ready tool definition.
 */
export function memoryOrganizeTool(ctx: Context, service: MemoryService): ToolDefinition {
  return defineTool({
    name: 'memory_organize',
    description:
      'Queue a manual consolidation run over existing active memories. The model proposes merges and replacements (each superseding the old memory ids) as pending proposals that still need review. Returns the dream id immediately; the run continues in the background.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description:
          'workspace (default) consolidates the current workspace; global consolidates global preferences.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const scope = args.scope ?? 'workspace'
      const workspace = scope === 'global' ? null : await workspaceIdentityOf(ctx, exec.agent)
      if (scope === 'workspace' && workspace === null) {
        return JSON.stringify({ dreamId: null, status: 'error', reason: 'no working directory' })
      }
      const dream = await service.enqueueDream({
        scope,
        workspace,
        trigger: 'organize',
        agent: exec.agent,
      })
      return JSON.stringify({ dreamId: dream.id, status: 'queued' })
    },
  })
}
