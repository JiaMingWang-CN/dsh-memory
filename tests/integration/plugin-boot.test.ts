import { describe, expect, it, vi } from 'vitest'
import { memoryDomain } from '../../src/host/domain.ts'
import { OperationRunner } from '../../src/host/operations.ts'
import { MemoryService } from '../../src/host/service.ts'
import { createFakeHost } from '../helpers/fake-domain.ts'
import { openService } from '../helpers/service.ts'
import { captureSession, turnStart } from '../helpers/capture-events.ts'

function serviceOf(ctx: unknown): MemoryService {
  return (ctx as { memory: MemoryService }).memory
}

describe('plugin boot', () => {
  it('boots through the loader and reports ready', async () => {
    const host = createFakeHost()
    const fiber = host.ctx.plugin(MemoryService, {})
    await fiber

    const service = serviceOf(host.ctx)
    expect(service).toBeInstanceOf(MemoryService)
    const status = service.status()
    expect(status.ready).toBe(true)
    expect(status.counts).toEqual({
      active: 0,
      archived: 0,
      pending: 0,
      stored: 0,
      queuedEpisodes: 0,
      auditRecords: 0,
      operationRecords: 0,
    })
  })

  it('rejects initialization and closes the domain when recovery throws', async () => {
    const host = createFakeHost()
    const spy = vi
      .spyOn(OperationRunner.prototype, 'recover')
      .mockRejectedValueOnce(new Error('recover boom'))
    try {
      const fiber = host.ctx.plugin(MemoryService, {})
      await expect(fiber).rejects.toThrow(/recover boom/)
    } finally {
      spy.mockRestore()
    }
    // The domain was closed on failure, so reopening the same name succeeds.
    await expect(host.ctx.storageDomain.open(memoryDomain)).resolves.toBeTruthy()
  })

  it('closes the domain and unregisters the service on dispose', async () => {
    const host = createFakeHost()
    const fiber = host.ctx.plugin(MemoryService, {})
    await fiber
    const service = serviceOf(host.ctx)
    expect(service.status().ready).toBe(true)

    await fiber.dispose()

    expect(service.status().ready).toBe(false)
    expect((host.ctx as unknown as { get(name: string): unknown }).get('memory')).toBeUndefined()
    await expect(host.ctx.storageDomain.open(memoryDomain)).resolves.toBeTruthy()
  })

  it('starts cold-session backfill on turn start when autoDream is enabled', async () => {
    let listCalls = 0
    const host = await openService({
      config: { autoDream: true },
      sessionQuery: {
        listSessions: async () => {
          listCalls += 1
          return []
        },
        readSession: async () => ({ events: [] }),
      },
    })
    try {
      const emit = (
        host.ctx as unknown as { emit(event: string, ...args: unknown[]): void }
      ).emit.bind(host.ctx)
      emit('session/event', captureSession('cold-1', 'C:/ws/a'), turnStart(1, 1))
      await vi.waitFor(() => expect(listCalls).toBeGreaterThan(0))
    } finally {
      await host.dispose()
    }
  })

  it('stays inactive when enabled is false', async () => {
    const host = createFakeHost()
    const fiber = host.ctx.plugin(MemoryService, { enabled: false })
    await fiber
    const service = serviceOf(host.ctx)
    expect(service.status().ready).toBe(false)
    // No domain was opened, so it is still available to another consumer.
    await expect(host.ctx.storageDomain.open(memoryDomain)).resolves.toBeTruthy()
  })
})
