// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { ConfigPanel } from '../../src/client/ConfigPanel.tsx'
import type { ClientContext, MemoryRemote, WorkspaceInfo } from '../../src/client/context.ts'
import { diffLines } from '../../src/client/diff.ts'
import { MemoryDetail } from '../../src/client/MemoryDetail.tsx'
import { MemoryList } from '../../src/client/MemoryList.tsx'
import { MemorySection } from '../../src/client/MemorySection.tsx'
import { MemoryUsageText } from '../../src/client/MemoryUsageText.tsx'
import { TransferPanel } from '../../src/client/TransferPanel.tsx'
import { setTranslate } from '../../src/client/locales.ts'
import { clearClientContext, setClientContext } from '../../src/client/runtime.ts'
import { DreamId, MemoryId, type DreamRun } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'
import { openStore } from '../helpers/runner.ts'

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

function makeCtx(remote: Partial<MemoryRemote>): ClientContext {
  const fullRemote: Partial<MemoryRemote> = {
    list: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0, truncated: false }),
    overview: vi.fn().mockResolvedValue({
      workspaceKey: 'c:/ws/a',
      counts: { active: 4, pending: 2, archived: 1, stored: 7 },
      pendingReview: 2,
      recentDream: null,
      index: { entries: 4, bytes: 2048 },
    }),
    activeWorkspace: vi.fn().mockResolvedValue('c:/ws/a'),
    getConfig: vi.fn().mockResolvedValue({ indexMaxBytes: 4096, redactSecrets: true }),
    dreamStatus: vi.fn().mockResolvedValue(null),
    ...remote,
  }
  return {
    slots: { inject: (_k: string, cb: () => () => void) => cb(), register: () => () => {} },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    remote: { memory: fullRemote as MemoryRemote, $on: () => () => {} },
    workspaces: { list: () => workspaces },
  } as unknown as ClientContext
}

describe('diffLines', () => {
  it('computes added, removed and unchanged lines', () => {
    const lines = diffLines('alpha\nbeta\ngamma', 'alpha\nbeta updated\ngamma\ndelta')
    expect(lines).toEqual([
      { kind: 'same', text: 'alpha' },
      { kind: 'remove', text: 'beta' },
      { kind: 'add', text: 'beta updated' },
      { kind: 'same', text: 'gamma' },
      { kind: 'add', text: 'delta' },
    ])
  })
})

describe('MemoryStore.list keyword query filter', () => {
  it('filters memories case-insensitively across title, body and tags', async () => {
    const { store } = await openStore({ defaultWorkspaceKey: 'c:/ws/a' })
    await store.create({
      type: 'lesson',
      title: 'Build caching pitfall',
      body: 'Always clear esbuild cache after updating tsconfig.',
      tags: ['build', 'typescript'],
      scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
      actor: 'user',
    })
    await store.create({
      type: 'wiki',
      title: 'Release notes checklist',
      body: 'Verify CHANGELOG before tagging.',
      tags: ['release'],
      scope: { kind: 'workspace', key: 'c:/ws/a', root: 'C:/ws/a' },
      actor: 'user',
    })

    const byTagAndBody = store.list({
      workspaceKey: 'c:/ws/a',
      query: 'TYPESCRIPT esbuild',
      management: true,
    })
    expect(byTagAndBody.total).toBe(1)
    expect(byTagAndBody.items[0]?.title).toBe('Build caching pitfall')

    const byTitle = store.list({ workspaceKey: 'c:/ws/a', query: 'changelog', management: true })
    expect(byTitle.total).toBe(1)
    expect(byTitle.items[0]?.title).toBe('Release notes checklist')

    const none = store.list({ workspaceKey: 'c:/ws/a', query: 'nonexistent', management: true })
    expect(none.total).toBe(0)
  })
})

