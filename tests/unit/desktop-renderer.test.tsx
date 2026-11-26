// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { AGY_EDITABLE_CONFIG_FIELDS, MEMORY_CONFIG_DEFAULTS } from '../../src/core/config.ts'
import type { ImportReport } from '../../src/core/exchange.ts'
import type { DesktopBridgeApi, IpcErrorCode, IpcResult } from '../../src/desktop/ipc-contract.ts'
import type { DesktopClientInfo } from '../../src/desktop/multi-service.ts'
import type { WriteGuardSnapshot } from '../../src/desktop/write-guard.ts'
import { DesktopApp } from '../../src/desktop/renderer/DesktopApp.tsx'
import { applyDesktopLocale, desktopErrorText } from '../../src/desktop/renderer/desktop-locales.ts'
import {
  AuditId,
  DreamId,
  MemoryId,
  type AuditRecord,
  type DreamRun,
  type MemoryRecord,
} from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const h = React.createElement
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

afterEach(() => {
  cleanup()
})

function ok<T>(value: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, value })
}

function fail<T = never>(code: IpcErrorCode, message: string): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error: { code, message } })
}

function createFakeBridge(options?: {
  legacyCandidate?: string | null
  initialLocale?: 'zh' | 'en'
  failNextUpdateWithExternalChange?: boolean
}) {
  const wsA = {
    key: 'c:/ws/a',
    root: 'C:/ws/a',
    memoryCount: 2,
    updatedAt: '2026-11-25T10:00:00.000Z',
  }
  const wsB = {
    key: 'c:/ws/b',
    root: 'C:/ws/b',
    memoryCount: 1,
    updatedAt: '2026-11-25T09:00:00.000Z',
  }

  const dshRecord: MemoryRecord = makeMemoryRecord({
    id: MemoryId('dsh-mem-1'),
    title: 'DSH Lesson',
    body: 'Always inspect logs before editing DSH state.',
    scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
    updatedAt: '2026-11-25T10:00:00.000Z',
  })
  const agyRecord: MemoryRecord = makeMemoryRecord({
    id: MemoryId('agy-mem-1'),
    title: 'AGY Wiki Note',
    type: 'wiki',
    body: 'AGY stores flat JSON with .memory.lock.',
    scope: { kind: 'workspace', key: 'c:/ws/b', root: 'C:/ws/b' },
    updatedAt: '2026-11-25T11:00:00.000Z',
  })

  const dshDreams: DreamRun[] = [
    {
      id: DreamId('dream-run-1'),
      trigger: 'auto',
      scopeKey: 'c:/ws/a',
      status: 'completed',
      startedAt: '2026-11-25T08:00:00.000Z',
      finishedAt: '2026-11-25T08:01:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-chat',
      episodes: 5,
      committed: 2,
      pending: 1,
    },
  ]

  const dshAudit: AuditRecord[] = [
    {
      id: AuditId('audit-1'),
      operationId: 'op-1',
      action: 'create',
      memoryId: 'dsh-mem-1',
      actor: 'user',
      status: 'applied',
      at: '2026-11-25T10:00:00.000Z',
      before: null,
      after: dshRecord,
    },
    {
      id: AuditId('audit-2'),
      operationId: 'op-2',
      dreamId: 'dream-run-1',
      action: 'dream-commit',
      memoryId: 'dsh-mem-1',
      actor: 'dream',
      status: 'applied',
      at: '2026-11-25T08:01:00.000Z',
    },
  ]

  let guard: WriteGuardSnapshot = {
    mode: 'readonly-dsh-running',
    dshRunning: true,
    uncertain: false,
    matchedProcesses: ['DeepSeek Harness.exe'],
    checkedAt: '2026-11-25T12:00:00.000Z',
    reason: 'DSH running',
  }

  let prefs = {
    theme: 'light' as 'system' | 'light' | 'dark',
    locale: (options?.initialLocale ?? 'zh') as 'zh' | 'en',
  }

  let agyConfig = { ...MEMORY_CONFIG_DEFAULTS }
  let failExternalOnce = options?.failNextUpdateWithExternalChange === true
  let legacyCandidate: string | null = options?.legacyCandidate ?? null

  const baseClients: DesktopClientInfo[] = [
    {
      id: 'dsh-default',
      name: 'DSH 默认',
      kind: 'dsh',
      builtin: true,
      storePath: 'C:/fake/dsh/memory.json',
      enabled: true,
      dshProtected: true,
      allowInitializeWhenMissing: false,
      format: 'dsh-unit',
      health: 'ready',
      lastCheckedAt: '2026-11-25T12:00:00.000Z',
      writable: false,
      configEditable: false,
    },
    {
      id: 'agy-default',
      name: 'AGY 默认',
      kind: 'agy',
      builtin: true,
      storePath: 'C:/fake/agy/memory.json',
      enabled: true,
      dshProtected: false,
      allowInitializeWhenMissing: true,
      format: 'agy-flat',
      health: 'ready',
      lastCheckedAt: '2026-11-25T12:00:00.000Z',
      writable: true,
      configEditable: true,
    },
    {
      id: 'custom-broken',
      name: '损坏旧库',
      kind: 'custom',
      builtin: false,
      storePath: 'C:/fake/broken/memory.json',
      enabled: true,
      dshProtected: false,
      allowInitializeWhenMissing: true,
      format: null,
      health: 'corrupted',
      healthDetail: 'Unexpected JSON token',
      lastCheckedAt: '2026-11-25T12:00:00.000Z',
      writable: true,
      configEditable: true,
    },
  ]

  const recordsByClient: Record<string, MemoryRecord[]> = {
    'dsh-default': [dshRecord],
    'agy-default': [agyRecord],
  }

  const currentClients = (): DesktopClientInfo[] =>
    baseClients.map((c) => ({
      ...c,
      writable: !c.dshProtected || guard.mode !== 'readonly-dsh-running',
    }))

  const migrationReport: ImportReport = {
    created: 2,
    skipped: 0,
    replaced: 1,
    episodesImported: 0,
    unmapped: [],
    redacted: 0,
    errors: [],
    operationId: 'mig-op-1',
  }

  const spies = {
    addClient: vi.fn(),
    forceUnlockDsh: vi.fn(),
    undoDream: vi.fn(),
    executeMigration: vi.fn(),
    updateConfig: vi.fn(),
    updatePreferences: vi.fn(),
    updateMemory: vi.fn(),
  }

  const bridge: DesktopBridgeApi = {
    clients: {
      list: () => ok(currentClients()),
      refreshAll: () => ok(currentClients()),
      add: (input) => {
        spies.addClient(input)
        const added: DesktopClientInfo = {
          id: 'custom-added',
          name: input.name,
          kind: 'custom',
          builtin: false,
          storePath: input.storePath,
          enabled: true,
          dshProtected: input.dshProtected ?? false,
          allowInitializeWhenMissing: true,
          format: 'agy-flat',
          health: 'ready',
          lastCheckedAt: '2026-11-25T12:00:00.000Z',
          writable: !(input.dshProtected ?? false),
          configEditable: !(input.dshProtected ?? false),
        }
        baseClients.push(added)
        recordsByClient[added.id] = []
        legacyCandidate = null
        return ok(added)
      },
      update: (input) => {
        const found = baseClients.find((c) => c.id === input.id)!
        return ok({ ...found, name: input.name ?? found.name })
      },
      remove: () => ok(true),
      getGuardSnapshot: () => ok(guard),
      refreshDshGuard: () => ok(guard),
      forceUnlockDsh: (req) => {
        spies.forceUnlockDsh(req)
        guard = {
          ...guard,
          mode: 'force-unlocked',
          reason: 'Force-unlocked for this session',
        }
        return ok(guard)
      },
      relockDsh: () => {
        guard = { ...guard, mode: 'readonly-dsh-running' }
        return ok(guard)
      },
      getLegacyAgyCandidate: () => ok(legacyCandidate),
    },
    memory: {
      overview: ({ clientId }) => {
        const list = recordsByClient[clientId] ?? []
        return ok({
          workspaceKey: 'all',
          counts: {
            active: list.filter((r) => r.status === 'active').length,
            pending: list.filter((r) => r.status === 'pending').length,
            archived: list.filter((r) => r.status === 'archived').length,
            stored: list.length,
          },
          pendingReview: 0,
          recentDream: clientId === 'dsh-default' ? dshDreams[0]! : null,
          index: { entries: list.length, bytes: 512 },
        })
      },
      list: ({ clientId, status, type, query }) => {
        let list = [...(recordsByClient[clientId] ?? [])]
        if (status !== undefined) list = list.filter((r) => r.status === status)
        if (type !== undefined) list = list.filter((r) => r.type === type)
        if (query !== undefined && query.trim() !== '') {
          const q = query.toLowerCase()
          list = list.filter(
            (r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q),
          )
        }
        return ok({ items: list, total: list.length, limit: 25, offset: 0, truncated: false })
      },
      view: ({ clientId, id }) => {
        const rec = (recordsByClient[clientId] ?? []).find((r) => r.id === id)
        if (!rec) return fail('memory/not-found', 'Not found')
        return ok({ record: rec, sources: rec.sourceRefs })
      },
      create: ({ clientId, title, body, type }) => {
        const rec = makeMemoryRecord({ id: MemoryId('new-1'), title, body, type })
        recordsByClient[clientId] = [...(recordsByClient[clientId] ?? []), rec]
        return ok(rec)
      },
      update: (req) => {
        spies.updateMemory(req)
        if (failExternalOnce) {
          failExternalOnce = false
          return fail('desktop/external-change', 'File changed externally')
        }
        const list = recordsByClient[req.clientId] ?? []
        const existing = list.find((r) => r.id === req.id)
        if (!existing) return fail('memory/not-found', 'Missing')
        const updated: MemoryRecord = {
          ...existing,
          title: req.title ?? existing.title,
          body: req.body ?? existing.body,
          contentRevision: existing.contentRevision + 1,
        }
        recordsByClient[req.clientId] = list.map((r) => (r.id === req.id ? updated : r))
        return ok(updated)
      },
      delete: () => ok({ deleted: true, record: null }),
      restore: ({ clientId, id }) => {
        const rec = (recordsByClient[clientId] ?? []).find((r) => r.id === id)!
        return ok({ ...rec, status: 'active' })
      },
      review: ({ clientId, id }) => {
        const rec = (recordsByClient[clientId] ?? []).find((r) => r.id === id)!
        return ok({ ...rec, status: 'active' })
      },
      listDreams: ({ clientId }) => ok(clientId === 'dsh-default' ? dshDreams : []),
      undoDream: ({ dreamId }) => {
        spies.undoDream(dreamId)
        return ok({ dreamId, undone: 2, skipped: 0, details: [] })
      },
      listAudit: ({ clientId }) => {
        const items = clientId === 'dsh-default' ? dshAudit : []
        return ok({ items, total: items.length, limit: 200, offset: 0 })
      },
      listWorkspaces: ({ clientId }) => ok(clientId === 'dsh-default' ? [wsA] : [wsB]),
      export: () =>
        ok({
          format: 'memloom',
          version: 1,
          exportedAt: '2026-11-25T12:00:00.000Z',
          scope: 'all',
          includeArchived: true,
          memories: [dshRecord],
          episodes: [],
        }),
      import: () => ok(migrationReport),
      rebuild: () =>
        ok({
          deleted: 0,
          retainedUser: 1,
          resetEpisodes: 0,
          resetCursors: 0,
          operationId: 'rb',
          errors: [],
        }),
      purgeAll: () => ok({ deleted: 0, deletedEpisodes: 0, operationId: 'pg', errors: [] }),
      getConfig: ({ clientId }) => {
        const c = baseClients.find((item) => item.id === clientId)!
        if (!c.configEditable) {
          return ok({
            editable: false,
            reason: 'DSH plugin configuration is managed by the DSH Profile.',
          })
        }
        return ok({
          editable: true,
          config: agyConfig,
          editableFields: AGY_EDITABLE_CONFIG_FIELDS,
        })
      },
      updateConfig: ({ patch }) => {
        spies.updateConfig(patch)
        agyConfig = { ...agyConfig, ...patch }
        return ok({
          editable: true,
          config: agyConfig,
          editableFields: AGY_EDITABLE_CONFIG_FIELDS,
        })
      },
    },
    aggregate: {
      search: (req) => {
        const q = req?.query?.toLowerCase() ?? ''
        const allowedIds = req?.clientIds ? new Set(req.clientIds) : null
        const allowedTypes = req?.types && req.types.length > 0 ? new Set(req.types) : null
        const items = [
          {
            clientId: 'dsh-default',
            clientName: 'DSH 默认',
            clientKind: 'dsh' as const,
            writable: guard.mode !== 'readonly-dsh-running',
            record: dshRecord,
            score: 1.0,
            normalizedScore: 1.0,
            snippet: dshRecord.body,
          },
          {
            clientId: 'agy-default',
            clientName: 'AGY 默认',
            clientKind: 'agy' as const,
            writable: true,
            record: agyRecord,
            score: 0.8,
            normalizedScore: 0.8,
            snippet: agyRecord.body,
          },
        ].filter((item) => {
          if (allowedIds !== null && !allowedIds.has(item.clientId)) return false
          if (allowedTypes !== null && !allowedTypes.has(item.record.type)) return false
          if (q !== '' && !item.record.title.toLowerCase().includes(q)) return false
          return true
        })
        return ok({
          items,
          total: items.length,
          limit: 20,
          offset: 0,
          truncated: false,
          skippedClients: [
            {
              id: 'custom-broken',
              name: '损坏旧库',
              health: 'corrupted',
              detail: 'Unexpected JSON token',
            },
          ],
        })
      },
      listWorkspaces: () =>
        ok({
          items: [wsA, wsB],
          byClient: [
            { ...wsA, clientId: 'dsh-default', clientName: 'DSH 默认' },
            { ...wsB, clientId: 'agy-default', clientName: 'AGY 默认' },
          ],
          skippedClients: [],
        }),
    },
    migration: {
      preview: (req) =>
        ok({
          sourceClientId: req.sourceClientId,
          targetClientId: req.targetClientId,
          targetWritable:
            req.targetClientId !== 'dsh-default' || guard.mode !== 'readonly-dsh-running',
          memoryCount: 1,
          episodeCount: 0,
          allowReplace: req.selection.kind === 'scope',
          sourceWorkspaces: [{ key: 'c:/ws/a', root: 'C:/ws/a', count: 1 }],
          suggestedMapping: { 'c:/ws/a': { key: 'c:/ws/a', root: 'C:/ws/a' } },
          targetWorkspaces: [wsB],
        }),
      execute: (req) => {
        spies.executeMigration(req)
        return ok(migrationReport)
      },
    },
    dialog: {
      pickMemoryFile: () => ok(null),
      pickDirectory: () => ok(null),
      pickImportJson: () => ok(null),
      saveExportJson: () => ok('C:/fake/export.json'),
    },
    app: {
      getInfo: () => ok({ version: '0.1.3', platform: 'win32', systemTheme: 'light' }),
      getPreferences: () => ok(prefs),
      updatePreferences: (patch) => {
        spies.updatePreferences(patch)
        prefs = { ...prefs, ...patch }
        return ok(prefs)
      },
      openExternal: () => ok(true),
      onFocusRefresh: () => () => undefined,
    },
  }

  return { bridge, spies }
}

