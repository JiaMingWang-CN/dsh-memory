import { describe, expect, it } from 'vitest'
import { runTool } from '../helpers/tool.ts'
import { openService } from '../helpers/service.ts'

const agent = { id: 'agent-a' }

describe('dream command registration', () => {
  it('registers memory_dream and /memory, executes them, and removes both on dispose', async () => {
    const host = await openService()

    expect(host.tools.get('memory_dream')).toBeDefined()
    const commands = (
      host.ctx as unknown as {
        commands: {
          find(a: unknown, n: string): unknown
          execute(a: unknown, l: string): Promise<{ result: any } | undefined>
        }
      }
    ).commands
    expect(commands.find(agent, 'memory')).toBeDefined()

    const toolResult = await runTool(host.tools, 'memory_dream', {}, 'agent-a')
    expect(toolResult.status).toBe('queued')
    expect(typeof toolResult.dreamId).toBe('string')
    expect(host.service.dreamRuns().some((dream) => dream.id === toolResult.dreamId)).toBe(true)

    const executed = await commands.execute(agent, '/memory dream')
    expect(executed?.result.kind).toBe('success')
    expect(executed?.result.text).toContain('Dream queued')

    await host.dispose()
    expect(host.tools.get('memory_dream')).toBeUndefined()
    expect(commands.find(agent, 'memory')).toBeUndefined()
  })
})
