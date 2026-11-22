// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import * as React from 'react'
import type { ClientContext } from '../../src/client/context.ts'
import { MemoryUsageAssistantAction, MemoryUsageText } from '../../src/client/MemoryUsageText.tsx'
import { setTranslate } from '../../src/client/locales.ts'
import { clearClientContext, setClientContext } from '../../src/client/runtime.ts'
import type { MemoryUsageView } from '../../src/shared/types.ts'

const h = React.createElement

const dict: Record<string, string> = {
  'usage.title': '本次记忆',
  'usage.injected': '注入',
  'usage.written': '写入',
  'usage.searched': '搜索',
}

afterEach(() => cleanup())
setTranslate((key) => dict[key] ?? key)

describe('memory usage note', () => {
  it('renders nothing without activity', () => {
    const usage: MemoryUsageView = { turns: {}, totalInjected: 0, totalWritten: 0 }
    const { container } = render(h(MemoryUsageText, { usage }))
    expect(container.firstChild).toBeNull()
  })

  it('shows a small inline note with injected, written and searched counts', () => {
    const usage: MemoryUsageView = {
      turns: { '1': { injected: ['a', 'b'], written: ['c'], searched: 2 } },
      totalInjected: 2,
      totalWritten: 1,
    }
    render(h(MemoryUsageText, { usage }))
    const note = screen.getByText(/本次记忆/)
    expect(note.textContent).toBe('本次记忆 注入 2 · 写入 1 · 搜索 2')
    expect((note as HTMLElement).style.order).toBe('1')
    expect((note as HTMLElement).style.fontSize).toBe('12px')
    // It is a plain text note, not a card.
    expect(note.className).toBe('dsh-mem-usage-note')
  })

  it('reads the memoryUsage projection through the slot hook', () => {
    const usage: MemoryUsageView = {
      turns: { '1': { injected: [], written: [], searched: 1 } },
      totalInjected: 0,
      totalWritten: 0,
    }
    render(h(MemoryUsageAssistantAction, { useProjection: () => usage }))
    expect(screen.getByText(/搜索 1/)).toBeTruthy()
  })

  it('renders nothing when the projection is absent', () => {
    const { container } = render(h(MemoryUsageAssistantAction, { useProjection: () => undefined }))
    expect(container.firstChild).toBeNull()
  })

  it('re-renders when ctx.locale.subscribe notifies a locale change (M18)', () => {
    const listeners = new Set<() => void>()
    let lang: 'zh' | 'en' = 'zh'
    const enDict: Record<string, string> = {
      'usage.title': 'Session memory',
      'usage.injected': 'Injected',
      'usage.written': 'Written',
      'usage.searched': 'Searched',
    }
    setTranslate((key) => (lang === 'zh' ? (dict[key] ?? key) : (enDict[key] ?? key)))
    setClientContext({
      slots: { inject: () => () => {}, register: () => () => {} },
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      remote: { memory: {} as never, $on: () => () => {} },
    } as unknown as ClientContext)

    const usage: MemoryUsageView = {
      turns: { '1': { injected: ['a'], written: [], searched: 1 } },
      totalInjected: 1,
      totalWritten: 0,
    }
    render(h(MemoryUsageText, { usage }))
    expect(screen.getByText(/本次记忆/)).toBeTruthy()

    lang = 'en'
    act(() => {
      for (const listener of listeners) listener()
    })
    expect(screen.getByText(/Session memory/)).toBeTruthy()

    clearClientContext()
    setTranslate((key) => dict[key] ?? key)
  })
})