describe('4-tab shell, overview meter & search/pill filters', () => {
  it('switches tabs via click and keyboard arrows, renders index meter, and sends debounced search queries', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0, truncated: false })
    setClientContext(makeCtx({ list }))

    render(h(MemorySection))
    await waitFor(() => expect(screen.getByText('2.0 KB / 4.0 KB')).toBeTruthy())

    // Review tab carries the pending count badge.
    const reviewTab = screen.getByRole('tab', { name: /tab\.review/ })
    expect(reviewTab.textContent).toContain('2')

    // ArrowRight moves focus and selection from Memories to Review.
    const memoriesTab = screen.getByRole('tab', { name: /tab\.memories/ })
    memoriesTab.focus()
    fireEvent.keyDown(memoriesTab, { key: 'ArrowRight' })
    expect(reviewTab.getAttribute('aria-selected')).toBe('true')

    // Clicking the Active overview pill returns to Memories with status=active.
    fireEvent.click(screen.getByRole('button', { name: /overview\.active/ }))
    expect(memoriesTab.getAttribute('aria-selected')).toBe('true')
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' })),
    )

    // Typing a search query calls remote.list with the trimmed query.
    fireEvent.change(screen.getByLabelText('filter.search'), { target: { value: 'esbuild' } })
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ query: 'esbuild' })),
    )

    // Selecting a type filter pill updates the list request.
    fireEvent.click(screen.getByRole('button', { name: 'type.wiki' }))
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'wiki', query: 'esbuild' }),
      ),
    )
  })
})

