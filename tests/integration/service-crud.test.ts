import { describe, expect, it } from 'vitest'
import { MemoryId } from '../../src/shared/types.ts'
import { openStore } from '../helpers/runner.ts'

const workspaceA = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }
const workspaceB = { kind: 'workspace' as const, key: 'ws-b', root: 'C:/ws/b' }

describe('memory store lifecycle', () => {
  it('runs create/read/update/archive/restore/delete and audits every change', async () => {
    const { store } = await openStore({ defaultWorkspaceKey: 'ws-a' })
    const created = await store.create({
      type: 'lesson',
      title: 'A',
      body: 'body',
      scope: workspaceA,
    })
    expect(store.get(created.id)).toEqual(created)

    const updated = await store.update(created.id, { expectedContentRevision: 1, body: 'body 2' })
    expect(updated.body).toBe('body 2')

    const archived = await store.archive(created.id)
    expect(archived.status).toBe('archived')

    const restored = await store.restore(created.id)
    expect(restored.status).toBe('active')
    expect(restored.ownership).toBe('user')

    await store.delete(created.id)
    expect(store.get(created.id)?.status).toBe('archived')

    const audits = store.auditList({ memoryId: created.id, limit: 500 })
    expect(audits.total).toBe(5)
    expect(audits.items.map((item) => item.action)).toEqual([
      'archive',
      'restore',
      'archive',
      'update',
      'create',
    ])
  })
})

describe('memory store scope isolation', () => {
  it('does not leak one workspace memory into another, while global preferences are shared', async () => {
    const { store } = await openStore()
    const a = await store.create({ type: 'lesson', title: 'A', body: 'x', scope: workspaceA })
    const b = await store.create({ type: 'lesson', title: 'B', body: 'x', scope: workspaceB })
    const pref = await store.create({
      type: 'preference',
      title: 'P',
      body: 'x',
      scope: { kind: 'global' },
    })

    const listA = store.list({ workspaceKey: 'ws-a' })
    expect(listA.items.map((item) => item.id)).toContain(a.id)
    expect(listA.items.map((item) => item.id)).not.toContain(b.id)
    expect(listA.items.map((item) => item.id)).toContain(pref.id)

    const listB = store.list({ workspaceKey: 'ws-b' })
    expect(listB.items.map((item) => item.id)).toContain(b.id)
    expect(listB.items.map((item) => item.id)).not.toContain(a.id)

    const all = store.list({ workspaceKey: 'all', management: true })
    expect(all.total).toBe(3)
  })
})

describe('permanent delete', () => {
  it('rejects a model actor even with confirm=true, and a confirmed user delete keeps a minimal audit', async () => {
    const { store } = await openStore()
    const record = await store.create({ type: 'lesson', title: 'D', body: 'x', scope: workspaceA })

    await expect(
      store.delete(record.id, { permanent: true, actor: 'model', confirm: true }),
    ).rejects.toMatchObject({ code: 'MEMORY_FORBIDDEN' })
    expect(store.get(record.id)).toBeDefined()

    await store.delete(record.id, { permanent: true, actor: 'user', confirm: true })
    expect(store.get(record.id)).toBeUndefined()

    const audit = store.auditList({ memoryId: record.id })
    const deleteAudit = audit.items.find((item) => item.action === 'delete')
    expect(deleteAudit).toBeDefined()
    expect(deleteAudit?.before).toBeNull()
    expect(JSON.stringify(audit.items)).not.toContain('"x"')
  })

  it('leaves no memory body in the operation log after a permanent delete', async () => {
    const { store, domain } = await openStore()
    const record = await store.create({
      type: 'lesson',
      title: 'erase',
      body: 'UNIQUE_ERASE_ME_BODY',
      scope: workspaceA,
    })
    await store.delete(record.id, { permanent: true, actor: 'user', confirm: true })

    const operationsJson = JSON.stringify([...domain.table('operations').entries()])
    expect(operationsJson).not.toContain('UNIQUE_ERASE_ME_BODY')
    expect(operationsJson).not.toContain('erase')
    expect([...domain.table('operations').entries()].length).toBeGreaterThan(0)
  })

  it('rejects a second create with the same id but different content', async () => {
    const { store } = await openStore()
    const first = await store.create({
      id: MemoryId('dup-id'),
      type: 'lesson',
      title: 'first',
      body: 'first body',
      scope: workspaceA,
    })
    await expect(
      store.create({
        id: MemoryId('dup-id'),
        type: 'lesson',
        title: 'second',
        body: 'second body',
        scope: workspaceA,
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(store.get(first.id)?.body).toBe('first body')
  })
})
