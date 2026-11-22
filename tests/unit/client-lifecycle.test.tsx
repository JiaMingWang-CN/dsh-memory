// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import type { ClientContext, MemoryRemote, WorkspaceInfo } from '../../src/client/context.ts'
import { apply } from '../../src/client/index.ts'
import { MemorySection, type MemorySectionProps } from '../../src/client/MemorySection.tsx'
import { setTranslate } from '../../src/client/locales.ts'
import { rpc } from '../../src/client/rpc.ts'
import { clearClientContext, clientContext, setClientContext } from '../../src/client/runtime.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const h = React.createElement

afterEach(() => {
  cleanup()
  clearClientContext()
  vi.restoreAllMocks()
})

setTranslate((key) => key)

const workspaces: WorkspaceInfo[] = [
  { id: 'ws-a', title: 'Project A', path: 'C:/ws/a', updatedAt: '2026-03-01T00:00:00.000Z' },
]

function makeCtx(
  remote: Partial<MemoryRemote>,
  opts: {
    workspaces?: WorkspaceInfo[]
    subscribe?: (listener: () => void) => () => void
  } = {},
): ClientContext {
  const fullRemote: Partial<MemoryRemote> = {
    list: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0, truncated: false }),
    overview: vi.fn().mockResolvedValue(undefined),
    activeWorkspace: vi.fn().mockResolvedValue('c:/ws/a'),
    getConfig: vi.fn().mockResolvedValue({}),
    ...remote,
  }
  return {
    slots: { inject: (_k: string, cb: () => () => void) => cb(), register: () => () => {} },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
      ...(opts.subscribe === undefined ? {} : { subscribe: opts.subscribe }),
    },
    remote: { memory: fullRemote as MemoryRemote, $on: () => () => {} },
    workspaces: { list: () => opts.workspaces ?? workspaces },
  } as unknown as ClientContext
}

