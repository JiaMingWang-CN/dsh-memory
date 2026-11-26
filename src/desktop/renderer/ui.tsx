/**
 * Memloom Desktop custom precision UI primitive library.
 * Zero native `<select>`, `<input type="checkbox|radio|range">`, or browser alerts.
 * @module memloom/desktop/renderer/ui
 */
import * as React from 'react'
import type { MemoryType } from '../../shared/types.ts'
import type { DesktopClientInfo } from '../multi-service.ts'

const h = React.createElement

/* ------------------------------------------------------------------ *
 * Official Memloom Horizontal SVG Logos (Light & Dark verbatim paths)
 * ------------------------------------------------------------------ */

export function LogoHorizontal(props: { readonly theme: 'light' | 'dark' }): React.ReactElement {
  const ink = props.theme === 'dark' ? '#FFFFFF' : '#182430'
  const copper = props.theme === 'dark' ? '#E57A44' : '#C85A28'
  return h(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: '0 0 960 256',
      className: 'memloom-logo-svg',
      role: 'img',
      'aria-label': 'memloom',
    },
    h(
      'g',
      { transform: 'translate(24.5, 46) scale(0.64)' },
      h('path', {
        fill: ink,
        d: 'M36 32 H54 L128 160.2 L133.6 150.5 H163.6 L128 212.2 L67.6 107.5 H36 Z',
      }),
      h('path', { fill: ink, d: 'M36 150.5 H62 V224 H36 Z' }),
      h('path', {
        fill: ink,
        d: 'M202 32 H220 V224 H194 V97.9 L188.4 107.5 H158.4 Z',
      }),
      h('path', { fill: copper, d: 'M21 118 H61.5 L74.2 140 H21 A11 11 0 0 1 21 118 Z' }),
      h('path', { fill: copper, d: 'M115.8 118 H183.5 V140 H128.5 Z' }),
      h('path', { fill: copper, d: 'M230.5 118 H237 A11 11 0 0 1 237 140 H230.5 Z' }),
    ),
    h(
      'g',
      null,
      h('path', {
        fill: ink,
        fillRule: 'evenodd',
        d: 'M244.5 186 V84 H263.5 V96 C266.5 86 263 81.5 275 81.5 C292 81.5 296 93 296 105 C296 93 300 81.5 317 81.5 C334 81.5 347.5 95 347.5 118 V186 H328.5 V116 A11.5 15 0 0 0 305.5 116 V186 H286.5 V116 A11.5 15 0 0 0 263.5 116 V186 Z',
      }),
      h('path', {
        fill: ink,
        fillRule: 'evenodd',
        d: 'M447.9 144 A42 53.5 0 1 0 441.7 164.1 L425.8 155.2 A23 37 0 0 1 384.2 144 H447.9 Z M383.8 129.5 A23 37 0 0 1 429.2 129.5 Z',
      }),
      h('path', {
        fill: ink,
        fillRule: 'evenodd',
        d: 'M465.5 186 V84 H484.5 V96 C487.5 86 484 81.5 496 81.5 C513 81.5 517 93 517 105 C517 93 521 81.5 538 81.5 C555 81.5 568.5 95 568.5 118 V186 H549.5 V116 A11.5 15 0 0 0 526.5 116 V186 H507.5 V116 A11.5 15 0 0 0 484.5 116 V186 Z',
      }),
      h('path', { fill: ink, fillRule: 'evenodd', d: 'M588.5 45.2 H607.5 V186 H588.5 Z' }),
      h('path', {
        fill: ink,
        fillRule: 'evenodd',
        d: 'M666.5 81.5 A43 53.5 0 1 1 666.4 81.5 Z M666.5 98 A24 37 0 1 0 666.6 98 Z',
      }),
      h('path', {
        fill: ink,
        fillRule: 'evenodd',
        d: 'M766.5 81.5 A43 53.5 0 1 1 766.4 81.5 Z M766.5 98 A24 37 0 1 0 766.6 98 Z',
      }),
      h('path', {
        fill: ink,
        fillRule: 'evenodd',
        d: 'M826.5 186 V84 H845.5 V96 C848.5 86 845 81.5 857 81.5 C874 81.5 878 93 878 105 C878 93 882 81.5 899 81.5 C916 81.5 929.5 95 929.5 118 V186 H910.5 V116 A11.5 15 0 0 0 887.5 116 V186 H868.5 V116 A11.5 15 0 0 0 845.5 116 V186 Z',
      }),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * Geometric 1.5px SVG Icons
 * ------------------------------------------------------------------ */

function svgIcon(
  children: React.ReactNode,
  size = 15,
  extra?: Record<string, unknown>,
): React.ReactElement {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      ...extra,
    },
    children,
  )
}