describe('Desktop renderer core interactions', () => {
  it('renders left platform sidebar, right workspace header/category bar, language/theme controls, and legacy quick-add banner', async () => {
    const { bridge, spies } = createFakeBridge({
      legacyCandidate: 'C:/Users/demo/.gemini/antigravity/dsh-memory/memory.json',
    })
    const { container } = render(h(DesktopApp, { bridge }))

    await screen.findByText('全部客户端')
    expect(container.querySelector('.memloom-topbar')).toBeNull()
    expect(container.querySelector('aside.memloom-sidebar')).toBeTruthy()
    expect(container.querySelector('main.memloom-workspace')).toBeTruthy()
    expect(container.querySelector('.memloom-workspace-header .memloom-category-bar')).toBeTruthy()
    expect(container.querySelector('.memloom-content-scroll')).toBeTruthy()

    const nav = screen.getByRole('navigation')
    expect(within(nav).getByText('DSH 默认')).toBeTruthy()
    expect(within(nav).getByText('AGY 默认')).toBeTruthy()
    expect(screen.getByText('+ 添加库')).toBeTruthy()
    expect(screen.getByText('中 / EN')).toBeTruthy()
    expect(screen.getByText('切换暗色')).toBeTruthy()

    // Legacy dsh-memory banner + one-click add
    expect(screen.getByText(/检测到旧版 dsh-memory AGY 记忆库/)).toBeTruthy()
    fireEvent.click(screen.getByText('一键添加'))
    await waitFor(() => expect(spies.addClient).toHaveBeenCalledTimes(1))
    expect(spies.addClient.mock.calls[0]?.[0]).toMatchObject({
      storePath: 'C:/Users/demo/.gemini/antigravity/dsh-memory/memory.json',
      dshProtected: false,
    })

    // Theme toggle persists preference and sets data-theme attribute
    fireEvent.click(screen.getByText('切换暗色'))
    await waitFor(() => expect(spies.updatePreferences).toHaveBeenCalledWith({ theme: 'dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('guards DSH in readonly mode, confirms forceUnlockDsh, and preserves draft on desktop/external-change', async () => {
    const { bridge, spies } = createFakeBridge({ failNextUpdateWithExternalChange: true })
    render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    // Read-only guard banner shown and write entry disabled
    expect(screen.getByText(/DSH 正在运行，已对受保护 DSH 库启用只读保护/)).toBeTruthy()
    const newBtn = screen.getByRole('button', { name: '新建记忆' }) as HTMLButtonElement
    expect(newBtn.disabled).toBe(true)

    // Opening a memory in read-only mode shows no Edit/Archive buttons
    fireEvent.click(screen.getByText('DSH Lesson'))
    await screen.findByText(/当前处于只读保护模式/)
    expect(screen.queryByText('编辑')).toBeNull()
    expect(screen.queryByText('归档')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    // Clicking Force Unlock opens confirmation modal BEFORE calling forceUnlockDsh
    fireEvent.click(screen.getByText('强制解锁'))
    expect(spies.forceUnlockDsh).not.toHaveBeenCalled()
    expect(screen.getByText('确认强制解锁 DSH 写保护')).toBeTruthy()
    fireEvent.click(screen.getByText('确认强制解锁'))

    await waitFor(() => expect(spies.forceUnlockDsh).toHaveBeenCalledWith({ confirmed: true }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '新建记忆' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )

    // Now edit DSH Lesson and trigger desktop/external-change: draft must survive + refresh banner appears
    fireEvent.click(screen.getByText('DSH Lesson'))
    await screen.findByText('编辑')
    fireEvent.click(screen.getByText('编辑'))
    const titleInput = screen.getByLabelText('标题') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: 'Unsaved External Draft' } })
    fireEvent.click(screen.getByText('保存'))

    await screen.findByText(/磁盘上的 DSH 记忆库已被外部修改/)
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Unsaved External Draft')
  })

  it('renders read-only All Clients aggregate view with skipped client warning, open-in-client, and merge-locked copy', async () => {
    const { bridge } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    await screen.findByText('全部客户端')
    fireEvent.click(screen.getByText('全部客户端'))

    await screen.findByText('全部客户端聚合检索')
    expect(screen.getByText(/以下客户端状态异常，本次聚合已跳过.*损坏旧库/)).toBeTruthy()
    expect(screen.getByText('AGY Wiki Note')).toBeTruthy()

    // Read-only detail modal has no Edit button and provides Open in client + Copy to another client
    fireEvent.click(screen.getByText('AGY Wiki Note'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('编辑')).toBeNull()

    // Click "复制到其他客户端…" from aggregate modal -> single migration wizard locked to Merge
    fireEvent.click(within(dialog).getByText('复制到其他客户端…'))
    await screen.findByText('复制记忆到其他客户端')
    expect(screen.getByText(/单条\/多选直迁严格锁定为合并/)).toBeTruthy()
    expect(screen.queryByText('替换目标作用域（Replace）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    // Top horizontal category bar filters aggregate results by memory type
    fireEvent.click(screen.getByRole('tab', { name: '知识' }))
    await waitFor(() => expect(screen.queryByText('DSH Lesson')).toBeNull())
    expect(screen.getByText('AGY Wiki Note')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '全部类型' }))
    await screen.findByText('DSH Lesson')

    // Click "在所属客户端中打开" -> switches to AGY client and opens memory detail
    const agyRow = screen.getByText('AGY Wiki Note').closest('li')!
    fireEvent.click(within(agyRow).getByText('在所属客户端中打开'))
    await screen.findByRole('dialog', { name: 'AGY Wiki Note' })
  })

  it('renders Dreams & Audit tab without LLM Dream trigger, supports undoDream and action filter', async () => {
    const { bridge, spies } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    // Unlock first so undoDream button is enabled
    fireEvent.click(screen.getByText('强制解锁'))
    fireEvent.click(screen.getByText('确认强制解锁'))
    await waitFor(() => expect(spies.forceUnlockDsh).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('tab', { name: /整理与审计/ }))
    await screen.findByText('dream-run-1')
    expect(screen.queryByText('立即整理')).toBeNull()
    expect(screen.queryByText('立即运行 LLM Dream')).toBeNull()

    fireEvent.click(screen.getByText('撤销该次整理'))
    await waitFor(() => expect(spies.undoDream).toHaveBeenCalledWith('dream-run-1'))

    // Filter audit timeline by action
    await screen.findByText('dream-commit')
    expect(screen.getByText('create')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('操作类型'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'dream-commit' }))
    expect(screen.queryByText('create')).toBeNull()
    expect(screen.getAllByText('dream-commit').length).toBeGreaterThanOrEqual(2)
  })

  it('blocks replace migration when any source workspace is skipped and executes after full mapping + confirm', async () => {
    const { bridge, spies } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    fireEvent.click(screen.getByText('跨库迁移'))
    await screen.findByText('跨客户端迁移向导')

    // Choose Replace mode
    fireEvent.click(screen.getByLabelText('迁移模式'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '替换目标作用域（Replace）' }))
    fireEvent.click(screen.getByText('下一步：预览与工作区映射'))

    await screen.findByText('工作区路径映射')
    // Skip the source workspace -> execute button must disable + show replaceNoSkipError
    fireEvent.click(screen.getByLabelText('c:/ws/a: 工作区路径映射'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '跳过不导入' }))
    expect(screen.getByText(/Replace 模式下禁止跳过任何源工作区/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '执行迁移' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    // Re-map to target workspace C:/ws/b, then confirm replace wipe
    fireEvent.click(screen.getByLabelText('c:/ws/a: 工作区路径映射'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'C:/ws/b' }))
    const execBtn = screen.getByRole('button', { name: '执行迁移' }) as HTMLButtonElement
    expect(execBtn.disabled).toBe(false)
    fireEvent.click(execBtn)

    await screen.findByText(/高危确认：Replace 模式将先清空/)
    fireEvent.click(screen.getByText('确认清空并执行迁移'))

    await waitFor(() => expect(spies.executeMigration).toHaveBeenCalledTimes(1))
    expect(spies.executeMigration.mock.calls[0]?.[0]).toMatchObject({
      mode: 'replace',
      confirm: true,
      targetScope: 'all',
    })
    await screen.findByText('迁移完成报告')
    expect(screen.getByText(/新增 2，跳过 0，替换 1/)).toBeTruthy()
  })

  it('renders 23-field AGY config with safety confirm and read-only card for DSH', async () => {
    const { bridge, spies } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    // DSH Settings shows read-only card
    await screen.findByText('DSH Lesson')
    fireEvent.click(screen.getByRole('tab', { name: /设置/ }))
    await screen.findByText('DSH 配置由 DSH Profile 管理')

    // Switch to AGY -> shows all 23 fields, no DSH model selection fields
    fireEvent.click(screen.getByText('AGY 默认'))
    await screen.findByText('AGY Wiki Note')
    fireEvent.click(screen.getByRole('tab', { name: /设置/ }))
    await screen.findByText('启用记忆插件')
    expect(screen.queryByText('dream 模型模式')).toBeNull()
    expect(screen.getByLabelText('默认检索返回上限')).toBeTruthy()
    expect(screen.getByLabelText('单次增量刷新字节上限')).toBeTruthy()

    // Disabling redactSecrets requires confirmation before calling updateConfig
    fireEvent.click(screen.getByRole('switch', { name: /秘密脱敏/ }))
    fireEvent.click(screen.getByText('保存'))
    expect(spies.updateConfig).not.toHaveBeenCalled()
    expect(screen.getByText('安全与自动化风险确认')).toBeTruthy()
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(spies.updateConfig).toHaveBeenCalledTimes(1))
    expect(spies.updateConfig.mock.calls[0]?.[0]).toMatchObject({ redactSecrets: false })
  })

  it('switches zh/en immediately across topbar and child components', async () => {
    const { bridge, spies } = createFakeBridge({ initialLocale: 'zh' })
    render(h(DesktopApp, { bridge }))

    await screen.findByText('全部客户端')
    fireEvent.click(screen.getByText('中 / EN'))

    await screen.findByText('All Clients')
    expect(screen.getByText('+ Add Store')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Memories/ })).toBeTruthy()
    expect(spies.updatePreferences).toHaveBeenCalledWith({ locale: 'en' })
  })
})

