/**
 * `memory_dream` — enqueue a manual dreaming run for the caller's scope.
 * @module dsh-memory/host/tools/dream
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { workspaceIdentityOf } from '../workspace.ts'
import { DREAM_QUEUE_OUTPUT_SCHEMA, renderJsonOutput } from './schemas.ts'

/**
 * Build the `memory_dream` tool.
 * @param ctx - Host context (for the caller's workspace).
 * @param service - Memory service.
 * @returns A registry-ready tool definition.
 */
export function memoryDreamTool(ctx: Context, service: MemoryService): ToolDefinition {
  return defineTool({
    name: 'memory_dream',
    description:
      'Queue a manual dreaming run that consolidates captured episodes into pending memory proposals. Returns the dream id and queue status immediately; the run continues in the background.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description:
          'workspace (default) consolidates the current workspace; global uses global preferences.',
      },
      max_episodes: {
        type: 'integer',
        description: 'Maximum episodes to process (default 40, >= 1).',
      },
      since: {
        type: 'string',
        description: 'Only process episodes created at or after this ISO timestamp.',
      },
    },
    output: {
      schema: DREAM_QUEUE_OUTPUT_SCHEMA,
      render: renderJsonOutput,
    },
    async execute(args, exec) {
      if (
        args.max_episodes !== undefined &&
        (!Number.isInteger(args.max_episodes) || args.max_episodes < 1)
      ) {
        return {
          dreamId: null,
          status: 'error' as const,
          reason: 'max_episodes must be a positive integer',
        }
      }
      if (args.since !== undefined && Number.isNaN(Date.parse(args.since))) {
        return {
          dreamId: null,
          status: 'error' as const,
          reason: 'since must be a valid ISO timestamp',
        }
      }
      const scope = args.scope ?? 'workspace'
      const workspace = scope === 'global' ? null : await workspaceIdentityOf(ctx, exec.agent)
      if (scope === 'workspace' && workspace === null) {
        return { dreamId: null, status: 'error' as const, reason: 'no working directory' }
      }
      const dream = await service.enqueueDream({
        scope,
        workspace,
        agent: exec.agent,
        ...(args.max_episodes === undefined ? {} : { maxEpisodes: args.max_episodes }),
        ...(args.since === undefined ? {} : { since: args.since }),
      })
      return { dreamId: dream.id, status: 'queued' as const }
    },
  })
}