export const Icons = {
  layers: () =>
    svgIcon([
      h('path', { key: '1', d: 'M8 2L14 5.5L8 9L2 5.5L8 2Z' }),
      h('path', { key: '2', d: 'M2 8.5L8 12L14 8.5' }),
      h('path', { key: '3', d: 'M2 11.5L8 15L14 11.5' }),
    ]),
  inbox: () =>
    svgIcon([
      h('path', { key: '1', d: 'M2.5 9.5L4.2 3.5H11.8L13.5 9.5V13H2.5V9.5Z' }),
      h('path', { key: '2', d: 'M2.5 9.5H5.5L6.5 11H9.5L10.5 9.5H13.5' }),
    ]),
  migrate: () =>
    svgIcon([
      h('path', { key: '1', d: 'M3 5.5H12.5M10 3L12.5 5.5L10 8' }),
      h('path', { key: '2', d: 'M13 10.5H3.5M6 8L3.5 10.5L6 13' }),
    ]),
  history: () =>
    svgIcon([
      h('circle', { key: '1', cx: 8, cy: 8, r: 5.5 }),
      h('path', { key: '2', d: 'M8 5V8.2L10.3 9.5' }),
    ]),
  sliders: () =>
    svgIcon([
      h('path', { key: '1', d: 'M2.5 4.5H13.5M2.5 8H13.5M2.5 11.5H13.5' }),
      h('circle', { key: '2', cx: 5.5, cy: 4.5, r: 1.5, fill: 'var(--ml-stage-bg)' }),
      h('circle', { key: '3', cx: 10.5, cy: 8, r: 1.5, fill: 'var(--ml-stage-bg)' }),
      h('circle', { key: '4', cx: 6.5, cy: 11.5, r: 1.5, fill: 'var(--ml-stage-bg)' }),
    ]),
  pin: () =>
    svgIcon(
      [
        h('path', { key: '1', d: 'M5.5 3H10.5L9.8 7L12 9.2V10.5H4V9.2L6.2 7L5.5 3Z' }),
        h('path', { key: '2', d: 'M8 10.5V14' }),
      ],
      13,
    ),
  lock: () =>
    svgIcon(
      [
        h('rect', { key: '1', x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }),
        h('path', { key: '2', d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }),
      ],
      13,
    ),
  unlock: () =>
    svgIcon(
      [
        h('rect', { key: '1', x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }),
        h('path', { key: '2', d: 'M5.5 7V5a2.5 2.5 0 0 1 4.8-1' }),
      ],
      13,
    ),
  shield: () =>
    svgIcon(
      [h('path', { key: '1', d: 'M8 2L13 4V7.8C13 11 10.8 13.2 8 14C5.2 13.2 3 11 3 7.8V4L8 2Z' })],
      14,
    ),
  plus: () => svgIcon([h('path', { key: '1', d: 'M8 3V13M3 8H13' })], 14),
  chevronDown: () => svgIcon([h('path', { key: '1', d: 'M4.5 6.5L8 10L11.5 6.5' })], 13),
  check: () =>
    svgIcon([h('path', { key: '1', d: 'M3.5 8.5L6.5 11.5L12.5 4.5' })], 11, { strokeWidth: 2.2 }),
  edit: () =>
    svgIcon([h('path', { key: '1', d: 'M11.2 2.8L13.2 4.8L5.5 12.5H3.5V10.5L11.2 2.8Z' })], 13),
  archive: () =>
    svgIcon(
      [
        h('rect', { key: '1', x: 2.5, y: 3, width: 11, height: 3, rx: 0.8 }),
        h('path', { key: '2', d: 'M3.5 6V13H12.5V6' }),
        h('path', { key: '3', d: 'M6.5 9H9.5' }),
      ],
      13,
    ),
  restore: () =>
    svgIcon(
      [
        h('path', { key: '1', d: 'M4 5.5A5 5 0 1 1 3.5 10' }),
        h('path', { key: '2', d: 'M4 2.5V5.5H7' }),
      ],
      13,
    ),
  close: () => svgIcon([h('path', { key: '1', d: 'M4 4L12 12M12 4L4 12' })], 14),
  refresh: () =>
    svgIcon(
      [
        h('path', { key: '1', d: 'M13 8A5 5 0 1 1 11.4 4.3' }),
        h('path', { key: '2', d: 'M12.5 2.5V5H10' }),
      ],
      13,
    ),
  download: () =>
    svgIcon(
      [
        h('path', { key: '1', d: 'M8 2.5V10.5M5.2 7.8L8 10.6L10.8 7.8' }),
        h('path', { key: '2', d: 'M3 13H13' }),
      ],
      13,
    ),
  upload: () =>
    svgIcon(
      [
        h('path', { key: '1', d: 'M8 10.5V2.5M5.2 5.2L8 2.4L10.8 5.2' }),
        h('path', { key: '2', d: 'M3 13H13' }),
      ],
      13,
    ),
  search: () =>
    svgIcon(
      [
        h('circle', { key: '1', cx: 7, cy: 7, r: 4.5 }),
        h('path', { key: '2', d: 'M10.5 10.5L14 14' }),
      ],
      14,
    ),
  sun: () =>
    svgIcon(
      [
        h('circle', { key: '1', cx: 8, cy: 8, r: 3 }),
        h('path', {
          key: '2',
          d: 'M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1',
        }),
      ],
      13,
    ),
  moon: () =>
    svgIcon([h('path', { key: '1', d: 'M13.2 9.8A5.4 5.4 0 0 1 6.2 2.8a5.5 5.5 0 1 0 7 7z' })], 13),
  memoryType: (type: MemoryType): React.ReactElement => {
    if (type === 'lesson') {
      return svgIcon([
        h('path', { key: '1', d: 'M8 2.2L13.5 12.5H2.5L8 2.2Z' }),
        h('path', { key: '2', d: 'M8 6.5V9.3' }),
      ])
    }
    if (type === 'wiki') {
      return svgIcon([
        h('rect', { key: '1', x: 3, y: 2.5, width: 10, height: 11, rx: 1.5 }),
        h('path', { key: '2', d: 'M5.5 6H10.5M5.5 8.8H10.5M5.5 11.2H8.5' }),
      ])
    }
    if (type === 'worklog') {
      return svgIcon([
        h('rect', { key: '1', x: 2.5, y: 3, width: 11, height: 10, rx: 1.5 }),
        h('path', { key: '2', d: 'M2.5 6.2H13.5M5.8 9.2H10.2' }),
      ])
    }
    return svgIcon([
      h('path', {
        key: '1',
        d: 'M8 2.2L9.7 5.8L13.6 6.4L10.8 9.1L11.5 13L8 11.1L4.5 13L5.2 9.1L2.4 6.4L6.3 5.8L8 2.2Z',
      }),
    ])
  },
}

