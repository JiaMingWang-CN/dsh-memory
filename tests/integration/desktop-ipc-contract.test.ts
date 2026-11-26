import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { OperationError, type OperationErrorCode } from '../../src/core/operations.ts'
import {
  IPC_CHANNELS,
  isAllowedExternalUrl,
  mapDesktopError,
} from '../../src/desktop/ipc-contract.ts'
import {
  attachNavigationGuards,
  attachProductionWindowGuards,
  createSecureWebPreferences,
  isDevToolsShortcut,
  MAIN_WINDOW_WEB_PREFERENCES,
} from '../../src/desktop/main/index.ts'
import {
  AuthorizedPathBook,
  createDesktopIpcHandlers,
  type DialogAdapter,
} from '../../src/desktop/main/ipc-handlers.ts'
import {
  DesktopStoreCorruptError,
  DesktopUnsupportedError,
  MultiClientService,
} from '../../src/desktop/multi-service.ts'
import type { PlatformAdapter } from '../../src/desktop/platform/types.ts'
import type { IpcRendererEvent } from 'electron'
import {
  createDesktopBridge,
  type PreloadIpcRendererLike,
} from '../../src/desktop/preload/index.ts'
import { ClientRegistry } from '../../src/desktop/registry.ts'
import { DesktopExternalChangeError } from '../../src/desktop/storage/dsh-domain.ts'
import { DesktopReadonlyGuardError, WriteGuard } from '../../src/desktop/write-guard.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'memloom-desktop-ipc-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeAgyFlatFile(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        name: 'memory',
        version: 1,
        memories: {},
        episodes: {},
        dreams: {},
        audit: {},
        operations: {},
        session_cursors: {},
      },
      null,
      2,
    ),
    'utf8',
  )
}

function createFakePlatform(
  rootDir: string,
  options: { legacyAgyCandidate?: string; dshRunning?: boolean } = {},
): PlatformAdapter {
  const dshPath = join(rootDir, 'dsh', 'storages', 'memory.json')
  const agyPath = join(rootDir, 'agy', 'memory.json')
  return {
    platform: 'win32',
    async detectDshProcesses() {
      return {
        running: options.dshRunning ?? false,
        uncertain: false,
        matchedProcesses: options.dshRunning ? ['DeepSeek Harness.exe'] : [],
      }
    },
    async resolveDefaultDshStores() {
      return [
        {
          id: 'dsh-default',
          name: 'DSH Default',
          kind: 'dsh',
          storePath: dshPath,
        },
      ]
    },
    async resolveDefaultAgyStore() {
      return {
        primary: {
          id: 'agy-default',
          name: 'Antigravity Default',
          kind: 'agy',
          storePath: agyPath,
        },
        ...(options.legacyAgyCandidate !== undefined
          ? { legacyCandidatePath: options.legacyAgyCandidate }
          : {}),
      }
    },
  }
}

