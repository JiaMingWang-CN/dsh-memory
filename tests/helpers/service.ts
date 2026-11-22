import type { Context } from '@deepseek-ai/cordis'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import { MemoryService } from '../../src/host/service.ts'
import { createFakeHost, type FakeDomainFacility } from './fake-domain.ts'

export interface MemoryServiceHost {
  ctx: Context
  facility: FakeDomainFacility
  service: MemoryService
  tools: ToolsService
  dispose(): Promise<void>
}

/**
 * Boot a real {@link MemoryService} on a fake Host context with a real tool
 * registry. The service is fully initialized (recovery done, index built, tools
 * registered) before this resolves.
 * @param options - Working-directory resolver and optional config override.
 * @returns The context, service, tool registry and a disposer.
 */
export async function openService(
  options: {
    workingDirectory?: (agent: unknown) => string | Promise<string>
    config?: Record<string, unknown>
    sessionQuery?: unknown
    facility?: FakeDomainFacility
    llm?: unknown
  } = {},
): Promise<MemoryServiceHost> {
  const host = createFakeHost({
    ...(options.workingDirectory === undefined
      ? {}
      : { workingDirectory: options.workingDirectory }),
    ...(options.sessionQuery === undefined ? {} : { sessionQuery: options.sessionQuery }),
    ...(options.facility === undefined ? {} : { facility: options.facility }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  })
  const fiber = host.ctx.plugin(MemoryService, options.config ?? {})
  await fiber
  const service = (host.ctx as unknown as { memory: MemoryService }).memory
  const tools = (host.ctx as unknown as { tools: ToolsService }).tools
  return {
    ctx: host.ctx,
    facility: host.facility,
    service,
    tools,
    dispose: async () => {
      await fiber.dispose()
    },
  }
}
