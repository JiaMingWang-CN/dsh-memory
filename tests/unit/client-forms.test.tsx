// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { ConfigPanel } from '../../src/client/ConfigPanel.tsx'
import { MemoryCreate } from '../../src/client/MemoryCreate.tsx'
import { draftFromRecord, MemoryEditor, type MemoryDraft } from '../../src/client/MemoryEditor.tsx'
import { TransferPanel } from '../../src/client/TransferPanel.tsx'
import { en, setTranslate, zh } from '../../src/client/locales.ts'
import type { ImportReport } from '../../src/client/context.ts'
import { MemoryId } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const h = React.createElement
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

afterEach(() => cleanup())
setTranslate((key) => key)

describe('tag editor', () => {
  it('keeps the typed comma so a second tag can be entered', () => {
    const record = makeMemoryRecord({ id: MemoryId('tags'), tags: ['one'] })
    const patches: Array<Partial<MemoryDraft>> = []
    render(
      h(MemoryEditor, {
        draft: draftFromRecord(record),
        onChange: (patch) => patches.push(patch),
        onSave: () => undefined,
        onCancel: () => undefined,
      }),
    )
    const input = screen.getByLabelText('detail.tags') as HTMLInputElement
    // Typing the comma must not rewrite the field back to `one`.
    fireEvent.change(input, { target: { value: 'one, ' } })
    expect(input.value).toBe('one, ')
    fireEvent.change(input, { target: { value: 'one, two' } })
    expect(patches.at(-1)?.tags).toEqual(['one', 'two'])
  })

  it('allows typing numeric values below min without locking out input (H10)', () => {
    const onSave = vi.fn()
    render(h(ConfigPanel, { config: { indexMaxBytes: 4096 }, onSave }))
    const input = screen.getByLabelText('config.indexMaxBytes') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2' } })
    expect(input.value).toBe('2')
    fireEvent.change(input, { target: { value: '2048' } })
    expect(input.value).toBe('2048')
    fireEvent.change(input, { target: { value: '500' } })
    expect(input.value).toBe('500')
    fireEvent.blur(input)
    expect(input.value).toBe('1024')
  })

  it('keeps empty draft in MemoryEditor importance until blur and clamps out-of-range (H10)', () => {
    const record = makeMemoryRecord({ id: MemoryId('imp'), importance: 0.5 })
    const patches: Array<Partial<MemoryDraft>> = []
    render(
      h(MemoryEditor, {
        draft: draftFromRecord(record),
        onChange: (patch) => patches.push(patch),
        onSave: () => undefined,
        onCancel: () => undefined,
      }),
    )
    const input = screen.getByLabelText('detail.importance') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    expect(patches).toHaveLength(0)
    fireEvent.change(input, { target: { value: '0.8' } })
    expect(input.value).toBe('0.8')
    expect(patches.at(-1)?.importance).toBe(0.8)
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.blur(input)
    expect(input.value).toBe('1')
    expect(patches.at(-1)?.importance).toBe(1)
  })
})

