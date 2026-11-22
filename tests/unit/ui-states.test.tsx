// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { MemoryList } from '../../src/client/MemoryList.tsx'
import { setTranslate } from '../../src/client/locales.ts'
import { NARROW_MEDIA_CSS } from '../../src/client/styles.ts'

const h = React.createElement
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

afterEach(() => cleanup())
setTranslate((key) => key)

describe('empty state', () => {
  it('shows the empty message and no list rows when there are no records', () => {
    render(h(MemoryList, { records: [] }))
    expect(screen.getByText('state.empty')).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})

describe('error state', () => {
  it('shows the error with a Retry action', () => {
    const onRetry = vi.fn()
    render(h(MemoryList, { records: [], error: 'boom', onRetry }))
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByText('common.retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('loading state', () => {
  it('shows loading instead of the empty message on first load', () => {
    render(h(MemoryList, { records: [], loading: true }))
    expect(screen.getByText('state.loading')).toBeTruthy()
    expect(screen.queryByText('state.empty')).toBeNull()
  })
})

describe('theme tokens', () => {
  it('uses no literal hex colors outside the icon artwork', () => {
    const dir = resolve(root, 'src', 'client')
    const files = readdirSync(dir).filter(
      (name) => /\.(ts|tsx)$/.test(name) && name !== 'MemoryIcon.tsx',
    )
    const offenders: string[] = []
    for (const name of files) {
      const text = readFileSync(resolve(dir, name), 'utf8')
      if (/#[0-9a-fA-F]{3,8}\b/.test(text)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })
})

describe('narrow layout', () => {
  it('stacks the toolbar and widens the modal below 768px', () => {
    expect(NARROW_MEDIA_CSS).toContain('@media (max-width: 768px)')
    expect(NARROW_MEDIA_CSS).toContain('flex-direction: column')
    expect(NARROW_MEDIA_CSS).toContain('.dsh-mem-modal')
  })
})