/* ------------------------------------------------------------------ *
 * Button
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'surface' | 'ghost' | 'danger' | 'warn'

export interface ButtonProps {
  readonly children?: React.ReactNode
  readonly onClick?: () => void
  readonly variant?: ButtonVariant
  readonly size?: 'sm' | 'md'
  readonly disabled?: boolean
  readonly title?: string
  readonly type?: 'button' | 'submit'
  readonly className?: string
}

export function Button(props: ButtonProps): React.ReactElement {
  return h(
    'button',
    {
      type: props.type ?? 'button',
      className: props.className ? `ml-btn ${props.className}` : 'ml-btn',
      'data-variant': props.variant ?? 'surface',
      'data-size': props.size ?? 'md',
      ...(props.disabled === true ? { disabled: true } : {}),
      ...(props.title !== undefined ? { title: props.title } : {}),
      ...(props.onClick !== undefined ? { onClick: props.onClick } : {}),
    },
    props.children,
  )
}

/* ------------------------------------------------------------------ *
 * SegmentedControl
 * ------------------------------------------------------------------ */

export interface SegmentItem<T extends string = string> {
  readonly id: T
  readonly label: React.ReactNode
}

export interface SegmentedControlProps<T extends string = string> {
  readonly items: readonly SegmentItem<T>[]
  readonly value: T
  readonly onChange: (id: T) => void
  readonly label: string
  readonly role?: 'tablist' | 'group'
  readonly fullWidth?: boolean
}

export function SegmentedControl<T extends string>(
  props: SegmentedControlProps<T>,
): React.ReactElement {
  const isTablist = props.role === 'tablist'
  return h(
    'div',
    {
      className: 'ml-segment',
      role: isTablist ? 'tablist' : 'group',
      'aria-label': props.label,
      ...(props.fullWidth === true ? { 'data-full': 'true' } : {}),
      style:
        props.fullWidth === true
          ? { gridTemplateColumns: `repeat(${Math.max(1, props.items.length)}, minmax(0, 1fr))` }
          : undefined,
    },
    props.items.map((item) => {
      const selected = item.id === props.value
      return h(
        'button',
        {
          key: item.id,
          type: 'button',
          className: 'ml-segment-item',
          ...(isTablist
            ? { role: 'tab', 'aria-selected': selected }
            : { 'aria-pressed': selected }),
          onClick: () => {
            if (item.id !== props.value) props.onChange(item.id)
          },
        },
        item.label,
      )
    }),
  )
}

