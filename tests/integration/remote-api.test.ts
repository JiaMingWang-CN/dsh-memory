import { describe, expect, it } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryService } from '../../src/host/service.ts'
import type { MemoryStore } from '../../src/host/store.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { openService } from '../helpers/service.ts'

const workspace = { key: 'ws-a', root: 'C:/ws/a' }

function storeOf(service: MemoryService): MemoryStore {
  return (service as unknown as { store: MemoryStore }).store
}

async function seedActive(service: MemoryService, title: string): Promise<MemoryRecord> {
  return service.create({
    type: 'lesson',
    title,
    body: `${title} body`,
    scope: 'workspace',
    workspaceKey: workspace.key,
    workspaceRoot: workspace.root,
  })
}

async function seedPending(
  service: MemoryService,
  supersedes: string[] = [],
): Promise<MemoryRecord> {
  const store = storeOf(service)
  return store.create({
    type: 'lesson',
    title: 'pending lesson',
    body: 'pending body',
    scope: { kind: 'workspace', key: workspace.key, root: workspace.root },
    origin: 'dream',
    ownership: 'derived',
    status: 'pending',
    sourceEpisodeIds: ['episode-1'],
    supersedes,
  })
}

describe('remote list', () => {
  it('filters by workspace/type/status and reports the correct page totals', async () => {
    const host = await openService()
    try {
      const service = host.service
      await seedActive(service, 'lesson one')
      await seedActive(service, 'lesson two')
      const wiki = await service.create({
        type: 'wiki',
        title: 'wiki one',
        body: 'wiki body',
        scope: 'workspace',
        workspaceKey: workspace.key,
        workspaceRoot: workspace.root,
      })
      await service.create({
        type: 'preference',
        title: 'global pref',
        body: 'pref body',
        scope: 'global',
      })
      await service.delete({ id: wiki.id })

      const lessons = service.remoteList({ workspaceKey: 'ws-a', type: 'lesson' })
      expect(lessons.total).toBe(2)
      expect(lessons.items.every((item) => item.type === 'lesson')).toBe(true)

      const archived = service.remoteList({ workspaceKey: 'ws-a', status: 'archived' })
      expect(archived.items.map((item) => item.id)).toEqual([wiki.id])

      const firstPage = service.remoteList({ workspaceKey: 'ws-a', limit: 2 })
      expect(firstPage.total).toBe(4)
      expect(firstPage.items).toHaveLength(2)
      expect(firstPage.truncated).toBe(true)
      const secondPage = service.remoteList({ workspaceKey: 'ws-a', limit: 2, offset: 2 })
      expect(secondPage.items).toHaveLength(2)
      expect(secondPage.truncated).toBe(false)

      const all = service.remoteList({ workspaceKey: 'all' })
      expect(all.total).toBe(4)
    } finally {
      await host.dispose()
    }
  })
})

describe('remote review', () => {
  it('accepts a proposal: active, user-owned, reviewed, and archives the old record', async () => {
    const host = await openService()
    try {
      const service = host.service
      const old = await seedActive(service, 'old lesson')
      const pending = await seedPending(service, [old.id])

      const accepted = await service.review({ id: pending.id, action: 'accept' })

      expect(accepted.status).toBe('active')
      expect(accepted.ownership).toBe('user')
      expect(accepted.reviewedByUserAt).toBeDefined()
      expect(storeOf(service).get(old.id)?.status).toBe('archived')
    } finally {
      await host.dispose()
    }
  })

  it('rejects a proposal: archived, and the old active record is unchanged', async () => {
    const host = await openService()
    try {
      const service = host.service
      const old = await seedActive(service, 'old lesson')
      const pending = await seedPending(service, [old.id])

      const rejected = await service.review({ id: pending.id, action: 'reject' })

      expect(rejected.status).toBe('archived')
      expect(rejected.ownership).toBe('derived')
      expect(storeOf(service).get(old.id)?.status).toBe('active')
    } finally {
      await host.dispose()
    }
  })
})

describe('remote update conflict', () => {
  it('rejects a stale expectedContentRevision with memory/conflict', async () => {
    const host = await openService()
    try {
      const record = await seedActive(host.service, 'conflict lesson')
      await expect(
        host.service.update({
          id: record.id,
          expectedContentRevision: 999,
          title: 'changed',
        }),
      ).rejects.toMatchObject({ code: 'memory/conflict', details: { code: 'MEMORY_CONFLICT' } })
    } finally {
      await host.dispose()
    }
  })
})

