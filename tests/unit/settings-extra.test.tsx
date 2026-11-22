// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { ConfigPanel } from '../../src/client/ConfigPanel.tsx'
import type { ClientContext, MemoryRemote, WorkspaceInfo } from '../../src/client/context.ts'
import { MemorySection } from '../../src/client/MemorySection.tsx'
import { ReviewPanel } from '../../src/client/ReviewPanel.tsx'
import { TransferPanel } from '../../src/client/TransferPanel.tsx'
import { WorkspaceFilter, pickDefaultWorkspace } from '../../src/client/WorkspaceFilter.tsx'
import { setTranslate } from '../../src/client/locales.ts'
import { setClientContext } from '../../src/client/runtime.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const h = React.createElement

afterEach(() => cleanup())
setTranslate((key) => key)

function pending(id: string, title: string): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    title,
    body: `${title} body`,
    status: 'pending',
    origin: 'dream',
    ownership: 'derived',
    sourceEpisodeIds: ['episode-1'],
    supersedes: ['old-1'],
  })
}

const workspaces: WorkspaceInfo[] = [
  { id: 'ws-old', title: 'Old', path: 'C:/old', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'ws-new', title: 'New', path: 'C:/new', updatedAt: '2026-03-01T00:00:00.000Z' },
]

describe('workspace default', () => {
  it('picks the most recent workspace and asks the Host for that key only', async () => {
    expect(pickDefaultWorkspace(workspaces)).toBe('c:/new')

    const list = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, truncated: false })
    const remote = {
      list,
      overview: vi.fn().mockResolvedValue(undefined),
      activeWorkspace: vi.fn().mockResolvedValue(null),
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as MemoryRemote
    const ctx = {
      slots: { inject: (_k: string, cb: () => () => void) => cb(), register: () => () => {} },
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      remote: { memory: remote, $on: () => () => {} },
      workspaces: { list: () => workspaces },
    } as unknown as ClientContext
    setClientContext(ctx)

    render(h(MemorySection))
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(list.mock.calls[0]?.[0]).toMatchObject({ workspaceKey: 'c:/new' })
    expect((screen.getByLabelText('filter.workspace') as HTMLButtonElement).textContent).toContain(
      'New',
    )
  })
})

describe('workspace all warning', () => {
  it('shows the cross-project notice when All accessible is selected', () => {
    render(h(WorkspaceFilter, { workspaces, value: 'all' }))
    expect(screen.getByText('workspace.warning')).toBeTruthy()
  })
})

describe('remote identity', () => {
  it('resolves the mounted namespace once so a rerender does not refetch', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, truncated: false })
    const remote = {
      list,
      overview: vi.fn().mockResolvedValue(undefined),
      activeWorkspace: vi.fn().mockResolvedValue(null),
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as MemoryRemote
    // `ctx.get` returns a fresh tracing proxy on every call in the real
    // runtime; a new object here reproduces that identity churn.
    const ctx = {
      slots: { inject: (_k: string, cb: () => () => void) => cb(), register: () => () => {} },
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      remote: { memory: remote, $on: () => () => {} },
      workspaces: { list: () => workspaces },
      get: () => ({ ...remote }),
    } as unknown as ClientContext
    setClientContext(ctx)

    const view = render(h(MemorySection))
    await waitFor(() => expect(list).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 30))
    view.rerender(h(MemorySection))
    await new Promise((resolve) => setTimeout(resolve, 30))
    // One call for the visible page and one for the pending-review list; a
    // rerender must not add a third.
    expect(list).toHaveBeenCalledTimes(2)
  })
})

describe('review accept', () => {
  it('removes an accepted proposal from the pending list', () => {
    function Harness(): React.ReactElement {
      const [items, setItems] = React.useState([pending('p1', 'One'), pending('p2', 'Two')])
      return h(ReviewPanel, {
        pending: items,
        onAccept: (id: string) => setItems((current) => current.filter((item) => item.id !== id)),
        onReject: () => undefined,
        onEdit: () => undefined,
      })
    }
    render(h(Harness))
    expect(screen.getAllByText('review.accept')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('review.accept')[0] as HTMLElement)
    expect(screen.getAllByText('review.accept')).toHaveLength(1)
  })
})

