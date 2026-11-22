/**
 * Small in-house control set for the Memory page.
 *
 * DSH's own primitives are not a runtime module a plugin may import (they change
 * between releases), so this file reimplements just the controls this page
 * needs: buttons, tabs, filter pills, a boundary-aware menu-backed select, a
 * switch, labelled text/numeric/range fields, tag chips and a focused modal.
 * They copy the host's control metrics and use host theme tokens, giving the
 * page the same feel as Settings → Plugins without a dependency edge.
 * @module dsh-memory/client/ui
 */
import * as React from 'react'
import { formatMessage, t } from './locales.ts'

const h = React.createElement

/** Visual weight of a button. */
export type ButtonVariant = 'outline' | 'primary' | 'ghost' | 'danger'

/** Props accepted by {@link Button}. */
export interface ButtonProps {
  children?: React.ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}

/** A themed button. */
export function Button(props: ButtonProps): React.ReactElement {
  return h(
    'button',
    {
      type: props.type ?? 'button',
      className: 'dsh-mem-btn',
      'data-variant': props.variant ?? 'outline',
      'data-size': props.size ?? 'md',
      ...(props.disabled === true ? { disabled: true } : {}),
      ...(props.title === undefined ? {} : { title: props.title }),
      ...(props.onClick === undefined ? {} : { onClick: props.onClick }),
    },
    props.children,
  )
}

/** Props accepted by {@link IconButton}. */
export interface IconButtonProps {
  children?: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
}

/** A compact square icon button; the label is its accessible name and tooltip. */
export function IconButton(props: IconButtonProps): React.ReactElement {
  return h(
    'button',
    {
      type: 'button',
      className: 'dsh-mem-iconbtn',
      'aria-label': props.label,
      title: props.label,
      ...(props.disabled === true ? { disabled: true } : {}),
      ...(props.onClick === undefined ? {} : { onClick: props.onClick }),
    },
    props.children,
  )
}

/** One tab entry rendered by {@link Tabs}. */
export interface TabItem<T extends string = string> {
  id: T
  label: string
  badge?: number
  dot?: boolean
}

/** Props accepted by {@link Tabs}. */
export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
  label?: string
}

/** Accessible horizontal tab bar with keyboard arrow navigation. */
export function Tabs<T extends string>(props: TabsProps<T>): React.ReactElement {
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([])
  const selectAt = (index: number): void => {
    const count = props.items.length
    if (count === 0) return
    const next = (index + count) % count
    const item = props.items[next]
    if (item === undefined) return
    props.onChange(item.id)
    buttons.current[next]?.focus()
  }
  return h(
    'div',
    {
      className: 'dsh-mem-tabs',
      role: 'tablist',
      ...(props.label === undefined ? {} : { 'aria-label': props.label }),
    },
    props.items.map((item, index) => {
      const selected = item.id === props.active
      return h(
        'button',
        {
          key: item.id,
          ref: (el: HTMLButtonElement | null) => {
            buttons.current[index] = el
          },
          type: 'button',
          role: 'tab',
          id: `dsh-mem-tab-${item.id}`,
          'aria-selected': selected,
          'aria-controls': `dsh-mem-panel-${item.id}`,
          tabIndex: selected ? 0 : -1,
          className: 'dsh-mem-tab',
          onClick: () => props.onChange(item.id),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              selectAt(index + 1)
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault()
              selectAt(index - 1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              selectAt(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              selectAt(props.items.length - 1)
            }
          },
        },
        h('span', null, item.label),
        item.badge !== undefined && item.badge > 0
          ? h('span', { className: 'dsh-mem-tab-badge' }, String(item.badge))
          : null,
        item.dot === true ? h('span', { className: 'dsh-mem-tab-dot', 'aria-hidden': true }) : null,
      )
    }),
  )
}

/** One option in {@link PillGroup}. */
export interface PillOption<T extends string = string> {
  value: T
  label: string
}

/** Props accepted by {@link PillGroup}. */
export interface PillGroupProps<T extends string = string> {
  label: string
  value: T
  options: readonly PillOption<T>[]
  onChange: (value: T) => void
}