describe('remote config invalid', () => {
  it('rejects a fixed dream model without provider/model', async () => {
    const host = await openService()
    try {
      await expect(host.service.updateConfig({ dreamModelMode: 'fixed' })).rejects.toMatchObject({
        code: 'memory/invalid',
        details: { code: 'MEMORY_INVALID_CONFIG' },
      })
    } finally {
      await host.dispose()
    }
  })
})

describe('remote event', () => {
  it('emits memory/changed exactly once after a successful mutation', async () => {
    const host = await openService()
    try {
      let events = 0
      ;(host.ctx as unknown as Context).on(
        'memory/changed' as never,
        (() => {
          events += 1
        }) as never,
      )
      await seedActive(host.service, 'event lesson')
      expect(events).toBe(1)
    } finally {
      await host.dispose()
    }
  })
})

describe('remote permanent delete', () => {
  it('requires a confirmed user action and never lets an actor=model delete permanently', async () => {
    const host = await openService()
    try {
      const service = host.service
      const record = await seedActive(service, 'delete me')

      await expect(
        service.delete({ id: record.id, permanent: true, confirm: false, actor: 'user' }),
      ).rejects.toMatchObject({ code: 'memory/forbidden' })

      await expect(
        service.delete({ id: record.id, permanent: true, confirm: true, actor: 'model' as never }),
      ).rejects.toMatchObject({ code: 'memory/forbidden' })
      expect(storeOf(service).get(record.id)).toBeDefined()

      await service.delete({ id: record.id, permanent: true, confirm: true, actor: 'user' })
      expect(storeOf(service).get(record.id)).toBeUndefined()
    } finally {
      await host.dispose()
    }
  })
})

describe('remote import safety', () => {
  it('refuses a replace import without mapping at the Remote boundary', async () => {
    const host = await openService()
    try {
      const service = host.service
      const keep = await seedActive(service, 'must survive')
      const payload = {
        format: 'dsh-memory' as const,
        version: 1 as const,
        exportedAt: '2026-11-15T00:00:00.000Z',
        scope: { workspaceKey: 'ws-a' },
        includeArchived: true,
        memories: [
          makeMemoryRecord({
            id: MemoryId('replacement'),
            title: 'replacement',
            body: 'new body',
            scope: { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' },
          }),
        ],
        episodes: [],
      }

      await expect(
        service.remoteImport({
          payload,
          options: { mode: 'replace', confirm: true, targetScope: { workspaceKey: 'ws-a' } },
        }),
      ).rejects.toMatchObject({ code: 'memory/forbidden' })
      expect(storeOf(service).get(keep.id)?.status).toBe('active')
      expect(storeOf(service).get(MemoryId('replacement'))).toBeUndefined()
    } finally {
      await host.dispose()
    }
  })
})

describe('remote export purge', () => {
  it('applies the after-export archive purge to the exported scope', async () => {
    const host = await openService({ config: { archivePurgePolicy: 'after-export' } })
    try {
      const service = host.service
      const archived = await seedActive(service, 'exported archive')
      await service.delete({ id: archived.id })
      const outside = await service.create({
        type: 'lesson',
        title: 'outside archive',
        body: 'outside body',
        scope: 'workspace',
        workspaceKey: 'ws-b',
        workspaceRoot: 'C:/ws/b',
      })
      await service.delete({ id: outside.id })

      await service.remoteExport({ scope: { workspaceKey: 'ws-a' } })
      expect(storeOf(service).get(archived.id)).toBeUndefined()
      expect(storeOf(service).get(outside.id)?.status).toBe('archived')
    } finally {
      await host.dispose()
    }
  })
})

describe('single remote service', () => {
  it('exposes every management endpoint on the one ctx.memory service', async () => {
    const host = await openService()
    try {
      const service = host.service
      const registered = (host.ctx as unknown as { get(name: string): unknown }).get('memory')
      expect(registered).toBeDefined()
      expect((service as unknown as { name: string }).name).toBe('memory')
      expect(service.typertRemote.serviceKey).toBe('memory')
      expect(service.typertRemote.namespace).toBe('memory')
      const exported = remoteMethods(service).map((marker) => marker.exportName ?? marker.method)
      for (const name of [
        'overview',
        'list',
        'view',
        'create',
        'update',
        'delete',
        'restore',
        'review',
        'dream',
        'dreamStatus',
        'undoDream',
        'cancelDream',
        'export',
        'import',
        'rebuild',
        'purgeAll',
        'getConfig',
        'updateConfig',
        'modelCatalog',
        'modelEfforts',
      ]) {
        expect(exported).toContain(name)
      }
    } finally {
      await host.dispose()
    }
  })
})