describe('MemoryList tags and filtered empty state', () => {
  it('renders user tags with overflow indicator and shows filter reset on empty filtered results', () => {
    const record = makeMemoryRecord({
      id: MemoryId('tagged'),
      title: 'Tagged memory',
      tags: ['alpha', 'beta', 'gamma', 'delta'],
    })
    const { rerender } = render(h(MemoryList, { records: [record] }))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.getByText('gamma')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()

    const onClearFilters = vi.fn()
    rerender(h(MemoryList, { records: [], filtered: true, onClearFilters }))
    expect(screen.getByText('list.noMatches')).toBeTruthy()
    fireEvent.click(screen.getByText('filter.clear'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })
})

describe('MemoryDetail modal polish and inline discard confirm', () => {
  it('omits duplicated title in modal mode and uses inline confirmation when cancelling dirty edits', () => {
    const stored = makeMemoryRecord({
      id: MemoryId('m-detail'),
      title: 'Unique Detail Title',
      body: 'Memory content',
      tags: ['t1', 't2'],
    })
    render(h(MemoryDetail, { record: stored, inModal: true }))
    // Title is owned by the outer Modal header when inModal=true.
    expect(screen.queryByRole('heading', { name: 'Unique Detail Title' })).toBeNull()

    fireEvent.click(screen.getByText('common.edit'))
    // Remove a tag chip in one click.
    fireEvent.click(screen.getAllByLabelText('detail.removeTag')[0] as HTMLElement)
    fireEvent.change(screen.getByLabelText('detail.title'), { target: { value: 'Modified' } })

    // First cancel prompts inline instead of window.confirm.
    fireEvent.click(screen.getByText('common.cancel'))
    expect(screen.getByText('detail.dirtyClose')).toBeTruthy()
    fireEvent.click(screen.getByText('detail.discardChanges'))
    expect(screen.queryByLabelText('detail.title')).toBeNull()
  })
})

describe('proposal review diff, save-and-accept and sequential navigation', () => {
  it('supports diff/side-by-side switch, save-and-accept and advancing to the next proposal', async () => {
    const p1 = makeMemoryRecord({
      id: MemoryId('p1'),
      title: 'Proposal One',
      body: 'Line A\nLine B new',
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
      supersedes: ['old-1'],
    })
    const p2 = makeMemoryRecord({
      id: MemoryId('p2'),
      title: 'Proposal Two',
      body: 'Second proposal body',
      status: 'pending',
      origin: 'dream',
      ownership: 'derived',
    })
    const old1 = makeMemoryRecord({
      id: MemoryId('old-1'),
      title: 'Old One',
      body: 'Line A\nLine B old',
    })
    const dreamRun: DreamRun = {
      id: DreamId('dream-42'),
      trigger: 'manual',
      scopeKey: 'c:/ws/a',
      status: 'completed',
      startedAt: '2026-11-22T05:00:00.000Z',
      finishedAt: '2026-11-22T05:01:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-chat',
      episodes: 6,
      committed: 1,
      pending: 2,
    }
    const update = vi.fn().mockResolvedValue({ ...p1, title: 'Proposal One Edited' })
    const review = vi.fn().mockResolvedValue({ ...p1, status: 'active' })
    const list = vi.fn().mockImplementation((req: { status?: string }) =>
      Promise.resolve({
        items: req.status === 'pending' ? [p1, p2] : [],
        total: req.status === 'pending' ? 2 : 0,
        limit: 50,
        offset: 0,
        truncated: false,
      }),
    )
    const view = vi.fn().mockResolvedValue({ record: old1, sources: [] })
    setClientContext(
      makeCtx({ list, view, update, review, dreamStatus: vi.fn().mockResolvedValue(dreamRun) }),
    )

    render(h(MemorySection))
    fireEvent.click(screen.getByRole('tab', { name: /tab\.review/ }))

    // Enhanced dream status card renders model and episode counts.
    await screen.findByText('deepseek / deepseek-chat')
    expect(screen.getByText('6')).toBeTruthy()

    // Open first proposal -> diff view is shown by default.
    fireEvent.click(await screen.findByText('Proposal One'))
    const dialog = within(screen.getByRole('dialog'))
    await dialog.findByText('Line B old')
    expect(dialog.getByText('Line B new')).toBeTruthy()

    // Switch to side-by-side comparison mode.
    fireEvent.click(dialog.getByRole('button', { name: 'review.sideBySide' }))
    expect(dialog.getByText('review.newVersion')).toBeTruthy()

    // Edit before accept -> save & accept calls update then review('accept') and advances to p2.
    fireEvent.click(dialog.getByText('review.editBeforeAccept'))
    fireEvent.change(dialog.getByLabelText('detail.title'), {
      target: { value: 'Proposal One Edited' },
    })
    fireEvent.click(dialog.getByText('review.saveAndAccept'))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(review).toHaveBeenCalledWith({ id: 'p1', action: 'accept' }))
    await screen.findByRole('dialog', { name: 'Proposal Two' })
  })
})

describe('ConfigPanel minutes conversion, grouping & discard', () => {
  it('converts autoDreamMinIntervalMs to minutes and saves back in milliseconds', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onDirtyChange = vi.fn()
    render(
      h(ConfigPanel, {
        config: { autoDream: true, autoDreamMinIntervalMs: 300_000, indexMaxBytes: 4096 },
        onSave,
        onDirtyChange,
      }),
    )

    expect(screen.getByText('config.groupDream')).toBeTruthy()
    expect(screen.getByText('config.groupIndex')).toBeTruthy()
    expect(screen.getByText('config.groupRetention')).toBeTruthy()
    expect(screen.getByText('config.groupPrivacy')).toBeTruthy()

    const intervalInput = screen.getByLabelText('config.autoDreamMinIntervalMs') as HTMLInputElement
    expect(intervalInput.value).toBe('5')

    fireEvent.change(intervalInput, { target: { value: '12' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('config.discard')).toBeTruthy()

    fireEvent.click(screen.getByText('common.save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ autoDreamMinIntervalMs: 720_000 })
    await screen.findByText('config.saved')
  })
})

describe('TransferPanel dropzone preview', () => {
  it('renders parsed export summary after picking a valid file', async () => {
    const file = new File(
      [
        JSON.stringify({
          format: 'dsh-memory',
          version: 1,
          exportedAt: '2026-11-15T00:00:00.000Z',
          scope: 'all',
          includeArchived: true,
          memories: [makeMemoryRecord({ id: MemoryId('m1') })],
          episodes: [],
        }),
      ],
      'backup.json',
      { type: 'application/json' },
    )
    render(h(TransferPanel, { workspaces }))
    fireEvent.change(screen.getByLabelText('transfer.import'), { target: { files: [file] } })
    await screen.findByText('transfer.summaryMemories')
    expect(screen.getByText('backup.json')).toBeTruthy()
    expect(screen.getByText('transfer.clearFile')).toBeTruthy()
  })
})

describe('MemoryUsageText non-zero filtering', () => {
  it('omits zero counters to reduce chat row noise', () => {
    render(
      h(MemoryUsageText, {
        usage: {
          turns: { '1': { injected: ['a', 'b'], written: [], searched: 0 } },
          totalInjected: 2,
          totalWritten: 0,
        },
      }),
    )
    const note = screen.getByText(/usage\.title/)
    expect(note.textContent).toBe('usage.title usage.injected 2')
  })
})