/** Compact segmented filter pills for small enumerations. */
export function PillGroup<T extends string>(props: PillGroupProps<T>): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-pill-group', role: 'group', 'aria-label': props.label },
    h('span', { className: 'dsh-mem-pill-label', 'aria-hidden': true }, props.label),
    props.options.map((option) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          className: 'dsh-mem-pill',
          'aria-pressed': option.value === props.value,
          onClick: () => {
            if (option.value !== props.value) props.onChange(option.value)
          },
        },
        option.label,
      ),
    ),
  )
}

/** One select choice. */
export interface SelectOption {
  value: string
  label: string
}

/** Props accepted by {@link Select}. */
export interface SelectProps {
  label: string
  value: string
  options: readonly SelectOption[]
  onChange?: (value: string) => void
  disabled?: boolean
  placeholder?: string
}

/** A menu-backed select that keeps one value, flips upward near viewport bottom, and reports changes. */
export function Select(props: SelectProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [placement, setPlacement] = React.useState<'bottom' | 'top'>('bottom')
  const root = React.useRef<HTMLDivElement>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const items = React.useRef<Array<HTMLButtonElement | null>>([])
  const focusTimer = React.useRef<number | undefined>(undefined)
  const shown = open && props.disabled !== true
  const current = props.options.find((option) => option.value === props.value)

  const clearFocusTimer = React.useCallback((): void => {
    if (focusTimer.current !== undefined) {
      window.clearTimeout(focusTimer.current)
      focusTimer.current = undefined
    }
  }, [])

  React.useEffect(() => clearFocusTimer, [clearFocusTimer])

  React.useLayoutEffect(() => {
    if (!shown || trigger.current === null || typeof window === 'undefined') return
    const rect = trigger.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    if (spaceBelow < 220 && spaceAbove > spaceBelow) setPlacement('top')
    else setPlacement('bottom')
  }, [shown])

  const focusItem = (index: number): void => {
    const list = items.current.filter((item): item is HTMLButtonElement => item !== null)
    if (list.length === 0) return
    const next = (index + list.length) % list.length
    list[next]?.focus()
  }

  const openWithFocus = (): void => {
    setOpen(true)
    const selected = props.options.findIndex((option) => option.value === props.value)
    clearFocusTimer()
    focusTimer.current = window.setTimeout(() => {
      focusTimer.current = undefined
      focusItem(selected < 0 ? 0 : selected)
    }, 0)
  }

  React.useEffect(() => {
    if (!shown) return undefined
    const onPointer = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [shown])

  return h(
    'div',
    { className: 'dsh-mem-select', ref: root },
    h(
      'button',
      {
        ref: trigger,
        type: 'button',
        className: 'dsh-mem-trigger',
        'aria-label': props.label,
        'aria-haspopup': 'menu',
        'aria-expanded': shown,
        ...(props.disabled === true ? { disabled: true } : {}),
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!shown) openWithFocus()
          } else if (event.key === 'Escape' && shown) {
            event.preventDefault()
            event.stopPropagation()
            event.nativeEvent.stopImmediatePropagation()
            setOpen(false)
          }
        },
      },
      h('span', { className: 'dsh-mem-trigger-value' }, current?.label ?? props.placeholder ?? ''),
      h(Chevron, { className: 'dsh-mem-chevron' }),
    ),
    shown
      ? h(
          'div',
          {
            className: 'dsh-mem-menu',
            'data-placement': placement,
            role: 'menu',
            onKeyDown: (event: React.KeyboardEvent) => {
              const list = items.current.filter((item): item is HTMLButtonElement => item !== null)
              const index = list.indexOf(document.activeElement as HTMLButtonElement)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusItem(index + 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusItem(index < 0 ? list.length - 1 : index - 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                event.nativeEvent.stopImmediatePropagation()
                setOpen(false)
                trigger.current?.focus()
              }
            },
          },
          props.options.map((option, index) =>
            h(
              'button',
              {
                key: option.value,
                ref: (element: HTMLButtonElement | null) => {
                  items.current[index] = element
                },
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': option.value === props.value,
                className: 'dsh-mem-menu-item',
                onClick: () => {
                  setOpen(false)
                  if (option.value !== props.value) props.onChange?.(option.value)
                  trigger.current?.focus()
                },
              },
              h('span', null, option.label),
              option.value === props.value ? h(Check, { className: 'dsh-mem-menu-check' }) : null,
            ),
          ),
        )
      : null,
  )
}