describe('create form', () => {
  it('saves the chosen type, scope, tags and workspace', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      h(MemoryCreate, {
        workspaceKey: 'c:/ws/a',
        workspaceRoot: 'C:/ws/a',
        onSave,
        onCancel: () => undefined,
      }),
    )
    fireEvent.change(screen.getByLabelText('create.titleField'), { target: { value: '新记忆' } })
    fireEvent.change(screen.getByLabelText('create.bodyField'), { target: { value: 'body' } })
    fireEvent.change(screen.getByLabelText('create.tagsField'), { target: { value: 'a, b' } })
    fireEvent.click(screen.getByText('create.submit'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      type: 'lesson',
      title: '新记忆',
      body: 'body',
      scope: 'workspace',
      workspaceKey: 'c:/ws/a',
      workspaceRoot: 'C:/ws/a',
      tags: ['a', 'b'],
    })
  })

  it('forces the preference type for a global memory', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(h(MemoryCreate, { onSave, onCancel: () => undefined }))
    fireEvent.click(screen.getByLabelText('create.scope'))
    fireEvent.click(screen.getByText('scope.global'))
    expect(screen.getByText('create.globalHint')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('create.titleField'), { target: { value: 'pref' } })
    fireEvent.change(screen.getByLabelText('create.bodyField'), { target: { value: 'body' } })
    fireEvent.click(screen.getByText('create.submit'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ type: 'preference', scope: 'global' })
  })

  it('allows clearing and retyping importance in MemoryCreate (H10)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(h(MemoryCreate, { onSave, onCancel: () => undefined }))
    const imp = screen.getByLabelText('create.importance') as HTMLInputElement
    fireEvent.change(imp, { target: { value: '' } })
    expect(imp.value).toBe('')
    fireEvent.change(imp, { target: { value: '0.9' } })
    expect(imp.value).toBe('0.9')
    fireEvent.change(screen.getByLabelText('create.titleField'), { target: { value: 't' } })
    fireEvent.change(screen.getByLabelText('create.bodyField'), { target: { value: 'b' } })
    fireEvent.click(screen.getByText('create.submit'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ importance: 0.9 })
  })
})

describe('transfer mapping', () => {
  const payload = {
    format: 'dsh-memory',
    version: 1,
    exportedAt: '2026-11-15T00:00:00.000Z',
    scope: { workspaceKey: 'ws-remote' },
    includeArchived: true,
    memories: [
      makeMemoryRecord({
        id: MemoryId('remote-1'),
        scope: { kind: 'workspace', key: 'ws-remote', root: '/remote' },
      }),
    ],
    episodes: [],
  }

  async function chooseFile(): Promise<void> {
    const file = new File([JSON.stringify(payload)], 'export.json', {
      type: 'application/json',
    })
    fireEvent.change(screen.getByLabelText('transfer.import'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('transfer.mapping')).toBeTruthy())
  }

  it('refuses a replace import until every source workspace is mapped', async () => {
    const onImport = vi.fn()
    render(
      h(TransferPanel, {
        workspaces: [{ id: 'ws', path: 'C:/ws/a' }],
        onImport,
      }),
    )
    await chooseFile()
    fireEvent.click(screen.getByLabelText('transfer.mode'))
    fireEvent.click(screen.getByText('transfer.replace'))
    fireEvent.click(screen.getByText('transfer.import'))
    expect(screen.getByText('transfer.needMapping')).toBeTruthy()
    expect(onImport).not.toHaveBeenCalled()

    // Map the source key onto the local workspace, then import for real.
    fireEvent.click(screen.getByLabelText('ws-remote: transfer.mapping'))
    fireEvent.click(screen.getByText('ws-remote → c:/ws/a'))
    fireEvent.click(screen.getByText('transfer.import'))
    fireEvent.click(screen.getByText('common.confirm'))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    expect(onImport.mock.calls[0]?.[3]).toEqual({
      'ws-remote': { key: 'c:/ws/a', root: 'C:/ws/a' },
    })
  })

  it('shows the import report including unmapped entries', async () => {
    const report: ImportReport = {
      created: 1,
      skipped: 0,
      replaced: 0,
      episodesImported: 0,
      unmapped: ['other-1'],
      redacted: 0,
      errors: [{ id: 'bad-1', message: 'nope' }],
      operationId: 'op-1',
    }
    render(
      h(TransferPanel, {
        workspaces: [{ id: 'ws', path: 'C:/ws/a' }],
        onImport: async () => report,
      }),
    )
    await chooseFile()
    fireEvent.click(screen.getByText('transfer.import'))
    await waitFor(() => expect(screen.getByText(/transfer.reportTitle/)).toBeTruthy())
    expect(screen.getByText(/other-1/)).toBeTruthy()
    expect(screen.getByText(/nope/)).toBeTruthy()
  })

  it('ignores stale async file reads and resets replace confirmation on scope/mapping change (M16)', async () => {
    let resolveFirst!: (text: string) => void
    const firstFile = new File(['{}'], 'first.json', { type: 'application/json' })
    firstFile.text = () =>
      new Promise<string>((resolve) => {
        resolveFirst = resolve
      })

    const secondPayload = {
      ...payload,
      memories: [
        makeMemoryRecord({
          id: MemoryId('remote-2'),
          scope: { kind: 'workspace', key: 'ws-second', root: '/second' },
        }),
      ],
    }
    const secondFile = new File([JSON.stringify(secondPayload)], 'second.json', {
      type: 'application/json',
    })

    const onImport = vi.fn()
    const view = render(
      h(TransferPanel, {
        scope: { workspaceKey: 'c:/ws/a' },
        workspaces: [{ id: 'ws', path: 'C:/ws/a' }],
        onImport,
      }),
    )

    const input = screen.getByLabelText('transfer.import')
    fireEvent.change(input, { target: { files: [firstFile] } })
    fireEvent.change(input, { target: { files: [secondFile] } })
    await waitFor(() => expect(screen.getByLabelText('ws-second: transfer.mapping')).toBeTruthy())

    // Now resolve the older file read; it must not clobber the newer file's mapping.
    resolveFirst(JSON.stringify(payload))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.queryByLabelText('ws-remote: transfer.mapping')).toBeNull()
    expect(screen.getByLabelText('ws-second: transfer.mapping')).toBeTruthy()

    // Enter replace confirmation, then change scope -> confirmation must reset.
    fireEvent.click(screen.getByLabelText('transfer.mode'))
    fireEvent.click(screen.getByText('transfer.replace'))
    fireEvent.click(screen.getByLabelText('ws-second: transfer.mapping'))
    fireEvent.click(screen.getByText('ws-second → c:/ws/a'))
    fireEvent.click(screen.getByText('transfer.import'))
    expect(screen.getByText('transfer.confirmReplace')).toBeTruthy()

    view.rerender(
      h(TransferPanel, {
        scope: 'all',
        workspaces: [{ id: 'ws', path: 'C:/ws/a' }],
        onImport,
      }),
    )
    expect(screen.queryByText('transfer.confirmReplace')).toBeNull()

    // Re-enter replace confirmation, then change mapping -> confirmation must reset.
    fireEvent.click(screen.getByText('transfer.import'))
    expect(screen.getByText('transfer.confirmReplace')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('ws-second: transfer.mapping'))
    fireEvent.click(screen.getByText('ws-second → transfer.mappingSkip'))
    expect(screen.queryByText('transfer.confirmReplace')).toBeNull()
  })
})