async function createTestHarness(
  options: { legacyAgyCandidate?: string; dshRunning?: boolean } = {},
): Promise<{
  rootDir: string
  service: MultiClientService
  dialog: DialogAdapter
  handlers: Record<
    string,
    (rawPayload?: unknown) => Promise<{
      ok: boolean
      value?: unknown
      error?: { code: string; message: string; details?: Record<string, unknown> }
    }>
  >
  pickedFiles: {
    open: string | null
    create: string | null
    dir: string | null
    saved: Array<{ fileName: string; content: string }>
  }
  openedUrls: string[]
}> {
  const rootDir = makeTempDir()
  const platform = createFakePlatform(rootDir, options)
  const registry = new ClientRegistry({
    statePath: join(rootDir, 'desktop-state.json'),
    platform,
    now: () => new Date('2026-11-25T12:00:00.000Z'),
  })
  const writeGuard = new WriteGuard(platform, () => new Date('2026-11-25T12:00:00.000Z'))
  const service = new MultiClientService({
    registry,
    writeGuard,
    now: () => new Date('2026-11-25T12:00:00.000Z'),
  })
  await service.initialize()

  const pickedFiles: {
    open: string | null
    create: string | null
    dir: string | null
    saved: Array<{ fileName: string; content: string }>
  } = {
    open: null,
    create: null,
    dir: null,
    saved: [],
  }

  const dialog: DialogAdapter = {
    async pickMemoryFile(mode) {
      return mode === 'open' ? pickedFiles.open : pickedFiles.create
    },
    async pickDirectory() {
      return pickedFiles.dir
    },
    async pickImportJson() {
      return null
    },
    async saveExportJson(defaultFileName, content) {
      const target = join(rootDir, 'exports', defaultFileName)
      pickedFiles.saved.push({ fileName: defaultFileName, content })
      return target
    },
  }

  const openedUrls: string[] = []
  const handlers = createDesktopIpcHandlers({
    service,
    dialog,
    appInfo: { version: '0.1.3', platform: 'win32', systemTheme: 'dark' },
    openExternal: async (url) => {
      openedUrls.push(url)
    },
  }) as Record<
    string,
    (rawPayload?: unknown) => Promise<{
      ok: boolean
      value?: unknown
      error?: { code: string; message: string; details?: Record<string, unknown> }
    }>
  >

  return { rootDir, service, dialog, handlers, pickedFiles, openedUrls }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('desktop IPC contract & security boundary', () => {
  it('mapDesktopError maps all OperationError codes, desktop errors, ZodError, and unknown errors accurately', () => {
    const opCases: Array<[OperationErrorCode, string]> = [
      ['MEMORY_CONFLICT', 'memory/conflict'],
      ['MEMORY_NOT_FOUND', 'memory/not-found'],
      ['MEMORY_INVALID_CONTENT', 'memory/invalid'],
      ['MEMORY_INVALID_CONFIG', 'memory/invalid'],
      ['MEMORY_INVALID_QUERY', 'memory/invalid'],
      ['MEMORY_FORBIDDEN', 'memory/forbidden'],
      ['MEMORY_FORBIDDEN_SCOPE', 'memory/forbidden'],
      ['MEMORY_CONFIRM_REQUIRED', 'memory/forbidden'],
      ['MEMORY_CAPACITY', 'memory/capacity'],
      ['MEMORY_RECOVERING', 'memory/unavailable'],
      ['MEMORY_STOPPED', 'memory/unavailable'],
      ['MEMORY_UNAVAILABLE', 'memory/unavailable'],
    ]

    for (const [domainCode, expectedIpcCode] of opCases) {
      const mapped = mapDesktopError(new OperationError(domainCode, `boom:${domainCode}`))
      expect(mapped.code).toBe(expectedIpcCode)
      expect(mapped.message).toBe(`boom:${domainCode}`)
      expect(mapped.details).toEqual({ code: domainCode })
    }

    const readonlyErr = new DesktopReadonlyGuardError({
      mode: 'readonly-dsh-running',
      dshRunning: true,
      uncertain: false,
      matchedProcesses: ['DeepSeek Harness.exe'],
      checkedAt: '2026-11-25T12:00:00.000Z',
    })
    expect(mapDesktopError(readonlyErr)).toMatchObject({
      code: 'desktop/readonly-guard',
      details: { snapshot: { mode: 'readonly-dsh-running', dshRunning: true } },
    })

    const externalErr = new DesktopExternalChangeError('C:/dsh/memory.json')
    expect(mapDesktopError(externalErr)).toMatchObject({
      code: 'desktop/external-change',
      details: { storePath: 'C:/dsh/memory.json' },
    })

    const corruptErr = new DesktopStoreCorruptError('custom-1', 'C:/custom/memory.json', 'bad json')
    expect(mapDesktopError(corruptErr)).toMatchObject({
      code: 'desktop/store-corrupt',
      details: { clientId: 'custom-1', storePath: 'C:/custom/memory.json' },
    })

    const unsupportedErr = new DesktopUnsupportedError('read-only config')
    expect(mapDesktopError(unsupportedErr)).toEqual({
      code: 'desktop/unsupported',
      message: 'read-only config',
    })

    const zodErr = new ZodError([
      {
        code: 'custom',
        path: ['clientId'],
        message: 'Required',
      },
    ])
    expect(mapDesktopError(zodErr).code).toBe('desktop/invalid-args')

    expect(mapDesktopError(new Error('unexpected failure'))).toEqual({
      code: 'desktop/internal',
      message: 'unexpected failure',
    })
    expect(mapDesktopError('string failure')).toEqual({
      code: 'desktop/internal',
      message: 'string failure',
    })
  })

  it('AuthorizedPathBook and clients:add block unauthorized paths and traversal while allowing dialog and legacy AGY paths', async () => {
    const rootDir = makeTempDir()
    const legacyPath = join(rootDir, 'legacy-dsh-memory', 'memory.json')
    writeAgyFlatFile(legacyPath)

    const { service, handlers, pickedFiles } = await createTestHarness({
      legacyAgyCandidate: legacyPath,
    })

    const unauthorizedPath = join(rootDir, 'unauthorized', 'memory.json')
    writeAgyFlatFile(unauthorizedPath)

    const forbiddenDirect = await handlers[IPC_CHANNELS.clientsAdd]!({
      name: 'Sneaky Store',
      storePath: unauthorizedPath,
    })
    expect(forbiddenDirect.ok).toBe(false)
    expect(forbiddenDirect.error?.code).toBe('memory/forbidden')

    const allowedDir = join(rootDir, 'picked-dir')
    mkdirSync(allowedDir, { recursive: true })
    pickedFiles.dir = allowedDir
    const pickedDirRes = await handlers[IPC_CHANNELS.dialogPickDirectory]!()
    expect(pickedDirRes).toEqual({ ok: true, value: allowedDir })

    const traversalPath = `${allowedDir}${path.sep}..${path.sep}unauthorized${path.sep}memory.json`
    const forbiddenTraversal = await handlers[IPC_CHANNELS.clientsAdd]!({
      name: 'Traversal Store',
      storePath: traversalPath,
    })
    expect(forbiddenTraversal.ok).toBe(false)
    expect(forbiddenTraversal.error?.code).toBe('memory/forbidden')

    // Standalone AuthorizedPathBook also blocks relative / traversal paths
    const pathBook = new AuthorizedPathBook()
    pathBook.authorizeDirectory(allowedDir)
    expect(pathBook.isFileAuthorized('../../etc/passwd')).toBe(false)
    expect(pathBook.isFileAuthorized(traversalPath)).toBe(false)
    expect(pathBook.isFileAuthorized(join(allowedDir, 'memory.json'))).toBe(true)

    // Legacy AGY candidate provided by service is allowed without dialog pick
    const legacyRes = await handlers[IPC_CHANNELS.clientsAdd]!({
      name: 'Legacy AGY',
      storePath: legacyPath,
    })
    expect(legacyRes.ok).toBe(true)

    // Explicit dialog.pickMemoryFile authorizes adding a new custom store
    const customPath = join(rootDir, 'custom', 'memory.json')
    writeAgyFlatFile(customPath)
    pickedFiles.open = customPath
    const pickRes = await handlers[IPC_CHANNELS.dialogPickMemoryFile]!({ mode: 'open' })
    expect(pickRes).toEqual({ ok: true, value: customPath })

    const addRes = await handlers[IPC_CHANNELS.clientsAdd]!({
      name: 'Custom Store',
      storePath: customPath,
    })
    expect(addRes.ok).toBe(true)

    await service.closeAll()
  })

  it('rejects malformed, empty, out-of-range, or unknown-field IPC payloads with desktop/invalid-args', async () => {
    const { service, handlers } = await createTestHarness()

    const emptyClient = await handlers[IPC_CHANNELS.memoryList]!({
      clientId: '',
    })
    expect(emptyClient.ok).toBe(false)
    expect(emptyClient.error?.code).toBe('desktop/invalid-args')

    const whitespaceClient = await handlers[IPC_CHANNELS.memoryOverview]!({
      clientId: '   ',
      workspaceKey: 'all',
    })
    expect(whitespaceClient.ok).toBe(false)
    expect(whitespaceClient.error?.code).toBe('desktop/invalid-args')

    const zeroLimit = await handlers[IPC_CHANNELS.aggregateSearch]!({
      limit: 0,
    })
    expect(zeroLimit.ok).toBe(false)
    expect(zeroLimit.error?.code).toBe('desktop/invalid-args')

    const hugeLimit = await handlers[IPC_CHANNELS.memoryList]!({
      clientId: 'agy-default',
      limit: 9999,
    })
    expect(hugeLimit.ok).toBe(false)
    expect(hugeLimit.error?.code).toBe('desktop/invalid-args')

    const unknownField = await handlers[IPC_CHANNELS.memoryList]!({
      clientId: 'agy-default',
      unexpectedExtra: true,
    })
    expect(unknownField.ok).toBe(false)
    expect(unknownField.error?.code).toBe('desktop/invalid-args')

    const badConfirmType = await handlers[IPC_CHANNELS.clientsForceUnlockDsh]!({
      confirmed: 'yes',
    })
    expect(badConfirmType.ok).toBe(false)
    expect(badConfirmType.error?.code).toBe('desktop/invalid-args')

    await service.closeAll()
  })

  it('executes full end-to-end IPC workflow from clients:list to migration and export dialog', async () => {
    const { rootDir, service, handlers, pickedFiles } = await createTestHarness()

    const listClientsRes = await handlers[IPC_CHANNELS.clientsList]!()
    expect(listClientsRes.ok).toBe(true)
    expect((listClientsRes.value as Array<{ id: string }>).map((c) => c.id)).toContain(
      'agy-default',
    )

    const customPath = join(rootDir, 'custom-e2e', 'memory.json')
    writeAgyFlatFile(customPath)
    pickedFiles.open = customPath
    await handlers[IPC_CHANNELS.dialogPickMemoryFile]!({ mode: 'open' })

    const addedRes = await handlers[IPC_CHANNELS.clientsAdd]!({
      name: 'E2E Custom',
      storePath: customPath,
    })
    expect(addedRes.ok).toBe(true)
    const customId = (addedRes.value as { id: string }).id

    const createdRes = await handlers[IPC_CHANNELS.memoryCreate]!({
      clientId: customId,
      type: 'lesson',
      title: 'IPC End-to-End Lesson',
      body: 'Always validate IPC boundaries with strict zod schemas.',
      workspaceKey: 'c:/ws/ipc-e2e',
      workspaceRoot: 'C:/ws/ipc-e2e',
      tags: ['ipc', 'security'],
    })
    expect(createdRes.ok).toBe(true)

    const aggRes = await handlers[IPC_CHANNELS.aggregateSearch]!({
      query: 'IPC End-to-End',
      limit: 10,
      offset: 0,
    })
    expect(aggRes.ok).toBe(true)
    const aggValue = aggRes.value as {
      items: Array<{ clientId: string; record: { title: string } }>
    }
    expect(aggValue.items).toHaveLength(1)
    expect(aggValue.items[0]?.clientId).toBe(customId)
    expect(aggValue.items[0]?.record.title).toBe('IPC End-to-End Lesson')

    const previewRes = await handlers[IPC_CHANNELS.migrationPreview]!({
      sourceClientId: customId,
      targetClientId: 'agy-default',
      selection: { kind: 'scope', scope: 'all', includeArchived: true, includeEpisodes: false },
    })
    expect(previewRes.ok).toBe(true)
    const previewValue = previewRes.value as {
      memoryCount: number
      suggestedMapping: Record<string, { key: string; root: string }>
    }
    expect(previewValue.memoryCount).toBe(1)

    const executeRes = await handlers[IPC_CHANNELS.migrationExecute]!({
      sourceClientId: customId,
      targetClientId: 'agy-default',
      selection: { kind: 'scope', scope: 'all', includeArchived: true, includeEpisodes: false },
      mode: 'merge',
      mapping: previewValue.suggestedMapping,
    })
    expect(executeRes.ok).toBe(true)
    expect((executeRes.value as { created: number }).created).toBe(1)

    const exportRes = await handlers[IPC_CHANNELS.memoryExport]!({
      clientId: 'agy-default',
      scope: 'all',
    })
    expect(exportRes.ok).toBe(true)

    const saveRes = await handlers[IPC_CHANNELS.dialogSaveExportJson]!({
      defaultFileName: 'memloom-export.json',
      content: JSON.stringify(exportRes.value),
    })
    expect(saveRes.ok).toBe(true)
    expect(pickedFiles.saved).toHaveLength(1)
    expect(pickedFiles.saved[0]?.fileName).toBe('memloom-export.json')

    await service.closeAll()
  })

  it('enforces Electron security baseline for webPreferences, navigation guards, external allowlist, and preload bridge', async () => {
    expect(MAIN_WINDOW_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    })
    const prefs = createSecureWebPreferences('/app/preload.cjs')
    expect(prefs).toEqual({
      preload: '/app/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    })

    expect(isAllowedExternalUrl('https://github.com/JiaMingWang-CN/memloom')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/JiaMingWang-CN/memloom/releases')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/JiaMingWang-CN/memloom-evil')).toBe(false)
    expect(isAllowedExternalUrl('https://evil.example.com')).toBe(false)
    expect(isAllowedExternalUrl('http://github.com/JiaMingWang-CN/memloom')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)

    const navListeners: Array<(event: { preventDefault(): void }, url: string) => void> = []
    let openHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | undefined
    const openedExternal: string[] = []
    const entryUrl = pathToFileURL('C:/app/renderer/index.html').href

    const fakeContents = {
      on(event: string, listener: (event: { preventDefault(): void }, url: string) => void) {
        if (event === 'will-navigate') navListeners.push(listener)
      },
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        openHandler = handler
      },
      send: vi.fn(),
      isDestroyed: () => false,
    }

    attachNavigationGuards(fakeContents, entryUrl, async (url) => {
      openedExternal.push(url)
    })

    const allowedNavEvent = { preventDefault: vi.fn() }
    navListeners[0]?.(allowedNavEvent, `${entryUrl}#section`)
    expect(allowedNavEvent.preventDefault).not.toHaveBeenCalled()

    const blockedNavEvent = { preventDefault: vi.fn() }
    navListeners[0]?.(blockedNavEvent, 'https://evil.example.com')
    expect(blockedNavEvent.preventDefault).toHaveBeenCalledTimes(1)

    expect(openHandler?.({ url: 'https://github.com/JiaMingWang-CN/memloom' })).toEqual({
      action: 'deny',
    })
    expect(openHandler?.({ url: 'https://evil.example.com' })).toEqual({ action: 'deny' })
    expect(openedExternal).toEqual(['https://github.com/JiaMingWang-CN/memloom'])

    // Verify preload bridge delegates via ipcRenderer.invoke & manages focus refresh listener
    const invokeMock = vi.fn(async () => ({ ok: true as const, value: [] }))
    const listenerMap = new Map<
      string,
      Set<(event: IpcRendererEvent, ...args: unknown[]) => void>
    >()
    const fakeIpcRenderer: PreloadIpcRendererLike = {
      invoke: invokeMock as PreloadIpcRendererLike['invoke'],
      on(channel, fn) {
        let set = listenerMap.get(channel)
        if (!set) {
          set = new Set()
          listenerMap.set(channel, set)
        }
        set.add(fn)
      },
      removeListener(channel, fn) {
        listenerMap.get(channel)?.delete(fn)
      },
    }

    const bridge = createDesktopBridge(fakeIpcRenderer)
    await bridge.clients.list()
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.clientsList)

    const onRefresh = vi.fn()
    const unsubscribe = bridge.app.onFocusRefresh(onRefresh)
    for (const fn of listenerMap.get(IPC_CHANNELS.appFocusRefresh) ?? []) {
      fn({ senderId: 1 })
    }
    expect(onRefresh).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(listenerMap.get(IPC_CHANNELS.appFocusRefresh)?.size ?? 0).toBe(0)

    // Verify production window guards remove native menu bar & block DevTools shortcuts
    expect(isDevToolsShortcut({ key: 'F12' })).toBe(true)
    expect(isDevToolsShortcut({ key: 'I', control: true, shift: true })).toBe(true)
    expect(isDevToolsShortcut({ key: 'j', control: true, shift: true })).toBe(true)
    expect(isDevToolsShortcut({ key: 'C', meta: true, shift: true })).toBe(true)
    expect(isDevToolsShortcut({ key: 'i', meta: true, alt: true })).toBe(true)
    expect(isDevToolsShortcut({ key: 'r', control: true })).toBe(false)

    const inputListeners: Array<
      (
        event: { preventDefault(): void },
        input: { key?: string; control?: boolean; shift?: boolean },
      ) => void
    > = []
    const fakeWin = {
      setMenuBarVisibility: vi.fn(),
      removeMenu: vi.fn(),
      webContents: {
        on(
          event: string,
          listener: (
            event: { preventDefault(): void },
            input: { key?: string; control?: boolean; shift?: boolean },
          ) => void,
        ) {
          if (event === 'before-input-event') inputListeners.push(listener)
        },
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        isDestroyed: () => false,
      },
    }

    attachProductionWindowGuards(fakeWin)
    expect(fakeWin.setMenuBarVisibility).toHaveBeenCalledWith(false)
    expect(fakeWin.removeMenu).toHaveBeenCalledTimes(1)
    expect(inputListeners).toHaveLength(1)

    const blockedShortcut = { preventDefault: vi.fn() }
    inputListeners[0]?.(blockedShortcut, { key: 'I', control: true, shift: true })
    expect(blockedShortcut.preventDefault).toHaveBeenCalledTimes(1)

    const normalShortcut = { preventDefault: vi.fn() }
    inputListeners[0]?.(normalShortcut, { key: 'f', control: true })
    expect(normalShortcut.preventDefault).not.toHaveBeenCalled()

    // Explicit allowDevTools opt-in skips before-input-event blocking while still stripping menu bar
    const debugListeners: unknown[] = []
    attachProductionWindowGuards(
      {
        setMenuBarVisibility: vi.fn(),
        removeMenu: vi.fn(),
        webContents: {
          on(event, listener) {
            if (event === 'before-input-event') debugListeners.push(listener)
          },
        },
      },
      { allowDevTools: true },
    )
    expect(debugListeners).toHaveLength(0)
  })

  it('enforces DSH readonly-guard, DSH config unsupported, AGY config updates, aggregate workspaces, and app channels over IPC', async () => {
    const { rootDir, service, handlers, openedUrls } = await createTestHarness({ dshRunning: true })

    // Create a valid dsh-unit store on disk and refresh discovery
    const dshStorePath = join(rootDir, 'dsh', 'storages', 'memory.json')
    mkdirSync(path.dirname(dshStorePath), { recursive: true })
    writeFileSync(
      dshStorePath,
      JSON.stringify({
        unit: { name: 'memory', version: 1 },
        global: { keep: true },
        tables: {
          memories: {},
          episodes: {},
          dreams: {},
          audit: {},
          operations: {},
          session_cursors: {},
        },
      }),
      'utf8',
    )
    const refreshRes = await handlers[IPC_CHANNELS.clientsRefreshAll]!()
    expect(refreshRes.ok).toBe(true)

    // Write on DSH while running fails with desktop/readonly-guard
    const blockedCreate = await handlers[IPC_CHANNELS.memoryCreate]!({
      clientId: 'dsh-default',
      type: 'lesson',
      title: 'Blocked',
      body: 'Should fail while DSH is running',
      scope: 'global',
    })
    expect(blockedCreate.ok).toBe(false)
    expect(blockedCreate.error?.code).toBe('desktop/readonly-guard')

    // DSH config update fails with desktop/unsupported
    const dshConfigErr = await handlers[IPC_CHANNELS.memoryUpdateConfig]!({
      clientId: 'dsh-default',
      patch: { searchLimit: 10 },
    })
    expect(dshConfigErr.ok).toBe(false)
    expect(dshConfigErr.error?.code).toBe('desktop/unsupported')

    // Force unlock allows writing to DSH, relock blocks again
    const unlockRes = await handlers[IPC_CHANNELS.clientsForceUnlockDsh]!({ confirmed: true })
    expect(unlockRes.ok).toBe(true)
    expect((unlockRes.value as { mode: string }).mode).toBe('force-unlocked')

    const dshCreateRes = await handlers[IPC_CHANNELS.memoryCreate]!({
      clientId: 'dsh-default',
      type: 'preference',
      title: 'Unlocked Preference',
      body: 'Saved after confirmation',
      scope: 'global',
    })
    expect(dshCreateRes.ok).toBe(true)
    const createdId = (dshCreateRes.value as { id: string }).id

    const relockRes = await handlers[IPC_CHANNELS.clientsRelockDsh]!()
    expect(relockRes.ok).toBe(true)
    expect((relockRes.value as { mode: string }).mode).toBe('readonly-dsh-running')

    // AGY config read/update and aggregate workspaces
    const agyCreateRes = await handlers[IPC_CHANNELS.memoryCreate]!({
      clientId: 'agy-default',
      type: 'lesson',
      title: 'AGY Workspace Lesson',
      body: 'Workspace memory for aggregate workspaces check',
      workspaceKey: 'c:/ws/agg',
      workspaceRoot: 'C:/ws/agg',
    })
    expect(agyCreateRes.ok).toBe(true)

    const agyConfigRes = await handlers[IPC_CHANNELS.memoryUpdateConfig]!({
      clientId: 'agy-default',
      patch: { searchLimit: 15 },
    })
    expect(agyConfigRes.ok).toBe(true)
    expect((agyConfigRes.value as { config: { searchLimit: number } }).config.searchLimit).toBe(15)

    const aggWsRes = await handlers[IPC_CHANNELS.aggregateListWorkspaces]!()
    expect(aggWsRes.ok).toBe(true)
    expect((aggWsRes.value as { items: Array<{ key: string }> }).items.map((w) => w.key)).toContain(
      'c:/ws/agg',
    )

    // Audit & Dreams & View
    const viewRes = await handlers[IPC_CHANNELS.memoryView]!({
      clientId: 'dsh-default',
      id: createdId,
    })
    expect(viewRes.ok).toBe(true)
    const auditRes = await handlers[IPC_CHANNELS.memoryListAudit]!({
      clientId: 'dsh-default',
      limit: 10,
    })
    expect(auditRes.ok).toBe(true)
    const dreamsRes = await handlers[IPC_CHANNELS.memoryListDreams]!({
      clientId: 'dsh-default',
      limit: 10,
    })
    expect(dreamsRes.ok).toBe(true)

    // App info, preferences, and external URL guard
    const infoRes = await handlers[IPC_CHANNELS.appGetInfo]!()
    expect(infoRes).toEqual({
      ok: true,
      value: { version: '0.1.3', platform: 'win32', systemTheme: 'dark' },
    })
    const prefRes = await handlers[IPC_CHANNELS.appUpdatePreferences]!({
      locale: 'en',
      theme: 'light',
    })
    expect(prefRes.ok).toBe(true)
    expect((prefRes.value as { locale: string; theme: string }).locale).toBe('en')

    const allowedExt = await handlers[IPC_CHANNELS.appOpenExternal]!({
      url: 'https://github.com/JiaMingWang-CN/memloom',
    })
    expect(allowedExt).toEqual({ ok: true, value: true })
    expect(openedUrls).toEqual(['https://github.com/JiaMingWang-CN/memloom'])

    const blockedExt = await handlers[IPC_CHANNELS.appOpenExternal]!({
      url: 'https://evil.example.com/phish',
    })
    expect(blockedExt.ok).toBe(false)
    expect(blockedExt.error?.code).toBe('memory/forbidden')

    await service.closeAll()
  })
})
