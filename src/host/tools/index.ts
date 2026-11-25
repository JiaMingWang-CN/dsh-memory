/**
 * Registers the explicit memory tools (`memory_search`, `memory_read`,
 * `memory_write`, `memory_forget`, `memory_dream`, `memory_organize`) on the
 * Host tool registry.
 *
 * The single entry point lets later plans add tools without changing how the
 * service owns and disposes the tool set.
 * @module memloom/host/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryService } from '../service.ts'
import { memoryDreamTool } from './dream.ts'
import { memoryForgetTool } from './forget.ts'
import { memoryOrganizeTool } from './organize.ts'
import { memoryReadTool } from './read.ts'
import { memorySearchTool } from './search.ts'
import { memoryWriteTool } from './write.ts'

/**
 * Register every explicit memory tool, returning one disposer that removes
 * exactly the tools it registered.
 * @param ctx - Host context whose `ctx.tools` registry receives the tools.
 * @param service - Memory service the tools execute against.
 * @returns A disposer that unregisters all six tools.
 */
export function registerMemoryTools(ctx: Context, service: MemoryService): () => void {
  const definitions = [
    memorySearchTool(ctx, service),
    memoryReadTool(ctx, service),
    memoryWriteTool(ctx, service),
    memoryForgetTool(ctx, service),
    memoryDreamTool(ctx, service),
    memoryOrganizeTool(ctx, service),
  ]
  const disposers: (() => void)[] = []
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register(definition))
  } catch (error) {
    for (const dispose of disposers) dispose()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) dispose()
  }
}
