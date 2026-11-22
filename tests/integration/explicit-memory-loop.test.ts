import { describe, expect, it } from 'vitest'
import { openService } from '../helpers/service.ts'
import { runTool } from '../helpers/tool.ts'

describe('explicit memory loop', () => {
  it('writes, searches, reads, soft-forgets and restores one memory', async () => {
    const host = await openService({ workingDirectory: () => 'C:/ws/a' })
    try {
      const created = await runTool(host.tools, 'memory_write', {
        type: 'lesson',
        title: '构建前先跑 typecheck',
        body: '构建前先运行 typecheck，避免构建失败。',
      })

      const firstSearch = await runTool(host.tools, 'memory_search', { query: 'typecheck' })
      expect(firstSearch.results.map((hit: { id: string }) => hit.id)).toContain(created.id)

      const read = await runTool(host.tools, 'memory_read', { id: created.id })
      expect(read.body).toContain('typecheck')

      await runTool(host.tools, 'memory_forget', { id: created.id })
      const afterForget = await runTool(host.tools, 'memory_search', { query: 'typecheck' })
      expect(afterForget.results).toEqual([])

      // Host management entry restores the archived memory.
      const restored = await host.service.restore(created.id)
      expect(restored.status).toBe('active')

      const afterRestore = await runTool(host.tools, 'memory_search', { query: 'typecheck' })
      expect(afterRestore.results.map((hit: { id: string }) => hit.id)).toContain(created.id)
    } finally {
      await host.dispose()
    }
  })
})