/* ------------------------------------------------------------------ *
 * Custom Glass Dropdown (Zero native <select>)
 * ------------------------------------------------------------------ */

export interface DropdownOption {
  readonly value: string
  readonly label: string
  readonly icon?: React.ReactNode
}

export interface DropdownProps {
  readonly label: string
  readonly value: string
  readonly options: readonly DropdownOption[]
  readonly onChange: (value: string) => void
  readonly prefix?: string
  readonly disabled?: boolean
  readonly fullWidth?: boolean
}

export function Dropdown(props: DropdownProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 196,
  })
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([])

  const shown = open && props.disabled !== true
  const current = props.options.find((opt) => opt.value === props.value)

  React.useLayoutEffect(() => {
    if (!shown || triggerRef.current === null || typeof window === 'undefined') return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const estHeight = Math.min(280, Math.max(44, props.options.length * 34 + 12))
    const top =
      spaceBelow < estHeight + 12 && rect.top > spaceBelow
        ? Math.max(8, rect.top - estHeight - 6)
        : Math.min(window.innerHeight - estHeight - 8, rect.bottom + 6)
    const width = Math.max(rect.width, 196)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setMenuPos({ top, left, width })
  }, [shown, props.options.length])

  React.useEffect(() => {
    if (!shown) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (
        wrapRef.current !== null &&
        !wrapRef.current.contains(target) &&
        (menuRef.current === null || !menuRef.current.contains(target))
      ) {
        setOpen(false)
      }
    }
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onEscape)
    }
  }, [shown])

  const focusItem = (index: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
    if (items.length === 0) return
    const next = (index + items.length) % items.length
    items[next]?.focus()
  }

  return h(
    'div',
    {
      ref: wrapRef,
      className: 'ml-dropdown-wrap',
      ...(props.fullWidth === true ? { 'data-full': 'true' } : {}),
    },
    h(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        className: 'ml-dropdown-trigger',
        'aria-label': props.label,
        'aria-haspopup': 'menu',
        'aria-expanded': shown,
        ...(props.disabled === true ? { disabled: true } : {}),
        onClick: () => setOpen((prev) => !prev),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            const selectedIdx = props.options.findIndex((o) => o.value === props.value)
            window.setTimeout(() => focusItem(selectedIdx < 0 ? 0 : selectedIdx), 0)
          }
        },
      },
      h(
        'span',
        { className: 'ml-dropdown-value' },
        props.prefix !== undefined && props.prefix !== ''
          ? h('span', { className: 'ml-dropdown-prefix' }, props.prefix)
          : null,
        current?.icon !== undefined
          ? h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', marginRight: '6px' } },
              current.icon,
            )
          : null,
        current?.label ?? props.value,
      ),
      h(
        'span',
        { style: { color: 'var(--ml-text-muted)', display: 'inline-flex' } },
        Icons.chevronDown(),
      ),
    ),
    shown
      ? h(
          'div',
          {
            ref: menuRef,
            className: 'ml-dropdown-menu ml-scroll',
            role: 'menu',
            style: {
              top: `${menuPos.top}px`,
              left: `${menuPos.left}px`,
              width: `${menuPos.width}px`,
            },
            onKeyDown: (event: React.KeyboardEvent) => {
              const items = itemRefs.current.filter(
                (item): item is HTMLButtonElement => item !== null,
              )
              const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusItem(currentIdx + 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusItem(currentIdx < 0 ? items.length - 1 : currentIdx - 1)
              }
            },
          },
          props.options.map((option, idx) => {
            const selected = option.value === props.value
            return h(
              'button',
              {
                key: option.value,
                ref: (el: HTMLButtonElement | null) => {
                  itemRefs.current[idx] = el
                },
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': selected,
                className: 'ml-dropdown-item',
                onClick: () => {
                  setOpen(false)
                  if (option.value !== props.value) props.onChange(option.value)
                  triggerRef.current?.focus()
                },
              },
              h(
                'span',
                {
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    minWidth: 0,
                    overflow: 'hidden',
                  },
                },
                option.icon ?? null,
                h(
                  'span',
                  { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  option.label,
                ),
              ),
              selected ? Icons.check() : null,
            )
          }),
        )
      : null,
  )
}

/* ------------------------------------------------------------------ *
 * Checkbox & Switch
 * ------------------------------------------------------------------ */

export function Checkbox(props: {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label?: string
  readonly disabled?: boolean
}): React.ReactElement {
  return h(
    'button',
    {
      type: 'button',
      role: 'checkbox',
      'aria-checked': props.checked,
      ...(props.label !== undefined ? { 'aria-label': props.label } : {}),
      ...(props.disabled === true ? { disabled: true } : {}),
      className: 'ml-check',
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation()
        props.onChange(!props.checked)
      },
    },
    props.checked ? Icons.check() : null,
  )
}