describe('config redactSecrets confirmation (M19)', () => {
  it('requires explicit confirmation before disabling redactSecrets', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(h(ConfigPanel, { config: { redactSecrets: true }, onSave }))

    fireEvent.click(screen.getByRole('switch', { name: 'config.redactSecrets' }))
    fireEvent.click(screen.getByText('common.save'))
    expect(screen.getByText('config.confirmDisableRedact')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()

    // Cancelling keeps onSave uncalled.
    fireEvent.click(screen.getByText('common.cancel'))
    expect(screen.queryByText('config.confirmDisableRedact')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()

    // Saving again and confirming invokes onSave with redactSecrets: false.
    fireEvent.click(screen.getByText('common.save'))
    fireEvent.click(screen.getByText('common.confirm'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ redactSecrets: false })
  })
})

describe('locale dictionaries', () => {
  it('keeps zh and en keys and placeholders aligned', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
    for (const key of zhKeys) {
      expect(placeholders(en[key] as string), key).toEqual(placeholders(zh[key] as string))
    }
  })
})

describe('theme tokens', () => {
  it('keeps literal colors and removed focus rings out of the stylesheet', () => {
    const css = readFileSync(resolve(root, 'src/client/styles.ts'), 'utf8')
    expect(css).not.toMatch(/rgba?\(/)
    expect(css).not.toMatch(/hsla?\(/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
