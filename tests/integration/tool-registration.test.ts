import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'

const EXPLICIT_TOOLS = [
  'memory_search',
  'memory_read',
  'memory_write',
  'memory_forget',
  'memory_dream',
  'memory_organize',
]

describe('tool registration', () => {
  it('registers every explicit memory tool and removes them on dispose', async () => {
    const host = await openService()
    try {
      const names = host.tools.schemas().map((schema) => schema.name)
      for (const name of EXPLICIT_TOOLS) expect(names).toContain(name)
    } finally {
      await host.dispose()
    }
    const remaining = host.tools.schemas().map((schema) => schema.name)
    for (const name of EXPLICIT_TOOLS) expect(remaining).not.toContain(name)
  })
})
