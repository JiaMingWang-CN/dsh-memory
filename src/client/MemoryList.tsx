/**
 * Scrolling memory list for the Settings page.
 *
 * Presentational: the section owns data loading and passes records in. Rows are
 * sorted newest-first here so the component is correct regardless of caller
 * ordering. A status dot aligned to the title baseline, a pin glyph, a one-line
 * excerpt, type/scope/user tags and a relative timestamp make each row quick to
 * scan.
 * @module memloom/client/MemoryList
 */
import * as React from 'react'
import type { MemoryRecord } from './context.ts'
import { formatMessage, t } from './locales.ts'
import { MemoryEmptyState, MemoryErrorState, MemoryLoadingState } from './styles.ts'
import { Button, Tag } from './ui.tsx'

const h = React.createElement

/** Props accepted by {@link MemoryList}. */
export interface MemoryListProps {
  records: MemoryRecord[]
  selectedId?: string
  onSelect?: (id: string) => void
  loading?: boolean
  error?: string
  onRetry?: () => void
  /** True when search or type/status filters are active, to refine empty-state copy. */
  filtered?: boolean
  onClearFilters?: () => void
}

/** Sort a copy of records by `updatedAt` descending. */
export function sortByUpdatedDesc(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/** Status dot tone for a record. */
function statusTone(record: MemoryRecord): 'success' | 'warn' | 'idle' {
  if (record.status === 'pending') return 'warn'
  if (record.status === 'archived') return 'idle'
  return 'success'
}

/** Format one ISO timestamp as a short relative label with a full-date fallback. */
export function formatRelativeTime(iso: string): { short: string; full: string } {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { short: iso.slice(0, 10), full: iso }
  const full = date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const diffMs = Date.now() - date.getTime()
  if (diffMs >= 0 && diffMs < 60_000) return { short: t('time.justNow'), full }
  if (diffMs >= 60_000 && diffMs < 3_600_000) {
    return { short: formatMessage('time.minutesAgo', { n: Math.floor(diffMs / 60_000) }), full }
  }
  if (diffMs >= 3_600_000 && diffMs < 86_400_000) {
    return { short: formatMessage('time.hoursAgo', { n: Math.floor(diffMs / 3_600_000) }), full }
  }
  if (diffMs >= 86_400_000 && diffMs < 7 * 86_400_000) {
    return { short: formatMessage('time.daysAgo', { n: Math.floor(diffMs / 86_400_000) }), full }
  }
  const short = date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return { short, full }
}

/** Subtle pin glyph for pinned memories. */
function PinGlyph(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
    h('path', {
      d: 'M9.8 2.4l3.8 3.8-1.4 1.4-.9-.3-2.2 2.2.4 2.1-1.1 1.1-2.5-2.5L3 13.1l-.7-.7 2.9-2.9-2.5-2.5 1.1-1.1 2.1.4 2.2-2.2-.3-.9 1.4-1.4z',
      fill: 'currentColor',
    }),
  )
}

const MAX_VISIBLE_TAGS = 3

/**
 * Render the memory list.
 * @param props - Records, selection and load state.
 * @returns The list element.
 */
export function MemoryList(props: MemoryListProps): React.ReactElement {
  if (props.loading === true) return h(MemoryLoadingState)
  if (props.error !== undefined && props.error !== '') {
    return h(MemoryErrorState, {
      message: props.error,
      ...(props.onRetry === undefined ? {} : { onRetry: props.onRetry }),
    })
  }
  const records = sortByUpdatedDesc(props.records)
  if (records.length === 0) {
    return h(MemoryEmptyState, {
      ...(props.filtered === true ? { description: t('list.noMatches') } : {}),
      ...(props.filtered === true && props.onClearFilters !== undefined
        ? {
            action: h(Button, { size: 'sm', onClick: props.onClearFilters }, t('filter.clear')),
          }
        : {}),
    })
  }
  return h(
    'ul',
    { className: 'dsh-mem-rows' },
    records.map((record) => {
      const stamp = formatRelativeTime(record.updatedAt)
      const visibleTags = record.tags.slice(0, MAX_VISIBLE_TAGS)
      const extraTags = record.tags.length - visibleTags.length
      return h(
        'li',
        { key: record.id, className: 'dsh-mem-row-item' },
        h(
          'button',
          {
            type: 'button',
            'aria-current': record.id === props.selectedId,
            className: 'dsh-mem-row',
            onClick: () => props.onSelect?.(record.id),
          },
          h('span', { className: 'dsh-mem-dot', 'data-tone': statusTone(record) }),
          h(
            'span',
            { className: 'dsh-mem-row-main' },
            h(
              'span',
              { className: 'dsh-mem-row-top' },
              h(
                'span',
                { className: 'dsh-mem-row-title' },
                record.pinned
                  ? h('span', { className: 'dsh-mem-pin', title: t('detail.pinned') }, h(PinGlyph))
                  : null,
                h(
                  'span',
                  { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
                  record.title,
                ),
              ),
              h('span', { className: 'dsh-mem-count', title: stamp.full }, stamp.short),
            ),
            h('span', { className: 'dsh-mem-row-excerpt' }, record.body),
            h(
              'span',
              { className: 'dsh-mem-row-meta' },
              h(Tag, null, t(`type.${record.type}`)),
              h(
                Tag,
                null,
                record.scope.kind === 'global' ? t('scope.global') : t('scope.workspace'),
              ),
              record.status !== 'active'
                ? h(
                    Tag,
                    { tone: record.status === 'pending' ? 'warn' : 'neutral' },
                    t(`status.${record.status}`),
                  )
                : null,
              ...visibleTags.map((tag) => h(Tag, { key: tag, tone: 'accent' }, tag)),
              extraTags > 0 ? h('span', { className: 'dsh-mem-count' }, `+${extraTags}`) : null,
            ),
          ),
        ),
      )
    }),
  )
}