export function Switch(props: {
  readonly label: string
  readonly hint?: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly disabled?: boolean
  readonly dim?: boolean
}): React.ReactElement {
  return h(
    'div',
    {
      className: 'ml-switch-row',
      ...(props.dim === true ? { 'data-dim': 'true' } : {}),
    },
    h(
      'div',
      { className: 'ml-switch-text' },
      h('span', { className: 'ml-switch-label' }, props.label),
      props.hint !== undefined && props.hint !== ''
        ? h('span', { className: 'ml-switch-hint' }, props.hint)
        : null,
    ),
    h(
      'button',
      {
        type: 'button',
        role: 'switch',
        className: 'ml-switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        ...(props.disabled === true ? { disabled: true } : {}),
        onClick: () => props.onChange(!props.checked),
      },
      h('span', { className: 'ml-switch-knob' }),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * Detented Slider (Zero native <input type="range">)
 * ------------------------------------------------------------------ */

export interface SliderDetent {
  readonly value: number
  readonly label: string
}

export function DetentedSlider(props: {
  readonly label: string
  readonly hint?: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly detents: readonly SliderDetent[]
  readonly onChange: (value: number) => void
  readonly disabled?: boolean
  readonly formatValue?: (value: number) => string
}): React.ReactElement {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const clamped = Math.max(props.min, Math.min(props.max, props.value))
  const pct = ((clamped - props.min) / Math.max(1, props.max - props.min)) * 100

  const dragCleanupRef = React.useRef<(() => void) | undefined>(undefined)

  React.useEffect(() => () => dragCleanupRef.current?.(), [])

  const updateFromClientX = (clientX: number): void => {
    if (props.disabled === true || trackRef.current === null) return
    const rect = trackRef.current.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const raw = props.min + ratio * (props.max - props.min)
    const snapped = Math.round(raw / props.step) * props.step
    props.onChange(Math.max(props.min, Math.min(props.max, snapped)))
  }

  return h(
    'div',
    { className: 'ml-slider-wrap' },
    h(
      'div',
      { className: 'ml-slider-head' },
      h(
        'div',
        { className: 'ml-switch-text' },
        h('span', { className: 'ml-switch-label' }, props.label),
        props.hint !== undefined && props.hint !== ''
          ? h('span', { className: 'ml-switch-hint' }, props.hint)
          : null,
      ),
      h(
        'span',
        { className: 'ml-slider-val ml-mono' },
        props.formatValue ? props.formatValue(clamped) : `${clamped}`,
      ),
    ),
    h(
      'div',
      {
        ref: trackRef,
        className: 'ml-slider-track',
        role: 'slider',
        tabIndex: props.disabled === true ? -1 : 0,
        'aria-label': props.label,
        'aria-valuemin': props.min,
        'aria-valuemax': props.max,
        'aria-valuenow': clamped,
        onMouseDown: (event: React.MouseEvent) => {
          if (props.disabled === true) return
          dragCleanupRef.current?.()
          updateFromClientX(event.clientX)
          const onMove = (ev: MouseEvent): void => updateFromClientX(ev.clientX)
          const onUp = (): void => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            dragCleanupRef.current = undefined
          }
          dragCleanupRef.current = onUp
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        },
        onKeyDown: (event: React.KeyboardEvent) => {
          if (props.disabled === true) return
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            props.onChange(Math.min(props.max, clamped + props.step))
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            props.onChange(Math.max(props.min, clamped - props.step))
          }
        },
      },
      h('div', { className: 'ml-slider-fill', style: { width: `${pct}%` } }),
      h('div', { className: 'ml-slider-thumb', style: { left: `${pct}%` } }),
    ),
    h(
      'div',
      { className: 'ml-slider-detents' },
      props.detents.map((d) =>
        h(
          'button',
          {
            key: d.value,
            type: 'button',
            className: 'ml-slider-detent ml-tabular',
            'data-active': clamped === d.value,
            ...(props.disabled === true ? { disabled: true } : {}),
            onClick: () => props.onChange(d.value),
          },
          d.label,
        ),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * Numeric Stepper (Zero native type="number" spinners)
 * ------------------------------------------------------------------ */

export function NumericStepper(props: {
  readonly label: string
  readonly value: number
  readonly onChange: (value: number) => void
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly disabled?: boolean
}): React.ReactElement {
  const [draft, setDraft] = React.useState(() => String(props.value))
  const lastProp = React.useRef(props.value)

  React.useEffect(() => {
    if (props.value !== lastProp.current) {
      lastProp.current = props.value
      setDraft(String(props.value))
    }
  }, [props.value])

  const min = props.min ?? 0
  const max = props.max ?? Number.MAX_SAFE_INTEGER
  const step = props.step ?? 1

  const commit = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      setDraft(String(props.value))
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      setDraft(String(props.value))
      return
    }
    const clamped = Math.max(min, Math.min(max, Math.trunc(parsed)))
    lastProp.current = clamped
    setDraft(String(clamped))
    if (clamped !== props.value) props.onChange(clamped)
  }

  return h(
    'div',
    { className: 'ml-stepper' },
    h(
      'button',
      {
        type: 'button',
        className: 'ml-stepper-btn',
        'aria-label': `${props.label} -`,
        disabled: props.disabled === true || props.value <= min,
        onClick: () => {
          const next = Math.max(min, props.value - step)
          lastProp.current = next
          setDraft(String(next))
          props.onChange(next)
        },
      },
      '−',
    ),
    h('input', {
      type: 'text',
      inputMode: 'numeric',
      className: 'ml-stepper-input',
      'aria-label': props.label,
      value: draft,
      ...(props.disabled === true ? { disabled: true } : {}),
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        const v = event.target.value
        setDraft(v)
        const n = Number(v.trim())
        if (v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) {
          lastProp.current = n
          props.onChange(n)
        }
      },
      onBlur: () => commit(draft),
    }),
    h(
      'button',
      {
        type: 'button',
        className: 'ml-stepper-btn',
        'aria-label': `${props.label} +`,
        disabled: props.disabled === true || props.value >= max,
        onClick: () => {
          const next = Math.min(max, props.value + step)
          lastProp.current = next
          setDraft(String(next))
          props.onChange(next)
        },
      },
      '+',
    ),
  )
}

/* ------------------------------------------------------------------ *
 * TextField
 * ------------------------------------------------------------------ */

export function TextField(props: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly multiline?: boolean
  readonly disabled?: boolean
  readonly rows?: number
  readonly hint?: string
  readonly id?: string
}): React.ReactElement {
  const inputProps = {
    className: 'ml-input',
    'aria-label': props.label,
    value: props.value,
    ...(props.id !== undefined ? { id: props.id } : {}),
    ...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {}),
    ...(props.disabled === true ? { disabled: true } : {}),
  }

  return h(
    'label',
    { className: 'ml-field' },
    h('span', { className: 'ml-field-label' }, props.label),
    props.multiline === true
      ? h('textarea', {
          ...inputProps,
          rows: props.rows ?? 5,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            props.onChange(event.target.value),
        })
      : h('input', {
          ...inputProps,
          type: 'text',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            props.onChange(event.target.value),
        }),
    props.hint !== undefined && props.hint !== ''
      ? h('span', { className: 'ml-switch-hint' }, props.hint)
      : null,
  )
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

export function Modal(props: {
  readonly title: string
  readonly subtitle?: string
  readonly onClose: () => void
  readonly closeLabel: string
  readonly footer?: React.ReactNode
  readonly maxWidth?: number
  readonly children?: React.ReactNode
}): React.ReactElement {
  const onCloseRef = React.useRef(props.onClose)
  onCloseRef.current = props.onClose

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return h(
    'div',
    {
      className: 'ml-backdrop',
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) props.onClose()
      },
    },
    h(
      'div',
      {
        className: 'ml-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': props.title,
        ...(props.maxWidth !== undefined ? { style: { maxWidth: `${props.maxWidth}px` } } : {}),
      },
      h(
        'div',
        { className: 'ml-modal-head' },
        h(
          'div',
          null,
          h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: 600 } }, props.title),
          props.subtitle !== undefined && props.subtitle !== ''
            ? h(
                'p',
                {
                  style: { margin: '4px 0 0', fontSize: '12px', color: 'var(--ml-text-secondary)' },
                },
                props.subtitle,
              )
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': props.closeLabel,
            onClick: props.onClose,
            style: {
              border: 0,
              background: 'transparent',
              color: 'var(--ml-text-muted)',
              padding: '5px',
              borderRadius: '7px',
              cursor: 'pointer',
              display: 'inline-flex',
            },
          },
          Icons.close(),
        ),
      ),
      h('div', { className: 'ml-modal-body ml-scroll' }, props.children),
      props.footer !== undefined ? h('div', { className: 'ml-modal-foot' }, props.footer) : null,
    ),
  )
}

