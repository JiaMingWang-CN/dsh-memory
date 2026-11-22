// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { MemoryList } from '../../src/client/MemoryList.tsx'
import { MemoryDetail } from '../../src/client/MemoryDetail.tsx'
import { setTranslate } from '../../src/client/locales.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const h = React.createElement

afterEach(() => cleanup())

setTranslate((key) => key)

function record(
  id: string,
  title: string,
  updatedAt: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    title,
    body: `${title} body`,
    updatedAt,
    ...overrides,
  })
}

describe('list render', () => {
  it('sorts three records newest-first and shows type and scope badges', () => {
    const records = [
      record('a', 'Oldest', '2026-01-01T00:00:00.000Z'),
      record('b', 'Newest', '2026-03-01T00:00:00.000Z'),
      record('c', 'Middle', '2026-02-01T00:00:00.000Z'),
    ]
    render(h(MemoryList, { records }))
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.textContent?.includes('Newest'))).toEqual([true, false, false])
    expect(rows[0]?.textContent).toContain('type.lesson')
    expect(rows[0]?.textContent).toContain('scope.workspace')
    expect(rows.map((row) => row.textContent?.includes('Middle'))).toEqual([false, true, false])
    expect(rows.map((row) => row.textContent?.includes('Oldest'))).toEqual([false, false, true])
  })
})

describe('detail save', () => {
  it('sends the original content revision when saving an edited title', async () => {
    const stored = record('a', 'Original', '2026-01-01T00:00:00.000Z')
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(h(MemoryDetail, { record: stored, onSave }))

    fireEvent.click(screen.getByText('common.edit'))
    fireEvent.change(screen.getByLabelText('detail.title'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('common.save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      id: stored.id,
      expectedContentRevision: stored.contentRevision,
      title: 'Renamed',
    })
  })
})

describe('detail conflict', () => {
  it('keeps the draft and shows the refresh prompt on memory/conflict', async () => {
    const stored = record('a', 'Original', '2026-01-01T00:00:00.000Z')
    const onSave = vi.fn().mockRejectedValue({
      code: 'memory/conflict',
      details: { code: 'MEMORY_CONFLICT' },
    })
    render(h(MemoryDetail, { record: stored, onSave }))

    fireEvent.click(screen.getByText('common.edit'))
    fireEvent.change(screen.getByLabelText('detail.title'), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByText('common.save'))

    await screen.findByText('error.conflict')
    expect((screen.getByLabelText('detail.title') as HTMLInputElement).value).toBe('Draft')
  })

  it('shows the localized message for a mapped business failure', async () => {
    const stored = record('a', 'Original', '2026-01-01T00:00:00.000Z')
    const onSave = vi.fn().mockRejectedValue({ code: 'memory/capacity' })
    render(h(MemoryDetail, { record: stored, onSave }))

    fireEvent.click(screen.getByText('common.edit'))
    fireEvent.click(screen.getByText('common.save'))

    await screen.findByText('error.capacity')
  })

  it('keeps the draft in edit mode if conflict reload fails, and exits on success (L11)', async () => {
    const stored = record('a', 'Original', '2026-01-01T00:00:00.000Z')
    const onSave = vi.fn().mockRejectedValue({ code: 'memory/conflict' })
    const onReload = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined)
    render(h(MemoryDetail, { record: stored, onSave, onReload }))

    fireEvent.click(screen.getByText('common.edit'))
    fireEvent.change(screen.getByLabelText('detail.title'), { target: { value: 'Unsaved Draft' } })
    fireEvent.click(screen.getByText('common.save'))
    await screen.findByText('error.conflict')

    // First reload fails: must stay in editing mode with the user's draft intact.
    fireEvent.click(screen.getByText('detail.reload'))
    await screen.findByText('network down')
    expect((screen.getByLabelText('detail.title') as HTMLInputElement).value).toBe('Unsaved Draft')

    // Second reload succeeds: exits editing mode.
    fireEvent.click(screen.getByText('detail.reload'))
    await waitFor(() => expect(screen.queryByLabelText('detail.title')).toBeNull())
  })
})

describe('archive confirm', () => {
  it('asks before archiving and sends nothing when cancelled', () => {
    const stored = record('a', 'Archive me', '2026-01-01T00:00:00.000Z')
    const onDelete = vi.fn()
    render(h(MemoryDetail, { record: stored, onDelete }))

    fireEvent.click(screen.getByText('detail.archive'))
    expect(screen.getByText('detail.archiveHint')).toBeTruthy()
    fireEvent.click(screen.getByText('common.cancel'))
    expect(screen.queryByText('detail.archiveHint')).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })
})

describe('restore', () => {
  it('invokes restore for an archived record and hides the archive action', () => {
    const stored = record('a', 'Archived one', '2026-01-01T00:00:00.000Z', {
      status: 'archived',
    })
    const onRestore = vi.fn()
    render(h(MemoryDetail, { record: stored, onRestore }))

    expect(screen.queryByText('detail.archive')).toBeNull()
    fireEvent.click(screen.getByText('common.restore'))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })
})
