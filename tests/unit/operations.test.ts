import { describe, expect, it } from 'vitest'
import { MemoryId } from '../../src/shared/types.ts'
import { OperationError, OperationRunner } from '../../src/host/operations.ts'
import { MemoryStore } from '../../src/host/store.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { openMemory } from '../helpers/runner.ts'

describe('operation log basics', () => {
  it('exposes stable error codes', () => {
    expect(new OperationError('MEMORY_CONFLICT').code).toBe('MEMORY_CONFLICT')
    expect(new OperationError('MEMORY_RECOVERING').code).toBe('MEMORY_RECOVERING')
    expect(new OperationError('MEMORY_CAPACITY').code).toBe('MEMORY_CAPACITY')
  })

  it('plans the documented step order per kind', async () => {
    const { runner } = await openMemory()
    const create = await runner.begin('memory.create', {
      record: makeMemoryRecord({ id: MemoryId('c1') }),
      actor: 'user',
    })
    expect(create.totalSteps).toBe(2)
    expect(create.stepName).toBe('memory')

    const del = await runner.begin('memory.delete', {
      before: makeMemoryRecord({ id: MemoryId('d1') }),
      actor: 'user',
    })
    expect(del.stepName).toBe('audit')
    expect(del.totalSteps).toBe(3)

    const accept = await runner.begin('memory.accept', {})
    expect(accept.stepName).toBe('archive-old')
    expect(accept.totalSteps).toBe(3)
  })

  it('dedupes one requestId inside the TTL and allows a new one after it', async () => {
    let clock = Date.parse('2026-11-15T00:00:00.000Z')
    const now = (): Date => new Date(clock)
    const { domain } = await openMemory()
    const runner = new OperationRunner(domain, { now, requestDedupeTtlMs: 1000 })
    const record = makeMemoryRecord({ id: MemoryId('dedupe') })
    const payload = { record, actor: 'user' as const }

    const first = await runner.begin('memory.create', payload, 'req-1')
    const second = await runner.begin('memory.create', payload, 'req-1')
    expect(second.id).toBe(first.id)

    clock += 2000
    const third = await runner.begin('memory.create', payload, 'req-1')
    expect(third.id).not.toBe(first.id)
  })
})

describe('recovery robustness', () => {
  it('fails one damaged dream.undo row and still recovers every other operation', async () => {
    const { domain, runner } = await openMemory()
    // A dream.undo operation without its payload must not abort startup.
    const damaged = await runner.begin('dream.undo', {})
    const healthy = await runner.begin('memory.create', {
      record: makeMemoryRecord({ id: MemoryId('c1') }),
      actor: 'user',
    })

    const report = await runner.recover()

    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ id: damaged.id, outcome: 'failed' }),
    )
    expect(domain.table('operations').get(damaged.id)?.status).toBe('failed')
    expect(domain.table('operations').get(healthy.id)?.status).toBe('committed')
    expect(domain.table('memories').get(MemoryId('c1'))).toBeDefined()
  })
})

describe('failed permanent delete', () => {
  it('strips the content snapshot instead of retaining the deleted body', async () => {
    const { domain, runner } = await openMemory()
    const record = makeMemoryRecord({ id: MemoryId('del-1'), body: 'SECRET BODY' })
    const operation = await runner.begin('memory.delete', { before: record, actor: 'user' })

    await runner.markFailed(operation, new Error('storage unavailable'))

    const stored = domain.table('operations').get(operation.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.before).toBeUndefined()
    expect(stored?.after).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain('SECRET BODY')
  })
})

describe('audit retention window', () => {
  it('keeps recent undo history even when the audit record cap is exceeded', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z')
    const now = (): Date => new Date(clock)
    const { domain } = await openMemory()
    const runner = new OperationRunner(domain, { now, maxAuditRecords: 1 })
    const store = new MemoryStore(domain, runner, {})
    await store.initialize()
    const workspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

    await store.create({ type: 'lesson', title: 'one', body: 'b', scope: workspace })
    await store.create({ type: 'lesson', title: 'two', body: 'b', scope: workspace })
    // Both audits are inside the 30-day undo window, so the cap does not prune.
    expect([...domain.table('audit').entries()]).toHaveLength(2)

    clock += 31 * 24 * 60 * 60 * 1000
    await store.create({ type: 'lesson', title: 'three', body: 'b', scope: workspace })
    // The two aged-out rows are pruned; the newest one survives the cap.
    expect([...domain.table('audit').entries()]).toHaveLength(1)
  })
})