describe('silentReload loading state (H11)', () => {
  it('does not get stuck in loading=true when a silent refresh fires before first load finishes', async () => {
    let resolveFirst!: (value: {
      items: MemoryRecord[]
      total: number
      limit: number
      offset: number
      truncated: boolean
    }) => void
    const list = vi.fn().mockImplementation((req: { status?: string }) => {
      if (req.status === 'pending') {
        return Promise.resolve({ items: [], total: 0, limit: 50, offset: 0, truncated: false })
      }
      if (list.mock.calls.filter((call) => call[0]?.status !== 'pending').length === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({
        items: [makeMemoryRecord({ id: MemoryId('m1'), title: 'Loaded item' })],
        total: 1,
        limit: 25,
        offset: 0,
        truncated: false,
      })
    })
    setClientContext(makeCtx({ list }))

    render(h(MemorySection))
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
    expect(screen.getByText('state.loading')).toBeTruthy()

    // Trigger a silent refresh while the first list request is still pending.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    fireEvent(document, new Event('visibilitychange'))

    await screen.findByText('Loaded item')
    expect(screen.queryByText('state.loading')).toBeNull()
  })
})

describe('create modal dirty close & create notice (M17, L10)', () => {
  it('prompts before discarding a non-empty create draft and uses create.created notice', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(makeMemoryRecord({ id: MemoryId('new-1'), title: 'Draft Title' }))
    setClientContext(makeCtx({ create }))

    render(h(MemorySection))
    await waitFor(() => expect(screen.getByText('common.new')).toBeTruthy())

    fireEvent.click(screen.getByText('common.new'))
    fireEvent.change(screen.getByLabelText('create.titleField'), {
      target: { value: 'Draft Title' },
    })

    // Closing a dirty draft shows an inline confirmation bar instead of window.confirm.
    fireEvent.click(screen.getByText('common.cancel'))
    expect(screen.getByText('detail.dirtyClose')).toBeTruthy()
    fireEvent.click(screen.getByText('detail.keepEditing'))
    expect(screen.queryByText('detail.dirtyClose')).toBeNull()
    // Stays open when user declines discard.
    expect(screen.getByLabelText('create.titleField')).toBeTruthy()

    // Submitting creates the memory and shows the dedicated create.created notice.
    fireEvent.change(screen.getByLabelText('create.bodyField'), { target: { value: 'Body' } })
    fireEvent.click(screen.getByText('create.submit'))
    await screen.findByText('create.created')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('client apply lifecycle & live locale (M18)', () => {
  it('disposes $mount and clears client context on fiber disposal, including mid-await', async () => {
    const disposers: Array<() => void> = []
    const unmount = vi.fn()
    let resolveMount!: (fn: () => void) => void
    const registerLocale = vi.fn(() => () => {})
    const ctx = {
      slots: { inject: vi.fn(() => () => {}), register: vi.fn(() => () => {}) },
      locale: { register: registerLocale, bind: () => (key: string) => key },
      remote: {
        memory: {} as MemoryRemote,
        $mount: vi.fn(
          () =>
            new Promise<() => void>((resolve) => {
              resolveMount = resolve
            }),
        ),
        $on: () => () => {},
      },
      effect: (cb: () => void | (() => void)) => {
        const off = cb()
        if (typeof off === 'function') disposers.push(off)
        return () => {}
      },
    } as unknown as ClientContext

    const applying = apply(ctx)
    // Dispose mid-await before $mount settles.
    for (const off of disposers) off()
    expect(() => clientContext()).toThrow()

    resolveMount(unmount)
    await applying
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(registerLocale).not.toHaveBeenCalled()
  })

  it('re-renders MemorySection when ctx.locale.subscribe notifies a locale switch', async () => {
    const listeners = new Set<() => void>()
    let title = '记忆'
    setTranslate((key) => (key === 'settings.title' ? title : key))
    setClientContext(
      makeCtx(
        {},
        {
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      ),
    )

    render(h(MemorySection))
    expect(screen.getByText('记忆')).toBeTruthy()

    title = 'Memory'
    act(() => {
      for (const listener of listeners) listener()
    })
    expect(screen.getByText('Memory')).toBeTruthy()
    setTranslate((key) => key)
  })

  it('preserves `this` binding when calling locale.subscribe on a class instance', () => {
    class HostLocale {
      readonly listeners = new Set<() => void>()
      register(): () => void {
        return () => {}
      }
      bind(): (key: string) => string {
        return (key: string) => key
      }
      subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }
    }
    const hostLocale = new HostLocale()
    const base = makeCtx({})
    setClientContext({ ...base, locale: hostLocale })

    render(h(MemorySection))
    expect(hostLocale.listeners.size).toBe(1)
  })
})

describe('proposal old/new comparison (M19)', () => {
  it('fetches superseded memory via remote.view and displays old vs new comparison', async () => {
    const oldRecord = makeMemoryRecord({
      id: MemoryId('old-1'),
      title: 'Old Lesson',
      body: 'Old body text',
    })
    const proposal = makeMemoryRecord({
      id: MemoryId('prop-1'),
      title: 'New Lesson',
      body: 'New body text',
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      supersedes: ['old-1', 'missing-2'],
    })
    const list = vi.fn().mockImplementation((req: { status?: string }) =>
      Promise.resolve({
        items: req.status === 'pending' ? [proposal] : [],
        total: req.status === 'pending' ? 1 : 0,
        limit: 50,
        offset: 0,
        truncated: false,
      }),
    )
    const view = vi.fn().mockImplementation((req: { id: string }) => {
      if (req.id === 'old-1') return Promise.resolve({ record: oldRecord, sources: [] })
      return Promise.reject({ code: 'memory/not-found' })
    })
    setClientContext(makeCtx({ list, view }))

    render(h(MemorySection))
    fireEvent.click(screen.getByRole('tab', { name: /tab\.review/ }))
    const card = await screen.findByText('New Lesson')
    fireEvent.click(card)

    await screen.findByText('Old Lesson')
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Old body text')).toBeTruthy()
    expect(dialog.getByText('New body text')).toBeTruthy()
    expect(dialog.getByText(/missing-2: review\.supersededMissing/)).toBeTruthy()
  })
})

describe('workspace re-resolution when workspaces populate late (L8)', () => {
  it('re-resolves from fallback all once workspaces populate', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0, truncated: false })
    setClientContext(
      makeCtx({
        list,
        activeWorkspace: vi.fn().mockResolvedValue(null),
      }),
    )

    let currentItems: Array<{
      workspaceId: string
      title: string
      path: string
      updatedAt: string
    }> = []
    const useWorkspaces: NonNullable<MemorySectionProps['useWorkspaces']> = (selector) =>
      selector({ items: currentItems })

    const view = render(<MemorySection useWorkspaces={useWorkspaces} />)
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceKey: 'all' })),
    )

    currentItems = [
      {
        workspaceId: 'ws-a',
        title: 'Project A',
        path: 'C:/ws/a',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ]
    view.rerender(<MemorySection useWorkspaces={useWorkspaces} />)

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceKey: 'c:/ws/a' })),
    )
  })
})

describe('config retry on Refresh & clearing actionError on saveConfig (L9)', () => {
  it('retries failed getConfig/modelCatalog on Refresh and clears actionError on saveConfig', async () => {
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ redactSecrets: true })
    const modelCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ providers: [], models: {} })
    const updateConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary error'))
      .mockResolvedValueOnce({ restartRequired: false, config: { redactSecrets: true } })
    setClientContext(makeCtx({ getConfig, modelCatalog, updateConfig }))

    render(h(MemorySection))
    fireEvent.click(screen.getByRole('tab', { name: /tab\.settings/ }))
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('config.groupDream')).toBeNull()

    // Explicit Refresh retries config & catalog.
    fireEvent.click(screen.getByLabelText('common.refresh'))
    await screen.findByText('config.groupDream')
    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(modelCatalog).toHaveBeenCalledTimes(2)

    // First save fails -> sets actionError; second save succeeds -> clears actionError.
    fireEvent.click(screen.getByText('common.save'))
    await waitFor(() => expect(screen.getAllByText(/temporary error/).length).toBeGreaterThan(0))

    fireEvent.click(screen.getByText('common.save'))
    await waitFor(() => expect(screen.queryByText('temporary error')).toBeNull())
  })
})

describe('rpc timer cleanup (L12)', () => {
  it('clears the timeout timer once the call resolves', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const value = await rpc(Promise.resolve({ ok: true as const, value: 42 }), 5_000)
    expect(value).toBe(42)
    expect(clearSpy).toHaveBeenCalled()
  })
})