/* ------------------------------------------------------------------ *
 * Safe Markdown Prose Renderer (No dangerouslySetInnerHTML)
 * ------------------------------------------------------------------ */

function renderInlineCode(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return h('code', { key: idx }, part.slice(1, -1))
    }
    return part
  })
}

export function MarkdownProse(props: {
  readonly text: string
  readonly compact?: boolean
}): React.ReactElement {
  const blocks = props.text.split(/\n{2,}/)
  return h(
    'div',
    {
      className: 'ml-prose',
      style: props.compact === true ? { fontSize: '12.5px', lineHeight: 1.6 } : undefined,
    },
    blocks.map((block, bIdx) => {
      const lines = block.split('\n').map((l) => l.trimEnd())
      const isBulletBlock = lines.length > 0 && lines.every((l) => /^\s*-\s+/.test(l))
      if (isBulletBlock) {
        return h(
          'ul',
          { key: bIdx },
          lines.map((line, lIdx) =>
            h('li', { key: lIdx }, renderInlineCode(line.replace(/^\s*-\s+/, ''))),
          ),
        )
      }
      return h(
        'p',
        { key: bIdx },
        lines.map((line, lIdx) =>
          h(React.Fragment, { key: lIdx }, lIdx > 0 ? h('br') : null, renderInlineCode(line)),
        ),
      )
    }),
  )
}