describe('import replace', () => {
  it('asks for a second confirmation and sends nothing when cancelled', async () => {
    const onImport = vi.fn()
    const file = new File(
      [
        JSON.stringify({
          format: 'dsh-memory',
          version: 1,
          exportedAt: '2026-11-15T00:00:00.000Z',
          scope: { workspaceKey: 'c:/new' },
          includeArchived: true,
          memories: [
            makeMemoryRecord({
              id: MemoryId('imported'),
              scope: { kind: 'workspace', key: 'c:/new', root: 'C:/new' },
            }),
          ],
          episodes: [],
        }),
      ],
      'export.json',
      { type: 'application/json' },
    )
    render(h(TransferPanel, { onImport, workspaces }))
    fireEvent.change(screen.getByLabelText('transfer.import'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('transfer.mapping')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('transfer.mode'))
    fireEvent.click(screen.getByText('transfer.replace'))
    fireEvent.click(screen.getByText('transfer.import'))
    expect(screen.getByText('transfer.confirmReplace')).toBeTruthy()
    expect(onImport).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.cancel'))
    expect(screen.queryByText('transfer.confirmReplace')).toBeNull()
    expect(onImport).not.toHaveBeenCalled()
  })
})

describe('config model catalog', () => {
  it('chooses provider and model from the reported catalog', () => {
    const onSave = vi.fn()
    render(
      h(ConfigPanel, {
        config: { dreamModelMode: 'fixed' },
        onSave,
        catalog: {
          providers: [{ id: 'deepseek', name: 'DeepSeek' }],
          models: { deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        },
      }),
    )
    fireEvent.click(screen.getByLabelText('config.dreamProvider'))
    fireEvent.click(screen.getByText('DeepSeek (deepseek)'))
    fireEvent.click(screen.getByLabelText('config.dreamModel'))
    fireEvent.click(screen.getByText('DeepSeek Chat (deepseek-chat)'))
    fireEvent.click(screen.getByText('common.save'))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ dreamProvider: 'deepseek', dreamModel: 'deepseek-chat' }),
    )
  })
})

describe('config reasoning efforts', () => {
  it('offers the selected model reasoning efforts as options', async () => {
    const onSave = vi.fn()
    const loadEfforts = vi.fn().mockResolvedValue({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
    })
    render(
      h(ConfigPanel, {
        config: {
          dreamModelMode: 'fixed',
          dreamProvider: 'deepseek',
          dreamModel: 'deepseek-chat',
        },
        onSave,
        catalog: {
          providers: [{ id: 'deepseek', name: 'DeepSeek' }],
          models: { deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        },
        loadEfforts,
      }),
    )
    await waitFor(() => expect(loadEfforts).toHaveBeenCalledWith('deepseek', 'deepseek-chat'))
    fireEvent.click(screen.getByLabelText('config.dreamReasoningEffort'))
    fireEvent.click(screen.getByText('High (high)'))
    fireEvent.click(screen.getByText('common.save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dreamReasoningEffort: 'high' }))
  })
})

describe('config follow-session efforts', () => {
  it('offers the default session model efforts in follow mode', async () => {
    const onSave = vi.fn()
    const loadEfforts = vi.fn().mockResolvedValue({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
    })
    render(
      h(ConfigPanel, {
        config: { dreamModelMode: 'follow-session' },
        onSave,
        catalog: {
          providers: [{ id: 'deepseek', name: 'DeepSeek' }],
          models: { deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
          defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
        },
        loadEfforts,
      }),
    )
    await waitFor(() => expect(loadEfforts).toHaveBeenCalledWith('deepseek', 'deepseek-chat'))
    fireEvent.click(screen.getByLabelText('config.dreamReasoningEffort'))
    fireEvent.click(screen.getByText('Low (low)'))
    fireEvent.click(screen.getByText('common.save'))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        dreamModelMode: 'follow-session',
        dreamProvider: '',
        dreamModel: '',
        dreamReasoningEffort: 'low',
      }),
    )
  })
})

describe('config fields', () => {
  it('omits autoCommitConfidence and rejects a fixed dream model without provider/model', () => {
    const onSave = vi.fn()
    render(h(ConfigPanel, { config: {}, onSave }))
    expect(screen.queryByLabelText('config.autoCommitConfidence')).toBeNull()
    expect(screen.queryByText('自动入库阈值')).toBeNull()

    fireEvent.click(screen.getByLabelText('config.dreamModelMode'))
    fireEvent.click(screen.getByText('config.dreamModeFixed'))
    fireEvent.click(screen.getByText('common.save'))
    expect(screen.getByText('config.dreamModelRequired')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })
})
