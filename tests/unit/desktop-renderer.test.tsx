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
import { DesktopConfigPanel } from '../../src/desktop/renderer/DesktopConfigPanel.tsx'
import { ReviewView } from '../../src/desktop/renderer/ReviewView.tsx'
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
  includePendingProposal?: boolean
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
      pluginStatus: {
        state: 'enabled',
        installed: true,
        enabled: true,
        version: '0.2.1',
        pluginName: 'dsh-memory',
        installPath: 'C:/fake/dsh/profile/node_modules/dsh-memory',
      },
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
      pluginStatus: {
        state: 'not-installed',
        installed: false,
        enabled: false,
        detail: 'Plugin is not installed under ~/.gemini/config/plugins.',
      },
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

  const agyPendingProposal: MemoryRecord = makeMemoryRecord({
    id: MemoryId('agy-prop-1'),
    title: 'AGY Pending Proposal',
    type: 'lesson',
    status: 'pending',
    ownership: 'derived',
    origin: 'dream',
    body: 'Prefer atomic write locks.',
    supersedes: ['agy-mem-1'],
    updatedAt: '2026-11-26T10:00:00.000Z',
  })

  const recordsByClient: Record<string, MemoryRecord[]> = {
    'dsh-default': [dshRecord],
    'agy-default':
      options?.includePendingProposal === true ? [agyRecord, agyPendingProposal] : [agyRecord],
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
    review: vi.fn(),
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
      list: ({ clientId, workspaceKey, status, type, query }) => {
        let list = [...(recordsByClient[clientId] ?? [])]
        const target = workspaceKey === undefined ? null : workspaceKey
        if (target === null) {
          list = list.filter((r) => r.scope.kind === 'global')
        } else if (target !== 'all') {
          list = list.filter(
            (r) =>
              r.scope.kind === 'global' || (r.scope.kind === 'workspace' && r.scope.key === target),
          )
        }
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
      review: ({ clientId, id, action }) => {
        spies.review(clientId, id, action)
        const rec = (recordsByClient[clientId] ?? []).find((r) => r.id === id)!
        const nextStatus = action === 'accept' ? 'active' : 'archived'
        recordsByClient[clientId] = (recordsByClient[clientId] ?? []).map((r) =>
          r.id === id ? { ...r, status: nextStatus } : r,
        )
        return ok({ ...rec, status: nextStatus })
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
        const allowedStatuses =
          req?.statuses && req.statuses.length > 0 ? new Set(req.statuses) : null
        const items = currentClients()
          .filter((client) => client.health === 'ready')
          .flatMap((client) =>
            (recordsByClient[client.id] ?? []).map((record) => ({
              clientId: client.id,
              clientName: client.name,
              clientKind: client.kind,
              writable: client.writable,
              record,
              score: record.id === dshRecord.id ? 1.0 : 0.8,
              normalizedScore: record.id === dshRecord.id ? 1.0 : 0.8,
              snippet: record.body,
            })),
          )
          .filter((item) => {
            if (allowedIds !== null && !allowedIds.has(item.clientId)) return false
            if (allowedTypes !== null && !allowedTypes.has(item.record.type)) return false
            if (allowedStatuses !== null && !allowedStatuses.has(item.record.status)) return false
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
      pickDshCli: () => ok(null),
    },
    plugins: {
      listDshProfiles: () => ok([]),
      install: () =>
        ok({
          kind: 'agy',
          action: 'install',
          pluginStatus: { state: 'enabled', installed: true, enabled: true, version: '0.2.2' },
          restartRequired: true,
          warnings: [],
        }),
      uninstall: () =>
        ok({
          kind: 'agy',
          action: 'uninstall',
          pluginStatus: { state: 'not-installed', installed: false, enabled: false },
          restartRequired: true,
          warnings: [],
        }),
      syncPending: () =>
        ok({ phase: 'idle', pendingSync: null, updatedAt: '2026-11-27T00:00:00.000Z' }),
      dismissPendingSync: () =>
        ok({ phase: 'idle', pendingSync: null, updatedAt: '2026-11-27T00:00:00.000Z' }),
    },
    updater: {
      check: () =>
        ok({
          currentVersion: '0.2.2',
          latestVersion: '0.2.2',
          hasUpdate: false,
          releaseUrl: 'https://github.com/JiaMingWang-CN/memloom/releases/tag/v0.2.2',
          releaseNotes: '',
          runtimeMode: 'electron',
          canSelfUpdateApp: false,
          assets: {},
          installedTargets: [],
        }),
      getState: () =>
        ok({ phase: 'idle', pendingSync: null, updatedAt: '2026-11-27T00:00:00.000Z' }),
      cancel: () =>
        ok({ phase: 'cancelled', pendingSync: null, updatedAt: '2026-11-27T00:00:00.000Z' }),
      startAppUpdate: () =>
        ok({ phase: 'checking', pendingSync: null, updatedAt: '2026-11-27T00:00:00.000Z' }),
      updateInstalledPluginsOnline: () =>
        ok({ phase: 'checking', pendingSync: null, updatedAt: '2026-11-27T00:00:00.000Z' }),
    },
    app: {
      getInfo: () =>
        ok({
          version: '0.2.2',
          platform: 'win32',
          systemTheme: 'light',
          runtimeMode: 'electron',
          bundledPluginsAvailable: true,
        }),
      getPreferences: () => ok(prefs),
      updatePreferences: (patch) => {
        spies.updatePreferences(patch)
        const prev = prefs as {
          theme: 'system' | 'light' | 'dark'
          locale: 'zh' | 'en'
          windowBounds?: { x: number; y: number; width: number; height: number }
          dshCliPath?: string
        }
        const nextDshCliPath =
          patch.dshCliPath === undefined
            ? prev.dshCliPath
            : patch.dshCliPath === null || patch.dshCliPath.trim() === ''
              ? undefined
              : patch.dshCliPath
        prefs = {
          theme: patch.theme ?? prev.theme,
          locale: patch.locale ?? prev.locale,
          ...(patch.windowBounds !== undefined
            ? { windowBounds: patch.windowBounds }
            : prev.windowBounds !== undefined
              ? { windowBounds: prev.windowBounds }
              : {}),
          ...(nextDshCliPath !== undefined ? { dshCliPath: nextDshCliPath } : {}),
        }
        return ok(prefs)
      },
      openExternal: () => ok(true),
      onFocusRefresh: () => () => undefined,
    },
  }

  return { bridge, spies }
}

describe('Desktop renderer core interactions', () => {
  it('renders floating island shell, horizontal logo, equal DSH/AGY hosts, zero native controls, theme/locale controls, and legacy quick-add', async () => {
    const { bridge, spies } = createFakeBridge({
      legacyCandidate: 'C:/Users/demo/.gemini/antigravity/dsh-memory/memory.json',
    })
    const { container } = render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    expect(container.querySelector('.memloom-shell')).toBeTruthy()
    expect(container.querySelector('aside.memloom-rail')).toBeTruthy()
    expect(container.querySelector('main.memloom-stage')).toBeTruthy()
    expect(container.querySelector('.memloom-logo-svg')).toBeTruthy()

    // Official vector host logos for DSH and AGY (with unique SVG clipPath IDs per instance)
    const dshLogos = container.querySelectorAll('svg[data-host-logo="dsh"]')
    const agyLogos = container.querySelectorAll('svg[data-host-logo="agy"]')
    expect(dshLogos.length).toBeGreaterThanOrEqual(2)
    expect(agyLogos.length).toBeGreaterThanOrEqual(2)
    const svgDefIds = Array.from(
      container.querySelectorAll('svg[data-host-logo="agy"] clipPath[id]'),
    ).map((el) => el.getAttribute('id'))
    expect(new Set(svgDefIds).size).toBe(svgDefIds.length)

    // Zero native <select>, <input type="checkbox|radio|range">, or <input type="number">
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container.querySelector('input[type="radio"]')).toBeNull()
    expect(container.querySelector('input[type="range"]')).toBeNull()
    expect(container.querySelector('input[type="number"]')).toBeNull()

    const nav = screen.getByRole('navigation')
    expect(within(nav).getByText('DSH 默认')).toBeTruthy()
    expect(within(nav).getByText('AGY 默认')).toBeTruthy()
    expect(within(nav).queryByText('+ 添加库')).toBeNull()

    // Legacy dsh-memory banner + one-click add
    expect(screen.getByText(/检测到旧版 dsh-memory AGY 记忆库/)).toBeTruthy()
    fireEvent.click(screen.getByText('一键添加'))
    await waitFor(() => expect(spies.addClient).toHaveBeenCalledTimes(1))
    expect(spies.addClient.mock.calls[0]?.[0]).toMatchObject({
      storePath: 'C:/Users/demo/.gemini/antigravity/dsh-memory/memory.json',
      dshProtected: false,
    })

    // Theme segmented toggle persists preference and sets data-theme
    fireEvent.click(screen.getByRole('button', { name: '深色' }))
    await waitFor(() => expect(spies.updatePreferences).toHaveBeenCalledWith({ theme: 'dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('guards DSH in readonly mode, confirms forceUnlockDsh, and preserves draft on desktop/external-change', async () => {
    const { bridge, spies } = createFakeBridge({ failNextUpdateWithExternalChange: true })
    render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    // Switch to DSH host
    const nav = screen.getByRole('navigation')
    fireEvent.click(within(nav).getByText('DSH 默认'))

    await screen.findByText(/DSH 正在运行，已对受保护 DSH 库启用只读保护/)
    const editBtn = screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement
    expect(editBtn.disabled).toBe(true)

    // Clicking Force Unlock opens confirmation modal BEFORE calling forceUnlockDsh
    fireEvent.click(screen.getByText('强制解锁'))
    expect(spies.forceUnlockDsh).not.toHaveBeenCalled()
    expect(screen.getByText('确认强制解锁 DSH 写保护')).toBeTruthy()
    fireEvent.click(screen.getByText('确认强制解锁'))

    await waitFor(() => expect(spies.forceUnlockDsh).toHaveBeenCalledWith({ confirmed: true }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )

    // Edit DSH Lesson and trigger desktop/external-change: draft must survive + refresh banner appears
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const titleInput = screen.getByLabelText('标题') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: 'Unsaved External Draft' } })
    fireEvent.click(screen.getByText('保存'))

    await screen.findByText(/磁盘上的 DSH 记忆库已被外部修改/)
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Unsaved External Draft')
  })

  it('renders unified MemoriesView with skipped client warning, open-in-host, and merge-locked migration', async () => {
    const { bridge } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    await screen.findByText('AGY Wiki Note')
    expect(screen.getByText(/以下客户端状态异常，本次聚合已跳过.*损坏旧库/)).toBeTruthy()

    // Select AGY Wiki Note and open in belonging host
    fireEvent.click(screen.getByText('AGY Wiki Note'))
    fireEvent.click(await screen.findByRole('button', { name: '在所属宿主中打开' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '在所属宿主中打开' })).toBeNull(),
    )

    // Category filter works in MemoriesView
    fireEvent.click(screen.getByRole('tab', { name: '教训' }))
    await waitFor(() => expect(screen.queryByText('AGY Wiki Note')).toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: '全部类型' }))
    await screen.findByText('AGY Wiki Note')

    // Click Migrate from inspector -> switches to MigrationView locked to Merge
    await waitFor(() => expect(document.querySelector('.ml-inspector-footer')).toBeTruthy())
    const inspectorFooter = document.querySelector('.ml-inspector-footer') as HTMLElement
    fireEvent.click(within(inspectorFooter).getByRole('button', { name: '跨端迁移' }))
    await screen.findByText(/单条\/多选直迁严格锁定为合并/)
  })

  it('renders Review Inbox with supersedes diff comparison and approval action', async () => {
    const { bridge, spies } = createFakeBridge({ includePendingProposal: true })
    render(h(DesktopApp, { bridge }))

    await screen.findByText('AGY Wiki Note')
    const nav = screen.getByRole('navigation')
    fireEvent.click(within(nav).getByText('待审阅提案'))

    await screen.findByText('AGY Pending Proposal')
    expect(await screen.findByText('版本替代对比：批准后自动归档旧条目并激活新版本')).toBeTruthy()
    expect(screen.getByText('原记忆')).toBeTruthy()
    expect(screen.getByText('提案内容')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /批准并转为永久记忆/ }))
    await waitFor(() =>
      expect(spies.review).toHaveBeenCalledWith('agy-default', 'agy-prop-1', 'accept'),
    )
  })

  it('renders Dreams & Audit view without LLM Dream trigger, supports undoDream and action filter', async () => {
    const { bridge, spies } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    // Unlock first so undoDream button is enabled
    fireEvent.click(screen.getByText('强制解锁'))
    fireEvent.click(screen.getByText('确认强制解锁'))
    await waitFor(() => expect(spies.forceUnlockDsh).toHaveBeenCalled())

    const nav = screen.getByRole('navigation')
    fireEvent.click(within(nav).getByText('整理与审计'))
    await screen.findByText('dream-run-1')
    expect(screen.queryByText('立即整理')).toBeNull()
    expect(screen.queryByText('立即运行 LLM Dream')).toBeNull()

    fireEvent.click(screen.getByText('撤销该次整理'))
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => expect(spies.undoDream).toHaveBeenCalledWith('dream-run-1'))

    // Filter audit timeline by action
    fireEvent.click(screen.getByRole('tab', { name: '只读审计时间线' }))
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
    const nav = screen.getByRole('navigation')
    fireEvent.click(within(nav).getByText('跨端迁移'))

    fireEvent.click(screen.getByText('下一步：预览与工作区映射'))
    await screen.findByText('工作区路径映射')

    // Choose Replace mode
    fireEvent.click(screen.getByText('替换目标作用域（Replace）'))

    // Skip the source workspace -> replaceNoSkipError shown and Next disabled
    fireEvent.click(screen.getByLabelText('c:/ws/a: 工作区路径映射'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '跳过不导入' }))
    expect(screen.getByText(/Replace 模式下禁止跳过任何源工作区/)).toBeTruthy()

    // Re-map to C:/ws/b and acknowledge replace risk
    fireEvent.click(screen.getByLabelText('c:/ws/a: 工作区路径映射'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'C:/ws/b' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '确认' }))
    fireEvent.click(screen.getByText('下一步：预览与工作区映射'))

    fireEvent.click(await screen.findByRole('button', { name: '执行迁移' }))
    await screen.findByText(/高危确认：Replace 模式将先清空/)
    fireEvent.click(screen.getByText('确认清空并执行迁移'))

    await waitFor(() => expect(spies.executeMigration).toHaveBeenCalledTimes(1))
    expect(spies.executeMigration.mock.calls[0]?.[0]).toMatchObject({
      mode: 'replace',
      confirm: true,
      targetScope: 'all',
    })
    await screen.findByText('迁移完成报告')
    expect(screen.getAllByText(/新增 2，跳过 0，替换 1/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders 24-field AGY config with subagent model selector, plugin status, detented slider + safety confirm, and read-only card for DSH', async () => {
    const { bridge, spies } = createFakeBridge()
    render(h(DesktopApp, { bridge }))

    await screen.findByText('DSH Lesson')
    const nav = screen.getByRole('navigation')
    // Sidebar displays AGY not-installed status label and DSH enabled tooltip
    expect(within(nav).getByText('未安装')).toBeTruthy()
    fireEvent.click(within(nav).getByText('宿主配置'))

    // Default focuses AGY: shows 24 fields, plugin status badge, subagent model selector, detented slider, no DSH model selection fields
    await screen.findByText('启用记忆插件')
    expect(screen.getAllByText('未安装').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('dream 模型模式')).toBeNull()
    expect(screen.getByRole('slider', { name: '索引大小上限（字节）' })).toBeTruthy()
    expect(screen.getByLabelText('默认检索返回上限')).toBeTruthy()
    expect(screen.getByRole('group', { name: '整理子代理模型档位' })).toBeTruthy()

    // Select Flash Lite subagent model and disable redactSecrets -> requires confirmation before calling updateConfig
    fireEvent.click(screen.getByRole('button', { name: 'Flash Lite' }))
    fireEvent.click(screen.getByRole('switch', { name: '秘密脱敏' }))
    fireEvent.click(await screen.findByRole('button', { name: '保存' }))
    expect(spies.updateConfig).not.toHaveBeenCalled()
    expect(screen.getByText('安全与自动化风险确认')).toBeTruthy()
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(spies.updateConfig).toHaveBeenCalledTimes(1))
    expect(spies.updateConfig.mock.calls[0]?.[0]).toMatchObject({
      redactSecrets: false,
      dreamSubagentModel: 'flash_lite',
    })

    // Switch to DSH tab -> shows enabled plugin status badge, read-only profile card, and WriteGuard controls
    fireEvent.click(screen.getByRole('tab', { name: 'DSH 默认' }))
    await screen.findByText('DSH 配置由 DSH Profile 管理')
    expect(screen.getByText('已启用 v0.2.1')).toBeTruthy()
    expect(screen.getByText('DSH 并发写保护状态机')).toBeTruthy()
  })

  it('switches zh/en immediately across rail and views, and opens Ctrl+K command palette', async () => {
    const { bridge, spies } = createFakeBridge({ initialLocale: 'zh' })
    render(h(DesktopApp, { bridge }))

    await screen.findByText('全部记忆')
    fireEvent.click(screen.getByText('中 / EN'))

    await screen.findByText('All Memories')
    expect(screen.getByText('Review Inbox')).toBeTruthy()
    expect(spies.updatePreferences).toHaveBeenCalledWith({ locale: 'en' })

    // Ctrl+K opens Command Palette
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(
      await screen.findByPlaceholderText('Search views, hosts, or quick actions…'),
    ).toBeTruthy()
  })
})