/* ------------------------------------------------------------------ *
 * Domain Micro Tags & States
 * ------------------------------------------------------------------ */

export function hostColorVars(kind: DesktopClientInfo['kind']): {
  color: string
  soft: string
} {
  if (kind === 'dsh') return { color: 'var(--ml-dsh)', soft: 'var(--ml-dsh-soft)' }
  if (kind === 'agy') return { color: 'var(--ml-agy)', soft: 'var(--ml-agy-soft)' }
  return { color: 'var(--ml-copper)', soft: 'var(--ml-copper-soft)' }
}

export function typeColorVar(type: MemoryType): string {
  if (type === 'lesson') return 'var(--ml-type-lesson)'
  if (type === 'wiki') return 'var(--ml-type-wiki)'
  if (type === 'worklog') return 'var(--ml-type-worklog)'
  return 'var(--ml-type-preference)'
}

const DSH_WHALE_PATH =
  'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z'

const AGY_MASK_PATH =
  'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z'

const AGY_COLOR_BLOBS: ReadonlyArray<{
  readonly d: string
  readonly fill: string
  readonly x: string
  readonly y: string
  readonly width: string
  readonly height: string
  readonly stdDeviation: string
}> = [
  {
    d: 'M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z',
    fill: '#FFE432',
    x: '-3.288',
    y: '-11.917',
    width: '19.838',
    height: '17.587',
    stdDeviation: '1.117',
  },
  {
    d: 'M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z',
    fill: '#FC413D',
    x: '4.251',
    y: '-13.493',
    width: '38.9',
    height: '38.565',
    stdDeviation: '5.4',
  },
  {
    d: 'M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z',
    fill: '#00B95C',
    x: '-21.889',
    y: '-10.592',
    width: '40.955',
    height: '36.517',
    stdDeviation: '4.591',
  },
  {
    d: 'M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z',
    fill: '#00B95C',
    x: '-21.889',
    y: '-10.592',
    width: '40.955',
    height: '36.517',
    stdDeviation: '4.591',
  },
  {
    d: 'M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z',
    fill: '#00B95C',
    x: '-19.099',
    y: '-10.278',
    width: '36.632',
    height: '36.595',
    stdDeviation: '4.591',
  },
  {
    d: 'M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z',
    fill: '#3186FF',
    x: '.981',
    y: '8.758',
    width: '33.533',
    height: '34.087',
    stdDeviation: '4.363',
  },
  {
    d: 'M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z',
    fill: '#FBBC04',
    x: '-6.143',
    y: '-21.659',
    width: '35.978',
    height: '35.276',
    stdDeviation: '3.954',
  },
  {
    d: 'M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z',
    fill: '#3186FF',
    x: '-11.96',
    y: '-.46',
    width: '45.114',
    height: '46.523',
    stdDeviation: '3.531',
  },
  {
    d: 'M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z',
    fill: '#749BFF',
    x: '10.485',
    y: '.58',
    width: '25.094',
    height: '24.054',
    stdDeviation: '3.159',
  },
  {
    d: 'M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z',
    fill: '#FC413D',
    x: '5.833',
    y: '-12.467',
    width: '33.508',
    height: '30.007',
    stdDeviation: '2.669',
  },
  {
    d: 'M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z',
    fill: '#FFEE48',
    x: '-8.355',
    y: '-8.876',
    width: '22.194',
    height: '26.151',
    stdDeviation: '3.303',
  },
]

