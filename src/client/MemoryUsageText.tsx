/**
 * Compact memory-usage note for the assistant action row (design §6.10).
 *
 * Rendered once per completed Turn in `conversation.chat.assistant-actions` as
 * a small, dim note so it sits beside the token-usage/time metadata instead of
 * a separate card. Only non-zero counters are displayed to keep the chat row
 * calm. Purely presentational: it reads the Host `memoryUsage` projection and
 * never calls a Remote or changes model context.
 * @module dsh-memory/client/MemoryUsageText
 */
import * as React from 'react'
import type { MemoryUsageView } from '../shared/types.ts'
import { t } from './locales.ts'
import { useLocaleVersion } from './runtime.ts'

const h = React.createElement

/** Props accepted by {@link MemoryUsageText}. */
export interface MemoryUsageTextProps {
  /** The `memoryUsage` projection value, or `undefined` before it exists. */
  usage?: MemoryUsageView | undefined
}

/** Whether the session recorded any memory activity worth showing. */
function isActive(usage: MemoryUsageView): boolean {
  return Object.values(usage.turns).some(
    (turn) => turn.injected.length > 0 || turn.written.length > 0 || turn.searched > 0,
  )
}

/**
 * Render the small memory-usage note.
 * @param props - The projection value.
 * @returns The note, or null when there is no activity.
 */
export function MemoryUsageText(props: MemoryUsageTextProps): React.ReactElement | null {
  useLocaleVersion()
  const usage = props.usage
  if (usage === undefined || !isActive(usage)) return null
  const searched = Object.values(usage.turns).reduce((sum, turn) => sum + turn.searched, 0)
  const parts: string[] = []
  if (usage.totalInjected > 0) parts.push(`${t('usage.injected')} ${usage.totalInjected}`)
  if (usage.totalWritten > 0) parts.push(`${t('usage.written')} ${usage.totalWritten}`)
  if (searched > 0) parts.push(`${t('usage.searched')} ${searched}`)
  if (parts.length === 0) return null
  const text = `${t('usage.title')} ${parts.join(' · ')}`
  return h(
    'span',
    {
      className: 'dsh-mem-usage-note',
      // The action row is a flex container; order pushes the note after the
      // built-in usage pill and time instead of between the icon actions.
      style: {
        order: 1,
        marginLeft: '8px',
        fontSize: '12px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      },
    },
    text,
  )
}

/** Standard props this wrapper reads from the assistant-action slot. */
interface MemoryUsageActionProps {
  useProjection?: (key: string) => unknown
}

/**
 * Assistant-action wrapper: read the `memoryUsage` projection and render the note.
 * @param props - Slot props carrying `useProjection`.
 * @returns The note, or null when there is no activity.
 */
export function MemoryUsageAssistantAction(
  props: MemoryUsageActionProps,
): React.ReactElement | null {
  const value = props.useProjection?.('memoryUsage')
  const usage = isMemoryUsageView(value) ? value : undefined
  return h(MemoryUsageText, { usage })
}

/** Structural guard for a value read through the untyped `useProjection` face. */
function isMemoryUsageView(value: unknown): value is MemoryUsageView {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<MemoryUsageView>
  return (
    typeof candidate.totalInjected === 'number' &&
    typeof candidate.totalWritten === 'number' &&
    candidate.turns !== null &&
    typeof candidate.turns === 'object'
  )
}
