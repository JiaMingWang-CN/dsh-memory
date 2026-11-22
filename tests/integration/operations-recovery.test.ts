import { describe, expect, it } from 'vitest'
import {
  DreamId,
  EpisodeId,
  MemoryId,
  type DreamRun,
  type EpisodeRecord,
  type MemoryRecord,
} from '../../src/shared/types.ts'
import { OperationRunner } from '../../src/host/operations.ts'
import { MemoryStore } from '../../src/host/store.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { openMemory } from '../helpers/runner.ts'

const undoWorkspace = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

class Crash extends Error {
  constructor(step: string) {
    super(`simulated crash after step '${step}'`)
    this.name = 'Crash'
  }
}

function crashRunner(domain: Awaited<ReturnType<typeof openMemory>>['domain'], step: string) {
  return new OperationRunner(domain, {
    observer: {
      afterStep: ({ stepName }) => {
        if (stepName === step) throw new Crash(step)
      },
    },
  })
}

describe('operation crash recovery matrix', () => {
  it('memory.create: crash after the memory write completes on restart', async () => {
    const { domain } = await openMemory()
    const record = makeMemoryRecord({ id: MemoryId('m-create') })
    const runner = crashRunner(domain, 'memory')
    const operation = await runner.begin('memory.create', { record, actor: 'user' })
    await expect(runner.apply(operation)).rejects.toBeInstanceOf(Crash)

    expect(domain.table('memories').get(record.id)).toBeDefined()
    expect(domain.table('audit').size).toBe(0)

    const report = await new OperationRunner(domain).recover()
    expect(report.committed).toBe(1)
    expect(report.failed).toBe(0)
    expect(domain.table('audit').size).toBe(1)
    expect(domain.table('operations').get(operation.id)?.status).toBe('committed')
  })

  it('memory.accept: crash between archive-old and activate-new never yields two active rows', async () => {
    const { domain } = await openMemory()
    const old = makeMemoryRecord({ id: MemoryId('old'), status: 'active' })
    const pending = makeMemoryRecord({
      id: MemoryId('new'),
      status: 'pending',
      ownership: 'derived',
      origin: 'dream',
    })
    await domain.table('memories').put(old.id, old)
    await domain.table('memories').put(pending.id, pending)

    const oldAfter: MemoryRecord = {
      ...old,
      status: 'archived',
      contentRevision: 2,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const activated: MemoryRecord = {
      ...pending,
      status: 'active',
      ownership: 'user',
      reviewedByUserAt: '2026-11-15T01:00:00.000Z',
      contentRevision: 2,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const runner = crashRunner(domain, 'archive-old')
    const operation = await runner.begin('memory.accept', {
      old,
      oldAfter,
      newBefore: pending,
      after: activated,
      actor: 'user',
    })
    await expect(runner.apply(operation)).rejects.toBeInstanceOf(Crash)

    const activeCount = (): number =>
      [...domain.table('memories').entries()].filter(([, record]) => record.status === 'active')
        .length
    expect(domain.table('memories').get(old.id)?.status).toBe('archived')
    expect(domain.table('memories').get(pending.id)?.status).toBe('pending')
    expect(activeCount()).toBe(0)

    const report = await new OperationRunner(domain).recover()
    expect(report.committed).toBe(1)
    expect(domain.table('memories').get(old.id)?.status).toBe('archived')
    expect(domain.table('memories').get(pending.id)?.status).toBe('active')
    expect(domain.table('memories').get(pending.id)?.ownership).toBe('user')
    expect(activeCount()).toBe(1)
  })

  it('memory.delete: crash after audit before delete finishes the delete and keeps audit', async () => {
    const { domain } = await openMemory()
    const record = makeMemoryRecord({ id: MemoryId('del') })
    await domain.table('memories').put(record.id, record)
    const runner = crashRunner(domain, 'audit')
    const operation = await runner.begin('memory.delete', { before: record, actor: 'user' })
    await expect(runner.apply(operation)).rejects.toBeInstanceOf(Crash)

    expect(domain.table('audit').size).toBe(1)
    expect(domain.table('memories').get(record.id)).toBeDefined()

    const report = await new OperationRunner(domain).recover()
    expect(report.committed).toBe(1)
    expect(domain.table('memories').get(record.id)).toBeUndefined()
    expect(domain.table('audit').size).toBe(1)
  })

  it('memory.delete: crash after the memory write still scrubs the operation snapshot on recovery', async () => {
    const { domain } = await openMemory()
    const record = makeMemoryRecord({
      id: MemoryId('del-secret'),
      title: 'private title',
      body: 'CRASH_DELETE_SECRET',
    })
    await domain.table('memories').put(record.id, record)
    const runner = crashRunner(domain, 'memory')
    const operation = await runner.begin('memory.delete', {
      before: record,
      actor: 'user',
      minimalAudit: true,
    })
    await expect(runner.apply(operation)).rejects.toBeInstanceOf(Crash)
    expect(domain.table('memories').get(record.id)).toBeUndefined()
    expect(JSON.stringify([...domain.table('operations').entries()])).toContain(
      'CRASH_DELETE_SECRET',
    )

    const report = await new OperationRunner(domain).recover()
    expect(report.committed).toBe(1)
    const persisted = domain.table('operations').get(operation.id)
    expect(persisted?.status).toBe('committed')
    expect(JSON.stringify(persisted)).not.toContain('CRASH_DELETE_SECRET')
    expect(JSON.stringify([...domain.table('audit').entries()])).not.toContain(
      'CRASH_DELETE_SECRET',
    )
  })

  it('permanent delete scrubs accept audits that carry the old snapshot under the new memory id', async () => {
    const { domain, runner } = await openMemory()
    const store = new MemoryStore(domain, runner)
    await store.initialize()
    const old = await store.create({
      type: 'lesson',
      title: 'old',
      body: 'CROSS_SNAPSHOT_SECRET',
      scope: undoWorkspace,
    })
    const pending = await store.create({
      type: 'lesson',
      title: 'new',
      body: 'new body',
      scope: undoWorkspace,
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      sourceEpisodeIds: ['episode-cross'],
      actor: 'dream',
    })
    const oldAfter: MemoryRecord = {
      ...old,
      status: 'archived',
      contentRevision: old.contentRevision + 1,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const activated: MemoryRecord = {
      ...pending,
      status: 'active',
      ownership: 'user',
      reviewedByUserAt: '2026-11-15T01:00:00.000Z',
      contentRevision: pending.contentRevision + 1,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const accept = await runner.begin('memory.accept', {
      old,
      oldAfter,
      newBefore: pending,
      after: activated,
      actor: 'user',
    })
    await runner.commit(await runner.apply(accept))

    await store.delete(old.id, { permanent: true, actor: 'user', confirm: true })
    const auditJson = JSON.stringify([...domain.table('audit').entries()])
    expect(auditJson).not.toContain('CROSS_SNAPSHOT_SECRET')
  })

  it('a transient audit write failure leaves the operation resumable instead of failed', async () => {
    const { domain, runner } = await openMemory()
    const store = new MemoryStore(domain, runner)
    await store.initialize()
    const created = await store.create({
      type: 'lesson',
      title: 'transient',
      body: 'before',
      scope: undoWorkspace,
    })

    const auditTable = domain.table('audit')
    const originalAuditPut = auditTable.put.bind(auditTable)
    let failNextAuditWrite = true
    ;(auditTable as unknown as { put: (key: string, value: unknown) => Promise<unknown> }).put =
      async (key: string, value: unknown) => {
        if (failNextAuditWrite) {
          failNextAuditWrite = false
          throw new Error('temporary audit write failure')
        }
        return originalAuditPut(key as never, value as never)
      }

    await expect(
      store.update(created.id, {
        expectedContentRevision: created.contentRevision,
        body: 'after',
        actor: 'user',
      }),
    ).rejects.toThrow('temporary audit write failure')
    expect(store.get(created.id)?.body).toBe('after')
    const midFlight = [...domain.table('operations').entries()].find(
      ([, operation]) => operation.kind === 'memory.update' && operation.status === 'applying',
    )
    expect(midFlight).toBeDefined()

    const report = await new OperationRunner(domain).recover()
    expect(report.committed).toBe(1)
    expect(domain.table('operations').get(midFlight![0])?.status).toBe('committed')
    expect(
      [...domain.table('audit').entries()].some(
        ([, audit]) => audit.action === 'update' && audit.after?.body === 'after',
      ),
    ).toBe(true)
  })

  it('dream.run: recovery only finalizes, retaining pending proposals and retrying episodes', async () => {
    const { domain } = await openMemory()
    const runner = new OperationRunner(domain)
    const dreamId = DreamId('dream-1')
    const operation = await runner.begin('dream.run', { dreamId })
    const dream: DreamRun = {
      id: dreamId,
      trigger: 'manual',
      scopeKey: 'ws-a',
      status: 'running',
      startedAt: '2026-11-15T00:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-chat',
      episodes: 1,
      committed: 0,
      pending: 1,
    }
    await domain.table('dreams').put(dreamId, dream)
    const proposal = makeMemoryRecord({
      id: MemoryId('pending-1'),
      status: 'pending',
      ownership: 'derived',
      origin: 'dream',
      proposalKey: 'proposal-1',
    })
    await domain.table('memories').put(proposal.id, proposal)
    const base: EpisodeRecord = {
      id: EpisodeId('e1'),
      sessionId: 'session-1',
      workspaceKey: 'ws-a',
      workspaceRoot: 'C:/ws/a',
      kind: 'turn',
      status: 'processing',
      attempts: 1,
      turn: 1,
      sourceSeqs: [1],
      files: [],
      createdAt: '2026-11-15T00:00:00.000Z',
      dreamId: 'dream-1',
    }
    const untouched: EpisodeRecord = { ...base, id: EpisodeId('e2'), status: 'new' }
    await domain.table('episodes').put(base.id, base)
    await domain.table('episodes').put(untouched.id, untouched)

    const report = await new OperationRunner(domain).recover()
    expect(report.failed).toBe(1)
    expect(domain.table('dreams').get(dreamId)?.status).toBe('failed')
    expect(domain.table('episodes').get(base.id)?.status).toBe('failed-retryable')
    expect(domain.table('episodes').get(untouched.id)?.status).toBe('new')
    expect(domain.table('memories').get(proposal.id)).toBeDefined()
    expect(domain.table('operations').get(operation.id)?.status).toBe('failed')
  })

  it('revision mismatch: a user edit after a crash is preserved and the operation fails', async () => {
    const { domain } = await openMemory()
    const record = makeMemoryRecord({ id: MemoryId('u1') })
    await domain.table('memories').put(record.id, record)
    const after: MemoryRecord = {
      ...record,
      title: 'new title',
      contentRevision: 2,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const runner = crashRunner(domain, 'memory')
    const operation = await runner.begin('memory.update', {
      before: record,
      after,
      actor: 'user',
      action: 'update',
    })
    await expect(runner.apply(operation)).rejects.toBeInstanceOf(Crash)

    const userEdit: MemoryRecord = {
      ...after,
      title: 'user title',
      contentRevision: 3,
      updatedAt: '2026-11-15T02:00:00.000Z',
    }
    await domain.table('memories').put(record.id, userEdit)

    const report = await new OperationRunner(domain).recover()
    expect(report.failed).toBe(1)
    expect(report.committed).toBe(0)
    expect(domain.table('memories').get(record.id)).toEqual(userEdit)
    expect(domain.table('operations').get(operation.id)?.status).toBe('failed')
  })
})

describe('dream undo', () => {
  it('undoes dream-generated memories and records a dream.undo operation', async () => {
    const { domain, runner } = await openMemory()
    const store = new MemoryStore(domain, runner)
    await store.initialize()
    const proposal = await store.create({
      type: 'lesson',
      title: 'dream proposal',
      body: 'x',
      scope: undoWorkspace,
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      sourceEpisodeIds: ['episode-undo'],
      actor: 'dream',
      dreamId: 'dream-undo-1',
    })

    const report = await runner.undoDream('dream-undo-1')
    expect(report.undone).toBe(1)
    expect(store.get(proposal.id)).toBeUndefined()
    const undoOperations = [...domain.table('operations').entries()].filter(
      ([, operation]) => operation.kind === 'dream.undo',
    )
    expect(undoOperations).toHaveLength(1)
    expect(undoOperations[0]![1].status).toBe('committed')
    expect(
      [...domain.table('audit').entries()].some(([, audit]) => audit.action === 'dream-undo'),
    ).toBe(true)
  })

  it('does not undo a user accept audit and never leaves two active records', async () => {
    const { domain, runner } = await openMemory()
    const store = new MemoryStore(domain, runner)
    await store.initialize()
    const old = await store.create({
      type: 'lesson',
      title: 'old',
      body: 'x',
      scope: undoWorkspace,
    })
    const pending = await store.create({
      type: 'lesson',
      title: 'new',
      body: 'y',
      scope: undoWorkspace,
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      sourceEpisodeIds: ['episode-accept'],
      actor: 'dream',
    })
    const oldAfter: MemoryRecord = {
      ...old,
      status: 'archived',
      contentRevision: old.contentRevision + 1,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const activated: MemoryRecord = {
      ...pending,
      status: 'active',
      ownership: 'user',
      reviewedByUserAt: '2026-11-15T01:00:00.000Z',
      contentRevision: pending.contentRevision + 1,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const operation = await runner.begin('memory.accept', {
      old,
      oldAfter,
      newBefore: pending,
      after: activated,
      actor: 'user',
      dreamId: 'dream-accept-1',
    })
    await runner.commit(await runner.apply(operation))

    await runner.undoDream('dream-accept-1')
    const active = [...domain.table('memories').entries()].filter(
      ([, record]) => record.status === 'active',
    )
    expect(active).toHaveLength(1)
    expect(active[0]![1].id).toBe(activated.id)
  })

  it('memory.reject archives a pending proposal with a reject audit', async () => {
    const { domain, runner } = await openMemory()
    const store = new MemoryStore(domain, runner)
    await store.initialize()
    const pending = await store.create({
      type: 'lesson',
      title: 'reject me',
      body: 'x',
      scope: undoWorkspace,
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      sourceEpisodeIds: ['episode-reject'],
      actor: 'dream',
    })
    const after: MemoryRecord = {
      ...pending,
      status: 'archived',
      contentRevision: pending.contentRevision + 1,
      updatedAt: '2026-11-15T01:00:00.000Z',
    }
    const operation = await runner.begin('memory.reject', {
      before: pending,
      after,
      actor: 'user',
      action: 'reject',
    })
    await runner.commit(await runner.apply(operation))
    expect(store.get(pending.id)?.status).toBe('archived')
    expect(
      store.auditList({ memoryId: pending.id }).items.some((item) => item.action === 'reject'),
    ).toBe(true)
  })
})
