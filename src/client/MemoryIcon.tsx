/**
 * Monochrome Warp & Weft M mark for the Memory settings section.
 *
 * The settings shell supplies `size` and `active`; all paths inherit
 * `currentColor` so the glyph follows light/dark themes without literal hex colors.
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
 * Draw the monochrome Warp & Weft M memory section icon.
 * @param props - Square edge and selection state from the settings shell.
 * @returns The icon element.
 */
export function MemoryIcon(props: MemoryIconProps): React.ReactElement {
  const size = props.size ?? 20
  return h(
    'svg',
    {
      viewBox: '0 0 256 256',
      width: size,
      height: size,
      fill: 'currentColor',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    h('path', {
      d: 'M35 28 H53 L128 157.9 L130.5 153.5 H162.9 L128 213.9 L64.8 104.5 H35 Z',
    }),
    h('path', { d: 'M35 153.5 H63 V228 H35 Z' }),
    h('path', { d: 'M203 28 H221 V228 H193 V101.3 L191.2 104.5 H158.8 Z' }),
    h('path', { d: 'M20 117 H57.6 L71.5 141 H20 A12 12 0 0 1 20 117 Z' }),
    h('path', { d: 'M118.8 117 H180.5 V141 H132.7 Z' }),
    h('path', { d: 'M233.5 117 H236 A12 12 0 0 1 236 141 H233.5 Z' }),
  )
}