export function HostLogo(props: {
  readonly kind: DesktopClientInfo['kind']
  readonly size?: number
}): React.ReactElement {
  const uid = React.useId().replace(/:/g, '')
  const size = props.size ?? 14
  if (props.kind === 'dsh') {
    return h(
      'svg',
      {
        className: 'ml-host-logo',
        'data-host-logo': 'dsh',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
      },
      h('path', { d: DSH_WHALE_PATH, fill: '#4D6BFE' }),
    )
  }
  if (props.kind === 'agy') {
    const maskId = `ml-agy-mask-${uid}`
    return h(
      'svg',
      {
        className: 'ml-host-logo',
        'data-host-logo': 'agy',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
      },
      h(
        'mask',
        {
          id: maskId,
          maskUnits: 'userSpaceOnUse',
          x: '0',
          y: '1',
          width: '24',
          height: '23',
        },
        h('path', { d: AGY_MASK_PATH, fill: '#fff' }),
      ),
      h(
        'g',
        { mask: `url(#${maskId})` },
        AGY_COLOR_BLOBS.map((blob, idx) =>
          h(
            'g',
            { key: idx, filter: `url(#ml-agy-f-${uid}-${idx})` },
            h('path', { d: blob.d, fill: blob.fill }),
          ),
        ),
      ),
      h(
        'defs',
        null,
        AGY_COLOR_BLOBS.map((blob, idx) =>
          h(
            'filter',
            {
              key: idx,
              id: `ml-agy-f-${uid}-${idx}`,
              colorInterpolationFilters: 'sRGB',
              filterUnits: 'userSpaceOnUse',
              x: blob.x,
              y: blob.y,
              width: blob.width,
              height: blob.height,
            },
            h('feFlood', { floodOpacity: '0', result: 'BackgroundImageFix' }),
            h('feBlend', { in: 'SourceGraphic', in2: 'BackgroundImageFix', result: 'shape' }),
            h('feGaussianBlur', {
              result: 'effect1_foregroundBlur_977_115',
              stdDeviation: blob.stdDeviation,
            }),
          ),
        ),
      ),
    )
  }
  return h('span', {
    className: 'ml-host-dot',
    'data-host-logo': 'custom',
    style: { background: 'var(--ml-copper)' },
  })
}

export function HostTag(props: {
  readonly kind: DesktopClientInfo['kind']
  readonly label: string
}): React.ReactElement {
  const palette = hostColorVars(props.kind)
  return h(
    'span',
    {
      className: 'ml-host-tag',
      style: { color: palette.color, background: palette.soft },
    },
    h(HostLogo, { kind: props.kind, size: 13 }),
    props.label,
  )
}

export function TypeTag(props: {
  readonly type: MemoryType
  readonly label: string
}): React.ReactElement {
  const color = typeColorVar(props.type)
  return h(
    'span',
    { className: 'ml-type-tag', style: { color } },
    Icons.memoryType(props.type),
    h('span', null, props.label),
  )
}

export interface ToastEntry {
  readonly id: string
  readonly message: string
  readonly tone: 'info' | 'success' | 'warn' | 'danger'
}

export function ToastHost(props: {
  readonly toasts: readonly ToastEntry[]
}): React.ReactElement | null {
  if (props.toasts.length === 0) return null
  return h(
    'div',
    { className: 'ml-toast-stack', role: 'status', 'aria-live': 'polite' },
    props.toasts.map((toast) => {
      const dotColor =
        toast.tone === 'success'
          ? 'var(--ml-success)'
          : toast.tone === 'warn'
            ? 'var(--ml-warn)'
            : toast.tone === 'danger'
              ? 'var(--ml-danger)'
              : 'var(--ml-copper)'
      return h(
        'div',
        { key: toast.id, className: 'ml-toast' },
        h('span', { className: 'ml-host-dot', style: { background: dotColor } }),
        h('span', { style: { flex: '1 1 auto', lineHeight: 1.4 } }, toast.message),
      )
    }),
  )
}

export function EmptyBlock(props: {
  readonly icon?: React.ReactNode
  readonly title: string
  readonly description?: string
  readonly action?: React.ReactNode
}): React.ReactElement {
  return h(
    'div',
    { className: 'ml-empty-state' },
    props.icon !== undefined
      ? h(
          'div',
          {
            style: {
              width: '44px',
              height: '44px',
              borderRadius: '11px',
              background: 'var(--ml-recessed)',
              color: 'var(--ml-text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '4px',
            },
          },
          props.icon,
        )
      : null,
    h('div', { style: { fontSize: '14px', fontWeight: 600 } }, props.title),
    props.description !== undefined && props.description !== ''
      ? h(
          'p',
          {
            style: {
              margin: 0,
              fontSize: '12px',
              color: 'var(--ml-text-secondary)',
              maxWidth: '360px',
              lineHeight: 1.55,
            },
          },
          props.description,
        )
      : null,
    props.action ?? null,
  )
}
