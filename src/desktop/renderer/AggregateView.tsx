/**
 * Strictly read-only federated search view across all enabled healthy clients.
 * @module memloom/desktop/renderer/AggregateView
 */
import * as React from 'react'
import { formatRelativeTime } from '../../client/MemoryList.tsx'
import { formatMessage, t } from '../../client/locales.ts'
import { MemoryEmptyState, MemoryErrorState, MemoryLoadingState } from '../../client/styles.ts'
import { Button, Modal, PillGroup, Tabs, Tag } from '../../client/ui.tsx'
import { WorkspaceFilter } from '../../client/WorkspaceFilter.tsx'
import type { MemoryRecord, MemoryStatus, MemoryType } from '../../shared/types.ts'
import type { AggregateWorkspacesResult, DesktopBridgeApi } from '../ipc-contract.ts'
import type {
  AggregateSearchItem,
  AggregateSearchResult,
  DesktopClientInfo,
} from '../multi-service.ts'
import { desktopErrorText, unwrapIpc } from './desktop-locales.ts'

const h = React.createElement

const PAGE_SIZE = 20

export interface AggregateViewProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly refreshToken: number
  readonly banners?: React.ReactNode
  readonly onOpenInClient: (clientId: string, record: MemoryRecord) => void
  readonly onMigrateRecord: (clientId: string, record: MemoryRecord) => void
}