describe('theme.css & desktopErrorText contracts', () => {
  it('defines all 32 --dsw-* variables in theme.css for both light and dark themes', () => {
    const stylesSrc = readFileSync(resolve(root, 'src/client/styles.ts'), 'utf8')
    const themeCss = readFileSync(resolve(root, 'src/desktop/renderer/theme.css'), 'utf8')
    const tokens = [
      ...new Set(
        (stylesSrc.match(/--dsw-[a-z0-9-]+/g) ?? []).filter((name) => !name.endsWith('-')),
      ),
    ]
    expect(tokens.length).toBe(32)
    for (const token of tokens) {
      expect(themeCss).toContain(token)
    }
    expect(themeCss).toMatch(/\[data-theme=['"]light['"]\]/)
    expect(themeCss).toMatch(/\[data-theme=['"]dark['"]\]/)
  })

  it('defines dual-pane App Shell layout, single scroll container, and custom capsule scrollbars in theme.css', () => {
    const themeCss = readFileSync(resolve(root, 'src/desktop/renderer/theme.css'), 'utf8')
    expect(themeCss).toContain('.memloom-sidebar')
    expect(themeCss).toContain('.memloom-workspace')
    expect(themeCss).toContain('.memloom-category-bar')
    expect(themeCss).toContain('.memloom-content-scroll')
    expect(themeCss).toContain('::-webkit-scrollbar')
    expect(themeCss).toContain('::-webkit-scrollbar-thumb')
    expect(themeCss).toContain('.memloom-shell .dsh-mem-list-full')
    expect(themeCss).toContain('.memloom-shell .dsh-mem-rows')
    expect(themeCss).not.toContain('.memloom-topbar')
  })

  it('localizes all 6 desktop/* error codes and falls back to client errors', () => {
    applyDesktopLocale('zh')
    expect(desktopErrorText({ code: 'desktop/readonly-guard', message: 'raw' })).toContain(
      '只读保护',
    )
    expect(desktopErrorText({ code: 'desktop/external-change', message: 'raw' })).toContain(
      '外部进程修改',
    )
    expect(desktopErrorText({ code: 'desktop/store-corrupt', message: 'bad json' })).toContain(
      'bad json',
    )
    expect(desktopErrorText({ code: 'desktop/unsupported', message: 'raw' })).toContain('不支持')
    expect(desktopErrorText({ code: 'desktop/invalid-args', message: 'raw' })).toContain('无效')
    expect(desktopErrorText({ code: 'desktop/internal', message: 'boom' })).toContain('boom')
    expect(desktopErrorText({ code: 'memory/conflict', message: 'raw' })).toContain('重新读取')
  })

  it('configures index.html with strict CSP and non-module deferred script for file:// loading', () => {
    const html = readFileSync(resolve(root, 'src/desktop/renderer/index.html'), 'utf8')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'self'")
    expect(html).toContain('href="./theme.css"')
    expect(html).toContain('<script defer src="./index.js"></script>')
    expect(html).not.toContain('type="module"')
  })

  it('supports zero-arg DesktopApp() and h(DesktopApp) typing', () => {
    const typeOnlyCheck = (): React.ReactElement => h(DesktopApp)
    expect(typeof typeOnlyCheck).toBe('function')
    expect(typeof DesktopApp).toBe('function')
    // Ensure DesktopApp() accepts zero arguments at type level as well:
    const zeroArgCheck: () => React.ReactElement = () => DesktopApp()
    expect(typeof zeroArgCheck).toBe('function')
  })
})
