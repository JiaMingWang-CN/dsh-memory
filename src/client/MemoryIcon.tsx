/**
 * Original line icon for the Memory settings section.
 *
 * The settings shell supplies `size` and `active`; the glyph inherits the
 * current text color so it follows light/dark themes without literal colors.
 * @module memloom/client/MemoryIcon
 */
import * as React from 'react'

const h = React.createElement

/** Props supplied by the `settings.section.icon` slot. */
export interface MemoryIconProps {
  size?: number
  active?: boolean
}

/**
 * Draw the memory section icon.
 * @param props - Square edge and selection state from the settings shell.
 * @returns The icon element.
 */
export function MemoryIcon(props: MemoryIconProps): React.ReactElement {
  const size = props.size ?? 20
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': true,
      style: { display: 'block' },
    },
    h('path', {
      d: 'M6 4h9a3 3 0 0 1 3 3v13H6z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M9 8h6M9 12h6M9 16h3',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
    }),
    h('path', {
      d: 'M3 8v10a2 2 0 0 0 2 2',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
    }),
  )
}