function SearchIcon(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
    h('circle', { cx: 7, cy: 7, r: 4.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
    h('path', {
      d: 'M10.5 10.5L13.5 13.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
    }),
  )
}

/**
 * Render the read-only All Clients federated search and detail view.
 */
export function AggregateView(props: AggregateViewProps): React.ReactElement {
  const { bridge, clients, refreshToken } = props
  const enabledClients = React.useMemo(() => clients.filter((c) => c.enabled), [clients])

  const [selectedClientIds, setSelectedClientIds] = React.useState<string[]>([])
  const [workspaceKey, setWorkspaceKey] = React.useState<string | 'all'>('all')
  const [type, setType] = React.useState<MemoryType | 'all'>('all')
  const [status, setStatus] = React.useState<MemoryStatus | 'all'>('all')
  const [searchInput, setSearchInput] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const [offset, setOffset] = React.useState(0)

  const [workspaces, setWorkspaces] = React.useState<AggregateWorkspacesResult | undefined>(
    undefined,
  )
  const [result, setResult] = React.useState<AggregateSearchResult | undefined>(undefined)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [detailItem, setDetailItem] = React.useState<AggregateSearchItem | undefined>(undefined)

  React.useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === debouncedQuery) return undefined
    if (trimmed === '') {
      setDebouncedQuery('')
      return undefined
    }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 200)
    return () => window.clearTimeout(timer)
  }, [searchInput, debouncedQuery])

  React.useEffect(() => {
    setOffset(0)
  }, [selectedClientIds, workspaceKey, type, status, debouncedQuery])

  const activeClientIds = selectedClientIds.length > 0 ? selectedClientIds : undefined

  React.useEffect(() => {
    let cancelled = false
    void bridge.aggregate
      .listWorkspaces(activeClientIds === undefined ? undefined : { clientIds: activeClientIds })
      .then((res) => {
        if (!cancelled) setWorkspaces(unwrapIpc(res))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [bridge, activeClientIds, refreshToken])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void bridge.aggregate
      .search({
        ...(debouncedQuery !== '' ? { query: debouncedQuery } : {}),
        ...(activeClientIds !== undefined ? { clientIds: activeClientIds } : {}),
        workspaceKey,
        ...(type !== 'all' ? { types: [type] } : {}),
        ...(status !== 'all' ? { statuses: [status] } : {}),
        limit: PAGE_SIZE,
        offset,
      })
      .then((res) => {
        if (!cancelled) setResult(unwrapIpc(res))
      })
      .catch((reason) => {
        if (!cancelled) setError(desktopErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bridge, debouncedQuery, activeClientIds, workspaceKey, type, status, offset, refreshToken])

  const toggleClientFilter = (clientId: string): void => {
    setSelectedClientIds((current) =>
      current.includes(clientId) ? current.filter((id) => id !== clientId) : [...current, clientId],
    )
  }

  const workspaceInfos = React.useMemo(
    () =>
      (workspaces?.items ?? []).map((w) => ({
        id: w.key,
        path: w.root,
        key: w.key,
        updatedAt: w.updatedAt,
      })),
    [workspaces],
  )

  const items = result?.items ?? []
  const total = result?.total ?? 0
  const skippedClients = result?.skippedClients ?? []
  const hasFilters =
    type !== 'all' ||
    status !== 'all' ||
    searchInput.trim() !== '' ||
    selectedClientIds.length > 0 ||
    workspaceKey !== 'all'

  return h(
    'section',
    { className: 'memloom-workspace-view' },
    h(
      'header',
      { className: 'memloom-workspace-header' },
      h(
        'div',
        { className: 'memloom-view-bar' },
        h(
          'div',
          { className: 'memloom-view-bar-main' },
          h('h2', { className: 'dsh-mem-title' }, t('desktop.aggregate.title')),
          h('p', { className: 'dsh-mem-intro' }, t('desktop.aggregate.subtitle')),
        ),
        h(Tag, { tone: 'accent' }, t('desktop.aggregate.readonlyBadge')),
      ),
      h(
        'div',
        { className: 'memloom-category-bar' },
        h(Tabs<MemoryType | 'all'>, {
          active: type,
          onChange: setType,
          label: t('desktop.aggregate.typeCategories'),
          items: [
            { id: 'all', label: t('type.all') },
            { id: 'lesson', label: t('type.lesson') },
            { id: 'worklog', label: t('type.worklog') },
            { id: 'wiki', label: t('type.wiki') },
            { id: 'preference', label: t('type.preference') },
          ],
        }),
      ),
    ),

    props.banners ?? null,

    h(
      'div',
      { className: 'memloom-content-scroll' },
      h(
        'div',
        { className: 'memloom-content-inner' },
        skippedClients.length > 0
          ? h(
              'div',
              { className: 'dsh-mem-warning', role: 'alert' },
              formatMessage('desktop.aggregate.skippedWarning', {
                details: skippedClients
                  .map((s) => `${s.name} (${s.health}${s.detail ? `: ${s.detail}` : ''})`)
                  .join('；'),
              }),
            )
          : null,

        h(
          'div',
          { className: 'dsh-mem-toolbar' },
          h(WorkspaceFilter, {
            workspaces: workspaceInfos,
            value: workspaceKey,
            hideWarning: true,
            onChange: setWorkspaceKey,
          }),
          h('span', { className: 'dsh-mem-toolbar-spacer' }),
          h(
            'div',
            {
              className: 'dsh-mem-pill-group',
              role: 'group',
              'aria-label': t('desktop.aggregate.clientFilter'),
            },
            h('span', { className: 'dsh-mem-pill-label' }, t('desktop.aggregate.clientFilter')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-mem-pill',
                'aria-pressed': selectedClientIds.length === 0,
                onClick: () => setSelectedClientIds([]),
              },
              t('desktop.aggregate.allClients'),
            ),
            ...enabledClients.map((client) =>
              h(
                'button',
                {
                  key: client.id,
                  type: 'button',
                  className: 'dsh-mem-pill',
                  'aria-pressed': selectedClientIds.includes(client.id),
                  onClick: () => toggleClientFilter(client.id),
                },
                client.name,
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'dsh-mem-card dsh-mem-list-full' },
          h(
            'div',
            { className: 'dsh-mem-pane-head' },
            h('span', { className: 'dsh-mem-pane-title' }, t('list.title')),
            h('span', { className: 'dsh-mem-count' }, formatMessage('list.total', { total })),
          ),
          h(
            'div',
            { className: 'dsh-mem-filters' },
            h(
              'div',
              { className: 'dsh-mem-search-row' },
              h(
                'div',
                { className: 'dsh-mem-search-wrap' },
                h('span', { className: 'dsh-mem-search-icon' }, h(SearchIcon)),
                h('input', {
                  type: 'search',
                  className: 'dsh-mem-search-input',
                  'aria-label': t('filter.search'),
                  placeholder: t('filter.searchPlaceholder'),
                  value: searchInput,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                    setSearchInput(event.target.value),
                }),
                searchInput === ''
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-mem-search-clear',
                        'aria-label': t('common.clear'),
                        onClick: () => {
                          setSearchInput('')
                          setDebouncedQuery('')
                        },
                      },
                      '×',
                    ),
              ),
              hasFilters
                ? h(
                    Button,
                    {
                      size: 'sm',
                      variant: 'ghost',
                      onClick: () => {
                        setSelectedClientIds([])
                        setWorkspaceKey('all')
                        setType('all')
                        setStatus('all')
                        setSearchInput('')
                        setDebouncedQuery('')
                      },
                    },
                    t('filter.clear'),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dsh-mem-filter-bars' },
              h(PillGroup<MemoryStatus | 'all'>, {
                label: t('filter.status'),
                value: status,
                options: [
                  { value: 'all', label: t('status.all') },
                  { value: 'active', label: t('status.active') },
                  { value: 'pending', label: t('status.pending') },
                  { value: 'archived', label: t('status.archived') },
                ],
                onChange: setStatus,
              }),
            ),
          ),

          loading
            ? h(MemoryLoadingState)
            : error !== ''
              ? h(MemoryErrorState, { message: error })
              : items.length === 0
                ? h(MemoryEmptyState, {
                    description: hasFilters ? t('list.noMatches') : t('list.empty'),
                  })
                : h(
                    'ul',
                    { className: 'dsh-mem-rows' },
                    items.map((item) => {
                      const stamp = formatRelativeTime(item.record.updatedAt)
                      return h(
                        'li',
                        {
                          key: `${item.clientId}:${item.record.id}`,
                          className: 'dsh-mem-row-item',
                        },
                        h(
                          'div',
                          { className: 'memloom-agg-row' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'memloom-agg-row-main',
                              onClick: () => setDetailItem(item),
                            },
                            h(
                              'span',
                              { className: 'dsh-mem-row-top' },
                              h('span', { className: 'dsh-mem-row-title' }, item.record.title),
                              h(
                                'span',
                                { className: 'dsh-mem-count', title: stamp.full },
                                stamp.short,
                              ),
                            ),
                            h(
                              'span',
                              { className: 'dsh-mem-row-excerpt' },
                              item.snippet !== '' ? item.snippet : item.record.body,
                            ),
                            h(
                              'span',
                              { className: 'dsh-mem-row-meta' },
                              h(Tag, { tone: 'accent' }, item.clientName),
                              h(
                                Tag,
                                { tone: item.writable ? 'success' : 'warn' },
                                item.writable
                                  ? t('desktop.status.writable')
                                  : t('desktop.status.readonly'),
                              ),
                              h(Tag, null, t(`type.${item.record.type}`)),
                              h(
                                Tag,
                                null,
                                item.record.scope.kind === 'global'
                                  ? t('scope.global')
                                  : item.record.scope.root,
                              ),
                              item.record.status !== 'active'
                                ? h(
                                    Tag,
                                    { tone: item.record.status === 'pending' ? 'warn' : 'neutral' },
                                    t(`status.${item.record.status}`),
                                  )
                                : null,
                              debouncedQuery !== ''
                                ? h(
                                    Tag,
                                    null,
                                    formatMessage('desktop.aggregate.score', {
                                      score: item.normalizedScore.toFixed(2),
                                    }),
                                  )
                                : null,
                            ),
                          ),
                          h(
                            'div',
                            { className: 'memloom-agg-row-actions' },
                            h(
                              Button,
                              {
                                size: 'sm',
                                onClick: () => props.onOpenInClient(item.clientId, item.record),
                              },
                              t('desktop.aggregate.openInClient'),
                            ),
                            h(
                              Button,
                              {
                                size: 'sm',
                                variant: 'ghost',
                                onClick: () => props.onMigrateRecord(item.clientId, item.record),
                              },
                              t('desktop.aggregate.copyToOther'),
                            ),
                          ),
                        ),
                      )
                    }),
                  ),

          total > PAGE_SIZE
            ? h(
                'div',
                { className: 'dsh-mem-pager' },
                h(
                  'span',
                  { className: 'dsh-mem-count' },
                  formatMessage('list.showing', {
                    from: offset + 1,
                    to: offset + items.length,
                  }),
                ),
                h(
                  Button,
                  {
                    size: 'sm',
                    disabled: offset === 0,
                    onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)),
                  },
                  t('list.pagePrev'),
                ),
                h(
                  Button,
                  {
                    size: 'sm',
                    disabled: offset + PAGE_SIZE >= total,
                    onClick: () => setOffset(offset + PAGE_SIZE),
                  },
                  t('list.pageNext'),
                ),
              )
            : null,
        ),
      ),
    ),

    // Strictly read-only detail modal (never renders edit/archive/restore controls)
    detailItem !== undefined
      ? h(
          Modal,
          {
            title: detailItem.record.title,
            onClose: () => setDetailItem(undefined),
            closeLabel: t('common.close'),
            footer: h(
              'div',
              { className: 'dsh-mem-footer-split' },
              h(
                Tag,
                { tone: 'accent' },
                `${t('desktop.aggregate.sourceClient')}: ${detailItem.clientName}`,
              ),
              h(
                'div',
                { className: 'dsh-mem-actions' },
                h(
                  Button,
                  {
                    size: 'sm',
                    onClick: () => {
                      const target = detailItem
                      setDetailItem(undefined)
                      props.onMigrateRecord(target.clientId, target.record)
                    },
                  },
                  t('desktop.aggregate.copyToOther'),
                ),
                h(
                  Button,
                  {
                    variant: 'primary',
                    size: 'sm',
                    onClick: () => {
                      const target = detailItem
                      setDetailItem(undefined)
                      props.onOpenInClient(target.clientId, target.record)
                    },
                  },
                  t('desktop.aggregate.openInClient'),
                ),
              ),
            ),
          },
          h(
            'div',
            { className: 'dsh-mem-detail' },
            h(
              'div',
              { className: 'dsh-mem-detail-tags' },
              h(Tag, { tone: 'accent' }, detailItem.clientName),
              h(Tag, null, t(`type.${detailItem.record.type}`)),
              h(
                Tag,
                {
                  tone:
                    detailItem.record.status === 'pending'
                      ? 'warn'
                      : detailItem.record.status === 'active'
                        ? 'success'
                        : 'neutral',
                },
                t(`status.${detailItem.record.status}`),
              ),
              h(
                Tag,
                null,
                detailItem.record.scope.kind === 'global'
                  ? t('scope.global')
                  : detailItem.record.scope.root,
              ),
            ),
            h(
              'div',
              { className: 'dsh-mem-body-box' },
              h('div', { className: 'dsh-mem-body' }, detailItem.record.body),
            ),
            detailItem.record.tags.length > 0
              ? h(
                  'div',
                  { className: 'dsh-mem-detail-tags' },
                  h('span', { className: 'dsh-mem-count' }, `${t('detail.tags')}:`),
                  ...detailItem.record.tags.map((tag) => h(Tag, { key: tag, tone: 'accent' }, tag)),
                )
              : null,
          ),
        )
      : null,
  )
}