/** Props accepted by {@link Switch}. */
export interface SwitchProps {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

/** A labelled switch row with the host's `role="switch"` behavior. */
export function Switch(props: SwitchProps): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-switchrow' },
    h(
      'span',
      { className: 'dsh-mem-switchtext' },
      h('span', { className: 'dsh-mem-switchlabel' }, props.label),
      props.hint === undefined ? null : h('span', { className: 'dsh-mem-switchhint' }, props.hint),
    ),
    h('button', {
      type: 'button',
      role: 'switch',
      className: 'dsh-mem-switch',
      'aria-checked': props.checked,
      'aria-label': props.label,
      ...(props.disabled === true ? { disabled: true } : {}),
      onClick: () => props.onChange(!props.checked),
    }),
  )
}

/** Props accepted by {@link TextField}. */
export interface TextFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  hint?: string
  placeholder?: string
  disabled?: boolean
  multiline?: boolean
  numeric?: boolean
  invalid?: boolean
  min?: number
  max?: number
  step?: number
  id?: string
}

/** A labelled single-line or multiline text field. */
export function TextField(props: TextFieldProps): React.ReactElement {
  const common = {
    className: 'dsh-mem-input',
    'aria-label': props.label,
    ...(props.id === undefined ? {} : { id: props.id }),
    ...(props.invalid === true ? { 'aria-invalid': true } : {}),
    ...(props.disabled === true ? { disabled: true } : {}),
    ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
    ...(props.onBlur === undefined ? {} : { onBlur: props.onBlur }),
  }
  return h(
    'label',
    { className: 'dsh-mem-field' },
    h('span', { className: 'dsh-mem-label' }, props.label),
    props.multiline === true
      ? h('textarea', {
          ...common,
          value: props.value,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            props.onChange(event.target.value),
        })
      : h('input', {
          ...common,
          type: props.numeric === true ? 'number' : 'text',
          ...(props.numeric === true && props.min !== undefined ? { min: props.min } : {}),
          ...(props.numeric === true && props.max !== undefined ? { max: props.max } : {}),
          ...(props.numeric === true && props.step !== undefined ? { step: props.step } : {}),
          value: props.value,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            props.onChange(event.target.value),
        }),
    props.hint === undefined ? null : h('span', { className: 'dsh-mem-hint' }, props.hint),
  )
}

/** Props accepted by {@link NumericField}. */
export interface NumericFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  integer?: boolean
  disabled?: boolean
  hint?: string
  id?: string
}

/**
 * Controlled numeric input that keeps a local string draft during typing so
 * intermediate values below `min` or empty text are never locked out.
 */
export function NumericField(props: NumericFieldProps): React.ReactElement {
  const [text, setText] = React.useState(() => String(props.value))
  const lastEmitted = React.useRef(props.value)

  React.useEffect(() => {
    if (props.value !== lastEmitted.current) {
      lastEmitted.current = props.value
      setText(String(props.value))
    }
  }, [props.value])

  const clamp = (raw: number): number => {
    const normalized = props.integer === true ? Math.round(raw) : raw
    const min = props.min ?? -Infinity
    const max = props.max ?? Infinity
    return Math.min(max, Math.max(min, normalized))
  }

  return h(TextField, {
    label: props.label,
    value: text,
    numeric: true,
    ...(props.id === undefined ? {} : { id: props.id }),
    ...(props.min === undefined ? {} : { min: props.min }),
    ...(props.max === undefined ? {} : { max: props.max }),
    ...(props.step === undefined ? {} : { step: props.step }),
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    ...(props.hint === undefined ? {} : { hint: props.hint }),
    onChange: (next: string) => {
      setText(next)
      const trimmed = next.trim()
      if (trimmed === '') return
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return
      const clamped = clamp(parsed)
      lastEmitted.current = clamped
      props.onChange(clamped)
    },
    onBlur: () => {
      const trimmed = text.trim()
      if (trimmed === '') {
        setText(String(props.value))
        return
      }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) {
        setText(String(props.value))
        return
      }
      const clamped = clamp(parsed)
      lastEmitted.current = clamped
      setText(String(clamped))
      if (clamped !== props.value) props.onChange(clamped)
    },
  })
}