describe('theme.css & desktopErrorText contracts', () => {
  it('defines Memloom --ml-* tokens for both light and dark themes without --dsw-* coupling', () => {
    const themeCss = readFileSync(resolve(root, 'src/desktop/renderer/theme.css'), 'utf8')
    expect(themeCss).toContain('--ml-shell-bg')
    expect(themeCss).toContain('--ml-stage-bg')
    expect(themeCss).toContain('--ml-copper')
    expect(themeCss).toContain('--ml-dsh')
    expect(themeCss).toContain('--ml-agy')
    expect(themeCss).not.toContain('--dsw-')
    expect(themeCss).toMatch(/\[data-theme=['"]light['"]\]/)
    expect(themeCss).toMatch(/\[data-theme=['"]dark['"]\]/)
  })

  it('defines floating island shell layout, custom scrollbars, and zero native form control selectors', () => {
    const themeCss = readFileSync(resolve(root, 'src/desktop/renderer/theme.css'), 'utf8')
    expect(themeCss).toContain('.memloom-shell')
    expect(themeCss).toContain('.memloom-rail')
    expect(themeCss).toContain('.memloom-stage')
    expect(themeCss).toContain('.ml-weft-bridge')
    expect(themeCss).toContain('::-webkit-scrollbar')
    expect(themeCss).toContain('::-webkit-scrollbar-thumb')
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
    const zeroArgCheck: () => React.ReactElement = () => DesktopApp()
    expect(typeof zeroArgCheck).toBe('function')
  })

  it('ignores Ctrl/Meta/Alt modified keys in ReviewView shortcuts while accepting plain A', async () => {
    applyDesktopLocale('zh')
    const { bridge, spies } = createFakeBridge({ includePendingProposal: true })
    const clientsRes = await bridge.clients.list()
    expect(clientsRes.ok).toBe(true)
    const clients = clientsRes.ok ? clientsRes.value : []

    render(
      h(ReviewView, {
        bridge,
        clients,
        refreshToken: 0,
        onDataChanged: async () => undefined,
        onExternalChange: () => undefined,
        onPendingCountChange: () => undefined,
        onOpenMemories: () => undefined,
        onNotify: () => undefined,
      }),
    )

    await waitFor(() => {
      expect(screen.getByText('批准并转为永久记忆')).toBeTruthy()
    })

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'r', metaKey: true })
    fireEvent.keyDown(window, { key: 'e', altKey: true })
    expect(spies.review).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'a' })
    await waitFor(() => {
      expect(spies.review).toHaveBeenCalledTimes(1)
    })
  })

  it('preserves unsaved AGY config draft across refreshToken updates on the same host', async () => {
    applyDesktopLocale('zh')
    const { bridge } = createFakeBridge()
    const clientsRes = await bridge.clients.list()
    expect(clientsRes.ok).toBe(true)
    const agyClients = (clientsRes.ok ? clientsRes.value : []).filter((c) => c.kind === 'agy')
    expect(agyClients.length).toBeGreaterThan(0)

    const propsBase = {
      bridge,
      clients: agyClients,
      onRecheckGuard: async () => undefined,
      onRequestUnlockDsh: () => undefined,
      onRelockDsh: async () => undefined,
      onDataChanged: async () => undefined,
      onExternalChange: () => undefined,
      onNotify: () => undefined,
    }

    const view = render(h(DesktopConfigPanel, { ...propsBase, refreshToken: 0 }))

    const switches = await waitFor(() => {
      const els = screen.getAllByRole('switch')
      expect(els.length).toBeGreaterThan(0)
      return els
    })
    const firstSwitch = switches[0]!
    const initialChecked = firstSwitch.getAttribute('aria-checked')
    const toggledChecked = initialChecked === 'true' ? 'false' : 'true'

    fireEvent.click(firstSwitch)
    await waitFor(() => {
      expect(screen.getAllByRole('switch')[0]!.getAttribute('aria-checked')).toBe(toggledChecked)
    })

    view.rerender(h(DesktopConfigPanel, { ...propsBase, refreshToken: 1 }))

    await waitFor(() => {
      expect(screen.getAllByRole('switch')[0]!.getAttribute('aria-checked')).toBe(toggledChecked)
    })
  })

  it('loads workspace-scoped pending proposals in ReviewView with workspaceKey="all" and shows all statuses by default in MemoriesView', async () => {
    applyDesktopLocale('zh')
    const { bridge } = createFakeBridge({ includePendingProposal: true })
    const listSpy = vi.spyOn(bridge.memory, 'list')
    const onPendingCountChange = vi.fn()

    const { container } = render(h(DesktopApp, { bridge }))
    await screen.findByText('AGY Pending Proposal')

    const nav = screen.getByRole('navigation')
    // Sidebar displays stored totals (2 for AGY with active + pending, 1 for DSH) and pending badge (1)
    expect(
      within(within(nav).getByRole('button', { name: /AGY 默认/ })).getByText('2'),
    ).toBeTruthy()
    expect(
      within(within(nav).getByRole('button', { name: /DSH 默认/ })).getByText('1'),
    ).toBeTruthy()
    expect(
      within(within(nav).getByRole('button', { name: /待审阅提案/ })).getByText('1'),
    ).toBeTruthy()

    const clientsRes = await bridge.clients.list()
    const clients = clientsRes.ok ? clientsRes.value : []
    render(
      h(ReviewView, {
        bridge,
        clients,
        refreshToken: 0,
        onDataChanged: async () => undefined,
        onExternalChange: () => undefined,
        onPendingCountChange,
        onOpenMemories: () => undefined,
        onNotify: () => undefined,
      }),
    )

    await waitFor(() => expect(onPendingCountChange).toHaveBeenCalledWith(1))
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: 'all',
        status: 'pending',
      }),
    )
    expect(container.querySelector('.ml-row-status-pill[data-status="pending"]')).toBeTruthy()
  })

  it('supports AGY one-click install/uninstall with data-safety confirmation and DSH profile selection/running guard', async () => {
    applyDesktopLocale('zh')
    const { bridge } = createFakeBridge()
    const installSpy = vi.spyOn(bridge.plugins, 'install')
    const uninstallSpy = vi.spyOn(bridge.plugins, 'uninstall')
    vi.spyOn(bridge.plugins, 'listDshProfiles').mockResolvedValue({
      ok: true,
      value: [
        {
          name: 'desktop',
          pluginStatus: { state: 'enabled', installed: true, enabled: true, version: '0.2.1' },
        },
        {
          name: 'work',
          pluginStatus: { state: 'not-installed', installed: false, enabled: false },
        },
      ],
    })

    const clientsRes = await bridge.clients.list()
    const clients = clientsRes.ok ? clientsRes.value : []
    const agyNotInstalled = clients.map((c) =>
      c.kind === 'agy'
        ? {
            ...c,
            pluginStatus: { state: 'not-installed' as const, installed: false, enabled: false },
          }
        : c,
    )

    // 1. AGY one-click install with confirmation mentioning memory data is preserved
    const { rerender } = render(
      h(DesktopConfigPanel, {
        bridge,
        clients: agyNotInstalled,
        appInfo: {
          version: '0.2.2',
          platform: 'win32',
          runtimeMode: 'electron',
          bundledPluginsAvailable: true,
        },
        refreshToken: 0,
        onRecheckGuard: async () => undefined,
        onRequestUnlockDsh: () => undefined,
        onRelockDsh: async () => undefined,
        onDataChanged: async () => undefined,
        onExternalChange: () => undefined,
        onNotify: () => undefined,
      }),
    )

    const installBtn = await screen.findByRole('button', { name: /一键安装/ })
    fireEvent.click(installBtn)
    expect(await screen.findByText(/不会删除/)).toBeTruthy()
    const confirmInstall = screen.getByRole('button', { name: /确认安装/ })
    fireEvent.click(confirmInstall)
    await waitFor(() =>
      expect(installSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agy' })),
    )

    // 2. AGY uninstall confirmation
    const agyInstalled = clients.map((c) =>
      c.kind === 'agy'
        ? {
            ...c,
            pluginStatus: {
              state: 'enabled' as const,
              installed: true,
              enabled: true,
              version: '0.2.2',
            },
          }
        : c,
    )
    rerender(
      h(DesktopConfigPanel, {
        bridge,
        clients: agyInstalled,
        appInfo: {
          version: '0.2.2',
          platform: 'win32',
          runtimeMode: 'electron',
          bundledPluginsAvailable: true,
        },
        refreshToken: 1,
        onRecheckGuard: async () => undefined,
        onRequestUnlockDsh: () => undefined,
        onRelockDsh: async () => undefined,
        onDataChanged: async () => undefined,
        onExternalChange: () => undefined,
        onNotify: () => undefined,
      }),
    )
    const uninstallBtn = await screen.findByRole('button', { name: /卸载插件/ })
    fireEvent.click(uninstallBtn)
    expect(await screen.findByText(/不会删除/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /确认卸载/ }))
    await waitFor(() =>
      expect(uninstallSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agy' })),
    )

    // 3. Switch to DSH tab: default desktop profile v0.2.1 < v0.2.2 shows sync button, disabled when DSH running
    rerender(
      h(DesktopConfigPanel, {
        bridge,
        clients,
        guardSnapshot: {
          mode: 'readonly-dsh-running',
          dshRunning: true,
          uncertain: false,
          matchedProcesses: ['DeepSeek Harness.exe'],
          checkedAt: '2026-11-27T00:00:00.000Z',
        },
        appInfo: {
          version: '0.2.2',
          platform: 'win32',
          runtimeMode: 'electron',
          bundledPluginsAvailable: true,
        },
        refreshToken: 2,
        onRecheckGuard: async () => undefined,
        onRequestUnlockDsh: () => undefined,
        onRelockDsh: async () => undefined,
        onDataChanged: async () => undefined,
        onExternalChange: () => undefined,
        onNotify: () => undefined,
      }),
    )
    fireEvent.click(screen.getByRole('tab', { name: /DSH/ }))
    const syncBtn = await screen.findByRole('button', { name: /同步到 v0\.2\.2/ })
    expect((syncBtn as HTMLButtonElement).disabled).toBe(true)

    // 4. Even in force-unlocked mode while DSH is still running, DSH plugin buttons remain disabled
    rerender(
      h(DesktopConfigPanel, {
        bridge,
        clients,
        guardSnapshot: {
          mode: 'force-unlocked',
          dshRunning: true,
          uncertain: false,
          matchedProcesses: ['DeepSeek Harness.exe'],
          checkedAt: '2026-11-27T00:00:00.000Z',
        },
        appInfo: {
          version: '0.2.2',
          platform: 'win32',
          runtimeMode: 'electron',
          bundledPluginsAvailable: true,
        },
        refreshToken: 3,
        onRecheckGuard: async () => undefined,
        onRequestUnlockDsh: () => undefined,
        onRelockDsh: async () => undefined,
        onDataChanged: async () => undefined,
        onExternalChange: () => undefined,
        onNotify: () => undefined,
      }),
    )
    const syncBtnForceUnlocked = await screen.findByRole('button', { name: /同步到 v0\.2\.2/ })
    expect((syncBtnForceUnlocked as HTMLButtonElement).disabled).toBe(true)

    // 5. Switching DSH Profile from desktop -> work updates top header badge to not-installed
    const profileTrigger = screen.getByRole('button', { name: /目标 DSH Profile/ })
    fireEvent.click(profileTrigger)
    const workOption = await screen.findByRole('menuitemradio', { name: 'work' })
    fireEvent.click(workOption)
    await waitFor(() => {
      expect(document.querySelector('[data-plugin-state="not-installed"]')).toBeTruthy()
    })
  })

  it('renders UpdateModal for electron vs local-bridge and shows post-restart pendingSync retry/dismiss banner', async () => {
    applyDesktopLocale('zh')
    const { bridge } = createFakeBridge()
    const syncPendingSpy = vi.spyOn(bridge.plugins, 'syncPending')
    const dismissPendingSpy = vi.spyOn(bridge.plugins, 'dismissPendingSync')
    const startAppUpdateSpy = vi.spyOn(bridge.updater, 'startAppUpdate')
    const updateOnlineSpy = vi.spyOn(bridge.updater, 'updateInstalledPluginsOnline')

    const failedPendingSnapshot = {
      phase: 'failed' as const,
      action: 'pending-sync' as const,
      targetVersion: '0.2.3',
      pendingSync: {
        targetVersion: '0.2.3',
        requestedAt: '2026-11-27T00:00:00.000Z',
        targets: [
          {
            kind: 'dsh' as const,
            profileName: 'desktop',
            status: 'blocked-dsh-running' as const,
            errorCode: 'desktop/dsh-running',
            errorMessage: 'DSH is running',
          },
        ],
      },
      updatedAt: '2026-11-27T00:00:00.000Z',
    }
    syncPendingSpy.mockResolvedValue({ ok: true, value: failedPendingSnapshot })
    vi.spyOn(bridge.updater, 'getState').mockResolvedValue({
      ok: true,
      value: failedPendingSnapshot,
    })
    vi.spyOn(bridge.updater, 'check').mockResolvedValue({
      ok: true,
      value: {
        currentVersion: '0.2.2',
        latestVersion: '0.2.3',
        hasUpdate: true,
        releaseUrl: 'https://github.com/JiaMingWang-CN/memloom/releases/tag/v0.2.3',
        releaseNotes: 'Bug fixes',
        runtimeMode: 'electron',
        canSelfUpdateApp: true,
        assets: {
          desktopExe: 'https://github.com/a.exe',
          checksums: 'https://github.com/SHA256SUMS.txt',
        },
        installedTargets: [{ kind: 'agy', previousVersion: '0.2.2', status: 'pending' }],
      },
    })

    render(h(DesktopApp, { bridge }))

    // Pending sync failure banner with retry & dismiss
    const retryBtn = await screen.findByRole('button', { name: /重试同步/ })
    fireEvent.click(retryBtn)
    await waitFor(() => expect(syncPendingSpy).toHaveBeenCalledTimes(1))

    const dismissBtn = screen.getByRole('button', { name: /忽略/ })
    fireEvent.click(dismissBtn)
    await waitFor(() => expect(dismissPendingSpy).toHaveBeenCalledTimes(1))

    // Open UpdateModal from sidebar button -> Electron mode shows 立即更新
    const checkUpdateBtn = screen.getByRole('button', { name: /检查更新/ })
    fireEvent.click(checkUpdateBtn)
    const updateNowBtn = await screen.findByRole('button', { name: /立即更新/ })
    fireEvent.click(updateNowBtn)
    await waitFor(() => expect(startAppUpdateSpy).toHaveBeenCalledTimes(1))

    // Local-bridge mode shows 更新已安装端插件
    vi.spyOn(bridge.app, 'getInfo').mockResolvedValue({
      ok: true,
      value: {
        version: '0.2.2',
        platform: 'win32',
        systemTheme: 'light',
        runtimeMode: 'local-bridge',
        bundledPluginsAvailable: true,
      },
    })
    vi.spyOn(bridge.updater, 'check').mockResolvedValue({
      ok: true,
      value: {
        currentVersion: '0.2.2',
        latestVersion: '0.2.3',
        hasUpdate: true,
        releaseUrl: 'https://github.com/JiaMingWang-CN/memloom/releases/tag/v0.2.3',
        releaseNotes: 'Local mode release',
        runtimeMode: 'local-bridge',
        canSelfUpdateApp: false,
        assets: {
          agyZip: 'https://github.com/a.zip',
          checksums: 'https://github.com/SHA256SUMS.txt',
        },
        installedTargets: [{ kind: 'agy', previousVersion: '0.2.2', status: 'pending' }],
      },
    })
    const localView = render(h(DesktopApp, { bridge }))
    const localBtns = await localView.findAllByRole('button', { name: /检查更新/ })
    fireEvent.click(localBtns[localBtns.length - 1]!)
    const onlinePluginsBtn = await screen.findByRole('button', { name: /更新已安装端插件/ })
    fireEvent.click(onlinePluginsBtn)
    await waitFor(() => expect(updateOnlineSpy).toHaveBeenCalledTimes(1))
  })
})
