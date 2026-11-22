// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { Button, Modal, Select } from '../../src/client/ui.tsx'

const h = React.createElement

afterEach(() => cleanup())

function open(onClose: () => void): void {
  render(h(Modal, { title: 'Detail', onClose }, h('div', null, 'body')))
}

describe('modal', () => {
  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn()
    open(onClose)
    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    open(onClose)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog open when its panel is clicked', () => {
    const onClose = vi.fn()
    open(onClose)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps focus in a field when the parent re-renders with a new close callback', () => {
    const view = render(
      h(Modal, { title: 'Edit', onClose: () => undefined }, h('input', { 'aria-label': 'field' })),
    )
    const field = screen.getByLabelText('field') as HTMLInputElement
    field.focus()
    view.rerender(
      h(Modal, { title: 'Edit', onClose: () => undefined }, h('input', { 'aria-label': 'field' })),
    )
    expect(document.activeElement).toBe(field)
  })

  it('moves focus into the panel and back to the opener on close', () => {
    function Harness(): React.ReactElement {
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        null,
        h(Button, { onClick: () => setOpen(true) }, 'open'),
        open
          ? h(
              Modal,
              { title: 'Detail', onClose: () => setOpen(false) },
              h('div', null, h(Button, null, 'inside')),
            )
          : null,
      )
    }
    render(h(Harness))
    const opener = screen.getByText('open')
    opener.focus()
    fireEvent.click(opener)
    // Focus starts inside the dialog rather than on the page behind it.
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull()

    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('presentation'))
    expect(document.activeElement).toBe(opener)
  })

  it('does not close the modal when Escape closes an open Select menu inside it (M14)', () => {
    const onClose = vi.fn()
    render(
      h(
        Modal,
        { title: 'Form', onClose },
        h(Select, {
          label: 'Scope',
          value: 'a',
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        }),
      ),
    )
    const trigger = screen.getByLabelText('Scope')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // Pressing Escape again with the menu closed closes the modal.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('skips disabled/hidden elements and pulls outside focus into the modal on Tab (M15)', () => {
    render(
      h(
        'div',
        null,
        h(Button, null, 'outside'),
        h(
          Modal,
          { title: 'Trap', onClose: () => undefined },
          h(
            'div',
            null,
            h(Button, { disabled: true }, 'disabled-btn'),
            h('button', { type: 'button', style: { display: 'none' } }, 'hidden-btn'),
            h(Button, null, 'enabled-btn'),
          ),
        ),
      ),
    )
    const outside = screen.getByText('outside')
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    const enabledBtn = screen.getByText('enabled-btn')

    // Outside focus is pulled into the modal on Tab / Shift+Tab.
    outside.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeBtn)

    outside.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(enabledBtn)

    // Tabbing from the last enabled button wraps to the first (skipping disabled/hidden).
    enabledBtn.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeBtn)
  })

  it('clears the Select focus timer on unmount (L12)', () => {
    const clearSpy = vi.spyOn(window, 'clearTimeout')
    const view = render(
      h(Select, {
        label: 'Pick',
        value: 'a',
        options: [{ value: 'a', label: 'Alpha' }],
      }),
    )
    fireEvent.keyDown(screen.getByLabelText('Pick'), { key: 'ArrowDown' })
    view.unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