/** Split one comma-separated tag string into trimmed, deduplicated tags. */
export function parseTagList(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.split(',')) {
    const tag = raw.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}

/** Props accepted by {@link TagsInput}. */
export interface TagsInputProps {
  label: string
  hint?: string
  placeholder?: string
  value: string[]
  disabled?: boolean
  onChange: (tags: string[]) => void
}

/**
 * Tag editor with live removable chips plus a comma/Enter text input.
 *
 * Keeps raw text state while typing so typing a comma never rewrites the input
 * out from under the cursor, while still letting users remove any tag chip in
 * one click or press Enter to normalize.
 */
export function TagsInput(props: TagsInputProps): React.ReactElement {
  const [text, setText] = React.useState(() => props.value.join(', '))
  const lastJoined = React.useRef(props.value.join('\u0000'))

  React.useEffect(() => {
    const joined = props.value.join('\u0000')
    if (joined !== lastJoined.current) {
      lastJoined.current = joined
      setText(props.value.join(', '))
    }
  }, [props.value])

  const emit = (tags: string[], syncText: boolean): void => {
    lastJoined.current = tags.join('\u0000')
    if (syncText) setText(tags.join(', '))
    props.onChange(tags)
  }

  const removeTag = (target: string): void => {
    const next = props.value.filter((tag) => tag !== target)
    emit(next, true)
  }

  return h(
    'div',
    { className: 'dsh-mem-field' },
    h('span', { className: 'dsh-mem-label' }, props.label),
    props.value.length === 0
      ? null
      : h(
          'div',
          { className: 'dsh-mem-chips' },
          props.value.map((tag) =>
            h(
              'span',
              { key: tag, className: 'dsh-mem-chip' },
              h('span', null, tag),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-mem-chip-x',
                  'aria-label': formatMessage('detail.removeTag', { tag }),
                  ...(props.disabled === true ? { disabled: true } : {}),
                  onClick: () => removeTag(tag),
                },
                '×',
              ),
            ),
          ),
        ),
    h('input', {
      className: 'dsh-mem-input',
      type: 'text',
      'aria-label': props.label,
      ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
      ...(props.disabled === true ? { disabled: true } : {}),
      value: text,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        const next = event.target.value
        setText(next)
        emit(parseTagList(next), false)
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const parsed = parseTagList(text)
          emit(parsed, true)
        }
      },
      onBlur: () => {
        const parsed = parseTagList(text)
        emit(parsed, true)
      },
    }),
    props.hint === undefined ? null : h('span', { className: 'dsh-mem-hint' }, props.hint),
  )
}

/** Props accepted by {@link ImportanceField}. */
export interface ImportanceFieldProps {
  id?: string
  label: string
  value: number
  disabled?: boolean
  onChange: (value: number) => void
}

/** Synchronized 0–1 slider and numeric input for memory importance. */
export function ImportanceField(props: ImportanceFieldProps): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-field' },
    h('span', { className: 'dsh-mem-label' }, props.label),
    h(
      'div',
      { className: 'dsh-mem-range-row' },
      h('input', {
        type: 'range',
        className: 'dsh-mem-range',
        min: 0,
        max: 1,
        step: 0.1,
        'aria-hidden': true,
        tabIndex: -1,
        value: Number.isFinite(props.value) ? Math.min(1, Math.max(0, props.value)) : 0.5,
        ...(props.disabled === true ? { disabled: true } : {}),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const parsed = Number(event.target.value)
          if (Number.isFinite(parsed)) props.onChange(parsed)
        },
      }),
      h(
        'div',
        { className: 'dsh-mem-range-num' },
        h(NumericField, {
          ...(props.id === undefined ? {} : { id: props.id }),
          label: props.label,
          value: props.value,
          min: 0,
          max: 1,
          step: 0.1,
          ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
          onChange: props.onChange,
        }),
      ),
    ),
  )
}

/** Props accepted by {@link Tag}. */
export interface TagProps {
  children?: React.ReactNode
  tone?: 'neutral' | 'warn' | 'success' | 'error' | 'accent'
}

/** A small inline label. */
export function Tag(props: TagProps): React.ReactElement {
  return h(
    'span',
    {
      className: 'dsh-mem-tag',
      ...(props.tone === undefined || props.tone === 'neutral' ? {} : { 'data-tone': props.tone }),
    },
    props.children,
  )
}

/** A downward chevron matching the host menu affordance. */
export function Chevron(props: { className?: string }): React.ReactElement {
  return h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 14,
      height: 14,
      'aria-hidden': true,
      ...(props.className === undefined ? {} : { className: props.className }),
    },
    h('path', {
      d: 'M4 6l4 4 4-4',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/** A small check mark for the selected menu item. */
export function Check(props: { className?: string }): React.ReactElement {
  return h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 14,
      height: 14,
      'aria-hidden': true,
      ...(props.className === undefined ? {} : { className: props.className }),
    },
    h('path', {
      d: 'M3.5 8.5l3 3 6-7',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/** Props accepted by {@link Modal}. */
export interface ModalProps {
  title: string
  subtitle?: React.ReactNode
  headerExtra?: React.ReactNode
  onClose: () => void
  children?: React.ReactNode
  footer?: React.ReactNode
  /** Render children directly as flex content so a panel can manage its own scroll body and sticky footer. */
  rawBody?: boolean
  /** Accessible name of the close control (defaults to "Close"). */
  closeLabel?: string
}

/**
 * A themed modal dialog rendered in place.
 *
 * Clicking the backdrop or pressing Escape closes it; clicks inside the panel
 * do not bubble to the backdrop. Focus moves into the panel on open, Tab cycles
 * inside it, and the previous focus is restored on close. The body scrolls when
 * the content is taller than the viewport instead of squeezing the page layout.
 */
export function Modal(props: ModalProps): React.ReactElement {
  const { onClose } = props
  const panel = React.useRef<HTMLDivElement>(null)
  // Keep the latest close callback without re-running the focus effect: the
  // page polls in the background, and re-running on every parent render would
  // pull focus out of the field the user is typing in.
  const close = React.useRef(onClose)
  close.current = onClose
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const previous = document.activeElement as HTMLElement | null
    const focusable = (): HTMLElement[] => {
      const found = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not(:disabled)',
      )
      if (found === undefined) return []
      return [...found].filter((element) => {
        if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
        if (element.closest('[hidden], [aria-hidden="true"]') !== null) return false
        if (typeof window.getComputedStyle === 'function') {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden') return false
        }
        return true
      })
    }
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      const inside = panel.current !== null && active !== null && panel.current.contains(active)
      if (!inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [])
  return h(
    'div',
    { className: 'dsh-mem-overlay', role: 'presentation', onClick: onClose },
    h(
      'div',
      {
        ref: panel,
        className: 'dsh-mem-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': props.title,
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      h(
        'div',
        { className: 'dsh-mem-modal-head' },
        h(
          'div',
          { className: 'dsh-mem-modal-head-main' },
          h('h3', { className: 'dsh-mem-modal-title' }, props.title),
          props.subtitle ?? null,
        ),
        h(
          'div',
          { className: 'dsh-mem-modal-head-right' },
          props.headerExtra ?? null,
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              onClick: onClose,
              title: props.closeLabel ?? 'Close',
            },
            h('span', { 'aria-label': props.closeLabel ?? 'Close', role: 'img' }, '×'),
          ),
        ),
      ),
      props.rawBody === true
        ? props.children
        : h('div', { className: 'dsh-mem-modal-body' }, props.children),
      props.footer === undefined
        ? null
        : h('div', { className: 'dsh-mem-modal-footer' }, props.footer),
    ),
  )
}

/** Props accepted by {@link Banner}. */
export interface BannerProps {
  tone: 'notice' | 'error'
  message: string
  onDismiss?: () => void
}

/** Dismissible status/error banner. */
export function Banner(props: BannerProps): React.ReactElement {
  return h(
    'div',
    {
      className: 'dsh-mem-banner',
      'data-tone': props.tone,
      role: props.tone === 'error' ? 'alert' : 'status',
    },
    h('span', null, props.message),
    props.onDismiss === undefined
      ? null
      : h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            onClick: props.onDismiss,
            title: t('common.close'),
          },
          '×',
        ),
  )
}
